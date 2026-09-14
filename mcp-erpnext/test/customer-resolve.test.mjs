/**
 * Unit tests for customer resolution (copilot-server.mjs).
 *
 * The safety property: when several customers share a name fragment, the
 * resolver must prefer an EXACTLY-ONE match from a longer prefix over the
 * first multi-match — answering for the wrong "Khách smoke" is a wrong-money
 * answer.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { nameCandidates, resolveCustomer } from "../src/copilot-server.mjs";

test("nameCandidates emits every token prefix, longest first", () => {
  assert.deepEqual(nameCandidates("Lan receivable bao nhiêu"), [
    "Lan receivable bao nhiêu",
    "Lan receivable bao",
    "Lan receivable",
    "Lan",
  ]);
});

test("resolveCustomer prefers the unique longer-prefix match", async () => {
  const calls = [];
  const skills = {
    findCustomer: async (name) => {
      calls.push(name);
      if (name === "Khách") return { data: { count: 3, data: [{ name: "A" }, { name: "B" }, { name: "C" }] } };
      if (name === "Khách smoke") return { data: { count: 3, data: [{ name: "A" }, { name: "B" }, { name: "C" }] } };
      if (name.startsWith("Khách smoke 2026-09-13-p1done"))
        return { data: { count: 1, data: [{ name: "A", customer_name: "Khách smoke 2026-09-13-p1done" }] } };
      return { data: { count: 0, data: [] } };
    },
  };
  const { customer, ambiguous } = await resolveCustomer(
    skills,
    "Khách smoke 2026-09-13-p1done receivable bao nhiêu",
  );
  assert.equal(ambiguous, false);
  assert.equal(customer.name, "A");
  // candidates are tried longest-first, so the unique match is reached quickly
  assert.ok(calls.length < 5, calls);
});

test("resolveCustomer reports ambiguity instead of silently picking", async () => {
  const skills = {
    findCustomer: async () => ({ data: { count: 2, data: [{ name: "A" }, { name: "B" }] } }),
  };
  const { customer, ambiguous } = await resolveCustomer(skills, "Khách smoke còn nợ bao nhiêu");
  assert.equal(ambiguous, true);
  assert.equal(customer.name, "A");
});

test("resolveCustomer returns null when nothing matches", async () => {
  const skills = { findCustomer: async () => ({ data: { count: 0, data: [] } }) };
  const { customer, ambiguous } = await resolveCustomer(skills, "Lan receivable bao nhiêu");
  assert.equal(customer, null);
  assert.equal(ambiguous, false);
});
