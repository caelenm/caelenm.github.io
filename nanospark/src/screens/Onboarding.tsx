import { useMemo, useState } from "react";
import { EntropyPool } from "../lib/mnemonic";
import { EntropyGrid } from "../components/EntropyGrid";
import { useWallet } from "../store/wallet";
import { Spinner } from "../components/ui";
import { Restore } from "./Restore";
import { MIN_PASSPHRASE_LENGTH, WEAK_PASSPHRASE_LENGTH } from "../lib/crypto";

type Step = "choose" | "warn" | "entropy" | "passphrase" | "restore";

export function Onboarding() {
  const [step, setStep] = useState<Step>("choose");
  const pool = useMemo(() => new EntropyPool(), []);
  const [poolTick, setPoolTick] = useState(0);
  const [mnemonic, setMnemonic] = useState<string | null>(null);

  const createWallet = useWallet((s) => s.createWallet);

  if (step === "restore") return <Restore onBack={() => setStep("choose")} />;

  return (
    <div className="app">
      <div className="header">
        <div className="brand">nanospark</div>
      </div>

      {step === "choose" && (
        <div style={{ paddingTop: 40 }}>
          <h1>A Lightning wallet that lives in this tab.</h1>
          <p className="muted">
            Self-custodial, on Spark. Your keys are generated here and never leave this device.
            There is no account and no server holding anything on your behalf.
          </p>
          <div className="stack" style={{ marginTop: 30 }}>
            <button className="btn primary" style={{ width: "100%" }} onClick={() => setStep("warn")}>
              Create a new wallet
            </button>
            <button className="btn ghost" style={{ width: "100%" }} onClick={() => setStep("restore")}>
              Restore from a recovery phrase
            </button>
          </div>
        </div>
      )}

      {step === "warn" && (
        <div style={{ paddingTop: 30 }}>
          <h1>Read this first.</h1>
          <p>
            This wallet is going to generate a <strong>12-word recovery phrase</strong>. That phrase
            is the only thing that can ever recover your money.
          </p>
          <div className="notice stark">
            If you clear your browser data, lose this device, or forget your passphrase, the
            recovery phrase is the only way back. <strong>Nobody can reset it for you.</strong> Not
            us, not Spark, not anyone. If it is gone, the money is gone.
          </div>
          <p className="muted">
            Everything else stored here — your history, your settings, your unlock passphrase — is
            just convenience. Losing it costs you nothing but history.
          </p>
          <div className="stack" style={{ marginTop: 26 }}>
            <button className="btn primary" style={{ width: "100%" }} onClick={() => setStep("entropy")}>
              I understand — continue
            </button>
            <button className="btn ghost" style={{ width: "100%" }} onClick={() => setStep("choose")}>
              Back
            </button>
          </div>
        </div>
      )}

      {step === "entropy" && (
        <div style={{ paddingTop: 24 }}>
          <h1>Add some randomness</h1>
          <p className="muted">
            Optional. Your browser's secure random generator is already used, and it is enough on
            its own. Dragging here mixes in some of your own timing as well — it can only add to the
            randomness, never weaken it.
          </p>
          <EntropyGrid pool={pool} onProgress={() => setPoolTick((t) => t + 1)} />
          <div className="meter">
            <div style={{ width: `${Math.round(pool.progress * 100)}%` }} />
          </div>
          <div className="muted" style={{ fontSize: 12 }}>
            {poolTick === 0
              ? "Drag across the panel, or just skip."
              : `${pool.distinctCells} cells · ${Math.round(pool.progress * 100)}% of the optional pool`}
          </div>
          <div className="stack" style={{ marginTop: 22 }}>
            <button
              className="btn primary"
              style={{ width: "100%" }}
              onClick={() => {
                setMnemonic(pool.toMnemonic());
                pool.clear();
                setStep("passphrase");
              }}
            >
              Generate my phrase
            </button>
          </div>
        </div>
      )}

      {step === "passphrase" && mnemonic && (
        <PassphraseStep
          onSubmit={async (pass) => {
            // On success the store flips to "unlocked" and App routes straight
            // to the backup gate, so there is nothing to do here afterwards.
            await createWallet(pass, mnemonic);
          }}
        />
      )}
    </div>
  );
}

export function PassphraseStep({
  onSubmit,
  title = "Set an unlock passphrase",
  blurb = "This encrypts the recovery phrase on this device. It is not a backup — it protects the copy stored here, nothing more.",
}: {
  onSubmit: (passphrase: string) => Promise<void>;
  title?: string;
  blurb?: string;
}) {
  const [a, setA] = useState("");
  const [b, setB] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const progress = useWallet((s) => s.kdfProgress);

  const tooShort = a.length > 0 && a.length < MIN_PASSPHRASE_LENGTH;
  const weak = a.length >= MIN_PASSPHRASE_LENGTH && a.length < WEAK_PASSPHRASE_LENGTH;
  const mismatch = b.length > 0 && a !== b;
  const ready = a.length >= MIN_PASSPHRASE_LENGTH && a === b && !busy;

  return (
    <div style={{ paddingTop: 24 }}>
      <h1>{title}</h1>
      <p className="muted">{blurb}</p>

      <label className="field" style={{ marginTop: 20 }}>
        <span>Passphrase ({MIN_PASSPHRASE_LENGTH} characters minimum)</span>
        <input type="password" value={a} autoComplete="new-password" onChange={(e) => setA(e.target.value)} />
      </label>
      <label className="field">
        <span>Confirm</span>
        <input
          type="password"
          value={b}
          autoComplete="new-password"
          onChange={(e) => setB(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && ready) void go();
          }}
        />
      </label>

      {tooShort && (
        <div className="err">A little longer, please — at least {MIN_PASSPHRASE_LENGTH} characters.</div>
      )}
      {weak && (
        <div className="muted" style={{ fontSize: 13, marginTop: 6 }}>
          That is short enough to be guessed by someone who copies this device's storage and tries
          every combination offline. It is allowed — a longer passphrase is safer.
        </div>
      )}
      {mismatch && <div className="err">Those do not match.</div>}
      {err && <div className="err">{err}</div>}

      <div className="notice">
        Forgetting this passphrase does not lose your money — you can always restore from the
        12-word phrase. It only locks you out of the copy saved in this browser.
      </div>

      <button className="btn primary" style={{ width: "100%", marginTop: 10 }} disabled={!ready} onClick={() => void go()}>
        {busy ? (
          <>
            <Spinner /> Encrypting…{progress > 0 ? ` ${Math.round(progress * 100)}%` : ""}
          </>
        ) : (
          "Continue"
        )}
      </button>
    </div>
  );

  async function go() {
    setBusy(true);
    setErr(null);
    try {
      await onSubmit(a);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }
}
