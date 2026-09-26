#!/usr/bin/env node
/**
 * Rule 2b falsification harness — in the repo (the in-repo rule set by C0/C1/C2
 * and issue1-mock-optin; a /tmp harness already rotted once).
 *
 * Breaks one part of the name-collision guard at a time and requires the suite
 * to go RED, then restores the file and checks the restore is byte-identical.
 *
 * Parts under test:
 *   block      — the guard actually refuses a shorter-prefix match
 *   wholeStart — a shorter fragment at the same start cannot re-pick the row
 *   intent     — the intent-word exemption keeps legit partial names working
 *   nextToken  — a token the row DOES contain must not block the match
 *
 * Usage:  node scripts/falsify/issue1-resolver.mjs
 * Exit:   0 = every part went RED when broken; 1 = something did not.
 */

import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", ".."); // mcp-erpnext/
const FILE = "src/copilot-server.mjs";
const SUITE = "test/entity-name-collision.test.mjs";

const BLOCK_LINE = "        if (rowContinues && isNameLike && !rowNames.includes(nextLow)) {";

const CASES = [
  {
    name: "block: the guard is bypassed (shorter prefix wins again)",
    old: BLOCK_LINE,
    new: "        if (false && rowContinues && isNameLike && !rowNames.includes(nextLow)) {",
  },
  {
    name: "wholeStart: only the fragment is skipped, the start is not blocked",
    old: "          blockedStarts.add(start);\n          continue;",
    new: "          continue;",
  },
  {
    name: "intent: intent words are treated as extra NAME (legit partials break)",
    old: "        const isNameLike = !/\\d/.test(nextLow) && !intentTokens().has(nextLow);",
    new: "        const isNameLike = !/\\d/.test(nextLow);",
  },
  {
    name: "nextToken: any following token blocks, even one the row contains",
    old: BLOCK_LINE,
    new: "        if (true) {",
  },
  {
    name: "rowContinues: a complete-name match is treated as an over-typed name",
    old: "          return at >= 0 && field.slice(at + low.length).trim().length > 0;",
    new: "          return true;",
  },
];

function runSuite() {
  const proc = spawnSync(process.execPath, ["--test", SUITE], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
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

const target = path.join(ROOT, FILE);
const backup = `${target}.falsify-bak`;

// A mutation must not survive an interrupted run (learned in issue1-mock-optin:
// a SIGKILL'd harness left the file mutated on disk).
let inFlight = null;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (inFlight) {
      try {
        copyFileSync(inFlight.backup, inFlight.target);
        unlinkSync(inFlight.backup);
        console.error(`\n[${sig}] restored ${FILE} before exit`);
      } catch (err) {
        console.error(`\n[${sig}] RESTORE FAILED: ${err?.message ?? err}`);
      }
    }
    process.exit(130);
  });
}

const base = runSuite();
console.log(`baseline: ${base.fails} failing (expected 0)`);
if (base.fails !== 0) {
  console.error("baseline is not green — fix that first");
  process.exit(1);
}
console.log("");

const results = [];
for (const c of CASES) {
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
      console.error(`\nRESTORE NOT BYTE-IDENTICAL: ${FILE} — DỪNG`);
      process.exit(1);
    }
  }
}

const width = Math.max(...results.map(([n]) => n.length));
for (const [name, verdict, first] of results) {
  console.log(`${name.padEnd(width)}  ${verdict}${first ? `  [${first}]` : ""}`);
}
const bad = results.filter(([, v]) => !v.startsWith("RED"));
console.log(bad.length === 0 ? "\nALL RULE-2B GUARDS FALSIFIED" : `\nCHƯA CHỨNG MINH: ${bad.length}`);
process.exit(bad.length === 0 ? 0 : 1);
