import { useEffect, useState, type ReactNode } from "react";
import { selectExitLocked, useWallet } from "../store/wallet";
import { Confirm, Sheet, Spinner } from "../components/ui";
import { Exit } from "./Exit";
import { PROVENANCE } from "./Backup";
import { formatSats } from "../lib/format";
import { formatUsd, stableSupported } from "../lib/stable";
import { MIN_PASSPHRASE_LENGTH } from "../lib/crypto";
import type { LeafLayout, StableMode } from "../lib/db";

type View = "root" | "seed" | "passphrase" | "exit" | "stable" | "layout";

export function Settings({ onClose, onShowBackup }: { onClose: () => void; onShowBackup: () => void }) {
  const settings = useWallet((s) => s.settings);
  const updateSettings = useWallet((s) => s.updateSettings);
  const lock = useWallet((s) => s.lock);
  const wipe = useWallet((s) => s.wipe);
  const mnemonic = useWallet((s) => s.mnemonic);
  const backupVerified = useWallet((s) => s.backupVerified);
  const privacyEnabled = useWallet((s) => s.privacyEnabled);
  const setPrivacy = useWallet((s) => s.setPrivacy);

  const [privacyBusy, setPrivacyBusy] = useState(false);
  const [view, setView] = useState<View>("root");
  const [confirmSeed, setConfirmSeed] = useState(false);
  const [confirmWipe, setConfirmWipe] = useState(false);
  const [confirmNetwork, setConfirmNetwork] = useState<"MAINNET" | "REGTEST" | null>(null);

  if (view === "exit") return <Exit onClose={() => setView("root")} />;
  if (view === "passphrase") return <ChangePassphrase onDone={() => setView("root")} />;
  if (view === "stable") return <StableBalance onDone={() => setView("root")} />;
  if (view === "layout") return <LeafLayoutView onDone={() => setView("root")} />;

  if (view === "seed" && mnemonic) {
    return (
      <Sheet title="Your recovery phrase" onClose={() => setView("root")}>
        <div className="notice stark">
          Anyone who reads these words can spend everything in this wallet. Make sure nobody is
          looking over your shoulder and nothing is recording your screen.
        </div>
        <div className="seed-grid">
          {mnemonic.split(" ").map((w, i) => (
            <div className="seed-word" key={i}>
              <span className="n">{i + 1}</span>
              <span>{w}</span>
            </div>
          ))}
        </div>
        <div className="muted mono" style={{ fontSize: 11.5, lineHeight: 1.6 }}>
          {PROVENANCE.map((l, i) => (
            <div key={i}>{l || " "}</div>
          ))}
        </div>
        <button className="btn ghost" style={{ width: "100%", marginTop: 16 }} onClick={() => setView("root")}>
          Hide
        </button>
      </Sheet>
    );
  }

  const stableLabel: Record<StableMode, string> = {
    off: "Off — everything is bitcoin",
    whole: "Whole balance in USD",
    separate: "Separate BTC and USD balances",
  };

  return (
    <Sheet title="Settings" onClose={onClose}>
      <div className="card">
        <Row label="Recovery phrase" hint={backupVerified ? "Backed up" : "Not backed up yet"}>
          <button className="link" onClick={() => (backupVerified ? setConfirmSeed(true) : onShowBackup())}>
            {backupVerified ? "Show" : "Back up"}
          </button>
        </Row>
        <Row label="Unlock passphrase" hint="Encrypts this device's copy">
          <button className="link" onClick={() => setView("passphrase")}>
            Change
          </button>
        </Row>
      </div>

      <div className="card">
        <Row label="Stable balance" hint={stableLabel[settings.stableMode]}>
          <button className="link" onClick={() => setView("stable")}>
            Change
          </button>
        </Row>
        <Row
          label="Leaf layout"
          hint={settings.leafLayout === "exit" ? "Exit-optimized" : "Payments-optimized"}
        >
          <button className="link" onClick={() => setView("layout")}>
            Change
          </button>
        </Row>
      </div>

      <div className="card">
        <div className="kv">
          <span className="k">
            <span style={{ color: "var(--text)" }}>Hide from public explorers</span>
            <div style={{ fontSize: 12 }}>
              {privacyEnabled === null
                ? "Checking…"
                : privacyEnabled
                  ? "sparkscan returns nothing for this wallet"
                  : "This wallet's history is publicly visible"}
            </div>
          </span>
          <span className="v">
            <input
              type="checkbox"
              className="switch"
              aria-label="Hide from public explorers"
              checked={privacyEnabled === true}
              disabled={privacyEnabled === null || privacyBusy}
              onChange={async (e) => {
                setPrivacyBusy(true);
                await setPrivacy(e.target.checked);
                setPrivacyBusy(false);
              }}
            />
          </span>
        </div>
        <p className="muted" style={{ fontSize: 12.5, padding: "0 0 14px" }}>
          Stops the public Spark APIs and explorers returning your address, balance or transfers.
          It does <strong>not</strong> hide anything from the Spark operators, and it changes
          nothing on-chain — a cooperative exit still lands on Bitcoin in public. Token transfers
          stay visible either way.
        </p>
      </div>

      <div className="card">
        <div className="kv" style={{ alignItems: "center", paddingTop: 12 }}>
          <span className="k">
            <span style={{ color: "var(--text)" }}>Claim on-chain deposits automatically</span>
            <div style={{ fontSize: 12 }}>
              {settings.autoClaimDeposits
                ? `On, while the SSP fee is ${formatSats(settings.autoClaimMaxFeeSats)} sats or less`
                : "Off — every deposit waits for you to claim it"}
            </div>
          </span>
          <span className="v">
            <input
              type="checkbox"
              className="switch"
              aria-label="Claim on-chain deposits automatically"
              checked={settings.autoClaimDeposits}
              onChange={(e) => void updateSettings({ autoClaimDeposits: e.target.checked })}
            />
          </span>
        </div>

        {settings.autoClaimDeposits && (
          <label className="field" style={{ marginBottom: 6 }}>
            <span>Most you will pay the SSP, in sats</span>
            <input
              type="number"
              min={0}
              inputMode="numeric"
              value={settings.autoClaimMaxFeeSats}
              onChange={(e) => {
                const n = Math.max(0, Math.floor(Number(e.target.value)));
                if (Number.isFinite(n)) void updateSettings({ autoClaimMaxFeeSats: n });
              }}
            />
          </label>
        )}

        <p className="muted" style={{ fontSize: 12.5, padding: "0 0 14px" }}>
          A deposit priced above the ceiling is left alone for you to look at, so a fee spike never
          spends your money unattended. This is offered because an unclaimed deposit is{" "}
          <strong>not</strong> recoverable from your recovery phrase alone — until it is claimed the
          bitcoin sits at an address built from your key and the operators' together, so claiming
          (or refunding) needs them either way.
        </p>
      </div>

      <div className="card">
        <label className="field" style={{ marginBottom: 6, paddingTop: 12 }}>
          <span>Network</span>
          <select
            value={settings.network}
            onChange={(e) => setConfirmNetwork(e.target.value as "MAINNET" | "REGTEST")}
          >
            <option value="MAINNET">Mainnet</option>
            <option value="REGTEST">Regtest</option>
          </select>
        </label>
        <p className="muted" style={{ fontSize: 12.5, margin: 0, paddingBottom: 12 }}>
          The same phrase is a different wallet on each network. Switching re-locks the wallet.
        </p>
      </div>

      <div className="card">
        <Row label="Exit to Bitcoin" hint="Cooperative and unilateral">
          <button className="link" onClick={() => setView("exit")}>
            Open
          </button>
        </Row>
      </div>

      <div className="card pad">
        <p className="muted" style={{ fontSize: 12.5, margin: 0 }}>
          Balance is held by the Spark network, not by this browser. The same phrase on another
          device shows the same balance — it is shared, not duplicated.
        </p>
      </div>

      <button className="btn ghost" style={{ width: "100%" }} onClick={() => void lock().then(onClose)}>
        Lock now
      </button>
      <button className="btn danger" style={{ width: "100%", marginTop: 10 }} onClick={() => setConfirmWipe(true)}>
        Wipe this wallet
      </button>

      {confirmSeed && (
        <Confirm
          title="Show recovery phrase?"
          body={
            <p>
              Your 12 words are about to appear on screen. Anyone who sees them — in person, over a
              screen share, in a screenshot — can take everything in this wallet.
            </p>
          }
          confirmLabel="Show it"
          onCancel={() => setConfirmSeed(false)}
          onConfirm={() => {
            setConfirmSeed(false);
            setView("seed");
          }}
        />
      )}

      {confirmNetwork && (
        <Confirm
          title="Switch network?"
          body={
            <p>
              Switching to <strong>{confirmNetwork === "MAINNET" ? "mainnet" : "regtest"}</strong>{" "}
              locks the wallet. Unlock again to reconnect. Your phrase controls a separate wallet on
              each network, so the balance will look different — nothing is lost.
            </p>
          }
          confirmLabel="Switch"
          onCancel={() => setConfirmNetwork(null)}
          onConfirm={async () => {
            await updateSettings({ network: confirmNetwork });
            setConfirmNetwork(null);
            await lock();
          }}
        />
      )}

      {confirmWipe && (
        <Confirm
          title="Wipe this wallet?"
          danger
          requirePhrase="WIPE"
          body={
            <>
              <p>
                This deletes the encrypted phrase, the history, and the settings stored in this
                browser.
              </p>
              <div className="notice stark">
                Your <strong>12-word recovery phrase is the only way back</strong>. If it is not
                written down somewhere you can reach, the money is gone permanently. Nobody can
                undo this.
              </div>
            </>
          }
          confirmLabel="Wipe everything"
          onCancel={() => setConfirmWipe(false)}
          onConfirm={async () => {
            setConfirmWipe(false);
            await wipe();
          }}
        />
      )}
    </Sheet>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="kv">
      <span className="k">
        <span style={{ color: "var(--text)" }}>{label}</span>
        {hint && <div style={{ fontSize: 12 }}>{hint}</div>}
      </span>
      <span className="v">{children}</span>
    </div>
  );
}

function Option({
  pressed,
  title,
  children,
  onClick,
  disabled,
}: {
  pressed: boolean;
  title: string;
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button className="option" aria-pressed={pressed} disabled={disabled} onClick={onClick}>
      <div className="t">{title}</div>
      <div className="d">{children}</div>
    </button>
  );
}

function StableBalance({ onDone }: { onDone: () => void }) {
  const mode = useWallet((s) => s.settings.stableMode);
  const network = useWallet((s) => s.settings.network);
  const stableBusy = useWallet((s) => s.stableBusy);
  const stableNote = useWallet((s) => s.stableNote);
  const error = useWallet((s) => s.error);
  const setStableMode = useWallet((s) => s.setStableMode);
  const exitRunning = useWallet(selectExitLocked);

  const [busy, setBusy] = useState(false);
  const supported = stableSupported(network);
  const locked = busy || stableBusy || exitRunning;

  async function pick(next: StableMode) {
    if (next === mode) return;
    setBusy(true);
    await setStableMode(next);
    setBusy(false);
  }

  return (
    <Sheet title="Stable balance" onClose={onDone}>
      <p className="muted">
        Hold dollars instead of bitcoin, so the balance does not move with the bitcoin price.
      </p>

      {!supported && (
        <div className="banner danger">
          <div className="banner-body">
            Not available on regtest — no USD stablecoin has swap liquidity there. Switch to mainnet
            to use it.
          </div>
        </div>
      )}
      {exitRunning && (
        <div className="banner danger">
          <div className="banner-body">A unilateral exit is in progress. Finish or forget it first.</div>
        </div>
      )}

      <Option pressed={mode === "off"} title="Off" disabled={locked} onClick={() => void pick("off")}>
        Everything is bitcoin. Turning this off converts any USD back to bitcoin.
      </Option>
      <Option
        pressed={mode === "whole"}
        title="Whole balance in USD"
        disabled={locked || !supported}
        onClick={() => void pick("whole")}
      >
        Your entire balance is held as USD. Every incoming payment converts on arrival, and when you
        pay in bitcoin, just enough USD converts back first.
      </Option>
      <Option
        pressed={mode === "separate"}
        title="Separate balances"
        disabled={locked || !supported}
        onClick={() => void pick("separate")}
      >
        Keep bitcoin and USD side by side and move between them yourself. A switch above the
        balance flips between the two.
      </Option>

      {mode === "separate" && supported && <MixSlider locked={locked} />}

      {(busy || stableBusy) && (
        <p className="muted center">
          <Spinner /> Converting…
        </p>
      )}
      {stableNote && <p className="muted" style={{ fontSize: 13 }}>{stableNote}</p>}
      {error && <div className="err">{error}</div>}

      <div className="notice">
        <strong style={{ color: "var(--text)" }}>What USD means here.</strong> The dollars are
        USDB, a stablecoin on Spark issued by Brale and backed by dollar reserves. Holding it means
        trusting Brale the way you would trust any stablecoin issuer — it is not self-custodial
        bitcoin. Conversions go through Flashnet's exchange, which signs you in with this wallet's
        key rather than an account. Each swap pays a small pool fee, and amounts below about 800
        sats or $0.50 cannot be converted, so tiny payments stay as bitcoin.
      </div>
    </Sheet>
  );
}

const SLIDER_STEPS = 1000;
const USD_UNITS = 1_000_000;

function parseSats(text: string): number | null {
  const t = text.replace(/[,\s_]/g, "");
  if (!/^\d+$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

function parseUsdUnits(text: string): number | null {
  const t = text.replace(/[$,\s]/g, "");
  if (!/^\d*(\.\d{0,6})?$/.test(t) || t === "" || t === ".") return null;
  const [whole, frac = ""] = t.split(".");
  return Number(whole || "0") * USD_UNITS + Number(frac.padEnd(6, "0"));
}

const usdText = (units: number) => (Math.floor(units / 10_000) / 100).toFixed(2);

/**
 * Separate balances: a slider from 100% USD (left) to 100% bitcoin (right),
 * with both figures above it editable.
 *
 * The side you set is the anchor and lands exactly; the other side is an
 * estimate from a live quote, before the pool's fee and slippage. Moving the
 * slider anchors whichever side is shrinking, so that swap is an exact spend.
 * Nothing converts until Confirm.
 */
function MixSlider({ locked }: { locked: boolean }) {
  const balance = useWallet((s) => s.balance);
  const usdbUnits = useWallet((s) => s.usdbUnits);
  const rebalance = useWallet((s) => s.rebalance);
  const quoteUnitsPerSat = useWallet((s) => s.quoteUnitsPerSat);

  const [rate, setRate] = useState<number | null | "loading">("loading");
  const [draft, setDraft] = useState<{ anchor: "btc" | "usd"; sats: number; units: number } | null>(null);
  const [btcInput, setBtcInput] = useState<string | null>(null);
  const [usdInput, setUsdInput] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sats = balance.available;
  const units = Number(usdbUnits);

  useEffect(() => {
    let alive = true;
    setRate("loading");
    void quoteUnitsPerSat().then((r) => alive && setRate(r));
    return () => {
      alive = false;
    };
  }, [quoteUnitsPerSat, sats, units]);

  const priced = typeof rate === "number" && rate > 0;
  /** The whole balance valued in sats. */
  const totalSats = priced ? sats + units / rate : sats;
  const shown = draft ?? { anchor: "btc" as const, sats, units };
  const position = totalSats > 0 ? Math.round((shown.sats / totalSats) * SLIDER_STEPS) : SLIDER_STEPS;

  function reset() {
    setDraft(null);
    setBtcInput(null);
    setUsdInput(null);
  }

  function fromSlider(v: number) {
    if (!priced) return;
    const targetSats = Math.round((v / SLIDER_STEPS) * totalSats);
    const targetUnits = Math.max(0, Math.round((totalSats - targetSats) * rate));
    const anchor = targetSats < sats ? "btc" : "usd";
    // Snap the exact side to the ends so "all" really means all.
    const exactSats = v === 0 ? 0 : targetSats;
    const exactUnits = v === SLIDER_STEPS ? 0 : targetUnits;
    setDraft({ anchor, sats: exactSats, units: exactUnits });
    setBtcInput(null);
    setUsdInput(null);
  }

  function fromBtc(text: string) {
    setBtcInput(text);
    setUsdInput(null);
    const n = parseSats(text);
    if (n === null || !priced) return;
    const clamped = Math.min(n, Math.floor(totalSats));
    setDraft({ anchor: "btc", sats: clamped, units: Math.max(0, Math.round((totalSats - clamped) * rate)) });
  }

  function fromUsd(text: string) {
    setUsdInput(text);
    setBtcInput(null);
    const n = parseUsdUnits(text);
    if (n === null || !priced) return;
    const clamped = Math.min(n, Math.floor(totalSats * rate));
    setDraft({ anchor: "usd", units: clamped, sats: Math.max(0, Math.round(totalSats - clamped / rate)) });
  }

  const changed = !!draft && (draft.anchor === "btc" ? draft.sats !== sats : draft.units !== units);

  async function confirm() {
    if (!draft) return;
    setBusy(true);
    await rebalance(draft.anchor, BigInt(draft.anchor === "btc" ? draft.sats : draft.units));
    setBusy(false);
    reset();
  }

  return (
    <div className="card pad">
      <div className="mix-amounts">
        <label>
          <span>Bitcoin (sats){draft?.anchor === "usd" ? " · estimate" : ""}</span>
          <input
            type="text"
            inputMode="numeric"
            value={btcInput ?? shown.sats.toLocaleString("en-US")}
            disabled={locked || busy || !priced}
            onChange={(e) => fromBtc(e.target.value)}
            onBlur={() => setBtcInput(null)}
          />
        </label>
        <label>
          <span>USD{draft?.anchor === "btc" ? " · estimate" : ""}</span>
          <input
            type="text"
            inputMode="decimal"
            value={usdInput ?? usdText(shown.units)}
            disabled={locked || busy || !priced}
            onChange={(e) => fromUsd(e.target.value)}
            onBlur={() => setUsdInput(null)}
          />
        </label>
      </div>

      <input
        type="range"
        className="mix-slider"
        min={0}
        max={SLIDER_STEPS}
        step={1}
        value={position}
        aria-label="Split between USD (left) and bitcoin (right)"
        disabled={locked || busy || !priced || totalSats <= 0}
        onChange={(e) => fromSlider(Number(e.target.value))}
      />
      <div className="mix-ends">
        <span>100% USD</span>
        <span>100% BTC</span>
      </div>

      {rate === "loading" && (
        <p className="muted" style={{ fontSize: 12.5 }}>
          <Spinner /> Getting a price…
        </p>
      )}
      {rate === null && (
        <p className="err">Could not get a price from the exchange right now, so the split cannot be changed.</p>
      )}
      {changed && draft && (
        <p className="muted" style={{ fontSize: 12.5 }}>
          {draft.anchor === "btc"
            ? draft.sats < sats
              ? `Converts exactly ${formatSats(sats - draft.sats)} sats to USD.`
              : `Converts about ${formatUsd(BigInt(Math.max(0, units - draft.units)))} of USD so bitcoin lands on ${formatSats(draft.sats)} sats.`
            : draft.units < units
              ? `Converts exactly ${formatUsd(BigInt(units - draft.units))} to bitcoin.`
              : `Converts about ${formatSats(Math.max(0, sats - draft.sats))} sats so USD lands on ${formatUsd(BigInt(draft.units))}.`}{" "}
          The other figure is an estimate before the pool fee.
        </p>
      )}

      <div className="row" style={{ marginTop: 6 }}>
        <button className="btn ghost" disabled={!draft || busy} onClick={reset}>
          Reset
        </button>
        <button className="btn primary" disabled={!changed || locked || busy} onClick={() => void confirm()}>
          {busy ? <Spinner /> : "Confirm"}
        </button>
      </div>
    </div>
  );
}

function LeafLayoutView({ onDone }: { onDone: () => void }) {
  const layout = useWallet((s) => s.settings.leafLayout);
  const setLeafLayout = useWallet((s) => s.setLeafLayout);
  const error = useWallet((s) => s.error);
  const exitRunning = useWallet(selectExitLocked);
  const [busy, setBusy] = useState<LeafLayout | null>(null);

  async function pick(next: LeafLayout) {
    if (next === layout) return;
    setBusy(next);
    await setLeafLayout(next);
    setBusy(null);
  }

  return (
    <Sheet title="Leaf layout" onClose={onDone}>
      <p className="muted">
        Spark holds your balance as leaves, each worth a power of two sats. How they are split is a
        trade-off between fast payments and a cheap escape hatch.
      </p>

      <Option
        pressed={layout === "payments"}
        title="Payments-optimized (default)"
        disabled={busy !== null || exitRunning}
        onClick={() => void pick("payments")}
      >
        A spread of sizes, so most payments go out without rearranging first. A unilateral exit
        costs more and strands more value as dust, because there are many small leaves.
      </Option>
      <Option
        pressed={layout === "exit"}
        title="Exit-optimized"
        disabled={busy !== null || exitRunning}
        onClick={() => void pick("exit")}
      >
        The fewest, largest leaves. The cheapest unilateral exit and the least dust. Some payments
        need a quick swap first, adding a moment before they send.
      </Option>

      {busy && (
        <p className="muted center">
          <Spinner /> Rearranging leaves…
        </p>
      )}
      {exitRunning && (
        <p className="muted" style={{ fontSize: 12.5 }}>
          Locked while a unilateral exit is in progress — changing leaves now would change what is
          being exited.
        </p>
      )}
      {error && <div className="err">{error}</div>}
    </Sheet>
  );
}

function ChangePassphrase({ onDone }: { onDone: () => void }) {
  const change = useWallet((s) => s.changePassphrase);
  const progress = useWallet((s) => s.kdfProgress);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const ready = current && next.length >= MIN_PASSPHRASE_LENGTH && next === confirm && !busy;

  return (
    <Sheet title="Change passphrase" onClose={onDone}>
      <label className="field">
        <span>Current passphrase</span>
        <input type="password" value={current} autoComplete="current-password" onChange={(e) => setCurrent(e.target.value)} />
      </label>
      <label className="field">
        <span>New passphrase ({MIN_PASSPHRASE_LENGTH} characters minimum)</span>
        <input type="password" value={next} autoComplete="new-password" onChange={(e) => setNext(e.target.value)} />
      </label>
      <label className="field">
        <span>Confirm new passphrase</span>
        <input type="password" value={confirm} autoComplete="new-password" onChange={(e) => setConfirm(e.target.value)} />
      </label>

      {err && <div className="err">{err}</div>}
      <p className="muted" style={{ fontSize: 12.5 }}>
        This re-encrypts the stored phrase. Your 12 words do not change, and a backup made before
        now is still valid.
      </p>

      <button
        className="btn primary"
        style={{ width: "100%" }}
        disabled={!ready}
        onClick={async () => {
          setBusy(true);
          setErr(null);
          const ok = await change(current, next);
          setBusy(false);
          if (ok) onDone();
          else setErr("That current passphrase didn't work.");
        }}
      >
        {busy ? (
          <>
            <Spinner /> Re-encrypting…{progress > 0 ? ` ${Math.round(progress * 100)}%` : ""}
          </>
        ) : (
          "Change passphrase"
        )}
      </button>
    </Sheet>
  );
}
