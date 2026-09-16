/**
 * Runs every src/**\/*.test.ts in its own process.
 *
 * The suite deliberately has no test-framework dependency: each file is a plain
 * script that exits non-zero on failure, executed with Node's native TypeScript
 * stripping. A wallet's dependency list is part of its attack surface, so the
 * runner is 40 lines instead of a framework.
 */
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function findTests(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await findTests(full)));
    else if (entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out.sort();
}

const files = await findTests(path.join(root, "src"));
if (files.length === 0) {
  console.error("no test files found");
  process.exit(1);
}

const failed = [];
for (const file of files) {
  const rel = path.relative(root, file);
  console.log(`\n── ${rel} ${"─".repeat(Math.max(0, 60 - rel.length))}`);
  const code = await new Promise((resolve) => {
    spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", file], {
      stdio: "inherit",
      cwd: root,
    }).on("close", resolve);
  });
  if (code !== 0) failed.push(rel);
}

console.log(`\n${"=".repeat(64)}`);
if (failed.length === 0) {
  console.log(`All ${files.length} test file(s) passed.`);
} else {
  console.log(`${failed.length} of ${files.length} test file(s) FAILED:`);
  for (const f of failed) console.log(`  - ${f}`);
}
process.exit(failed.length === 0 ? 0 : 1);
