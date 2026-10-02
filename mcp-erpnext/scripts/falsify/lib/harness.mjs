/**
 * Shared falsification harness core.
 *
 * A guard nobody can re-run proves nothing, so every harness in this directory
 * lives in the repo and follows the same four rules per case:
 *
 *   1. the NAMED test is green BEFORE the mutation (a red baseline proves
 *      nothing about the mutation);
 *   2. the mutation applies (a moved anchor is reported, not skipped);
 *   3. the run goes RED **with the named test failing** — a red run caused by a
 *      compile error or by an unrelated test is not evidence;
 *   4. the file is restored byte-identically, or the run stops.
 *
 * p42/p43 predate this module and carry their own copy of these rules; new
 * harnesses should import from here instead of copying them again.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo paths a case can point at. */
export const PATHS = {
  ROOT: path.join(HERE, "..", "..", ".."), // mcp-erpnext/
  MOBILE: path.join(HERE, "..", "..", "..", "..", "apps", "mobile"),
  FLUTTER_DIR: process.env.FLUTTER_BIN_DIR ?? "/google/flutter/bin",
};

/** Regex-escape a test name before handing it to --test-name-pattern / --plain-name. */
const esc = (name) => name.replace(/[?*+^$(){}|[\]\\]/g, "\\$&");

export function runNodeSuite(file, only) {
  // `npm test` sets COPILOT_MOCK_OK=1: the fixture is opt-in, and these suites
  // read through it. Without it the route refuses to start (by design).
  const proc = spawnSync(
    process.execPath,
    ["--test", `--test-name-pattern=${esc(only)}`, file],
    { cwd: PATHS.ROOT, encoding: "utf8", timeout: 600_000, env: { ...process.env, COPILOT_MOCK_OK: "1" } },
  );
  const out = `${proc.stdout}${proc.stderr}`;
  const ran = Number((out.match(/^ℹ pass (\d+)$/m) ?? [])[1] ?? 0);
  const fails = Number((out.match(/^ℹ fail (\d+)$/m) ?? [])[1] ?? 0);
  const names = out
    .split("\n")
    .filter((l) => l.startsWith("✖") && !l.includes("failing"))
    .map((l) => l.replace(/^✖ /, "").slice(0, 78));
  // A pattern that matches nothing passes silently — never let that count as RED.
  if (fails === 0 && ran === 0) return { red: false, why: "0 test matched the pattern", names };
  return { red: fails > 0, why: `fail=${fails} pass=${ran}`, names };
}

/**
 * Failed Dart test names. `flutter test` prints the description on the NEXT line
 * ("The test description was:\n  <name>"), so filtering single lines yields an
 * empty name and every case then looks "red but the wrong test".
 */
export function dartFailedTestNames(out) {
  const lines = out.split("\n");
  const names = [];
  for (let i = 0; i < lines.length; i++) {
    const inline = lines[i].match(/The test description was:\s*(.+)$/);
    if (inline && inline[1].trim()) {
      names.push(inline[1].trim().slice(0, 78));
      continue;
    }
    if (lines[i].trim() === "The test description was:") {
      const next = (lines[i + 1] ?? "").trim();
      if (next) names.push(next.slice(0, 78));
    }
  }
  return names;
}

/**
 * Failed Dart test names, second source: the compact reporter's own end-of-run
 * list (`Failing tests:` then `  <path>.dart: <name>`).
 *
 * Needed for the failures that never print "The test description was:" — a
 * synchronous `expect` inside a `group()` (e.g. a pure model class) reports only
 * the `[E]` banner and this list. Without it `runDartSuite` saw no failed name
 * AND no "All tests passed!", so a genuinely RED run was reported as "no test
 * ran (pattern matched nothing?)" — the case would have been blamed on the
 * pattern instead of being evidence.
 */
function dartFailingListNames(out) {
  const block = out.split(/^Failing tests:\s*$/m)[1] ?? "";
  const names = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^\s+(.+?\.dart):\s+(.+?)\s*$/);
    if (m && m[2]) names.push(m[2].slice(0, 78));
  }
  return names;
}

export function runDartSuite(suiteFile, only) {
  const args = ["test", suiteFile];
  if (only) args.push("--plain-name", only);
  const proc = spawnSync("flutter", args, {
    cwd: PATHS.MOBILE,
    encoding: "utf8",
    timeout: 900_000,
    env: { ...process.env, PATH: `${PATHS.FLUTTER_DIR}:${process.env.PATH}` },
  });
  const out = `${proc.stdout}${proc.stderr}`;
  // A compile error is NOT a falsification: the suite never ran.
  if (/Error: .*(Compilation|compilation)|Failed to load|Compilation failed/.test(out)) {
    return { red: false, why: "DART SUITE DID NOT COMPILE", names: [] };
  }
  const passed = Number((out.match(/\+(\d+)(?!\d* -\d)/g) ?? ["0"]).slice(-1)[0].replace("+", ""));
  const failed = [...new Set([...dartFailedTestNames(out), ...dartFailingListNames(out)])];
  const ranOne = out.includes("All tests passed!") || failed.length > 0;
  if (!ranOne) return { red: false, why: "no test ran (pattern matched nothing?)", names: [] };
  return { red: failed.length > 0, why: `failed=${failed.length} passed=${passed}`, names: failed };
}

/**
 * Run every case: baseline check, mutate, run, restore, attribute, report.
 *
 * @param {{name:string, suite:"node"|"dart", file:string, old:string, new:string,
 *          nodeFile?:string, dartSuite?:string, only?:string}[]} cases
 * @param {{title:string, nodeFiles?:Record<string,string>, dartSuites?:Record<string,string>}} opts
 * @returns {number} number of PROBLEMs (0 = every guard alive)
 */
/**
 * Mutations currently written to disk, so a killed run can put them back.
 *
 * Learned the hard way (2026-09-21, P4-4/P4-5 work): the loop restores a file
 * right after each run, so a normal exit is safe — but Ctrl-C / a timeout during
 * a long `flutter test` leaves the mutation ON DISK, and the next `git diff`
 * someone reads is fiction. This handler is the fix; it is why the guards below
 * carry their own lesson row.
 */
const PENDING = new Map();

function restoreAll() {
  for (const [file, original] of PENDING) {
    try {
      if (readFileSync(file, "utf8") !== original) writeFileSync(file, original, "utf8");
    } catch {
      // nothing better to do while dying
    }
  }
  PENDING.clear();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(signal, () => {
    restoreAll();
    console.log(`\n[falsify] ${signal} — mutations restored, exiting`);
    process.exit(130);
  });
}
process.on("exit", restoreAll);

export function runCases(cases, opts) {
  let problems = 0;
  for (const c of cases) {
    const full = path.isAbsolute(c.file) ? c.file : path.join(PATHS.ROOT, c.file);
    const original = readFileSync(full, "utf8");
    const run = () =>
      c.suite === "dart"
        ? runDartSuite(opts.dartSuites[c.dartSuite ?? "default"], c.only)
        : runNodeSuite(opts.nodeFiles[c.nodeFile ?? "default"], c.only);

    if (!original.includes(c.old)) {
      problems += 1;
      console.log(`PROBLEM  anchor missing: ${c.name}`);
      continue;
    }
    // Control FIRST: the named test must exist and pass before the mutation.
    const before = run();
    if (before.red) {
      problems += 1;
      console.log(`PROBLEM  ${c.name}  → the named test did not pass beforehand (${before.why})`);
      continue;
    }

    PENDING.set(full, original);
    writeFileSync(full, original.replace(c.old, c.new), "utf8");
    const after = run();
    writeFileSync(full, original, "utf8");
    PENDING.delete(full);

    const identical = readFileSync(full, "utf8") === original;
    const attributed = after.names.some((n) => n.includes(c.only.slice(0, 40)));
    const ok = after.red && identical && attributed;
    if (!ok) problems += 1;
    const why = !after.red
      ? `NOT RED (${after.why})`
      : !identical
        ? "RESTORE NOT BYTE-IDENTICAL"
        : `RED BUT NOT THIS TEST (failing: ${after.names.join(" | ") || "none"})`;
    console.log(`${ok ? "RED" : "PROBLEM"}  ${c.name}${ok ? "" : `  → ${why}`}`);
  }
  console.log(
    problems === 0
      ? `\nALL GUARDS ALIVE — ${opts.title}: every mutation turns the NAMED test red, restore byte-identical`
      : `\n${problems} PROBLEM(S)`,
  );
  return problems;
}
