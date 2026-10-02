#!/usr/bin/env node
/**
 * A0 falsification battery — proves the WRITE handoff is load-bearing.
 *
 * For each mutation: apply, run the named test files, record which test names
 * go RED, then restore the file byte-identical. A mutation that turns NO test
 * red is reported as EMPTY (the guard would be decoration).
 *
 * Run: env -u ERPNEXT_* -u MOCK_ERP_P4_FIXTURE COPILOT_MOCK_OK=1 node scripts/falsify/next7-a0-handoff.mjs
 *
 * A1: the battery now guards the WIDER set — M1 empties it (every write back to
 * refusal), M3 lets the FORBIDDEN document.delete through the handoff guard,
 * M6 silently drops one wired id (sales_order.create). Each must turn its own
 * named test RED.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const files = {
  optin: path.join(ROOT, "src", "dsh-optin.mjs"),
  gateway: path.join(ROOT, "src", "dsh-gateway.mjs"),
  ask: path.join(ROOT, "src", "http-ask.mjs"),
};
const TESTS = [
  "test/dsh-gateway.test.mjs",
  "test/http-ask.test.mjs",
  "test/next7-a0-dsh-write-handoff.test.mjs",
];

/**
 * Two tests in dsh-gateway.test.mjs verify the REAL runtime via a `--version`
 * proof and time out on machines without a runnable dsh entry — they fail on
 * master with no diff applied too (measured 2026-09-27), so they are NOT a
 * mutation's signal. Recorded here so a mutation report is read against the
 * machine's own baseline, never against a spotless run that cannot exist here.
 */
const BASELINE_RED = new Set([
  "dshGatewayHealth — local mode verifies the patch marker, not just file existence",
  "verifyDshRuntime — the real runtime proves it runs; a failing command does not",
]);

const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex").slice(0, 16);
const original = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, readFileSync(p, "utf8")]));
const originalSha = Object.fromEntries(Object.entries(files).map(([k, p]) => [k, sha(p)]));

function restoreAll() {
  for (const [k, p] of Object.entries(files)) writeFileSync(p, original[k]);
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { restoreAll(); process.exit(130); });

function runTests() {
  try {
    const out = execFileSync(
      process.execPath,
      ["--test", "--test-reporter=tap", ...TESTS],
      { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return out;
  } catch (err) {
    return `${err.stdout ?? ""}${err.stderr ?? ""}`;
  }
}

/** Red test names, from TAP output of `node --test --test-reporter=tap`. */
function redNames(output) {
  const names = new Set();
  const re = /^\s*not ok \d+ - (.+?)(?: \(.*)?$/gm;
  let m;
  while ((m = re.exec(output))) names.add(m[1].trim());
  return [...names].filter((n) => !BASELINE_RED.has(n));
}

const MUTATIONS = [
  {
    name: "M1 handoff set emptied (every write refused again)",
    file: "optin",
    from: 'export const DSH_WRITE_HANDOFF_CAPABILITIES = new Set([\n  "payment.create",',
    to: 'export const DSH_WRITE_HANDOFF_CAPABILITIES = new Set([',
  },
  {
    name: "M2 handoff verdict returns a spawn instead of a decision",
    file: "gateway",
    from: "  const handoff = dshWriteHandoffFor(route);\n  if (handoff) {\n    return {\n      ok: false,",
    to: "  const handoff = null;\n  if (handoff) {\n    return {\n      ok: false,",
  },
  {
    name: "M3 every routed capability is handed off (forbidden document.delete included)",
    file: "optin",
    from: "export function dshWriteHandoffFor(route) {\n  if (!route || route.forbidden) return null;\n  if (route.capability && DSH_WRITE_HANDOFF_CAPABILITIES.has(route.capability)) {",
    to: "export function dshWriteHandoffFor(route) {\n  if (route.capability) {",
  },
  {
    name: "M5 the route stops metering the handoff's proposal (AI mode becomes the cheap card)",
    file: "ask",
    from: "            const metered = proposalBucketFor(result?.proposal);\n            if (metered) {",
    to: "            const metered = null;\n            if (false) {",
  },
  {
    name: "M4 the route drops the pipeline result from the handoff response",
    file: "ask",
    from: "              erp_target: erpTargetLabel(process.env),\n              result,\n            });",
    to: "              erp_target: erpTargetLabel(process.env),\n              result: null,\n            });",
  },
  {
    name: "M6 one wired write (sales_order.create) silently leaves the set",
    file: "optin",
    from: '  "sales_order.create",\n  "quotation.create",',
    to: '  "quotation.create",',
  },
];

const report = [];
for (const mut of MUTATIONS) {
  const p = files[mut.file];
  const src = original[mut.file];
  if (!src.includes(mut.from)) {
    report.push({ mutation: mut.name, result: "SKIPPED — anchor not found" });
    continue;
  }
  writeFileSync(p, src.replace(mut.from, mut.to));
  const out = runTests();
  const red = redNames(out);
  writeFileSync(p, src);
  report.push({
    mutation: mut.name,
    result: red.length ? `RED x${red.length}` : "EMPTY (no test caught it)",
    red,
  });
}

const restored = Object.entries(files).every(([k, p]) => sha(p) === originalSha[k]);
console.log("\n=== A0 falsification battery ===");
for (const r of report) {
  console.log(`\n${r.mutation}\n  ${r.result}`);
  for (const n of r.red ?? []) console.log(`    - ${n}`);
}
console.log(`\nrestore byte-identical: ${restored}`);
console.log("original sha:", originalSha);
console.log("current  sha:", Object.fromEntries(Object.entries(files).map(([k, p]) => [k, sha(p)])));
process.exit(restored ? 0 : 1);
