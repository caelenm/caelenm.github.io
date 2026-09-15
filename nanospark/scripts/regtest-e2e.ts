/**
 * Live end-to-end check against Spark regtest. Opt-in, interactive, and not
 * part of `npm test` — it needs real coins and a person to send them.
 *
 *   npm run regtest
 *
 * It is deliberately a separate script from the suite. The tests under src/ are
 * deterministic and prove the wallet's own logic; this proves the logic matches
 * what the network actually does, which no mock can tell you.
 *
 * Flow:
 *   1. Derives a throwaway regtest wallet and prints its addresses.
 *   2. Waits for you to send regtest sats to the deposit address.
 *   3. Watches confirmations, then claims the deposit and checks the balance.
 *   4. Optionally pays a BOLT11 invoice and verifies the preimage against it.
 *
 * The mnemonic is printed and is throwaway. Do not put real money through it.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { generateMnemonic, mnemonicToSeedSync } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english";
import { SparkWallet } from "@buildonspark/spark-sdk";
import { decodeInvoice } from "../src/lib/bolt11.ts";
import { classifySend } from "../src/lib/lightning.ts";
import { DEPOSIT_CONFIRMATIONS, depositOutput } from "../src/lib/deposits.ts";

const ESPLORA = "https://regtest-mempool.us-west-2.sparkinfra.net/api";
const rl = createInterface({ input: stdin, output: stdout });
const ask = (q: string) => rl.question(q);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
function check(label: string, ok: boolean, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${detail ? `  ${detail}` : ""}`);
}

const mnemonic = process.env.REGTEST_MNEMONIC || generateMnemonic(wordlist);
console.log("\n=== nanospark regtest end-to-end ===\n");
console.log(`mnemonic (throwaway): ${mnemonic}`);
console.log("Re-run with REGTEST_MNEMONIC set to reuse this wallet.\n");

// The seed must be a valid BIP39 one, or nothing below means anything.
check("the mnemonic derives a 64-byte seed", mnemonicToSeedSync(mnemonic).length === 64);

const { wallet } = await SparkWallet.initialize({
  mnemonicOrSeed: mnemonic,
  options: { network: "REGTEST" },
});

const sparkAddress = await wallet.getSparkAddress();
const depositAddress = await wallet.getStaticDepositAddress();
console.log(`\n  spark address:   ${sparkAddress}`);
console.log(`  deposit address: ${depositAddress}\n`);

const startBalance = Number((await wallet.getBalance()).balance);
console.log(`starting balance: ${startBalance} sats`);

/* --- 1. on-chain deposit --------------------------------------------------- */

await ask(`\nSend regtest sats to ${depositAddress}, then press Enter… `);

console.log("\nwatching for the deposit (Ctrl-C to stop)…");
let claimed = false;
for (let poll = 0; poll < 120 && !claimed; poll++) {
  const utxos = await wallet.getUtxosForDepositAddress(depositAddress, 100, 0, true);
  for (const u of utxos) {
    const out = await depositOutput(ESPLORA, u.txid, u.vout);
    console.log(
      `  ${u.txid.slice(0, 12)}…:${u.vout}  ${out.valueSats ?? "?"} sats  ${out.confirmations}/${DEPOSIT_CONFIRMATIONS} conf`,
    );
    if (out.confirmations < DEPOSIT_CONFIRMATIONS) continue;

    check("the deposit output has a value", out.valueSats !== null);
    const quote = await wallet.getClaimStaticDepositQuote(u.txid, u.vout);
    check("the SSP quotes a credit", quote.creditAmountSats > 0, `${quote.creditAmountSats} sats`);
    check(
      "the credit does not exceed the deposit",
      out.valueSats === null || quote.creditAmountSats <= out.valueSats,
      `credit ${quote.creditAmountSats} vs output ${out.valueSats}`,
    );

    await wallet.claimStaticDeposit({
      transactionId: u.txid,
      outputIndex: u.vout,
      creditAmountSats: quote.creditAmountSats,
      sspSignature: quote.signature,
    });

    // The claim is only real once the balance moves.
    let after = startBalance;
    for (let i = 0; i < 30 && after === startBalance; i++) {
      await sleep(2000);
      after = Number((await wallet.getBalance()).balance);
    }
    check("the claim credited the balance", after > startBalance, `${startBalance} -> ${after} sats`);
    check(
      "the balance grew by the quoted credit",
      after - startBalance === quote.creditAmountSats,
      `grew ${after - startBalance}, quoted ${quote.creditAmountSats}`,
    );
    claimed = true;
    break;
  }
  if (!claimed) await sleep(5000);
}
check("a deposit was seen and claimed", claimed);

/* --- 2. lightning send atomicity ------------------------------------------- */

const invoice = (await ask("\nPaste a regtest BOLT11 invoice to pay (Enter to skip): ")).trim();
if (invoice) {
  const decoded = decodeInvoice(invoice);
  check("the invoice decodes", decoded !== null);
  check("it is a regtest invoice", decoded?.network === "regtest", decoded?.network ?? "?");
  check("it carries a payment hash to verify against", Boolean(decoded?.paymentHash));

  const before = Number((await wallet.getBalance()).balance);
  const result = await wallet.payLightningInvoice({ invoice, maxFeeSats: 10 });
  const outcome = classifySend(result, decoded?.paymentHash);
  console.log(`\n  status: ${outcome.status || "(none)"}   state: ${outcome.state}   preimage: ${outcome.preimage}`);

  // The atomicity claim, against the live network: the sats leave only if the
  // receiver was paid, and a payment that did not land is refunded.
  let after = Number((await wallet.getBalance()).balance);
  for (let i = 0; i < 30 && after === before && outcome.state === "in-flight"; i++) {
    await sleep(2000);
    after = Number((await wallet.getBalance()).balance);
  }

  if (outcome.state === "delivered") {
    check("a delivered payment left the wallet", after < before, `${before} -> ${after} sats`);
    if (decoded?.paymentHash) {
      check("delivery was proved by the preimage, not just a status", outcome.preimage === true);
    }
  } else if (outcome.state === "failed") {
    check("a failed payment cost nothing", after === before, `${before} -> ${after} sats`);
  } else {
    console.log("  still in flight — re-check the balance and Activity shortly.");
  }
}

await wallet.cleanup().catch(() => {});
rl.close();

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
