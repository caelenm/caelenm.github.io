import { useMemo, useState } from "react";
import { depositClaimable, selectExitLocked, useWallet, type PendingDeposit } from "../store/wallet";
import { formatSats, relativeTime, truncateMiddle } from "../lib/format";
import { describeDeposit, mergeActivity } from "../lib/activity";
import { ClaimDeposit } from "./ClaimDeposit";
import { formatUsd, satsToUsdUnits } from "../lib/stable";
import { Banner, CopyButton, Sheet } from "../components/ui";
import { Receive } from "./Receive";
import { Send } from "./Send";
import { Settings } from "./Settings";
import { Backup } from "./Backup";
import { Exit } from "./Exit";
import type { CachedActivity } from "../lib/db";

export function Home() {
  const [sheet, setSheet] = useState<"receive" | "send" | "settings" | "exit" | null>(null);
  const [showBackup, setShowBackup] = useState(false);
  const [backupBannerHidden, setBackupBannerHidden] = useState(false);
  const [storageBannerHidden, setStorageBannerHidden] = useState(false);
  const [detail, setDetail] = useState<CachedActivity | null>(null);
  const [claim, setClaim] = useState<PendingDeposit | null>(null);

  const activity = useWallet((s) => s.activity);
  const error = useWallet((s) => s.error);
  const backupVerified = useWallet((s) => s.backupVerified);
  const storage = useWallet((s) => s.storage);
  const network = useWallet((s) => s.settings.network);
  const mnemonic = useWallet((s) => s.mnemonic);
  const exitRunning = useWallet(selectExitLocked);
  const exitArmed = useWallet((s) => !!s.exit.capture);
  const deposits = useWallet((s) => s.deposits);
  const stableMode = useWallet((s) => s.settings.stableMode);
  const usdbBalance = useWallet((s) => s.usdbUnits);
  const unitsPerSat = useWallet((s) => s.unitsPerSat);
  const claimableDeposits = useMemo(() => deposits.filter(depositClaimable), [deposits]);
  const claimable = claimableDeposits.length;

  // Unclaimed deposits are not in the SDK's transfer list, so they are merged in
  // here rather than cached — a claimed one must not survive as a stale row.
  const rows = useMemo(() => mergeActivity(activity, deposits), [activity, deposits]);

  /**
   * In whole-balance mode the wallet is denominated in dollars, so figures read
   * in dollars. Historic amounts are valued at today's rate, so they carry "≈";
   * the sats are what actually moved and are still shown in the detail view.
   */
  const inUsd = stableMode === "whole" && unitsPerSat !== null;
  const amountText = (sats: number, sign = "") =>
    // The sign belongs inside the approximation, not before it: "≈−$0.01",
    // never "−≈$0.01".
    inUsd ? `≈${sign}${formatUsd(satsToUsdUnits(sats, unitsPerSat!))}` : `${sign}${formatSats(sats)}`;

  if (showBackup && mnemonic) {
    return <Backup mnemonic={mnemonic} onDone={() => setShowBackup(false)} />;
  }

  const storageBad =
    storage && (!storage.persistent || storage.ephemeral || !storage.indexedDbUsable);

  return (
    <div className="app">
      <div className="header">
        <div className="brand">
          sparknote
          {network === "REGTEST" && <span className="net-badge">regtest</span>}
        </div>
        <button className="icon-btn" onClick={() => setSheet("settings")} aria-label="Settings">
          ⚙
        </button>
      </div>

      {/* Recurring until backup is verified (§3.3.5). Dismissible per session,
          never permanently. */}
      {!backupVerified && !backupBannerHidden && (
        <Banner kind="danger" onDismiss={() => setBackupBannerHidden(true)}>
          Your recovery phrase is not backed up. Receiving is disabled until it is.{" "}
          <button className="link" onClick={() => setShowBackup(true)}>
            Back it up now
          </button>
        </Banner>
      )}

      {exitRunning && (
        <Banner kind="danger">
          {exitArmed
            ? "A unilateral exit is armed. Sending is paused so the captured leaves stay valid."
            : "A unilateral exit is in progress. Sending is paused so the leaves being exited are not spent."}{" "}
          <button className="link" onClick={() => setSheet("exit")}>
            {exitArmed ? "Open exit" : "View progress"}
          </button>
        </Banner>
      )}

      {/* Money the wallet holds must never be invisible. With the stable
          balance off there is no USD figure and no currency switch, so a
          balance the pool would not swap on the way out would otherwise vanish
          from the screen entirely. */}
      {stableMode === "off" && usdbBalance > 0n && (
        <Banner>
          {formatUsd(usdbBalance)} is still held as USD — it was too small for the pool to convert
          back.{" "}
          <button className="link" onClick={() => setSheet("settings")}>
            Recover it
          </button>
        </Banner>
      )}

      {claimable > 0 && backupVerified && (
        <Banner>
          {claimable === 1 ? "An on-chain deposit is" : `${claimable} on-chain deposits are`} ready to
          claim into your balance.{" "}
          {/* Straight to the claim, not to the Receive sheet — that opened on the
              invoice tab, two clicks from the deposit and with no sign of it. */}
          <button className="link" onClick={() => setClaim(claimableDeposits[0]!)}>
            Review and claim
          </button>
        </Banner>
      )}

      {storageBad && !storageBannerHidden && (
        <Banner onDismiss={() => setStorageBannerHidden(true)}>
          {!storage!.indexedDbUsable
            ? "This browser will not let the wallet store anything. Nothing will survive a reload."
            : storage!.ephemeral
              ? "This looks like a private window. The wallet will be gone when you close it — write down your recovery phrase."
              : "The browser would not mark this site's storage as persistent, so it may be evicted. Your recovery phrase is the backup."}
        </Banner>
      )}

      <BalanceDisplay />

      {error && <div className="err center">{error}</div>}

      <div className="row" style={{ marginTop: 8 }}>
        <button className="btn ghost" onClick={() => setSheet("receive")}>
          Receive
        </button>
        {/* Not disabled at zero balance: the confirm step refuses with an exact
            figure, and hiding the screen would stop someone inspecting an
            invoice before funding. It is disabled during an exit, because
            spending the leaves being exited would sabotage it. */}
        <button className="btn primary" disabled={exitRunning} onClick={() => setSheet("send")}>
          Send
        </button>
      </div>

      <div className="activity">
        <h2>Activity</h2>
        {rows.length === 0 ? (
          <p className="muted" style={{ paddingTop: 10 }}>
            Nothing yet. Payments you send and receive will show up here.
          </p>
        ) : (
          rows.map((row) =>
            row.type === "deposit" ? (
              <button className="tx" key={row.id} onClick={() => setClaim(row.deposit)}>
                <div className="tx-icon">↓</div>
                <div className="tx-main">
                  <div className="tx-title">
                    {row.stage === "claimable" ? "Deposit ready to claim" : "On-chain deposit"}
                  </div>
                  <div className="tx-sub">
                    {row.stage !== "claimable" && <span className="pending-dot" />}
                    {row.stage !== "claimable" ? "pending · " : ""}
                    {describeDeposit(row.deposit)}
                  </div>
                </div>
                <div className="tx-amount in">
                  +{row.deposit.valueSats !== null ? formatSats(row.deposit.valueSats) : "…"}
                </div>
              </button>
            ) : (
              <button className="tx" key={row.id} onClick={() => setDetail(row.tx)}>
                <div className="tx-icon">{txIcon(row.tx)}</div>
                <div className="tx-main">
                  <div className="tx-title">{txTitle(row.tx)}</div>
                  <div className="tx-sub">
                    {!row.tx.settled && <span className="pending-dot" />}
                    {!row.tx.settled ? "pending · " : ""}
                    {kindLabel(row.tx.kind)} · {relativeTime(row.tx.time)}
                  </div>
                </div>
                {/* A swap did not add or remove money, so it gets no + or −
                    and no green: the balance is the same, in a different
                    denomination. */}
                <div
                  className={`tx-amount ${row.tx.kind === "swap" || row.tx.kind === "internal" ? "" : row.tx.direction === "in" ? "in" : ""}`}
                >
                  {row.tx.kind === "swap" || row.tx.kind === "internal"
                    ? amountText(row.tx.amountSats)
                    : amountText(row.tx.amountSats, row.tx.direction === "in" ? "+" : "−")}
                </div>
              </button>
            ),
          )
        )}
      </div>

      {detail && <TransactionDetail tx={detail} onClose={() => setDetail(null)} />}

      {claim && (
        <ClaimDeposit
          // Re-read from the store so confirmations and the quote stay live
          // while the sheet is open; the row that opened it is a snapshot.
          deposit={deposits.find((d) => d.txid === claim.txid && d.vout === claim.vout) ?? claim}
          onClose={() => setClaim(null)}
        />
      )}

      {sheet === "receive" && (
        <Receive
          onClose={() => setSheet(null)}
          onBackup={() => {
            setSheet(null);
            setShowBackup(true);
          }}
        />
      )}
      {sheet === "send" && <Send onClose={() => setSheet(null)} />}
      {sheet === "exit" && <Exit onClose={() => setSheet(null)} />}
      {sheet === "settings" && (
        <Settings
          onClose={() => setSheet(null)}
          onShowBackup={() => {
            setSheet(null);
            setShowBackup(true);
          }}
        />
      )}
    </div>
  );
}

/**
 * The big number.
 *
 * Whole-balance mode shows dollars. Separate mode adds a BTC · Spark / USD
 * switch above it, and the number slides in from the side the switch moved
 * toward. Until the first sync lands, a placeholder stands in for the number
 * rather than showing a total that climbs as leaves are counted.
 */
function BalanceDisplay() {
  const balanceLoaded = useWallet((s) => s.balanceLoaded);
  const balance = useWallet((s) => s.balance);
  const usdbUnits = useWallet((s) => s.usdbUnits);
  const mode = useWallet((s) => s.settings.stableMode);
  const stableBusy = useWallet((s) => s.stableBusy);
  const stableNote = useWallet((s) => s.stableNote);
  const syncing = useWallet((s) => s.syncing);
  const streamConnected = useWallet((s) => s.streamConnected);

  const [side, setSide] = useState<"btc" | "usd">("btc");
  const [anim, setAnim] = useState<"" | "slide-from-right" | "slide-from-left">("");
  const [animKey, setAnimKey] = useState(0);

  function choose(next: "btc" | "usd") {
    if (next === side) return;
    setAnim(next === "usd" ? "slide-from-right" : "slide-from-left");
    setSide(next);
    setAnimKey((k) => k + 1);
  }

  const showUsd = mode === "whole" || (mode === "separate" && side === "usd");

  return (
    <div className="balance">
      {mode === "separate" && (
        <div style={{ marginBottom: 22 }}>
          <div
            className="currency-switch"
            data-side={side === "usd" ? "right" : "left"}
            role="group"
            aria-label="Show balance in"
          >
            <span className="thumb" aria-hidden="true" />
            <button aria-pressed={side === "btc"} onClick={() => choose("btc")}>
              BTC · Spark
            </button>
            <button aria-pressed={side === "usd"} onClick={() => choose("usd")}>
              USD
            </button>
          </div>
        </div>
      )}

      <div className="balance-viewport">
        {!balanceLoaded ? (
          <span className="skeleton" role="status" aria-label="Loading balance" />
        ) : (
          <div key={animKey} className={`balance-amount ${anim}`}>
            {showUsd ? (
              formatUsd(usdbUnits)
            ) : (
              <>
                {formatSats(balance.available)}
                <span className="balance-unit">sats</span>
              </>
            )}
          </div>
        )}
      </div>

      <div className="balance-sub">
        {!balanceLoaded ? (
          "scanning leaves"
        ) : (
          <>
            {mode === "whole" && balance.available > 0 && (
              <>+{formatSats(balance.available)} sats not yet converted · </>
            )}
            {showUsd && mode === "separate" && <>USDB · </>}
            {balance.incoming > 0 && !showUsd && <>+{formatSats(balance.incoming)} incoming · </>}
            <span className={`live-dot${streamConnected ? "" : " off"}`} />
            {stableBusy ? "converting" : syncing ? "syncing" : streamConnected ? "live" : "reconnecting"}
          </>
        )}
      </div>
      {stableNote && balanceLoaded && (
        <div className="muted" style={{ fontSize: 12.5, marginTop: 6 }}>
          {stableNote}
        </div>
      )}
    </div>
  );
}

/** A swap moved value sideways, so it gets its own mark rather than an arrow. */
function txIcon(tx: CachedActivity): string {
  if (tx.kind === "swap") return "⇄";
  if (tx.kind === "internal") return "↻";
  return tx.direction === "in" ? "↓" : "↑";
}

function txTitle(tx: CachedActivity): string {
  if (tx.memo) return tx.memo;
  if (tx.kind === "swap") {
    // Named by what the user did, not by the transfer underneath it.
    return tx.swapDirection === "toBitcoin" ? "Swap · USD → BTC" : "Swap · BTC → USD";
  }
  // A transfer to the wallet's own identity is the SDK tidying leaves; calling
  // it "Sent" implies money left, which it did not.
  if (tx.kind === "internal") return "Rearranged leaves";
  return tx.direction === "in" ? "Received" : "Sent";
}

function kindLabel(k: string): string {
  switch (k) {
    case "lightning":
      return "Lightning";
    case "spark":
      return "Spark";
    case "onchain":
      return "On-chain";
    case "swap":
      return "Swap";
    case "internal":
      return "Internal";
    default:
      return "Transfer";
  }
}

/** Tidies the SDK's SCREAMING_SNAKE statuses into something readable. */
function humanStatus(s: string): string {
  const t = s.replace(/^TRANSFER_STATUS_/, "").replace(/_/g, " ").toLowerCase();
  return t.charAt(0).toUpperCase() + t.slice(1);
}

function TransactionDetail({ tx, onClose }: { tx: CachedActivity; onClose: () => void }) {
  return (
    <Sheet title={tx.direction === "in" ? "Received" : "Sent"} onClose={onClose}>
      <div className="center" style={{ marginBottom: 22 }}>
        <div className="balance-amount" style={{ fontSize: 38 }}>
          {tx.direction === "in" ? "+" : "−"}
          {formatSats(tx.amountSats)}
          <span className="balance-unit">sats</span>
        </div>
        <div className="muted" style={{ marginTop: 8 }}>
          {tx.settled ? humanStatus(tx.status) : "Pending"}
        </div>
      </div>

      <div className="card">
        {tx.memo && (
          <div className="kv">
            <span className="k">Memo</span>
            <span className="v">{tx.memo}</span>
          </div>
        )}
        <div className="kv">
          <span className="k">Type</span>
          <span className="v">{kindLabel(tx.kind)}</span>
        </div>
        <div className="kv">
          <span className="k">Status</span>
          <span className="v">{humanStatus(tx.status) || "—"}</span>
        </div>
        <div className="kv">
          <span className="k">Created</span>
          <span className="v">{new Date(tx.time).toLocaleString()}</span>
        </div>
        {tx.updatedTime !== undefined && tx.updatedTime !== tx.time && (
          <div className="kv">
            <span className="k">Updated</span>
            <span className="v">{new Date(tx.updatedTime).toLocaleString()}</span>
          </div>
        )}
        {/* Explicit boolean: `{0 && …}` renders a literal 0 in JSX. */}
        {tx.expiryTime !== undefined && tx.expiryTime > 0 && (
          <div className="kv">
            <span className="k">Expires</span>
            <span className="v">{new Date(tx.expiryTime).toLocaleString()}</span>
          </div>
        )}
        {typeof tx.leafCount === "number" && (
          <div className="kv">
            <span className="k">Leaves</span>
            <span className="v">{tx.leafCount}</span>
          </div>
        )}
      </div>

      {tx.counterparty && (
        <>
          <div className="muted" style={{ fontSize: 12.5, marginBottom: 6 }}>
            {tx.direction === "in" ? "From" : "To"}
          </div>
          <div className="card pad mono" style={{ marginBottom: 10 }}>
            {truncateMiddle(tx.counterparty, 24, 20)}
          </div>
          <CopyButton value={tx.counterparty} label="Copy identity key" />
        </>
      )}

      <div className="muted" style={{ fontSize: 12.5, marginTop: 18, marginBottom: 6 }}>
        Transfer ID
      </div>
      <div className="card pad mono">{tx.id}</div>
      <CopyButton value={tx.id} label="Copy transfer ID" />
    </Sheet>
  );
}
