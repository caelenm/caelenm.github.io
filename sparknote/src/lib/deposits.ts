/**
 * On-chain deposits to the static deposit address.
 *
 * Bitcoin sent to that address does not credit by itself. The SSP has to quote
 * a fee for converting it into a Spark leaf, and the wallet has to accept that
 * quote and claim it — the Spark SDK has no background claimer. A claim only
 * succeeds once the deposit has DEPOSIT_CONFIRMATIONS confirmations.
 *
 * Source: https://docs.spark.money/wallets/deposit-from-l1 — "claimStaticDeposit
 * will only succeed after the deposit transaction has 3 confirmations."
 */
export const DEPOSIT_CONFIRMATIONS = 3;

export interface DepositOutput {
  valueSats: number | null;
  /** 0 while unconfirmed. */
  confirmations: number;
}

/** Reads a deposit output's value and depth from an esplora API. Never throws. */
export async function depositOutput(
  esploraBase: string,
  txid: string,
  vout: number,
  fetchImpl: typeof fetch = (...a) => fetch(...a),
): Promise<DepositOutput> {
  const init = { cache: "no-store", credentials: "omit", referrerPolicy: "no-referrer" } as const;
  try {
    const res = await fetchImpl(`${esploraBase}/tx/${txid}`, init);
    if (!res.ok) return { valueSats: null, confirmations: 0 };
    const tx = (await res.json()) as {
      vout?: { value?: number }[];
      status?: { confirmed?: boolean; block_height?: number };
    };
    const valueSats = typeof tx.vout?.[vout]?.value === "number" ? tx.vout[vout].value! : null;
    if (!tx.status?.confirmed || tx.status.block_height === undefined) return { valueSats, confirmations: 0 };
    const tipRes = await fetchImpl(`${esploraBase}/blocks/tip/height`, init);
    const tip = tipRes.ok ? Number((await tipRes.text()).trim()) : NaN;
    const confirmations = Number.isFinite(tip) ? Math.max(1, tip - tx.status.block_height + 1) : 1;
    return { valueSats, confirmations };
  } catch {
    return { valueSats: null, confirmations: 0 };
  }
}
