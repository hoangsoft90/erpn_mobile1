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
