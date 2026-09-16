/**
 * Regression for the result37 review: answerQuestion's outer ambiguous-customer
 * guard runs resolveCustomer() BEFORE the payment_write branch, which then
 * calls resolveCustomer() AGAIN on the same text. Same inputs ⇒ same output,
 * so behaviour is correct — but every question pays a duplicate full-catalog
 * findCustomer("") round-trip, and the two blocks can silently diverge.
 *
 * Contract: for a payment_write question, resolveCustomer runs EXACTLY ONCE.
 * (If the duplicated block is ever re-introduced, this test fails on the
 * call count — the guard-before-branch lesson from result31's notIf fix.)
 */

import test from "node:test";
import assert from "node:assert/strict";

test("payment_write question resolves the customer exactly ONCE (no duplicate guard+branch calls)", async () => {
  // The pipeline answerQuestion() spawns the mock MCP server and runs the
  // full stack; we cannot inject a counting skills mock into it. Instead,
  // assert at the SOURCE level: the payment_write block must REUSE the
  // outer `customer` binding, not destructure a second resolveCustomer call.
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const path = await import("node:path");
  const src = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "copilot-server.mjs"),
    "utf8",
  );

  // Count CALL expressions only — `await resolveCustomer(skills` — NOT the
  // `export async function resolveCustomer(skills, ...)` definition line, which
  // matches the bare name too (that mismatch made this test red on correct
  // code the first time it ran).
  const callSites = (src.match(/await resolveCustomer\(skills/g) ?? []).length;
  assert.equal(
    callSites,
    1,
    `resolveCustomer(skills, ...) must be CALLED from exactly ONE site (the outer guard); found ${callSites}. ` +
      `A second call inside the payment_write branch is a duplicate round-trip per question.`,
  );
});
