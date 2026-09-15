import { useState } from "react";
import { useWallet } from "../store/wallet";
import { Spinner } from "../components/ui";
import { Restore } from "./Restore";

export function Lock() {
  const [pass, setPass] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const unlock = useWallet((s) => s.unlock);
  const progress = useWallet((s) => s.kdfProgress);

  if (restoring) return <Restore onBack={() => setRestoring(false)} />;

  async function go() {
    if (!pass || busy) return;
    setBusy(true);
    setFailed(false);
    const ok = await unlock(pass);
    if (!ok) {
      // Generic failure, a small delay, and no attempt counter that wipes
      // anything (§3.6). Wiping on wrong guesses turns a typo into a disaster.
      await new Promise((r) => setTimeout(r, 600));
      setFailed(true);
      setPass("");
      setBusy(false);
    }
  }

  return (
    <div className="app">
      <div className="header">
        <div className="brand">nanospark</div>
      </div>

      <div style={{ paddingTop: 70 }}>
        <h1>Locked</h1>
        <p className="muted">Enter your passphrase to unlock this device's copy of the wallet.</p>

        <label className="field" style={{ marginTop: 22 }}>
          <span>Passphrase</span>
          <input
            type="password"
            value={pass}
            autoFocus
            autoComplete="current-password"
            onChange={(e) => setPass(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void go();
            }}
          />
        </label>

        {failed && <div className="err">That didn't work. Try again.</div>}

        <button className="btn primary" style={{ width: "100%" }} disabled={!pass || busy} onClick={() => void go()}>
          {busy ? (
            <>
              {/* The percentage only appears once the KDF actually reports;
                  a permanently stuck "0%" reads as a hang. */}
              <Spinner /> Unlocking…{progress > 0 ? ` ${Math.round(progress * 100)}%` : ""}
            </>
          ) : (
            "Unlock"
          )}
        </button>

        <div className="center" style={{ marginTop: 20 }}>
          <button className="link subtle" onClick={() => setRestoring(true)}>
            Forgot passphrase → restore from recovery phrase
          </button>
        </div>
      </div>
    </div>
  );
}
