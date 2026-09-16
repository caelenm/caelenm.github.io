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
import { classifySend, sendRequestId, verifyPreimage, watchLightningSend, type SendResultLike } from "./lightning.ts";

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


/* --- following an in-flight send to its conclusion ------------------------- */
// The reported bug: a payment that really arrived still read "still settling".
// payLightningInvoice returns before anyone is paid, and nothing asked again.

const noSleep = { sleep: async () => {}, intervalMs: 0 };

{
  check("an id is read from the result", sendRequestId({ id: "req_1" }), "req_1");
  check("a missing id is null", sendRequestId({}), null);
  check("an empty id is null", sendRequestId({ id: "" }), null);
  check("a non-string id is null", sendRequestId({ id: 7 }), null);
}

{
  // The exact sequence the SSP walks: accepted, in flight, then paid.
  const seq: SendResultLike[] = [
    { status: "CREATED" },
    { status: "LIGHTNING_PAYMENT_INITIATED" },
    { status: "LIGHTNING_PAYMENT_SUCCEEDED", paymentPreimage: PREIMAGE },
  ];
  let i = 0;
  const seen: string[] = [];
  const o = await watchLightningSend(async () => seq[i++] ?? seq[seq.length - 1]!, HASH, {
    ...noSleep,
    onUpdate: (u) => seen.push(u.state),
  });
  check("a send that lands is reported delivered", o.state, "delivered");
  check("and proved by the preimage", o.preimage, true);
  check("the UI saw it move", seen, ["in-flight", "in-flight", "delivered"]);
  check("polling stopped once proven", i, 3);
}

{
  const seq: SendResultLike[] = [{ status: "CREATED" }, { status: "LIGHTNING_PAYMENT_FAILED" }];
  let i = 0;
  const o = await watchLightningSend(async () => seq[Math.min(i++, 1)]!, HASH, noSleep);
  check("a send that fails is reported failed", o.state, "failed");
}

{
  const seq: SendResultLike[] = [{ status: "CREATED" }, { status: "USER_SWAP_RETURNED" }];
  let i = 0;
  const o = await watchLightningSend(async () => seq[Math.min(i++, 1)]!, HASH, noSleep);
  check("a refunded send is failed", o.state, "failed");
  check("and says the sats came back", o.refunded, true);
}

{
  // Never resolves: give up and stay honest rather than guess either way.
  let calls = 0;
  let t = 0;
  const o = await watchLightningSend(async () => { calls++; return { status: "CREATED" }; }, HASH, {
    sleep: async () => { t += 1_000; },
    intervalMs: 1_000,
    timeoutMs: 5_000,
    now: () => t,
  });
  check("an unresolved send times out as in-flight", o.state, "in-flight");
  check("and stops polling", calls <= 6, true);
}

{
  // A poll that throws says nothing about the payment; keep waiting.
  let i = 0;
  const o = await watchLightningSend(
    async () => {
      if (++i < 3) throw new Error("offline");
      return { status: "TRANSFER_COMPLETED" };
    },
    HASH,
    noSleep,
  );
  check("a failed poll does not end the watch", o.state, "delivered");
}

{
  // Null means "nothing to report", not "failed".
  let i = 0;
  const o = await watchLightningSend(async () => (++i < 3 ? null : { status: "PREIMAGE_PROVIDED" }), HASH, noSleep);
  check("a null poll does not end the watch", o.state, "delivered");
}

{
  // The preimage check still governs while polling: a mismatch is never delivery.
  const o = await watchLightningSend(
    async () => ({ status: "LIGHTNING_PAYMENT_SUCCEEDED", paymentPreimage: PREIMAGE }),
    OTHER_HASH,
    noSleep,
  );
  check("a mismatched preimage while polling is failure", o.state, "failed");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
