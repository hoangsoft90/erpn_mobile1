/**
 * The correlation-field migration is a SCHEMA step an operator runs, so it has
 * no runtime guard of its own — which is exactly why its SCOPE needs a test.
 *
 * Failure mode being prevented: a new WRITE capability is declared (B4 will add
 * one) and its doctype never gets the correlation field. The executors then
 * refuse every write on that doctype (fail-closed, but the feature is dead), and
 * nobody notices until go-live. The script derives its target list from the
 * contract precisely so that cannot happen — this test proves the derivation
 * actually covers everything, instead of trusting the script's own comment.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { getCapability, isForbidden, listCapabilities } from "../src/capability-contract.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const SCRIPT = path.join(ROOT, "scripts", "add-correlation-field.mjs");

/** Run the operator script in its no-network, no-credentials mode. */
function planOnly() {
  const res = spawnSync(process.execPath, [SCRIPT, "--plan-only"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ERPNEXT_URL: "", ERPNEXT_API_KEY: "", ERPNEXT_API_SECRET: "" },
  });
  assert.equal(res.status, 0, `plan-only must succeed without credentials: ${res.stderr}`);
  return [...res.stdout.matchAll(/doctype="([^"]+)" field="([^"]+)" capability="([^"]+)"/g)].map((m) => ({
    doctype: m[1],
    field: m[2],
    capability: m[3],
  }));
}

test("correlation-field migration: scope is DERIVED from the contract, and covers every write", () => {
  const planned = planOnly();

  // The migration plan DEDUPES by (doctype|field) — two capabilities writing the
  // SAME doctype (sales_invoice.create and sales_return.create both write Sales
  // Invoice) share ONE target. The expectation below mirrors that dedupe by
  // collapsing to the FIRST capability per pair, so "each contract write is
  // covered" means "each (doctype, field) the contract names is covered".
  // next3/B added a SECOND FAMILY of targets to the same derivation: a
  // capability that declares `business_doc_key.field` needs that column too
  // (Purchase Order today). Both families are mirrored here, so the expectation
  // still comes from the contract rather than from a list kept in this file.
  const seen = new Set();
  const expected = listCapabilities()
    .filter((id) => getCapability(id)?.type === "WRITE" && !isForbidden(id))
    .filter((id) => getCapability(id)?.execution?.write_doctype)
    .flatMap((id) => {
      const cap = getCapability(id);
      const rows = [
        { capability: id, doctype: cap.execution.write_doctype, field: cap.execution.correlation_field ?? "custom_ai_action_id" },
      ];
      if (cap.business_doc_key?.field) {
        rows.push({ capability: id, doctype: cap.execution.write_doctype, field: cap.business_doc_key.field });
      }
      return rows;
    })
    .filter((e) => {
      const key = `${e.doctype}|${e.field}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

  for (const e of expected) {
    assert.ok(
      planned.some((p) => p.capability === e.capability && p.doctype === e.doctype && p.field === e.field),
      `migration must cover ${e.capability} -> ${e.doctype}.${e.field}`,
    );
  }
  assert.equal(planned.length, expected.length, "the plan must not invent targets outside the contract");

  // Spelled out independently, so a silent contract edit cannot make this test
  // agree with itself: these are the writes that exist today (B2 + B3 + B4's
  // Purchase Order + P9-A2's Delivery Note + P9-B's Purchase Receipt +
  // P9-D's Sales Invoice + P9-E's Stock Entry + P9-F's sales return — the
  // return writes the SAME Sales Invoice doctype, so no new target appears;
  // every one is a doctype whose executors refuse every write until this field
  // exists, which is what makes the coverage real).
  // Two fields on ONE doctype is the expected next3/B shape, so this list is the
  // deduped set of doctypes (the pair-level coverage is asserted above).
  assert.deepEqual(
    [...new Set(planned.map((p) => p.doctype))].sort(),
    // M1 (2026-09-23) added the tenth WRITE (customer.create) — Customer joins
    // the migration scope like every other write doctype.
    ["Customer", "Delivery Note", "Payment Entry", "Purchase Order", "Purchase Receipt", "Quotation", "Sales Invoice", "Sales Order", "Stock Entry"],
  );
  // P9-E FLIPPED THIS ASSERTION on purpose. It read `=== false` to pin "a stub
  // never gets a migrated doctype" on Stock Entry, because that doctype was
  // still fictional. The write-off capability now names it, so the assertion
  // inverts: asking ERPNext for the field on Stock Entry is the expected state,
  // not a bug. The old invariant is not lost, it is just un-pinnable right now —
  // there is no stub WRITE left to pin it on (the same situation the
  // capability-contract test documents). The loop above still proves the half
  // that matters either way: the plan covers exactly what the contract declares
  // and invents no target outside it.
  assert.equal(planned.some((p) => p.doctype === "Stock Entry"), true);
  // next3/B: the document-identity column for the purchase path — the executor
  // refuses every keyed write until it exists, so it MUST be in the plan.
  assert.equal(
    planned.some((p) => p.doctype === "Purchase Order" && p.field === "custom_business_doc_key"),
    true,
    "the purchase document-identity column must be in the migration plan",
  );
  // Forbidden capabilities never reach the schema step.
  assert.equal(planned.some((p) => p.capability === "document.delete"), false);
});

test("correlation-field migration: restricting the scope cannot widen it", () => {
  const res = spawnSync(process.execPath, [SCRIPT, "--plan-only", "Sales Order"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ERPNEXT_URL: "", ERPNEXT_API_KEY: "", ERPNEXT_API_SECRET: "" },
  });
  assert.equal(res.status, 0, res.stderr);
  const doctypes = [...res.stdout.matchAll(/doctype="([^"]+)"/g)].map((m) => m[1]);
  assert.deepEqual(doctypes, ["Sales Order"]);

  // An unknown doctype is a refusal, not a silent no-op that "succeeds".
  // P9-D moved this example to Sales Invoice, and M1 then moved it AGAIN: every
  // doctype a WRITE capability names is in scope, so the "nobody declared it"
  // case needs a doctype NO capability will ever write from chat.
  const bad = spawnSync(process.execPath, [SCRIPT, "--plan-only", "Journal Entry"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ERPNEXT_URL: "", ERPNEXT_API_KEY: "", ERPNEXT_API_SECRET: "" },
  });
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /không có WRITE capability nào khai write_doctype/);
});
