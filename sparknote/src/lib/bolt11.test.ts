/**
 * BOLT11 decoder checks against the official test vectors from the spec.
 * Run with: node --experimental-strip-types src/lib/bolt11.test.ts
 */
import { decodeInvoice, parseHrp } from "./bolt11.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
}

// "Please send $3 for a cup of coffee to the same peer, within one minute"
const COFFEE =
  "lnbc2500u1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdq5xysxxatsyp3k7enxv4jsxqzpuaztrnwngzn3kdzw5hydlzf03qdgm2hdq27cqv3agm2awhz5se903vruatfhq77w3ls4evs3ch9zw97j25emudupq63nyw24cg27h2rspfj9srp";

// "Please make a donation of any amount" — no amount in the prefix
const DONATION =
  "lnbc1pvjluezpp5qqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqqqsyqcyq5rqwzqfqypqdpl2pkx2ctnv5sxxmmwwd5kgetjypeh2ursdae8g6twvus8g6rfwvs8qun0dfjkxaq8rkx3yf5tcsyz3d73gafnh3cax9rn449d9p5uxz9ezhhypd0elx87sjle52x86fux2ypatgddc6k63n7erqz25le42c4u4ecky03ylcqca784w";

/**
 * A real invoice with one character altered, so the bech32 checksum no longer
 * holds. A wallet that accepted this would show the user an amount nobody
 * signed for.
 */
const CORRUPTED = COFFEE.slice(0, 60) + (COFFEE[60] === "q" ? "p" : "q") + COFFEE.slice(61);

const coffee = decodeInvoice(COFFEE);
check("coffee decodes", coffee !== null, true);
check("coffee network", coffee?.network, "mainnet");
check("coffee amount (2500u = 250000 sats)", coffee?.amountSats, 250_000);
check("coffee description", coffee?.description, "1 cup coffee");
check("coffee expiry", coffee?.expirySeconds, 60);
check("coffee timestamp", coffee?.timestamp, 1496314658);
check(
  "coffee payment hash",
  coffee?.paymentHash,
  "0001020304050607080900010203040506070809000102030405060708090102",
);

const donation = decodeInvoice(DONATION);
check("donation decodes", donation !== null, true);
check("donation has no amount", donation?.amountSats, null);
check("donation description", donation?.description, "Please consider supporting this project");
check("donation default expiry", donation?.expirySeconds, 3600);

check("a single altered character is rejected", decodeInvoice(CORRUPTED), null);

// Human-readable part: every network and every multiplier. A signed invoice
// cannot be fabricated for a test, but this is where an amount would silently
// come out wrong, so it is covered directly.
check("mainnet, no amount", parseHrp("lnbc"), { network: "mainnet", amountSats: null });
check("mainnet 2500u", parseHrp("lnbc2500u"), { network: "mainnet", amountSats: 250_000 });
check("testnet 20m", parseHrp("lntb20m"), { network: "testnet", amountSats: 2_000_000 });
check("regtest 10u", parseHrp("lnbcrt10u"), { network: "regtest", amountSats: 1_000 });
check("signet (sb) 100n", parseHrp("lnsb100n"), { network: "signet", amountSats: 10 });
check("signet (tbs) 5m", parseHrp("lntbs5m"), { network: "signet", amountSats: 500_000 });
// 1 BTC with no multiplier.
check("no multiplier = whole BTC", parseHrp("lnbc1"), { network: "mainnet", amountSats: 100_000_000 });
// 1p = 0.1 msat, which must round UP so the confirm screen never understates.
check("sub-satoshi rounds up", parseHrp("lnbc1p"), { network: "mainnet", amountSats: 1 });
check("1000p = 1 sat", parseHrp("lnbc1000p"), { network: "mainnet", amountSats: 1 });
check("not a lightning prefix", parseHrp("lnxx100u"), null);

// Garbage and near-misses must return null rather than throwing.
check("empty", decodeInvoice(""), null);
check("not an invoice", decodeInvoice("hello world"), null);
check("bitcoin address", decodeInvoice("bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq"), null);
check("truncated", decodeInvoice("lnbc2500u1pvjluez"), null);

// The lightning: scheme prefix and upper case (as QR codes encode it) must work.
const upper = decodeInvoice("lightning:" + COFFEE.toUpperCase());
check("scheme prefix + uppercase", upper?.amountSats, 250_000);

// Expiry arithmetic.
check(
  "expiresAt = timestamp + expiry",
  coffee?.expiresAt,
  (1496314658 + 60) * 1000,
);

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
