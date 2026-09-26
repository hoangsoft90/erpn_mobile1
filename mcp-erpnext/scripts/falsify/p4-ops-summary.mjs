#!/usr/bin/env node
/**
 * P4-1 falsification harness — break ONE guard at a time, prove the suite
 * turns RED, restore byte-identical, and never leave a mutation on disk
 * (LESSONS_LEARNED group 17: bounded runtime, restores in finally, refuses to
 * continue when the restore is not byte-identical).
 *
 * A guard whose removal turns nothing red is decoration — this file is how
 * that claim gets checked for the ops summary.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, "..", ".."); // mcp-erpnext/ (this file lives in scripts/falsify/)

const CASES = [
  {
    // §7.10: the summary must not count drafts as submitted orders.
    name: "A. draft SO merged into submitted totals",
    file: "src/skills/ops-summary.mjs",
    find: 'const drafts = rows.filter((r) => r.docstatus === 0 && r.status !== "Cancelled");',
    replace: 'const drafts = rows.filter(() => false);',
    // Merging drafts into submitted is the SAME family: the submitted block
    // would then include the 120M draft ⇒ the §10.1 test must catch it. This
    // mutation kills the draft block instead — caught by its exact-count test.
  },
  {
    name: "B. cancelled invoices counted (§3.1b broken)",
    file: "src/skills/ops-summary.mjs",
    find: 'return rows.filter((r) => r.docstatus === 1 && r.status !== "Cancelled");',
    replace: 'return rows.filter((r) => r.docstatus === 1);',
  },
  {
    name: "C. returns excluded from invoices (§3.5 broken)",
    file: "src/skills/ops-summary.mjs",
    find: "rowOfCompany(r, company) && !r.is_return",
    replace: "rowOfCompany(r, company)",
  },
  {
    name: "D. advance split collapses into against_invoice (§3.2 broken)",
    file: "src/skills/ops-summary.mjs",
    find: "const againstInvoice = receive.filter((r) => Array.isArray(r.references) && r.references.length > 0);",
    replace: "const againstInvoice = receive;",
  },
  {
    // The P4-0 lesson: classify by the ACCOUNT of the money side, never by the
    // mode (on the real site 'Chuyển khoản' has MoP.type=Cash while its PE rows
    // hit the bank account). Mutating the CALL SITE is the honest version:
    // passing the mode instead of the account must break the cash/bank split.
    name: "E. classifier fed the MODE instead of the money account (P4-0 lesson broken)",
    file: "src/skills/ops-summary.mjs",
    find: "      return classifyMoneyAccount(sideOf(row), { accountsByCompany, companyDefaults: defaults });",
    replace: "      return classifyMoneyAccount(row.mode_of_payment ?? sideOf(row), { accountsByCompany, companyDefaults: defaults });",
  },
  {
    // §4.3 literal: a failed branch must surface as a NULL block; replacing it
    // with a fabricated zero-shaped block is the exact failure §4.3 forbids.
    name: "F. a failed branch is rewritten to a fake zero block (§4.3 broken)",
    file: "src/skills/ops-summary.mjs",
    find: "    sales_orders: so.ok ? so.value : null,",
    replace: "    sales_orders: so.ok ? so.value : { submitted: { count: 0, amount: 0 }, draft: { count: 0, amount: 0 } },",
  },
  {
    name: "G. missing company default becomes a 0 opening (két invented)",
    file: "src/skills/ops-summary.mjs",
    find: "if (!defs.cash) return null; // §10.3 / §3.6: no configured opening → hide the block",
    replace: 'if (!defs.cash) return { opening: 0, cash_in_today: 0, cash_out_today: 0, expected_closing: 0, account: null, includes_bank: false };',
  },
  {
    name: "H. untyped account guessed as cash (unclassified broken)",
    file: "src/skills/ops-summary.mjs",
    find: '  return "unclassified";\n}',
    replace: '  return "cash";\n}',
  },
  {
    // The routing-isolation guard lives in the CONTRACT: ops must stay absent
    // from the keyword table. Mutating the skill can't test that; mutating the
    // contract file can.
    name: "I. malformed ERP response iterated as data (Array.isArray guard removed)",
    file: "src/skills/ops-summary.mjs",
    find: "  if (!rows) {\n    throw new Error(`ERP_MALFORMED_RESPONSE: ${doctype} list did not return an array`);\n  }",
    replace: "",
  },
  {
    // Measured on the real tool (2026-09-21): `count` is the RETURNED page size,
    // not the filtered total, so without this guard a truncated page is summed
    // as if it were complete — a silently wrong MONEY number.
    name: "J. truncation guard removed (a partial page is summed as complete)",
    file: "src/skills/ops-summary.mjs",
    find: "  if (rows.length > limit) {\n    throw new Error(`ERP_TRUNCATED: ${doctype} matched more than ${limit} rows — refusing to sum a partial page`);\n  }",
    replace: "",
  },
  {
    // A numeric filter value ships again. The mock validates nothing, so no
    // runtime test can see it — the static tripwire over the source is what
    // must turn red.
    name: "K. a NUMERIC filter literal ships again in ops-summary (the real tool rejects it)",
    // Run ONLY the tripwire: with the whole suite running, a case could go red for
    // an unrelated reason and the evidence would be worthless (LESSONS: "đỏ không
    // đúng chỗ"). The tripwire alone must be what fails.
    only: "test/filter-literal-types.test.mjs",
    file: "src/skills/ops-summary.mjs",
    find: '      filters: [["docstatus", "=", "1"], ["outstanding_amount", ">", "0"]],',
    replace: '      filters: [["docstatus", "=", 1], ["outstanding_amount", ">", "0"]],',
  },
  {
    // The same latent bug in the WRITE path: the Item Price read every sales
    // order / quotation proposal performs. Caught by the repo-wide tripwire
    // (test/filter-literal-types.test.mjs), which is run alongside the ops test.
    name: "M. a NUMERIC filter literal ships again in the sales-order writer",
    only: "test/filter-literal-types.test.mjs",
    file: "src/skills/sales-order-write.mjs",
    find: '      filters: [["selling", "=", "1"]],',
    replace: '      filters: [["selling", "=", 1]],',
  },
  {
    // The array form of the same violation: `in` with numeric elements. Its own
    // case (not folded into K) because the regex's value group stops at the first
    // `]` — this is the shape that would otherwise slip through silently.
    name: "N. a NUMERIC ARRAY filter value ships again (`in` with numbers)",
    only: "test/filter-literal-types.test.mjs",
    file: "src/skills/ops-summary.mjs",
    find: '      filters: [["docstatus", "=", "1"], ["outstanding_amount", ">", "0"]],',
    replace: '      filters: [["docstatus", "in", ["0", 1]], ["outstanding_amount", ">", "0"]],',
  },
  {
    // §4.3: the branch that cannot answer must NOT answer 0. This restores the
    // exact bug the real site exposed (correlation field missing on 3 of the 4
    // doctypes ⇒ a confident "0 nháp").
    name: "L. app_drafts swallows its failures and reports a confident 0 (§4.3 broken)",
    file: "src/skills/ops-summary.mjs",
    // NOTE (2026-09-21, P4-5): this anchor must track the appDrafts field list.
    // It drifted once ("company" was added for company scoping) and the harness
    // correctly reported `anchor missing` instead of silently skipping the case
    // — a skipped case looks identical to a passing one in a summary line.
    find: "      const res = await docList(mcp, doctype, {\n        fields: [\"name\", \"docstatus\", \"custom_ai_action_id\", dateField, \"company\"],\n        filters: [[\"custom_ai_action_id\", \"is\", \"set\"]],\n        limit: 500,\n      });",
    replace: "      let res = [];\n      try {\n        res = await docList(mcp, doctype, {\n          fields: [\"name\", \"docstatus\", \"custom_ai_action_id\", dateField, \"company\"],\n          filters: [[\"custom_ai_action_id\", \"is\", \"set\"]],\n          limit: 500,\n        });\n      } catch {\n        res = []; // swallowed failure ⇒ the block answers a confident 0\n      }",
  },
  {
    // §7.6: a doctype the API user may NOT read must stay a NULL block. This is
    // the same fabricated-0 family as L, in the shape that is easiest to ship by
    // accident: a wrapper that treats Frappe's PermissionError (HTTP 403) as "no
    // rows" — the owner then reads "hôm nay chưa bán được gì" when the truth is
    // "không đọc được". Caught by the §7.6 test asserting NULL (not 0).
    name: "O. a PermissionError is swallowed into an empty page (a denial becomes 0)",
    file: "src/skills/ops-summary.mjs",
    find: '  const res = await mcp.callTool("erpnext_doc_list", { doctype, fields, filters, limit: limit + 1, order_by });',
    replace: '  let res;\n  try {\n    res = await mcp.callTool("erpnext_doc_list", { doctype, fields, filters, limit: limit + 1, order_by });\n  } catch (e) {\n    if (String(e?.message ?? e).includes("PermissionError")) return []; // denial ⇒ "no rows"??\n    throw e;\n  }',
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
    const suites = c.only
      ? [c.only]
      : ["test/p4-ops-summary.test.mjs", "test/filter-literal-types.test.mjs"];
    execFileSync(
      process.execPath,
      ["--test", ...suites],
      {
        cwd: ROOT,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 60_000,
      },
    );
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
