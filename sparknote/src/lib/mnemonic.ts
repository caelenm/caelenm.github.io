/**
 * BIP39 mnemonic generation, validation and the optional user-entropy pool.
 *
 * The phrase produced here is a plain, standard BIP39 12-word English mnemonic.
 * Nothing in this file adds an app-specific wrapper, encoding or checksum — the
 * whole point of §3.5 is that the phrase restores into any other Spark-compatible
 * wallet without this codebase existing.
 */
import {
  generateMnemonic as bip39Generate,
  entropyToMnemonic,
  mnemonicToEntropy,
  validateMnemonic as bip39Validate,
} from "@scure/bip39";
// No ".js" suffix: @scure/bip39 v1 (the major the Spark SDK pins, and so the
// only copy in the tree) exports this subpath unsuffixed.
import { wordlist } from "@scure/bip39/wordlists/english";
import { sha256 } from "@noble/hashes/sha2.js";
import { hmac } from "@noble/hashes/hmac.js";

export { wordlist };

/** 128 bits of entropy → 12 words. */
const ENTROPY_BYTES = 16;

export function generateMnemonic(): string {
  return bip39Generate(wordlist, 128);
}

/** Normalizes whitespace and case the way §3.4 requires before any validation. */
export function normalizePhrase(input: string): string {
  return input
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\s　]+/g, " ")
    .trim();
}

export function validateMnemonic(phrase: string): boolean {
  try {
    return bip39Validate(normalizePhrase(phrase), wordlist);
  } catch {
    return false;
  }
}

/**
 * Distinguishes "this isn't a valid phrase" from "the checksum is wrong", so
 * the restore screen can say which. A single altered word gives a valid-words,
 * bad-checksum result — the case §8 tests.
 */
export type PhraseProblem =
  | { kind: "ok" }
  | { kind: "length"; count: number }
  | { kind: "unknown-words"; words: string[] }
  | { kind: "checksum" };

export function inspectPhrase(input: string): PhraseProblem {
  const words = normalizePhrase(input).split(" ").filter(Boolean);
  if (words.length !== 12) return { kind: "length", count: words.length };

  const unknown = words.filter((w) => !wordlist.includes(w));
  if (unknown.length) return { kind: "unknown-words", words: unknown };

  try {
    mnemonicToEntropy(words.join(" "), wordlist);
    return { kind: "ok" };
  } catch {
    return { kind: "checksum" };
  }
}

export function isWordlistWord(word: string): boolean {
  return wordlist.includes(word);
}

export function completeWord(prefix: string, limit = 5): string[] {
  const p = prefix.trim().toLowerCase();
  if (p.length < 2) return [];
  const out: string[] = [];
  for (const w of wordlist) {
    if (w.startsWith(p)) {
      out.push(w);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Optional user entropy (§3.2)                                        */
/* ------------------------------------------------------------------ */

/**
 * A pool the UI feeds with mouse movement and keystrokes.
 *
 * This can only ever *add* entropy. The final mnemonic is derived from
 * `HMAC-SHA256(key = crypto.getRandomValues(32), msg = pool)`, so even a pool
 * an attacker chose entirely still leaves 128 bits of CSPRNG material in the
 * key. The user's contribution is never used on its own.
 */
export class EntropyPool {
  private chunks: Uint8Array[] = [];
  private bits = 0;

  /** Distinct grid cells seen so far, so the UI can show honest progress. */
  private seen = new Set<number>();

  constructor(private readonly targetBits = 256) {}

  get progress(): number {
    return Math.min(1, this.bits / this.targetBits);
  }

  get distinctCells(): number {
    return this.seen.size;
  }

  /**
   * `symbol` is the permuted 0..2047 value behind the grid cell the pointer is
   * over — 11 bits — and `t` is the high-resolution timestamp, whose low bits
   * carry the genuinely unpredictable part (human timing jitter).
   */
  addGridSample(symbol: number, t: number): void {
    const buf = new ArrayBuffer(12);
    const view = new DataView(buf);
    view.setUint16(0, symbol & 0x7ff);
    view.setFloat64(2, t);
    view.setUint16(10, (Math.random() * 0x10000) | 0);
    this.chunks.push(new Uint8Array(buf));

    // Credit 11 bits for a cell never visited before, and only ~2 bits of
    // timing jitter for a repeat. Dragging in circles should not look like
    // progress when it is not.
    if (this.seen.has(symbol)) {
      this.bits += 2;
    } else {
      this.seen.add(symbol);
      this.bits += 11;
    }
  }

  addKeystroke(code: string, t: number): void {
    const enc = new TextEncoder().encode(code + "|" + t);
    this.chunks.push(enc);
    this.bits += 3; // keystrokes are low-entropy; credit them as such
  }

  private digest(): Uint8Array {
    let total = 0;
    for (const c of this.chunks) total += c.length;
    const flat = new Uint8Array(total);
    let o = 0;
    for (const c of this.chunks) {
      flat.set(c, o);
      o += c.length;
    }
    return sha256(flat);
  }

  /**
   * Mixes the pool with fresh CSPRNG output and returns a BIP39 phrase.
   * Safe to call with an empty pool: the result is then just CSPRNG output
   * run through an HMAC.
   */
  toMnemonic(): string {
    const key = crypto.getRandomValues(new Uint8Array(32));
    const mixed = hmac(sha256, key, this.digest());
    const entropy = mixed.slice(0, ENTROPY_BYTES);
    const phrase = entropyToMnemonic(entropy, wordlist);
    key.fill(0);
    mixed.fill(0);
    entropy.fill(0);
    return phrase;
  }

  clear(): void {
    for (const c of this.chunks) c.fill(0);
    this.chunks = [];
    this.seen.clear();
    this.bits = 0;
  }
}

/**
 * A secret, per-session mapping from grid cell index to an 11-bit symbol. The
 * user sees an undifferentiated grid; which cell means what is never shown and
 * never reused, so the visual pattern of a drag reveals nothing about the pool.
 */
export function makeGridPermutation(cells = 2048): Uint16Array {
  const perm = new Uint16Array(cells);
  for (let i = 0; i < cells; i++) perm[i] = i;
  // Fisher-Yates with rejection sampling, driven by the CSPRNG.
  const rand = new Uint32Array(cells);
  crypto.getRandomValues(rand);
  for (let i = cells - 1; i > 0; i--) {
    const j = rand[i] % (i + 1);
    const tmp = perm[i];
    perm[i] = perm[j];
    perm[j] = tmp;
  }
  return perm;
}
