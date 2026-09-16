/**
 * Unilateral exit as a bundle of pre-signed transactions.
 *
 * The wallet does the part only it can do (holding keys, knowing the leaves,
 * signing) and hands you a file. You broadcast it yourself, step by step, from
 * mempool.space/tx/push or your own mempool instance. Nothing about finishing
 * the exit depends on this app, on the Spark operators, or on a tab staying
 * open.
 *
 * Why a separate "fee coin" is needed at all: every transaction Spark pre-signs
 * for an exit pays zero fee and carries a zero-value anchor output. Bitcoin
 * will only mine it alongside a child transaction that spends that anchor and
 * pays the fee for both (a v3 "package", CPFP). The child needs real bitcoin
 * that is not inside Spark — so you send a small payment to an ordinary address
 * derived from your own recovery phrase, and every child is pre-signed against
 * it:
 *
 *   fee coin → child 1 → change → child 2 → change → … → returned to you
 *
 * Each child spends the previous child's change, so the tree steps go out one
 * per block, in order. TRUC (v3) policy requires that anyway: a package cannot
 * build on another unconfirmed package.
 *
 * The last transaction of each leaf is different. Its child spends the refund's
 * own output together with the anchor, pays the fee out of the leaf itself, and
 * sends the rest straight to your destination. So the final step of every leaf
 * needs no fee coin and does not wait on any other leaf.
 *
 * Only leaves worth exiting are included: a leaf goes in when what reaches you,
 * after its share of fees, is at least the dust limit. Ancestors shared with an
 * included leaf are paid for once, which can make a smaller leaf worth it.
 */
import * as btc from "@scure/btc-signer";
import type { HDKey } from "@scure/bip32";
import { DUST_LIMIT_SATS } from "./onchain.ts";
import {
  bitcoinNetwork,
  buildSweep,
  deriveFeeKey,
  deriveLeafKey,
  EXPLORER_URL,
  feeKeyAddress,
  feeKeyScript,
  fromHex,
  leafRefundScript,
  parseTx,
  relativeBlockLock,
  signFeeBumpPsbt,
  toHex,
  txidOf,
  type ConfirmedUtxo,
  type ExitNetwork,
  type ExitNode,
  type SdkUtxo,
} from "./unilateral.ts";

/** Change below this is refused, matching the SDK's own fee-bump selection margin. */
export const MIN_CHANGE_SATS = 546;
/** The SDK's size estimate for a fee-bump child with one funding input (estimateFeeBumpTxSize). */
export const CPFP_CHILD_VBYTES = 151;
/** A one-input P2WPKH spend to a taproot output, generously rounded. */
const RETURN_TX_VBYTES = 112;

export class BundleError extends Error {}

/* ------------------------------------------------------------------ */
/* capture                                                             */
/* ------------------------------------------------------------------ */

export interface CapturedNode {
  id: string;
  parentNodeId?: string;
  status?: string;
  value: number;
  nodeTx: string;
  refundTx: string;
}

/** What the operators said the wallet's leaves were, frozen at one moment. */
export interface ExitCapture {
  version: 1;
  network: ExitNetwork;
  capturedAt: number;
  leafIds: string[];
  nodes: CapturedNode[];
}

export function captureFromNodes(network: ExitNetwork, leafIds: string[], nodes: ExitNode[], now = Date.now()): ExitCapture {
  return {
    version: 1,
    network,
    capturedAt: now,
    leafIds: [...leafIds],
    nodes: nodes.map((n) => ({
      id: n.id,
      parentNodeId: n.parentNodeId,
      status: n.status,
      value: n.value,
      nodeTx: toHex(n.nodeTx),
      refundTx: toHex(n.refundTx),
    })),
  };
}

export function nodeMapFromCapture(capture: ExitCapture): Map<string, ExitNode> {
  return new Map(
    capture.nodes.map((n) => [
      n.id,
      {
        id: n.id,
        parentNodeId: n.parentNodeId,
        status: n.status,
        value: n.value,
        nodeTx: fromHex(n.nodeTx),
        refundTx: fromHex(n.refundTx),
      },
    ]),
  );
}

/* ------------------------------------------------------------------ */
/* transaction helpers                                                 */
/* ------------------------------------------------------------------ */

/** Virtual size from the serializations, so it works on transactions this code did not finalize. */
export function vsizeOf(tx: btc.Transaction): number {
  const base = tx.toBytes(true, false).length;
  let full = base;
  try {
    full = tx.toBytes(true, true).length;
  } catch {
    /* no witness data to add */
  }
  return Math.ceil((base * 3 + full) / 4);
}

/** The anchor forms the SDK recognises, including Bitcoin Core 29's pay-to-anchor. */
export function isEphemeralAnchor(script: Uint8Array | undefined, amount: bigint | undefined): boolean {
  if (amount !== 0n || !script) return false;
  const h = toHex(script);
  return h === "51" || h === "0151" || h === "51024e73" || h === "015152014e0173";
}

/** The fee the SDK's constructFeeBumpTx charges for one parent at a rate. */
export function cpfpFeeSats(parentVsize: number, feeRate: number): number {
  return Math.ceil((parentVsize + CPFP_CHILD_VBYTES) * feeRate);
}

export type SweepChild =
  | { ok: true; hex: string; txid: string; amountSats: number; feeSats: number; vsize: number }
  | { ok: false; reason: string };

/**
 * The child that finishes a leaf: spends the refund's output and its anchor
 * together, pays the whole package's fee out of the leaf, and sends the rest
 * to the destination. Signed with the leaf's key (taproot key path).
 */
export function buildRefundSweepChild(opts: {
  refundTx: Uint8Array | string;
  leafKey: HDKey;
  destination: string;
  network: ExitNetwork;
  feeRate: number;
}): SweepChild {
  let refund: btc.Transaction;
  try {
    refund = parseTx(opts.refundTx);
  } catch (e) {
    return { ok: false, reason: `The refund transaction could not be read: ${e instanceof Error ? e.message : e}` };
  }
  const refundTxid = txidOf(refund);
  const script = leafRefundScript(opts.leafKey);
  const scriptHex = toHex(script);

  let vout = -1;
  let amount = 0n;
  let anchor = -1;
  let anchorScript: Uint8Array | undefined;
  for (let i = 0; i < refund.outputsLength; i++) {
    const o = refund.getOutput(i);
    if (vout < 0 && o.script && toHex(o.script) === scriptHex) {
      vout = i;
      amount = o.amount ?? 0n;
    } else if (anchor < 0 && isEphemeralAnchor(o.script, o.amount)) {
      anchor = i;
      anchorScript = o.script;
    }
  }
  if (vout < 0) return { ok: false, reason: "Its refund transaction does not pay this wallet's key for that leaf." };
  if (anchor < 0 || !anchorScript) return { ok: false, reason: "Its refund transaction has no fee anchor." };
  const priv = opts.leafKey.privateKey;
  const pub = opts.leafKey.publicKey;
  if (!priv || !pub) return { ok: false, reason: "The leaf key is not available." };

  const build = (out: bigint): Uint8Array => {
    const outScript = btc.OutScript.encode(btc.Address(bitcoinNetwork(opts.network)).decode(opts.destination));
    const t = new btc.Transaction({ version: 3, allowUnknownInputs: true, allowUnknownOutputs: true, disableScriptCheck: true });
    t.addInput({
      txid: refundTxid,
      index: vout,
      sequence: 0xfffffffd,
      witnessUtxo: { script, amount },
      tapInternalKey: pub.slice(1),
    });
    t.addInput({ txid: refundTxid, index: anchor, sequence: 0xffffffff, witnessUtxo: { script: anchorScript!, amount: 0n } });
    t.addOutput({ script: outScript, amount: out });
    // The taproot signature commits to both prevouts (scripts and amounts),
    // which is why the anchor input carries its witnessUtxo above.
    t.signIdx(priv, 0);
    t.finalizeIdx(0);
    const witness = t.getInput(0).finalScriptWitness;
    if (!witness?.length) throw new Error("the leaf input did not sign");
    // Serialized directly, because the anchor is spent with an empty witness
    // and the library refuses to hold an empty witness on an input.
    const txid = fromHex(refundTxid);
    return btc.RawTx.encode({
      version: 3,
      segwitFlag: true,
      inputs: [
        { txid, index: vout, finalScriptSig: new Uint8Array(), sequence: 0xfffffffd },
        { txid, index: anchor, finalScriptSig: new Uint8Array(), sequence: 0xffffffff },
      ],
      outputs: [{ amount: out, script: outScript }],
      witnesses: [witness, []],
      lockTime: 0,
    });
  };

  try {
    const refundVsize = vsizeOf(refund);
    // Size does not depend on the output amount, so a probe gives the real vsize.
    const vsize = vsizeOf(parseTx(build(amount > 2_000n ? amount - 1_000n : amount)));
    const fee = BigInt(Math.ceil((refundVsize + vsize) * opts.feeRate));
    const out = amount - fee;
    if (out < BigInt(DUST_LIMIT_SATS)) {
      return {
        ok: false,
        reason: `Worth ${amount} sats, but its last step costs ${fee} sats in fees, leaving less than the ${DUST_LIMIT_SATS}-sat dust limit.`,
      };
    }
    const bytes = build(out);
    return { ok: true, hex: toHex(bytes), txid: txidOf(parseTx(bytes)), amountSats: Number(out), feeSats: Number(fee), vsize };
  } catch (e) {
    return { ok: false, reason: `Its last step could not be built: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/** Sends whatever is left at the fee address back to the destination. */
export function buildReturnTx(opts: {
  coins: { txid: string; vout: number; value: number }[];
  feeKey: HDKey;
  destination: string;
  network: ExitNetwork;
  feeRate: number;
}): { ok: true; hex: string; txid: string; amountSats: number; feeSats: number } | { ok: false; reason: string } {
  const priv = opts.feeKey.privateKey;
  if (!priv) return { ok: false, reason: "The fee key is not available." };
  const script = feeKeyScript(opts.feeKey);
  const total = opts.coins.reduce((s, c) => s + BigInt(c.value), 0n);
  const net = bitcoinNetwork(opts.network);
  const build = (out: bigint) => {
    const t = new btc.Transaction();
    for (const c of opts.coins) t.addInput({ txid: c.txid, index: c.vout, witnessUtxo: { script, amount: BigInt(c.value) } });
    t.addOutputAddress(opts.destination, out, net);
    t.sign(priv);
    t.finalize();
    return t;
  };
  try {
    const probe = build(total > 1_000n ? total - 500n : total);
    const fee = BigInt(Math.ceil(vsizeOf(probe) * opts.feeRate));
    const out = total - fee;
    if (out < BigInt(DUST_LIMIT_SATS)) return { ok: false, reason: `Only ${out} sats would be left after the fee.` };
    const final = build(out);
    return { ok: true, hex: final.hex, txid: txidOf(final), amountSats: Number(out), feeSats: Number(fee) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/* ------------------------------------------------------------------ */
/* planning                                                            */
/* ------------------------------------------------------------------ */

export interface TxStatus {
  confirmed: boolean;
  blockHeight?: number;
}

export interface NodePackage {
  nodeId: string;
  nodeHex: string;
  txid: string;
  parentTxid: string;
  /** BIP68 blocks the parent must be buried under before this can be mined. */
  lock: number;
  vsize: number;
  feeSats: number;
  depth: number;
}

export interface RefundPackage {
  leafId: string;
  valueSats: number;
  refundHex: string;
  refundTxid: string;
  /** The leaf's own node transaction, which the refund spends. */
  parentTxid: string;
  lock: number;
  /** The refund is already mined, so only a plain sweep remains. */
  refundConfirmed: boolean;
  sweepHex: string;
  sweepTxid: string;
  receiveSats: number;
  feeSats: number;
}

export interface ExitPlan {
  network: ExitNetwork;
  destination: string;
  feeRate: number;
  capturedAt: number;
  included: { leafId: string; valueSats: number; receiveSats: number; chainFeeSats: number }[];
  excluded: { leafId: string; valueSats: number; reason: string }[];
  /** Fee-chain order: parents before children, untimelocked before timelocked. */
  nodePackages: NodePackage[];
  refunds: RefundPackage[];
  /** Fees paid from the fee coin, in total. */
  chainFeeSats: number;
  /** The smallest single payment to the fee address that funds every step. 0 when none is needed. */
  fundingSats: number;
  /** Sum of what every included leaf delivers, before any returned fee-coin change. */
  receiveSats: number;
  /** Heights already confirmed on-chain for transactions the plan builds on. */
  confirmedHeights: Record<string, number>;
}

type LeafCandidate = {
  leafId: string;
  valueSats: number;
  pending: NodePackage[];
  refund: RefundPackage;
};

/**
 * Works out which leaves are worth exiting and every transaction that has to
 * go out, skipping anything already confirmed. Signs each leaf's final sweep;
 * the fee chain is signed later, once the fee coin exists.
 */
export async function planExit(input: {
  capture: ExitCapture;
  root: HDKey;
  destination: string;
  feeRate: number;
  txStatus(txid: string): Promise<TxStatus>;
  buildChain(leaf: ExitNode, nodeMap: Map<string, ExitNode>): Promise<ExitNode[]>;
}): Promise<ExitPlan> {
  const { capture, root, feeRate } = input;
  const network = capture.network;
  const destination = input.destination.trim();

  try {
    btc.Address(bitcoinNetwork(network)).decode(destination);
  } catch {
    throw new BundleError(`That is not a valid ${network === "MAINNET" ? "Bitcoin" : "regtest"} address.`);
  }
  if (!Number.isFinite(feeRate) || feeRate < 1) throw new BundleError("The fee rate must be at least 1 sat/vB.");

  const map = nodeMapFromCapture(capture);
  const statuses = new Map<string, TxStatus>();
  const status = async (txid: string) => {
    let s = statuses.get(txid);
    if (!s) {
      s = await input.txStatus(txid);
      statuses.set(txid, s);
    }
    return s;
  };

  const excluded: ExitPlan["excluded"] = [];
  const candidates: LeafCandidate[] = [];

  for (const leafId of capture.leafIds) {
    const leaf = map.get(leafId);
    if (!leaf) {
      excluded.push({ leafId, valueSats: 0, reason: "Missing from the captured leaves." });
      continue;
    }
    const chain = await input.buildChain(leaf, map);
    if (!chain.length || chain[chain.length - 1].id !== leafId) {
      excluded.push({ leafId, valueSats: leaf.value, reason: "Not in a state that can be exited." });
      continue;
    }

    const pending: NodePackage[] = [];
    let problem: string | null = null;
    let previousTxid: string | null = null;
    for (let depth = 0; depth < chain.length; depth++) {
      const tx = parseTx(chain[depth].nodeTx);
      const txid = txidOf(tx);
      const first = tx.getInput(0);
      const parentTxid = first.txid ? toHex(first.txid) : "";
      if (depth > 0 && parentTxid !== previousTxid) {
        problem = "Its transactions do not form a chain.";
        break;
      }
      previousTxid = txid;
      if ((await status(txid)).confirmed) continue;
      if (depth === 0 || !pending.length) {
        const parent = await status(parentTxid);
        if (!parent.confirmed) {
          problem = "The transaction its tree is built on is not confirmed.";
          break;
        }
      }
      const vsize = vsizeOf(tx);
      pending.push({
        nodeId: chain[depth].id,
        nodeHex: toHex(chain[depth].nodeTx),
        txid,
        parentTxid,
        lock: relativeBlockLock(first.sequence) ?? 0,
        vsize,
        feeSats: cpfpFeeSats(vsize, feeRate),
        depth,
      });
    }
    if (problem) {
      excluded.push({ leafId, valueSats: leaf.value, reason: problem });
      continue;
    }

    if (!leaf.refundTx.length) {
      excluded.push({ leafId, valueSats: leaf.value, reason: "It has no refund transaction." });
      continue;
    }
    const refundTx = parseTx(leaf.refundTx);
    const refundTxid = txidOf(refundTx);
    const refundInput = refundTx.getInput(0);
    const refundConfirmed = (await status(refundTxid)).confirmed;
    const leafKey = deriveLeafKey(root, leafId);

    let sweep: { hex: string; txid: string; amountSats: number; feeSats: number };
    if (refundConfirmed) {
      const s = buildSweep({ refundTx: leaf.refundTx, leafKey, destination, network, feeRate });
      if (!s.ok) {
        excluded.push({ leafId, valueSats: leaf.value, reason: s.reason });
        continue;
      }
      sweep = s;
    } else {
      const s = buildRefundSweepChild({ refundTx: leaf.refundTx, leafKey, destination, network, feeRate });
      if (!s.ok) {
        excluded.push({ leafId, valueSats: leaf.value, reason: s.reason });
        continue;
      }
      sweep = s;
    }

    candidates.push({
      leafId,
      valueSats: leaf.value,
      pending,
      refund: {
        leafId,
        valueSats: leaf.value,
        refundHex: toHex(leaf.refundTx),
        refundTxid,
        parentTxid: refundInput.txid ? toHex(refundInput.txid) : "",
        lock: relativeBlockLock(refundInput.sequence) ?? 0,
        refundConfirmed,
        sweepHex: sweep.hex,
        sweepTxid: sweep.txid,
        receiveSats: sweep.amountSats,
        feeSats: sweep.feeSats,
      },
    });
  }

  // Economics. Largest first; repeat until nothing changes, because a leaf
  // rejected early can become worth it once a later inclusion has paid for the
  // ancestors it shares.
  const covered = new Set<string>();
  const included: ExitPlan["included"] = [];
  const chosen: LeafCandidate[] = [];
  let remaining = [...candidates].sort((a, b) => b.valueSats - a.valueSats);
  for (let changed = true; changed; ) {
    changed = false;
    for (const c of remaining) {
      const fresh = c.pending.filter((p) => !covered.has(p.txid));
      const chainFeeSats = fresh.reduce((s, p) => s + p.feeSats, 0);
      if (c.refund.receiveSats - chainFeeSats >= DUST_LIMIT_SATS) {
        for (const p of fresh) covered.add(p.txid);
        included.push({ leafId: c.leafId, valueSats: c.valueSats, receiveSats: c.refund.receiveSats, chainFeeSats });
        chosen.push(c);
        changed = true;
      }
    }
    remaining = remaining.filter((c) => !chosen.includes(c));
  }
  for (const c of remaining) {
    const cost = c.refund.feeSats + c.pending.filter((p) => !covered.has(p.txid)).reduce((s, p) => s + p.feeSats, 0);
    excluded.push({
      leafId: c.leafId,
      valueSats: c.valueSats,
      reason: `Not worth it at ${feeRate} sat/vB: about ${cost} sats in fees for a ${c.valueSats}-sat leaf.`,
    });
  }

  // Fee-chain order: a topological sort that prefers untimelocked, shallower
  // transactions, so the long waits come last and do not hold up the rest.
  const byTxid = new Map<string, NodePackage>();
  for (const c of chosen) for (const p of c.pending) byTxid.set(p.txid, p);
  const all = [...byTxid.values()];
  const indegree = new Map(all.map((p) => [p.txid, byTxid.has(p.parentTxid) ? 1 : 0]));
  const rank = (a: NodePackage, b: NodePackage) => (a.lock > 0 ? 1 : 0) - (b.lock > 0 ? 1 : 0) || a.depth - b.depth || a.lock - b.lock || (a.txid < b.txid ? -1 : 1);
  const ready = all.filter((p) => indegree.get(p.txid) === 0).sort(rank);
  const nodePackages: NodePackage[] = [];
  while (ready.length) {
    const next = ready.shift()!;
    nodePackages.push(next);
    for (const p of all) {
      if (p.parentTxid === next.txid) {
        indegree.set(p.txid, 0);
        ready.push(p);
      }
    }
    ready.sort(rank);
  }

  const chainFeeSats = nodePackages.reduce((s, p) => s + p.feeSats, 0);
  const confirmedHeights: Record<string, number> = {};
  for (const [txid, s] of statuses) if (s.confirmed && s.blockHeight !== undefined) confirmedHeights[txid] = s.blockHeight;

  return {
    network,
    destination,
    feeRate,
    capturedAt: capture.capturedAt,
    included,
    excluded,
    nodePackages,
    refunds: chosen.map((c) => c.refund),
    chainFeeSats,
    fundingSats: nodePackages.length ? chainFeeSats + MIN_CHANGE_SATS + Math.ceil(RETURN_TX_VBYTES * feeRate) : 0,
    receiveSats: chosen.reduce((s, c) => s + c.refund.receiveSats, 0),
    confirmedHeights,
  };
}

/* ------------------------------------------------------------------ */
/* signing the bundle                                                  */
/* ------------------------------------------------------------------ */

export interface BundleStep {
  n: number;
  kind: "tree" | "leaf-final" | "sweep" | "return";
  title: string;
  /** Raw transaction hex, in the order to paste. Two means "submit as a package". */
  txs: string[];
  txids: string[];
  /** Every condition that must hold before pasting, in plain words. */
  when: string[];
  /** The transaction to watch on the explorer. */
  watchTxid: string;
  feeSats: number;
  receiveSats?: number;
  /** Blocks of relative timelock this step waits out, for rough timing. */
  lock: number;
}

export interface ExitBundle {
  plan: ExitPlan;
  createdAt: number;
  feeAddress: string;
  feeCoin: ConfirmedUtxo | null;
  steps: BundleStep[];
  /** Sats returned from the fee address at the end, or left there if too few to move. */
  leftoverSats: number;
  leftoverReturned: boolean;
  text: string;
}

const short = (txid: string) => `${txid.slice(0, 10)}…${txid.slice(-6)}`;

export function signBundle(
  plan: ExitPlan,
  opts: {
    root: HDKey;
    /** Confirmed coins at the fee address. */
    coins: ConfirmedUtxo[];
    constructFeeBump(parentTxHex: string, utxos: SdkUtxo[], feeRate: { satPerVbyte: number }): { feeBumpPsbt: string; usedUtxos: SdkUtxo[] };
    now?: number;
  },
): ExitBundle {
  const feeKey = deriveFeeKey(opts.root);
  const feeScript = toHex(feeKeyScript(feeKey));
  const feePub = toHex(feeKey.publicKey!);
  const feeAddress = feeKeyAddress(feeKey, plan.network);
  const coins = [...opts.coins].sort((a, b) => b.value - a.value);
  const steps: BundleStep[] = [];
  const stepOfTxid = new Map<string, number>();

  const needed = plan.chainFeeSats + MIN_CHANGE_SATS;
  let feeCoin: ConfirmedUtxo | null = null;
  if (plan.nodePackages.length) {
    if (!coins.length) throw new BundleError("There is no confirmed payment at the fee address yet.");
    feeCoin = coins[0];
    if (feeCoin.value < needed) {
      const total = coins.reduce((s, c) => s + c.value, 0);
      throw new BundleError(
        total >= needed
          ? `The fee address holds ${total} sats, but split across payments. Send a single payment of at least ${needed} sats.`
          : `The fee address holds ${feeCoin.value} sats; this exit needs at least ${needed} sats in one payment.`,
      );
    }
  }

  const confirmsText = (txid: string, lock: number) => {
    const step = stepOfTxid.get(txid);
    const who = step ? `step ${step}` : `transaction ${short(txid)} (already on-chain)`;
    return lock > 0 ? `${who} has at least ${lock} confirmations` : `${who} is confirmed`;
  };

  // The fee chain.
  let coin: SdkUtxo | null = feeCoin
    ? { txid: feeCoin.txid, vout: feeCoin.vout, value: BigInt(feeCoin.value), script: feeScript, publicKey: feePub }
    : null;
  let previousChainStep: number | null = null;
  plan.nodePackages.forEach((p, i) => {
    const bump = opts.constructFeeBump(p.nodeHex, [coin!], { satPerVbyte: plan.feeRate });
    const childHex = signFeeBumpPsbt(bump.feeBumpPsbt, feeKey);
    const child = parseTx(childHex);
    const change = child.outputsLength === 1 ? (child.getOutput(0).amount ?? 0n) : -1n;
    if (child.outputsLength !== 1 || toHex(child.getOutput(0).script!) !== feeScript) {
      throw new BundleError("A fee child was built with an unexpected output. Nothing was produced.");
    }
    if (change < BigInt(MIN_CHANGE_SATS)) {
      throw new BundleError(`The fee coin runs out at tree step ${i + 1}. Send at least ${needed} sats in one payment.`);
    }
    const childTxid = txidOf(child);
    const n = steps.length + 1;

    // Two things must be confirmed: the coin this child spends (the fee
    // payment, or the previous step's change) and the transaction this tree
    // transaction spends — buried under its timelock, if it has one.
    const when: string[] = [
      previousChainStep === null
        ? `your fee payment ${short(feeCoin!.txid)}:${feeCoin!.vout} is confirmed`
        : `step ${previousChainStep} is confirmed`,
    ];
    const parentStep = stepOfTxid.get(p.parentTxid);
    if (p.lock > 0) {
      when.push(confirmsText(p.parentTxid, p.lock));
    } else if (parentStep !== undefined && parentStep !== previousChainStep) {
      when.push(`step ${parentStep} is confirmed`);
    }
    steps.push({
      n,
      kind: "tree",
      title: `Tree transaction ${i + 1} of ${plan.nodePackages.length}`,
      txs: [p.nodeHex, childHex],
      txids: [p.txid, childTxid],
      when: dedupe(when),
      watchTxid: p.txid,
      feeSats: Number(coin!.value - change),
      lock: p.lock,
    });
    stepOfTxid.set(p.txid, n);
    previousChainStep = n;
    coin = { txid: childTxid, vout: 0, value: change, script: feeScript, publicKey: feePub };
  });

  // What is left at the fee address comes back, as soon as the chain is done.
  let leftoverSats = 0;
  let leftoverReturned = false;
  const spare = coins.filter((c) => !feeCoin || c.txid !== feeCoin.txid || c.vout !== feeCoin.vout);
  // Includes any other payments sitting at the fee address, so nothing sent
  // there is stranded — even when no tree step needed paying for.
  const returnCoins = [...(coin ? [{ txid: coin.txid, vout: coin.vout, value: Number(coin.value) }] : []), ...spare];
  if (returnCoins.length) {
    leftoverSats = returnCoins.reduce((s, c) => s + c.value, 0);
    const r = buildReturnTx({ coins: returnCoins, feeKey, destination: plan.destination, network: plan.network, feeRate: plan.feeRate });
    if (r.ok) {
      leftoverReturned = true;
      leftoverSats = r.amountSats;
      const n = steps.length + 1;
      steps.push({
        n,
        kind: "return",
        title: "Return the unused fee money",
        txs: [r.hex],
        txids: [r.txid],
        when: previousChainStep === null ? ["anytime"] : [`step ${previousChainStep} is confirmed`],
        watchTxid: r.txid,
        feeSats: r.feeSats,
        receiveSats: r.amountSats,
        lock: 0,
      });
    }
  }

  // Each leaf's last step. Independent of each other and of the fee chain.
  plan.refunds.forEach((r, i) => {
    const n = steps.length + 1;
    if (r.refundConfirmed) {
      steps.push({
        n,
        kind: "sweep",
        title: `Leaf ${i + 1} of ${plan.refunds.length}: sweep to your address`,
        txs: [r.sweepHex],
        txids: [r.sweepTxid],
        when: ["anytime — its refund is already confirmed"],
        watchTxid: r.sweepTxid,
        feeSats: r.feeSats,
        receiveSats: r.receiveSats,
        lock: 0,
      });
      return;
    }
    steps.push({
      n,
      kind: "leaf-final",
      title: `Leaf ${i + 1} of ${plan.refunds.length}: refund and pay out`,
      txs: [r.refundHex, r.sweepHex],
      txids: [r.refundTxid, r.sweepTxid],
      when: [confirmsText(r.parentTxid, r.lock)],
      watchTxid: r.refundTxid,
      feeSats: r.feeSats,
      receiveSats: r.receiveSats,
      lock: r.lock,
    });
  });

  const bundle: ExitBundle = {
    plan,
    createdAt: opts.now ?? Date.now(),
    feeAddress,
    feeCoin,
    steps,
    leftoverSats,
    leftoverReturned,
    text: "",
  };
  bundle.text = renderBundleText(bundle);
  return bundle;
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)];
}

/** The package line exactly as mempool.space's "Submit package" box expects it. */
export function pasteLine(step: BundleStep): string {
  return step.txs.join(",");
}

export function pushUrl(network: ExitNetwork): string {
  return `${EXPLORER_URL[network]}/tx/push`;
}

const fmt = (n: number) => n.toLocaleString("en-US");

export function renderBundleText(b: ExitBundle): string {
  const p = b.plan;
  const explorer = EXPLORER_URL[p.network];
  const blockMinutes = p.network === "MAINNET" ? 10 : 0.5;
  const maxLock = b.steps.reduce((m, s) => Math.max(m, s.lock), 0);
  const L: string[] = [];

  L.push("NANOSPARK UNILATERAL EXIT BUNDLE");
  L.push("================================");
  L.push("");
  L.push(`Network:        ${p.network}`);
  L.push(`Built:          ${new Date(b.createdAt).toISOString()}`);
  L.push(`Leaves as of:   ${new Date(p.capturedAt).toISOString()}`);
  L.push(`Destination:    ${p.destination}`);
  L.push(`Fee rate:       ${p.feeRate} sat/vB (fixed when signed)`);
  L.push(`Leaves exited:  ${p.included.length} (${fmt(p.included.reduce((s, l) => s + l.valueSats, 0))} sats)`);
  if (p.excluded.length) {
    L.push(`Left behind:    ${p.excluded.length} (${fmt(p.excluded.reduce((s, l) => s + l.valueSats, 0))} sats)`);
    for (const e of p.excluded) L.push(`                - ${e.leafId.slice(0, 8)} ${fmt(e.valueSats)} sats: ${e.reason}`);
  }
  L.push(`Arrives:        ${fmt(p.receiveSats)} sats from the leaves${b.leftoverReturned ? `, plus ${fmt(b.leftoverSats)} sats of unused fee money` : ""}`);
  if (b.feeCoin) L.push(`Fee coin:       ${b.feeCoin.txid}:${b.feeCoin.vout} (${fmt(b.feeCoin.value)} sats at ${b.feeAddress})`);
  L.push(`Steps:          ${b.steps.length}`);
  L.push(`Longest wait:   ${fmt(maxLock)} blocks of timelock (about ${duration(maxLock * blockMinutes)}), plus one block per tree step`);
  L.push("");
  L.push("BEFORE YOU START");
  L.push("----------------");
  L.push("* This bundle is only valid for the leaves the wallet held at the time above. If you have sent,");
  L.push("  received or converted anything since, do not use it: build a new one. Never broadcast an old bundle.");
  L.push("* Once step 1 is broadcast there is no undo. Stop using this wallet on Spark.");
  L.push("* This file cannot spend anything by itself, but it reveals your balance and destination. Keep it private.");
  L.push("");
  L.push("HOW TO BROADCAST A STEP");
  L.push("-----------------------");
  L.push(`1. Open ${pushUrl(p.network)} (or /tx/push on your own mempool instance).`);
  L.push('2. Two transactions: choose "Submit package" and paste the line exactly as given (comma-separated).');
  L.push("   One transaction: paste it into the normal broadcast box.");
  L.push("3. Submit, then open the Watch link and wait until it shows as confirmed.");
  L.push("");
  L.push("Do the tree steps in order, one at a time. The leaf steps at the end are independent of each other.");
  L.push("A step pasted too early is simply rejected and costs nothing:");
  L.push('  "non-BIP68-final"                     its timelock has not passed yet');
  L.push('  "missing inputs" / "missingorspent"   an earlier step has not confirmed yet');
  L.push("Wait and paste it again.");
  L.push("");
  L.push("IF FEES RISE");
  L.push("------------");
  L.push(`Fees are fixed at ${p.feeRate} sat/vB. If a step sits unconfirmed for hours, open sparknote -> Settings ->`);
  L.push("Exit to Bitcoin -> Unilateral and rebuild at a higher rate. The rebuilt bundle skips everything already");
  L.push("confirmed, and its version of the stuck step replaces the old one. It does not need the Spark operators.");
  L.push("");

  for (const s of b.steps) {
    L.push("=".repeat(78));
    L.push(`STEP ${s.n} of ${b.steps.length}: ${s.title}`);
    L.push(`Paste when: ${s.when.join(", and ")}`);
    L.push(
      s.txs.length === 2
        ? `Type: PACKAGE (2 transactions). Fee ${fmt(s.feeSats)} sats.`
        : `Type: SINGLE transaction. Fee ${fmt(s.feeSats)} sats.`,
    );
    if (s.receiveSats !== undefined) L.push(`Pays ${fmt(s.receiveSats)} sats to ${p.destination}.`);
    L.push(`Watch: ${explorer}/tx/${s.watchTxid}`);
    L.push("");
    L.push(pasteLine(s));
    L.push("");
  }
  L.push("=".repeat(78));
  L.push("End of bundle.");
  return L.join("\n");
}

function duration(minutes: number): string {
  if (minutes < 90) return `${Math.max(1, Math.round(minutes))} min`;
  if (minutes < 60 * 36) return `${(minutes / 60).toFixed(1)} hours`;
  return `${(minutes / 1440).toFixed(1)} days`;
}
