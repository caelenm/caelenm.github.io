/**
 * Did the Lightning payment actually reach the receiver?
 *
 * A Spark Lightning send is not one action. The wallet hands leaves to the SSP,
 * the SSP pays the invoice, and only on success does it reveal the preimage and
 * the leaves become the SSP's. Each of those can be in flight or fail
 * separately, so "the call returned" says nothing about whether anyone was paid.
 *
 * Exactly one thing proves delivery: the payment preimage. An invoice commits to
 * `sha256(preimage)` as its payment hash, so a preimage that hashes to it is
 * proof the receiver released it, and nobody can produce one otherwise. Operator
 * status is a claim; the preimage is evidence. This module prefers the evidence
 * and treats everything it does not recognise as undelivered.
 *
 * The asymmetry here is deliberate. Reporting a payment as delivered when it was
 * not is far worse than the reverse: the user stops waiting, the receiver never
 * got paid, and the funds are somewhere in between.
 */
import { sha256 } from "@noble/hashes/sha2.js";

/** Statuses that mean the receiver has been paid. */
const DELIVERED = new Set([
  "LIGHTNING_PAYMENT_SUCCEEDED",
  "PREIMAGE_PROVIDED",
  "TRANSFER_COMPLETED",
  "TRANSFER_STATUS_COMPLETED",
]);

/** Statuses that mean it is over and the receiver was not paid. */
const FAILED = new Set([
  "LIGHTNING_PAYMENT_FAILED",
  "USER_TRANSFER_VALIDATION_FAILED",
  "PREIMAGE_PROVIDING_FAILED",
  "TRANSFER_FAILED",
  "TRANSFER_STATUS_EXPIRED",
  "TRANSFER_STATUS_RETURNED",
]);

/** Failed *and* the sats are back — the send cost nothing. */
const REFUNDED = new Set([
  "PENDING_USER_SWAP_RETURN",
  "USER_SWAP_RETURNED",
  "USER_SWAP_RETURN_FAILED",
  "TRANSFER_STATUS_RETURNED",
]);

export type SendState =
  /** The receiver has the money. Safe to tell the user it is done. */
  | "delivered"
  /** Still moving. Not delivered, not refunded — the user must keep waiting. */
  | "in-flight"
  /** Over, and the receiver was not paid. */
  | "failed";

export interface SendOutcome {
  state: SendState;
  /** The operator's own status string, kept for display and diagnosis. */
  status: string;
  /**
   * true  — a preimage came back and it hashes to the invoice's payment hash.
   * false — a preimage came back and it does NOT match. Never delivered.
   * null  — no preimage was offered, so there is nothing to check.
   */
  preimage: boolean | null;
  /** The operator says the sats returned to this wallet. */
  refunded: boolean;
}

/** The subset of the SDK's send results this module reads. */
export interface SendResultLike {
  status?: unknown;
  paymentPreimage?: unknown;
}

function hexToBytes(s: string): Uint8Array | null {
  const h = s.trim().toLowerCase();
  if (h.length === 0 || h.length % 2 !== 0 || !/^[0-9a-f]+$/.test(h)) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Constant-time compare, so a mismatch does not leak where it differed. */
function equal(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

/**
 * True when `preimageHex` is the preimage for `paymentHashHex`.
 *
 * Returns false for anything malformed rather than throwing: an unparseable
 * preimage is not proof of payment, which is the same answer a wrong one gets.
 */
export function verifyPreimage(preimageHex: string, paymentHashHex: string): boolean {
  const preimage = hexToBytes(preimageHex);
  const hash = hexToBytes(paymentHashHex);
  if (!preimage || !hash || hash.length !== 32) return false;
  return equal(sha256(preimage), hash);
}

/**
 * Classifies what the SSP returned for a Lightning send.
 *
 * `paymentHashHex` comes from the invoice the user is paying — decoded locally,
 * never taken from the response, or the proof would be circular.
 */
export function classifySend(result: SendResultLike | null | undefined, paymentHashHex?: string): SendOutcome {
  const status = typeof result?.status === "string" ? result.status : "";
  const refunded = REFUNDED.has(status);

  let preimage: boolean | null = null;
  if (typeof result?.paymentPreimage === "string" && result.paymentPreimage.length > 0) {
    // With no invoice hash to check against, an unverifiable preimage is not
    // evidence. It must not be promoted to proof.
    preimage = paymentHashHex ? verifyPreimage(result.paymentPreimage, paymentHashHex) : null;
  }

  // A preimage that does not match the invoice is never delivery, whatever the
  // status says — either it is the wrong payment or the response is not trustworthy.
  if (preimage === false) return { state: "failed", status, preimage, refunded };

  // A verified preimage is proof, and outranks a status that has not caught up.
  if (preimage === true) return { state: "delivered", status, preimage, refunded };

  if (DELIVERED.has(status)) return { state: "delivered", status, preimage, refunded };
  if (FAILED.has(status) || refunded) return { state: "failed", status, preimage, refunded };

  // CREATED, LIGHTNING_PAYMENT_INITIATED, REQUEST_VALIDATED, an unrecognised
  // status, or no status at all. All of these mean "not proven", and the only
  // safe reading of "not proven" is that the money is still in motion.
  return { state: "in-flight", status, preimage, refunded };
}
