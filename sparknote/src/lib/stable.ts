/**
 * Stable balance — the arithmetic and the decisions, with no network code.
 *
 * Behaviour follows Breez's Stable Balance: hold USDB instead of bitcoin,
 * convert incoming sats on arrival, and convert back just in time to pay.
 * Breez's SDK itself is not used, because it requires a Breez API key and this
 * wallet's one hard rule is that there are no API keys. Conversions go through
 * Flashnet's AMM instead, which authenticates by wallet signature (see
 * flashnet.ts). Everything here talks to a `SwapProvider`, so the logic is
 * tested without either.
 *
 * USDB is a dollar token issued by Brale on Spark. Holding it means trusting
 * Brale's redemption the way holding any dollar stablecoin does — it is not
 * self-custodial bitcoin, and the UI says so.
 */

export const USDB_DECIMALS = 6;

export const USDB_TOKEN = {
  MAINNET: {
    identifier: "btkn1xgrvjwey5ngcagvap2dzzvsy4uk8ua9x69k82dwvt5e7ef9drm9qztux87",
    hex: "3206c93b24a4d18ea19d0a9a213204af2c7e74a6d16c7535cc5d33eca4ad1eca",
    ticker: "USDB",
    decimals: USDB_DECIMALS,
  },
  /** No USD stablecoin has AMM liquidity on regtest. */
  REGTEST: null,
} as const;

export type StableNetwork = keyof typeof USDB_TOKEN;

export function stableSupported(network: StableNetwork): boolean {
  return USDB_TOKEN[network] !== null;
}

/**
 * Slippage allowed on every swap. Breez defaults to 10 bps; 50 leaves room for a
 * quote to move between simulate and execute without being loose enough to
 * matter on a deep pool.
 */
export const DEFAULT_SLIPPAGE_BPS = 50;

export type SwapDirection = "toStable" | "toBitcoin";

export interface SwapMinimums {
  /** Smallest bitcoin swap the AMM accepts, in sats. */
  btcSats: bigint;
  /** Smallest USDB swap, in base units (1e-6 USD). */
  usdbUnits: bigint;
}

export interface SwapProvider {
  minimums(): Promise<SwapMinimums>;
  /** Quoted output for an exact input: sats in → USDB units out, or the reverse. */
  quote(direction: SwapDirection, amountIn: bigint): Promise<bigint>;
  swap(direction: SwapDirection, amountIn: bigint, minAmountOut: bigint): Promise<{ amountOut: bigint }>;
}

export class StableError extends Error {
  readonly code: "insufficient-stable" | "insufficient-bitcoin" | "below-minimum" | "swap-failed" | "paid-after-swap-failed";
  readonly satsHeld?: bigint;
  constructor(code: StableError["code"], message: string, satsHeld?: bigint) {
    super(message);
    this.code = code;
    this.satsHeld = satsHeld;
  }
}

/** "$1,234.56", floored to the cent so a balance is never overstated. */
export function formatUsd(units: bigint, decimals: number = USDB_DECIMALS): string {
  const negative = units < 0n;
  const abs = negative ? -units : units;
  const cents = decimals >= 2 ? abs / 10n ** BigInt(decimals - 2) : abs * 10n ** BigInt(2 - decimals);
  const dollars = cents / 100n;
  const rem = cents % 100n;
  return `${negative ? "-" : ""}$${dollars.toLocaleString("en-US")}.${rem.toString().padStart(2, "0")}`;
}

/**
 * Values sats in USD at a rate of `unitsPerSat`, for display only.
 *
 * Deliberately not used for anything that moves money. A past payment is being
 * valued at today's price, which is an approximation and is marked as one
 * wherever it is shown; the actual amount that moved was, and remains, the sats.
 */
export function satsToUsdUnits(sats: number, unitsPerSat: number): bigint {
  if (!Number.isFinite(sats) || !Number.isFinite(unitsPerSat) || unitsPerSat <= 0) return 0n;
  return BigInt(Math.max(0, Math.round(sats * unitsPerSat)));
}

export function withSlippage(amountOut: bigint, bps: number = DEFAULT_SLIPPAGE_BPS): bigint {
  return (amountOut * BigInt(10_000 - bps)) / 10_000n;
}

export type ConvertResult =
  | {
      status: "converted";
      amountIn: bigint;
      amountOut: bigint;
      /**
       * Input-asset balance left behind because it is below the AMM's minimum,
       * i.e. change. Only set when the remainder is too small to convert — a
       * remainder the user deliberately kept back (a partial rebalance) is not
       * change and is left undefined.
       */
      change?: bigint;
    }
  | { status: "skipped"; reason: "nothing" | "below-minimum" | "quote-failed"; detail?: string }
  | { status: "failed"; error: string };

/**
 * The part of `available` that cannot follow `amountIn` through the swap.
 *
 * Returns undefined when nothing is left over, or when what is left is large
 * enough to convert on its own — that is a balance, not change.
 */
function changeLeftBy(available: bigint | undefined, amountIn: bigint, minimum: bigint): bigint | undefined {
  if (available === undefined) return undefined;
  const leftover = available - amountIn;
  return leftover > 0n && leftover < minimum ? leftover : undefined;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function convert(
  provider: SwapProvider,
  direction: SwapDirection,
  amountIn: bigint,
  bps: number,
  /** Total input-asset balance, when known, so any unconvertible remainder can be reported as change. */
  available?: bigint,
): Promise<ConvertResult> {
  if (amountIn <= 0n) return { status: "skipped", reason: "nothing" };

  let minimum: bigint;
  try {
    const m = await provider.minimums();
    minimum = direction === "toStable" ? m.btcSats : m.usdbUnits;
  } catch (e) {
    return { status: "skipped", reason: "quote-failed", detail: message(e) };
  }
  if (amountIn < minimum) return { status: "skipped", reason: "below-minimum", detail: `minimum is ${minimum}` };

  let quoted: bigint;
  try {
    quoted = await provider.quote(direction, amountIn);
  } catch (e) {
    return { status: "skipped", reason: "quote-failed", detail: message(e) };
  }
  if (quoted <= 0n) return { status: "skipped", reason: "quote-failed", detail: "quoted output is zero" };

  try {
    const r = await provider.swap(direction, amountIn, withSlippage(quoted, bps));
    const change = changeLeftBy(available, amountIn, minimum);
    return { status: "converted", amountIn, amountOut: r.amountOut, ...(change === undefined ? {} : { change }) };
  } catch (e) {
    return { status: "failed", error: message(e) };
  }
}

/**
 * Converts sats to USDB — the path for an incoming payment in whole-balance
 * mode and for "move to USD" in separate mode.
 *
 * "Convert every payment unless the swap would fail": anything below the AMM's
 * minimum, or that cannot be quoted, is left as bitcoin rather than attempted.
 * It never throws.
 */
export function convertToStable(
  provider: SwapProvider,
  sats: bigint,
  bps = DEFAULT_SLIPPAGE_BPS,
  availableSats?: bigint,
) {
  return convert(provider, "toStable", sats, bps, availableSats);
}

export function convertToBitcoin(
  provider: SwapProvider,
  usdbUnits: bigint,
  bps = DEFAULT_SLIPPAGE_BPS,
  availableUnits?: bigint,
) {
  return convert(provider, "toBitcoin", usdbUnits, bps, availableUnits);
}

/* ------------------------------------------------------------------ */
/* Recovering a USD balance that is too small to swap                  */
/* ------------------------------------------------------------------ */

/**
 * The AMM refuses any swap below a published minimum, so a USD balance under
 * that figure cannot be converted back to bitcoin at all. Converting to USD and
 * back leaves exactly this: a remainder too small to move, stuck for good.
 *
 * It is a trap the obvious remedy does not spring. Adding bitcoin to the wallet
 * changes nothing, because a USD to bitcoin swap only looks at the USD side —
 * the remainder is still under the minimum. The only way out is to convert a
 * little bitcoin *into* USD first, so the total clears the minimum, and then
 * sweep the whole lot back.
 *
 * That is two swaps and two lots of fees to rescue a small amount, so it is
 * never done automatically. The plan exists to be shown to the user, with its
 * cost, before they decide the remainder is worth recovering.
 */
export type SweepPlan =
  /** No USD to move. */
  | { kind: "nothing" }
  /** The balance already clears the minimum; one swap does it. */
  | { kind: "direct"; usdbIn: bigint }
  /** Under the minimum: bitcoin must be converted in first. */
  | { kind: "top-up"; usdbIn: bigint; minimum: bigint; shortfall: bigint; topUpSats: bigint }
  /** Under the minimum and the wallet cannot cover the top-up. */
  | { kind: "stuck"; usdbIn: bigint; minimum: bigint; shortfall: bigint; reason: string };

/**
 * Headroom on the top-up, in hundredths of a percent.
 *
 * The two legs are separate swaps against a live pool. Buying exactly the
 * shortfall risks landing a hair under the minimum if the price moves between
 * them, which would strand the balance again — the precise failure being fixed.
 */
const TOP_UP_HEADROOM_BPS = 300n;

export async function planStableSweep(
  provider: SwapProvider,
  args: { usdbAvailable: bigint; btcAvailable: bigint; slippageBps?: number },
): Promise<SweepPlan> {
  const { usdbAvailable, btcAvailable } = args;
  const bps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  if (usdbAvailable <= 0n) return { kind: "nothing" };

  const minimum = (await provider.minimums()).usdbUnits;
  if (usdbAvailable >= minimum) return { kind: "direct", usdbIn: usdbAvailable };

  const shortfall = minimum - usdbAvailable;
  const target = shortfall + (shortfall * TOP_UP_HEADROOM_BPS) / 10_000n + 1n;

  try {
    const { amountIn } = await amountInForOut(provider, "toStable", target, btcAvailable, bps);
    return { kind: "top-up", usdbIn: usdbAvailable, minimum, shortfall, topUpSats: amountIn };
  } catch (e) {
    return {
      kind: "stuck",
      usdbIn: usdbAvailable,
      minimum,
      shortfall,
      reason:
        e instanceof StableError
          ? e.message
          : `There is not enough bitcoin to convert ${shortfall} USD units first.`,
    };
  }
}

export interface SweepResult {
  /** USD converted to bitcoin in the final swap. */
  usdbIn: bigint;
  satsOut: bigint;
  /** The first leg, when one was needed. Its cost is part of what this sweep took. */
  toppedUp: null | { sats: bigint; usdbOut: bigint };
}

/**
 * Moves the whole USD balance back to bitcoin, converting bitcoin in first if
 * the balance is under the AMM's minimum.
 *
 * Not atomic, and it does not pretend to be. If the top-up succeeds and the
 * sweep then fails, the error says so exactly: the USD balance went *up*, the
 * bitcoin spent on the top-up is in USD now, and retrying is what recovers it.
 * Reporting that plainly is worth more than a rollback that cannot be trusted.
 */
export async function sweepStableToBitcoin(
  provider: SwapProvider,
  args: {
    usdbAvailable: bigint;
    btcAvailable: bigint;
    slippageBps?: number;
    /**
     * Reads the USD balance again after the top-up settles. The operators are
     * authoritative; without this the second leg would swap an amount derived
     * from a quote rather than from the balance that actually exists.
     */
    usdbAfterTopUp?: () => Promise<bigint>;
  },
): Promise<SweepResult> {
  const bps = args.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
  const plan = await planStableSweep(provider, args);

  if (plan.kind === "nothing") throw new StableError("insufficient-stable", "There is no USD to convert.");
  if (plan.kind === "stuck") throw new StableError("below-minimum", plan.reason);

  let toppedUp: SweepResult["toppedUp"] = null;
  let usdbIn = plan.usdbIn;

  if (plan.kind === "top-up") {
    let quoted: bigint;
    try {
      quoted = await provider.quote("toStable", plan.topUpSats);
    } catch (e) {
      throw new StableError("swap-failed", `Could not price the bitcoin to convert first: ${message(e)}`);
    }
    try {
      const r = await provider.swap("toStable", plan.topUpSats, withSlippage(quoted, bps));
      toppedUp = { sats: plan.topUpSats, usdbOut: r.amountOut };
      usdbIn = plan.usdbIn + r.amountOut;
    } catch (e) {
      throw new StableError("swap-failed", `Could not convert bitcoin to USD first: ${message(e)}`);
    }

    if (args.usdbAfterTopUp) {
      try {
        const settled = await args.usdbAfterTopUp();
        // Only trust it if it is at least what we expect; a lagging read must
        // not shrink the sweep and re-strand the remainder.
        if (settled >= usdbIn) usdbIn = settled;
      } catch {
        /* the estimate above stands */
      }
    }
  }

  const result = await convert(provider, "toBitcoin", usdbIn, bps, usdbIn);
  if (result.status === "converted") {
    return { usdbIn: result.amountIn, satsOut: result.amountOut, toppedUp };
  }

  const detail =
    result.status === "failed"
      ? result.error
      : result.reason === "below-minimum"
        ? "it is still below the smallest amount the pool will swap"
        : (result.detail ?? result.reason);

  if (toppedUp) {
    throw new StableError(
      "paid-after-swap-failed",
      `${toppedUp.sats} sats were converted to USD first, but the sweep back then failed: ${detail}. ` +
        `That bitcoin is in your USD balance now, which is larger than before — try the sweep again.`,
    );
  }
  throw new StableError("swap-failed", `Could not convert USD to bitcoin: ${detail}`);
}

/**
 * The smallest input whose slippage-adjusted quote still yields at least
 * `targetOut`, in either direction.
 *
 * The AMM only quotes exact-input swaps, so this searches. A linear estimate
 * from the full-balance quote lands close, then bisection narrows it; the
 * search stops once the bracket is within 0.01%, overshooting by at most that.
 */
export async function amountInForOut(
  provider: SwapProvider,
  direction: SwapDirection,
  targetOut: bigint,
  availableIn: bigint,
  bps = DEFAULT_SLIPPAGE_BPS,
): Promise<{ amountIn: bigint; minOut: bigint }> {
  const m = await provider.minimums();
  const minimum = direction === "toBitcoin" ? m.usdbUnits : m.btcSats;
  const out = async (amount: bigint) => withSlippage(await provider.quote(direction, amount), bps);
  const code = direction === "toBitcoin" ? "insufficient-stable" : "insufficient-bitcoin";
  const what = direction === "toBitcoin" ? "USD" : "bitcoin";

  if (availableIn < minimum) {
    throw new StableError(code, `The ${what} balance is below the smallest amount that can be converted.`);
  }
  const fullOut = await out(availableIn);
  if (fullOut < targetOut) {
    throw new StableError(code, `The ${what} balance is not enough for that.`);
  }
  if ((await out(minimum)) >= targetOut) return { amountIn: minimum, minOut: await out(minimum) };

  let lo = minimum; // known too small
  let hi = availableIn; // known enough

  // Linear estimate with a hair of headroom, clamped into the bracket.
  const guess = (targetOut * availableIn * 1_002n) / (fullOut * 1_000n);
  if (guess > lo && guess < hi) {
    if ((await out(guess)) >= targetOut) hi = guess;
    else lo = guess;
  }

  while (hi - lo > 1n && (hi - lo) * 10_000n > hi) {
    const mid = (lo + hi) / 2n;
    if ((await out(mid)) >= targetOut) hi = mid;
    else lo = mid;
  }
  return { amountIn: hi, minOut: await out(hi) };
}

/** The smallest USDB input that yields at least `targetSats` after slippage. */
export async function usdbNeededForSats(
  provider: SwapProvider,
  targetSats: bigint,
  availableUsdb: bigint,
  bps = DEFAULT_SLIPPAGE_BPS,
): Promise<{ amountIn: bigint; minSatsOut: bigint }> {
  try {
    const r = await amountInForOut(provider, "toBitcoin", targetSats, availableUsdb, bps);
    return { amountIn: r.amountIn, minSatsOut: r.minOut };
  } catch (e) {
    if (e instanceof StableError && e.message.endsWith("not enough for that.")) {
      throw new StableError("insufficient-stable", "The USD balance is not enough to cover this payment.");
    }
    throw e;
  }
}

/* ------------------------------------------------------------------ */
/* Rebalancing between the two balances (separate mode)                */
/* ------------------------------------------------------------------ */

/**
 * What to swap so one side of the balance lands on an exact figure.
 *
 * The side being set is the anchor. When the anchor shrinks, the swap spends
 * exactly the difference from it (exact input), so it lands exactly. When the
 * anchor grows, the AMM cannot deliver an exact output, so the smallest input
 * from the other side that still delivers the difference is searched for; it
 * lands on the figure or overshoots it by at most 0.01%.
 */
export type RebalancePlan =
  | { kind: "none" }
  | { kind: "exact-in"; direction: SwapDirection; amountIn: bigint }
  | { kind: "exact-out"; direction: SwapDirection; amountOut: bigint };

export function planRebalance(
  anchor: "btc" | "usd",
  target: bigint,
  current: { sats: bigint; usdbUnits: bigint },
): RebalancePlan {
  const t = target < 0n ? 0n : target;
  if (anchor === "btc") {
    if (t === current.sats) return { kind: "none" };
    return t < current.sats
      ? { kind: "exact-in", direction: "toStable", amountIn: current.sats - t }
      : { kind: "exact-out", direction: "toBitcoin", amountOut: t - current.sats };
  }
  if (t === current.usdbUnits) return { kind: "none" };
  return t < current.usdbUnits
    ? { kind: "exact-in", direction: "toBitcoin", amountIn: current.usdbUnits - t }
    : { kind: "exact-out", direction: "toStable", amountOut: t - current.usdbUnits };
}

/** Runs a rebalance plan. Never throws; the result says what happened. */
export async function executeRebalance(
  provider: SwapProvider,
  plan: RebalancePlan,
  current: { sats: bigint; usdbUnits: bigint },
  bps = DEFAULT_SLIPPAGE_BPS,
): Promise<ConvertResult & { direction?: SwapDirection }> {
  if (plan.kind === "none") return { status: "skipped", reason: "nothing" };
  if (plan.kind === "exact-in") {
    const held = plan.direction === "toBitcoin" ? current.usdbUnits : current.sats;
    return {
      ...(await convert(provider, plan.direction, plan.amountIn, bps, held)),
      direction: plan.direction,
    };
  }
  const available = plan.direction === "toBitcoin" ? current.usdbUnits : current.sats;
  let found: { amountIn: bigint; minOut: bigint };
  try {
    found = await amountInForOut(provider, plan.direction, plan.amountOut, available, bps);
  } catch (e) {
    return { status: "failed", error: message(e), direction: plan.direction };
  }
  try {
    const r = await provider.swap(plan.direction, found.amountIn, found.minOut);
    // An exact-out swap takes only what the target needed; whatever is left is
    // change only if it is too small to convert on its own.
    let change: bigint | undefined;
    try {
      const m = await provider.minimums();
      const minimum = plan.direction === "toBitcoin" ? m.usdbUnits : m.btcSats;
      change = changeLeftBy(available, found.amountIn, minimum);
    } catch {
      // The swap already succeeded; not being able to name the leftover is not
      // a reason to report the conversion as failed.
    }
    return {
      status: "converted",
      amountIn: found.amountIn,
      amountOut: r.amountOut,
      ...(change === undefined ? {} : { change }),
      direction: plan.direction,
    };
  } catch (e) {
    return { status: "failed", error: message(e), direction: plan.direction };
  }
}

export interface PayFromStablePlan {
  /** null when the bitcoin already in the wallet covers the payment. */
  swap: null | { usdbIn: bigint; minSatsOut: bigint; shortfallSats: bigint };
}

/** Works out whether a payment needs USDB converted first, and how much. */
export async function planPayFromStable(
  provider: SwapProvider,
  args: { neededSats: bigint; btcAvailable: bigint; usdbAvailable: bigint; slippageBps?: number },
): Promise<PayFromStablePlan> {
  const shortfall = args.neededSats - args.btcAvailable;
  if (shortfall <= 0n) return { swap: null };
  const r = await usdbNeededForSats(provider, shortfall, args.usdbAvailable, args.slippageBps ?? DEFAULT_SLIPPAGE_BPS);
  return { swap: { usdbIn: r.amountIn, minSatsOut: r.minSatsOut, shortfallSats: shortfall } };
}

/**
 * Pays in bitcoin from a USD balance: swap exactly enough USDB to sats, then
 * run the ordinary payment.
 *
 * If the payment fails after the swap succeeded, the converted sats are still
 * in the wallet as bitcoin — nothing is lost, but it is not USD any more. That
 * case throws a distinct error carrying the amount, so the UI can say so rather
 * than implying the money vanished.
 */
export async function payFromStable<T>(
  provider: SwapProvider,
  args: {
    neededSats: bigint;
    btcAvailable: bigint;
    usdbAvailable: bigint;
    slippageBps?: number;
    pay: () => Promise<T>;
    /**
     * Waits until the swapped sats are actually spendable, after the swap and
     * before the payment.
     *
     * The swap call returning does not mean the bitcoin is ready to spend: the
     * operators still have to settle it into leaves the wallet can select. Pay
     * in that gap and the SDK refuses with "Total target amount exceeds
     * available balance", having converted the USD but sent nothing — which
     * looks like the wallet cannot pay from a balance it visibly holds.
     */
    settle?: (minSats: bigint) => Promise<void>;
  },
): Promise<{ result: T; swapped: null | { usdbIn: bigint; satsOut: bigint } }> {
  const plan = await planPayFromStable(provider, args);

  let swapped: null | { usdbIn: bigint; satsOut: bigint } = null;
  if (plan.swap) {
    try {
      const r = await provider.swap("toBitcoin", plan.swap.usdbIn, plan.swap.minSatsOut);
      swapped = { usdbIn: plan.swap.usdbIn, satsOut: r.amountOut };
    } catch (e) {
      throw new StableError("swap-failed", `Could not convert USD to bitcoin: ${message(e)}`);
    }
  }

  if (swapped && args.settle) {
    // Its own failure is not the payment's failure; pay() reports for itself.
    try {
      await args.settle(args.neededSats);
    } catch {
      /* fall through and let the payment speak */
    }
  }

  try {
    return { result: await args.pay(), swapped };
  } catch (e) {
    if (swapped) {
      throw new StableError(
        "paid-after-swap-failed",
        `The payment failed after ${swapped.satsOut} sats were converted from USD. Those sats are still in the wallet, as bitcoin. ${message(e)}`,
        swapped.satsOut,
      );
    }
    throw e;
  }
}
