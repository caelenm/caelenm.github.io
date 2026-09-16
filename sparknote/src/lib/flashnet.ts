/**
 * Flashnet AMM as a SwapProvider for stable balance.
 *
 * Flashnet authenticates by having the Spark wallet sign a challenge — there is
 * no API key, which is the only reason it is usable here at all. Swaps are
 * exact-input only; stable.ts does the searching needed to pay an exact bitcoin
 * amount from USD.
 *
 * Origins contacted: the network's AMM gateway (listed in the CSP). Nothing
 * else — pool selection, quotes, minimums and swaps all go through it.
 */
import { BTC_ASSET_PUBKEY, FlashnetClient, getClientNetworkConfig } from "@flashnet/sdk";
import type { SparkWallet } from "@buildonspark/spark-sdk";
import {
  DEFAULT_SLIPPAGE_BPS,
  USDB_TOKEN,
  type StableNetwork,
  type SwapDirection,
  type SwapMinimums,
  type SwapProvider,
} from "./stable.ts";

/**
 * Every pool this session has seen, by its LP public key.
 *
 * Swapping moves sats to a pool with an ordinary transfer, so without knowing
 * which counterparties are pools the activity list reads a swap as a payment
 * for the whole balance. Identifiers only — no amounts, nothing sensitive.
 */
export const knownPoolIds = new Set<string>();

const MINIMUMS_TTL_MS = 10 * 60_000;
const FALLBACK_MINIMUMS: SwapMinimums = { btcSats: 800n, usdbUnits: 500_000n };

/** Amounts come back as decimal strings in base units; never let a stray "." become NaN. */
function toBigInt(value: string | undefined): bigint {
  if (!value) return 0n;
  const whole = value.split(".")[0];
  return /^-?\d+$/.test(whole) ? BigInt(whole) : 0n;
}

type Pool = {
  lpPublicKey: string;
  assetAAddress: string;
  assetBAddress: string;
  tvlAssetB?: string;
  totalLiquidity?: string;
  assetAReserve?: string;
  assetBReserve?: string;
};

export async function createFlashnetProvider(wallet: SparkWallet, network: StableNetwork): Promise<SwapProvider> {
  const token = USDB_TOKEN[network];
  if (!token) throw new Error("Stable balance is not available on this network — there is no USD stablecoin liquidity.");

  const environment = network === "MAINNET" ? "mainnet" : "regtest";
  const gateway = getClientNetworkConfig(environment).ammGatewayUrl;

  // The SDK is typed against a newer spark-sdk and the issuer SDK; the wallet
  // object is structurally what it needs at runtime.
  const client = new FlashnetClient(wallet as never, {
    sparkNetworkType: network,
    clientEnvironment: environment,
    autoAuthenticate: true,
  });

  let initialized: Promise<void> | null = null;
  const ready = () => (initialized ??= client.initialize());

  let poolId: string | null = null;
  async function pool(): Promise<string> {
    if (poolId) return poolId;
    await ready();
    const seen = new Map<string, Pool>();
    for (const query of [
      { assetAAddress: BTC_ASSET_PUBKEY, assetBAddress: token!.hex },
      { assetAAddress: token!.hex, assetBAddress: BTC_ASSET_PUBKEY },
    ]) {
      const res = await client.listPools({ ...query, sort: "TVL_DESC", limit: 20 });
      for (const p of res.pools as Pool[]) seen.set(p.lpPublicKey, p);
    }
    // Only pools that actually pair the two assets and hold liquidity on both
    // sides. Single-sided launch pools list USDB against BTC but cannot sell
    // bitcoin back.
    const pairs = [...seen.values()].filter((p) => {
      const assets = new Set([p.assetAAddress, p.assetBAddress]);
      if (!assets.has(BTC_ASSET_PUBKEY) || !assets.has(token!.hex)) return false;
      const liquid = toBigInt(p.totalLiquidity) > 0n;
      const bothReserves = toBigInt(p.assetAReserve) > 0n && toBigInt(p.assetBReserve) > 0n;
      return liquid || bothReserves;
    });
    if (!pairs.length) throw new Error("No liquid USDB/BTC pool is available right now.");
    pairs.sort((a, b) => Number(toBigInt(b.tvlAssetB) - toBigInt(a.tvlAssetB)));
    poolId = pairs[0].lpPublicKey;
    // Recorded so the activity list can tell a swap from a payment: a swap is an
    // ordinary Spark transfer whose counterparty happens to be a pool.
    for (const p of seen.keys()) knownPoolIds.add(p);
    knownPoolIds.add(poolId);
    return poolId;
  }

  const assets = (direction: SwapDirection) =>
    direction === "toStable"
      ? { assetInAddress: BTC_ASSET_PUBKEY, assetOutAddress: token.hex }
      : { assetInAddress: token.hex, assetOutAddress: BTC_ASSET_PUBKEY };

  let minimums: { value: SwapMinimums; at: number } | null = null;

  return {
    async minimums() {
      if (minimums && Date.now() - minimums.at < MINIMUMS_TTL_MS) return minimums.value;
      try {
        const res = await fetch(`${gateway}/v1/config/min-amounts`, { credentials: "omit", cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const list = (await res.json()) as { asset_identifier: string; min_amount: string | number; enabled: boolean }[];
        const find = (id: string) => list.find((m) => m.asset_identifier === id && m.enabled);
        const btc = find(BTC_ASSET_PUBKEY);
        const usdb = find(token.hex);
        const value: SwapMinimums = {
          btcSats: btc ? BigInt(btc.min_amount) : FALLBACK_MINIMUMS.btcSats,
          usdbUnits: usdb ? BigInt(usdb.min_amount) : FALLBACK_MINIMUMS.usdbUnits,
        };
        minimums = { value, at: Date.now() };
        return value;
      } catch {
        // Better to assume the published minimums than to refuse every swap.
        return FALLBACK_MINIMUMS;
      }
    },

    async quote(direction, amountIn) {
      const res = await client.simulateSwap({
        poolId: await pool(),
        ...assets(direction),
        amountIn: amountIn.toString(),
      });
      if (res.warningMessage && toBigInt(res.amountOut) === 0n) throw new Error(res.warningMessage);
      return toBigInt(res.amountOut);
    },

    async swap(direction, amountIn, minAmountOut) {
      const res = await client.executeSwap({
        poolId: await pool(),
        ...assets(direction),
        amountIn: amountIn.toString(),
        minAmountOut: minAmountOut.toString(),
        maxSlippageBps: DEFAULT_SLIPPAGE_BPS,
      });
      if (!res.accepted) {
        const refund = res.refundedAmount ? ` ${res.refundedAmount} was refunded.` : "";
        throw new Error(`${res.error ?? "The swap was rejected."}${refund}`);
      }
      return { amountOut: toBigInt(res.amountOut) };
    },
  };
}

/** The spendable USDB balance, in base units, out of the SDK's token balance map. */
export function usdbAvailable(
  tokenBalances: Map<string, { availableToSendBalance: bigint }> | undefined,
  network: StableNetwork,
): bigint {
  const token = USDB_TOKEN[network];
  if (!token || !tokenBalances) return 0n;
  return tokenBalances.get(token.identifier)?.availableToSendBalance ?? 0n;
}
