/**
 * LNURL safety checks. This is the only code in the app that contacts a host
 * the user's counterparty chooses, so the guards get tested rather than assumed.
 *
 * Run with: node --experimental-strip-types src/lib/lnurl.test.ts
 */
import { lightningAddressToUrl, resolvePayParams, decodeLnurl, LnurlError } from "./lnurl.ts";
import { bech32 } from "@scure/base";

/** Builds a genuinely valid LNURL for a given target, rather than a hand-typed one. */
function makeLnurl(url: string): string {
  const bytes = new TextEncoder().encode(url);
  return bech32.encode("lnurl", bech32.toWords(bytes), false);
}

let failures = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  got ${JSON.stringify(actual)} want ${JSON.stringify(expected)}`}`);
}

/**
 * Asserts the host was refused *because it is private*, not merely that
 * something threw.
 *
 * `rejects` below is too weak for these: an unreachable host also raises
 * LnurlError ("Could not reach the recipient's server"), so a check for the
 * type alone would still pass with the private-address guard deleted. Matching
 * the refusal message is what makes these tests mean anything — and it also
 * proves no request was ever attempted.
 */
async function refusesPrivate(label: string, url: string) {
  try {
    await resolvePayParams(url.includes("@") ? url : makeLnurl(url));
    failures++;
    console.log(`FAIL ${label}  (did not throw)`);
  } catch (e) {
    const ok = e instanceof LnurlError && /Refusing to contact a private address/.test(e.message);
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  threw ${e}`}`);
  }
}

async function rejects(label: string, fn: () => Promise<unknown>, expectLnurlError = true) {
  try {
    await fn();
    failures++;
    console.log(`FAIL ${label}  (did not throw)`);
  } catch (e) {
    const ok = !expectLnurlError || e instanceof LnurlError;
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} ${label}${ok ? "" : `  threw ${e}`}`);
  }
}

// --- Lightning address → well-known URL -----------------------------------

check(
  "plain address",
  lightningAddressToUrl("alice@example.com"),
  "https://example.com/.well-known/lnurlp/alice",
);
check(
  "uppercase is normalised",
  lightningAddressToUrl("ALICE@Example.COM"),
  "https://example.com/.well-known/lnurlp/alice",
);
check(
  "dots and dashes in the name are allowed",
  lightningAddressToUrl("a.b-c_d@example.com"),
  "https://example.com/.well-known/lnurlp/a.b-c_d",
);

for (const bad of [
  "no-at-sign",
  "two@at@signs.com",
  "@example.com",
  "alice@",
  "alice/../../etc@example.com",
  "alice?x=1@example.com",
  "ali ce@example.com",
  // The domain half must not be able to steer the request elsewhere.
  "alice@example.com/evil.test",
  "alice@example.com:8080",
  "alice@evil.test#example.com",
  "alice@127.0.0.1",
  "alice@localhost",
  "alice@example.com@evil.test",
]) {
  try {
    lightningAddressToUrl(bad);
    failures++;
    console.log(`FAIL rejects "${bad}"  (accepted)`);
  } catch (e) {
    const ok = e instanceof LnurlError;
    if (!ok) failures++;
    console.log(`${ok ? "ok  " : "FAIL"} rejects "${bad}"`);
  }
}

// A name that survives the character filter must still be escaped into the path.
check(
  "name is percent-encoded into the path",
  lightningAddressToUrl("a.b@example.com").endsWith("/lnurlp/a.b"),
  true,
);

// --- URL safety guards ----------------------------------------------------
// These must throw before any network request is attempted.

check(
  "decodeLnurl round-trips",
  decodeLnurl(makeLnurl("https://example.com/pay")),
  "https://example.com/pay",
);
check(
  "decodeLnurl strips a lightning: prefix",
  decodeLnurl("lightning:" + makeLnurl("https://example.com/pay")),
  "https://example.com/pay",
);

await rejects("refuses plain http", () => resolvePayParams(makeLnurl("http://example.com/pay")));
await refusesPrivate("refuses localhost via LNURL", "https://localhost/pay");
await refusesPrivate("refuses loopback IP", "https://127.0.0.1/pay");
await refusesPrivate("refuses RFC1918 10.x", "https://10.0.0.5/pay");
await refusesPrivate("refuses RFC1918 192.168.x", "https://192.168.1.1/pay");
await refusesPrivate("refuses RFC1918 172.16.x", "https://172.16.0.1/pay");
await refusesPrivate("refuses link-local 169.254.x", "https://169.254.169.254/pay");
await rejects("refuses file: scheme", () => resolvePayParams(makeLnurl("file:///etc/passwd")));
await rejects("refuses localhost address", () => resolvePayParams("alice@localhost"));

// Alternate IPv4 spellings. The URL parser normalises these to dotted quads
// before the host check ever sees them, but that is worth pinning down.
await refusesPrivate("refuses decimal-encoded loopback", "https://2130706433/pay");
await refusesPrivate("refuses hex-encoded loopback", "https://0x7f000001/pay");
await refusesPrivate("refuses octal-encoded loopback", "https://017700000001/pay");

// IPv6. These are not reachable by the IPv4 patterns: an embedded IPv4 address
// is re-rendered in hex ([::ffff:127.0.0.1] becomes [::ffff:7f00:1]).
await refusesPrivate("refuses IPv6 loopback", "https://[::1]/pay");
await refusesPrivate("refuses IPv6 unspecified", "https://[::]/pay");
await refusesPrivate("refuses IPv4-mapped loopback", "https://[::ffff:127.0.0.1]/pay");
await refusesPrivate("refuses IPv4-mapped RFC1918", "https://[::ffff:10.0.0.1]/pay");
await refusesPrivate("refuses IPv6 unique-local fd00::/8", "https://[fd00::1]/pay");
await refusesPrivate("refuses IPv6 unique-local fc00::/8", "https://[fc00::1]/pay");
await refusesPrivate("refuses IPv6 link-local fe80::/10", "https://[fe80::1]/pay");

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
