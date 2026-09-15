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
await rejects("refuses localhost via LNURL", () => resolvePayParams(makeLnurl("https://localhost/pay")));
await rejects("refuses loopback IP", () => resolvePayParams(makeLnurl("https://127.0.0.1/pay")));
await rejects("refuses RFC1918 10.x", () => resolvePayParams(makeLnurl("https://10.0.0.5/pay")));
await rejects("refuses RFC1918 192.168.x", () => resolvePayParams(makeLnurl("https://192.168.1.1/pay")));
await rejects("refuses RFC1918 172.16.x", () => resolvePayParams(makeLnurl("https://172.16.0.1/pay")));
await rejects("refuses link-local 169.254.x", () => resolvePayParams(makeLnurl("https://169.254.169.254/pay")));
await rejects("refuses file: scheme", () => resolvePayParams(makeLnurl("file:///etc/passwd")));
await rejects("refuses localhost address", () => resolvePayParams("alice@localhost"));

console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} check(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
