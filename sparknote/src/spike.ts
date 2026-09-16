/**
 * Step 1 of the build order: prove the SDK works in a browser before anything
 * else is built on top of it. Not part of the shipped app — `npm run dev` then
 * open /spike.html.
 *
 * What this must establish:
 *   1. The WASM FROST signer loads and signs in-browser under Vite.
 *   2. Operator calls with an Authorization header actually succeed
 *      (buildonspark/spark#152 — the CORS preflight risk).
 *   3. An invoice can be created client-side.
 */
import { SparkWallet } from "@buildonspark/spark-sdk";
import { generateMnemonic, wordlist } from "./lib/mnemonic";

const logEl = document.getElementById("log")!;
const line = (msg: string, cls = "") => {
  const d = document.createElement("div");
  if (cls) d.className = cls;
  d.textContent = msg;
  logEl.appendChild(d);
  console.log(msg);
};

async function step<T>(label: string, fn: () => Promise<T>): Promise<T | undefined> {
  const t0 = performance.now();
  try {
    const out = await fn();
    line(`OK   ${label}  (${Math.round(performance.now() - t0)}ms)`, "ok");
    return out;
  } catch (e) {
    line(`FAIL ${label}: ${e instanceof Error ? e.message : String(e)}`, "err");
    console.error(e);
    return undefined;
  }
}

async function main() {
  line(`wordlist loaded: ${wordlist.length} words`, "dim");

  const mnemonic = generateMnemonic();
  line(`mnemonic: ${mnemonic.split(" ").slice(0, 2).join(" ")} … (${mnemonic.split(" ").length} words)`, "dim");

  const init = await step("SparkWallet.initialize (regtest)", () =>
    SparkWallet.initialize({
      mnemonicOrSeed: mnemonic,
      options: { network: "REGTEST" },
    }),
  );
  if (!init) {
    line("--- stopped: init failed. If this is a CORS/preflight error on the", "err");
    line("    Authorization header, spark#152 has become blocking. ---", "err");
    return;
  }
  const wallet = init.wallet;

  const addr = await step("getSparkAddress", () => wallet.getSparkAddress());
  if (addr) line(`  ${addr}`, "dim");

  const pubkey = await step("getIdentityPublicKey", () => wallet.getIdentityPublicKey());
  if (pubkey) line(`  ${pubkey}`, "dim");

  const bal = await step("getBalance", () => wallet.getBalance());
  if (bal) line(`  available=${bal.satsBalance.available} owned=${bal.satsBalance.owned} incoming=${bal.satsBalance.incoming}`, "dim");

  const dep = await step("getStaticDepositAddress", () => wallet.getStaticDepositAddress());
  if (dep) line(`  ${dep}`, "dim");

  const inv = await step("createLightningInvoice(1000 sats)", () =>
    wallet.createLightningInvoice({ amountSats: 1000, memo: "spike", expirySeconds: 600 }),
  );
  if (inv) line(`  ${inv.invoice.encodedInvoice.slice(0, 70)}…`, "dim");

  await step("getTransfers", () => wallet.getTransfers(10, 0));

  line("");
  line("Spike complete. If every line above is OK, spark#152 is not blocking", "ok");
  line("and the whole static-app approach holds.", "ok");
}

main().catch((e) => line(`unhandled: ${e}`, "err"));
