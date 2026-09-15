/**
 * Exit bundle checks: which leaves are worth exiting, the order transactions go
 * out in, the pre-signed fee chain, and each leaf's final sweep.
 *
 * Run with: node --experimental-strip-types src/lib/exitBundle.test.ts
 */
import * as btc from "@scure/btc-signer";
import { schnorr } from "@noble/curves/secp256k1.js";
import { constructFeeBumpTx } from "@buildonspark/spark-sdk";
import {
  BundleError,
  MIN_CHANGE_SATS,
  buildRefundSweepChild,
  captureFromNodes,
  cpfpFeeSats,
  pasteLine,
  planExit,
  pushUrl,
  signBundle,
  vsizeOf,
  type TxStatus,
} from "./exitBundle.ts";
import { deriveLeafKey, feeKeyScript, deriveFeeKey, leafRefundScript, parseTx, rootKey, toHex, txidOf, type ExitNode } from "./unilateral.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const norm = (v: unknown) => JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x));
  const ok = norm(actual) === norm(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${norm(actual)} want ${norm(expected)}`}`);
}

/** The standard BIP39 test phrase — never a real wallet. */
const MNEMONIC = "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about";
const root = rootKey(MNEMONIC);
const REGTEST = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };
const DESTINATION = btc.p2tr(deriveLeafKey(root, "destination").publicKey!.slice(1), undefined, REGTEST).address!;

const treeKey = deriveLeafKey(root, "tree-fixture");
const treeScript = leafRefundScript(treeKey);
/** Bitcoin Core 29's pay-to-anchor output. */
const ANCHOR = new Uint8Array([0x51, 0x02, 0x4e, 0x73]);
const DEPOSIT = "aa".repeat(32);
const RATE = 2;

/** Spark's pre-signed transactions arrive signed, zero-fee, with a zero-value anchor. */
function sparkTx(parentTxid: string, sequence: number, payTo: Uint8Array, amount: bigint) {
  const t = new btc.Transaction({ version: 3, allowUnknownOutputs: true });
  t.addInput({
    txid: parentTxid,
    index: 0,
    sequence,
    witnessUtxo: { script: treeScript, amount },
    tapInternalKey: treeKey.publicKey!.slice(1),
  });
  t.addOutput({ script: payTo, amount });
  t.addOutput({ script: ANCHOR, amount: 0n });
  t.sign(treeKey.privateKey!);
  t.finalize();
  return t;
}

const LEAF_LOCK = (1 << 30) | 2000;
const REFUND_LOCK = (1 << 30) | 1900;

function scenario(leaves: { id: string; value: number; refundKeyId?: string }[]) {
  const total = leaves.reduce((s, l) => s + l.value, 0);
  const rootTx = sparkTx(DEPOSIT, 0xfffffffd, treeScript, BigInt(total));
  const rootTxid = txidOf(rootTx);
  const nodes: ExitNode[] = [
    { id: "root", status: "SPLITTED", value: total, nodeTx: rootTx.toBytes(true, true), refundTx: new Uint8Array() },
  ];
  const txids: Record<string, { node: string; refund: string }> = {};
  for (const l of leaves) {
    const leafNode = sparkTx(rootTxid, LEAF_LOCK, treeScript, BigInt(l.value));
    const refund = sparkTx(txidOf(leafNode), REFUND_LOCK, leafRefundScript(deriveLeafKey(root, l.refundKeyId ?? l.id)), BigInt(l.value));
    nodes.push({
      id: l.id,
      parentNodeId: "root",
      status: "AVAILABLE",
      value: l.value,
      nodeTx: leafNode.toBytes(true, true),
      refundTx: refund.toBytes(true, true),
    });
    txids[l.id] = { node: txidOf(leafNode), refund: txidOf(refund) };
  }
  const capture = captureFromNodes("REGTEST", leaves.map((l) => l.id), nodes, 1_700_000_000_000);
  return { capture, rootTxid, txids, rootTx };
}

const buildChain = async (leaf: ExitNode, map: Map<string, ExitNode>) => {
  const chain: ExitNode[] = [];
  let cur: ExitNode | undefined = leaf;
  while (cur) {
    chain.unshift(cur);
    cur = cur.parentNodeId ? map.get(cur.parentNodeId) : undefined;
  }
  return chain;
};

const chainAt = (confirmed: Record<string, number>) => async (txid: string): Promise<TxStatus> =>
  txid in confirmed ? { confirmed: true, blockHeight: confirmed[txid] } : { confirmed: false };

const plan = (s: ReturnType<typeof scenario>, confirmed: Record<string, number>, feeRate = RATE) =>
  planExit({ capture: s.capture, root, destination: DESTINATION, feeRate, txStatus: chainAt(confirmed), buildChain });

// --- which leaves go in --------------------------------------------------------

{
  const s = scenario([
    { id: "big", value: 20_000 },
    { id: "tiny", value: 600 },
  ]);
  const p = await plan(s, { [DEPOSIT]: 100 });
  if (!p.included.length) console.log("     excluded:", JSON.stringify(p.excluded));
  check("a large leaf is included", p.included.map((l) => l.leafId), ["big"]);
  check("a leaf eaten by fees is left behind", p.excluded.map((l) => l.leafId), ["tiny"]);
  check("every excluded leaf says why", p.excluded.every((e) => e.reason.length > 10), true);
  check("tree steps: the root, then the leaf's node", p.nodePackages.map((n) => n.txid), [s.rootTxid, s.txids.big.node]);
  check("chain fees are the SDK's fee-bump formula", p.chainFeeSats, p.nodePackages.reduce((a, n) => a + cpfpFeeSats(n.vsize, RATE), 0));
  check("funding covers chain fees, minimum change and the return", p.fundingSats, p.chainFeeSats + MIN_CHANGE_SATS + Math.ceil(112 * RATE));
  check("what arrives is the leaf less its last step's fee", p.receiveSats, 20_000 - p.refunds[0].feeSats);
  check("the leaf node's lock is read from its sequence", p.nodePackages[1].lock, 2000);
}

{
  // Different values, so the two leaf node transactions are distinct (the
  // fixture spends the same parent output for both, unlike a real tree).
  const s = scenario([
    { id: "a", value: 20_000 },
    { id: "b", value: 19_000 },
  ]);
  const p = await plan(s, { [DEPOSIT]: 100 });
  check("a shared ancestor is paid for once", p.nodePackages.length, 3);
  check("the untimelocked root goes first", p.nodePackages[0].txid, s.rootTxid);
  check("both leaves are included", p.included.length, 2);
}

{
  const s = scenario([{ id: "big", value: 20_000 }]);
  const p = await plan(s, { [DEPOSIT]: 100, [s.rootTxid]: 101 });
  check("transactions already on-chain are skipped", p.nodePackages.map((n) => n.txid), [s.txids.big.node]);
}

{
  const s = scenario([{ id: "big", value: 20_000 }]);
  const p = await plan(s, {});
  check("a tree whose funding is unconfirmed is not exited", p.excluded.map((e) => e.leafId), ["big"]);
  check("and needs no funding", p.fundingSats, 0);
}

{
  const s = scenario([{ id: "big", value: 20_000, refundKeyId: "somebody-else" }]);
  const p = await plan(s, { [DEPOSIT]: 100 });
  check("a refund not paying this wallet is refused", p.excluded[0]?.reason.includes("does not pay this wallet"), true);
}

{
  const s = scenario([{ id: "big", value: 20_000 }]);
  let threw = false;
  try {
    await planExit({ capture: s.capture, root, destination: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", feeRate: RATE, txStatus: chainAt({}), buildChain });
  } catch (e) {
    threw = e instanceof BundleError;
  }
  check("a mainnet destination on a regtest exit is refused", threw, true);
}

// --- the final sweep of a leaf --------------------------------------------------

{
  const s = scenario([{ id: "big", value: 20_000 }]);
  const leaf = s.capture.nodes.find((n) => n.id === "big")!;
  const leafKey = deriveLeafKey(root, "big");
  const r = buildRefundSweepChild({ refundTx: leaf.refundTx, leafKey, destination: DESTINATION, network: "REGTEST", feeRate: RATE });
  check("the sweep child builds", r.ok ? true : r.reason, true);
  if (r.ok) {
    const refund = parseTx(leaf.refundTx);
    const child = parseTx(r.hex);
    const refundScript = leafRefundScript(leafKey);
    check("it is version 3", child.version, 3);
    check("it spends the refund's output", toHex(child.getInput(0).txid!) === txidOf(refund) && child.getInput(0).index === 0, true);
    check("and the refund's anchor", toHex(child.getInput(1).txid!) === txidOf(refund) && child.getInput(1).index === 1, true);
    check("the anchor is spent with an empty witness", child.getInput(1).finalScriptWitness?.length, 0);
    check("one output, to the destination", child.outputsLength, 1);
    check(
      "paying the leaf less the package fee",
      child.getOutput(0).amount,
      BigInt(20_000 - r.feeSats),
    );
    const packageRate = r.feeSats / (vsizeOf(refund) + vsizeOf(child));
    check("the package pays at least the requested rate", packageRate >= RATE, true);

    const sig = child.getInput(0).finalScriptWitness![0];
    const msg = child.preimageWitnessV1(0, [refundScript, ANCHOR], btc.SigHash.DEFAULT, [20_000n, 0n]);
    check("the taproot signature verifies against the refund's output key", schnorr.verify(sig, msg, refundScript.slice(2)), true);
  }

  const small = buildRefundSweepChild({ refundTx: leaf.refundTx, leafKey, destination: DESTINATION, network: "REGTEST", feeRate: 200 });
  check("a sweep that would leave dust is refused", small.ok, false);
}

// --- signing the whole bundle ---------------------------------------------------

{
  const s = scenario([
    { id: "a", value: 20_000 },
    { id: "b", value: 12_000 },
  ]);
  const p = await plan(s, { [DEPOSIT]: 100 });
  const feeKey = deriveFeeKey(root);
  const coin = { txid: "cc".repeat(32), vout: 1, value: 50_000 };
  const b = signBundle(p, { root, coins: [coin], constructFeeBump: constructFeeBumpTx, now: 1_700_000_100_000 });

  check("steps: 3 tree, 1 return, 2 leaf finals", b.steps.map((st) => st.kind), ["tree", "tree", "tree", "return", "leaf-final", "leaf-final"]);
  check("steps are numbered in order", b.steps.map((st) => st.n), [1, 2, 3, 4, 5, 6]);

  const trees = b.steps.filter((st) => st.kind === "tree");
  let spends = coin.txid;
  let spendsVout = coin.vout;
  let chainOk = true;
  let anchorsOk = true;
  let ratesOk = true;
  let previousValue = BigInt(coin.value);
  for (const st of trees) {
    const node = parseTx(st.txs[0]);
    const child = parseTx(st.txs[1]);
    const inputs = Array.from({ length: child.inputsLength }, (_, i) => child.getInput(i));
    if (!inputs.some((inp) => toHex(inp.txid!) === spends && inp.index === spendsVout)) chainOk = false;
    if (!inputs.some((inp) => toHex(inp.txid!) === txidOf(node))) anchorsOk = false;
    const change = child.getOutput(0).amount!;
    const fee = previousValue - change;
    if (Number(fee) / (vsizeOf(node) + vsizeOf(child)) < RATE) ratesOk = false;
    if (toHex(child.getOutput(0).script!) !== toHex(feeKeyScript(feeKey))) chainOk = false;
    spends = txidOf(child);
    spendsVout = 0;
    previousValue = change;
  }
  check("each fee child spends the previous child's change, starting from the fee coin", chainOk, true);
  check("each fee child spends its tree transaction's anchor", anchorsOk, true);
  check("every tree package pays at least the requested rate", ratesOk, true);

  const ret = b.steps.find((st) => st.kind === "return")!;
  const retTx = parseTx(ret.txs[0]);
  check("the return spends the last change", toHex(retTx.getInput(0).txid!) === spends && retTx.getInput(0).index === 0, true);
  check("and pays the destination", toHex(retTx.getOutput(0).script!), toHex(btc.OutScript.encode(btc.Address(REGTEST).decode(DESTINATION))));
  check("the return waits for the last tree step", ret.when, ["step 3 is confirmed"]);

  check("step 1 waits for the fee payment", b.steps[0].when[0].startsWith("your fee payment"), true);
  check("step 2 waits for step 1", b.steps[1].when.includes("step 1 is confirmed"), true);
  check("a leaf node waits out its lock on the root", b.steps[1].when.includes("step 1 has at least 2000 confirmations"), true);
  const final = b.steps.find((st) => st.kind === "leaf-final")!;
  check("a leaf's final step waits out the refund lock on its node", /step \d has at least 1900 confirmations/.test(final.when[0]), true);

  check("a package pastes as two hex strings joined by one comma", /^[0-9a-f]+,[0-9a-f]+$/.test(pasteLine(b.steps[0])), true);
  check("a single transaction pastes as bare hex", /^[0-9a-f]+$/.test(pasteLine(ret)), true);
  check("the text names every step", b.steps.every((st) => b.text.includes(`STEP ${st.n} of ${b.steps.length}`)), true);
  check("the text points at the push page", b.text.includes(pushUrl("REGTEST")), true);
  check("what is returned is reported", b.leftoverReturned && b.leftoverSats > 0, true);
}

{
  const s = scenario([{ id: "a", value: 20_000 }]);
  const p = await plan(s, { [DEPOSIT]: 100 });
  let message = "";
  try {
    signBundle(p, { root, coins: [{ txid: "cc".repeat(32), vout: 0, value: 400 }], constructFeeBump: constructFeeBumpTx });
  } catch (e) {
    message = e instanceof BundleError ? e.message : `wrong error: ${e}`;
  }
  check("an underfunded fee coin is refused before anything is produced", message.includes("needs at least"), true);

  let noCoin = "";
  try {
    signBundle(p, { root, coins: [], constructFeeBump: constructFeeBumpTx });
  } catch (e) {
    noCoin = e instanceof BundleError ? e.message : `wrong error: ${e}`;
  }
  check("no fee coin at all is refused", noCoin.includes("no confirmed payment"), true);
}

{
  const s = scenario([{ id: "a", value: 20_000 }]);
  const p = await plan(s, { [DEPOSIT]: 100, [s.rootTxid]: 101, [s.txids.a.node]: 2101 });
  const b = signBundle(p, { root, coins: [], constructFeeBump: constructFeeBumpTx });
  check("with the tree already on-chain, no fee coin is needed", b.steps.map((st) => st.kind), ["leaf-final"]);
  check("and the final step names the on-chain node", b.steps[0].when[0].includes("already on-chain"), true);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
