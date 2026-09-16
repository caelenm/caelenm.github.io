/**
 * Claiming one on-chain deposit into the Spark balance.
 *
 * The screen this replaces gave no sign anything was happening: the claim ran
 * behind a button that only stopped spinning, and a failure surfaced as a line
 * of text elsewhere. A claim moves the user's money and costs a fee, so it gets
 * a real before/during/after: what arrived, what the SSP takes, what lands, and
 * then plainly whether it worked.
 */
import { useState } from "react";
import { Sheet, Spinner } from "../components/ui";
import { formatSats } from "../lib/format";
import { useWallet, type PendingDeposit } from "../store/wallet";
import { DEPOSIT_CONFIRMATIONS } from "../lib/deposits";
import { depositFee, depositStage } from "../lib/activity";

type Stage = { s: "review" } | { s: "claiming" } | { s: "done"; creditedSats: number } | { s: "error"; message: string };

export function ClaimDeposit({ deposit, onClose }: { deposit: PendingDeposit; onClose: () => void }) {
  const claimDeposit = useWallet((s) => s.claimDeposit);
  const [stage, setStage] = useState<Stage>({ s: "review" });

  const fee = depositFee(deposit);
  const ready = depositStage(deposit) === "claimable";

  async function claim() {
    setStage({ s: "claiming" });
    const r = await claimDeposit(deposit.txid, deposit.vout);
    setStage(r.ok ? { s: "done", creditedSats: r.creditedSats } : { s: "error", message: r.error });
  }

  return (
    <Sheet title="Claim deposit" onClose={onClose}>
      {stage.s === "claiming" && (
        <div className="center" style={{ padding: "40px 0" }}>
          <Spinner />
          <p className="muted" style={{ marginTop: 14 }}>
            Claiming into your balance — don't close this tab. The SSP is converting the on-chain
            deposit into a Spark leaf.
          </p>
        </div>
      )}

      {stage.s === "done" && (
        <div className="center">
          <div className="big-tick ok-text">✓</div>
          <h2>Claimed</h2>
          <p className="muted">{formatSats(stage.creditedSats)} sats are now in your balance.</p>
          <button className="btn primary" style={{ width: "100%", marginTop: 16 }} onClick={onClose}>
            Done
          </button>
        </div>
      )}

      {stage.s === "error" && (
        <div>
          <div className="err">{stage.message}</div>
          <p className="muted" style={{ fontSize: 12.5 }}>
            The deposit has not moved — it is still on-chain and still yours to claim. Nothing was
            spent. Check Activity before retrying, in case the claim landed despite the error.
          </p>
          <div className="stack" style={{ marginTop: 16 }}>
            <button className="btn primary" style={{ width: "100%" }} onClick={() => setStage({ s: "review" })}>
              Try again
            </button>
            <button className="btn ghost" style={{ width: "100%" }} onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      )}

      {stage.s === "review" && (
        <div>
          <div className="card pad">
            <div className="kv">
              <span className="k">Received on-chain</span>
              <span className="v">{deposit.valueSats !== null ? `${formatSats(deposit.valueSats)} sats` : "—"}</span>
            </div>
            <div className="kv">
              <span className="k">SSP fee</span>
              <span className="v">{fee !== null ? `− ${formatSats(fee)} sats` : "—"}</span>
            </div>
            <div className="kv">
              <span className="k" style={{ color: "var(--text)" }}>
                Credited to your balance
              </span>
              <span className="v" style={{ color: "var(--text)" }}>
                {deposit.creditSats !== null ? `${formatSats(deposit.creditSats)} sats` : "—"}
              </span>
            </div>
          </div>

          {!ready && (
            <div className="notice" style={{ marginTop: 14 }}>
              {deposit.confirmations < DEPOSIT_CONFIRMATIONS
                ? `This deposit has ${deposit.confirmations} of the ${DEPOSIT_CONFIRMATIONS} confirmations a claim needs. It will become claimable on its own — nothing to do but wait.`
                : deposit.quoteError
                  ? `The SSP will not price this deposit yet: ${deposit.quoteError}`
                  : "Waiting for the SSP to price this deposit."}
            </div>
          )}

          <p className="muted" style={{ marginTop: 14, fontSize: 12.5 }}>
            Claiming converts this on-chain output into a Spark leaf. The fee is the SSP's, not this
            wallet's. Until it is claimed the bitcoin sits at an address built from your key and the
            operators' together, so your recovery phrase alone cannot spend it — claiming is what
            brings it fully under this wallet.
          </p>

          <button
            className="btn primary"
            style={{ width: "100%", marginTop: 16 }}
            disabled={!ready}
            onClick={() => void claim()}
          >
            {ready ? `Claim ${deposit.creditSats !== null ? formatSats(deposit.creditSats) : ""} sats` : "Not claimable yet"}
          </button>
        </div>
      )}
    </Sheet>
  );
}
