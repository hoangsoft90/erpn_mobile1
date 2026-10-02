/**
 * Repo-wide invariant: every `filters` VALUE literal sent to the pinned ERPNext
 * list tool must be a STRING.
 *
 * Why a static tripwire instead of a runtime check: measured on the real tool
 * (2026-09-21, P4-1) — `[["selling","=",1]]` answers
 * `TOOL_ERROR: Property /filters/0/2 must be string`, while `src/mock-server.mjs`
 * validates nothing. A numeric literal therefore passes EVERY feature test and
 * only fails against the site, which is exactly how three real reads stayed
 * broken unnoticed: `receivables` in skills/ops-summary.mjs (the whole branch
 * died → 551,910,625 never shown) and the Item Price read in
 * skills/sales-order-write.mjs + skills/quotation-write.mjs (the write path's
 * price lookup). A runtime guard cannot catch it either: every filter in the
 * repo is a literal, so no test can reach such a guard.
 *
 * Comments are stripped before scanning — a comment that NAMES the forbidden
 * form ("the tool rejects a numeric 1") is documentation, not a violation.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));

/** Every .mjs under src/, recursively — a new skill is covered automatically. */
function sourceFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return entry.name.endsWith(".mjs") ? [full] : [];
  });
}

const TRIPLE = /\[\s*"([a-z_]+)"\s*,\s*"(=|>|<|<=|>=|!=|is|like|in)"\s*,\s*([^\]]+?)\s*\]/g;

/**
 * The SAME triple when the FIELD is a variable instead of a quoted literal.
 *
 * MEASURED GAP (2026-09-24, A2 real loop): the pattern above requires a quoted
 * lowercase field name, so `[[side, "=", 1]]` was never scanned — and that is
 * exactly how the two Item Price reads stayed numeric and kept failing against
 * the site only: `skills/inventory.mjs` (used by every order builder's price
 * lookup) and `skills/purchase-order-write.mjs` (the executor's drift re-read).
 * A repo-wide invariant that misses the form it was written for is the one thing
 * worse than no invariant, because everyone trusts it.
 */
const TRIPLE_VAR_FIELD = /\[\s*[A-Za-z_$][\w$]*\s*,\s*"(=|>|<|<=|>=|!=|is|like|in)"\s*,\s*([^\]]+?)\s*\]/g;

test("static tripwire: no NUMERIC filter literal anywhere in src/ (ERPNext only accepts string values)", () => {
  const triples = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    for (const m of src.matchAll(TRIPLE)) {
      triples.push({ file: path.relative(SRC, file), field: m[1], op: m[2], value: m[3].trim() });
    }
  }

  // Control: the scan must still FIND the repo's filters (15 across 6 files at
  // the time of writing). Without this, a moved/renamed src/ would make the test
  // pass by finding nothing at all.
  assert.ok(
    triples.length >= 12,
    `expected to find the repo's filter literals, found ${triples.length} — did the scan break, not the code?`,
  );

  for (const t of triples) {
    // A value can be an ARRAY (`["docstatus","in",[0,1]]`): the real tool rejects
    // numeric elements there too, and the regex's value group stops at the first
    // `]` — so the array form is checked element by element. `+` is accepted as
    // a numeric prefix on purpose: `["x","=",+1]` is the same violation.
    const values = t.value.startsWith("[") ? t.value.slice(1).split(",") : [t.value];
    for (const raw of values) {
      const v = raw.trim();
      assert.ok(
        !/^[+-]?\d/.test(v),
        `${t.file}: filter ["${t.field}","${t.op}",${t.value}] uses a numeric value — ERPNext only accepts string filter values`,
      );
    }
  }

  // The same rule for a VARIABLE field name — the form this scan used to miss.
  const varFieldTriples = [];
  for (const file of sourceFiles(SRC)) {
    const src = readFileSync(file, "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    for (const m of src.matchAll(TRIPLE_VAR_FIELD)) {
      varFieldTriples.push({ file: path.relative(SRC, file), op: m[1], value: m[2].trim() });
    }
  }
  // Control again: the repo does carry variable-field filters (`[[field, "=", value]]`
  // and `[[side, "=", "1"]]`), so finding none means the scan broke.
  assert.ok(
    varFieldTriples.length >= 5,
    `expected to find variable-field filter triples, found ${varFieldTriples.length} — did the scan break, not the code?`,
  );
  for (const t of varFieldTriples) {
    const values = t.value.startsWith("[") ? t.value.slice(1).split(",") : [t.value];
    for (const raw of values) {
      const v = raw.trim();
      assert.ok(
        !/^[+-]?\d/.test(v) && v !== "true" && v !== "false",
        `${t.file}: filter [<field>,"${t.op}",${t.value}] uses a numeric/boolean value — ERPNext only accepts string filter values`,
      );
    }
  }
});
