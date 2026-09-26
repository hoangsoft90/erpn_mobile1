#!/usr/bin/env node
/**
 * C0 falsification harness — lives IN THE REPO on purpose.
 *
 * B2/B3 left their harnesses in /tmp and both rotted silently (anchors went
 * stale as later phases edited the same files; the review on 2026-09-20 found
 * B2's case A reporting "MUTATION NOT APPLIED" and B3's crashing). A guard whose
 * removal changes nothing is not a guard — but a harness nobody can re-run
 * proves nothing either. So this one is versioned next to the code it breaks.
 *
 * Usage:  node scripts/falsify/c0-ocr.mjs
 * Exit:   0 = every named guard went RED when broken; 1 = something did not.
 */

import { readFileSync, writeFileSync, copyFileSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", ".."); // mcp-erpnext/
const TEST = "test/c0-ocr-foundation.test.mjs";

/**
 * Each case names the invariant it breaks and the file that implements it.
 * `old` must be the EXACT text in the file today — a stale anchor is reported
 * as "ANCHOR STALE", never silently treated as a pass.
 */
const CASES = [
  {
    name: "contract relaxed: log_raw_image=true (a PII rule turned optional)",
    file: "capabilities.json",
    old: '"log_raw_image": false,',
    new: '"log_raw_image": true,',
  },
  {
    name: "sanitisation removed in the seam (OCR text reaches the classifier raw)",
    file: "src/ocr/ocr-provider.mjs",
    old: "  const text = sanitizeUntrustedText(raw, { maxLength: policy.max_text_length });",
    new: "  const text = raw;",
  },
  {
    name: "confidence gate removed (a 0.4-confidence read becomes usable)",
    file: "src/ocr/ocr-provider.mjs",
    old: '  else if (confidence !== null && confidence < policy.min_confidence) status = "LOW_CONFIDENCE";',
    new: '  else if (false) status = "LOW_CONFIDENCE";',
  },
  {
    name: "unknown provider silently accepted (a typo stops being an error)",
    file: "src/ocr/ocr-provider.mjs",
    old: "  if (!policy.allowed_providers.includes(id)) {",
    new: "  if (false) {",
  },
  {
    name: "hint sent to the model unwrapped (caller text promoted to instructions)",
    file: "src/ocr/providers/router-vision.mjs",
    old: "text: hint ? `Gợi ý ngữ cảnh (dữ liệu): ${wrapUntrusted(hint)}` : \"Đọc toàn bộ chữ trong ảnh.\"",
    new: "text: hint ? `Gợi ý ngữ cảnh (dữ liệu): ${hint}` : \"Đọc toàn bộ chữ trong ảnh.\"",
  },
  {
    name: "router HTTP failure ignored (a 502 tries to parse as a reading)",
    file: "src/ocr/providers/router-vision.mjs",
    old: "      if (!res.ok) {",
    new: "      if (false) {",
  },
  {
    name: "image-type allowlist removed (a caller string reaches the data: URL)",
    file: "src/ocr/ocr-provider.mjs",
    old: "  if (!OCR_IMAGE_TYPES.includes(mimeType)) {",
    new: "  if (false) {",
  },
  {
    name: "image size cap removed (a 12 MB photo is attempted, not refused)",
    file: "src/ocr/ocr-provider.mjs",
    old: "  if (bytes > policy.max_image_bytes) {",
    new: "  if (false) {",
  },
  {
    name: "write surface added to the OCR layer (erpnext_doc_create referenced)",
    file: "src/ocr/ocr-provider.mjs",
    old: "/** Outcomes of turning an OCR result into pipeline-ready text. */",
    new: "// erpnext_doc_create — FALSIFY probe\n/** Outcomes of turning an OCR result into pipeline-ready text. */",
  },
];

function runSuite() {
  const proc = spawnSync(process.execPath, ["--test", TEST], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 600_000,
  });
  const out = `${proc.stdout}${proc.stderr}`;
  const m = out.match(/^ℹ fail (\d+)$/m);
  const fails = m ? Number(m[1]) : -1;
  const names = out
    .split("\n")
    .filter((l) => l.startsWith("✖") && !l.includes("failing"))
    .map((l) => l.replace(/^✖ /, "").slice(0, 78));
  return { fails, names };
}

const baseline = runSuite();
console.log(`baseline: ${baseline.fails} failing (expected 0)\n`);
if (baseline.fails !== 0) {
  console.error("baseline is not green — fix that first, a falsify run needs a green start");
  process.exit(1);
}

const results = [];
for (const c of CASES) {
  const target = path.join(ROOT, c.file);
  const backup = `${target}.falsify-bak`;
  const original = readFileSync(target, "utf8");
  if (!original.includes(c.old)) {
    results.push([c.name, "ANCHOR STALE — não áp được", ""]);
    continue;
  }
  copyFileSync(target, backup);
  writeFileSync(target, original.replace(c.old, c.new));
  const changed = readFileSync(target, "utf8") !== original;
  try {
    if (!changed) {
      results.push([c.name, "MUTATION NOT APPLIED", ""]);
      continue;
    }
    const { fails, names } = runSuite();
    results.push([c.name, fails > 0 ? `RED ✓ (fail=${fails})` : "GREEN ✗ — GUARD KHÔNG ĐƯỢC TEST", names[0] ?? ""]);
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
console.log(bad.length === 0 ? "\nALL C0 GUARDS FALSIFIED" : `\nCHƯA CHỨNG MINH: ${bad.length}`);
process.exit(bad.length === 0 ? 0 : 1);
