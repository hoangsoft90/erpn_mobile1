/**
 * P2 tests — uncertainty taxonomy (§12) + session context (§14).
 *
 * Safety properties under test:
 *  1. every taxonomy code carries mandatory Vietnamese copy (a refusal without
 *     words is a dead end);
 *  2. toUncertaintyCode() never fabricates: unknown raw codes stay null;
 *  3. session context has TTLs and EXPIRED entries are dropped, not returned;
 *  4. only user_selected/exact provenance is WRITE-eligible — a derived fuzzy
 *     read match can never seed a payment (P2 deliverable 3, fail-closed).
 *
 * Money-adjacent ⇒ every rule has a falsifiable assertion, not a comment.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  UNCERTAINTY_CODES,
  uncertaintyCopy,
  toUncertaintyCode,
} from "../src/uncertainty.mjs";
import {
  SessionContext,
  CONTEXT_PROVENANCE,
  CONTEXT_TTL_MS,
} from "../src/session-context.mjs";

// ───────────────────────────── taxonomy (§12) ─────────────────────────────

test("P2 §12: every taxonomy code has Vietnamese copy, and no code fabricates", () => {
  for (const code of Object.values(UNCERTAINTY_CODES)) {
    const copy = uncertaintyCopy(code);
    assert.ok(copy, `${code} must carry copy`);
    assert.equal(copy.code, code);
    assert.ok(copy.message.trim().length > 10, `${code} message must be a real sentence`);
  }
  // An unknown code maps to null — callers must not invent taxonomy entries.
  assert.equal(uncertaintyCopy("TOTALLY_MADE_UP"), null);
  assert.equal(uncertaintyCopy(null), null);
});

test("P2 §12: raw pipeline codes map onto the taxonomy — and unknowns stay unknown", () => {
  // Builder refusals (PAYMENT_*) are business validation, by prefix.
  assert.equal(toUncertaintyCode("PAYMENT_INVOICE_ALREADY_SETTLED"), UNCERTAINTY_CODES.BUSINESS_VALIDATION_FAILED);
  assert.equal(toUncertaintyCode("PAYMENT_AMOUNT_INVALID"), UNCERTAINTY_CODES.BUSINESS_VALIDATION_FAILED);
  // The contract's authorization error is the genuine authorization refusal.
  assert.equal(toUncertaintyCode("INSUFFICIENT_PERMISSION"), UNCERTAINTY_CODES.AUTHORIZATION_DENIED);
  // P1 codes already ARE taxonomy codes (identity mapping).
  assert.equal(toUncertaintyCode("ENTITY_PICK_REQUIRED"), "ENTITY_PICK_REQUIRED");
  assert.equal(toUncertaintyCode("NLP_UNAVAILABLE"), "NLP_UNAVAILABLE");
  assert.equal(toUncertaintyCode("UNKNOWN_INTENT"), "UNKNOWN_INTENT");
  // NEVER fabricate.
  assert.equal(toUncertaintyCode("SOMETHING_ELSE"), null);
  assert.equal(toUncertaintyCode(null), null);
});

// ───────────────────────── session context (§14) ─────────────────────────

test("P2 §14: TTLs — customer 30m, invoice 10m; expired entries are DROPPED, not returned", () => {
  assert.equal(CONTEXT_TTL_MS.customer, 30 * 60 * 1000);
  assert.equal(CONTEXT_TTL_MS.invoice, 10 * 60 * 1000);

  let now = 1_000_000;
  const ctx = new SessionContext({ now: () => now });
  ctx.set("customer", { id: "CUST-00001", name: "Nguyễn Thị Lan", provenance: CONTEXT_PROVENANCE.USER_SELECTED });

  // Alive well within the TTL.
  now += 29 * 60 * 1000;
  assert.equal(ctx.get("customer", { now: now })?.value, "CUST-00001");

  // One second past 30 minutes: the entry is GONE — a stale customer must be
  // re-named by the user, never silently reused.
  now += 60 * 1000 + 1;
  assert.equal(ctx.get("customer", { now }), null);
  assert.equal(ctx.get("customer", { now }), null, "the drop is permanent, not per-read");
});

test("P2 §14: only user_selected/exact provenance is WRITE-eligible — derived never seeds a payment", () => {
  let now = 2_000_000;
  const ctx = new SessionContext({ now: () => now });

  // A fuzzy READ match recorded the customer (derived).
  ctx.set("customer", { id: "CUST-00001", name: "Nguyễn Thị Lan", provenance: CONTEXT_PROVENANCE.DERIVED });
  const derived = ctx.writeEligible("customer");
  assert.equal(derived.eligible, false, "derived context must NEVER drive a WRITE");
  assert.equal(derived.code, "CONTEXT_NOT_USER_SELECTED");
  assert.ok(derived.context, "but the context itself is still readable for follow-up READs");
  assert.equal(derived.context.value, "CUST-00001");

  // The user PICKS the customer: same id, provenance flips — now eligible.
  now += 1000;
  ctx.set("customer", { id: "CUST-00001", name: "Nguyễn Thị Lan", provenance: CONTEXT_PROVENANCE.USER_SELECTED });
  assert.equal(ctx.writeEligible("customer", { now }).eligible, true);

  // ...but the WRITE-eligibility ALSO expires with the TTL (not just reads).
  now += 30 * 60 * 1000 + 1;
  const stale = ctx.writeEligible("customer", { now });
  assert.equal(stale.eligible, false, "expired context cannot seed a WRITE either");
  assert.equal(stale.code, "CONTEXT_EXPIRED_OR_ABSENT");
});

test("P2 §14: the store refuses unknown kinds and unprovenanced writes (fail-closed)", () => {
  const ctx = new SessionContext();
  assert.equal(ctx.set("warehouse", { id: "W-1", provenance: "user_selected" }).code, "CONTEXT_KIND_UNKNOWN");
  assert.equal(
    ctx.set("customer", { id: "CUST-00001", provenance: "guessed" }).code,
    "CONTEXT_PROVENANCE_INVALID",
  );
  assert.equal(ctx.set("customer", { id: "  ", provenance: "user_selected" }).code, "CONTEXT_KIND_UNKNOWN");
  // Most-recent mention wins.
  ctx.set("customer", { id: "CUST-00001", provenance: "user_selected" });
  ctx.set("customer", { id: "CUST-00002", provenance: "user_selected" });
  assert.equal(ctx.get("customer").value, "CUST-00002");
});
