#!/usr/bin/env node
/**
 * Falsification harness for the /execute correlation-id boundary check
 * (P4-1 review finding, 2026-09-21).
 *
 * Break ONE thing at a time, prove test/http-execute.test.mjs turns RED, restore
 * the file, and verify the restore is byte-identical. A guard whose removal
 * turns nothing red is decoration — this file is how that claim gets checked.
 *
 * Bounded runtime + restore in `finally` + byte-identical assertion: LESSONS
 *_LEARNED group 17 (a harness killed mid-mutation once left `if (false)` on disk).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", ".."); // mcp-erpnext/
const SUITE = "test/http-execute.test.mjs";

const CASES = [
  {
    name: "A. the boundary check is skipped entirely (a numeric id reaches the entrypoint)",
    file: "src/http-ask.mjs",
    find: "      const idProblem = correlationIdProblem(body);",
    replace: "      const idProblem = null;",
  },
  {
    name: "B. only command_id is checked — proposal.action_id slips through (the value that lands in the filter)",
    file: "src/http-ask.mjs",
    find: '    ["proposal.action_id", body?.proposal?.action_id],\n',
    replace: "    // action_id no longer checked\n",
  },
  {
    name: "C. the empty-string case is no longer refused (shape check weakened to `typeof` only)",
    file: "src/http-ask.mjs",
    find: '    if (typeof value !== "string" || value.trim() === "") {',
    replace: '    if (typeof value !== "string") {',
  },
];

let failures = 0;
for (const c of CASES) {
  const full = path.join(ROOT, c.file);
  const original = readFileSync(full, "utf8");
  if (!original.includes(c.find)) {
    console.log(`PROBLEM  anchor missing: ${c.name}`);
    failures += 1;
    continue;
  }
  writeFileSync(full, original.replace(c.find, c.replace), "utf8");
  let red = false;
  try {
    execFileSync(process.execPath, ["--test", SUITE], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
      env: { ...process.env, COPILOT_MOCK_OK: "1" },
    });
  } catch {
    red = true; // suite failed while mutated ⇒ the guard is ALIVE
  } finally {
    writeFileSync(full, original, "utf8");
  }
  const identical = readFileSync(full, "utf8") === original;
  const ok = red && identical;
  if (!ok) failures += 1;
  console.log(`${ok ? "RED" : "PROBLEM"}  ${c.name}${identical ? "" : "  (RESTORE NOT BYTE-IDENTICAL)"}`);
}

console.log(failures === 0 ? "\nALL GUARDS ALIVE (every mutation red, restore byte-identical)" : `\n${failures} PROBLEM(S)`);
process.exit(failures === 0 ? 0 : 1);
