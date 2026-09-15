import { useEffect } from "react";
import { useWallet } from "./store/wallet";
import { useIdleLock } from "./lib/useIdleLock";
import { Onboarding } from "./screens/Onboarding";
import { Lock } from "./screens/Lock";
import { Home } from "./screens/Home";
import { Backup } from "./screens/Backup";
import { Spinner } from "./components/ui";

export default function App() {
  const phase = useWallet((s) => s.phase);
  const boot = useWallet((s) => s.boot);
  const backupVerified = useWallet((s) => s.backupVerified);
  const backupDeferred = useWallet((s) => s.backupDeferred);
  const mnemonic = useWallet((s) => s.mnemonic);
  useIdleLock();

  useEffect(() => {
    void boot();
  }, [boot]);

  switch (phase) {
    case "boot":
      return (
        <div className="app center" style={{ paddingTop: 120 }}>
          <Spinner />
        </div>
      );
    case "welcome":
      return <Onboarding />;
    case "locked":
      return <Lock />;
    case "unlocked":
      // A freshly created wallet lands here before Home. Backup is the default
      // destination, not a prompt the user has to go looking for (§3.3) — only
      // verifying, or explicitly choosing to defer, gets past it.
      if (!backupVerified && !backupDeferred && mnemonic) {
        return <Backup mnemonic={mnemonic} />;
      }
      return <Home />;
  }
}
