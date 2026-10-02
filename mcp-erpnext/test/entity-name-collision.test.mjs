/**
 * Rule 2b — a name fragment may not resolve to a DIFFERENT customer just because
 * a shorter prefix of what the user typed happens to match uniquely.
 *
 * Why (measured on real ERPNext, 2026-09-21): the site has a customer
 * "Nguyễn Thị B" and no "Nguyễn Thị Lan". Asking "Nguyễn Thị Lan còn nợ bao
 * nhiêu" matched the fragment "Nguyễn Thị" uniquely and answered "Nguyễn Thị B
 * không còn nợ gì" — a confident wrong-customer answer with no ambiguity flag.
 * The distinguishing token "Lan" was silently dropped.
 *
 * These tests are hermetic (synthetic master data, no network, no NLP): they pin
 * the resolver CONTRACT, while the real-data check lives in the session evidence
 * (`result63.txt`).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { resolveCustomer, resolveSupplier } from "../src/copilot-server.mjs";

/** Minimal `skills` double — resolveCustomer only calls findCustomer(""). */
const skillsWith = (rows) => ({
  findCustomer: async () => ({ data: { data: rows } }),
  findSupplier: async () => ({ data: { data: rows } }),
});

const COLLISION = [{ name: "Nguyễn Thị B", customer_name: "Nguyễn Thị B" }];
/** The real site has both of these, which is why the measured result was AMBIGUOUS. */
const SITE_LIKE = [...COLLISION, { name: "Bùi Thị H", customer_name: "Bùi Thị H" }];

test("rule 2b: a longer typed name must NOT resolve to a shorter-matching customer", async () => {
  const r = await resolveCustomer(skillsWith(SITE_LIKE), "Nguyễn Thị Lan receivable bao nhiêu");
  assert.equal(r.customer, null, `resolved to the WRONG customer: ${JSON.stringify(r.customer)}`);
  // It must not silently pick; the user gets a question instead of an answer.
  assert.equal(r.ambiguous, true);
});

test("rule 2b: refusal does not depend on there being a collider to report", async () => {
  // With a SINGLE row there is no candidate list to offer, so the answer is
  // NO_MATCH rather than AMBIGUOUS — either way it must NOT name the wrong
  // customer, which is the property that matters.
  const r = await resolveCustomer(skillsWith(COLLISION), "Nguyễn Thị Lan receivable bao nhiêu");
  assert.equal(r.customer, null);
  assert.deepEqual(r.candidates, []);
});

test("rule 2b control: the customer who really has that name still resolves", async () => {
  const r = await resolveCustomer(skillsWith(COLLISION), "Nguyễn Thị B receivable bao nhiêu");
  assert.equal(r.customer?.name, "Nguyễn Thị B");
});

test("rule 2b does not shadow an EXACT match on the longer name", async () => {
  const rows = [...COLLISION, { name: "Nguyễn Thị Lan", customer_name: "Nguyễn Thị Lan" }];
  const r = await resolveCustomer(skillsWith(rows), "Nguyễn Thị Lan receivable bao nhiêu");
  assert.equal(r.customer?.name, "Nguyễn Thị Lan");
});

test("rule 2b: an INTENT word after the fragment must not block a real match", async () => {
  // "Bảy receivable bao nhiêu" — the token after "Bảy" is the router's intent
  // vocabulary, not extra name. Blocking here would be a coverage regression, so
  // intent tokens are read from the capability contract instead of hardcoded.
  const rows = [{ name: "Chú Bảy — chăn nuôi", customer_name: "Chú Bảy — chăn nuôi" }];
  const r = await resolveCustomer(skillsWith(rows), "Bảy receivable bao nhiêu");
  assert.equal(r.customer?.name, "Chú Bảy — chăn nuôi");
});

test("rule 2b: a spoken amount after the name must not block it (regression that rule 2b first caused)", async () => {
  // Real regression caught by the suite: "…cho chị Lan năm trăm ngàn" leaves
  // "năm" right after the matched fragment "Lan" — a letter token that is not
  // intent vocabulary and is absent from the row. The guard must not fire here:
  // the ROW's name ends at the match, so there is no name the user over-typed.
  const rows = [{ name: "Nguyễn Thị Lan", customer_name: "Nguyễn Thị Lan" }];
  const r = await resolveCustomer(skillsWith(rows), "payment cho chị Lan năm trăm ngàn");
  assert.equal(r.customer?.name, "Nguyễn Thị Lan");
  // …and the digit form (what the normaliser usually emits) must work too.
  const r2 = await resolveCustomer(skillsWith(rows), "payment cho chị Lan 500 ngàn");
  assert.equal(r2.customer?.name, "Nguyễn Thị Lan");
});

test("rule 2b: a partially typed name still resolves when the row contains the NEXT token too", async () => {
  // "Công ty ABC" vs stored "Công ty TNHH ABC": the fragment "Công ty" is followed
  // by "ABC", which the row DOES contain ⇒ accepting is correct.
  const rows = [{ name: "Công ty TNHH ABC", customer_name: "Công ty TNHH ABC" }];
  const r = await resolveCustomer(skillsWith(rows), "Công ty ABC receivable bao nhiêu");
  assert.equal(r.customer?.name, "Công ty TNHH ABC");
});

test("rule 2b blocks the WHOLE start position (a shorter fragment cannot re-pick it)", async () => {
  // "Nguyễn" alone also substring-matches "Nguyễn Thị B"; if only the exact
  // fragment were skipped, the loop would fall back to it and answer wrongly.
  const r = await resolveCustomer(skillsWith(COLLISION), "Nguyễn Thị Lan receivable bao nhiêu");
  assert.notEqual(r.customer?.name, "Nguyễn Thị B");
});

test("rule 2b applies to the SUPPLIER twin as well (same rule, other master list)", async () => {
  const rows = [{ name: "Nguyễn Thị B", supplier_name: "Nguyễn Thị B" }];
  const r = await resolveSupplier(skillsWith(rows), "Nguyễn Thị Lan payable bao nhiêu");
  assert.equal(r.supplier, null);
});

test("rule 2b: multi-word exact names are unaffected (no over-blocking)", async () => {
  const rows = [{ name: "Trang trại Minh Anh", customer_name: "Trang trại Minh Anh" }];
  const r = await resolveCustomer(skillsWith(rows), "cho biết nợ của Trang trại Minh Anh");
  assert.equal(r.customer?.name, "Trang trại Minh Anh");
});
