/**
 * Cooperative exit (on-chain send) helpers.
 *
 * This module exists because getting the fee wrong here is not a cosmetic bug.
 * The SDK validates that the SSP's L1 transaction actually pays the requested
 * address the expected amount — an anti-redirect check. If the fee we declare is
 * lower than the real cost, the SSP covers the difference out of the payout, the
 * payout then falls short of what the SDK expects, and the withdrawal is
 * rejected with:
 *
 *   "SSP cooperative exit transaction does not pay the requested withdrawal
 *    address for the expected amount"
 *
 * The fee has two components and is quoted per speed. Both must be summed, and
 * the speed must match the one passed to withdraw().
 */
import { ExitSpeed } from "@buildonspark/spark-sdk/types";
import type { SparkWallet } from "@buildonspark/spark-sdk";

/**
 * Bitcoin's dust threshold as the SDK defines it. An output below this is not
 * relayed, so a withdrawal paying less than this to the destination cannot
 * confirm and would simply burn the fee.
 */
export const DUST_LIMIT_SATS = 330;

export interface FeeQuote {
  id?: string;
  /** userFee + l1BroadcastFee for the selected speed. */
  totalSats: number;
  userFeeSats: number;
  broadcastFeeSats: number;
  speed: ExitSpeed;
}

/** CurrencyAmount is `{ originalValue, originalUnit }`; sats is the unit used here. */
function amountToSats(v: unknown): number {
  if (typeof v === "object" && v !== null) {
    const o = v as { originalValue?: unknown; originalUnit?: unknown };
    if (typeof o.originalValue === "number") {
      // Defensive: if the SSP ever quotes in millisats, do not silently inflate
      // the fee by 1000x.
      return o.originalUnit === "MILLISATOSHI"
        ? Math.ceil(o.originalValue / 1000)
        : Math.ceil(o.originalValue);
    }
  }
  return 0;
}

/**
 * Reads the per-speed fee out of a CoopExitFeeQuote.
 *
 * Mirrors the SDK's own formula:
 *   feeAmountSats = l1BroadcastFee<Speed>.originalValue + userFee<Speed>.originalValue
 */
export function readFeeQuote(quote: unknown, speed: ExitSpeed): FeeQuote {
  const q = (quote ?? {}) as Record<string, unknown>;
  const suffix =
    speed === ExitSpeed.FAST ? "Fast" : speed === ExitSpeed.SLOW ? "Slow" : "Medium";

  const userFeeSats = amountToSats(q[`userFee${suffix}`]);
  const broadcastFeeSats = amountToSats(q[`l1BroadcastFee${suffix}`]);

  return {
    id: typeof q.id === "string" ? q.id : undefined,
    userFeeSats,
    broadcastFeeSats,
    totalSats: userFeeSats + broadcastFeeSats,
    speed,
  };
}

export async function quoteWithdrawal(
  wallet: SparkWallet,
  onchainAddress: string,
  amountSats: number,
  speed: ExitSpeed,
): Promise<FeeQuote | null> {
  const q = await wallet.getWithdrawalFeeQuote({
    amountSats,
    withdrawalAddress: onchainAddress.trim(),
  });
  if (!q) return null;
  return readFeeQuote(q, speed);
}

export type WithdrawPlan =
  /** Destination receives exactly `amountSats`; the fee is paid from other leaves. */
  | { mode: "exact"; amountSats: number; feeSats: number; receivesSats: number }
  /** Everything goes; the destination receives `amountSats` minus the fee. */
  | { mode: "max"; amountSats: number; feeSats: number; receivesSats: number };

/**
 * Works out what the destination actually receives.
 *
 * "exact"  — the destination gets `amountSats`, and the fee is taken from other
 *            leaves on top. Total cost to the wallet is amount + fee.
 * "max"    — everything goes, and the fee comes out of it, so the destination
 *            gets balance - fee. This is what the SDK calls
 *            `deductFeeFromWithdrawalAmount`, and it is the only honest way to
 *            express "send it all" without leaving a dust remainder behind.
 */
export function planWithdrawal(
  balanceSats: number,
  amountSats: number | "max",
  fee: FeeQuote,
): WithdrawPlan {
  if (amountSats === "max") {
    return {
      mode: "max",
      amountSats: balanceSats,
      feeSats: fee.totalSats,
      receivesSats: Math.max(0, balanceSats - fee.totalSats),
    };
  }
  return { mode: "exact", amountSats, feeSats: fee.totalSats, receivesSats: amountSats };
}

export function validateWithdrawal(
  plan: WithdrawPlan,
  balanceSats: number,
): { ok: true } | { ok: false; reason: string } {
  if (plan.receivesSats < DUST_LIMIT_SATS) {
    return {
      ok: false,
      reason: `The destination would receive ${plan.receivesSats} sats, below Bitcoin's ${DUST_LIMIT_SATS}-sat dust limit. An output that small cannot confirm.`,
    };
  }
  const total = plan.mode === "max" ? balanceSats : plan.amountSats + plan.feeSats;
  if (total > balanceSats) {
    return {
      ok: false,
      reason: `That needs ${total} sats including the ${plan.feeSats}-sat fee, but the balance is ${balanceSats}.`,
    };
  }
  return { ok: true };
}

/**
 * Submits the withdrawal.
 *
 * Three parts of `withdraw()`'s contract are easy to get wrong, and all three
 * are load-bearing:
 *
 *  1. `amountSats` must always be a safe integer. There is no "omit it to send
 *     everything" — a missing value fails `Number.isSafeInteger` before any of
 *     the withdraw-all handling is reached.
 *  2. `feeQuoteId` and `feeAmountSats` are both required, and the fee must be
 *     the sum for the quoted speed (see readFeeQuote).
 *  3. `deductFeeFromWithdrawalAmount` DEFAULTS TO TRUE. Leaving it out means
 *     the destination silently receives `amountSats - fee`, not `amountSats`.
 *     It is passed explicitly here in both directions so the figure shown on
 *     the confirm screen is the figure that actually arrives.
 */
export async function submitWithdrawal(
  wallet: SparkWallet,
  onchainAddress: string,
  plan: WithdrawPlan,
  fee: FeeQuote,
) {
  if (!fee.id) {
    throw new Error("The fee quote expired before the withdrawal was submitted. Get a new quote.");
  }

  return wallet.withdraw({
    onchainAddress: onchainAddress.trim(),
    exitSpeed: fee.speed,
    amountSats: plan.amountSats,
    feeQuoteId: fee.id,
    feeAmountSats: fee.totalSats,
    // max: take the fee out of the amount, emptying the wallet.
    // exact: the destination gets the full amount, fee paid from other leaves.
    deductFeeFromWithdrawalAmount: plan.mode === "max",
  });
}
