#!/usr/bin/env node
/**
 * P4-3 falsification harness — drawer + "Tóm tắt ngày" (plan4_final §2, §6).
 *
 * Lives IN THE REPO for the same reason C1's does: a harness in /tmp rots, and a
 * guard nobody can re-run proves nothing. P4-3 spans two runtimes, so this breaks
 * guards on both sides of the wire: the Dart screen/widgets (`flutter test
 * test/daily_summary_test.dart`) and the Node route/skill that feeds it.
 *
 * Rules each case must satisfy, or it is reported as NOT PROVEN:
 *   1. the named test is GREEN before the mutation (a red baseline proves
 *      nothing about the mutation);
 *   2. the mutation applies (an anchor that moved is "ANCHOR STALE", not a pass);
 *   3. the run goes RED **with the named test failing** — a red run caused by a
 *      compile error or by an unrelated test is not evidence;
 *   4. the file is restored byte-identically, or the run stops.
 *
 * Usage:  node scripts/falsify/p43-drawer-summary.mjs
 * Exit:   0 = every guard went RED when broken; 1 = something did not.
 */

import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", ".."); // mcp-erpnext/
const REPO = path.join(ROOT, "..");
const MOBILE = path.join(REPO, "apps", "mobile");
const FLUTTER_DIR = process.env.FLUTTER_BIN_DIR ?? "/google/flutter/bin";

const DART_SUITE = "test/daily_summary_test.dart";
// Paths are relative to ROOT (mcp-erpnext/), like every other falsify case.
const DART_SCREEN = "../apps/mobile/lib/features/ops/presentation/screens/daily_summary_screen.dart";
const DART_MODELS = "../apps/mobile/lib/features/ops/data/daily_summary_models.dart";
const DART_FOOTER = "../apps/mobile/lib/features/ops/presentation/widgets/summary_status_footer.dart";

/** Node suites a case can be run against; `only` names the test that must fail. */
const NODE_FILES = {
  skill: "test/p4-ops-summary.test.mjs",
  route: "test/p42-read-daily-summary.test.mjs",
  target: "test/target.test.mjs",
};

const CASES = [
  // ── the app: money may not be invented ────────────────────────────────────
  {
    name: "a NULL block is parsed into a ZEROED block (unread becomes \"Tổng thu 0đ\")",
    suite: "dart",
    file: DART_MODELS,
    only: "a failed block shows Lỗi · Thử lại and NO 0đ in its place",
    old: "      receipts: _block(json['receipts'], ReceiptsBlock.fromJson),",
    new: "      receipts: _block(json['receipts'], ReceiptsBlock.fromJson) ?? const ReceiptsBlock(),",
  },
  {
    name: "an EMPTY object block is accepted (a malformed payload reads as a measured zero)",
    suite: "dart",
    file: DART_MODELS,
    only: "an EMPTY object block is treated as unreadable, not as zero",
    old: "  if (raw is! Map<String, dynamic> || raw.isEmpty) return null;",
    new: "  if (raw is! Map<String, dynamic>) return null;",
  },
  {
    name: "a PARTIAL day is allowed to call itself a quiet day (a failed block becomes \"no sales\")",
    suite: "dart",
    file: DART_SCREEN,
    only: "a PARTIAL day whose flows read 0 is NOT called a quiet day",
    old: "    if (d.meta.partial) return false;",
    new: "    // FALSIFY: partial days may claim a quiet day",
  },
  // ── the app: cache window and honesty of what is on screen ───────────────
  {
    name: "the freshness window is ignored (every drawer open re-reads ERPNext)",
    suite: "dart",
    file: DART_SCREEN,
    only: "a fresh cached day costs NO request",
    old: "        if (!force && fresh) return;",
    new: "        // FALSIFY: freshness window ignored",
  },
  {
    name: "an aged cache is served WITHOUT re-reading (the day is never refreshed)",
    suite: "dart",
    file: DART_SCREEN,
    only: "a stale cache is re-read",
    old: "        if (!force && fresh) return;",
    new: "        if (!force) return;",
  },
  {
    name: "a cache older than the window is not labelled (old numbers pass as current)",
    suite: "dart",
    file: DART_SCREEN,
    only: "an aged cache is labelled OLD at once",
    old: "          _stale = !fresh;",
    new: "          _stale = false;",
  },
  {
    name: "an unknown provenance is printed as REAL (an invented source on a money screen)",
    suite: "dart",
    file: DART_FOOTER,
    only: "no server signal",
    old: "      _ => ('Không rõ nguồn dữ liệu', theme.colorScheme.outline),",
    new: "      _ => ('REAL ERPNext', theme.colorScheme.primary),",
  },
  {
    name: "a MOCK day is not marked (a rehearsal looks like the shop's books)",
    suite: "dart",
    file: DART_SCREEN,
    only: "a MOCK day says so",
    old: "    final mock = meta.erpTarget == 'MOCK';",
    new: "    final mock = false;",
  },
  // ── the server: the label the app renders ───────────────────────────────
  {
    name: "the skill stops sending erp_target (the footer has nothing honest to show)",
    suite: "node",
    file: "src/skills/ops-summary.mjs",
    nodeFile: NODE_FILES.skill,
    only: "P4 provenance: meta.erp_target is PASSED THROUGH",
    old: "      erp_target: erpTarget,\n",
    new: "",
  },
  {
    name: "the route stops passing the target (meta.erp_target silently disappears)",
    suite: "node",
    file: "src/http-ask.mjs",
    nodeFile: NODE_FILES.route,
    only: "POST with an explicit date returns the §4.3 object",
    old: "          erpTarget: erpTargetLabel(process.env),\n",
    new: "",
  },
  {
    name: "the label stops following the target switch (says MOCK while reading ERPNext)",
    suite: "node",
    file: "src/copilot-server.mjs",
    nodeFile: NODE_FILES.target,
    only: "erpTargetLabel says exactly what pickServerScript decided",
    old: '  return env.ERPNEXT_URL ? "REAL" : "MOCK";',
    new: '  return "MOCK";',
  },
];

function runNodeSuite(file, only) {
  // `npm test` sets COPILOT_MOCK_OK=1: the fixture is opt-in, and these suites
  // read through it. Without it the route refuses to start (by design).
  const proc = spawnSync(process.execPath, ["--test", `--test-name-pattern=${only.replace(/[?*+^$(){}|[\]\\]/g, "\\$&")}`, file], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
    env: { ...process.env, COPILOT_MOCK_OK: "1" },
  });
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
 * empty name and every case then looks "red but the wrong test" — which is how
 * this harness caught its own blind spot the first time it ran.
 */
function dartFailedTestNames(out) {
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

function runDartSuite(only) {
  const args = ["test", DART_SUITE];
  if (only) args.push("--plain-name", only);
  const proc = spawnSync("flutter", args, {
    cwd: MOBILE,
    encoding: "utf8",
    timeout: 900_000,
    env: { ...process.env, PATH: `${FLUTTER_DIR}:${process.env.PATH}` },
  });
  const out = `${proc.stdout}${proc.stderr}`;
  // A compile error is NOT a falsification: the suite never ran.
  if (/Error: .*(Compilation|compilation)|Failed to load|Compilation failed/.test(out)) {
    return { red: false, why: "DART SUITE DID NOT COMPILE", names: [] };
  }
  const names = dartFailedTestNames(out);
  return {
    red: proc.status !== 0 && names.length > 0,
    why: proc.status === 0 ? "suite stayed green" : `status=${proc.status} failed=[${names[0] ?? "?"}]`,
    names,
  };
}

const runners = {
  dart: (c) => runDartSuite(c.only),
  node: (c) => runNodeSuite(c.nodeFile, c.only),
};

// Baseline: every suite a case will use must start GREEN, otherwise "RED" after
// a mutation proves nothing about the mutation.
console.log("baseline [dart]: full daily_summary suite (expected green)");
const dartBase = runDartSuite(null);
if (dartBase.red) {
  console.error("baseline dart is not green — fix that first, a falsify run needs a green start");
  process.exit(1);
}
console.log("baseline [dart]: green\n");

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
  try {
    const { red, why, names } = runners[c.suite](c);
    // Being red is not enough: the NAMED test has to be the one that failed.
    const named = (names[0] ?? "").includes(c.only.slice(0, 24));
    results.push([
      c.name,
      red && named ? `RED ✓ (${why})` : red ? `RED NHƯNG SAI TEST ✗ (${why})` : `GREEN ✗ — GUARD KHÔNG ĐƯỢC TEST (${why})`,
      names[0] ?? "",
    ]);
  } finally {
    copyFileSync(backup, target);
    unlinkSync(backup);
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
const bad = results.filter(([, v]) => !v.startsWith("RED ✓"));
console.log(
  bad.length === 0
    ? `\nALL P4-3 GUARDS FALSIFIED (${results.length}/${CASES.length})`
    : `\nCHƯA CHỨNG MINH: ${bad.length}/${CASES.length}`,
);
process.exit(bad.length === 0 ? 0 : 1);
