/**
 * LNURL-pay and Lightning-address resolution.
 *
 * This is the one part of the app that talks to a host neither you nor Spark
 * control, so it is written defensively:
 *
 *   - https only, and never to a loopback or private host.
 *   - Hard timeout and a response size cap.
 *   - The invoice that comes back is decoded locally and its amount is checked
 *     against what was asked for. A payee server that returns an invoice for a
 *     different amount is rejected, not paid.
 *   - No redirect following to a different origin than the user named.
 *
 * The caller is responsible for telling the user their IP is exposed to the
 * recipient's server before any of this runs.
 */
// Explicit .ts extension so `npm test` can load this module under Node's ESM
// resolver, which (unlike Vite) will not guess at extensions.
import { decodeInvoice } from "./bolt11.ts";
import { bech32 } from "@scure/base";

const TIMEOUT_MS = 10_000;
const MAX_BYTES = 64 * 1024;

export class LnurlError extends Error {}

export interface PayParams {
  /** Where to request the invoice from. */
  callback: string;
  minSats: number;
  maxSats: number;
  /** Short human-readable line pulled out of the metadata, if there is one. */
  description?: string;
  /** The host the user is trusting, for display on the confirm screen. */
  host: string;
}

function assertSafeUrl(u: URL): void {
  if (u.protocol !== "https:") {
    throw new LnurlError("Only https endpoints are allowed.");
  }
  const h = u.hostname.toLowerCase();

  // Alternate IPv4 spellings (2130706433, 0x7f000001, 0177.0.0.1) do not need
  // handling here: the URL parser has already normalised them to dotted quads.
  const privateV4 =
    h === "0.0.0.0" ||
    /^127\./.test(h) ||
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^169\.254\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h);

  // IPv6 arrives bracketed and compressed. ::1 is loopback, fc00::/7 is
  // unique-local and fe80::/10 link-local. ::ffff:x.x.x.x embeds an IPv4
  // address, which the parser renders in hex ([::ffff:7f00:1] for 127.0.0.1),
  // so the v4 patterns above would never have matched it.
  const v6 = h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : null;
  const privateV6 =
    v6 !== null &&
    (v6 === "::1" ||
      v6 === "::" ||
      /^f[cd][0-9a-f]{0,2}:/.test(v6) ||
      /^fe[89ab][0-9a-f]?:/.test(v6) ||
      v6.startsWith("::ffff:"));

  const isPrivate = h === "localhost" || h.endsWith(".localhost") || privateV4 || privateV6;
  if (isPrivate) throw new LnurlError("Refusing to contact a private address.");
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const u = new URL(url);
  assertSafeUrl(u);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(u.toString(), {
      signal: ctrl.signal,
      redirect: "error", // a redirect elsewhere is a different host than the user named
      referrerPolicy: "no-referrer",
      credentials: "omit",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
  } catch (e) {
    clearTimeout(timer);
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new LnurlError("The recipient's server did not respond in time.");
    }
    throw new LnurlError("Could not reach the recipient's server.");
  }
  clearTimeout(timer);

  if (!res.ok) throw new LnurlError(`The recipient's server returned ${res.status}.`);

  const text = (await res.text()).slice(0, MAX_BYTES);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new LnurlError("The recipient's server did not return valid JSON.");
  }
  if (typeof body !== "object" || body === null) {
    throw new LnurlError("Unexpected response from the recipient's server.");
  }

  const obj = body as Record<string, unknown>;
  // LNURL signals failure in-band with HTTP 200.
  if (obj.status === "ERROR") {
    throw new LnurlError(typeof obj.reason === "string" ? obj.reason : "The recipient's server refused.");
  }
  return obj;
}

/**
 * `user@example.com` → `https://example.com/.well-known/lnurlp/user`
 *
 * Splits on exactly one "@". Destructuring a multi-"@" address would silently
 * drop the trailing parts and resolve to the wrong host — `a@b@c.com` would
 * contact `b`, not `c.com`.
 */
export function lightningAddressToUrl(address: string): string {
  const parts = address.trim().toLowerCase().split("@");
  if (parts.length !== 2) throw new LnurlError("Not a valid Lightning address.");
  const [name, domain] = parts;
  if (!/^[a-z0-9._-]+$/.test(name)) throw new LnurlError("Not a valid Lightning address.");
  // Domain labels only — no path, port, credentials or anything else that would
  // let the string steer the request somewhere other than the named host. The
  // final label must be alphabetic, which also rules out a bare IPv4 address
  // (assertSafeUrl would catch those too, but rejecting here is clearer).
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.[a-z]{2,}$/.test(domain)) {
    throw new LnurlError("Not a valid Lightning address.");
  }
  return `https://${domain}/.well-known/lnurlp/${encodeURIComponent(name)}`;
}

export function decodeLnurl(input: string): string {
  const s = input.trim().toLowerCase().replace(/^lightning:/, "");
  const { words } = bech32.decode(s as `${string}1${string}`, false);
  const bytes = bech32.fromWords(words);
  return new TextDecoder().decode(bytes);
}

function firstTextFromMetadata(metadata: unknown): string | undefined {
  if (typeof metadata !== "string") return undefined;
  try {
    const parsed: unknown = JSON.parse(metadata);
    if (!Array.isArray(parsed)) return undefined;
    for (const entry of parsed) {
      if (Array.isArray(entry) && entry[0] === "text/plain" && typeof entry[1] === "string") {
        return entry[1];
      }
    }
  } catch {
    /* metadata is optional */
  }
  return undefined;
}

/** Step one: ask the recipient's server what it will accept. */
export async function resolvePayParams(destination: string): Promise<PayParams> {
  const url = destination.includes("@")
    ? lightningAddressToUrl(destination)
    : decodeLnurl(destination);

  const body = await getJson(url);
  if (body.tag !== "payRequest") {
    throw new LnurlError("That address is not set up to receive payments.");
  }
  const callback = body.callback;
  const min = body.minSendable;
  const max = body.maxSendable;
  if (typeof callback !== "string" || typeof min !== "number" || typeof max !== "number") {
    throw new LnurlError("The recipient's server sent an incomplete response.");
  }
  const cb = new URL(callback);
  assertSafeUrl(cb);

  return {
    callback,
    minSats: Math.ceil(min / 1000),
    maxSats: Math.floor(max / 1000),
    description: firstTextFromMetadata(body.metadata),
    host: cb.hostname,
  };
}

/**
 * Step two: request an invoice for a specific amount.
 *
 * The returned invoice is decoded and its amount compared to what was asked.
 * This check is the whole reason this function exists rather than the caller
 * just pasting the `pr` field into the SDK.
 */
export async function requestInvoice(params: PayParams, amountSats: number): Promise<string> {
  if (amountSats < params.minSats || amountSats > params.maxSats) {
    throw new LnurlError(
      `That recipient accepts between ${params.minSats} and ${params.maxSats} sats.`,
    );
  }

  const u = new URL(params.callback);
  u.searchParams.set("amount", String(amountSats * 1000));
  const body = await getJson(u.toString());

  const pr = body.pr;
  if (typeof pr !== "string" || !pr) {
    throw new LnurlError("The recipient's server did not return an invoice.");
  }

  const decoded = decodeInvoice(pr);
  if (!decoded) throw new LnurlError("The recipient returned an invoice this wallet cannot read.");
  if (decoded.amountSats === null) {
    throw new LnurlError("The recipient returned an open-amount invoice, which is not accepted here.");
  }
  if (decoded.amountSats !== amountSats) {
    throw new LnurlError(
      `The recipient asked for ${decoded.amountSats} sats but ${amountSats} was requested. Not paying.`,
    );
  }
  return pr;
}
