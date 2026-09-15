#!/usr/bin/env node
// Decrement stock after a sale, then optionally commit and push.
//
//   updateinventory.sh '<order json>'        apply an order (quantities subtracted)
//   updateinventory.sh sticker -5 mug -2     manual adjustment
//   updateinventory.sh --set tee 20          set an absolute quantity
//   updateinventory.sh --show                print current stock
//
// Flags:  --yes  skip prompts   --no-push  update the file only   --dry-run
//
// Authentication: this shells out to `git push`, so it uses whatever
// credentials git already has (credential manager, SSH key, or gh). If
// GITHUB_TOKEN is set it is used for this push only and never written to disk.

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createInterface } from "node:readline/promises";
import { stdin, stdout, argv, env, exit } from "node:process";

const FILE = "inventory.json";
const c = (n, s) => `[${n}m${s}[0m`;
const bold = (s) => c(1, s), dim = (s) => c(2, s);
const ok = (s) => c(32, `✓ ${s}`), bad = (s) => c(31, `✕ ${s}`), warn = (s) => c(33, `! ${s}`);

const args = argv.slice(2);
const flag = (f) => { const i = args.indexOf(f); if (i >= 0) args.splice(i, 1); return i >= 0; };
const YES = flag("--yes"), NO_PUSH = flag("--no-push"), DRY = flag("--dry-run");
const SET = flag("--set"), SHOW = flag("--show");

function load() {
  if (!existsSync(FILE)) {
    console.error(bad(`${FILE} not found. Enable "Track inventory" in the admin panel and download it first.`));
    exit(1);
  }
  const j = JSON.parse(readFileSync(FILE, "utf8"));
  return { doc: j, q: j.quantities || j };
}

function save(doc, quantities) {
  const out = { schema: "satstore.inventory/1", updated_at: new Date().toISOString(), quantities };
  writeFileSync(FILE, JSON.stringify(out, null, 2) + "\n", "utf8");
  return out;
}

function git(...a) {
  return execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** Parse either an order JSON blob or "id delta id delta" pairs. */
function parseChanges(input) {
  let joined = input.join(" ").trim();
  // A path to a saved order avoids fighting your shell over JSON quoting.
  if (input.length === 1 && !joined.startsWith("{") && existsSync(joined) && /\.json$/i.test(joined))
    joined = readFileSync(joined, "utf8").trim();
  if (joined.startsWith("{")) {
    let order;
    try { order = JSON.parse(joined); }
    catch (e) { console.error(bad(`Order JSON did not parse: ${e.message}`)); exit(1); }
    if (order.schema && order.schema !== "satstore.order/1")
      console.log(warn(`Unexpected schema "${order.schema}" — continuing anyway.`));
    const items = order.items || [];
    if (!items.length) { console.error(bad("Order contains no items.")); exit(1); }
    const changes = {};
    for (const it of items) {
      const id = it.id || it.product_id;
      if (!id) { console.error(bad(`An item has no id: ${JSON.stringify(it)}`)); exit(1); }
      changes[id] = (changes[id] || 0) - Number(it.quantity ?? it.qty ?? 1);
    }
    return { changes, label: `order ${order.order_number || "(unnumbered)"}`, order };
  }
  // manual pairs, tolerating "id,-5" and "id -5"
  const toks = joined.split(/[\s,]+/).filter(Boolean);
  if (toks.length === 0 || toks.length % 2 !== 0) {
    console.error(bad("Expected pairs of <item-id> <amount>, or a single order JSON string."));
    exit(1);
  }
  const changes = {};
  for (let i = 0; i < toks.length; i += 2) {
    const n = Number(toks[i + 1]);
    if (!Number.isFinite(n)) { console.error(bad(`"${toks[i + 1]}" is not a number.`)); exit(1); }
    changes[toks[i]] = (changes[toks[i]] || 0) + n;
  }
  return { changes, label: "manual adjustment" };
}

async function main() {
  const { q } = load();

  if (SHOW) {
    console.log(`\n${bold("Current stock")}\n`);
    for (const [k, v] of Object.entries(q)) console.log(`  ${k.padEnd(20)} ${String(v).padStart(5)}`);
    console.log();
    exit(0);
  }

  if (!args.length) {
    console.error(`Usage:
  updateinventory.sh '<order json>'         apply an order
  updateinventory.sh sticker -5 mug -2      manual adjustment
  updateinventory.sh --set tee 20           absolute quantity
  updateinventory.sh --show                 print current stock`);
    exit(1);
  }

  const { changes, label, order } = parseChanges(args);
  const next = { ...q };
  const rows = [];
  let problems = 0;

  for (const [id, delta] of Object.entries(changes)) {
    const before = Number(next[id] ?? 0);
    const known = Object.prototype.hasOwnProperty.call(next, id);
    const after = SET ? delta : before + delta;
    if (!known) { console.log(warn(`"${id}" is not in ${FILE} — it will be added.`)); problems++; }
    if (after < 0) { console.log(warn(`"${id}" would go negative (${before} → ${after}); clamping to 0.`)); problems++; }
    next[id] = Math.max(0, after);
    rows.push([id, before, next[id]]);
  }

  console.log(`\n${bold(`Applying ${label}`)}\n`);
  for (const [id, before, after] of rows) {
    const d = after - before;
    console.log(`  ${id.padEnd(20)} ${String(before).padStart(5)} → ${String(after).padStart(5)}  ${dim(d >= 0 ? `+${d}` : String(d))}`);
  }
  console.log();

  if (DRY) { console.log(warn("--dry-run: nothing written.")); exit(0); }

  const rl = (!YES) ? createInterface({ input: stdin, output: stdout }) : null;
  const confirm = async (question) => {
    if (YES) return true;
    const a = (await rl.question(`${question} ${dim("[y/N]")} `)).trim().toLowerCase();
    return a === "y" || a === "yes";
  };

  if (problems && !await confirm("There were warnings. Apply anyway?")) { rl?.close(); exit(1); }

  save(null, next);
  console.log(ok(`${FILE} updated`));

  if (order?.order_number)
    console.log(dim(`  order ${order.order_number} · payment_hash ${order.payment?.payment_hash || "—"}`));

  if (NO_PUSH) { rl?.close(); console.log(dim("--no-push: not committing.")); exit(0); }

  // Only offer git if this is actually a repo with a remote.
  let remote = "";
  try { remote = git("remote", "get-url", "origin"); }
  catch { rl?.close(); console.log(warn("No git remote 'origin' — file updated locally only.")); exit(0); }

  console.log(`\n  remote  ${dim(remote.replace(/\/\/[^@]*@/, "//"))}`);
  if (!await confirm("Commit and push this inventory update?")) {
    rl?.close();
    console.log(dim("Left uncommitted. Commit it yourself when ready."));
    exit(0);
  }
  rl?.close();

  try {
    git("add", FILE);
    git("commit", "-m", `Update inventory${order?.order_number ? ` (order ${order.order_number})` : ""}`);
  } catch (e) {
    console.error(bad(`Commit failed: ${(e.stderr || e.message || "").toString().trim()}`));
    exit(1);
  }

  // GITHUB_TOKEN, when present, is handed to git through a one-shot credential
  // helper. The token stays in the environment: it is never written to
  // .git/config, never embedded in a remote URL, and never placed in argv,
  // where any other local process could read it out of the process list.
  try {
    if (env.GITHUB_TOKEN && /^https:\/\/github\.com\//.test(remote)) {
      const helper = '!f() { echo username=x-access-token; echo "password=$GITHUB_TOKEN"; }; f';
      execFileSync("git", ["-c", `credential.helper=${helper}`, "push"], {
        stdio: ["ignore", "pipe", "pipe"],
        env,
      });
    } else {
      execFileSync("git", ["push"], { stdio: "inherit" });
    }
    console.log(`\n${ok("Pushed. Your storefront will show the new stock once the host redeploys.")}\n`);
  } catch (e) {
    const msg = (e.stderr || e.message || "").toString().replace(/x-access-token:[^@]*@/g, "x-access-token:***@").trim();
    console.error(bad(`Push failed: ${msg}`));
    console.error(dim("The commit is made locally — fix authentication and run `git push` yourself."));
    exit(1);
  }
}

main().catch((e) => { console.error(bad(e.message)); exit(1); });
