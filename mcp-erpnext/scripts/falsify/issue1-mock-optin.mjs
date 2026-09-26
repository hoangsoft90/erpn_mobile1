#!/usr/bin/env node
/**
 * issue1_fix1 falsification harness — in the repo (B2/B3 left theirs in /tmp and
 * both rotted; C0/C1/C2 set the in-repo rule).
 *
 * Breaks ONE guard at a time and requires the named suite to go RED, then
 * restores the file and verifies the restore is byte-identical.
 *
 * Guards under test:
 *   strictness — the fixture requires the EXACT opt-in; truthy lookalikes refuse
 *   gate       — absent config without opt-in REFUSES (no silent fixture)
 *   partial    — a half-configured deployment is an error, not a licence for fixtures
 *   structure  — no second file may reach the fixture constant
 *   premise    — the E2E is anchored to the real fixture data the bug used
 *
 * Usage:  node scripts/falsify/issue1-mock-optin.mjs
 * Exit:   0 = every guard went RED when broken; 1 = something did not.
 */

import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", ".."); // mcp-erpnext/

const SUITE = ["test/target.test.mjs", "test/mock-optin.test.mjs"];

const CASES = [
  // ---- strictness: the opt-in is a literal "1", not "truthy" --------------
  {
    name: "gate: absent config silently returns the fixture (the issue1 bug)",
    file: "src/copilot-server.mjs",
    old: '  if (!url && !key && !secret) {\n    if (env.COPILOT_MOCK_OK !== "1") {',
    new: '  if (!url && !key && !secret) {\n    if (false) {',
  },
  {
    name: "strictness: COPILOT_MOCK_OK accepted as truthy (true/yes/on)",
    file: "src/copilot-server.mjs",
    old: '    if (env.COPILOT_MOCK_OK !== "1") {',
    new: '    if (!env.COPILOT_MOCK_OK) {',
  },
  {
    name: "partial: the opt-in rescues a half-configured deployment",
    file: "src/copilot-server.mjs",
    old: '  const missing = ["ERPNEXT_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET"].filter((k) => !env[k]);',
    new: '  const missing = env.COPILOT_MOCK_OK === "1" ? [] : ["ERPNEXT_URL", "ERPNEXT_API_KEY", "ERPNEXT_API_SECRET"].filter((k) => !env[k]);',
  },

  // ---- structure: a second path to the fixture must trip the wire --------
  {
    name: "structure: another src file references the fixture constant",
    file: "src/http-ask.mjs",
    old: "export function createAskServer({",
    // Built via concatenation so THIS file never contains the literal token the
    // static tripwire greps for (otherwise the harness trips its own wire).
    new: `// dev fallback: ${"MOCK" + "_SERVER"} would be used here\nexport function createAskServer({`,
  },

  // ---- boot: the HTTP server must validate the target BEFORE listening -----
  {
    name: "boot: http-ask no longer validates the config before listening",
    file: "src/http-ask.mjs",
    old: "  pickServerScript(); // throws ERPNEXT_NOT_CONFIGURED / PARTIAL_ERPNEXT_CONFIG / INVALID_ERPNEXT_URL\n",
    new: "",
  },

  // ---- premise: the E2E must be tied to the data the bug actually served --
  {
    name: "premise: the fixture no longer contains the issue1 customer",
    file: "src/mock-server.mjs",
    old: '"Nguyễn Thị Lan"',
    new: '"Khách Demo"',
  },
];

function runSuite() {
  const proc = spawnSync(process.execPath, ["--test", ...SUITE], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
    // The suite legitimately needs the opt-in (it IS the mock path); the
    // unconfigured case inside the test strips this var explicitly.
    env: { ...process.env, COPILOT_MOCK_OK: "1" },
  });
  const out = `${proc.stdout}${proc.stderr}`;
  const m = out.match(/^ℹ fail (\d+)$/m);
  const fails = m ? Number(m[1]) : proc.status === 0 ? 0 : -1;
  const names = out
    .split("\n")
    .filter((l) => l.startsWith("✖") && !l.includes("failing"))
    .map((l) => l.replace(/^✖ /, "").slice(0, 74));
  return { fails, names };
}

const base = runSuite();
console.log(`baseline: ${base.fails} failing (expected 0)`);
if (base.fails !== 0) {
  console.error("baseline is not green — fix that first");
  process.exit(1);
}
console.log("");

// A mutation must never survive an interrupted run: Ctrl-C (or a harness
// timeout) restores the file in flight before exiting. Learned the hard way —
// a SIGKILL'd run left `src/copilot-server.mjs` mutated on disk.
let inFlight = null; // { target, backup }
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (inFlight) {
      try {
        copyFileSync(inFlight.backup, inFlight.target);
        unlinkSync(inFlight.backup);
        console.error(`\n[${sig}] restored ${path.relative(ROOT, inFlight.target)} before exit`);
      } catch (err) {
        console.error(`\n[${sig}] RESTORE FAILED for ${inFlight.target}: ${err?.message ?? err}`);
      }
    }
    process.exit(130);
  });
}

const results = [];
for (const c of CASES) {
  const target = path.join(ROOT, c.file);
  const backup = `${target}.falsify-bak`;
  const original = readFileSync(target, "utf8");
  if (!original.includes(c.old)) {
    results.push([c.name, "ANCHOR STALE — không áp được", ""]);
    continue;
  }
  copyFileSync(target, backup);
  writeFileSync(target, original.replace(c.old, c.new));
  if (readFileSync(target, "utf8") === original) {
    unlinkSync(backup);
    results.push([c.name, "MUTATION NOT APPLIED", ""]);
    continue;
  }
  inFlight = { target, backup };
  try {
    const { fails, names } = runSuite();
    results.push([
      c.name,
      fails > 0 ? `RED ✓ (fail=${fails})` : "GREEN ✗ — GUARD KHÔNG ĐƯỢC TEST",
      names[0] ?? "",
    ]);
  } finally {
    copyFileSync(backup, target);
    unlinkSync(backup);
    inFlight = null;
    if (readFileSync(target, "utf8") !== original) {
      console.error(`\nRESTORE NOT BYTE-IDENTICAL: ${c.file} — DỪNG`);
      process.exit(1);
    }
  }
}

const width = Math.max(...results.map(([n]) => n.length));
for (const [name, verdict, first] of results) {
  console.log(`${name.padEnd(width)}  ${verdict}${first ? `  [${first}]` : ""}`);
}
const bad = results.filter(([, v]) => !v.startsWith("RED"));
console.log(bad.length === 0 ? "\nALL ISSUE1_OPTIN GUARDS FALSIFIED" : `\nCHƯA CHỨNG MINH: ${bad.length}`);
process.exit(bad.length === 0 ? 0 : 1);
