/**
 * Unit tests for customer resolution (copilot-server.mjs).
 *
 * The safety property: when several customers share a name fragment, the
 * resolver must prefer an EXACTLY-ONE match over the first multi-match —
 * answering for the wrong "Khách smoke" is a wrong-money answer.
 *
 * result9 contract update: resolveCustomer() fetches the customer list ONCE
 * (findCustomer("")) and scores name candidates itself — the old prefix-only
 * candidates made mid-utterance names ("cho biết nợ của Trang trại Minh Anh")
 * unreachable.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { nameCandidates, resolveCustomer } from "../src/copilot-server.mjs";

const CUSTS = [
  { name: "Khách smoke 2026-09-13-p1done", customer_name: "Khách smoke 2026-09-13-p1done" },
  { name: "Khách smoke 2026-09-13-p1final", customer_name: "Khách smoke 2026-09-13-p1final" },
  { name: "Trang trại Minh Anh", customer_name: "Trang trại Minh Anh" },
  { name: "Công trình nhà ông An", customer_name: "Công trình nhà ông An" },
];

function fakeSkills() {
  const calls = [];
  return {
    calls,
    findCustomer: async (q) => {
      calls.push(q);
      const needle = String(q ?? "").toLowerCase();
      const data = needle === "" ? CUSTS : CUSTS.filter((c) => c.customer_name.toLowerCase().includes(needle));
      return { data: { count: data.length, data } };
    },
  };
}

test("nameCandidates emits every token substring, longest first", () => {
  const c = nameCandidates("nợ của Trang trại Minh Anh");
  assert.equal(c[0], "nợ của Trang trại Minh Anh");
  assert.ok(c.includes("Trang trại Minh Anh"));
  assert.ok(c.includes("Minh Anh"));
  assert.ok(c.includes("Anh"));
  // all substrings present
  assert.ok(c.includes("của Trang"));
});

test("resolveCustomer finds mid-utterance names (prefix-only bug, result9)", async () => {
  const s = fakeSkills();
  const { customer, ambiguous } = await resolveCustomer(s, "cho biết nợ của Trang trại Minh Anh");
  assert.equal(ambiguous, false);
  assert.equal(customer.name, "Trang trại Minh Anh");
  assert.equal(s.calls.length, 1, "customer list fetched exactly once");
});

test("resolveCustomer prefers the unique match over ambiguous shorter ones", async () => {
  const s = fakeSkills();
  const { customer, ambiguous } = await resolveCustomer(
    s,
    "Khách smoke 2026-09-13-p1done còn nợ bao nhiêu",
  );
  assert.equal(ambiguous, false);
  assert.equal(customer.name, "Khách smoke 2026-09-13-p1done");
});

test("resolveCustomer reports ambiguity instead of silently picking", async () => {
  const two = [
    { name: "A", customer_name: "Khách smoke" },
    { name: "B", customer_name: "Khách smoke" },
  ];
  const s = { findCustomer: async () => ({ data: { count: 2, data: two } }) };
  const { customer, ambiguous } = await resolveCustomer(s, "Khách smoke còn nợ bao nhiêu");
  assert.equal(ambiguous, true);
  assert.equal(customer.name, "A");
});

test("resolveCustomer returns null when nothing matches", async () => {
  const s = { findCustomer: async () => ({ data: { count: 0, data: [] } }) };
  const { customer, ambiguous } = await resolveCustomer(s, "Lan receivable bao nhiêu");
  assert.equal(customer, null);
  assert.equal(ambiguous, false);
});

// ---------------------------------------------------------------- Phase 6
// Exit-criteria battery: entity resolution ≥ 90% on a DUPLICATE/SIMILAR-name
// set (spec: "tập test có tên trùng/gần giống"). Every case states the full
// expected behaviour — resolve to the right customer, flag ambiguity instead
// of guessing, or fail honestly with null.

const PH6_CUSTS = [
  { name: "CUST-001", customer_name: "Nguyễn Thị Lan" },
  { name: "CUST-002", customer_name: "Trần Văn Lan" },
  { name: "CUST-003", customer_name: "Phạm Thị Lanh" },
  { name: "CUST-004", customer_name: "Nguyễn Thị Lan Khuê" },
  { name: "CUST-005", customer_name: "Trang trại Minh Anh" },
  { name: "CUST-006", customer_name: "Công ty Minh Anh" },
  { name: "CUST-007", customer_name: "Trần Văn Hai" },
  { name: "CUST-008", customer_name: "Nguyễn Văn Hải" },
  { name: "CUST-009", customer_name: "BÁ HAI TỔNG HỢP" },
  { name: "CUST-010", customer_name: "Hai Bánh Mì" },
];

function ph6Skills() {
  return {
    findCustomer: async () => ({ data: { count: PH6_CUSTS.length, data: PH6_CUSTS } }),
  };
}

// `want` = expected customer id or null; `amb` = expected ambiguous flag;
// `candidates` (optional) = expected length of the returned candidate list.
const PH6_CASES = [
  // exact full-name match wins over everything
  { text: "Nguyễn Thị Lan còn nợ bao nhiêu", want: "CUST-001", amb: false },
  { text: "Trần Văn Lan còn nợ bao nhiêu", want: "CUST-002", amb: false },
  // "Lan" alone: 4 customers contain it but the fragment is ONE word — the
  // resolver refuses to pick (result9) and now REPORTS the ambiguity instead
  // of an indistinguishable "not found" (Phase 6: ask, don't guess).
  { text: "Lan còn nợ bao nhiêu", want: null, amb: true, candidates: 4 },
  // "Lanh" is the unique exact match of Phạm Thị Lanh? No — substring pass:
  // "lanh" is contained in ONLY "Phạm Thị Lanh" → unique include-hit.
  { text: "Phạm Thị Lanh còn nợ không", want: "CUST-003", amb: false },
  // "Minh Anh" (2 words) matches 2 → ambiguous fallback (first)
  { text: "Minh Anh còn nợ bao nhiêu", want: "CUST-005", amb: true },
  // full names resolve uniquely
  { text: "Trang trại Minh Anh còn nợ không", want: "CUST-005", amb: false },
  { text: "Công ty Minh Anh còn nợ không", want: "CUST-006", amb: false },
  // Hai family: full names unique
  { text: "Trần Văn Hai còn nợ bao nhiêu", want: "CUST-007", amb: false },
  { text: "Nguyễn Văn Hải còn nợ bao nhiêu", want: "CUST-008", amb: false },
  // bare "Hai" → 3 substring hits, one word ⇒ explicit ambiguity (ask), null.
  { text: "Hai còn nợ bao nhiêu", want: null, amb: true, candidates: 3 },
  // "BÁ HAI TỔNG HỢP" is uppercase in ERPNext — case-insensitive exact match
  { text: "Bá Hai Tổng Hợp còn nợ không", want: "CUST-009", amb: false },
  // a name that exists nowhere → honest null
  { text: "Khách Lapranep còn nợ bao nhiêu", want: null, amb: false },
];

test("Phase 6 battery: duplicate/similar names ≥ 90% correct", async () => {
  let correct = 0;
  const fails = [];
  for (const c of PH6_CASES) {
    const { customer, ambiguous, candidates } = await resolveCustomer(ph6Skills(), c.text);
    const gotId = customer?.name ?? null;
    let ok = gotId === c.want && ambiguous === c.amb;
    if (ok && c.candidates !== undefined) ok = (candidates ?? []).length === c.candidates;
    if (ok) correct++;
    else
      fails.push({
        text: c.text,
        want: c.want,
        wantAmb: c.amb,
        wantCands: c.candidates,
        got: gotId,
        gotAmb: ambiguous,
        gotCands: (candidates ?? []).length,
      });
  }
  const pct = Math.round((correct / PH6_CASES.length) * 100);
  assert.ok(
    pct >= 90,
    `entity resolution ${pct}% < 90% (exit criteria) — fails: ${JSON.stringify(fails)}`,
  );
  assert.deepEqual(fails, [], "any miss must be surfaced, not just counted");
});

test("Phase 6: one-word fragment with multiple hits returns the candidate list (ask-the-user contract)", async () => {
  const { customer, ambiguous, candidates } = await resolveCustomer(
    ph6Skills(),
    "Lan còn nợ bao nhiêu",
  );
  assert.equal(customer, null);
  assert.equal(ambiguous, true);
  assert.equal(candidates.length, 4);
  assert.ok(candidates.includes("Nguyễn Thị Lan"));
  assert.ok(candidates.includes("Trần Văn Lan"));
});
