/**
 * Minimal BOLT11 reader.
 *
 * Only enough to show the user what they are about to pay before they confirm:
 * amount, description, expiry, network. The SDK does the real validation when
 * the payment is attempted — this exists so the confirm screen can be honest,
 * not so the app can decide an invoice is good.
 *
 * Deliberately not a dependency: a wallet should not pull a package to read a
 * string it already has in hand.
 */
import { bech32 } from "@scure/base";

export interface DecodedInvoice {
  network: "mainnet" | "testnet" | "regtest" | "signet";
  /** null for a zero-amount ("any amount") invoice. */
  amountSats: number | null;
  description?: string;
  descriptionHash?: string;
  paymentHash?: string;
  /** Epoch seconds. */
  timestamp: number;
  expirySeconds: number;
  get expiresAt(): number;
}

const NETWORKS: Record<string, DecodedInvoice["network"]> = {
  bc: "mainnet",
  tb: "testnet",
  bcrt: "regtest",
  tbs: "signet",
  sb: "signet",
};

/** msat per whole unit, by BOLT11 multiplier suffix. */
const MULTIPLIER: Record<string, number> = {
  m: 1e8,
  u: 1e5,
  n: 1e2,
  p: 0.1,
};

/**
 * Parses the human-readable part (`lnbc2500u`) into network and amount.
 *
 * Exported so it can be tested directly against every network and multiplier:
 * a signed invoice cannot be fabricated for a test, but this half of the format
 * is pure arithmetic and is where an amount would silently go wrong.
 */
export function parseHrp(prefix: string): { network: DecodedInvoice["network"]; amountSats: number | null } | null {
  const m = /^ln(bcrt|bc|tbs|tb|sb)(\d+)?([munp])?$/.exec(prefix);
  if (!m) return null;
  const network = NETWORKS[m[1]];
  if (!network) return null;

  if (!m[2]) return { network, amountSats: null };
  const digits = Number(m[2]);
  const msat = m[3] ? digits * MULTIPLIER[m[3]] : digits * 1e11;
  // A sub-satoshi invoice is real but unpayable here; round up so the confirm
  // screen never understates what leaves the wallet.
  return { network, amountSats: Math.ceil(msat / 1000) };
}

function wordsToBytes(words: number[]): Uint8Array {
  const out = bech32.fromWordsUnsafe(words);
  return out ?? new Uint8Array(0);
}

function wordsToInt(words: number[]): number {
  let n = 0;
  for (const w of words) n = n * 32 + w;
  return n;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function decodeInvoice(raw: string): DecodedInvoice | null {
  const input = raw.trim().replace(/^lightning:/i, "").toLowerCase();
  if (!input.startsWith("ln")) return null;

  let prefix: string;
  let words: number[];
  try {
    // BOLT11 invoices routinely exceed bech32's 90-character default limit.
    const res = bech32.decode(input as `${string}1${string}`, false);
    prefix = res.prefix;
    words = [...res.words];
  } catch {
    return null;
  }

  const hrp = parseHrp(prefix);
  if (!hrp) return null;
  const { network, amountSats } = hrp;

  // 7 words of timestamp, then tagged fields, then a 104-word signature.
  if (words.length < 7 + 104) return null;
  const timestamp = wordsToInt(words.slice(0, 7));
  const tagged = words.slice(7, words.length - 104);

  let description: string | undefined;
  let descriptionHash: string | undefined;
  let paymentHash: string | undefined;
  let expirySeconds = 3600; // BOLT11 default

  let i = 0;
  while (i + 3 <= tagged.length) {
    const type = tagged[i];
    const len = tagged[i + 1] * 32 + tagged[i + 2];
    const start = i + 3;
    const end = start + len;
    if (end > tagged.length) break;
    const data = tagged.slice(start, end);

    switch (type) {
      case 1: // p — payment hash
        paymentHash = toHex(wordsToBytes(data));
        break;
      case 13: // d — short description
        try {
          description = new TextDecoder("utf-8", { fatal: false }).decode(wordsToBytes(data));
        } catch {
          /* leave undefined */
        }
        break;
      case 23: // h — description hash
        descriptionHash = toHex(wordsToBytes(data));
        break;
      case 6: // x — expiry
        expirySeconds = wordsToInt(data);
        break;
      default:
        break;
    }
    i = end;
  }

  return {
    network,
    amountSats,
    description,
    descriptionHash,
    paymentHash,
    timestamp,
    expirySeconds,
    get expiresAt() {
      return (this.timestamp + this.expirySeconds) * 1000;
    },
  };
}

export function isExpired(inv: DecodedInvoice, now = Date.now()): boolean {
  return now >= inv.expiresAt;
}
