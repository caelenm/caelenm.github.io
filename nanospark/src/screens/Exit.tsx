import { useEffect, useState } from "react";
import { ExitSpeed } from "@buildonspark/spark-sdk/types";
import { selectExitLocked, useWallet } from "../store/wallet";
import { validateOnchainAddress } from "../lib/address";
import { Confirm, CopyButton, QR, Sheet, Spinner } from "../components/ui";
import { formatSats, readableError, relativeTime, truncateMiddle } from "../lib/format";
import {
  DUST_LIMIT_SATS,
  planWithdrawal,
  quoteWithdrawal,
  submitWithdrawal,
  validateWithdrawal,
  type FeeQuote,
} from "../lib/onchain";
import { BLOCK_SECONDS, EXPLORER_URL, type ExitNetwork, type LeafProgress } from "../lib/unilateral";
import { BundleError, pasteLine, pushUrl, type ExitBundle, type ExitPlan } from "../lib/exitBundle";

/**
 * Exit to Bitcoin L1 (§3.7).
 *
 * Two genuinely different things live here, and conflating them would be
 * dishonest about what self-custody on Spark rests on:
 *
 *   Cooperative exit — the SSP signs, it is fast and cheap, and it needs the
 *   SSP to be willing. This is the normal path.
 *
 *   Unilateral exit — the escape hatch. It works with no cooperation from
 *   anyone, which is the entire basis of the self-custody claim.
 */
export function Exit({ onClose }: { onClose: () => void }) {
  const exitLocked = useWallet(selectExitLocked);
  const [tab, setTab] = useState<"coop" | "unilateral">(exitLocked ? "unilateral" : "coop");
  return (
    <Sheet title="Exit to Bitcoin" onClose={onClose}>
      <div className="tabs" role="tablist">
        <button role="tab" aria-selected={tab === "coop"} onClick={() => setTab("coop")}>
          Cooperative
        </button>
        <button role="tab" aria-selected={tab === "unilateral"} onClick={() => setTab("unilateral")}>
          Unilateral
        </button>
      </div>
      {tab === "coop" ? <Cooperative /> : <Unilateral />}
    </Sheet>
  );
}

export function Cooperative({ initialAddress = "" }: { initialAddress?: string }) {
  const wallet = useWallet((s) => s.wallet);
  const balance = useWallet((s) => s.balance);
  const refresh = useWallet((s) => s.refresh);
  const usdbUnits = useWallet((s) => s.usdbUnits);
  const stableMode = useWallet((s) => s.settings.stableMode);
  const withStableCover = useWallet((s) => s.withStableCover);
  const exitRunning = useWallet(selectExitLocked);
  const network = useWallet((s) => s.settings.network);

  const [address, setAddress] = useState(initialAddress);
  const [amount, setAmount] = useState("");
  const [isMax, setIsMax] = useState(false);
  const [speed, setSpeed] = useState<ExitSpeed>(ExitSpeed.MEDIUM);
  const [fee, setFee] = useState<FeeQuote | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // In whole-balance mode the bitcoin for an exact-amount withdrawal is
  // converted from USD just in time. Max stays bitcoin-only: "everything" is
  // ambiguous once part of the balance is dollars.
  const stableCovers = stableMode === "whole" && usdbUnits > 0n;

  const sats = Number(amount);
  const amountOk = isMax ? balance.available > 0 : Number.isInteger(sats) && sats > 0;
  // Checked locally rather than left to the SSP: a mistyped address still has a
  // valid-looking length, and paying one loses the money for good.
  const addressCheck = validateOnchainAddress(address, network);
  const canQuote = !exitRunning && addressCheck.ok && amountOk && (balance.available > 0 || stableCovers);

  /** Any change to the inputs invalidates the quote — it is priced per address, amount and speed. */
  function invalidate<T>(setter: (v: T) => void) {
    return (v: T) => {
      setFee(null);
      setErr(null);
      setter(v);
    };
  }

  function budget(mode: "exact" | "max") {
    return stableCovers && mode === "exact" ? Number.MAX_SAFE_INTEGER : balance.available;
  }

  async function getQuote() {
    if (!wallet || !canQuote) return;
    setBusy(true);
    setErr(null);
    try {
      const q = await quoteWithdrawal(wallet, address, isMax ? balance.available : sats, speed);
      if (!q) {
        setErr("The SSP would not quote this withdrawal. Try a different amount, or use a unilateral exit.");
        return;
      }
      const plan = planWithdrawal(balance.available, isMax ? "max" : sats, q);
      const check = validateWithdrawal(plan, budget(plan.mode));
      if (!check.ok) {
        setErr(check.reason);
        return;
      }
      setFee(q);
    } catch (e) {
      setErr(readableError(e));
    } finally {
      setBusy(false);
    }
  }

  async function withdraw() {
    if (!wallet || !fee) return;
    // Re-checked at the point of no return: the quote was fetched against this
    // address, but nothing stops it having been edited since.
    const check = validateOnchainAddress(address, network);
    if (!check.ok) {
      setErr(check.reason);
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      const plan = planWithdrawal(balance.available, isMax ? "max" : sats, fee);
      const submit = () => submitWithdrawal(wallet, address, plan, fee);
      if (plan.mode === "exact" && stableCovers) {
        await withStableCover(plan.amountSats + plan.feeSats, submit);
      } else {
        await submit();
      }
      setDone(true);
      void refresh();
    } catch (e) {
      setErr(e instanceof Error && e.name === "Error" && e.message.includes("USD") ? e.message : readableError(e));
      void refresh();
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <div className="center">
        <div className="big-tick ok-text">✓</div>
        <h2>Withdrawal submitted</h2>
        <p className="muted">
          It will confirm on Bitcoin in its own time. The balance updates when it settles.
        </p>
      </div>
    );
  }

  const plan = fee ? planWithdrawal(balance.available, isMax ? "max" : sats, fee) : null;
  const convertsFromUsd =
    !!plan && plan.mode === "exact" && stableCovers && plan.amountSats + plan.feeSats > balance.available;

  return (
    <div>
      <p className="muted">
        The SSP signs a transaction paying you on-chain. Fast, cheap, and dependent on the SSP
        being willing to cooperate.
      </p>

      {exitRunning && (
        <div className="err">A unilateral exit is armed or in progress, so cooperative withdrawals are paused.</div>
      )}

      <label className="field">
        <span>Bitcoin address</span>
        <input
          type="text"
          value={address}
          placeholder="bc1…"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => invalidate(setAddress)(e.target.value)}
        />
        {/* Only once they have typed something worth judging — an error on an
            empty field is noise, not help. */}
        {address.trim().length > 0 && !addressCheck.ok && (
          <div className="err">{addressCheck.reason}</div>
        )}
      </label>

      <label className="field">
        <span>
          Amount in sats
          <button
            className="chip"
            aria-pressed={isMax}
            onClick={() => {
              setFee(null);
              setErr(null);
              setIsMax((m) => !m);
              setAmount("");
            }}
          >
            Max
          </button>
        </span>
        <input
          type="number"
          inputMode="numeric"
          value={isMax ? "" : amount}
          disabled={isMax}
          placeholder={isMax ? `Everything — ${formatSats(balance.available)} sats minus fee` : "0"}
          onChange={(e) => invalidate(setAmount)(e.target.value)}
        />
      </label>

      <label className="field">
        <span>Speed</span>
        <select value={speed} onChange={(e) => invalidate(setSpeed)(e.target.value as ExitSpeed)}>
          <option value={ExitSpeed.FAST}>Fast</option>
          <option value={ExitSpeed.MEDIUM}>Medium</option>
          <option value={ExitSpeed.SLOW}>Slow</option>
        </select>
      </label>

      {err && <div className="err">{err}</div>}

      {fee && plan ? (
        <>
          <div className="card">
            <div className="kv">
              <span className="k">They receive</span>
              <span className="v">{formatSats(plan.receivesSats)} sats</span>
            </div>
            <div className="kv">
              <span className="k">SSP fee</span>
              <span className="v">{formatSats(fee.userFeeSats)} sats</span>
            </div>
            <div className="kv">
              <span className="k">On-chain fee</span>
              <span className="v">{formatSats(fee.broadcastFeeSats)} sats</span>
            </div>
            <div className="kv">
              <span className="k">Leaves your wallet</span>
              <span className="v total">
                {formatSats(plan.mode === "max" ? balance.available : plan.amountSats + plan.feeSats)} sats
              </span>
            </div>
          </div>
          {convertsFromUsd && (
            <p className="muted" style={{ fontSize: 12.5 }}>
              The bitcoin for this converts from your USD balance first.
            </p>
          )}
          <button className="btn primary" style={{ width: "100%" }} disabled={busy} onClick={() => void withdraw()}>
            {busy ? <Spinner /> : "Confirm withdrawal"}
          </button>
          <button className="btn ghost" style={{ width: "100%", marginTop: 10 }} onClick={() => setFee(null)}>
            Back
          </button>
        </>
      ) : (
        <button className="btn ghost" style={{ width: "100%" }} disabled={!canQuote || busy} onClick={() => void getQuote()}>
          {busy ? <Spinner /> : "Get a quote"}
        </button>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Unilateral                                                          */
/* ------------------------------------------------------------------ */

function Unilateral() {
  const job = useWallet((s) => s.exit.job);
  const capture = useWallet((s) => s.exit.capture);
  // An exit started in the browser by an earlier version is driven to the end.
  if (job) return <EngineProgress />;
  return capture ? <BundleBuilder /> : <StartExit />;
}

function StartExit() {
  const exit = useWallet((s) => s.exit);
  const network = useWallet((s) => s.settings.network);
  const leafLayout = useWallet((s) => s.settings.leafLayout);
  const captureForExit = useWallet((s) => s.captureForExit);
  const [confirm, setConfirm] = useState(false);

  return (
    <div>
      <p className="muted">
        The escape hatch. It works even if every Spark operator and the SSP stop answering — which
        is the only reason "self-custodial" means anything here. Use the cooperative exit whenever
        it works: it is one transaction and far cheaper.
      </p>

      <div className="notice stark">
        Not yet verified end to end on a live network. Keep the cooperative path as your primary
        route out until a unilateral exit has landed on regtest.
      </div>

      <div className="notice">
        <strong style={{ color: "var(--text)" }}>How it works.</strong> This wallet captures your
        leaves' pre-signed transactions and turns them into an <strong>exit bundle</strong>: a text
        file of steps you paste into{" "}
        <a href={pushUrl(network)} target="_blank" rel="noreferrer">
          {pushUrl(network).replace("https://", "")}
        </a>{" "}
        (or your own mempool instance) yourself. Finishing it needs nothing from this app, the
        operators, or an open tab. Each leaf's last steps are timelocked —{" "}
        {network === "MAINNET" ? "on mainnet that can be weeks" : "on regtest roughly a day"}.
      </div>

      {leafLayout === "payments" && (
        <div className="notice">
          Your wallet is payments-optimized, so it holds many small leaves; those below about{" "}
          {DUST_LIMIT_SATS} sats, or worth less than their fees, are left behind. Switching Settings →
          Leaf layout to exit-optimized first consolidates them.
        </div>
      )}

      {exit.error && <div className="err">{exit.error}</div>}

      <button className="btn danger" style={{ width: "100%" }} disabled={exit.running} onClick={() => setConfirm(true)}>
        {exit.running ? (
          <>
            <Spinner /> Capturing leaves…
          </>
        ) : (
          "Prepare a unilateral exit"
        )}
      </button>

      {confirm && (
        <Confirm
          title="Prepare a unilateral exit?"
          body={
            <>
              <p>
                This captures every leaf's exit transactions from the Spark operators and arms the
                exit.
              </p>
              <div className="notice stark">
                While armed, sending, conversions and leaf rearranging are paused — any of them would
                make the captured transactions stale. Nothing is broadcast yet, and you can cancel
                until you paste the first step yourself.
              </div>
            </>
          }
          confirmLabel="Capture and arm"
          onCancel={() => setConfirm(false)}
          onConfirm={async () => {
            setConfirm(false);
            await captureForExit();
          }}
        />
      )}
    </div>
  );
}

function BundleBuilder() {
  const capture = useWallet((s) => s.exit.capture)!;
  const feeAddress = useWallet((s) => s.exit.feeAddress);
  const planExitBundle = useWallet((s) => s.planExitBundle);
  const signExitBundle = useWallet((s) => s.signExitBundle);
  const cancelExitBundle = useWallet((s) => s.cancelExitBundle);
  const recommendedFeeRate = useWallet((s) => s.recommendedFeeRate);
  const network = capture.network;

  const [destination, setDestination] = useState("");
  const [feeRate, setFeeRate] = useState("");
  const [suggested, setSuggested] = useState<number | null>(null);
  const [plan, setPlan] = useState<ExitPlan | null>(null);
  const [bundle, setBundle] = useState<ExitBundle | null>(null);
  const [busy, setBusy] = useState<"plan" | "sign" | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [confirmCancel, setConfirmCancel] = useState(false);

  useEffect(() => {
    let alive = true;
    void recommendedFeeRate().then((r) => {
      if (!alive || r === null) return;
      setSuggested(r);
      setFeeRate((v) => v || String(r));
    });
    return () => {
      alive = false;
    };
  }, [recommendedFeeRate]);

  const rate = Number(feeRate);
  const canPlan = destination.trim().length > 14 && Number.isFinite(rate) && rate >= 1 && !busy;

  async function makePlan() {
    setBusy("plan");
    setErr(null);
    setPlan(null);
    setBundle(null);
    try {
      setPlan(await planExitBundle(destination, rate));
    } catch (e) {
      setErr(e instanceof BundleError || e instanceof Error ? e.message : readableError(e));
    } finally {
      setBusy(null);
    }
  }

  async function sign() {
    if (!plan) return;
    setBusy("sign");
    setErr(null);
    try {
      setBundle(await signExitBundle(plan));
    } catch (e) {
      setErr(e instanceof BundleError || e instanceof Error ? e.message : readableError(e));
    } finally {
      setBusy(null);
    }
  }

  function download(b: ExitBundle) {
    const blob = new Blob([b.text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `nanospark-exit-bundle-${new Date(b.createdAt).toISOString().slice(0, 16).replace(/[:T]/g, "-")}.txt`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  if (bundle) return <BundleView bundle={bundle} onBack={() => setBundle(null)} onDownload={() => download(bundle)} />;

  return (
    <div>
      <div className="card">
        <div className="kv">
          <span className="k">Leaves captured</span>
          <span className="v">
            {capture.leafIds.length} · {relativeTime(capture.capturedAt)}
          </span>
        </div>
      </div>

      <label className="field">
        <span>Destination {network === "MAINNET" ? "Bitcoin" : "regtest"} address</span>
        <input
          type="text"
          value={destination}
          placeholder={network === "MAINNET" ? "bc1…" : "bcrt1…"}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onChange={(e) => {
            setDestination(e.target.value);
            setPlan(null);
          }}
        />
      </label>

      <label className="field">
        <span>
          Fee rate (sat/vB)
          {suggested !== null && <span className="muted">mempool suggests {suggested}</span>}
        </span>
        <input
          type="number"
          inputMode="decimal"
          min={1}
          value={feeRate}
          onChange={(e) => {
            setFeeRate(e.target.value);
            setPlan(null);
          }}
        />
      </label>
      <p className="muted" style={{ fontSize: 12.5, marginTop: -8 }}>
        Fixed into every transaction when signed. Pick a rate you expect to confirm within a few
        hours; if fees rise later, rebuild here at a higher one.
      </p>

      {err && <div className="err">{err}</div>}

      {!plan && (
        <button className="btn primary" style={{ width: "100%" }} disabled={!canPlan} onClick={() => void makePlan()}>
          {busy === "plan" ? (
            <>
              <Spinner /> Checking the chain…
            </>
          ) : (
            "Work out the exit"
          )}
        </button>
      )}

      {plan && (
        <>
          <div className="card">
            <div className="kv">
              <span className="k">Leaves exited</span>
              <span className="v">
                {plan.included.length} · {formatSats(plan.included.reduce((s, l) => s + l.valueSats, 0))} sats
              </span>
            </div>
            {plan.excluded.length > 0 && (
              <div className="kv">
                <span className="k">Left behind</span>
                <span className="v">
                  {plan.excluded.length} · {formatSats(plan.excluded.reduce((s, l) => s + l.valueSats, 0))} sats
                </span>
              </div>
            )}
            <div className="kv">
              <span className="k">Tree transactions</span>
              <span className="v">{plan.nodePackages.length}</span>
            </div>
            <div className="kv">
              <span className="k">Arrives at your address</span>
              <span className="v total">{formatSats(plan.receiveSats)} sats</span>
            </div>
          </div>

          {plan.excluded.length > 0 && (
            <details style={{ marginBottom: 14 }}>
              <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
                Why some leaves are left behind
              </summary>
              <div className="muted" style={{ fontSize: 12.5, marginTop: 8 }}>
                {plan.excluded.map((e) => (
                  <div key={e.leafId} style={{ marginBottom: 6 }}>
                    {formatSats(e.valueSats)} sats — {e.reason}
                  </div>
                ))}
              </div>
            </details>
          )}

          {plan.included.length === 0 ? (
            <div className="err">No leaf is worth exiting at this fee rate.</div>
          ) : plan.fundingSats > 0 && feeAddress ? (
            <FeeFunding plan={plan} feeAddress={feeAddress} />
          ) : (
            <p className="muted" style={{ fontSize: 12.5 }}>
              The tree is already on-chain, so no fee payment is needed.
            </p>
          )}

          {plan.included.length > 0 && (
            <button className="btn primary" style={{ width: "100%" }} disabled={!!busy} onClick={() => void sign()}>
              {busy === "sign" ? (
                <>
                  <Spinner /> Signing…
                </>
              ) : plan.fundingSats > 0 ? (
                "I've sent it — build the bundle"
              ) : (
                "Build the bundle"
              )}
            </button>
          )}
          <button className="btn ghost" style={{ width: "100%", marginTop: 10 }} onClick={() => setPlan(null)}>
            Change destination or fee rate
          </button>
        </>
      )}

      <button className="btn danger" style={{ width: "100%", marginTop: 18 }} onClick={() => setConfirmCancel(true)}>
        Cancel the exit
      </button>

      {confirmCancel && (
        <Confirm
          title="Cancel the unilateral exit?"
          danger
          body={
            <div className="notice stark">
              Only cancel if you have not broadcast any step. Once cancelled the wallet resumes
              normal use, which makes any bundle you downloaded stale — delete it, and never
              broadcast it later. If you already broadcast a step, keep going with that bundle
              instead.
            </div>
          }
          confirmLabel="Cancel the exit"
          onCancel={() => setConfirmCancel(false)}
          onConfirm={async () => {
            setConfirmCancel(false);
            await cancelExitBundle();
          }}
        />
      )}
    </div>
  );
}

/** Why a separate payment is needed, where to send it, and how much. */
function FeeFunding({ plan, feeAddress }: { plan: ExitPlan; feeAddress: string }) {
  return (
    <div className="card pad">
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Send the exit's fees</div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Spark's exit transactions carry no fee of their own. Bitcoin only mines them alongside a
        second transaction that pays for both, and that needs ordinary bitcoin from outside Spark.
      </p>
      <p className="muted" style={{ fontSize: 12.5 }}>
        This address belongs to <strong>this wallet</strong>: it is derived from your own recovery
        phrase (path m/8797556'/0/0), and only your phrase can spend from it. Send{" "}
        <strong style={{ color: "var(--text)" }}>at least {formatSats(plan.fundingSats)} sats in one payment</strong>{" "}
        from any Bitcoin wallet or exchange. Whatever the exit does not use is sent on to your
        destination by the bundle.
      </p>
      <QR value={`bitcoin:${feeAddress}?amount=${(plan.fundingSats / 1e8).toFixed(8)}`} size={180} />
      <div className="mono card" style={{ marginBottom: 10 }}>
        {feeAddress}
      </div>
      <div className="row">
        <CopyButton value={feeAddress} label="Copy address" />
        <CopyButton value={String(plan.fundingSats)} label="Copy amount" />
      </div>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 12, marginBottom: 0 }}>
        Wait for one confirmation, then build the bundle. Fees at {plan.feeRate} sat/vB:{" "}
        {formatSats(plan.chainFeeSats)} sats for {plan.nodePackages.length} tree transactions, plus a
        small reserve that comes back to you.
      </p>
    </div>
  );
}

function BundleView({ bundle, onBack, onDownload }: { bundle: ExitBundle; onBack: () => void; onDownload: () => void }) {
  const p = bundle.plan;
  const explorer = EXPLORER_URL[p.network];
  const maxLock = bundle.steps.reduce((m, s) => Math.max(m, s.lock), 0);

  return (
    <div>
      <div className="center" style={{ marginBottom: 14 }}>
        <div className="big-tick ok-text">✓</div>
        <h2>Exit bundle ready</h2>
        <p className="muted">
          {bundle.steps.length} steps · {formatSats(p.receiveSats + (bundle.leftoverReturned ? bundle.leftoverSats : 0))}{" "}
          sats to {truncateMiddle(p.destination, 10, 8)}
        </p>
      </div>

      <button className="btn primary" style={{ width: "100%" }} onClick={onDownload}>
        Download bundle (.txt)
      </button>
      <p className="muted" style={{ fontSize: 12.5, marginTop: 10 }}>
        Save it somewhere you can reach without this browser. It holds every step and the same
        instructions as below.
      </p>

      <div className="notice">
        <strong style={{ color: "var(--text)" }}>How to broadcast.</strong> Open{" "}
        <a href={pushUrl(p.network)} target="_blank" rel="noreferrer">
          {pushUrl(p.network).replace("https://", "")}
        </a>{" "}
        (or /tx/push on your own mempool). For a two-transaction step choose{" "}
        <strong>Submit package</strong> and paste the line as copied; a single transaction goes in
        the normal box. Go in order and wait for each step's condition. A step pasted too early is
        rejected harmlessly — "non-BIP68-final" means its timelock has not passed. The longest wait
        is {formatSats(maxLock)} blocks (~{duration(maxLock * BLOCK_SECONDS[p.network])}).
      </div>

      <div className="card">
        {bundle.steps.map((s) => (
          <div className="step" key={s.n}>
            <div style={{ fontWeight: 600, fontSize: 14 }}>
              {s.n}. {s.title}
            </div>
            <div className="when">
              {s.txs.length === 2 ? "Package" : "Single transaction"} · paste when {s.when.join(", and ")}
              {s.receiveSats !== undefined && <> · pays {formatSats(s.receiveSats)} sats</>}
            </div>
            <div className="row">
              <CopyButton value={pasteLine(s)} label={s.txs.length === 2 ? "Copy package" : "Copy transaction"} />
              <a
                className="btn ghost"
                style={{ textAlign: "center", textDecoration: "none", display: "block" }}
                href={`${explorer}/tx/${s.watchTxid}`}
                target="_blank"
                rel="noreferrer"
              >
                Watch
              </a>
            </div>
          </div>
        ))}
      </div>

      <button className="btn ghost" style={{ width: "100%" }} onClick={onBack}>
        Back — rebuild at a different rate
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* The in-browser engine, for an exit an earlier version started      */
/* ------------------------------------------------------------------ */

function duration(seconds: number): string {
  if (seconds < 3600) return `${Math.max(1, Math.ceil(seconds / 60))} min`;
  if (seconds < 86_400) return `${(seconds / 3600).toFixed(1)} h`;
  return `${(seconds / 86_400).toFixed(1)} days`;
}

function describe(p: LeafProgress, network: ExitNetwork): string {
  const label = "kind" in p ? (p.kind === "refund" ? "the refund transaction" : `transaction ${p.step} of ${p.of}`) : "";
  switch (p.state) {
    case "broadcast":
      return `Broadcast ${label}`;
    case "in-mempool":
      return `Waiting for ${label} to confirm`;
    case "waiting-parent":
      return `Waiting for the transaction before ${label} to confirm`;
    case "timelock":
      return `${label.charAt(0).toUpperCase() + label.slice(1)} is timelocked: ${formatSats(p.blocksLeft)} more blocks (~${duration(p.blocksLeft * BLOCK_SECONDS[network])})`;
    case "needs-funding":
      return `Needs fee money at the fee address for ${label}${p.detail ? ` — ${p.detail}` : ""}`;
    case "waiting-fee":
      return `Ready to broadcast ${label} — waiting a block for ${formatSats(p.pendingSats)} sats of fee change to confirm`;
    case "error":
      return `Problem: ${p.detail}`;
    case "sweep-broadcast":
      return `Sweep sent: ${formatSats(p.amountSats)} sats on the way to the destination`;
    case "swept":
      return p.confirmed ? "Arrived at the destination" : "Sweep waiting for confirmation";
    case "unsweepable":
      return p.reason;
  }
}

function txidOfProgress(p: LeafProgress): string | null {
  return "txid" in p ? p.txid : null;
}

function EngineProgress() {
  const exit = useWallet((s) => s.exit);
  const network = useWallet((s) => s.settings.network);
  const runExit = useWallet((s) => s.runExit);
  const forgetExit = useWallet((s) => s.forgetExit);
  const [confirmForget, setConfirmForget] = useState(false);

  const job = exit.job!;
  const explorer = EXPLORER_URL[network];
  const needsFunding = exit.progress.some((p) => p.state === "needs-funding");

  return (
    <div>
      {job.finishedAt ? (
        <div className="center" style={{ marginBottom: 14 }}>
          <div className="big-tick ok-text">✓</div>
          <h2>Exit complete</h2>
          <p className="muted">Every exitable leaf has been swept to the destination.</p>
        </div>
      ) : (
        <p className="muted">
          A unilateral exit started in this browser is in progress. This checks the chain every
          minute while the wallet is unlocked.
        </p>
      )}

      <div className="card">
        <div className="kv">
          <span className="k">Destination</span>
          <span className="v mono">{truncateMiddle(job.destination, 12, 10)}</span>
        </div>
        <div className="kv">
          <span className="k">Leaves</span>
          <span className="v">{job.leafIds.length}</span>
        </div>
        <div className="kv">
          <span className="k">Fee rate</span>
          <span className="v">{job.feeRate} sat/vB</span>
        </div>
        {exit.tip !== null && (
          <div className="kv">
            <span className="k">Chain tip</span>
            <span className="v">{formatSats(exit.tip)}</span>
          </div>
        )}
        {exit.lastCheckedAt && (
          <div className="kv">
            <span className="k">Last checked</span>
            <span className="v">{relativeTime(exit.lastCheckedAt)}</span>
          </div>
        )}
      </div>

      <div className="card">
        {exit.progress.length === 0 ? (
          <div className="kv">
            <span className="k">{exit.running ? "Checking the chain…" : "Not checked yet."}</span>
          </div>
        ) : (
          exit.progress.map((p) => {
            const txid = txidOfProgress(p);
            return (
              <div key={p.leafId} style={{ padding: "12px 0", borderBottom: "1px solid var(--line-soft)" }}>
                <div className="muted mono" style={{ fontSize: 11.5 }}>
                  leaf {p.leafId.slice(0, 8)}
                </div>
                <div style={{ fontSize: 14, marginTop: 2 }}>{describe(p, network)}</div>
                {txid && (
                  <a
                    className="muted mono"
                    style={{ fontSize: 11.5 }}
                    href={`${explorer}/tx/${txid}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {truncateMiddle(txid, 10, 10)}
                  </a>
                )}
              </div>
            );
          })
        )}
      </div>

      {needsFunding && exit.feeAddress && (
        <div className="card pad">
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
            This wallet's exit fee address (derived from your recovery phrase). Send sats here to pay
            the remaining fees.
          </div>
          <div className="mono" style={{ marginBottom: 10 }}>
            {exit.feeAddress}
          </div>
          <CopyButton value={exit.feeAddress} label="Copy address" />
        </div>
      )}
      {exit.error && <div className="err">{exit.error}</div>}

      {!job.finishedAt && (
        <button className="btn ghost" style={{ width: "100%" }} disabled={exit.running} onClick={() => void runExit()}>
          {exit.running ? (
            <>
              <Spinner /> Checking…
            </>
          ) : (
            "Check now"
          )}
        </button>
      )}

      {job.log.length > 0 && (
        <details style={{ marginTop: 14 }}>
          <summary className="muted" style={{ cursor: "pointer", fontSize: 13 }}>
            Activity log ({job.log.length})
          </summary>
          <div className="mono muted" style={{ fontSize: 11.5, lineHeight: 1.6, marginTop: 8 }}>
            {job.log
              .slice(-20)
              .reverse()
              .map((l, i) => (
                <div key={i}>
                  {new Date(l.at).toLocaleTimeString()} — {l.msg}
                </div>
              ))}
          </div>
        </details>
      )}

      <button className="btn ghost" style={{ width: "100%", marginTop: 14 }} onClick={() => setConfirmForget(true)}>
        {job.finishedAt ? "Clear this exit" : "Stop tracking this exit"}
      </button>

      {confirmForget && (
        <Confirm
          title={job.finishedAt ? "Clear this exit?" : "Stop tracking this exit?"}
          danger={!job.finishedAt}
          body={
            job.finishedAt ? (
              <p>The record of this completed exit is removed from this browser.</p>
            ) : (
              <div className="notice stark">
                Transactions already broadcast stay on Bitcoin — this does not undo them. It only
                stops this app from continuing. Leaves partway through will be stuck until someone
                finishes the exit, here or with another Spark exit tool.
              </div>
            )
          }
          confirmLabel={job.finishedAt ? "Clear" : "Stop tracking"}
          onCancel={() => setConfirmForget(false)}
          onConfirm={async () => {
            setConfirmForget(false);
            await forgetExit();
          }}
        />
      )}
    </div>
  );
}
