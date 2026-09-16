/**
 * Destination detection for the one paste field on the Send sheet.
 *
 * Explicit .ts extensions so `npm test` can load this under Node's ESM
 * resolver, which (unlike Vite) will not guess at them.
 */
import { isValidSparkAddress } from "@buildonspark/spark-sdk";
import { decodeInvoice, type DecodedInvoice } from "./bolt11.ts";
import { addressNetwork } from "./address.ts";

export type Destination =
  | { kind: "bolt11"; raw: string; decoded: DecodedInvoice }
  | { kind: "spark"; raw: string }
  | { kind: "lightning-address"; raw: string }
  | { kind: "lnurl"; raw: string }
  | { kind: "onchain"; raw: string }
  | { kind: "unknown"; raw: string };

const LIGHTNING_ADDRESS = /^[a-z0-9._-]+@[a-z0-9.-]+\.[a-z]{2,}$/i;
const ONCHAIN = /^(bc1|tb1|bcrt1|[13mn2])[a-zA-HJ-NP-Z0-9]{10,}$/;

/** Strips the scheme prefixes that QR codes and OS share sheets add. */
export function stripScheme(input: string): string {
  let s = input.trim();
  s = s.replace(/^(lightning|bitcoin|spark):(\/\/)?/i, "");
  // A BIP21 URI carries the address before any query parameters.
  const q = s.indexOf("?");
  if (q > 0 && !s.toLowerCase().startsWith("ln")) s = s.slice(0, q);
  return s.trim();
}

export function detect(input: string): Destination {
  const raw = stripScheme(input);
  if (!raw) return { kind: "unknown", raw };

  const lower = raw.toLowerCase();

  if (lower.startsWith("ln") && !lower.startsWith("lnurl")) {
    const decoded = decodeInvoice(raw);
    if (decoded) return { kind: "bolt11", raw: lower, decoded };
  }

  if (lower.startsWith("lnurl1")) return { kind: "lnurl", raw: lower };

  if (LIGHTNING_ADDRESS.test(raw)) return { kind: "lightning-address", raw: lower };

  try {
    if (isValidSparkAddress(raw)) return { kind: "spark", raw };
  } catch {
    /* not a Spark address */
  }

  // Shape first, then the checksum. The regex alone would accept a mistyped
  // address, which detect() would then present as a valid destination and offer
  // to save as a contact — a typo made permanent and reusable. addressNetwork
  // decodes it properly; which chain it belongs to is checked at the point of
  // withdrawal, where the wallet's own network is known.
  if (ONCHAIN.test(raw) && addressNetwork(raw) !== null) return { kind: "onchain", raw };

  return { kind: "unknown", raw };
}

export function describeDestination(d: Destination): string {
  switch (d.kind) {
    case "bolt11":
      return "Lightning invoice";
    case "spark":
      return "Spark address";
    case "lightning-address":
      return "Lightning address";
    case "lnurl":
      return "LNURL";
    case "onchain":
      return "Bitcoin address";
    default:
      return "Unrecognised";
  }
}
