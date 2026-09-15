/**
 * Stable balance logic, against a mock AMM.
 *
 * Run with: node --experimental-strip-types src/lib/stable.test.ts
 */
import {
  StableError,
  convertToBitcoin,
  convertToStable,
  executeRebalance,
  formatUsd,
  planRebalance,
  payFromStable,
  planPayFromStable,
  usdbNeededForSats,
  withSlippage,
  type SwapDirection,
  type SwapProvider,
} from "./stable.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const norm = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? `${x}n` : x));
  const ok = norm(actual) === norm(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${norm(actual)} want ${norm(expected)}`}`);
}

/**
 * A constant-price pool: BTC at $100,000, so 1,000 sats = $1 = 1,000,000 USDB
 * units, with a 5 bps fee taken on the way out.
 */
function mockProvider(opts: { failQuote?: boolean; failSwap?: boolean; minBtc?: bigint; minUsdb?: bigint } = {}) {
  const calls: { kind: string; direction?: SwapDirection; amountIn?: bigint; minOut?: bigint }[] = [];
  const out = (direction: SwapDirection, amountIn: bigint) => {
    const gross = direction === "toStable" ? amountIn * 1_000n : amountIn / 1_000n;
    return (gross * 9_995n) / 10_000n;
  };
  const provider: SwapProvider = {
    minimums: async () => ({ btcSats: opts.minBtc ?? 800n, usdbUnits: opts.minUsdb ?? 500_000n }),
    quote: async (direction, amountIn) => {
      calls.push({ kind: "quote", direction, amountIn });
      if (opts.failQuote) throw new Error("no route");
      return out(direction, amountIn);
    },
    swap: async (direction, amountIn, minOut) => {
      calls.push({ kind: "swap", direction, amountIn, minOut });
      if (opts.failSwap) throw new Error("pool moved");
      const amountOut = out(direction, amountIn);
      if (amountOut < minOut) throw new Error("slippage");
      return { amountOut };
    },
  };
  return { provider, calls };
}

// --- formatting ---------------------------------------------------------------

check("whole dollars", formatUsd(12_000_000n), "$12.00");
check("floors to the cent, never rounds up", formatUsd(1_999_999n), "$1.99");
check("thousands separators", formatUsd(1_234_567_890n), "$1,234.56");
check("zero", formatUsd(0n), "$0.00");
check("slippage of 50 bps", withSlippage(1_000_000n), 995_000n);

// --- converting incoming payments ----------------------------------------------

{
  const { provider, calls } = mockProvider();
  const r = await convertToStable(provider, 799n);
  check("below the 800-sat minimum is left as bitcoin", r.status === "skipped" ? r.reason : r.status, "below-minimum");
  check("no swap attempted below the minimum", calls.filter((c) => c.kind === "swap").length, 0);
}

{
  const { provider, calls } = mockProvider();
  const r = await convertToStable(provider, 800n);
  check("exactly the minimum converts", r.status, "converted");
  const swap = calls.find((c) => c.kind === "swap");
  check("min output is the quote less slippage", swap?.minOut, withSlippage((800_000n * 9_995n) / 10_000n));
}

{
  const { provider, calls } = mockProvider({ failQuote: true });
  const r = await convertToStable(provider, 50_000n);
  check("an unquotable swap is skipped, not attempted", r.status === "skipped" ? r.reason : r.status, "quote-failed");
  check("no swap after a failed quote", calls.filter((c) => c.kind === "swap").length, 0);
}

{
  const { provider } = mockProvider({ failSwap: true });
  const r = await convertToStable(provider, 50_000n);
  check("a swap that fails reports failure without throwing", r.status, "failed");
}

check("zero sats is nothing to do", (await convertToStable(mockProvider().provider, 0n)).status, "skipped");

{
  const { provider } = mockProvider();
  const r = await convertToBitcoin(provider, 400_000n);
  check("USD below the $0.50 minimum stays USD", r.status === "skipped" ? r.reason : r.status, "below-minimum");
}

// --- finding the USD needed for a bitcoin amount --------------------------------

{
  const { provider } = mockProvider();
  const target = 12_345n;
  const { amountIn, minSatsOut } = await usdbNeededForSats(provider, target, 1_000_000_000n);
  const outAt = async (u: bigint) => withSlippage(await provider.quote("toBitcoin", u));
  check("the found input covers the target after slippage", minSatsOut >= target, true);
  check("the found input overshoots by no more than 0.01%", (amountIn - 1n) * 10_000n <= amountIn * 10_001n / 1n && (await outAt((amountIn * 9_999n) / 10_000n)) < target, true);
}

{
  const { provider } = mockProvider();
  const r = await usdbNeededForSats(provider, 100n, 1_000_000_000n);
  check("a tiny target is clamped up to the $0.50 minimum", r.amountIn, 500_000n);
}

{
  const { provider } = mockProvider();
  try {
    await usdbNeededForSats(provider, 50_000n, 10_000_000n);
    failures++;
    console.log("FAIL insufficient USD did not throw");
  } catch (e) {
    check("not enough USD throws insufficient-stable", e instanceof StableError ? e.code : String(e), "insufficient-stable");
  }
}

// --- planning and paying ----------------------------------------------------------

{
  const { provider, calls } = mockProvider();
  const plan = await planPayFromStable(provider, { neededSats: 5_000n, btcAvailable: 6_000n, usdbAvailable: 100_000_000n });
  check("no swap when bitcoin already covers the payment", plan.swap, null);
  check("no quotes needed either", calls.length, 0);
}

{
  const { provider } = mockProvider();
  const plan = await planPayFromStable(provider, { neededSats: 5_000n, btcAvailable: 1_000n, usdbAvailable: 100_000_000n });
  check("only the shortfall is converted", plan.swap?.shortfallSats, 4_000n);
  check("and the conversion covers it", (plan.swap?.minSatsOut ?? 0n) >= 4_000n, true);
}

{
  const { provider, calls } = mockProvider();
  const order: string[] = [];
  const { result, swapped } = await payFromStable(provider, {
    neededSats: 3_000n,
    btcAvailable: 0n,
    usdbAvailable: 100_000_000n,
    pay: async () => {
      order.push(`pay after ${calls.filter((c) => c.kind === "swap").length} swap(s)`);
      return "paid";
    },
  });
  check("the swap happens before the payment", order, ["pay after 1 swap(s)"]);
  check("the payment result is returned", result, "paid");
  check("the swap is reported", (swapped?.satsOut ?? 0n) >= 3_000n, true);
}

{
  const { provider } = mockProvider();
  try {
    await payFromStable(provider, {
      neededSats: 3_000n,
      btcAvailable: 0n,
      usdbAvailable: 100_000_000n,
      pay: async () => {
        throw new Error("no route");
      },
    });
    failures++;
    console.log("FAIL a failed payment after a swap did not throw");
  } catch (e) {
    check("a payment failing after the swap names the sats now held", e instanceof StableError ? e.code : String(e), "paid-after-swap-failed");
    check("and carries the amount", e instanceof StableError && (e.satsHeld ?? 0n) >= 3_000n, true);
  }
}

{
  const { provider, calls } = mockProvider({ failSwap: true });
  let paid = false;
  try {
    await payFromStable(provider, {
      neededSats: 3_000n,
      btcAvailable: 0n,
      usdbAvailable: 100_000_000n,
      pay: async () => {
        paid = true;
      },
    });
  } catch (e) {
    check("a failed swap throws swap-failed", e instanceof StableError ? e.code : String(e), "swap-failed");
  }
  check("and the payment is never attempted", paid, false);
  check("exactly one swap was tried", calls.filter((c) => c.kind === "swap").length, 1);
}

// --- rebalancing between the two balances ----------------------------------------

check(
  "setting bitcoin lower spends exactly the difference in sats",
  planRebalance("btc", 4_000n, { sats: 10_000n, usdbUnits: 0n }),
  { kind: "exact-in", direction: "toStable", amountIn: 6_000n },
);
check(
  "setting bitcoin higher asks for exactly the difference out",
  planRebalance("btc", 12_000n, { sats: 10_000n, usdbUnits: 50_000_000n }),
  { kind: "exact-out", direction: "toBitcoin", amountOut: 2_000n },
);
check(
  "setting USD lower spends exactly the difference in USD",
  planRebalance("usd", 1_000_000n, { sats: 0n, usdbUnits: 3_000_000n }),
  { kind: "exact-in", direction: "toBitcoin", amountIn: 2_000_000n },
);
check(
  "setting USD higher asks for exactly the difference out",
  planRebalance("usd", 5_000_000n, { sats: 10_000n, usdbUnits: 3_000_000n }),
  { kind: "exact-out", direction: "toStable", amountOut: 2_000_000n },
);
check("an unchanged figure is nothing to do", planRebalance("btc", 10n, { sats: 10n, usdbUnits: 0n }), { kind: "none" });
check(
  "a negative figure clamps to zero",
  planRebalance("btc", -5n, { sats: 900n, usdbUnits: 0n }),
  { kind: "exact-in", direction: "toStable", amountIn: 900n },
);

{
  const { provider, calls } = mockProvider();
  const current = { sats: 0n, usdbUnits: 100_000_000n };
  const r = await executeRebalance(provider, planRebalance("btc", 5_000n, current), current);
  check("an exact bitcoin figure converts", r.status, "converted");
  check("and delivers at least that many sats", r.status === "converted" && r.amountOut >= 5_000n, true);
  check("in a single swap", calls.filter((c) => c.kind === "swap").length, 1);
}

{
  const { provider } = mockProvider();
  const current = { sats: 10_000n, usdbUnits: 0n };
  const r = await executeRebalance(provider, planRebalance("usd", 5_000_000n, current), current);
  check("an exact USD figure converts from sats", r.status, "converted");
  check("and delivers at least $5", r.status === "converted" && r.amountOut >= 5_000_000n, true);
  check("without spending more sats than exist", r.status === "converted" && r.amountIn <= 10_000n, true);
}

{
  const { provider } = mockProvider();
  const current = { sats: 1_000n, usdbUnits: 0n };
  const r = await executeRebalance(provider, planRebalance("usd", 50_000_000n, current), current);
  check("a USD figure the bitcoin cannot reach fails without throwing", r.status, "failed");
}

{
  const { provider, calls } = mockProvider();
  const current = { sats: 10_000n, usdbUnits: 0n };
  const r = await executeRebalance(provider, planRebalance("btc", 4_000n, current), current);
  check("an exact-input rebalance swaps exactly the difference", calls.find((c) => c.kind === "swap")?.amountIn, 6_000n);
  check("and reports its direction", r.direction, "toStable");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
