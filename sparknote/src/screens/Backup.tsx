import { useMemo, useState } from "react";
import { useWallet } from "../store/wallet";

export const PROVENANCE = [
  "BIP39 12-word phrase, Spark wallet.",
  "Derivation: m/8797555'/0'/0' (identity), .../1' (signing), .../2' (deposit),",
  ".../3' (static deposit), .../4' (HTLC preimage). Account number 0.",
  "",
  "This phrase restores in any Spark-compatible wallet — the official Spark CLI,",
  "the Breez SDK, or any other. It is not specific to the app that made it.",
];

/** Picks three distinct positions to quiz on. */
function pickPositions(): number[] {
  const chosen = new Set<number>();
  while (chosen.size < 3) {
    chosen.add(crypto.getRandomValues(new Uint32Array(1))[0] % 12);
  }
  return [...chosen].sort((x, y) => x - y);
}

/**
 * Mandatory backup before first receive (§3.3).
 *
 * Receive stays locked until this passes. The friction is the feature.
 */
export function Backup({ mnemonic, onDone }: { mnemonic: string; onDone?: () => void }) {
  const [stage, setStage] = useState<"show" | "verify">("show");
  const words = useMemo(() => mnemonic.split(" "), [mnemonic]);
  const markVerified = useWallet((s) => s.markBackupVerified);
  const deferBackup = useWallet((s) => s.deferBackup);

  return (
    <div className="app">
      <div className="header">
        <div className="brand">Back up your wallet</div>
      </div>

      {stage === "show" ? (
        <ShowPhrase words={words} onNext={() => setStage("verify")} onDefer={async () => {
          await deferBackup();
          onDone?.();
        }} />
      ) : (
        <VerifyPhrase
          words={words}
          onBack={() => setStage("show")}
          onPass={async () => {
            await markVerified();
            onDone?.();
          }}
        />
      )}
    </div>
  );
}

function ShowPhrase({
  words,
  onNext,
  onDefer,
}: {
  words: string[];
  onNext: () => void;
  onDefer: () => void;
}) {
  const [copied, setCopied] = useState(false);

  const sheet = [
    "NANOSPARK RECOVERY SHEET",
    "========================",
    "",
    ...words.map((w, i) => `${String(i + 1).padStart(2, " ")}. ${w}`),
    "",
    ...PROVENANCE,
    "",
    "Anyone who reads these words can spend your money.",
    "Keep this on paper, offline. Do not photograph it. Do not store it in a",
    "password manager that syncs, or in cloud notes, or in email.",
    "",
    `Written ${new Date().toISOString().slice(0, 10)}.`,
  ].join("\n");

  function download() {
    const blob = new Blob([sheet], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "sparknote-recovery-sheet.txt";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  return (
    <div>
      <p>
        Write these 12 words down, in order, on paper. This is the only backup that exists.
      </p>

      <div className="seed-grid">
        {words.map((w, i) => (
          <div className="seed-word" key={i}>
            <span className="n">{i + 1}</span>
            <span>{w}</span>
          </div>
        ))}
      </div>

      <div className="notice stark">
        Anyone who sees these words can take everything in the wallet. No screenshots, no photos,
        no cloud notes.
      </div>

      <div className="row" style={{ marginBottom: 8 }}>
        <button className="btn ghost" onClick={download}>
          Download .txt
        </button>
        <button
          className="btn ghost"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(words.join(" "));
              setCopied(true);
              setTimeout(() => setCopied(false), 1600);
            } catch {
              window.prompt("Copy this:", words.join(" "));
            }
          }}
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <p className="muted" style={{ fontSize: 12.5 }}>
        Copying puts the phrase on your clipboard, where clipboard managers and phone-to-desktop
        sync may keep a copy. Paper is safer. The .txt file is generated here in your browser and
        is never uploaded.
      </p>

      <button className="btn primary" style={{ width: "100%", marginTop: 18 }} onClick={onNext}>
        I've written it down
      </button>

      <div className="center" style={{ marginTop: 14 }}>
        <button className="link subtle" onClick={onDefer}>
          I'll back up later (unsafe)
        </button>
      </div>
    </div>
  );
}

function VerifyPhrase({
  words,
  onBack,
  onPass,
}: {
  words: string[];
  onBack: () => void;
  onPass: () => void;
}) {
  const [positions, setPositions] = useState<number[]>(() => pickPositions());
  const [answers, setAnswers] = useState<string[]>(["", "", ""]);
  const [failed, setFailed] = useState(false);

  const filled = answers.every((a) => a.trim().length > 0);

  function check() {
    const ok = positions.every(
      (p, i) => answers[i].trim().toLowerCase() === words[p].toLowerCase(),
    );
    if (ok) {
      onPass();
    } else {
      // Never fail the user out — show the phrase again and re-quiz (§3.3.3).
      setFailed(true);
      setAnswers(["", "", ""]);
      setPositions(pickPositions());
    }
  }

  return (
    <div>
      <h1>Check the phrase</h1>
      <p className="muted">
        Type the words at these positions from the copy you just wrote down.
      </p>

      {failed && (
        <div className="banner warn">
          <div className="banner-body">
            That didn't match. Nothing is lost — go back, read the phrase again, and try a fresh
            set of words.
          </div>
        </div>
      )}

      <div className="stack" style={{ marginTop: 16 }}>
        {positions.map((p, i) => (
          <label className="field" key={p}>
            <span>Word #{p + 1}</span>
            <input
              type="text"
              value={answers[i]}
              autoCapitalize="none"
              autoCorrect="off"
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                const next = [...answers];
                next[i] = e.target.value;
                setAnswers(next);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && filled) check();
              }}
            />
          </label>
        ))}
      </div>

      <button className="btn primary" style={{ width: "100%" }} disabled={!filled} onClick={check}>
        Confirm
      </button>
      <div className="center" style={{ marginTop: 12 }}>
        <button className="link subtle" onClick={onBack}>
          Show me the phrase again
        </button>
      </div>
    </div>
  );
}
