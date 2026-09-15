// Tests for Lightning payment confirmation.
//
//   node test/payment.test.mjs
//
// The code under test is extracted verbatim from the <paywatch> region of
// index.html, so these exercise what actually ships — not a copy that can
// drift. Time and network are injected, so a 2-hour invoice runs instantly.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");

const region = html.match(/\/\* <paywatch> [^\n]*\n([\s\S]*?)\/\* <\/paywatch> \*\//);
if (!region) { console.error("FATAL: <paywatch> region not found in index.html"); process.exit(1); }
const { createPaymentWatcher, readVerifyBody } =
  await import("data:text/javascript," + encodeURIComponent(
    region[1] + "\nexport { createPaymentWatcher, readVerifyBody };"));

/* ── a controllable clock ─────────────────────────────────────────────── */
function makeClock(start = 1_700_000_000_000) {
  let t = start, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer(fn, ms) { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    /** Advance time, firing timers in order, letting promises settle between. */
    async advance(ms) {
      const target = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= target)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, { at, fn }] = due;
        timers.delete(id);
        t = at;
        fn();
        await flush();
      }
      t = target;
      await flush();
    },
    pending: () => timers.size,
  };
}
const flush = () => new Promise((r) => setImmediate(r));

let pass = 0, fail = 0;
const failures = [];
const ok = (cond, name) => { if (cond) pass++; else { fail++; failures.push(name); } };
const eq = (a, b, name) => ok(Object.is(a, b), `${name} (got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

/** Build a watcher with a scripted verify endpoint. */
function harness({ script, expiresInMs = 3600_000, ...opts } = {}) {
  const clock = makeClock();
  const calls = [];
  const events = { paid: [], trouble: 0, recovered: 0, stopped: [] };
  const watcher = createPaymentWatcher({
    verifyUrl: "https://x.test/v",
    expiresAt: clock.now() + expiresInMs,
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
    check: async () => {
      const n = calls.length;
      calls.push(clock.now());
      const r = script(n);
      if (r instanceof Error) throw r;
      return r;
    },
    onPaid: (p) => events.paid.push(p),
    onTrouble: () => events.trouble++,
    onRecovered: () => events.recovered++,
    onStop: (r) => events.stopped.push(r),
    ...opts,
  });
  return { clock, calls, events, watcher };
}
const UNPAID = { settled: false, preimage: null };
const PAID = (p = "ab".repeat(32)) => ({ settled: true, preimage: p });

/* ═══════════════════════════════════════════════════════════════════════
   1. Cadence: fast while the buyer is paying, slower afterwards
   ═══════════════════════════════════════════════════════════════════════ */
{
  const { clock, calls, watcher } = harness({ script: () => UNPAID });
  watcher.start();
  await clock.advance(0);
  eq(calls.length, 1, "polls immediately on start");

  await clock.advance(1500);
  eq(calls.length, 2, "polls again after 1.5s");

  await clock.advance(60_000);
  const gaps = calls.slice(1).map((t, i) => t - calls[i]);
  ok(gaps.every((g) => g === 1500), `fast phase polls every 1500ms (saw ${[...new Set(gaps)]})`);

  // The whole point: a payment is noticed in well under 5 seconds.
  ok(Math.max(...gaps) < 5000, `worst-case detection gap under 5s (${Math.max(...gaps)}ms)`);
  watcher.stop();
}
{
  // After the fast phase it eases off, so a tab left open all day is cheap.
  const { clock, calls, watcher } = harness({ script: () => UNPAID, expiresInMs: 3600_000 });
  watcher.start();
  await clock.advance(200_000);
  const before = calls.length;
  await clock.advance(60_000);
  const slowGaps = calls.slice(before).map((t, i, a) => (i ? t - a[i - 1] : null)).filter(Boolean);
  ok(slowGaps.every((g) => g === 5000), `slow phase polls every 5000ms (saw ${[...new Set(slowGaps)]})`);
  watcher.stop();
}
{
  // Detection latency for a payment made at an arbitrary moment.
  const { clock, calls, events, watcher } = harness({ script: (n) => (n >= 3 ? PAID() : UNPAID) });
  watcher.start();
  await clock.advance(10_000);
  const paidAt = calls[3];
  eq(events.paid.length, 1, "payment detected");
  ok(paidAt - calls[2] <= 1500, `detected within one fast interval (${paidAt - calls[2]}ms)`);
}

/* ═══════════════════════════════════════════════════════════════════════
   2. Detects settlement, at various points in time
   ═══════════════════════════════════════════════════════════════════════ */
for (const settleOnCall of [0, 1, 5, 50]) {
  const { clock, events, watcher } = harness({
    script: (n) => (n >= settleOnCall ? PAID() : UNPAID),
  });
  watcher.start();
  await clock.advance(5000 * (settleOnCall + 2));
  eq(events.paid.length, 1, `settles when paid on call ${settleOnCall}`);
  eq(events.paid[0], "ab".repeat(32), `preimage delivered (call ${settleOnCall})`);
  ok(watcher.stopped, `watcher stops after payment (call ${settleOnCall})`);
}

// A long wait: paid 20 minutes in, the watcher must still be alive.
{
  const { clock, events, watcher } = harness({
    script: (n) => (n >= 240 ? PAID() : UNPAID),
    expiresInMs: 3600_000,
  });
  watcher.start();
  await clock.advance(20 * 60_000 + 10_000);
  eq(events.paid.length, 1, "still polling and detects payment 20 minutes later");
}

/* ═══════════════════════════════════════════════════════════════════════
   3. Never reports paid when it is not
   ═══════════════════════════════════════════════════════════════════════ */
{
  const { clock, events, watcher } = harness({ script: () => UNPAID });
  watcher.start();
  await clock.advance(30 * 60_000);
  eq(events.paid.length, 0, "never fires onPaid while unsettled");
  watcher.stop();
}
{
  // Malformed bodies must not be read as settled.
  for (const body of [{}, null, { settled: "no" }, { settled: 0 }, { status: "OK" }, { paid: false }]) {
    const r = readVerifyBody(body);
    ok(r.settled === false, `not settled for ${JSON.stringify(body)}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════
   4. Survives errors — the bug that lost a real payment
   ═══════════════════════════════════════════════════════════════════════ */
{
  // 12 consecutive failures, then success. The old code gave up after 5.
  const { clock, calls, events, watcher } = harness({
    script: (n) => (n < 12 ? new Error("network down") : PAID()),
  });
  watcher.start();
  await clock.advance(0);
  await clock.advance(15_000 * 14);
  ok(calls.length > 12, `keeps polling through 12 failures (made ${calls.length} calls)`);
  eq(events.paid.length, 1, "detects payment after a long outage");
  eq(events.trouble, 1, "warned the buyer once, not repeatedly");
}
{
  // Recovery without payment should clear the warning.
  const { clock, events, watcher } = harness({
    script: (n) => (n < 4 ? new Error("blip") : UNPAID),
  });
  watcher.start();
  await clock.advance(0);
  await clock.advance(15_000 * 5);
  eq(events.trouble, 1, "trouble reported after repeated errors");
  eq(events.recovered, 1, "recovery reported when the endpoint comes back");
  ok(!watcher.stopped, "watcher still running after recovery");
  watcher.stop();
}
{
  // Errors must back off, not hammer the server.
  const { clock, calls, watcher } = harness({ script: () => new Error("500") });
  watcher.start();
  await clock.advance(0);
  await clock.advance(60_000);
  ok(calls.length <= 6, `backs off while failing (${calls.length} calls in 60s)`);
  ok(calls.length >= 3, `but keeps trying (${calls.length} calls in 60s)`);
  watcher.stop();
}

/* ═══════════════════════════════════════════════════════════════════════
   5. Expiry — keeps checking through the grace window
   ═══════════════════════════════════════════════════════════════════════ */
{
  // Paid 30s AFTER the invoice nominally expired.
  const { clock, events, watcher } = harness({
    script: (n) => (n >= 7 ? PAID() : UNPAID),
    expiresInMs: 30_000,
  });
  watcher.start();
  await clock.advance(60_000);
  eq(events.paid.length, 1, "detects a payment that settles just after expiry");
}
{
  // But it does eventually stop, rather than polling forever.
  const { clock, calls, events, watcher } = harness({
    script: () => UNPAID,
    expiresInMs: 30_000, graceMs: 120_000,
  });
  watcher.start();
  await clock.advance(10 * 60_000);
  ok(watcher.stopped, "watcher stops after the grace window");
  eq(events.stopped[0], "expired", "reports why it stopped");
  const last = calls.length;
  await clock.advance(10 * 60_000);
  eq(calls.length, last, "no polling at all after stopping");
  eq(clock.pending(), 0, "no timers left behind");
}

/* ═══════════════════════════════════════════════════════════════════════
   6. Waking on tab refocus — the wallet-app handoff
   ═══════════════════════════════════════════════════════════════════════ */
{
  const { clock, calls, events, watcher } = harness({
    script: (n) => (n >= 1 ? PAID() : UNPAID),
  });
  watcher.start();
  await clock.advance(0);
  eq(calls.length, 1, "one poll, then the buyer leaves for their wallet");

  // Simulate a frozen background tab: time passes but no timer fires.
  clock.now = (() => { const base = clock.now(); return () => base + 90_000; })();
  watcher.poke();                       // returning to the tab
  await flush();
  eq(calls.length, 2, "poke() polls immediately on refocus");
  eq(events.paid.length, 1, "payment made while away is detected on return");
}
{
  // poke() must not stack concurrent requests.
  let inFlight = 0, maxInFlight = 0;
  const clock = makeClock();
  const watcher = createPaymentWatcher({
    verifyUrl: "u", expiresAt: clock.now() + 600_000,
    now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer,
    check: async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await flush(); await flush();
      inFlight--;
      return UNPAID;
    },
    onPaid: () => {},
  });
  watcher.start();
  for (let i = 0; i < 10; i++) watcher.poke();
  await flush(); await flush(); await flush();
  eq(maxInFlight, 1, "never more than one verify request in flight");
  watcher.stop();
}
{
  // poke() after stop must do nothing.
  const { clock, calls, watcher } = harness({ script: () => UNPAID });
  watcher.start();
  await clock.advance(0);
  const n = calls.length;
  watcher.stop();
  watcher.poke();
  await flush();
  eq(calls.length, n, "poke() is inert once stopped");
}

/* ═══════════════════════════════════════════════════════════════════════
   7. Provider response shapes
   ═══════════════════════════════════════════════════════════════════════ */
{
  const P = "cd".repeat(32);
  const cases = [
    [{ status: "OK", settled: true, preimage: P }, true, P, "LUD-21 canonical"],
    [{ settled: true }, true, null, "settled with no preimage"],
    [{ paid: true, preimage: P }, true, P, "paid: alias"],
    [{ is_paid: true }, true, null, "is_paid alias"],
    [{ status: "PAID" }, true, null, "status: PAID"],
    [{ settled: "true", preimage: P }, true, P, "stringified boolean"],
    [{ settled: 1 }, true, null, "numeric 1"],
    [{ settled: true, payment_preimage: P }, true, P, "payment_preimage field"],
    [{ settled: true, preimage: "not-hex" }, true, null, "bad preimage dropped, still paid"],
    [{ settled: true, preimage: P.toUpperCase() }, true, P, "uppercase preimage normalised"],
    [{ settled: false, preimage: P }, false, null, "preimage ignored when unsettled"],
  ];
  for (const [body, settled, pre, name] of cases) {
    const r = readVerifyBody(body);
    eq(r.settled, settled, `readVerifyBody settled: ${name}`);
    eq(r.preimage, pre, `readVerifyBody preimage: ${name}`);
  }
}

/* ═══════════════════════════════════════════════════════════════════════ */
console.log(fail === 0
  ? `payment confirmation: all ${pass} checks passed`
  : `payment confirmation: ${fail} FAILED, ${pass} passed`);
if (failures.length) { failures.forEach((f) => console.log("  FAIL " + f)); process.exit(1); }
