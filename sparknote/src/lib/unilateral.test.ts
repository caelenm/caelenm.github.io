/**
 * Unilateral exit engine checks.
 *
 * Run with: node --experimental-strip-types src/lib/unilateral.test.ts
 */
import * as btc from "@scure/btc-signer";
import { DefaultSparkSigner, KeyDerivationType, constructFeeBumpTx } from "@buildonspark/spark-sdk";
import {
  blocksUntilSpendable,
  buildSweep,
  createExitJob,
  deriveFeeKey,
  deriveLeafKey,
  feeKeyAddress,
  feeKeyScript,
  leafRefundScript,
  parseTx,
  relativeBlockLock,
  rootKey,
  runExitRound,
  signFeeBumpPsbt,
  toHex,
  txidOf,
  type Esplora,
  type ExitNode,
  type TxState,
} from "./unilateral.ts";

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

// --- keys agree with the SDK's own signer ----------------------------------

const signer = new DefaultSparkSigner();
await signer.createSparkWalletFromSeed(await signer.mnemonicToSeed(MNEMONIC), 0);
for (const leafId of [
  "01a08c9d-4b1e-7a3c-9f00-0123456789ab",
  "01a0a05b-0000-7000-8000-000000000000",
  "leaf",
]) {
  const sdk = await signer.getPublicKeyFromDerivation({ type: KeyDerivationType.LEAF, path: leafId });
  check(`leaf key for ${leafId.slice(0, 8)} matches the SDK signer`, toHex(deriveLeafKey(root, leafId).publicKey!), toHex(sdk));
}

const feeKey = deriveFeeKey(root);
const feeAddress = feeKeyAddress(feeKey, "REGTEST");
check("fee address is regtest P2WPKH", feeAddress.startsWith("bcrt1q"), true);
check("fee address is stable", feeKeyAddress(deriveFeeKey(rootKey(MNEMONIC)), "REGTEST"), feeAddress);

// --- BIP68 --------------------------------------------------------------------

check("disabled sequence has no lock", relativeBlockLock(0xfffffffd), null);
check("block lock read from the low 16 bits", relativeBlockLock(2000), 2000);
check("Spark's bit 30 is ignored", relativeBlockLock((1 << 30) | 1900), 1900);
check("time-based lock is not a block lock", relativeBlockLock(0x00400000 | 10), null);
check("undefined sequence has no lock", relativeBlockLock(undefined), null);

check("no lock: spendable in the next block", blocksUntilSpendable(null, 100, 100), 0);
check("lock 2000 right after parent confirms", blocksUntilSpendable(2000, 101, 101), 1999);
check("lock matures exactly on time", blocksUntilSpendable(2000, 101, 2100), 0);
check("one block short", blocksUntilSpendable(2000, 101, 2099), 1);

// --- txid ---------------------------------------------------------------------

{
  // A signed transaction: txidOf must agree with the library's own id.
  const k = deriveLeafKey(root, "txid-check");
  const script = leafRefundScript(k);
  const t = new btc.Transaction();
  t.addInput({ txid: "55".repeat(32), index: 0, witnessUtxo: { script, amount: 5_000n }, tapInternalKey: k.publicKey!.slice(1) });
  t.addOutput({ script, amount: 4_000n });
  t.sign(k.privateKey!);
  t.finalize();
  check("txidOf matches the library id on a signed transaction", txidOf(t), t.id);
}

// --- sweep --------------------------------------------------------------------

function fakeRefund(leafKey: ReturnType<typeof deriveLeafKey>, amount: bigint, parentTxid = "11".repeat(32)) {
  const t = new btc.Transaction({ version: 3, allowUnknownOutputs: true });
  t.addInput({ txid: parentTxid, index: 0, sequence: (1 << 30) | 1900 });
  t.addOutput({ script: leafRefundScript(leafKey), amount });
  t.addOutput({ script: new Uint8Array([0x51]), amount: 0n });
  return t;
}

const leafKey = deriveLeafKey(root, "leaf");
const refund = fakeRefund(leafKey, 10_000n);
const sweep = buildSweep({ refundTx: refund.unsignedTx, leafKey, destination: feeAddress, network: "REGTEST", feeRate: 2 });
check("sweep builds", sweep.ok ? true : sweep.reason, true);
if (sweep.ok) {
  const tx = parseTx(sweep.hex);
  check("sweep spends the refund output", toHex(tx.getInput(0).txid!), txidOf(refund));
  check("sweep has one output", tx.outputsLength, 1);
  check("sweep pays the destination", toHex(tx.getOutput(0).script!), toHex(btc.OutScript.encode(btc.Address(REGTEST).decode(feeAddress))));
  check("amount + fee = refund value", sweep.amountSats + sweep.feeSats, 10_000);
  check("fee is at least the vsize at 2 sat/vB", sweep.feeSats >= tx.vsize * 2 - 2, true);
}

const dust = buildSweep({ refundTx: fakeRefund(leafKey, 400n).unsignedTx, leafKey, destination: feeAddress, network: "REGTEST", feeRate: 1 });
check("a sweep that would leave dust is refused", dust.ok, false);

const wrongKey = buildSweep({ refundTx: refund.unsignedTx, leafKey: deriveLeafKey(root, "other"), destination: feeAddress, network: "REGTEST", feeRate: 1 });
check("a refund not paying this leaf's key is refused", wrongKey.ok, false);

// --- fee bump signing, against the SDK's real constructFeeBumpTx -------------

{
  // Real Spark node and refund transactions arrive fully signed. The parent
  // here is signed too, because the SDK's constructFeeBumpTx reads the parent's
  // id, which the signing library refuses to compute for an unsigned input.
  const parent = new btc.Transaction({ version: 3, allowUnknownOutputs: true });
  parent.addInput({
    txid: "33".repeat(32),
    index: 0,
    sequence: 0xfffffffd,
    witnessUtxo: { script: leafRefundScript(leafKey), amount: 30_000n },
    tapInternalKey: leafKey.publicKey!.slice(1),
  });
  parent.addOutput({ script: leafRefundScript(leafKey), amount: 20_000n });
  parent.addOutput({ script: new Uint8Array([0x51]), amount: 0n });
  parent.sign(leafKey.privateKey!);
  parent.finalize();
  const parentHex = parent.hex;
  const parentTxid = txidOf(parent);

  try {
    const { feeBumpPsbt } = constructFeeBumpTx(
      parentHex,
      [{ txid: "44".repeat(32), vout: 1, value: 50_000n, script: toHex(feeKeyScript(feeKey)), publicKey: toHex(feeKey.publicKey!) }],
      { satPerVbyte: 2 },
    );
    const childHex = signFeeBumpPsbt(feeBumpPsbt, feeKey);
    const child = parseTx(childHex);
    const inputs = Array.from({ length: child.inputsLength }, (_, i) => child.getInput(i));
    check("child spends the parent's anchor", inputs.some((inp) => inp.txid && toHex(inp.txid) === parentTxid), true);
    check(
      "fee-key input carries a P2WPKH witness",
      inputs.some((inp) => inp.txid && toHex(inp.txid) === "44".repeat(32) && (inp.finalScriptWitness?.length ?? 0) === 2),
      true,
    );
    check(
      "anchor input is spent with an empty witness",
      inputs.some((inp) => inp.txid && toHex(inp.txid) === parentTxid && inp.finalScriptWitness?.length === 0),
      true,
    );
  } catch (e) {
    failures++;
    console.log(`FAIL fee bump signing threw: ${e instanceof Error ? e.message : e}`);
  }
}

// --- rounds, with a fake chain -----------------------------------------------

function nodeTx(parentTxid: string, sequence: number, payTo: Uint8Array, amount: bigint) {
  const t = new btc.Transaction({ version: 3, allowUnknownOutputs: true });
  t.addInput({ txid: parentTxid, index: 0, sequence });
  t.addOutput({ script: payTo, amount });
  t.addOutput({ script: new Uint8Array([0x51]), amount: 0n });
  return t;
}

const DEPOSIT = "aa".repeat(32);
const treeScript = leafRefundScript(deriveLeafKey(root, "tree"));

function scenario(leafIds = ["leaf"]) {
  const rootTx = nodeTx(DEPOSIT, 0xfffffffd, treeScript, 40_000n);
  const rootTxid = txidOf(rootTx);
  const nodes: ExitNode[] = [{ id: "root", status: "SPLITTED", value: 40_000, nodeTx: rootTx.unsignedTx, refundTx: new Uint8Array() }];
  const txs: Record<string, { node: string; refund: string }> = {};
  for (const id of leafIds) {
    const k = deriveLeafKey(root, id);
    const leafNode = nodeTx(rootTxid, (1 << 30) | 2000, treeScript, 20_000n);
    const refundTx = nodeTx(txidOf(leafNode), (1 << 30) | 1900, leafRefundScript(k), 20_000n);
    nodes.push({ id, parentNodeId: "root", status: "AVAILABLE", value: 20_000, nodeTx: leafNode.unsignedTx, refundTx: refundTx.unsignedTx });
    txs[id] = { node: txidOf(leafNode), refund: txidOf(refundTx) };
  }
  return { rootTxid, nodes, txs };
}

function fakeEsplora(opts: { tip: number; states: Record<string, TxState>; utxos?: number }) {
  const submitted: string[][] = [];
  const broadcasts: string[] = [];
  const esplora: Esplora = {
    tipHeight: async () => opts.tip,
    txState: async (txid) => opts.states[txid] ?? { found: false, confirmed: false },
    confirmedUtxos: async () =>
      Array.from({ length: opts.utxos ?? 1 }, (_, i) => ({ txid: (i + 1).toString(16).padStart(64, "b"), vout: 0, value: 50_000 })),
    submitPackage: async (hexes) => void submitted.push(hexes),
    broadcast: async (hex) => {
      broadcasts.push(hex);
      return txidOf(parseTx(hex));
    },
    recommendedFeeRate: async () => 1,
  };
  return { esplora, submitted, broadcasts };
}

const deps = (esplora: Esplora) => ({
  esplora,
  root,
  buildChain: async (leaf: ExitNode, map: Map<string, ExitNode>) => {
    const chain: ExitNode[] = [];
    let cur: ExitNode | undefined = leaf;
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentNodeId ? map.get(cur.parentNodeId) : undefined;
    }
    return chain;
  },
  constructFeeBump: (_hex: string, utxos: { txid: string; vout: number; value: bigint; script: string; publicKey: string }[]) => ({
    feeBumpPsbt: "psbt",
    usedUtxos: [utxos[0]],
  }),
  signFeeBump: () => "child",
});

const confirmed = (h: number): TxState => ({ found: true, confirmed: true, blockHeight: h });

{
  const s = scenario();
  const job = createExitJob({ network: "REGTEST", destination: feeAddress, feeRate: 1, leafIds: ["leaf"], nodes: s.nodes });
  const fe = fakeEsplora({ tip: 100, states: { [DEPOSIT]: confirmed(100) } });
  const r = await runExitRound(job, deps(fe.esplora));
  check("round 1: broadcasts the root node transaction", r.progress[0].state, "broadcast");
  check("round 1: submitted as a [parent, child] package", fe.submitted.length === 1 && fe.submitted[0][1] === "child", true);
  check("round 1: step 1 of 3", "step" in r.progress[0] ? [r.progress[0].step, r.progress[0].of] : null, [1, 3]);
}

{
  const s = scenario();
  const job = createExitJob({ network: "REGTEST", destination: feeAddress, feeRate: 1, leafIds: ["leaf"], nodes: s.nodes });
  const fe = fakeEsplora({ tip: 101, states: { [DEPOSIT]: confirmed(100), [s.rootTxid]: confirmed(101) } });
  const r = await runExitRound(job, deps(fe.esplora));
  const p = r.progress[0];
  check("leaf node waits out its 2000-block lock", p.state === "timelock" ? p.blocksLeft : p.state, 1999);
  check("nothing is broadcast while locked", fe.submitted.length, 0);
}

{
  const s = scenario();
  const job = createExitJob({ network: "REGTEST", destination: feeAddress, feeRate: 1, leafIds: ["leaf"], nodes: s.nodes });
  const fe = fakeEsplora({ tip: 2101, states: { [DEPOSIT]: confirmed(100), [s.rootTxid]: confirmed(101) }, utxos: 0 });
  const r = await runExitRound(job, deps(fe.esplora));
  check("with no fee UTXO the round asks for funding", r.progress[0].state, "needs-funding");
}

{
  const s = scenario();
  const job = createExitJob({ network: "REGTEST", destination: feeAddress, feeRate: 1, leafIds: ["leaf"], nodes: s.nodes });
  const fe = fakeEsplora({
    tip: 4001,
    states: { [DEPOSIT]: confirmed(100), [s.rootTxid]: confirmed(101), [s.txs.leaf.node]: confirmed(2101), [s.txs.leaf.refund]: confirmed(4001) },
  });
  const r = await runExitRound(job, deps(fe.esplora));
  check("all confirmed: the refund is swept", r.progress[0].state, "sweep-broadcast");
  check("the sweep is recorded on the job", typeof r.job.sweeps.leaf, "string");
  check("the input job is not mutated", Object.keys(job.sweeps).length, 0);
  if (fe.broadcasts.length) {
    const sweepTx = parseTx(fe.broadcasts[0]);
    check("the sweep spends the refund", toHex(sweepTx.getInput(0).txid!), s.txs.leaf.refund);
  }

  const fe2 = fakeEsplora({ tip: 4002, states: { [r.job.sweeps.leaf]: confirmed(4002) } });
  const r2 = await runExitRound(r.job, deps(fe2.esplora));
  check("once the sweep confirms the job is done", r2.done, true);
}

{
  const s = scenario(["leaf-a", "leaf-b"]);
  const job = createExitJob({ network: "REGTEST", destination: feeAddress, feeRate: 1, leafIds: ["leaf-a", "leaf-b"], nodes: s.nodes });
  const fe = fakeEsplora({ tip: 100, states: { [DEPOSIT]: confirmed(100) }, utxos: 2 });
  const r = await runExitRound(job, deps(fe.esplora));
  check("a shared ancestor is broadcast once", fe.submitted.length, 1);
  check("the second leaf waits on it", r.progress[1].state, "in-mempool");
}

try {
  createExitJob({ network: "REGTEST", destination: "bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq", feeRate: 1, leafIds: ["x"], nodes: [] });
  failures++;
  console.log("FAIL a mainnet destination on a regtest exit is accepted");
} catch {
  console.log("ok   a mainnet destination on a regtest exit is refused");
}

{
  // Found live: one fee UTXO means one package per block. After a broadcast its
  // change is unconfirmed, and a leaf that is ready meanwhile must say it is
  // waiting on that change — not that the fee address is empty.
  const s = scenario();
  const job = createExitJob({ network: "REGTEST", destination: feeAddress, feeRate: 1, leafIds: ["leaf"], nodes: s.nodes });
  const fe = fakeEsplora({ tip: 2101, states: { [DEPOSIT]: confirmed(100), [s.rootTxid]: confirmed(101) }, utxos: 0 });
  const r = await runExitRound(job, deps({ ...fe.esplora, pendingUtxoSats: async () => 49_046 }));
  const p = r.progress[0];
  check("unconfirmed fee change reads as waiting, not unfunded", p.state, "waiting-fee");
  check("and reports how much is pending", p.state === "waiting-fee" ? p.pendingSats : null, 49_046);
}

// --- esplora request shapes ---------------------------------------------------
// Regression guard: a text/plain package body is silently rejected by mempool's
// backend with a misleading "RPC error {code:-1}", which stalled the first live exit.

{
  const { createEsplora } = await import("./unilateral.ts");
  const calls: { url: string; init?: RequestInit }[] = [];
  const fakeFetch = (async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ package_msg: "success" }), { status: 200 });
  }) as unknown as typeof fetch;
  const es = createEsplora("https://example.test/api", fakeFetch);
  await es.submitPackage(["aa", "bb"]);
  check("packages are posted to /txs/package", calls[0]?.url, "https://example.test/api/txs/package");
  check("packages are posted as application/json", new Headers(calls[0]?.init?.headers).get("Content-Type"), "application/json");
  check("the package body is a JSON array of hex", calls[0]?.init?.body, JSON.stringify(["aa", "bb"]));

  const rejecting = createEsplora("https://example.test/api", (async () =>
    new Response(JSON.stringify({ package_msg: "transaction failed" }), { status: 200 })) as unknown as typeof fetch);
  let threw = false;
  try {
    await rejecting.submitPackage(["aa", "bb"]);
  } catch {
    threw = true;
  }
  check("a 200 response that is not package success still throws", threw, true);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
