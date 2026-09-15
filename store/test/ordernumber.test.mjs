// Tests for the order number: a short hash of the order's own contents.
//
//   node test/ordernumber.test.mjs
//
// It has to be stable (the same order always numbers the same, so a merchant
// can recompute it) and sensitive (any edit to items, totals or customer
// changes it). orderCore is extracted verbatim from index.html.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(here, "..", "index.html"), "utf8");

const fn = html.match(/function orderCore\(o\)\{[\s\S]*?\n      notes:o\.customer\?\.notes\|\|""\}\}\}/);
if (!fn) { console.error("FATAL: could not extract orderCore from index.html"); process.exit(1); }
const { orderCore } = await import("data:text/javascript," + encodeURIComponent(fn[0] + "\nexport { orderCore };"));

const num = (o) => createHash("sha256").update(JSON.stringify(orderCore(o))).digest("hex").slice(0, 8).toUpperCase();

let pass = 0, fail = 0;
const bad = (m) => { console.log("FAIL " + m); fail++; };

const base = () => ({
  at: 1_757_000_000_000,
  channel: "online",
  storeName: "Caelen's store",
  totalSats: 4519,
  shippingSats: 0,
  fiatTotal: 5,
  fiatCurrency: "CAD",
  items: [{ id: "cube", name: "fidget cube", qty: 1, unitPrice: 5, opts: { Size: "M" } }],
  customer: { name: "Jane", email: "j@example.com", phone: "", address: "12 Test Lane", notes: "" },
});

// Stable: same content, same number, every time.
{
  const a = num(base()), b = num(base());
  if (a === b) pass++; else bad(`not deterministic: ${a} vs ${b}`);
  if (/^[0-9A-F]{8}$/.test(a)) pass++; else bad(`unexpected shape: ${a}`);
}

// Option order must not matter — objects can serialise in any key order.
{
  const o = base();
  o.items[0].opts = { Colour: "red", Size: "M" };
  const p = base();
  p.items[0].opts = { Size: "M", Colour: "red" };
  if (num(o) === num(p)) pass++; else bad("option key order changed the number");
}

// Sensitive: every field that matters must change the number.
const mutations = {
  "item quantity": (o) => { o.items[0].qty = 2; },
  "item price": (o) => { o.items[0].unitPrice = 1; },
  "item id": (o) => { o.items[0].id = "other"; },
  "item name": (o) => { o.items[0].name = "something else"; },
  "an added item": (o) => { o.items.push({ id: "x", name: "x", qty: 1, unitPrice: 1, opts: {} }); },
  "chosen option": (o) => { o.items[0].opts = { Size: "L" }; },
  "total": (o) => { o.totalSats = 1; },
  "shipping": (o) => { o.shippingSats = 500; },
  "fiat total": (o) => { o.fiatTotal = 999; },
  "currency": (o) => { o.fiatCurrency = "USD"; },
  "customer name": (o) => { o.customer.name = "Mallory"; },
  "customer email": (o) => { o.customer.email = "m@evil.test"; },
  "shipping address": (o) => { o.customer.address = "99 Attacker Road"; },
  "phone": (o) => { o.customer.phone = "555"; },
  "notes": (o) => { o.customer.notes = "leave at door"; },
  "timestamp": (o) => { o.at += 1; },
  "store name": (o) => { o.storeName = "Not the store"; },
  "channel": (o) => { o.channel = "in-person"; },
};
const original = num(base());
for (const [name, mutate] of Object.entries(mutations)) {
  const o = base();
  mutate(o);
  if (num(o) !== original) pass++; else bad(`editing the ${name} did not change the order number`);
}

// Payment fields are excluded on purpose: they do not exist at numbering time.
{
  const o = base();
  o.paymentHash = "f".repeat(64);
  o.preimage = "a".repeat(64);
  o.invoice = "lnbc90n1...";
  if (num(o) === original) pass++; else bad("payment fields leaked into the order number");
}

// Distinct orders should not collide across a realistic volume.
{
  const seen = new Set();
  for (let i = 0; i < 5000; i++) {
    const o = base();
    o.at = 1_757_000_000_000 + i;
    seen.add(num(o));
  }
  if (seen.size === 5000) pass++; else bad(`${5000 - seen.size} collisions in 5000 orders`);
}

console.log(fail === 0
  ? `order number: all ${pass} checks passed`
  : `order number: ${fail} FAILED, ${pass} passed`);
process.exit(fail ? 1 : 0);
