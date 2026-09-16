import { useEffect, useState } from "react";
import { selectExitLocked, useWallet } from "../store/wallet";
import { Confirm, SatoshiIcon, Sheet, Spinner } from "../components/ui";
import { Scanner } from "../components/Scanner";
import { Cooperative } from "./Exit";
import { detect, describeDestination, type Destination } from "../lib/detect";
import { decodeInvoice, isExpired } from "../lib/bolt11";
import { classifySend, sendRequestId, watchLightningSend } from "../lib/lightning";
import { LnurlError, requestInvoice, resolvePayParams, type PayParams } from "../lib/lnurl";
import { formatSats, readableError, truncateMiddle } from "../lib/format";
import { StableError, formatUsd, parseUsdUnits, satsToUsdUnits, usdUnitsToSats } from "../lib/stable";
import type { Contact, ContactKind } from "../lib/db";

/** Headroom over the SDK's estimate, so a small routing surprise doesn't fail the payment. */
const feeCeiling = (estimate: number) => Math.max(estimate + 2, Math.ceil(estimate * 1.5), 5);

/** The BOLT11 network name each wallet network expects to be paying on. */
const INVOICE_NETWORK = { MAINNET: "mainnet", REGTEST: "regtest" } as const;

type Plan = {
  target:
    | { kind: "bolt11"; invoice: string; paymentHash?: string }
    | { kind: "spark"; address: string };
  amountSats: number;
  maxFeeSats: number;
  label: string;
  note?: string;
};

type Stage =
  | { s: "input" }
  | { s: "scan" }
  | { s: "onchain"; address: string }
  | { s: "amount"; dest: Destination; lnurl?: PayParams }
  | { s: "preparing" }
  | { s: "confirm"; plan: Plan }
  | { s: "paying" }
  | { s: "done"; amountSats: number }
  /** Dispatched, but delivery to the receiver is not proven yet. */
  | { s: "settling"; amountSats: number; status: string }
  /** `afterAttempt` marks failures where a payment was actually dispatched, so
   *  the "check Activity first" warning only appears when it is true. */
  | { s: "error"; message: string; afterAttempt?: boolean };

/** Stable-balance errors carry their own precise wording; everything else goes through readableError. */
function explain(e: unknown): string {
  return e instanceof StableError ? e.message : readableError(e);
}

/** Reusable destinations can be saved. An invoice is single-use, so it cannot. */
function contactKind(d: Destination | null): ContactKind | null {
  if (!d) return null;
  return d.kind === "spark" || d.kind === "lightning-address" || d.kind === "lnurl" || d.kind === "onchain" ? d.kind : null;
}

export function Send({ onClose }: { onClose: () => void }) {
  const wallet = useWallet((s) => s.wallet);
  const balance = useWallet((s) => s.balance);
  const refresh = useWallet((s) => s.refresh);
  const network = useWallet((s) => s.settings.network);
  const stableMode = useWallet((s) => s.settings.stableMode);
  const usdbUnits = useWallet((s) => s.usdbUnits);
  const withStableCover = useWallet((s) => s.withStableCover);
  const quoteUsdInSats = useWallet((s) => s.quoteUsdInSats);
  const exitLocked = useWallet(selectExitLocked);
  const allContacts = useWallet((s) => s.contacts);

  const [raw, setRaw] = useState("");
  const [stage, setStage] = useState<Stage>({ s: "input" });
  // Paying from USD is on by default whenever there is USD to pay from. In
  // separate mode it can be switched off, per payment.
  const [payFromUsd, setPayFromUsd] = useState(true);

  const hasUsd = stableMode !== "off" && usdbUnits > 0n;
  const stableCover = hasUsd && (stableMode === "whole" || payFromUsd);
  const dest = raw.trim() ? detect(raw) : null;
  const contacts = allContacts.filter((c) => c.network === network).sort((a, b) => a.name.localeCompare(b.name));
  const savedAs = dest ? contacts.find((c) => c.address === dest.raw) : undefined;

  if (exitLocked) {
    return (
      <Sheet title="Send" onClose={onClose}>
        <p>A unilateral exit is armed or in progress, so sending is paused.</p>
        <p className="muted">
          Spending the leaves being exited would make the exit transactions stale. Sending comes back
          once the exit is finished or cancelled, in Settings → Exit to Bitcoin.
        </p>
      </Sheet>
    );
  }

  async function begin(input: string) {
    const d = detect(input);

    if (d.kind === "unknown") {
      setStage({ s: "error", message: "That is not an invoice, a Spark address, a Lightning address, or a Bitcoin address." });
      return;
    }

    // On-chain sending is a cooperative exit, so it reuses that flow rather
    // than pretending to be a Lightning payment with different words.
    if (d.kind === "onchain") {
      setStage({ s: "onchain", address: d.raw });
      return;
    }

    if (d.kind === "bolt11") {
      if (isExpired(d.decoded)) {
        setStage({ s: "error", message: "That invoice has expired. Ask for a new one." });
        return;
      }
      if (d.decoded.amountSats === null) {
        setStage({ s: "amount", dest: d });
        return;
      }
      await prepareBolt11(d.raw, d.decoded.amountSats, d.decoded.description);
      return;
    }

    if (d.kind === "spark") {
      setStage({ s: "amount", dest: d });
      return;
    }

    // Lightning address / LNURL: resolve what the recipient's server accepts.
    setStage({ s: "preparing" });
    try {
      const params = await resolvePayParams(d.raw);
      setStage({ s: "amount", dest: d, lnurl: params });
    } catch (e) {
      setStage({ s: "error", message: e instanceof LnurlError ? e.message : readableError(e) });
    }
  }

  async function estimateLightningFee(invoice: string, amountSats: number): Promise<number> {
    if (!wallet) return 0;
    try {
      return await wallet.getLightningSendFeeEstimate({ encodedInvoice: invoice, amountSats });
    } catch {
      // A missing estimate must not block the payment; the caller applies a floor.
      return 0;
    }
  }

  async function prepareBolt11(invoice: string, amountSats: number, label?: string) {
    if (!wallet) return;
    // Decoded here, from the invoice the user is paying — the preimage check
    // is only meaningful against a hash the response did not supply.
    const decoded = decodeInvoice(invoice);
    const paymentHash = decoded?.paymentHash;

    // Every invoice reaches the confirm screen through this function — pasted,
    // pasted with an amount, or returned by an LNURL server — so the checks
    // that must not be skippable belong here rather than at the paste site.
    if (decoded && decoded.network !== INVOICE_NETWORK[network]) {
      setStage({
        s: "error",
        message: `That is a ${decoded.network} invoice, but this wallet is on ${INVOICE_NETWORK[network]}.`,
      });
      return;
    }
    if (decoded && isExpired(decoded)) {
      setStage({ s: "error", message: "That invoice has expired. Ask for a new one." });
      return;
    }

    setStage({ s: "preparing" });
    try {
      const estimate = await estimateLightningFee(invoice, amountSats);
      setStage({
        s: "confirm",
        plan: {
          target: { kind: "bolt11", invoice, ...(paymentHash ? { paymentHash } : {}) },
          amountSats,
          maxFeeSats: feeCeiling(estimate),
          label: label || "Lightning invoice",
          note: estimate === 0 ? "Fee could not be estimated; a small cap is applied." : undefined,
        },
      });
    } catch (e) {
      setStage({ s: "error", message: readableError(e) });
    }
  }

  async function pay(plan: Plan) {
    if (!wallet) return;
    setStage({ s: "paying" });
    try {
      // Whatever the send returns is the only evidence of what happened to the
      // money; it is classified rather than discarded.
      let outcome: ReturnType<typeof classifySend> | null = null;
      let sendId: string | null = null;
      await withStableCover(
        plan.amountSats + plan.maxFeeSats,
        async () => {
          if (plan.target.kind === "bolt11") {
            const result = await wallet.payLightningInvoice({
              invoice: plan.target.invoice,
              maxFeeSats: plan.maxFeeSats,
            });
            outcome = classifySend(result, plan.target.paymentHash);
            sendId = sendRequestId(result);
            // A send that is over and undelivered must not read as success. It
            // throws so the stable-cover wrapper can unwind with it.
            if (outcome.state === "failed") {
              throw new Error(
                outcome.refunded
                  ? "The Lightning payment did not go through, and the sats have been returned."
                  : "The Lightning payment did not reach the receiver.",
              );
            }
          } else {
            const result = await wallet.transfer({
              receiverSparkAddress: plan.target.address,
              amountSats: plan.amountSats,
            });
            outcome = classifySend(result);
          }
        },
        { allow: stableCover },
      );

      // "in-flight" is not "done": the leaves have gone to the SSP but nobody
      // has proved the receiver was paid.
      let settled = outcome as ReturnType<typeof classifySend> | null;

      // The SSP answers as soon as it accepts the request, which is before
      // anyone has been paid — so ask it again until it knows. Without this a
      // payment that lands a second later reads as "still settling" for ever.
      if (settled && settled.state === "in-flight" && sendId && plan.target.kind === "bolt11") {
        const id = sendId;
        const hash = plan.target.paymentHash;
        setStage({ s: "settling", amountSats: plan.amountSats, status: settled.status });
        settled = await watchLightningSend(() => wallet.getLightningSendRequest(id), hash, {
          onUpdate: (o) => setStage({ s: "settling", amountSats: plan.amountSats, status: o.status }),
        });
        void refresh();
      }

      if (settled && settled.state === "failed") {
        setStage({
          s: "error",
          message: settled.refunded
            ? "The Lightning payment did not go through, and the sats have been returned."
            : "The Lightning payment did not reach the receiver.",
          afterAttempt: true,
        });
        void refresh();
        return;
      }

      setStage(
        settled && settled.state === "in-flight"
          ? { s: "settling", amountSats: plan.amountSats, status: settled.status }
          : { s: "done", amountSats: plan.amountSats },
      );
      void refresh();
    } catch (e) {
      setStage({ s: "error", message: explain(e), afterAttempt: true });
      // The payment may have gone through despite the error. Re-sync so the
      // activity list reflects what the operators think, not what we guessed.
      void refresh();
    }
  }

  const usdToggle = stableMode === "separate" && hasUsd && (
    <label className="kv" style={{ cursor: "pointer", marginBottom: 12 }}>
      <span className="k">
        <span style={{ color: "var(--text)" }}>Cover any shortfall from USD</span>
        <div style={{ fontSize: 12 }}>{formatUsd(usdbUnits)} available</div>
      </span>
      <span className="v">
        <input
          type="checkbox"
          className="switch"
          checked={payFromUsd}
          onChange={(e) => setPayFromUsd(e.target.checked)}
        />
      </span>
    </label>
  );

  return (
    <Sheet title="Send" onClose={onClose}>
      {stage.s === "input" && (
        <div>
          <label className="field">
            <span>Invoice, Spark address, Lightning address, or Bitcoin address</span>
            <textarea
              value={raw}
              autoFocus
              placeholder="lnbc… / sp1… / you@example.com / bc1…"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              onChange={(e) => setRaw(e.target.value)}
            />
          </label>

          {dest && (
            <div className="muted" style={{ marginTop: -8, marginBottom: 10, fontSize: 13 }}>
              Detected: {describeDestination(dest)}
              {dest.kind === "bolt11" && dest.decoded.amountSats !== null && (
                <> · {formatSats(dest.decoded.amountSats)} sats</>
              )}
              {savedAs && <> · {savedAs.name}</>}
            </div>
          )}

          {contactKind(dest) && !savedAs && <AddContact key={dest!.raw} address={dest!.raw} kind={contactKind(dest)!} />}

          {(dest?.kind === "lightning-address" || dest?.kind === "lnurl") && (
            <div className="notice">
              Paying a Lightning address contacts the recipient's own server from this browser. That
              server will see your IP address. Nothing else about you is sent.
            </div>
          )}

          {usdToggle}

          <div className="row">
            <button className="btn ghost" onClick={() => setStage({ s: "scan" })}>
              Scan QR
            </button>
            <button
              className="btn primary"
              disabled={!dest || dest.kind === "unknown"}
              onClick={() => void begin(raw)}
            >
              Continue
            </button>
          </div>
          <p className="muted center" style={{ marginTop: 16, fontSize: 12.5 }}>
            Balance {formatSats(balance.available)} sats
            {hasUsd && <> · {formatUsd(usdbUnits)}</>}
          </p>

          {contacts.length > 0 && (
            <ContactList
              contacts={contacts}
              onPick={(c) => {
                setRaw(c.address);
                void begin(c.address);
              }}
            />
          )}
        </div>
      )}

      {stage.s === "scan" && (
        <Scanner
          onCancel={() => setStage({ s: "input" })}
          onResult={(text) => {
            setRaw(text);
            void begin(text);
          }}
        />
      )}

      {stage.s === "onchain" && (
        <div>
          <p className="muted" style={{ fontSize: 12.5 }}>
            Sending on-chain is a cooperative exit: the SSP pays this address from Bitcoin and
            settles with your wallet on Spark.
          </p>
          <Cooperative initialAddress={stage.address} />
          <button
            className="btn ghost"
            style={{ width: "100%", marginTop: 10 }}
            onClick={() => setStage({ s: "input" })}
          >
            Back
          </button>
        </div>
      )}

      {stage.s === "amount" && (
        <>
          {usdToggle}
          <AmountStep
            dest={stage.dest}
            lnurl={stage.lnurl}
            max={balance.available}
            extraFromUsd={stableCover ? quoteUsdInSats : undefined}
            estimateFee={estimateLightningFee}
            onBack={() => setStage({ s: "input" })}
            onPick={async (amountSats) => {
              const d = stage.dest;
              if (d.kind === "spark") {
                setStage({
                  s: "confirm",
                  plan: {
                    target: { kind: "spark", address: d.raw },
                    amountSats,
                    // Spark-to-Spark transfers settle inside Spark; no routing fee.
                    maxFeeSats: 0,
                    label: savedAs?.name ?? truncateMiddle(d.raw, 14, 10),
                  },
                });
                return;
              }
              if (d.kind === "bolt11") {
                await prepareBolt11(d.raw, amountSats, d.decoded.description);
                return;
              }
              setStage({ s: "preparing" });
              try {
                const invoice = await requestInvoice(stage.lnurl!, amountSats);
                await prepareBolt11(invoice, amountSats, savedAs?.name ?? d.raw);
              } catch (e) {
                setStage({ s: "error", message: e instanceof LnurlError ? e.message : readableError(e) });
              }
            }}
          />
        </>
      )}

      {stage.s === "preparing" && (
        <p className="center muted" style={{ padding: "40px 0" }}>
          <Spinner /> Checking…
        </p>
      )}

      {stage.s === "confirm" && (() => {
        const total = stage.plan.amountSats + stage.plan.maxFeeSats;
        const exceeds = total > balance.available;
        const blocked = exceeds && !stableCover;
        return (
          <div>
            <div className="card">
              <div className="kv">
                <span className="k">Amount</span>
                <span className="v">{formatSats(stage.plan.amountSats)} sats</span>
              </div>
              <div className="kv">
                <span className="k">To</span>
                <span className="v">{truncateMiddle(stage.plan.label, 16, 12)}</span>
              </div>
              <div className="kv">
                <span className="k">Max fee</span>
                <span className="v">{formatSats(stage.plan.maxFeeSats)} sats</span>
              </div>
              <div className="kv">
                <span className="k">Most it can cost</span>
                <span className="v total">{formatSats(total)} sats</span>
              </div>
            </div>
            {stage.plan.note && <p className="muted" style={{ fontSize: 12.5 }}>{stage.plan.note}</p>}
            {exceeds && stableCover && (
              <p className="muted" style={{ fontSize: 12.5 }}>
                About {formatSats(total - balance.available)} sats convert from your USD balance
                first.
              </p>
            )}
            {blocked && (
              <div className="err">
                Not enough sats. You have {formatSats(balance.available)}.
                {hasUsd && " Turn on “Cover any shortfall from USD” to pay the rest from USD."}
              </div>
            )}
            <div className="row" style={{ marginTop: 16 }}>
              <button className="btn ghost" onClick={() => setStage({ s: "input" })}>
                Back
              </button>
              <button className="btn primary" disabled={blocked} onClick={() => void pay(stage.plan)}>
                Pay
              </button>
            </div>
          </div>
        );
      })()}

      {stage.s === "paying" && (
        <div className="center" style={{ padding: "40px 0" }}>
          <Spinner />
          <p className="muted" style={{ marginTop: 14 }}>
            {stableCover && "Converting from USD if needed, then paying. "}
            Lightning payments can take a few seconds — don't close this tab.
          </p>
        </div>
      )}

      {stage.s === "done" && (
        <div className="center">
          <div className="big-tick ok-text">✓</div>
          <h2>Sent</h2>
          <p className="muted">{formatSats(stage.amountSats)} sats on their way.</p>
          <button className="btn primary" style={{ width: "100%", marginTop: 16 }} onClick={onClose}>
            Done
          </button>
        </div>
      )}

      {stage.s === "settling" && (
        <div className="center">
          <Spinner />
          <h2 style={{ marginTop: 14 }}>Still settling</h2>
          <p className="muted">
            {formatSats(stage.amountSats)} sats have left this wallet, but the receiver has not
            confirmed yet. This usually resolves in a few seconds. Activity will show it as paid
            once it does — and if it does not go through, the sats come back.
          </p>
          <button className="btn primary" style={{ width: "100%", marginTop: 16 }} onClick={onClose}>
            Close
          </button>
        </div>
      )}

      {stage.s === "error" && (
        <div>
          <div className="err">{stage.message}</div>
          {stage.afterAttempt && (
            <p className="muted" style={{ fontSize: 12.5 }}>
              A payment was already dispatched, so check Activity before trying again — the
              operators, not this screen, are the source of truth.
            </p>
          )}
          <button
            className="btn ghost"
            style={{ width: "100%", marginTop: 10 }}
            onClick={() => setStage({ s: "input" })}
          >
            Back
          </button>
        </div>
      )}
    </Sheet>
  );
}

/**
 * Offered only once something reusable and valid has been pasted. Collapsed to
 * a single quiet link until asked for, so it never gets in the way of paying.
 */
function AddContact({ address, kind }: { address: string; kind: ContactKind }) {
  const addContact = useWallet((s) => s.addContact);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <div style={{ marginTop: -4, marginBottom: 14 }}>
        <button className="link subtle" onClick={() => setOpen(true)}>
          + Add to contacts
        </button>
      </div>
    );
  }

  async function save() {
    if (!name.trim()) return;
    setBusy(true);
    await addContact(name, address, kind);
    setBusy(false);
  }

  return (
    <div className="add-contact">
      <input
        type="text"
        value={name}
        autoFocus
        maxLength={60}
        placeholder="Name for this address"
        aria-label="Contact name"
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
          if (e.key === "Escape") setOpen(false);
        }}
      />
      <button className="btn primary" disabled={!name.trim() || busy} onClick={() => void save()}>
        Save
      </button>
      <button className="btn ghost" onClick={() => setOpen(false)}>
        Cancel
      </button>
    </div>
  );
}

function ContactList({ contacts, onPick }: { contacts: Contact[]; onPick: (c: Contact) => void }) {
  const removeContact = useWallet((s) => s.removeContact);
  const [removing, setRemoving] = useState<Contact | null>(null);

  return (
    <div className="contacts">
      <h2>Contacts</h2>
      {contacts.map((c) => (
        <div className="contact" key={c.id}>
          <button className="pick" onClick={() => onPick(c)}>
            <div className="name">{c.name}</div>
            <div className="addr mono">{c.kind === "lightning-address" ? c.address : truncateMiddle(c.address, 14, 10)}</div>
          </button>
          <button className="icon-btn" style={{ fontSize: 13 }} aria-label={`Remove ${c.name}`} onClick={() => setRemoving(c)}>
            ✕
          </button>
        </div>
      ))}
      <p className="muted" style={{ fontSize: 11.5, marginTop: 8 }}>
        Stored encrypted in this browser with your passphrase. Never sent anywhere.
      </p>
      {removing && (
        <Confirm
          title={`Remove ${removing.name}?`}
          body={<p className="mono">{removing.address}</p>}
          confirmLabel="Remove"
          danger
          onCancel={() => setRemoving(null)}
          onConfirm={async () => {
            const c = removing;
            setRemoving(null);
            await removeContact(c.id);
          }}
        />
      )}
    </div>
  );
}

function AmountStep({
  dest,
  lnurl,
  max,
  extraFromUsd,
  estimateFee,
  onPick,
  onBack,
}: {
  dest: Destination;
  lnurl?: PayParams;
  /** Spendable bitcoin, in sats. */
  max: number;
  /** When paying may draw on USD: what the USD balance fetches in sats, or null if it cannot be quoted. */
  extraFromUsd?: () => Promise<number | null>;
  estimateFee: (invoice: string, amountSats: number) => Promise<number>;
  onPick: (amountSats: number) => Promise<void>;
  onBack: () => void;
}) {
  const stableModeForDisplay = useWallet((s) => s.settings.stableMode);
  const unitsPerSat = useWallet((s) => s.unitsPerSat);
  const inUsd = stableModeForDisplay === "whole" && unitsPerSat !== null;

  const [amount, setAmount] = useState("");
  const [busy, setBusy] = useState(false);
  const [maxNote, setMaxNote] = useState<string | null>(null);
  /**
   * Which unit the field is in. A wallet denominated in dollars opens in
   * dollars; the toggle is offered either way, whenever there is a rate to
   * convert with.
   */
  const [unit, setUnit] = useState<"sats" | "usd">(inUsd ? "usd" : "sats");
  /** "loading" until the USD quote answers; null if it could not be quoted. */
  const [extra, setExtra] = useState<number | null | "loading">(extraFromUsd ? "loading" : 0);

  useEffect(() => {
    if (!extraFromUsd) {
      setExtra(0);
      return;
    }
    let alive = true;
    setExtra("loading");
    void extraFromUsd().then(
      (v) => alive && setExtra(v),
      () => alive && setExtra(null),
    );
    return () => {
      alive = false;
    };
  }, [extraFromUsd]);

  const extraSats = typeof extra === "number" ? extra : 0;
  const spendable = max + extraSats;

  // Sats stay the source of truth whatever the field shows: the invoice, the
  // fee and the payment are all denominated in sats, and every bound below is
  // checked against them.
  const canPriceUsd = unitsPerSat !== null && unitsPerSat > 0;
  const typedUsdUnits = unit === "usd" ? parseUsdUnits(amount) : null;
  const sats =
    unit === "usd"
      ? typedUsdUnits !== null && canPriceUsd
        ? usdUnitsToSats(typedUsdUnits, unitsPerSat!)
        : NaN
      : Number(amount);

  /**
   * Keeps the figure the user already typed when the unit changes, rather than
   * blanking it or — worse — leaving a sats figure sitting in a dollar field.
   */
  function switchUnit(next: "sats" | "usd") {
    setMaxNote(null);
    setUnit(next);
    if (!canPriceUsd) return;
    if (next === "usd") {
      const current = Number(amount);
      setAmount(
        Number.isFinite(current) && current > 0
          ? (Number(satsToUsdUnits(current, unitsPerSat!)) / 1_000_000).toFixed(2)
          : "",
      );
    } else {
      const units = parseUsdUnits(amount);
      setAmount(units !== null && units > 0 ? String(usdUnitsToSats(units, unitsPerSat!)) : "");
    }
  }

  const min = lnurl?.minSats ?? 1;
  const ceiling = Math.min(spendable, lnurl?.maxSats ?? spendable);
  const valid = Number.isInteger(sats) && sats >= min && sats <= ceiling && sats > 0;

  /**
   * "Max" means the largest amount that still leaves room for the fee.
   *
   * Spark transfers are free, so max is everything spendable. Lightning has a
   * routing fee that depends on the amount, so the fee is estimated against the
   * full amount first and then subtracted — one pass is enough, because
   * lowering the amount can only lower the fee. When the USD balance can cover
   * the payment, its bitcoin value is part of what is spendable.
   */
  /** Writes a sats figure into the field in whatever unit it is showing. */
  function setAmountSats(n: number) {
    const safe = Math.max(0, Math.floor(n));
    if (unit === "usd" && canPriceUsd) {
      // Floored to the cent, so "Max" can never round above what is spendable.
      setAmount((Math.floor(Number(satsToUsdUnits(safe, unitsPerSat!)) / 10_000) / 100).toFixed(2));
    } else {
      setAmount(String(safe));
    }
  }

  async function fillMax() {
    setBusy(true);
    setMaxNote(null);
    const fromUsd = extraSats > 0 ? ` Includes about ${formatSats(extraSats)} sats from your USD balance.` : "";
    try {
      if (dest.kind === "spark") {
        setAmountSats(spendable);
        setMaxNote(`Spark transfers have no fee, so this is everything spendable.${fromUsd}`);
      } else if (dest.kind === "bolt11") {
        const est = await estimateFee(dest.raw, spendable);
        const reserve = feeCeiling(est);
        setAmountSats(spendable - reserve);
        setMaxNote(`${formatSats(reserve)} sats held back for the routing fee.${fromUsd}`);
      } else {
        // LNURL: no invoice exists yet, so the fee cannot be estimated for real.
        // Hold back a conservative reserve and let the confirm screen show the
        // actual figure once the invoice comes back.
        const reserve = Math.max(5, Math.ceil(spendable * 0.005));
        setAmountSats(Math.min(Math.max(0, spendable - reserve), ceiling));
        setMaxNote(
          `${formatSats(reserve)} sats held back for the routing fee — the exact fee is shown before you confirm.${fromUsd}`,
        );
      }
    } finally {
      setBusy(false);
    }
  }

  // In whole-balance mode the wallet is denominated in dollars, so the amount
  // is echoed there too. The field itself stays in sats: that is the unit the
  // invoice, the fee and the payment are all actually in, and converting the
  // input would quietly change what is sent.
  const usdFor = (n: number) =>
    canPriceUsd && Number.isFinite(n) && n > 0 ? `≈${formatUsd(satsToUsdUnits(n, unitsPerSat!))}` : null;
  // The field shows one unit; this shows the same figure in the other, so the
  // sats going out are never hidden behind a dollar amount.
  const amountEcho =
    !Number.isFinite(sats) || sats <= 0
      ? null
      : unit === "usd"
        ? `${formatSats(sats)} sats`
        : usdFor(sats);

  const spendableNote =
    extra === "loading"
      ? `Spendable ${formatSats(max)} sats, plus your USD balance — getting a quote…`
      : extra === null
        ? `Spendable ${formatSats(max)} sats. Your USD balance could not be quoted right now, so it is not counted — try again in a moment.`
        : `Spendable ${formatSats(spendable)} sats${usdFor(spendable) ? ` (${usdFor(spendable)})` : ""}${extraSats > 0 ? ` — ${formatSats(max)} bitcoin + about ${formatSats(extraSats)} from USD` : ""}`;

  return (
    <div>
      <p className="muted">
        {dest.kind === "bolt11"
          ? "This invoice does not specify an amount. Choose one."
          : lnurl
            ? `${lnurl.description ? lnurl.description + " · " : ""}Accepts ${formatSats(lnurl.minSats)}–${formatSats(lnurl.maxSats)} sats.`
            : "How much would you like to send?"}
      </p>
      <label className="field">
        <span className="amount-label">
          {canPriceUsd && (
            <button
              type="button"
              className="unit-toggle"
              aria-label={unit === "sats" ? "Switch to entering US dollars" : "Switch to entering sats"}
              title={unit === "sats" ? "Enter in USD instead" : "Enter in sats instead"}
              onClick={(e) => {
                // Inside a <label>, a click also activates the label's control,
                // which fires this button a second time and toggles it straight
                // back. Stop that before it undoes the switch.
                e.preventDefault();
                e.stopPropagation();
                switchUnit(unit === "sats" ? "usd" : "sats");
              }}
            >
              {unit === "sats" ? <SatoshiIcon size={15} /> : <span aria-hidden="true">$</span>}
            </button>
          )}
          Amount in {unit === "sats" ? "sats" : "USD"}
          <button className="chip" disabled={busy || extra === "loading"} onClick={() => void fillMax()}>
            Max
          </button>
        </span>
        <input
          // Not type=number: dollars carry a decimal point and a currency the
          // numeric spinner has no idea about.
          type="text"
          inputMode="decimal"
          autoFocus
          value={amount}
          placeholder={unit === "sats" ? "0" : "0.00"}
          onChange={(e) => {
            setAmount(e.target.value);
            setMaxNote(null);
          }}
        />
      </label>
      {amountEcho && (
        <p className="muted" style={{ fontSize: 13, marginTop: -8, marginBottom: 4 }}>
          {amountEcho}
        </p>
      )}
      <p className="muted" style={{ fontSize: 12.5, marginTop: amountEcho ? 0 : -8 }}>
        {maxNote ?? spendableNote}
      </p>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn ghost" onClick={onBack}>
          Back
        </button>
        <button
          className="btn primary"
          disabled={!valid || busy}
          onClick={async () => {
            setBusy(true);
            await onPick(sats);
            setBusy(false);
          }}
        >
          {busy ? <Spinner /> : "Continue"}
        </button>
      </div>
    </div>
  );
}
