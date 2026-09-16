/**
 * On-chain deposit detection, against a mock esplora.
 *
 * Run with: node --experimental-strip-types src/lib/deposits.test.ts
 *
 * Bitcoin sent to the static deposit address does not credit itself: the wallet
 * reads the output, waits for DEPOSIT_CONFIRMATIONS, then claims it against an
 * SSP quote. What matters here is that the confirmation count is never
 * overstated — claiming too early fails, and reporting a deposit as spendable
 * before it is confirmed is a lie about money.
 */
import { DEPOSIT_CONFIRMATIONS, depositOutput } from "./deposits.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
}

const BASE = "https://esplora.test";
const TXID = "aa".repeat(32);

/**
 * A mock esplora. `tx` is the /tx/:txid body; `tip` the chain tip height.
 * Anything set to null responds 404.
 */
function mockEsplora(opts: { tx?: unknown | null; tip?: number | null; throws?: boolean }) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(String(url));
    if (opts.throws) throw new Error("network down");
    if (String(url).endsWith("/blocks/tip/height")) {
      if (opts.tip === null || opts.tip === undefined) return { ok: false } as Response;
      return { ok: true, text: async () => `${opts.tip}\n` } as Response;
    }
    if (opts.tx === null) return { ok: false } as Response;
    return { ok: true, json: async () => opts.tx } as Response;
  }) as unknown as typeof fetch;
  return { fetchImpl, urls };
}

const confirmedTx = (height: number, value = 100_000) => ({
  vout: [{ value }, { value: 7 }],
  status: { confirmed: true, block_height: height },
});

/* --- unconfirmed ----------------------------------------------------------- */
{
  const { fetchImpl } = mockEsplora({ tx: { vout: [{ value: 50_000 }], status: { confirmed: false } } });
  const out = await depositOutput(BASE, TXID, 0, fetchImpl);
  check("an unconfirmed deposit reports its value", out.valueSats, 50_000);
  check("but zero confirmations", out.confirmations, 0);
  check("so it is not yet claimable", out.confirmations >= DEPOSIT_CONFIRMATIONS, false);
}

/* --- confirmation arithmetic ----------------------------------------------- */
{
  // Mined in the tip block: that is one confirmation, not zero.
  const { fetchImpl } = mockEsplora({ tx: confirmedTx(100), tip: 100 });
  const out = await depositOutput(BASE, TXID, 0, fetchImpl);
  check("a deposit in the tip block has 1 confirmation", out.confirmations, 1);
}

{
  const { fetchImpl } = mockEsplora({ tx: confirmedTx(100), tip: 102 });
  check("two blocks later is 3 confirmations", (await depositOutput(BASE, TXID, 0, fetchImpl)).confirmations, 3);
}

{
  const { fetchImpl } = mockEsplora({ tx: confirmedTx(100), tip: 101 });
  const out = await depositOutput(BASE, TXID, 0, fetchImpl);
  check("one block short is 2 confirmations", out.confirmations, 2);
  check("and is still not claimable", out.confirmations >= DEPOSIT_CONFIRMATIONS, false);
}

{
  const { fetchImpl } = mockEsplora({ tx: confirmedTx(100), tip: 102 });
  const out = await depositOutput(BASE, TXID, 0, fetchImpl);
  check("exactly DEPOSIT_CONFIRMATIONS is claimable", out.confirmations >= DEPOSIT_CONFIRMATIONS, true);
}

{
  // A reorg can leave the tip below the block the deposit claimed to be in.
  // The count must never go negative or read as "deeply confirmed".
  const { fetchImpl } = mockEsplora({ tx: confirmedTx(200), tip: 100 });
  const out = await depositOutput(BASE, TXID, 0, fetchImpl);
  check("a tip behind the block never goes negative", out.confirmations, 1);
}

/* --- reading the right output ---------------------------------------------- */
{
  const { fetchImpl } = mockEsplora({ tx: confirmedTx(100), tip: 100 });
  check("vout 1 reads its own value", (await depositOutput(BASE, TXID, 1, fetchImpl)).valueSats, 7);
}

{
  const { fetchImpl } = mockEsplora({ tx: confirmedTx(100), tip: 100 });
  check("a vout past the end is null, not undefined", (await depositOutput(BASE, TXID, 9, fetchImpl)).valueSats, null);
}

{
  const { fetchImpl } = mockEsplora({ tx: { vout: [{}], status: { confirmed: true, block_height: 100 } }, tip: 100 });
  check("a missing value is null", (await depositOutput(BASE, TXID, 0, fetchImpl)).valueSats, null);
}

/* --- failure is never a credit --------------------------------------------- */
{
  const { fetchImpl } = mockEsplora({ tx: null });
  const out = await depositOutput(BASE, TXID, 0, fetchImpl);
  check("an unknown txid reports nothing", out, { valueSats: null, confirmations: 0 });
}

{
  const { fetchImpl } = mockEsplora({ throws: true });
  const out = await depositOutput(BASE, TXID, 0, fetchImpl);
  check("a network failure never throws", out, { valueSats: null, confirmations: 0 });
}

{
  // The tip is unreadable, so depth is unknown. It falls back to 1 — known
  // confirmed, depth unproven — and must not reach the claim threshold.
  const { fetchImpl } = mockEsplora({ tx: confirmedTx(100), tip: null });
  const out = await depositOutput(BASE, TXID, 0, fetchImpl);
  check("an unreadable tip still reports the value", out.valueSats, 100_000);
  check("and assumes the shallowest depth", out.confirmations, 1);
  check("so it does not become claimable by accident", out.confirmations >= DEPOSIT_CONFIRMATIONS, false);
}

{
  const { fetchImpl } = mockEsplora({ tx: { vout: [{ value: 1 }], status: { confirmed: true } }, tip: 100 });
  check("confirmed without a height is treated as unconfirmed", (await depositOutput(BASE, TXID, 0, fetchImpl)).confirmations, 0);
}

/* --- the request itself ---------------------------------------------------- */
{
  const { fetchImpl, urls } = mockEsplora({ tx: confirmedTx(100), tip: 100 });
  await depositOutput(BASE, TXID, 0, fetchImpl);
  check("the tx is fetched by txid", urls[0], `${BASE}/tx/${TXID}`);
  check("the tip is fetched too", urls[1], `${BASE}/blocks/tip/height`);
  // No tip request is worth making if the tx was never found.
  const second = mockEsplora({ tx: null });
  await depositOutput(BASE, TXID, 0, second.fetchImpl);
  check("an unknown tx does not go on to ask for the tip", second.urls.length, 1);
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
