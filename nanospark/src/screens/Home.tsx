import { useState } from "react";
import { selectExitLocked, useWallet } from "../store/wallet";
import { formatSats, relativeTime, truncateMiddle } from "../lib/format";
import { DEPOSIT_CONFIRMATIONS } from "../lib/deposits";
import { formatUsd } from "../lib/stable";
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

  const activity = useWallet((s) => s.activity);
  const error = useWallet((s) => s.error);
  const backupVerified = useWallet((s) => s.backupVerified);
  const storage = useWallet((s) => s.storage);
  const network = useWallet((s) => s.settings.network);
  const mnemonic = useWallet((s) => s.mnemonic);
  const exitRunning = useWallet(selectExitLocked);
  const exitArmed = useWallet((s) => !!s.exit.capture);
  const claimable = useWallet(
    (s) => s.deposits.filter((d) => d.confirmations >= DEPOSIT_CONFIRMATIONS && d.creditSats !== null).length,
  );

  if (showBackup && mnemonic) {
    return <Backup mnemonic={mnemonic} onDone={() => setShowBackup(false)} />;
  }

  const storageBad =
    storage && (!storage.persistent || storage.ephemeral || !storage.indexedDbUsable);

  return (
    <div className="app">
      <div className="header">
        <div className="brand">
          nanospark
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

      {claimable > 0 && backupVerified && (
        <Banner>
          {claimable === 1 ? "An on-chain deposit is" : `${claimable} on-chain deposits are`} ready to
          claim into your balance.{" "}
          <button className="link" onClick={() => setSheet("receive")}>
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
        {activity.length === 0 ? (
          <p className="muted" style={{ paddingTop: 10 }}>
            Nothing yet. Payments you send and receive will show up here.
          </p>
        ) : (
          activity.map((t) => (
            <button className="tx" key={t.id} onClick={() => setDetail(t)}>
              <div className="tx-icon">{t.direction === "in" ? "↓" : "↑"}</div>
              <div className="tx-main">
                <div className="tx-title">
                  {t.memo || (t.direction === "in" ? "Received" : "Sent")}
                </div>
                <div className="tx-sub">
                  {!t.settled && <span className="pending-dot" />}
                  {!t.settled ? "pending · " : ""}
                  {kindLabel(t.kind)} · {relativeTime(t.time)}
                </div>
              </div>
              <div className={`tx-amount ${t.direction === "in" ? "in" : ""}`}>
                {t.direction === "in" ? "+" : "−"}
                {formatSats(t.amountSats)}
              </div>
            </button>
          ))
        )}
      </div>

      {detail && <TransactionDetail tx={detail} onClose={() => setDetail(null)} />}

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

function kindLabel(k: string): string {
  switch (k) {
    case "lightning":
      return "Lightning";
    case "spark":
      return "Spark";
    case "onchain":
      return "On-chain";
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
