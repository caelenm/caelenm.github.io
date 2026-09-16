/**
 * On-chain address validation.
 *
 * Run with: node --experimental-strip-types src/lib/address.test.ts
 *
 * These guard an irreversible action. The cooperative exit used to accept any
 * string longer than twelve characters, so every case below — a flipped
 * character, a mainnet address on regtest — was previously handed straight to
 * the SSP with the user's money behind it.
 */
import { addressNetwork, validateOnchainAddress } from "./address.ts";
import { detect } from "./detect.ts";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
}
const accepts = (label: string, addr: string, net: "MAINNET" | "REGTEST") =>
  check(label, validateOnchainAddress(addr, net).ok, true);
function refuses(label: string, addr: string, net: "MAINNET" | "REGTEST", match?: RegExp) {
  const r = validateOnchainAddress(addr, net);
  const ok = !r.ok && (!match || match.test(r.reason));
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(r)}`}`);
}

/* --- real mainnet addresses, every common type ----------------------------- */
{
  accepts("p2pkh (1…)", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2", "MAINNET");
  accepts("p2sh (3…)", "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy", "MAINNET");
  accepts("p2wpkh (bc1q…)", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "MAINNET");
  accepts("p2tr (bc1p…)", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0", "MAINNET");
  accepts("leading and trailing space is tolerated", "  1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2  ", "MAINNET");
}

/* --- regtest --------------------------------------------------------------- */
{
  accepts("regtest bech32 (bcrt1…)", "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080", "REGTEST");
  check("and it is identified as regtest", addressNetwork("bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080"), "REGTEST");
}

/* --- the cross-chain mistake ----------------------------------------------- */
{
  refuses(
    "a mainnet address on a regtest wallet",
    "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
    "REGTEST",
    /mainnet address.*regtest/i,
  );
  refuses(
    "a regtest address on a mainnet wallet",
    "bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080",
    "MAINNET",
    /regtest address.*mainnet/i,
  );
  // The wording has to be actionable, not just "invalid".
  const r = validateOnchainAddress("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4", "REGTEST");
  check("and it warns about losing the money", !r.ok && /lose the money/i.test(r.reason), true);
}

/* --- typos: the checksum earns its keep ------------------------------------ */
{
  // One character changed in each. Every one of these is a different address
  // nobody holds the key to.
  refuses("bech32 with a flipped character", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5", "MAINNET", /checksum|typo/i);
  refuses("p2tr with a flipped character", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj1", "MAINNET", /checksum|typo/i);
  refuses("base58 with a flipped character", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3", "MAINNET", /checksum|typo/i);
  refuses("a truncated address", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7", "MAINNET");
  refuses("an address with a character appended", "1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2X", "MAINNET");
}

/* --- junk that used to pass the length check ------------------------------- */
{
  // Every one of these is longer than twelve characters, which was the old bar.
  refuses("a sentence", "send it to my other wallet please", "MAINNET");
  refuses("a lightning invoice", "lnbc2500u1pvjluezsp5zyg3zyg3zyg3zyg3zyg3zyg3", "MAINNET");
  refuses("a spark address", "sp1pgss88jsfr948dtgvvwueyk8l4cev3xaf6qn8hhc724kje44mny6cae8h9s0ml", "MAINNET");
  refuses("an email address", "someone@example.com", "MAINNET");
  refuses("a long string of zeroes", "0".repeat(40), "MAINNET");
}

/* --- empty and whitespace -------------------------------------------------- */
{
  refuses("empty", "", "MAINNET", /Enter a Bitcoin address/);
  refuses("only whitespace", "   ", "MAINNET", /Enter a Bitcoin address/);
  refuses(
    "an internal space is called out",
    "bc1qw508d6qejxtdg4 y5r3zarvary0c5xw7kv8f3t4",
    "MAINNET",
    /contains a space/,
  );
}

/* --- addressNetwork -------------------------------------------------------- */
{
  check("mainnet is identified", addressNetwork("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"), "MAINNET");
  check("nonsense belongs to no chain", addressNetwork("not an address"), null);
  check("an empty string belongs to no chain", addressNetwork(""), null);
}

/* --- detect() must not offer a mistyped address as a destination ----------- */
{
  // An address that only matches the shape regex used to be classified as a
  // valid on-chain destination — payable, and offered for the address book,
  // where one typo becomes a permanent, reusable one.
  check("a valid mainnet address is a destination", detect("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4").kind, "onchain");
  check("a valid regtest address is a destination", detect("bcrt1qw508d6qejxtdg4y5r3zarvary0c5xw7kygt080").kind, "onchain");
  check("a valid p2pkh address is a destination", detect("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN2").kind, "onchain");
  check("a mistyped bech32 address is not", detect("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5").kind, "unknown");
  check("a mistyped base58 address is not", detect("1BvBMSEYstWetqTFn5Au4m4GFg7xJaNVN3").kind, "unknown");
  // Still recognises everything else it should.
  check("a spark address still detects", detect("sp1pgss88jsfr948dtgvvwueyk8l4cev3xaf6qn8hhc724kje44mny6cae8h9s0ml").kind, "spark");
  check("a lightning address still detects", detect("alice@example.com").kind, "lightning-address");
}

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
