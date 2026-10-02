/**
 * next8 / Phase 8 — ROUTE CORPUS GATE.
 *
 * 280 sentences captured by the next10 audit on the REAL site (git cc2073b) and
 * frozen here as `test/fixtures/route-corpus.json`. Each case carries the EXACT
 * text the router saw (`attributed_normalized` — the Phase 1 NLP output, entity
 * tokens already protected) so this test asserts ROUTING and nothing else:
 * no Python NLP bridge, no ERPNext, no network. One command:
 *
 *     cd mcp-erpnext && node --test test/route-corpus.test.mjs
 *
 * Two levels:
 *  1. REGRESSION GATE (default): the set of locked cases that FAIL must equal
 *     `fixture.gate.locked_failures` — the audit baseline, which may only SHRINK
 *     as phase-08 clusters land. A new failing case (regression) and a fixed case
 *     that is still listed (stale baseline) both make this test red, so the list
 *     is edited in the SAME change that fixes a cluster.
 *  2. EXIT GATE (`ROUTE_CORPUS_STRICT=1`): locked failures must be empty. This is
 *     the phase-08 DoD ("280/280 PASS or ACCEPTED_BY_OWNER"); run it at the end
 *     of the phase. Before the fix clusters land it fails with the full list —
 *     which is the proof that this harness really observes the baseline.
 *
 * Review-contract cases (113) are REPORTED, never gated: their wording was not
 * locked by the audit, so the owner classifies them (phase §5.5). A case the
 * owner accepts keeps `accepted_by_owner: {reason}` in the fixture and is listed
 * separately — accepted is not the same as passing, and the case is never deleted.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { routeIntent } from "../src/router.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, "fixtures", "route-corpus.json");
const SNAPSHOT = path.join(HERE, "fixtures", "route-corpus.snapshot.json");

const fixture = JSON.parse(readFileSync(FIXTURE, "utf8"));
const snapshot = JSON.parse(readFileSync(SNAPSHOT, "utf8"));

/** Run one case through the real router and compare with its locked expectation. */
function observe(c) {
  const route = c.attributed_normalized === null ? null : routeIntent(c.attributed_normalized);
  const group = route?.group ?? null;
  const capability = route?.capability ?? null;
  return {
    case: c,
    group,
    capability,
    matched: route?.matched ?? null,
    forbidden: route?.forbidden ?? false,
    ok: group === c.expected_group && capability === c.expected_capability,
  };
}

const observed = fixture.cases.map(observe);
const locked = observed.filter((o) => o.case.contract === "locked");
const review = observed.filter((o) => o.case.contract !== "locked");

const lockedFails = locked.filter((o) => !o.ok && !o.case.accepted_by_owner);
const lockedAccepted = locked.filter((o) => !o.ok && o.case.accepted_by_owner);
// An owner-ACCEPTED review row is reported SEPARATELY (like `lockedAccepted`):
// "accepted" is not "passing", but it is also not an open failure.
const reviewFails = review.filter((o) => !o.ok && !o.case.accepted_by_owner);
const reviewAccepted = review.filter((o) => !o.ok && o.case.accepted_by_owner);

/** Compact per-cluster summary — the numbers the result doc quotes. */
function summarise(rows) {
  const out = {};
  for (const o of rows) {
    const key = o.case.cluster ?? (o.case.contract === "review" ? "review" : "other");
    const b = (out[key] ??= { total: 0, pass: 0, fail: 0 });
    b.total++;
    if (o.ok) b.pass++;
    else b.fail++;
  }
  return out;
}

test("corpus: the fixture is the 280-case next10 audit set (167 locked + 113 review)", () => {
  assert.equal(fixture.schema_version, "next8.route-corpus/v1");
  assert.equal(fixture.cases.length, 280);
  assert.equal(snapshot.totals.cases, 280);
  assert.equal(locked.length, 167);
  assert.equal(review.length, 113);
  // Every case must be runnable: the audit recorded a normalized text for each.
  const missing = fixture.cases.filter((c) => c.attributed_normalized === null);
  assert.equal(missing.length, 0, `cases without attributed_normalized: ${missing.map((c) => c.test_id)}`);
});

test("corpus: snapshot counts match the fixture (drift signal)", () => {
  assert.equal(snapshot.totals.locked_pass, locked.filter((o) => o.ok).length);
  assert.equal(snapshot.totals.locked_fail, locked.filter((o) => !o.ok).length);
  for (const [bucket, exp] of Object.entries(snapshot.by_bucket)) {
    const rows = observed.filter((o) => o.case.bucket === bucket);
    assert.equal(rows.length, exp.total, `bucket ${bucket} total`);
    const lk = rows.filter((o) => o.case.contract === "locked");
    assert.equal(lk.filter((o) => o.ok).length, exp.locked - exp.locked_fail, `bucket ${bucket} locked pass`);
    assert.equal(lk.filter((o) => !o.ok).length, exp.locked_fail, `bucket ${bucket} locked fail`);
  }
  console.log("[corpus] per-cluster (locked+review):", JSON.stringify(summarise(observed)));
});

test("corpus GATE: locked failures equal the recorded baseline exactly (may only shrink)", () => {
  const actual = lockedFails.map((o) => o.case.test_id).sort();
  const expected = [...fixture.gate.locked_failures].sort();
  assert.deepEqual(
    actual,
    expected,
    "locked failures drifted from the fixture baseline — a regression must not be added, " +
      "and a fixed case must be removed from gate.locked_failures in the same change. " +
      `\nnew (unexpected) failures: ${actual.filter((id) => !expected.includes(id)).join(", ") || "none"}` +
      `\nstale (now passing, still listed): ${expected.filter((id) => !actual.includes(id)).join(", ") || "none"}`,
  );
  console.log(
    `[corpus] locked ${locked.length}: pass ${locked.length - lockedFails.length - lockedAccepted.length}` +
      ` · known-fail ${lockedFails.length} · accepted ${lockedAccepted.length}` +
      ` | review ${review.length}: pass ${review.length - reviewFails.length - reviewAccepted.length}` +
      ` · fail ${reviewFails.length} · accepted ${reviewAccepted.length}`,
  );
});

test("corpus: every review row the OWNER LABELLED keeps its frozen route (sign-off 2026-10-01)", () => {
  // The owner signed 106 review rows by freezing an expectation on them (the 43
  // that already carried one + the 61 recorded from the PASS proposal + C5-212/
  // C5-219). `locked_failures` does not watch these, so this test is what makes
  // the decision OBSERVABLE: a mutation that changes one of them must go RED.
  // Owner-ACCEPTED rows (`accepted_by_owner`) carry no expectation on purpose —
  // accepted is not passing — so they are excluded here.
  const labelled = review.filter((o) => o.case.expected_group !== null);
  assert.ok(labelled.length >= 100, `expected the signed review set, got ${labelled.length}`);
  assert.deepEqual(
    labelled
      .filter((o) => !o.ok)
      .map((o) => `${o.case.test_id}: expected ${o.case.expected_group}/${o.case.expected_capability}, got ${o.group}/${o.capability}`),
    [],
    "a review row the owner labelled drifted from its frozen route",
  );
});

test("corpus EXIT GATE: ROUTE_CORPUS_STRICT=1 requires zero locked failures", { skip: process.env.ROUTE_CORPUS_STRICT !== "1" ? "set ROUTE_CORPUS_STRICT=1" : false }, () => {
  const lines = lockedFails
    .map((o) => `  ${o.case.test_id} [${o.case.cluster ?? "-"}] "${o.case.input}" → expected ${o.case.expected_group}/${o.case.expected_capability}, got ${o.group}/${o.capability}`)
    .join("\n");
  assert.deepEqual(lockedFails.map((o) => o.case.test_id), [], `locked cases still failing:\n${lines}`);
});

test("corpus SAFETY: a locked READ expectation is never promoted to a WRITE group", () => {
  // The phase §3 rule in test form: no case whose locked expectation is a READ
  // capability may come back as a WRITE route. Kept explicit (not implied by the
  // gate above) so the safety property survives a future expectation edit.
  const READ_CAPS = new Set([
    "payment.history", "sales.summary", "invoice.lookup", "customer.balance",
    "customer.lookup", "stock.balance",
  ]);
  const promoted = locked.filter(
    (o) =>
      READ_CAPS.has(o.case.expected_capability) &&
      typeof o.capability === "string" &&
      /\.(create|adjustment|return|update)$/.test(o.capability),
  );
  assert.deepEqual(
    promoted.map((o) => `${o.case.test_id}: ${o.case.expected_capability} → ${o.capability}`),
    [],
    "a READ question was routed into a WRITE capability",
  );
});

test("corpus SAFETY: a 'bán' sentence that is a QUESTION is not an order (CL-3 keeps its deny-list)", () => {
  // The phase §3 rule in test form: never turn a question into a blind WRITE. A
  // `bán` question must not resolve to the order write, and the canonical free-sale
  // phrase `bán hàng cho …` must still reach the Phase 6 sales screen (Phase 6's
  // S22 test owns that path; here we own "a command needs its tell-tale").
  for (const q of [
    "bán được bao nhiêu hôm nay",
    "bán hàng cho Nguyễn Thị Lan",
    "bán cho chị Lan chưa",
    "bán hôm qua bao nhiêu",
  ]) {
    const r = routeIntent(q);
    assert.notEqual(r?.capability, "sales_order.create", `"${q}" must not become a sales order`);
  }
});

test("corpus SAFETY: a sentence the audit locked as NOT a route stays unrouted (CL-6)", () => {
  // Out-of-domain sentences (phase §5.5 CL-6): the contract expects NO route at
  // all. These two are the locked ones; the rest of that bucket is review.
  const outOfDomain = locked.filter((o) => o.case.expected_group === null);
  assert.ok(outOfDomain.length >= 2, "the corpus must keep its out-of-domain cases");
  const routed = outOfDomain.filter((o) => o.group !== null);
  assert.deepEqual(
    routed.map((o) => `${o.case.test_id} "${o.case.input}" → ${o.group}/${o.capability}`),
    [],
    "an out-of-domain sentence was routed into an ERP group",
  );
});
