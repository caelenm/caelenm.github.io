/**
 * The activity list, including the on-chain deposits the SDK cannot see.
 *
 * Run with: node --experimental-strip-types src/lib/activity.test.ts
 *
 * The behaviour under test is the one that was missing: an unclaimed deposit
 * must be visible while it matures, must say so honestly, and must become
 * actionable at exactly the point it can actually be claimed — never before.
 */
import { DEPOSIT_CONFIRMATIONS } from "./deposits.ts";
import {
  autoClaimable,
  depositFee,
  depositStage,
  describeDeposit,
  mergeActivity,
  poolIdsIn,
  reconcileActivity,
  type DepositLike,
} from "./activity.ts";
import type { CachedActivity } from "./db.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
}

const dep = (over: Partial<DepositLike> = {}): DepositLike => ({
  txid: "aa".repeat(32),
  vout: 0,
  valueSats: 100_000,
  confirmations: DEPOSIT_CONFIRMATIONS,
  creditSats: 99_500,
  quoteError: null,
  firstSeenAt: 1_000,
  ...over,
});

const tx = (over: Partial<CachedActivity> = {}): CachedActivity => ({
  id: "tx1",
  direction: "in",
  amountSats: 5_000,
  status: "COMPLETED",
  settled: true,
  time: 2_000,
  kind: "lightning",
  ...over,
});

/* --- stages ---------------------------------------------------------------- */
{
  check("unmined is unconfirmed", depositStage(dep({ confirmations: 0, creditSats: null })), "unconfirmed");
  check("mined but shallow is confirming", depositStage(dep({ confirmations: 1, creditSats: null })), "confirming");
  check("one short is still confirming", depositStage(dep({ confirmations: DEPOSIT_CONFIRMATIONS - 1, creditSats: null })), "confirming");
  check("deep and priced is claimable", depositStage(dep()), "claimable");
  check("deep but unpriced is not claimable", depositStage(dep({ creditSats: null })), "unquoted");
  check("deeper than required stays claimable", depositStage(dep({ confirmations: 50 })), "claimable");
}

/* --- the fee the user is agreeing to --------------------------------------- */
{
  check("fee is what the SSP keeps", depositFee(dep()), 500);
  check("no fee without a quote", depositFee(dep({ creditSats: null })), null);
  check("no fee without a value", depositFee(dep({ valueSats: null })), null);
}

/* --- what the row says ----------------------------------------------------- */
{
  check("unconfirmed explains itself", describeDeposit(dep({ confirmations: 0, creditSats: null })), "Waiting for its first confirmation");
  check("confirming counts", describeDeposit(dep({ confirmations: 2, creditSats: null })), `2 of ${DEPOSIT_CONFIRMATIONS} confirmations`);
  check("claimable says so", describeDeposit(dep()), "Ready to claim");
  check(
    "an unquoted deposit surfaces the reason",
    describeDeposit(dep({ creditSats: null, quoteError: "SSP unavailable" })),
    "Confirmed — no quote yet: SSP unavailable",
  );
  check(
    "and reads sensibly with no reason",
    describeDeposit(dep({ creditSats: null })),
    "Confirmed — waiting for a quote",
  );
}

/* --- merging --------------------------------------------------------------- */
{
  const rows = mergeActivity([tx()], [dep({ confirmations: 1, creditSats: null, firstSeenAt: 500 })]);
  check("both sources appear", rows.length, 2);
  check("a maturing deposit sorts by time", rows[0]?.type, "tx");
  check("and is still present", rows[1]?.type, "deposit");
}

{
  // The one row waiting on the user outranks history, however old it is.
  const rows = mergeActivity([tx({ time: 9_999 })], [dep({ firstSeenAt: 1 })]);
  check("a claimable deposit goes to the top", rows[0]?.type, "deposit");
  check("even against newer activity", rows[1]?.type, "tx");
}

{
  const rows = mergeActivity(
    [tx({ id: "old", time: 1_000 }), tx({ id: "new", time: 3_000 })],
    [],
  );
  check("activity alone is newest first", rows.map((r) => r.id), ["new", "old"]);
}

{
  const rows = mergeActivity([], [dep({ vout: 0, firstSeenAt: 1 }), dep({ vout: 1, firstSeenAt: 2 })]);
  check("two claimable deposits both show", rows.length, 2);
  check("newest first among them", (rows[0] as { deposit: DepositLike }).deposit.vout, 1);
}

{
  // Two outputs of one transaction are two separate deposits and must not collide.
  const rows = mergeActivity([], [dep({ vout: 0 }), dep({ vout: 1 })]);
  check("ids are distinct per output", new Set(rows.map((r) => r.id)).size, 2);
}

{
  check("an empty wallet has an empty list", mergeActivity([], []), []);
}

{
  // A claimed deposit is gone from state, so it cannot linger as a row.
  const rows = mergeActivity([tx({ id: "credit" })], []);
  check("no deposits means only activity", rows.map((r) => r.id), ["credit"]);
}

/* --- auto-claim: spending the user's money unattended ---------------------- */
{
  const on = { enabled: true, maxFeeSats: 500 };

  check("off by default means never", autoClaimable(dep(), { enabled: false, maxFeeSats: 10_000 }), false);
  check("a fee under the ceiling is claimed", autoClaimable(dep({ creditSats: 99_600 }), on), true);
  check("a fee exactly at the ceiling is claimed", autoClaimable(dep({ creditSats: 99_500 }), on), true);
  check("a fee one sat over is not", autoClaimable(dep({ creditSats: 99_499 }), on), false);

  // Everything unknown or unfinished must refuse.
  check("an unconfirmed deposit is never auto-claimed", autoClaimable(dep({ confirmations: 0, creditSats: null }), on), false);
  check("a maturing deposit is never auto-claimed", autoClaimable(dep({ confirmations: DEPOSIT_CONFIRMATIONS - 1, creditSats: null }), on), false);
  check("an unquoted deposit is never auto-claimed", autoClaimable(dep({ creditSats: null }), on), false);
  check("an unknown on-chain value is never auto-claimed", autoClaimable(dep({ valueSats: null }), on), false);

  // A credit larger than the deposit is a broken quote, not free money.
  check("a negative fee waits for a person", autoClaimable(dep({ creditSats: 100_001 }), on), false);

  // A zero ceiling means only a genuinely free claim.
  const zero = { enabled: true, maxFeeSats: 0 };
  check("a zero ceiling refuses any fee", autoClaimable(dep(), zero), false);
  check("a zero ceiling allows a zero fee", autoClaimable(dep({ creditSats: 100_000 }), zero), true);
}

/* --- classification never degrades ----------------------------------------- */
{
  // The bug: recognising a swap needs the pool's identity, which is learned at
  // runtime, so the same transfer read as "Swap" in one session and "Sent" in
  // the next — and the downgrade was written back to the cache.
  const swap = tx({ id: "s", kind: "swap", swapDirection: "toStable", counterparty: "pool", direction: "out" });
  const degraded = { ...swap, kind: "spark" as const, swapDirection: undefined };

  check(
    "a swap is not relabelled a payment when the pool is unknown",
    reconcileActivity([degraded], [swap]).map((a) => [a.kind, a.swapDirection]),
    [["swap", "toStable"]],
  );
  check(
    "an unknown kind is upgraded the same way",
    reconcileActivity([{ ...degraded, kind: "unknown" }], [swap])[0].kind,
    "swap",
  );

  // Only the classification is carried over: the operators stay the authority
  // on anything that genuinely changes.
  const settledLater = reconcileActivity([{ ...degraded, status: "COMPLETED", settled: true, amountSats: 7 }], [
    { ...swap, status: "PENDING", settled: false, amountSats: 7 },
  ])[0];
  check("status still comes from the fresh row", [settledLater.status, settledLater.settled], ["COMPLETED", true]);

  // And it must not invent classifications it was never given.
  check(
    "a genuine payment stays a payment",
    reconcileActivity([tx({ id: "p", kind: "spark" })], [tx({ id: "p", kind: "spark" })])[0].kind,
    "spark",
  );
  check(
    "a fresh identification wins over the cached one",
    reconcileActivity([tx({ id: "x", kind: "onchain" })], [tx({ id: "x", kind: "spark" })])[0].kind,
    "onchain",
  );
  check(
    "an unseen row is left exactly as fetched",
    reconcileActivity([tx({ id: "new", kind: "spark" })], [swap])[0].kind,
    "spark",
  );

  check("pools are recovered from known swaps", poolIdsIn([swap, tx({ id: "b", kind: "spark", counterparty: "bob" })]), ["pool"]);
  check("a swap with no counterparty yields nothing", poolIdsIn([tx({ kind: "swap" })]), []);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
