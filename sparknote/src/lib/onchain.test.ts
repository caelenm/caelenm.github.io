/**
 * Cooperative-exit fee arithmetic.
 *
 * These checks exist because of a real failure: the first version read
 * `userFeeFast` regardless of the selected speed and ignored `l1BroadcastFee`
 * entirely. The declared fee came out too low, the SSP made up the difference
 * out of the payout, and the SDK's anti-redirect validation rejected the
 * withdrawal with "does not pay the requested withdrawal address for the
 * expected amount".
 *
 * Run with: node --experimental-strip-types src/lib/onchain.test.ts
 */
import { ExitSpeed } from "@buildonspark/spark-sdk/types";
import {
  DUST_LIMIT_SATS,
  planWithdrawal,
  readFeeQuote,
  validateWithdrawal,
} from "./onchain.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(
    `${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`,
  );
}

const sats = (n: number) => ({ originalValue: n, originalUnit: "SATOSHI" });

/** Shaped like a real CoopExitFeeQuote, with a different figure per speed. */
const QUOTE = {
  id: "quote-abc",
  userFeeFast: sats(400),
  userFeeMedium: sats(250),
  userFeeSlow: sats(100),
  l1BroadcastFeeFast: sats(900),
  l1BroadcastFeeMedium: sats(500),
  l1BroadcastFeeSlow: sats(200),
};

// --- the actual bug -------------------------------------------------------

check("fast = userFee + broadcastFee", readFeeQuote(QUOTE, ExitSpeed.FAST).totalSats, 1300);
check("medium reads the medium fields", readFeeQuote(QUOTE, ExitSpeed.MEDIUM).totalSats, 750);
check("slow reads the slow fields", readFeeQuote(QUOTE, ExitSpeed.SLOW).totalSats, 300);

// The regression that caused the failure: picking a non-fast speed must not
// silently return the fast fee.
check(
  "slow does not return the fast fee",
  readFeeQuote(QUOTE, ExitSpeed.SLOW).totalSats !== readFeeQuote(QUOTE, ExitSpeed.FAST).totalSats,
  true,
);
// And the broadcast fee must not be dropped.
check(
  "broadcast fee is included, not ignored",
  readFeeQuote(QUOTE, ExitSpeed.MEDIUM).totalSats >
    readFeeQuote(QUOTE, ExitSpeed.MEDIUM).userFeeSats,
  true,
);

check("quote id is carried through", readFeeQuote(QUOTE, ExitSpeed.FAST).id, "quote-abc");
check("speed is carried through", readFeeQuote(QUOTE, ExitSpeed.SLOW).speed, ExitSpeed.SLOW);

// Missing or malformed components must degrade to 0, never NaN — a NaN fee
// would be sent to the SSP verbatim.
check("missing fields → 0", readFeeQuote({}, ExitSpeed.FAST).totalSats, 0);
check("null quote → 0", readFeeQuote(null, ExitSpeed.FAST).totalSats, 0);
check(
  "millisatoshi is converted, not taken at face value",
  readFeeQuote(
    { userFeeFast: { originalValue: 400_000, originalUnit: "MILLISATOSHI" }, l1BroadcastFeeFast: sats(0) },
    ExitSpeed.FAST,
  ).totalSats,
  400,
);

// --- planning -------------------------------------------------------------

const fee = readFeeQuote(QUOTE, ExitSpeed.MEDIUM); // 750

check("exact: destination receives the requested amount", planWithdrawal(100_000, 10_000, fee), {
  mode: "exact",
  amountSats: 10_000,
  feeSats: 750,
  receivesSats: 10_000,
});
check("max: destination receives balance minus fee", planWithdrawal(100_000, "max", fee), {
  mode: "max",
  amountSats: 100_000,
  feeSats: 750,
  receivesSats: 99_250,
});
// withdraw() rejects a non-integer amountSats before it ever looks at the
// withdraw-all flag, so max must still carry a concrete amount.
check(
  "max still carries a concrete amountSats",
  Number.isSafeInteger(planWithdrawal(100_000, "max", fee).amountSats),
  true,
);

// --- validation -----------------------------------------------------------

check("a normal withdrawal passes", validateWithdrawal(planWithdrawal(100_000, 10_000, fee), 100_000), {
  ok: true,
});

const belowDust = validateWithdrawal(planWithdrawal(100_000, DUST_LIMIT_SATS - 1, fee), 100_000);
check("below the dust limit is refused", belowDust.ok, false);

check(
  "exactly the dust limit is allowed",
  validateWithdrawal(planWithdrawal(100_000, DUST_LIMIT_SATS, fee), 100_000).ok,
  true,
);

// Amount alone fits, but amount + fee does not.
check(
  "fee is counted against the balance",
  validateWithdrawal(planWithdrawal(10_000, 9_800, fee), 10_000).ok,
  false,
);

// Max out of a balance that cannot cover the fee leaves a dust payout.
check(
  "max on a balance below the fee is refused",
  validateWithdrawal(planWithdrawal(500, "max", fee), 500).ok,
  false,
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
