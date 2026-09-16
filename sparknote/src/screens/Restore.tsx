import { useRef, useState } from "react";
import { completeWord, inspectPhrase, isWordlistWord, normalizePhrase } from "../lib/mnemonic";
import { useWallet } from "../store/wallet";
import { PassphraseStep } from "./Onboarding";

/**
 * Restore (§3.4).
 *
 * Reachable from onboarding and from the lock screen, because "I forgot my
 * passphrase" and "I cleared my browser" must both land somewhere useful.
 *
 * No BIP39 passphrase field: this build omits the 25th word entirely, so a
 * phrase created here never has one. A phrase from elsewhere that does will
 * restore to a different, empty wallet — the notice below says so rather than
 * letting the user conclude their money vanished.
 */
export function Restore({ onBack }: { onBack: () => void }) {
  const [words, setWords] = useState<string[]>(() => Array(12).fill(""));
  const [focused, setFocused] = useState<number | null>(null);
  const [stage, setStage] = useState<"phrase" | "passphrase">("phrase");
  const inputs = useRef<(HTMLInputElement | null)[]>([]);
  const restoreWallet = useWallet((s) => s.restoreWallet);

  const phrase = words.join(" ").trim();
  const problem = inspectPhrase(phrase);
  const complete = words.every((w) => w.trim().length > 0);
  const valid = complete && problem.kind === "ok";

  function setWord(i: number, value: string) {
    const next = [...words];
    next[i] = value.trim().toLowerCase();
    setWords(next);
  }

  /** Pasting the whole phrase into any box fills the grid (§3.4). */
  function handlePaste(i: number, text: string) {
    const parts = normalizePhrase(text).split(" ").filter(Boolean);
    if (parts.length < 2) return false;
    const next = [...words];
    for (let k = 0; k < parts.length && i + k < 12; k++) next[i + k] = parts[k];
    setWords(next);
    inputs.current[Math.min(i + parts.length, 11)]?.focus();
    return true;
  }

  if (stage === "passphrase") {
    return (
      <div className="app">
        <div className="header">
          <div className="brand">Restore</div>
        </div>
        <PassphraseStep
          title="Set an unlock passphrase"
          blurb="This encrypts the restored phrase on this device. It is not your recovery phrase and it is not a backup."
          onSubmit={async (pass) => {
            await restoreWallet(pass, normalizePhrase(phrase));
          }}
        />
      </div>
    );
  }

  return (
    <div className="app">
      <div className="header">
        <div className="brand">Restore a wallet</div>
      </div>

      <p className="muted">
        Enter your 12-word recovery phrase. You can paste the whole thing into the first box.
      </p>

      <div className="restore-grid">
        {words.map((w, i) => {
          const bad = w.length > 1 && !isWordlistWord(w);
          const suggestions = focused === i && w.length >= 2 && !isWordlistWord(w) ? completeWord(w) : [];
          return (
            <div className={`restore-word${bad ? " bad" : ""}`} key={i}>
              <span className="n">{i + 1}</span>
              <input
                ref={(el) => {
                  inputs.current[i] = el;
                }}
                type="text"
                value={w}
                autoCapitalize="none"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                onFocus={() => setFocused(i)}
                onBlur={() => setTimeout(() => setFocused((f) => (f === i ? null : f)), 120)}
                onChange={(e) => setWord(i, e.target.value)}
                onPaste={(e) => {
                  if (handlePaste(i, e.clipboardData.getData("text"))) e.preventDefault();
                }}
                onKeyDown={(e) => {
                  if (e.key === " " || e.key === "Enter") {
                    e.preventDefault();
                    if (suggestions.length) setWord(i, suggestions[0]);
                    inputs.current[Math.min(i + 1, 11)]?.focus();
                  }
                  if (e.key === "Backspace" && w === "" && i > 0) inputs.current[i - 1]?.focus();
                }}
              />
              {suggestions.length > 0 && (
                <div className="suggest">
                  {suggestions.map((s) => (
                    <button
                      key={s}
                      onMouseDown={(e) => {
                        e.preventDefault();
                        setWord(i, s);
                        inputs.current[Math.min(i + 1, 11)]?.focus();
                      }}
                    >
                      {s}
                    </button>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {complete && problem.kind === "checksum" && (
        <div className="err">
          These are all real BIP39 words, but the phrase's checksum is wrong — at least one word is
          in the wrong place or is the wrong word. Check it against your backup.
        </div>
      )}
      {problem.kind === "unknown-words" && (
        <div className="err">Not in the BIP39 word list: {problem.words.join(", ")}</div>
      )}

      <div className="notice">
        This wallet does not use a BIP39 passphrase (a "25th word"). If your phrase has one, it will
        restore here as a different, empty wallet — your funds are not lost, but you will need a
        wallet that supports the extra word.
      </div>

      <button
        className="btn primary"
        style={{ width: "100%" }}
        disabled={!valid}
        onClick={() => setStage("passphrase")}
      >
        Continue
      </button>
      <div className="center" style={{ marginTop: 12 }}>
        <button className="link subtle" onClick={onBack}>
          Back
        </button>
      </div>
    </div>
  );
}
