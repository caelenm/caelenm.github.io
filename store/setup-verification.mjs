#!/usr/bin/env node
// Prepares store attestation: hashes config.json, writes config_hash.txt, and
// records the signature you produce with your Bitcoin wallet.
//
//   node setup-verification.mjs            interactive
//   node setup-verification.mjs --check    verify what is already on disk
//
// Nothing here ever touches a private key. You sign in your own wallet and
// paste the result back.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, exit } from "node:process";

const CONFIG = "config.json";
const HASH_FILE = "config_hash.txt";
const SIG_FILE = "config_hash.sig";

const c = (n, s) => `[${n}m${s}[0m`;
const bold = (s) => c(1, s), dim = (s) => c(2, s);
const ok = (s) => c(32, `✓ ${s}`), bad = (s) => c(31, `✕ ${s}`), warn = (s) => c(33, `! ${s}`);

function sha256Hex(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

function readConfig() {
  if (!existsSync(CONFIG)) {
    console.error(bad(`${CONFIG} not found. Run this from your store directory.`));
    exit(1);
  }
  const raw = readFileSync(CONFIG);           // exact bytes — the browser hashes these too
  let parsed;
  try { parsed = JSON.parse(raw.toString("utf8")); }
  catch (e) { console.error(bad(`${CONFIG} is not valid JSON: ${e.message}`)); exit(1); }
  return { raw, parsed, hash: sha256Hex(raw) };
}

async function check() {
  const { parsed, hash } = readConfig();
  console.log(`\n${bold("Checking store attestation")}\n`);
  console.log(`  config.json sha256   ${hash}`);

  let pass = true;
  if (!existsSync(HASH_FILE)) { console.log(bad(`${HASH_FILE} is missing`)); pass = false; }
  else {
    const stored = readFileSync(HASH_FILE, "utf8").trim().split(/\s+/)[0];
    console.log(`  ${HASH_FILE}     ${stored}`);
    if (stored === hash) console.log(ok("hash file matches config.json"));
    else { console.log(bad("hash file does NOT match config.json — config changed after signing")); pass = false; }
  }
  if (!existsSync(SIG_FILE)) { console.log(bad(`${SIG_FILE} is missing`)); pass = false; }
  else if (readFileSync(SIG_FILE, "utf8").trim().length < 60) {
    console.log(bad(`${SIG_FILE} does not look like a base64 signature`)); pass = false;
  } else console.log(ok("signature file present"));

  const addr = parsed?.store?.signingAddress;
  const url = parsed?.store?.canonicalUrl;
  if (!addr) { console.log(bad("config.store.signingAddress is empty")); pass = false; }
  else console.log(ok(`signing address ${addr}`));
  if (!url) { console.log(bad("config.store.canonicalUrl is empty")); pass = false; }
  else console.log(ok(`canonical URL ${url}`));

  if (addr?.startsWith("bc1p")) {
    console.log(warn("taproot (bc1p) addresses are not supported by the in-browser verifier"));
    pass = false;
  }

  console.log(pass
    ? `\n${ok("Attestation files are consistent. Commit all three.")}\n`
    : `\n${bad("Not ready. Re-run without --check to regenerate.")}\n`);
  exit(pass ? 0 : 1);
}

async function main() {
  if (argv.includes("--check")) return check();

  const { parsed, hash } = readConfig();

  // Without a terminal every prompt reads EOF instantly, so the script would
  // race to the end and look like it did nothing. Say so, and still be useful.
  if (!stdin.isTTY) {
    console.log(`
${bold("Store verification setup")}

This step is interactive, but nothing is attached to the keyboard here
(stdin is not a terminal). Run it directly in your shell:

    ./setup-verification.sh

Meanwhile, here is what it would have told you.

  config.json sha256:
    ${bold(hash)}

  Sign that exact string with the Bitcoin address you want buyers to trust,
  then save the base64 signature to ${SIG_FILE} and the hash to ${HASH_FILE}.

  Check the result at any time with:
    ./setup-verification.sh --check
`);
    exit(0);
  }

  const rl = createInterface({ input: stdin, output: stdout });
  const ask = async (q, def) => {
    const a = (await rl.question(def ? `${q} ${dim(`[${def}]`)}: ` : `${q}: `)).trim();
    return a || def || "";
  };

  console.log(`
${bold("Store verification setup")}

This lets buyers confirm the page they are looking at really is your store,
and lets you verify orders later. It is optional but recommended.

You will need a Bitcoin wallet that can sign messages — Electrum, Sparrow, or
Bitcoin Core. ${bold("Your private key never leaves your wallet")}; this script only
records the signature you paste back.
`);

  console.log(bold("Step 1 of 4 — the address buyers will trust\n"));
  const address = await ask("Bitcoin address you will sign with", parsed?.store?.signingAddress);
  if (!address) { console.error(bad("An address is required.")); exit(1); }
  if (address.startsWith("bc1p"))
    console.log(warn("Taproot (bc1p) is not supported by the browser verifier. Use a 1…, 3… or bc1q… address."));

  console.log(bold("\nStep 2 of 4 — where the authoritative copy lives\n"));
  const canonicalUrl = await ask(
    "Raw URL where the canonical config.json will live",
    parsed?.store?.canonicalUrl || "https://raw.githubusercontent.com/USER/REPO/main/config.json");
  if (!canonicalUrl) { console.error(bad("A canonical URL is required.")); exit(1); }
  if (/github\.com\/.+\/blob\//.test(canonicalUrl))
    console.log(warn("That looks like a GitHub HTML page. Use the raw.githubusercontent.com URL instead."));

  // Write the settings into config.json FIRST — they are part of what gets signed.
  const updated = structuredClone(parsed);
  updated.store = { ...updated.store, signingAddress: address, canonicalUrl };
  const body = JSON.stringify(updated, null, 2) + "\n";
  writeFileSync(CONFIG, body, "utf8");

  const finalHash = sha256Hex(Buffer.from(body, "utf8"));
  writeFileSync(HASH_FILE, finalHash + "\n", "utf8");

  console.log(`
${ok(`Updated ${CONFIG} and wrote ${HASH_FILE}`)}

${bold("Step 3 of 4 — sign the hash in your wallet")}

Sign this exact string with that address:

    ${bold(finalHash)}

  ${dim("Electrum")}      Tools → Sign/Verify Message
  ${dim("Sparrow")}       Tools → Sign/Verify Message
  ${dim("Bitcoin Core")}  signmessage "${address}" "${finalHash}"

Paste the base64 signature below (or leave blank to finish later and write
${SIG_FILE} yourself).
`);

  console.log(bold("Step 4 of 4 — paste the signature back\n"));
  const sig = (await rl.question("Signature: ")).trim();
  rl.close();

  if (!sig) {
    console.log(`\n${warn(`No signature recorded. Write it to ${SIG_FILE} before publishing.`)}\n`);
    exit(0);
  }
  writeFileSync(SIG_FILE, sig + "\n", "utf8");

  console.log(`
${ok(`Wrote ${SIG_FILE}`)}

${bold("Commit all three files together:")}

    git add ${CONFIG} ${HASH_FILE} ${SIG_FILE}
    git commit -m "Update store config and attestation"
    git push

${bold("Every time you change config.json, re-run this script")} — the hash changes,
the old signature stops matching, and the store will show as unverified.

Verify at any time with:  node setup-verification.mjs --check
`);
}

main().catch((e) => { console.error(bad(e.message)); exit(1); });
