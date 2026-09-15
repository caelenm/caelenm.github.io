/**
 * Lightning send atomicity.
 *
 * Run with: node --experimental-strip-types src/lib/lightning.test.ts
 *
 * The invariant every check here defends: the wallet reports "delivered" only
 * when the receiver provably has the money. Everything ambiguous, unrecognised
 * or contradictory must read as undelivered, because a false "sent" makes the
 * user stop chasing a payment that never arrived.
 */
import { sha256 } from "@noble/hashes/sha2.js";
import { classifySend, verifyPreimage, type SendResultLike } from "./lightning.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${actual} want ${expected}`}`);
}

const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");
/** A real preimage/payment-hash pair: the hash is sha256 of the preimage. */
const PREIMAGE = toHex(new Uint8Array(32).fill(0xab));
const HASH = toHex(sha256(new Uint8Array(32).fill(0xab)));
const OTHER_HASH = toHex(sha256(new Uint8Array(32).fill(0xcd)));

/* --- the proof itself ------------------------------------------------------ */
{
  check("a preimage verifies against its own hash", verifyPreimage(PREIMAGE, HASH), true);
  check("it does not verify against another hash", verifyPreimage(PREIMAGE, OTHER_HASH), false);
  check("uppercase hex still verifies", verifyPreimage(PREIMAGE.toUpperCase(), HASH.toUpperCase()), true);
  check("an empty preimage does not verify", verifyPreimage("", HASH), false);
  check("non-hex does not verify", verifyPreimage("zz".repeat(32), HASH), false);
  check("odd-length hex does not verify", verifyPreimage("abc", HASH), false);
  check("a payment hash that is not 32 bytes is refused", verifyPreimage(PREIMAGE, "abcd"), false);
  check("a truncated preimage does not verify", verifyPreimage(PREIMAGE.slice(0, 60), HASH), false);
}

/* --- proof beats status ---------------------------------------------------- */
{
  const r: SendResultLike = { status: "LIGHTNING_PAYMENT_INITIATED", paymentPreimage: PREIMAGE };
  const o = classifySend(r, HASH);
  check("a verified preimage means delivered even mid-flight", o.state, "delivered");
  check("and the verification is recorded", o.preimage, true);
}

{
  // The dangerous case: the operator claims success but the preimage is for a
  // different payment. Believing the status here would be a false "sent".
  const r: SendResultLike = { status: "LIGHTNING_PAYMENT_SUCCEEDED", paymentPreimage: PREIMAGE };
  const o = classifySend(r, OTHER_HASH);
  check("a mismatched preimage is never delivered", o.state, "failed");
  check("even though the status claims success", o.status, "LIGHTNING_PAYMENT_SUCCEEDED");
  check("and the mismatch is recorded", o.preimage, false);
}

{
  const r: SendResultLike = { status: "LIGHTNING_PAYMENT_SUCCEEDED", paymentPreimage: "nonsense" };
  check("an unparseable preimage is a mismatch, not a pass", classifySend(r, HASH).state, "failed");
}

{
  // Without the invoice hash there is nothing to check the preimage against, so
  // it cannot count as proof — the status has to carry the decision.
  const r: SendResultLike = { status: "LIGHTNING_PAYMENT_INITIATED", paymentPreimage: PREIMAGE };
  const o = classifySend(r);
  check("an unverifiable preimage is not proof", o.preimage, null);
  check("so an in-flight status stays in-flight", o.state, "in-flight");
}

/* --- status, where there is no preimage ------------------------------------ */
{
  for (const status of ["LIGHTNING_PAYMENT_SUCCEEDED", "PREIMAGE_PROVIDED", "TRANSFER_COMPLETED"]) {
    check(`${status} is delivered`, classifySend({ status }, HASH).state, "delivered");
  }
  for (const status of [
    "LIGHTNING_PAYMENT_FAILED",
    "USER_TRANSFER_VALIDATION_FAILED",
    "PREIMAGE_PROVIDING_FAILED",
    "TRANSFER_FAILED",
  ]) {
    check(`${status} is failed`, classifySend({ status }, HASH).state, "failed");
  }
  for (const status of ["CREATED", "LIGHTNING_PAYMENT_INITIATED", "REQUEST_VALIDATED"]) {
    check(`${status} is still in flight`, classifySend({ status }, HASH).state, "in-flight");
  }
}

/* --- refunds --------------------------------------------------------------- */
{
  for (const status of ["PENDING_USER_SWAP_RETURN", "USER_SWAP_RETURNED"]) {
    const o = classifySend({ status }, HASH);
    check(`${status} is failed`, o.state, "failed");
    check(`${status} reports the sats came back`, o.refunded, true);
  }
  check("a delivered send is not a refund", classifySend({ status: "TRANSFER_COMPLETED" }, HASH).refunded, false);
}

/* --- the default must never be optimistic ---------------------------------- */
{
  check("an unknown status is not delivered", classifySend({ status: "SOMETHING_NEW" }, HASH).state, "in-flight");
  check("FUTURE_VALUE is not delivered", classifySend({ status: "FUTURE_VALUE" }, HASH).state, "in-flight");
  check("a missing status is not delivered", classifySend({}, HASH).state, "in-flight");
  check("a null result is not delivered", classifySend(null, HASH).state, "in-flight");
  check("an undefined result is not delivered", classifySend(undefined, HASH).state, "in-flight");
  check("a non-string status is not delivered", classifySend({ status: 7 }, HASH).state, "in-flight");
  // No status string is ever silently treated as success.
  check("an empty status is not delivered", classifySend({ status: "" }, HASH).state, "in-flight");
}

/* --- the spark-transfer leg ------------------------------------------------ */
{
  check(
    "a completed spark transfer is delivered",
    classifySend({ status: "TRANSFER_STATUS_COMPLETED" }).state,
    "delivered",
  );
  const returned = classifySend({ status: "TRANSFER_STATUS_RETURNED" });
  check("a returned spark transfer failed", returned.state, "failed");
  check("and counts as refunded", returned.refunded, true);
  check("an expired spark transfer failed", classifySend({ status: "TRANSFER_STATUS_EXPIRED" }).state, "failed");
  check(
    "a transfer still being tweaked is in flight",
    classifySend({ status: "TRANSFER_STATUS_SENDER_KEY_TWEAKED" }).state,
    "in-flight",
  );
}

/* --- no state is ever both ------------------------------------------------- */
{
  const statuses = [
    "LIGHTNING_PAYMENT_SUCCEEDED", "PREIMAGE_PROVIDED", "TRANSFER_COMPLETED", "TRANSFER_STATUS_COMPLETED",
    "LIGHTNING_PAYMENT_FAILED", "TRANSFER_FAILED", "PENDING_USER_SWAP_RETURN", "USER_SWAP_RETURNED",
    "CREATED", "LIGHTNING_PAYMENT_INITIATED", "REQUEST_VALIDATED", "FUTURE_VALUE", "",
  ];
  const valid = statuses.every((status) => {
    const s = classifySend({ status }, HASH).state;
    return s === "delivered" || s === "in-flight" || s === "failed";
  });
  check("every status maps to exactly one state", valid, true);

  // Nothing that is delivered may also claim to have been refunded.
  const contradiction = statuses.some((status) => {
    const o = classifySend({ status }, HASH);
    return o.state === "delivered" && o.refunded;
  });
  check("nothing is both delivered and refunded", contradiction, false);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
