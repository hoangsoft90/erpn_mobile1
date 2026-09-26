#!/usr/bin/env node
/**
 * C1 falsification harness — lives IN THE REPO, like C0's (B2/B3 left theirs in
 * /tmp and both rotted; a harness nobody can re-run proves nothing).
 *
 * C1 spans two runtimes, so this one breaks guards on both sides of the wire:
 * the `/ocr` route (Node, `node --test`) and the camera UI (Dart,
 * `flutter test test/chat_camera_test.dart`). Each case names the invariant it
 * destroys, mutates the file in place, and requires the named suite to go RED.
 *
 * Usage:  node scripts/falsify/c1-ocr.mjs
 * Exit:   0 = every guard went RED when broken; 1 = something did not (or a
 *         file could not be restored byte-identically, which stops the run).
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

const NODE_SUITE = "test/c1-camera-ocr-endpoint.test.mjs";
const DART_SUITE = "test/chat_camera_test.dart";

const CASES = [
  // ---- server: what the route is allowed to answer -------------------------
  {
    name: "route-level input check removed (a request with NO image is answered by a canned reading)",
    suite: "node",
    file: "src/http-ask.mjs",
    old: "        assertOcrInput({ image: body?.image, mimeType: body?.mime_type });",
    new: "        // FALSIFY: route-level input check removed",
  },
  {
    name: "mock flag dropped (a fixture can pass as the user's own document)",
    suite: "node",
    file: "src/http-ask.mjs",
    old: '            mock: prepared.provider === "mock",',
    new: "            mock: false,",
  },
  {
    name: "wrapped prompt text returned to the client (server-side variant leaks out)",
    suite: "node",
    file: "src/http-ask.mjs",
    old: '            mock: prepared.provider === "mock",',
    new: '            mock: prepared.provider === "mock",\n            wrapped: prepared.wrapped,',
  },
  {
    name: "recognised text written to the log line (the user's document becomes a log field)",
    suite: "node",
    file: "src/http-ask.mjs",
    old: "        process.stderr.write(`${ocrLogLine({ result, prepared, image: body?.image, ms: prepared ? Date.now() - ocrStartedAt : null })}\\n`);",
    new: "        process.stderr.write(`[ocr] text=${prepared.text} ${ocrLogLine({ result, prepared, image: body?.image, ms: null })}\\n`);",
  },
  {
    name: "operator misconfiguration silently answered by the mock (loud 500 becomes a fake reading)",
    suite: "node",
    file: "src/http-ask.mjs",
    old: "        ocrProvider = getOcrProvider(env);",
    new: "        ocrProvider = getOcrProvider({});",
  },

  // ---- client: what the app is allowed to do with a reading ----------------
  {
    name: "camera channel auto-sends after inject (a photo becomes a command)",
    suite: "dart",
    file: "../apps/mobile/lib/features/chat/presentation/screens/chat_screen.dart",
    old: "      // NOTE: no _maybeAutoSend() here on purpose — see the doc comment.",
    new: "      await _maybeAutoSend();",
  },
  {
    name: "client trusts an unknown status claiming usable:true (fail-open parsing)",
    suite: "dart",
    file: "../apps/mobile/lib/features/chat/data/ocr_models.dart",
    old: "      usable: known && status == statusOk && json['usable'] == true,",
    new: "      usable: json['usable'] == true,",
  },
  {
    name: "inject offered for an unusable reading (an unsure read is used silently)",
    suite: "dart",
    file: "../apps/mobile/lib/features/chat/presentation/widgets/ocr_sheet.dart",
    old: "            if (usable)\n              FilledButton.icon(",
    new: "            if (true)\n              FilledButton.icon(",
  },
  {
    name: "mock reading not labelled (a rehearsal can pass as a real reading)",
    suite: "dart",
    file: "../apps/mobile/lib/features/chat/presentation/widgets/ocr_sheet.dart",
    old: "            if (read.mock) ...[",
    new: "            if (false) ...[",
  },
];

function runNodeSuite() {
  const proc = spawnSync(process.execPath, ["--test", NODE_SUITE], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
  });
  const out = `${proc.stdout}${proc.stderr}`;
  const m = out.match(/^ℹ fail (\d+)$/m);
  const fails = m ? Number(m[1]) : proc.status === 0 ? 0 : -1;
  const names = out
    .split("\n")
    .filter((l) => l.startsWith("✖") && !l.includes("failing"))
    .map((l) => l.replace(/^✖ /, "").slice(0, 78));
  return { fails, names };
}

function runDartSuite() {
  const proc = spawnSync("flutter", ["test", DART_SUITE], {
    cwd: MOBILE,
    encoding: "utf8",
    timeout: 900_000,
    env: { ...process.env, PATH: `${FLUTTER_DIR}:${process.env.PATH}` },
  });
  const out = `${proc.stdout}${proc.stderr}`;
  // A compile error is NOT a falsification: the suite never ran.
  if (/Error: .*(Compilation|compilation)|Failed to load/.test(out)) {
    return { fails: -1, names: ["DART SUITE DID NOT COMPILE"] };
  }
  const names = out
    .split("\n")
    .filter((l) => l.trim().startsWith("The test description was:"))
    .map((l) => l.replace(/.*The test description was: /, "").slice(0, 78));
  return { fails: proc.status === 0 ? 0 : Math.max(1, names.length), names };
}

const runners = { node: runNodeSuite, dart: runDartSuite };

// Baseline: both suites must start green, otherwise "RED" proves nothing.
for (const [kind, run] of Object.entries(runners)) {
  const base = run();
  console.log(`baseline [${kind}]: ${base.fails} failing (expected 0)`);
  if (base.fails !== 0) {
    console.error(`baseline ${kind} is not green — fix that first, a falsify run needs a green start`);
    process.exit(1);
  }
}
console.log("");

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
    const { fails, names } = runners[c.suite]();
    results.push([
      c.name,
      fails > 0 ? `RED ✓ (fail=${fails})` : "GREEN ✗ — GUARD KHÔNG ĐƯỢC TEST",
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
const bad = results.filter(([, v]) => !v.startsWith("RED"));
console.log(bad.length === 0 ? "\nALL C1 GUARDS FALSIFIED" : `\nCHƯA CHỨNG MINH: ${bad.length}`);
process.exit(bad.length === 0 ? 0 : 1);
