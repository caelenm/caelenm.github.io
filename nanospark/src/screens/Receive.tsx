import { useEffect, useState } from "react";
import { useWallet } from "../store/wallet";
import { CopyButton, QR, Sheet, Spinner } from "../components/ui";
import { countdown, formatSats, readableError, truncateMiddle } from "../lib/format";
import { DEPOSIT_CONFIRMATIONS } from "../lib/deposits";

type Tab = "invoice" | "address";

export function Receive({ onClose, onBackup }: { onClose: () => void; onBackup: () => void }) {
  const backupVerified = useWallet((s) => s.backupVerified);
  const [tab, setTab] = useState<Tab>("invoice");

  // The gate (§3.3): no receiving until the phrase is verified. The wallet
  // should be recoverable before it can ever hold money.
  if (!backupVerified) {
    return (
      <Sheet title="Back up first" onClose={onClose}>
        <p>
          Receiving is locked until your recovery phrase is written down and checked.
        </p>
        <p className="muted">
          This takes about a minute. It exists because there is no other way to recover this wallet
          — if money arrives before the phrase is saved, a cleared browser takes it with it.
        </p>
        <button className="btn primary" style={{ width: "100%", marginTop: 16 }} onClick={onBackup}>
          Back up my phrase
        </button>
      </Sheet>
    );
  }

  return (
    <Sheet title="Receive" onClose={onClose}>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "invoice"} onClick={() => setTab("invoice")}>
          Invoice
        </button>
        <button role="tab" aria-selected={tab === "address"} onClick={() => setTab("address")}>
          Address
        </button>
      </div>
      {tab === "invoice" ? <InvoiceTab /> : <AddressTab />}
    </Sheet>
  );
}

function InvoiceTab() {
  const wallet = useWallet((s) => s.wallet);
  const activity = useWallet((s) => s.activity);

  const [amount, setAmount] = useState("");
  const [memo, setMemo] = useState("");
  const [invoice, setInvoice] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [paid, setPaid] = useState(false);
  const [now, setNow] = useState(Date.now());

  // Any newly settled incoming transfer while an invoice is on screen is
  // treated as this one being paid. The SDK's TransferClaimed event drives
  // the refresh that produces it.
  const incomingCount = activity.filter((a) => a.direction === "in").length;
  const [baseline, setBaseline] = useState<number | null>(null);
  useEffect(() => {
    if (invoice && baseline !== null && incomingCount > baseline) setPaid(true);
  }, [incomingCount, baseline, invoice]);

  useEffect(() => {
    if (!invoice) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [invoice]);

  const sats = Number(amount);
  const valid = Number.isFinite(sats) && sats > 0 && Number.isInteger(sats);

  async function generate() {
    if (!wallet || !valid) return;
    setBusy(true);
    setErr(null);
    try {
      const res = await wallet.createLightningInvoice({
        amountSats: sats,
        memo: memo.trim() || undefined,
        expirySeconds: 3600,
      });
      setInvoice(res.invoice.encodedInvoice);
      setExpiresAt(Date.now() + 3600_000);
      setBaseline(incomingCount);
    } catch (e) {
      setErr(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  if (paid && invoice) {
    return (
      <div className="center">
        <div className="big-tick ok-text">✓</div>
        <h2>Paid</h2>
        <p className="muted">{formatSats(sats)} sats received.</p>
        <button
          className="btn ghost"
          style={{ width: "100%", marginTop: 16 }}
          onClick={() => {
            setInvoice(null);
            setPaid(false);
            setAmount("");
            setMemo("");
            setBaseline(null);
          }}
        >
          New invoice
        </button>
      </div>
    );
  }

  if (invoice) {
    const remaining = expiresAt - now;
    return (
      <div>
        <QR value={invoice.toUpperCase()} />
        <div className="center muted" style={{ marginBottom: 12 }}>
          {formatSats(sats)} sats · expires in {countdown(remaining)}
        </div>
        {remaining <= 0 && (
          <div className="err center">This invoice has expired. Generate a new one.</div>
        )}
        <div className="mono card">{truncateMiddle(invoice, 34, 28)}</div>
        <div className="row">
          <CopyButton value={invoice} label="Copy invoice" />
          {typeof navigator.share === "function" && (
            <button
              className="btn ghost"
              onClick={() => void navigator.share({ text: invoice }).catch(() => {})}
            >
              Share
            </button>
          )}
        </div>
        <button
          className="btn ghost"
          style={{ width: "100%", marginTop: 10 }}
          onClick={() => {
            setInvoice(null);
            setBaseline(null);
          }}
        >
          Back
        </button>
        <p className="muted center" style={{ marginTop: 12, fontSize: 12.5 }}>
          Waiting for payment. You can close this — it will still arrive.
        </p>
      </div>
    );
  }

  return (
    <div>
      <label className="field">
        <span>Amount in sats</span>
        <input
          type="number"
          inputMode="numeric"
          min={1}
          value={amount}
          autoFocus
          placeholder="0"
          onChange={(e) => setAmount(e.target.value)}
        />
      </label>
      <label className="field">
        <span>Memo (optional)</span>
        <input type="text" value={memo} maxLength={120} onChange={(e) => setMemo(e.target.value)} />
      </label>
      {err && <div className="err">{err}</div>}
      <button className="btn primary" style={{ width: "100%" }} disabled={!valid || busy} onClick={() => void generate()}>
        {busy ? (
          <>
            <Spinner /> Creating…
          </>
        ) : (
          "Create invoice"
        )}
      </button>
    </div>
  );
}

function AddressTab() {
  const wallet = useWallet((s) => s.wallet);
  const sparkAddress = useWallet((s) => s.sparkAddress);
  const knownDeposit = useWallet((s) => s.staticDepositAddress);
  const deposits = useWallet((s) => s.deposits);
  const checkDeposits = useWallet((s) => s.checkDeposits);
  const [fetched, setFetched] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [which, setWhich] = useState<"spark" | "onchain">("spark");
  const deposit = knownDeposit ?? fetched;

  useEffect(() => {
    if (which !== "onchain" || deposit || !wallet) return;
    let cancelled = false;
    wallet
      .getStaticDepositAddress()
      .then((a) => {
        if (!cancelled) setFetched(a);
      })
      .catch((e) => {
        if (!cancelled) setErr(readableError(e));
      });
    return () => {
      cancelled = true;
    };
  }, [which, deposit, wallet]);

  // Look for new deposits whenever the on-chain address is on screen.
  useEffect(() => {
    if (which === "onchain") void checkDeposits();
  }, [which, checkDeposits]);

  const value = which === "spark" ? sparkAddress : deposit;

  return (
    <div>
      <div className="tabs" style={{ marginBottom: 14 }}>
        <button aria-selected={which === "spark"} onClick={() => setWhich("spark")}>
          Spark
        </button>
        <button aria-selected={which === "onchain"} onClick={() => setWhich("onchain")}>
          On-chain
        </button>
      </div>

      {err && <div className="err">{err}</div>}

      {value ? (
        <>
          <QR value={value} />
          <div className="mono card">{value}</div>
          <CopyButton value={value} label="Copy address" />
        </>
      ) : (
        <p className="muted center" style={{ padding: "30px 0" }}>
          <Spinner /> Fetching address…
        </p>
      )}

      <p className="muted" style={{ marginTop: 14, fontSize: 12.5 }}>
        {which === "spark"
          ? "Your Spark address. Reusable, and instant for anyone paying from another Spark wallet."
          : `A reusable Bitcoin address. A deposit can be claimed into your balance once it has ${DEPOSIT_CONFIRMATIONS} confirmations (about ${DEPOSIT_CONFIRMATIONS * 10} minutes on mainnet), and the SSP charges a fee to convert it — shown below before you claim.`}
      </p>

      {which === "onchain" && deposits.length > 0 && <PendingDeposits />}
    </div>
  );
}

/** Deposits to the static address, waiting to be claimed. Nothing credits until claimed. */
export function PendingDeposits() {
  const deposits = useWallet((s) => s.deposits);
  const claimDeposit = useWallet((s) => s.claimDeposit);
  const error = useWallet((s) => s.error);
  const [claiming, setClaiming] = useState<string | null>(null);

  return (
    <div className="card pad" style={{ marginTop: 14 }}>
      <div className="muted" style={{ fontSize: 12.5, marginBottom: 8 }}>
        Deposits waiting to be claimed
      </div>
      {deposits.map((d) => {
        const id = `${d.txid}:${d.vout}`;
        const ready = d.confirmations >= DEPOSIT_CONFIRMATIONS && d.creditSats !== null;
        const fee = d.valueSats !== null && d.creditSats !== null ? d.valueSats - d.creditSats : null;
        return (
          <div key={id} className="kv" style={{ alignItems: "center" }}>
            <span className="k">
              <span style={{ color: "var(--text)" }}>
                {d.valueSats !== null ? `${formatSats(d.valueSats)} sats` : truncateMiddle(d.txid, 8, 6)}
              </span>
              <div style={{ fontSize: 12 }}>
                {d.confirmations < DEPOSIT_CONFIRMATIONS
                  ? `${d.confirmations} of ${DEPOSIT_CONFIRMATIONS} confirmations`
                  : d.creditSats !== null
                    ? `Credits ${formatSats(d.creditSats)} sats${fee !== null ? ` · SSP fee ${formatSats(fee)}` : ""}`
                    : `No quote yet${d.quoteError ? ` — ${d.quoteError}` : ""}`}
              </div>
            </span>
            <span className="v">
              <button
                className="btn primary"
                style={{ padding: "9px 14px", fontSize: 14 }}
                disabled={!ready || claiming !== null}
                onClick={async () => {
                  setClaiming(id);
                  await claimDeposit(d.txid, d.vout);
                  setClaiming(null);
                }}
              >
                {claiming === id ? <Spinner /> : "Claim"}
              </button>
            </span>
          </div>
        );
      })}
      {error && <div className="err">{error}</div>}
    </div>
  );
}
