/** Sats only. No fiat anywhere in v1 (§5). */
export function formatSats(n: number | bigint): string {
  return new Intl.NumberFormat("en-US").format(n);
}

export function relativeTime(ms: number, now = Date.now()): string {
  const d = Math.round((ms - now) / 1000);
  const abs = Math.abs(d);
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (abs < 60) return rtf.format(Math.round(d), "second");
  if (abs < 3600) return rtf.format(Math.round(d / 60), "minute");
  if (abs < 86400) return rtf.format(Math.round(d / 3600), "hour");
  if (abs < 2592000) return rtf.format(Math.round(d / 86400), "day");
  return new Date(ms).toLocaleDateString();
}

export function countdown(msRemaining: number): string {
  if (msRemaining <= 0) return "expired";
  const s = Math.floor(msRemaining / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  if (m > 0) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${s}s`;
}

export function truncateMiddle(s: string, head = 12, tail = 10): string {
  if (s.length <= head + tail + 1) return s;
  return `${s.slice(0, head)}…${s.slice(-tail)}`;
}

/**
 * Turns an SDK or network failure into something a person can act on.
 * Anything unrecognised keeps its original message rather than being replaced
 * by a reassuring lie — in a wallet, a vague error is worse than an ugly one.
 */
export function readableError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  const m = msg.toLowerCase();

  if (m.includes("insufficient") || m.includes("not enough"))
    return "Not enough sats in the wallet for this payment and its fee.";
  if (m.includes("expired")) return "That invoice has expired. Ask for a new one.";
  if (m.includes("no route") || m.includes("route not found") || m.includes("routing"))
    return "No route to the recipient. They may be offline or short of inbound capacity.";
  if (m.includes("already paid") || m.includes("already been paid"))
    return "That invoice has already been paid.";
  if (m.includes("amount") && m.includes("mismatch"))
    return "The invoice amount does not match what was entered.";
  if (m.includes("failed to fetch") || m.includes("networkerror") || m.includes("load failed"))
    return "Could not reach the Spark network. Check your connection and try again.";
  if (m.includes("cors") || m.includes("preflight"))
    return "The browser blocked a request to a Spark operator. This is the known CORS issue — see the README.";
  if (m.includes("timeout") || m.includes("deadline"))
    return "The request timed out. The payment may still settle — check activity before retrying.";
  if (m.includes("unauthenticated") || m.includes("authentication"))
    return "The operators rejected this session. Lock and unlock the wallet to reconnect.";

  return msg || "Something went wrong.";
}
