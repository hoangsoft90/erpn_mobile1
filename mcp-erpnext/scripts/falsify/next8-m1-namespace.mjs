/**
 * next8 / M1 — falsify battery for the pick namespace guard.
 *
 * Two mutations, each must turn the RIGHT tests RED (the tests are the spec):
 *
 *   F1  remove the WRONG_KIND refinement from pickRowFromCandidates
 *       ⇒ U3 (supplier side), T1, T5 red — the refinement is what they pin.
 *   F2  let the series check run BEFORE the list lookup (series overrides the
 *       fresh list) ⇒ U1 red — the list is the authority, never the series.
 *
 * Run: node scripts/falsify/next8-m1-namespace.mjs
 * Files are restored byte-identical from /tmp backups after each mutation
 * (the kill-harness lesson: never leave a mutation behind).
 */

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..", "..");
const ER = path.join(ROOT, "src", "entity-resolution.mjs");
const TEST = "test/next8-pick-namespace.test.mjs";

function runTests() {
  const r = spawnSync("node", ["--test", TEST], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 300_000,
  });
  const pass = /ℹ pass (\d+)/.exec(r.stdout)?.[1];
  const fail = /ℹ fail (\d+)/.exec(r.stdout)?.[1];
  const failedNames = [...r.stdout.matchAll(/✖ (U\d|T\d) /g)].map((m) => m[1]);
  return { pass: Number(pass), fail: Number(fail), failedNames };
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "RED-FAIL"} — ${name}${cond ? "" : `: ${detail}`}`);
  if (!cond) failures++;
}

const backupDir = mkdtempSync(path.join(tmpdir(), "m1-namespace-"));
cpSync(ER, path.join(backupDir, "entity-resolution.mjs"));
const original = readFileSync(ER, "utf8");

try {
  // ── F1: the refinement is gone (absent ids answer the generic INVALID). ──
  const f1 = original.replace(
    /const idKind = pickIdKindSeries\(pickedId\);\n    if \(kind && idKind && idKind !== kind\) \{[\s\S]*?\n    \}\n/g,
    "",
  );
  if (f1 === original) throw new Error("F1 mutation did not apply");
  writeFileSync(ER, f1);
  let r = runTests();
  check(
    "F1 — refinement removed ⇒ U3+T1+T5 red",
    r.failedNames.includes("U3") && r.failedNames.includes("T1") && r.failedNames.includes("T5"),
    `failed=${JSON.stringify(r.failedNames)} fail=${r.fail}`,
  );
  cpSync(path.join(backupDir, "entity-resolution.mjs"), ER);

  // ── F2: the series check runs BEFORE the list lookup (series > list). ──
  const f2 = original.replace(
    "  const hit = (rows ?? []).find((r) => String(idOf(r)) === pickedId.trim());",
    `  const preKind = pickIdKindSeries(pickedId);
  if (kind && preKind && preKind !== kind) {
    return { ok: false, code: "ENTITY_PICK_WRONG_KIND", error: "pre-list" };
  }
  const hit = (rows ?? []).find((r) => String(idOf(r)) === pickedId.trim());`,
  );
  if (f2 === original) throw new Error("F2 mutation did not apply");
  writeFileSync(ER, f2);
  r = runTests();
  check(
    "F2 — series overrides the list ⇒ U1 red",
    r.failedNames.includes("U1"),
    `failed=${JSON.stringify(r.failedNames)} fail=${r.fail}`,
  );
} finally {
  cpSync(path.join(backupDir, "entity-resolution.mjs"), ER);
  rmSync(backupDir, { recursive: true, force: true });
}

// Restore proof: the file must be byte-identical to the pre-run original.
const restored = readFileSync(ER, "utf8");
check("restore byte-identical", restored === original, "entity-resolution.mjs differs after restore");

console.log(failures === 0 ? "\nFALSIFY RESULT: 2/2 RED đúng test, restore sạch" : `\nFALSIFY RESULT: ${failures} lỗi`);
process.exit(failures === 0 ? 0 : 1);
