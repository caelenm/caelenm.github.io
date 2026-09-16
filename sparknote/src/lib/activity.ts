/**
 * The activity list, as the user sees it.
 *
 * The SDK only knows about Spark transfers, so bitcoin sent to the static
 * deposit address is invisible to `getTransfers` until it has been claimed —
 * which is precisely the window in which the user most wants to see it. It has
 * arrived, it is theirs, and it needs an action from them.
 *
 * So the list is a merge of two sources: settled Spark activity from the
 * operators, and unclaimed deposits observed on-chain. Deposits are not written
 * into the activity cache; they are derived on each render from live state, so
 * a claimed deposit cannot linger as a stale row.
 */
import type { CachedActivity } from "./db.ts";
import { DEPOSIT_CONFIRMATIONS } from "./deposits.ts";

export interface DepositLike {
  txid: string;
  vout: number;
  valueSats: number | null;
  confirmations: number;
  creditSats: number | null;
  quoteError: string | null;
  firstSeenAt: number;
}

export type DepositStage =
  /** Seen on-chain, not yet mined. */
  | "unconfirmed"
  /** Mined, still short of the confirmations a claim needs. */
  | "confirming"
  /** Deep enough and priced — the user can claim it. */
  | "claimable"
  /** Deep enough, but the SSP will not price it yet. */
  | "unquoted";

export type ActivityRow =
  | { type: "tx"; id: string; tx: CachedActivity; time: number }
  | { type: "deposit"; id: string; deposit: DepositLike; stage: DepositStage; time: number };

export function depositStage(d: DepositLike): DepositStage {
  if (d.confirmations === 0) return "unconfirmed";
  if (d.confirmations < DEPOSIT_CONFIRMATIONS) return "confirming";
  return d.creditSats === null ? "unquoted" : "claimable";
}

/** The SSP's cut: what arrived on-chain, less what it will credit. */
export function depositFee(d: DepositLike): number | null {
  return d.valueSats === null || d.creditSats === null ? null : d.valueSats - d.creditSats;
}

/**
 * Whether a deposit may be claimed without asking the user.
 *
 * Deliberately conservative — every uncertainty answers "no":
 *   - the feature must be switched on;
 *   - the deposit must be claimable, not merely confirmed;
 *   - the fee must be *known*, because a ceiling cannot be applied to an
 *     unknown number;
 *   - the fee must be within the ceiling, so a spike is never paid unattended.
 *
 * A negative fee (the SSP crediting more than arrived) is not treated as a
 * bargain: it means something is wrong with the quote, so it waits for a person.
 */
export function autoClaimable(
  d: DepositLike,
  opts: { enabled: boolean; maxFeeSats: number },
): boolean {
  if (!opts.enabled) return false;
  if (depositStage(d) !== "claimable") return false;
  const fee = depositFee(d);
  if (fee === null || fee < 0) return false;
  return fee <= opts.maxFeeSats;
}

/** One line describing where the deposit has got to. */
export function describeDeposit(d: DepositLike): string {
  switch (depositStage(d)) {
    case "unconfirmed":
      return "Waiting for its first confirmation";
    case "confirming":
      return `${d.confirmations} of ${DEPOSIT_CONFIRMATIONS} confirmations`;
    case "claimable":
      return "Ready to claim";
    case "unquoted":
      return d.quoteError ? `Confirmed — no quote yet: ${d.quoteError}` : "Confirmed — waiting for a quote";
  }
}

/**
 * Kinds that were positively identified. "spark" and "unknown" are what a row
 * falls back to when nothing identified it, so they are absence of knowledge,
 * not knowledge of absence.
 */
const IDENTIFIED = new Set<CachedActivity["kind"]>(["lightning", "onchain", "swap", "internal"]);

/** The pools this wallet has swapped with, recovered from rows already known to be swaps. */
export function poolIdsIn(activity: readonly CachedActivity[]): string[] {
  return activity.flatMap((a) => (a.kind === "swap" && a.counterparty ? [a.counterparty] : []));
}

/**
 * Carries a known classification forward onto a freshly fetched row.
 *
 * What a transfer *was* cannot change — a swap does not become a payment — but
 * how well this wallet can recognise it does, because recognising a swap needs
 * the pool's identity and that is learned at runtime. Re-fetching with that
 * knowledge missing used to overwrite a correct "Swap" row with "Sent", and
 * then persist the downgrade to the cache, so a reload could permanently
 * relabel a swap as money leaving the wallet.
 *
 * So classification is only ever allowed to improve: an identified kind is kept
 * unless the fresh row identifies one too. Everything else — status, amount,
 * timestamps — still comes from the operators, which remain the authority on
 * anything that genuinely changes.
 */
export function reconcileActivity(
  fresh: readonly CachedActivity[],
  previous: readonly CachedActivity[],
): CachedActivity[] {
  if (!previous.length) return [...fresh];
  const before = new Map(previous.map((a) => [a.id, a]));
  return fresh.map((row) => {
    if (IDENTIFIED.has(row.kind)) return row;
    const old = before.get(row.id);
    if (!old || !IDENTIFIED.has(old.kind)) return row;
    return {
      ...row,
      kind: old.kind,
      ...(old.swapDirection ? { swapDirection: old.swapDirection } : {}),
    };
  });
}

/**
 * Merges deposits into the activity list, newest first, with anything the user
 * can act on pulled to the top.
 *
 * A claimable deposit outranks everything: it is the only row in the list that
 * is waiting on the user rather than reporting what already happened.
 */
export function mergeActivity(activity: CachedActivity[], deposits: DepositLike[]): ActivityRow[] {
  const rows: ActivityRow[] = [
    ...activity.map((tx): ActivityRow => ({ type: "tx", id: tx.id, tx, time: tx.time })),
    ...deposits.map((deposit): ActivityRow => ({
      type: "deposit",
      id: `deposit:${deposit.txid}:${deposit.vout}`,
      deposit,
      stage: depositStage(deposit),
      time: deposit.firstSeenAt,
    })),
  ];

  const rank = (r: ActivityRow) => (r.type === "deposit" && r.stage === "claimable" ? 0 : 1);
  return rows.sort((a, b) => rank(a) - rank(b) || b.time - a.time);
}
