/**
 * Phase 9 unit tests — proposal freshness (expiry) + snapshot drift.
 *
 * Property under test: every uncertainty fails CLOSED. A proposal we cannot
 * prove is fresh, or whose snapshot no longer matches the live debt, must be
 * refused — never guessed at.
 */

import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_TTL_MS,
  MAX_CLOCK_SKEW_MS,
  assertFresh,
  detectDrift,
  proposalCreatedAtMs,
  proposalTtlMs,
} from "../src/proposal-freshness.mjs";

const NOW = Date.parse("2026-09-16T04:00:00.000Z");
const at = (offsetMs) => new Date(NOW + offsetMs).toISOString();

test("a proposal built moments ago is fresh", () => {
  const v = assertFresh({ created_at: at(-30_000) }, { now: NOW });
  assert.equal(v.ok, true);
  assert.equal(v.ageMs, 30_000);
});

test("a proposal older than the TTL is refused with PROPOSAL_EXPIRED", () => {
  const v = assertFresh({ created_at: at(-(DEFAULT_TTL_MS + 1)) }, { now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.code, "PROPOSAL_EXPIRED");
  assert.match(v.error, /hết hạn/);
});

test("exactly at the TTL boundary is still allowed (no off-by-one refusal)", () => {
  const v = assertFresh({ created_at: at(-DEFAULT_TTL_MS) }, { now: NOW });
  assert.equal(v.ok, true);
});

test("a missing or unparseable created_at is refused (fail closed)", () => {
  for (const bad of [undefined, null, "", "   ", "không phải ngày", 12345]) {
    const v = assertFresh(bad === undefined ? {} : { created_at: bad }, { now: NOW });
    assert.equal(v.ok, false, `created_at=${JSON.stringify(bad)} must be refused`);
    assert.equal(v.code, "PROPOSAL_NO_CREATED_AT");
  }
});

test("a created_at in the FUTURE beyond clock skew is refused", () => {
  const v = assertFresh({ created_at: at(MAX_CLOCK_SKEW_MS + 61_000) }, { now: NOW });
  assert.equal(v.ok, false);
  assert.equal(v.code, "PROPOSAL_CREATED_IN_FUTURE");
});

test("TTL is configurable via PROPOSAL_TTL_MS, invalid values fall back to the default", () => {
  assert.equal(proposalTtlMs({ PROPOSAL_TTL_MS: "1000" }), 1000);
  for (const bad of [undefined, "", "abc", "0", "-5"]) {
    assert.equal(proposalTtlMs({ PROPOSAL_TTL_MS: bad }), DEFAULT_TTL_MS, `env=${JSON.stringify(bad)}`);
  }
  // and the custom TTL really drives the verdict
  const v = assertFresh({ created_at: at(-2000) }, { now: NOW, ttlMs: 1000 });
  assert.equal(v.ok, false);
});

test("proposalCreatedAtMs reads both snake_case and the client's camelCase", () => {
  assert.equal(proposalCreatedAtMs({ created_at: at(0) }), NOW);
  assert.equal(proposalCreatedAtMs({ createdAt: at(0) }), NOW);
  assert.equal(proposalCreatedAtMs({ created_at: "not a date" }), null);
});

test("drift: an identical snapshot has no problems", () => {
  const p = {
    entity: { id: "CUST-1" },
    params: { amount_vnd: 500_000, invoice: "SINV-1", outstanding_vnd: 500_000 },
  };
  assert.deepEqual(detectDrift(p, { customerId: "CUST-1", invoice: "SINV-1", outstanding_vnd: 500_000 }), []);
});

test("drift: the debt changed after the proposal was built", () => {
  const p = { entity: { id: "CUST-1" }, params: { amount_vnd: 500_000, invoice: "SINV-1", outstanding_vnd: 500_000 } };
  const problems = detectDrift(p, { customerId: "CUST-1", invoice: "SINV-1", outstanding_vnd: 300_000 });
  // TWO independent refusals, both correct: the snapshot is stale AND the
  // 500k amount no longer fits the 300k live debt. Phase 9 refuses instead
  // of Phase 7's silent clamp — assert each message, not just the count.
  assert.equal(problems.length, 2);
  assert.match(problems[0], /nợ lúc tạo đề xuất 500000 ≠ nợ hiện tại 300000/);
  assert.ok(problems.some((x) => /số tiền 500000 vượt nợ hiện tại 300000/.test(x)), JSON.stringify(problems));
});

test("drift: the debt changed but the amount still fits — exactly one refusal", () => {
  const p = { entity: { id: "CUST-1" }, params: { amount_vnd: 200_000, invoice: "SINV-1", outstanding_vnd: 500_000 } };
  const problems = detectDrift(p, { customerId: "CUST-1", invoice: "SINV-1", outstanding_vnd: 300_000 });
  assert.equal(problems.length, 1);
  assert.match(problems[0], /nợ lúc tạo đề xuất 500000 ≠ nợ hiện tại 300000/);
});

test("drift: the invoice is no longer affordable / belongs elsewhere", () => {
  const p = { entity: { id: "CUST-1" }, params: { amount_vnd: 900_000, invoice: "SINV-1", outstanding_vnd: 900_000 } };
  const problems = detectDrift(p, { customerId: "CUST-2", invoice: "SINV-1", outstanding_vnd: 900_000 });
  assert.ok(problems.some((x) => /không còn thuộc khách/.test(x)), JSON.stringify(problems));

  const amountTooBig = detectDrift(p, { customerId: "CUST-1", invoice: "SINV-1", outstanding_vnd: 400_000 });
  assert.ok(amountTooBig.some((x) => /vượt nợ hiện tại/.test(x)), JSON.stringify(amountTooBig));
});

test("drift: a proposal without snapshot or invoice is refused (cannot be verified)", () => {
  const noSnapshot = { entity: { id: "CUST-1" }, params: { amount_vnd: 500_000, invoice: "SINV-1" } };
  assert.ok(
    detectDrift(noSnapshot, { customerId: "CUST-1", invoice: "SINV-1", outstanding_vnd: 500_000 }).some((x) =>
      /không kèm snapshot nợ/.test(x),
    ),
  );
  const noInvoice = { entity: { id: "CUST-1" }, params: { amount_vnd: 500_000, outstanding_vnd: 500_000 } };
  assert.ok(
    detectDrift(noInvoice, { customerId: "CUST-1", invoice: "SINV-9", outstanding_vnd: 500_000 }).some((x) =>
      /không ghi rõ chứng từ đích/.test(x),
    ),
  );
});
