#!/usr/bin/env node
/**
 * C2 falsification harness — in the repo, like C0/C1's (B2/B3 left theirs in
 * /tmp and both rotted). Breaks one guard at a time across BOTH runtimes and
 * requires the named suite to go RED.
 *
 * Guards under test:
 *   contract  — the kind→capability mapping cannot weaken (stub / submit / unknown)
 *   provenance — a low-confidence or MOCK reading cannot seed a draft document
 *   strictness — a truncated or digit-glued party name cannot auto-pick a row
 *   route     — /ocr/slots refuses what the gate refuses
 *   client    — the sheet hides kind buttons for readings the server would refuse
 *
 * Usage:  node scripts/falsify/c2-ocr.mjs
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

const NODE_SUITE = "test/c2-ocr-proposal.test.mjs";
const DART_SUITE = "test/ocr_slots_form_test.dart";

const CASES = [
  // ---- contract: the kind mapping is not a back door -----------------------
  {
    name: "a kind may point at a STUB (form for purchase_receipt)",
    suite: "node",
    file: "src/capability-contract.mjs",
    old: "    if (!executableIds.includes(spec.capability)) {",
    new: "    if (false) {",
  },
  {
    name: "a kind may point at a submit-capable write (payment.create)",
    suite: "node",
    file: "src/capability-contract.mjs",
    old: "    if (cap.execution?.draft_only !== true) {\n      fail(`document_kinds.${kind} → ${spec.capability} is not draft_only (a photo must never reach a submit-capable write)`);\n    }",
    new: "    if (false) {\n      fail(`document_kinds.${kind} → ${spec.capability} is not draft_only (a photo must never reach a submit-capable write)`);\n    }",
  },

  // ---- provenance: a fixture or an unsure read cannot become a document ----
  {
    name: "a MOCK reading may seed slots (the default provider becomes a back door)",
    suite: "node",
    file: "src/ocr/ocr-slots.mjs",
    old: "  if (provenance?.mock === true) {",
    new: "  if (false) {",
  },
  {
    name: "the confidence floor is removed (a 0.2 read becomes a form)",
    suite: "node",
    file: "src/ocr/ocr-slots.mjs",
    old: "  if (confidence < policy.min_confidence) {",
    new: "  if (false) {",
  },
  {
    name: "the route skips the provenance gate entirely",
    suite: "node",
    file: "src/http-ask.mjs",
    old: "        slotsProvenance = assertSlotsProvenance(body?.ocr);",
    new: "        slotsProvenance = { status: \"OK\", confidence: 1, min_confidence: 0 };",
  },

  // ---- strictness: photos are lossy, names must not be guessed -------------
  {
    name: "a TRUNCATED name auto-picks its single substring hit again",
    suite: "node",
    file: "src/ocr/ocr-slots.mjs",
    old: "  const resolution = resolvePartyFromPhoto(parties, normalized, accessors);",
    new: "  const { resolveEntityByText } = await import(\"../entity-resolution.mjs\");\n  const resolution = resolveEntityByText(parties, normalized, accessors);",
  },
  {
    name: "word-boundary matching removed (\"Hà Tiên 20 Bao\" picks \"Hà Tiên 2\")",
    suite: "node",
    file: "src/ocr/ocr-slots.mjs",
    old: "    const re = new RegExp(`(^|\\\\W)${needle.replace(/[.*+?^${}()|[\\]\\\\]/g, \"\\\\$&\")}(\\\\W|$)`);",
    new: "    const re = null; // FALSIFY: boundaries gone\n    return haystack.includes(needle);",
  },

  // ---- size bound: the client trip re-enforces the policy bound -------------
  {
    name: "the route no longer bounds the reading's length (1 MB text reaches NLP)",
    suite: "node",
    file: "src/http-ask.mjs",
    old: "        assertSlotsText(body?.text);",
    new: "        assertSlotsText(\"\"); // FALSIFY: bound gone",
  },

  // ---- client: the sheet mirrors the server's rules -------------------------
  {
    name: "the sheet offers document kinds for a MOCK reading",
    suite: "dart",
    file: "../apps/mobile/lib/features/chat/presentation/widgets/ocr_sheet.dart",
    old: "            if (usable && read.confidence != null && !read.mock) ...[",
    new: "            if (usable) ...[",
  },
  {
    name: "the app sends a capability id instead of the kind word",
    suite: "dart",
    file: "../apps/mobile/lib/features/chat/data/copilot_api_client.dart",
    old: "          'kind': kind,",
    new: "          'kind': kind,\n          'capability': kind == 'purchase' ? 'purchase_order.create' : 'sales_order.create',",
  },
];

function runNodeSuite() {
  // COPILOT_MOCK_OK matches `npm test` (package.json): without it the http-ask
  // fail-loud config check makes 3 route tests fail — the same hazard as the
  // "ran node --test by hand" lesson from P4-4 (2026-09-21).
  const proc = spawnSync(process.execPath, ["--test", NODE_SUITE], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
    env: { ...process.env, COPILOT_MOCK_OK: "1" },
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

for (const [kind, run] of Object.entries(runners)) {
  const base = run();
  console.log(`baseline [${kind}]: ${base.fails} failing (expected 0)`);
  if (base.fails !== 0) {
    console.error(`baseline ${kind} is not green — fix that first`);
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
console.log(bad.length === 0 ? "\nALL C2 GUARDS FALSIFIED" : `\nCHƯA CHỨNG MINH: ${bad.length}`);
process.exit(bad.length === 0 ? 0 : 1);
