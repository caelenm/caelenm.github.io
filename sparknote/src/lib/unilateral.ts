/**
 * Unilateral exit, done properly.
 *
 * The escape hatch that makes "self-custodial" mean anything: getting funds out
 * to a Bitcoin address with no cooperation from the Spark operators or the SSP.
 * The earlier version of this screen exported raw transaction hex and stopped
 * there, which was not an exit — those transactions pay no fee and cannot enter
 * a mempool on their own. This module does the whole thing:
 *
 *   1. For each leaf, walk its chain of ancestor transactions from the tree
 *      root down to the leaf's own node transaction, then its refund.
 *   2. Broadcast each one as a v3 package together with a CPFP child that pays
 *      its fee from a separate on-chain "fee key" the user funds.
 *   3. Wait for every level to confirm before the next — TRUC (v3) policy will
 *      not accept a child of an unconfirmed package — and for the relative
 *      timelocks on the leaf's node and refund transactions to mature.
 *   4. Sweep each confirmed refund output to the destination address, signed
 *      with the leaf's own key.
 *
 * It runs as repeated rounds rather than one long call, because the waiting is
 * measured in hours to weeks and the tab will be closed and reopened. Each
 * round reads the chain, does whatever is possible right now, and returns.
 *
 * Key derivation is shared with Blink's spark-unilateral-exit tool, so an exit
 * started here can be finished there and vice versa:
 *
 *   leaf key  m/8797555'/{account}'/1'/{uint32BE(sha256(leafId)) mod 2^31}'
 *   fee key   m/8797556'/{account}/0   (P2WPKH)
 *
 * The leaf-key path is also exactly what the Spark SDK's own signer uses; a test
 * checks the two agree.
 */
import { HDKey } from "@scure/bip32";
import * as btc from "@scure/btc-signer";
import { mnemonicToSeedSync } from "@scure/bip39";
import { sha256 } from "@noble/hashes/sha2.js";
import type { SparkWallet } from "@buildonspark/spark-sdk";
import { DUST_LIMIT_SATS } from "./onchain.ts";

export type ExitNetwork = "MAINNET" | "REGTEST";

const REGTEST_PARAMS = { bech32: "bcrt", pubKeyHash: 0x6f, scriptHash: 0xc4, wif: 0xef };

export function bitcoinNetwork(network: ExitNetwork) {
  return network === "MAINNET" ? btc.NETWORK : REGTEST_PARAMS;
}

/** Esplora-compatible APIs. Both are already origins the Spark SDK contacts. */
export const ESPLORA_URL: Record<ExitNetwork, string> = {
  MAINNET: "https://mempool.space/api",
  REGTEST: "https://regtest-mempool.us-west-2.sparkinfra.net/api",
};

/** Human-facing explorers for the same chains, for "view on explorer" links. */
export const EXPLORER_URL: Record<ExitNetwork, string> = {
  MAINNET: "https://mempool.space",
  REGTEST: "https://regtest-mempool.us-west-2.sparkinfra.net",
};

/** Average block interval, for turning a timelock into a rough duration. */
export const BLOCK_SECONDS: Record<ExitNetwork, number> = {
  MAINNET: 600,
  REGTEST: 31,
};

/* ------------------------------------------------------------------ */
/* bytes                                                               */
/* ------------------------------------------------------------------ */

export function toHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i].toString(16).padStart(2, "0");
  return s;
}

export function fromHex(h: string): Uint8Array {
  if (h.length % 2) throw new Error("odd-length hex");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/* ------------------------------------------------------------------ */
/* keys                                                                */
/* ------------------------------------------------------------------ */

const HARDENED = 0x80000000;

export function rootKey(mnemonic: string): HDKey {
  return HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic));
}

/** The hardened child index the SDK signer derives a leaf's signing key at. */
export function leafSigningChildIndex(leafId: string): number {
  const h = sha256(new TextEncoder().encode(leafId));
  return new DataView(h.buffer, h.byteOffset, h.byteLength).getUint32(0, false) % HARDENED;
}

export function deriveLeafKey(root: HDKey, leafId: string, account = 0): HDKey {
  return root.derive(`m/8797555'/${account}'/1'`).deriveChild(leafSigningChildIndex(leafId) + HARDENED);
}

export function deriveFeeKey(root: HDKey, account = 0): HDKey {
  return root.derive(`m/8797556'/${account}/0`);
}

function publicKeyOf(key: HDKey): Uint8Array {
  if (!key.publicKey) throw new Error("key has no public key");
  return key.publicKey;
}

function privateKeyOf(key: HDKey): Uint8Array {
  if (!key.privateKey) throw new Error("key has no private key");
  return key.privateKey;
}

export function feeKeyScript(key: HDKey): Uint8Array {
  return btc.p2wpkh(publicKeyOf(key)).script;
}

export function feeKeyAddress(key: HDKey, network: ExitNetwork): string {
  const address = btc.p2wpkh(publicKeyOf(key), bitcoinNetwork(network)).address;
  if (!address) throw new Error("could not encode fee address");
  return address;
}

/** The key-path P2TR script a leaf's refund transaction pays. */
export function leafRefundScript(leafKey: HDKey): Uint8Array {
  return btc.p2tr(publicKeyOf(leafKey).slice(1)).script;
}

/* ------------------------------------------------------------------ */
/* transactions                                                        */
/* ------------------------------------------------------------------ */

const PARSE = { allowUnknownOutputs: true, allowUnknownInputs: true, disableScriptCheck: true };

export function parseTx(raw: Uint8Array | string) {
  return btc.Transaction.fromRaw(typeof raw === "string" ? fromHex(raw) : raw, PARSE);
}

/**
 * The txid, computed from the witness-free serialization — which is what a txid
 * commits to. The signing library's own `.id` refuses to compute until every
 * input is finalized, which would make the engine fail on any transaction it did
 * not sign itself.
 */
export function txidOf(tx: btc.Transaction): string {
  return toHex(sha256(sha256(tx.toBytes(true, false))).reverse());
}

const SEQUENCE_DISABLE_FLAG = 0x80000000;
const SEQUENCE_TYPE_TIME_FLAG = 0x00400000;

/**
 * BIP68 relative lock in blocks for an input's nSequence, or null when the
 * input carries none.
 *
 * Spark also sets bit 30 on its sequences for its own bookkeeping; BIP68 only
 * looks at bits 31 (disable) and 22 (time-based), so bit 30 is ignored here as
 * it is by consensus. Spark does not use time-based locks; one would be treated
 * as "no block lock", and at worst the broadcast is rejected and retried.
 */
export function relativeBlockLock(sequence: number | undefined): number | null {
  if (sequence === undefined) return null;
  const s = sequence >>> 0;
  if (s & SEQUENCE_DISABLE_FLAG) return null;
  if (s & SEQUENCE_TYPE_TIME_FLAG) return null;
  return s & 0xffff;
}

/**
 * Blocks still to wait before a transaction whose parent confirmed at
 * `parentHeight` can be mined, given a relative lock of `lock` blocks.
 *
 * BIP68: valid in a block of height >= parentHeight + lock. The earliest block
 * it can enter is the next one, tipHeight + 1.
 */
export function blocksUntilSpendable(lock: number | null, parentHeight: number, tipHeight: number): number {
  return Math.max(0, parentHeight + (lock ?? 0) - (tipHeight + 1));
}

/* ------------------------------------------------------------------ */
/* esplora                                                             */
/* ------------------------------------------------------------------ */

export interface TxState {
  found: boolean;
  confirmed: boolean;
  blockHeight?: number;
}

export interface ConfirmedUtxo {
  txid: string;
  vout: number;
  value: number;
}

export interface Esplora {
  tipHeight(): Promise<number>;
  txState(txid: string): Promise<TxState>;
  confirmedUtxos(address: string): Promise<ConfirmedUtxo[]>;
  /**
   * Value at the address that is not yet confirmed — typically the change from a
   * fee bump broadcast in the previous round. Optional so simple fakes can omit it.
   */
  pendingUtxoSats?(address: string): Promise<number>;
  submitPackage(txHexes: string[]): Promise<void>;
  broadcast(txHex: string): Promise<string>;
  recommendedFeeRate(): Promise<number>;
}

type RawUtxo = { txid: string; vout: number; value: number; status?: { confirmed?: boolean } };

/**
 * Browser-safe esplora client.
 *
 * Reads and single-transaction broadcasts are CORS "simple requests": no
 * credentials, no custom headers beyond a text/plain body. Package submission is
 * the exception — it must be application/json (see submitPackage), which
 * triggers a preflight. The regtest instance passes that preflight because POST
 * is a CORS-safelisted method and Content-Type is in its allow-headers.
 */
export function createEsplora(baseUrl: string, fetchImpl: typeof fetch = (...a) => fetch(...a)): Esplora {
  const init = { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" } as const;

  async function text(res: Response): Promise<string> {
    try {
      return (await res.text()).slice(0, 500);
    } catch {
      return "";
    }
  }

  async function utxos(address: string): Promise<RawUtxo[]> {
    const res = await fetchImpl(`${baseUrl}/address/${address}/utxo`, init);
    if (!res.ok) throw new Error(`utxos: HTTP ${res.status}`);
    return (await res.json()) as RawUtxo[];
  }

  return {
    async tipHeight() {
      const res = await fetchImpl(`${baseUrl}/blocks/tip/height`, init);
      if (!res.ok) throw new Error(`tip height: HTTP ${res.status}`);
      return Number((await res.text()).trim());
    },

    async txState(txid) {
      const res = await fetchImpl(`${baseUrl}/tx/${txid}/status`, init);
      if (res.status === 404) return { found: false, confirmed: false };
      if (!res.ok) throw new Error(`tx status ${txid}: HTTP ${res.status} ${await text(res)}`);
      const j = (await res.json()) as { confirmed?: boolean; block_height?: number };
      return { found: true, confirmed: !!j.confirmed, blockHeight: j.block_height };
    },

    async confirmedUtxos(address) {
      return (await utxos(address))
        .filter((u) => u.status?.confirmed)
        .map((u) => ({ txid: u.txid, vout: u.vout, value: u.value }));
    },

    async pendingUtxoSats(address) {
      return (await utxos(address)).filter((u) => !u.status?.confirmed).reduce((sum, u) => sum + u.value, 0);
    },

    async submitPackage(txHexes) {
      // application/json, not text/plain: mempool's backend only accepts a
      // parsed JSON array here. A text/plain body arrives as a string and is
      // rejected with a message it mislabels "submitpackage RPC error {code:-1}"
      // — the request never reaches bitcoind.
      const res = await fetchImpl(`${baseUrl}/txs/package`, {
        ...init,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(txHexes),
      });
      const body = await text(res);
      if (!res.ok) throw new Error(`package rejected: HTTP ${res.status} ${body}`);
      let parsed: { package_msg?: string } | null = null;
      try {
        parsed = JSON.parse(body) as { package_msg?: string };
      } catch {
        // A non-JSON 2xx body is taken as acceptance.
      }
      if (parsed?.package_msg && parsed.package_msg !== "success") {
        throw new Error(`package rejected: ${body}`);
      }
    },

    async broadcast(txHex) {
      const res = await fetchImpl(`${baseUrl}/tx`, {
        ...init,
        method: "POST",
        headers: { "Content-Type": "text/plain" },
        body: txHex,
      });
      const body = await text(res);
      if (!res.ok) throw new Error(`broadcast rejected: HTTP ${res.status} ${body}`);
      return body.trim();
    },

    async recommendedFeeRate() {
      const res = await fetchImpl(`${baseUrl}/v1/fees/recommended`, init);
      if (!res.ok) return 1;
      const j = (await res.json()) as { halfHourFee?: number };
      return Math.max(1, Math.ceil(j.halfHourFee ?? 1));
    },
  };
}

/* ------------------------------------------------------------------ */
/* signing                                                             */
/* ------------------------------------------------------------------ */

/**
 * Signs the fee-key inputs of a CPFP fee-bump PSBT built by the SDK's
 * constructFeeBumpTx, and returns the child transaction as hex.
 *
 * Inputs paying the fee key's P2WPKH script are signed. The input spending the
 * parent's zero-value ephemeral anchor needs no signature — it is spent with an
 * empty witness — and is finalized that way so the child serializes completely.
 */
export function signFeeBumpPsbt(psbtHex: string, feeKey: HDKey): string {
  const tx = btc.Transaction.fromPSBT(fromHex(psbtHex), PARSE);
  const own = toHex(feeKeyScript(feeKey));
  let signed = 0;
  for (let i = 0; i < tx.inputsLength; i++) {
    const input = tx.getInput(i);
    const script = input.witnessUtxo?.script;
    if (script && toHex(script) === own) {
      tx.signIdx(privateKeyOf(feeKey), i);
      tx.finalizeIdx(i);
      signed++;
      continue;
    }
    const isAnchor = input.witnessUtxo?.amount === 0n;
    if (isAnchor && !input.finalScriptWitness && !input.finalScriptSig) {
      tx.updateInput(i, { finalScriptWitness: [] }, true);
    }
  }
  if (signed === 0) throw new Error("The fee-bump transaction spends nothing the fee key controls.");
  return toHex(tx.toBytes(true, true));
}

export type SweepResult =
  | { ok: true; hex: string; txid: string; amountSats: number; feeSats: number }
  | { ok: false; reason: string };

/** Spends a confirmed refund output to the destination, signed with the leaf key. */
export function buildSweep(opts: {
  refundTx: Uint8Array | string;
  leafKey: HDKey;
  destination: string;
  network: ExitNetwork;
  feeRate: number;
}): SweepResult {
  const refund = parseTx(opts.refundTx);
  const refundTxid = txidOf(refund);
  const script = leafRefundScript(opts.leafKey);
  const scriptHex = toHex(script);

  let vout = -1;
  let amount = 0n;
  for (let i = 0; i < refund.outputsLength; i++) {
    const o = refund.getOutput(i);
    if (o.script && toHex(o.script) === scriptHex) {
      vout = i;
      amount = o.amount ?? 0n;
      break;
    }
  }
  if (vout < 0) {
    return { ok: false, reason: "The refund transaction does not pay this wallet's key for that leaf." };
  }

  const xonly = publicKeyOf(opts.leafKey).slice(1);
  const net = bitcoinNetwork(opts.network);
  const build = (out: bigint) => {
    const t = new btc.Transaction();
    t.addInput({ txid: refundTxid, index: vout, witnessUtxo: { script, amount }, tapInternalKey: xonly });
    t.addOutputAddress(opts.destination, out, net);
    t.sign(privateKeyOf(opts.leafKey));
    t.finalize();
    return t;
  };

  try {
    // Size does not depend on the output amount, so a probe gives the real vsize.
    const probe = build(amount > 1_000n ? amount - 500n : amount);
    const feeSats = BigInt(Math.max(probe.vsize, Math.ceil(probe.vsize * opts.feeRate)));
    const out = amount - feeSats;
    if (out < BigInt(DUST_LIMIT_SATS)) {
      return {
        ok: false,
        reason: `Only ${out} sats would remain after the ${feeSats}-sat sweep fee — below the ${DUST_LIMIT_SATS}-sat dust limit.`,
      };
    }
    const final = build(out);
    return { ok: true, hex: final.hex, txid: final.id, amountSats: Number(out), feeSats: Number(feeSats) };
  } catch (e) {
    return { ok: false, reason: `Could not build the sweep: ${e instanceof Error ? e.message : String(e)}` };
  }
}

/* ------------------------------------------------------------------ */
/* the exit job                                                        */
/* ------------------------------------------------------------------ */

export interface ExitNode {
  id: string;
  parentNodeId?: string;
  status?: string;
  value: number;
  nodeTx: Uint8Array;
  refundTx: Uint8Array;
}

interface StoredNode {
  id: string;
  parentNodeId?: string;
  status?: string;
  value: number;
  nodeTx: string;
  refundTx: string;
}

export interface ExitJob {
  version: 1;
  network: ExitNetwork;
  destination: string;
  feeRate: number;
  createdAt: number;
  /** Leaves being exited, all at or above the dust limit. */
  leafIds: string[];
  /** Every exited leaf and all of its ancestors, captured while the operators were reachable. */
  nodes: StoredNode[];
  /** leafId → sweep txid, once broadcast. */
  sweeps: Record<string, string>;
  log: { at: number; msg: string }[];
  finishedAt?: number;
}

type StepKind = "node" | "refund";

export type LeafProgress =
  | { leafId: string; state: "broadcast" | "in-mempool" | "waiting-parent"; step: number; of: number; kind: StepKind; txid: string }
  | { leafId: string; state: "timelock"; step: number; of: number; kind: StepKind; txid: string; blocksLeft: number }
  | { leafId: string; state: "needs-funding"; step: number; of: number; kind: StepKind; txid: string; detail?: string }
  /**
   * Ready to broadcast, but the only fee money is change from a fee bump sent
   * earlier and still unconfirmed. Resolves on its own within a block — this is
   * not the same as the fee address being empty.
   */
  | { leafId: string; state: "waiting-fee"; step: number; of: number; kind: StepKind; txid: string; pendingSats: number }
  | { leafId: string; state: "error"; detail: string }
  | { leafId: string; state: "sweep-broadcast"; txid: string; amountSats: number }
  | { leafId: string; state: "swept"; txid: string; confirmed: boolean }
  | { leafId: string; state: "unsweepable"; reason: string };

export interface SdkUtxo {
  txid: string;
  vout: number;
  value: bigint;
  script: string;
  publicKey: string;
}

export interface ExitDeps {
  esplora: Esplora;
  root: HDKey;
  /** The SDK's buildUnilateralExitChain, injected so rounds can be tested without the SDK. */
  buildChain(leaf: ExitNode, nodeMap: Map<string, ExitNode>): Promise<ExitNode[]>;
  /** The SDK's constructFeeBumpTx. */
  constructFeeBump(parentTxHex: string, utxos: SdkUtxo[], feeRate: { satPerVbyte: number }): {
    feeBumpPsbt: string;
    usedUtxos: SdkUtxo[];
  };
  /** Defaults to signFeeBumpPsbt with the derived fee key. */
  signFeeBump?(psbtHex: string): string;
  now?(): number;
}

export function createExitJob(opts: {
  network: ExitNetwork;
  destination: string;
  feeRate: number;
  leafIds: string[];
  nodes: ExitNode[];
  now?: number;
}): ExitJob {
  try {
    btc.Address(bitcoinNetwork(opts.network)).decode(opts.destination);
  } catch {
    throw new Error(`That is not a valid ${opts.network === "MAINNET" ? "Bitcoin" : "regtest"} address.`);
  }
  if (!opts.leafIds.length) throw new Error("There are no leaves above the dust limit to exit.");
  return {
    version: 1,
    network: opts.network,
    destination: opts.destination,
    feeRate: Math.max(1, opts.feeRate),
    createdAt: opts.now ?? Date.now(),
    leafIds: [...opts.leafIds],
    nodes: opts.nodes.map((n) => ({
      id: n.id,
      parentNodeId: n.parentNodeId,
      status: n.status,
      value: n.value,
      nodeTx: toHex(n.nodeTx),
      refundTx: toHex(n.refundTx),
    })),
    sweeps: {},
    log: [],
  };
}

function appendLog(job: ExitJob, msg: string, now: number) {
  job.log.push({ at: now, msg });
  if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
}

/**
 * One round of the exit: look at the chain, do everything that can be done
 * right now, report where each leaf stands, and return.
 *
 * Never throws for a single leaf's problem — one leaf stuck behind a timelock
 * or a rejected broadcast must not stall the others.
 */
export async function runExitRound(
  input: ExitJob,
  deps: ExitDeps,
): Promise<{ job: ExitJob; tip: number; progress: LeafProgress[]; done: boolean }> {
  const job: ExitJob = structuredClone(input);
  const now = deps.now ?? (() => Date.now());
  const feeKey = deriveFeeKey(deps.root);
  const signChild = deps.signFeeBump ?? ((psbt: string) => signFeeBumpPsbt(psbt, feeKey));

  const nodeMap = new Map<string, ExitNode>(
    job.nodes.map((n) => [
      n.id,
      { id: n.id, parentNodeId: n.parentNodeId, status: n.status, value: n.value, nodeTx: fromHex(n.nodeTx), refundTx: fromHex(n.refundTx) },
    ]),
  );

  const tip = await deps.esplora.tipHeight();
  const feeAddress = feeKeyAddress(feeKey, job.network);
  const feeScript = toHex(feeKeyScript(feeKey));
  const feePub = toHex(publicKeyOf(feeKey));
  let pool: SdkUtxo[] = (await deps.esplora.confirmedUtxos(feeAddress)).map((u) => ({
    txid: u.txid,
    vout: u.vout,
    value: BigInt(u.value),
    script: feeScript,
    publicKey: feePub,
  }));

  // Fetched only if some leaf runs out of confirmed fee money this round.
  let pendingFeeSats: number | null = null;
  const pendingFee = async () => {
    if (pendingFeeSats === null) {
      pendingFeeSats = deps.esplora.pendingUtxoSats ? await deps.esplora.pendingUtxoSats(feeAddress) : 0;
    }
    return pendingFeeSats;
  };

  const stateCache = new Map<string, TxState>();
  const txState = async (txid: string) => {
    let s = stateCache.get(txid);
    if (!s) {
      s = await deps.esplora.txState(txid);
      stateCache.set(txid, s);
    }
    return s;
  };

  const progress: LeafProgress[] = [];

  for (const leafId of job.leafIds) {
    try {
      const sweepTxid = job.sweeps[leafId];
      if (sweepTxid) {
        const s = await txState(sweepTxid);
        progress.push({ leafId, state: "swept", txid: sweepTxid, confirmed: s.confirmed });
        continue;
      }

      const leaf = nodeMap.get(leafId);
      if (!leaf) {
        progress.push({ leafId, state: "unsweepable", reason: "This leaf is missing from the captured bundle." });
        continue;
      }

      const chain = await deps.buildChain(leaf, nodeMap);
      const steps = [
        ...chain.map((n) => ({ kind: "node" as const, raw: n.nodeTx })),
        { kind: "refund" as const, raw: leaf.refundTx },
      ];

      let blocked = false;
      for (let i = 0; i < steps.length; i++) {
        const tx = parseTx(steps[i].raw);
        const txid = txidOf(tx);
        const base = { leafId, step: i + 1, of: steps.length, kind: steps[i].kind, txid };
        const s = await txState(txid);
        if (s.confirmed) continue;

        // Already in a mempool — possibly broadcast by this very round for a
        // leaf sharing the same ancestor. Either way, wait for it to confirm.
        if (s.found) {
          progress.push({ ...base, state: "in-mempool" });
          blocked = true;
          break;
        }

        const firstInput = tx.getInput(0);
        const parentTxid =
          i === 0 ? (firstInput.txid ? toHex(firstInput.txid) : "") : txidOf(parseTx(steps[i - 1].raw));
        const parent = parentTxid ? await txState(parentTxid) : { found: false, confirmed: false };
        if (!parent.confirmed || parent.blockHeight === undefined) {
          progress.push({ ...base, state: "waiting-parent" });
          blocked = true;
          break;
        }

        const left = blocksUntilSpendable(relativeBlockLock(firstInput.sequence), parent.blockHeight, tip);
        if (left > 0) {
          progress.push({ ...base, state: "timelock", blocksLeft: left });
          blocked = true;
          break;
        }

        if (pool.length === 0) {
          const pending = await pendingFee();
          progress.push(
            pending > 0 ? { ...base, state: "waiting-fee", pendingSats: pending } : { ...base, state: "needs-funding" },
          );
          blocked = true;
          break;
        }

        let bump: { feeBumpPsbt: string; usedUtxos: SdkUtxo[] };
        try {
          bump = deps.constructFeeBump(toHex(steps[i].raw), pool, { satPerVbyte: job.feeRate });
        } catch (e) {
          progress.push({ ...base, state: "needs-funding", detail: e instanceof Error ? e.message : String(e) });
          blocked = true;
          break;
        }

        const child = signChild(bump.feeBumpPsbt);
        await deps.esplora.submitPackage([toHex(steps[i].raw), child]);

        const used = new Set(bump.usedUtxos.map((u) => `${u.txid}:${u.vout}`));
        pool = pool.filter((u) => !used.has(`${u.txid}:${u.vout}`));
        // The change from this bump is unconfirmed until the next block.
        pendingFeeSats = null;
        stateCache.set(txid, { found: true, confirmed: false });
        appendLog(job, `Broadcast ${steps[i].kind} ${i + 1}/${steps.length} for leaf ${leafId.slice(0, 8)}: ${txid}`, now());
        progress.push({ ...base, state: "broadcast" });
        blocked = true;
        break;
      }
      if (blocked) continue;

      // Every transaction down to the refund is confirmed: sweep it.
      const sweep = buildSweep({
        refundTx: leaf.refundTx,
        leafKey: deriveLeafKey(deps.root, leafId),
        destination: job.destination,
        network: job.network,
        feeRate: job.feeRate,
      });
      if (!sweep.ok) {
        progress.push({ leafId, state: "unsweepable", reason: sweep.reason });
        continue;
      }
      const returned = await deps.esplora.broadcast(sweep.hex);
      const txid = /^[0-9a-f]{64}$/i.test(returned) ? returned.toLowerCase() : sweep.txid;
      job.sweeps[leafId] = txid;
      appendLog(job, `Swept leaf ${leafId.slice(0, 8)}: ${sweep.amountSats} sats to ${job.destination} in ${txid}`, now());
      progress.push({ leafId, state: "sweep-broadcast", txid, amountSats: sweep.amountSats });
    } catch (e) {
      progress.push({ leafId, state: "error", detail: e instanceof Error ? e.message : String(e) });
    }
  }

  const done =
    progress.length === job.leafIds.length &&
    progress.every((p) => (p.state === "swept" && p.confirmed) || p.state === "unsweepable");
  if (done && !job.finishedAt) job.finishedAt = now();

  return { job, tip, progress, done };
}

/**
 * Captures every leaf worth exiting and all of its ancestors from the
 * operators. This is the one step that needs them online, which is why it runs
 * once at the start and the result is stored.
 *
 * Reaches into the wallet's connection manager and config, neither of which the
 * SDK exposes publicly; buildUnilateralExitChain needs exactly this data, and
 * query_nodes with includeParents is how the SDK itself fetches it.
 */
export async function captureExitNodes(
  wallet: SparkWallet,
): Promise<{ leafIds: string[]; nodes: ExitNode[]; dustLeaves: number }> {
  const leaves = await wallet.getLeaves();
  const exitable = leaves.filter((l) => l.value >= DUST_LIMIT_SATS);
  if (!exitable.length) return { leafIds: [], nodes: [], dustLeaves: leaves.length };

  type RawNode = {
    id: string;
    parentNodeId?: string;
    status?: string;
    value: number;
    nodeTx?: Uint8Array;
    refundTx?: Uint8Array;
  };
  const internals = wallet as unknown as {
    connectionManager: {
      createSparkClient(address: string): Promise<{ query_nodes(req: unknown): Promise<{ nodes: Record<string, RawNode> }> }>;
    };
    config: { getCoordinatorAddress(): string; getNetworkProto(): unknown };
  };
  const client = await internals.connectionManager.createSparkClient(internals.config.getCoordinatorAddress());
  const response = await client.query_nodes({
    source: { $case: "nodeIds", nodeIds: { nodeIds: exitable.map((l) => l.id) } },
    includeParents: true,
    network: internals.config.getNetworkProto(),
  });

  const nodes: ExitNode[] = Object.values(response.nodes).map((n) => ({
    id: n.id,
    parentNodeId: n.parentNodeId,
    status: n.status,
    value: n.value,
    nodeTx: n.nodeTx ?? new Uint8Array(),
    refundTx: n.refundTx ?? new Uint8Array(),
  }));

  return { leafIds: exitable.map((l) => l.id), nodes, dustLeaves: leaves.length - exitable.length };
}
