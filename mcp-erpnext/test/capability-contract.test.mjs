/**
 * P0 — Capability Contract tests (plan2_final §2 D5, §5-8, §18, §24.2, §25).
 *
 * The contract is the single source of truth for router/skill/safety/
 * authorization/UI/test. These tests pin the properties the Safety Gateway
 * relies on:
 *   1. the Reference Capabilities exist, with the declared risk/type/scope
 *   2. `document.delete` is declared FORBIDDEN and can never be executable
 *   3. validation FAILS CLOSED on a broken contract (not a warning)
 *   4. routing is contract-driven and resolves to the right capability
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  __contract,
  assertCapabilityExecutable,
  capabilityForAction,
  executableWriteActions,
  getCapability,
  isForbidden,
  listCapabilities,
  operationalControls,
  resolveCapability,
  validateContract,
} from "../src/capability-contract.mjs";
import { routeIntent } from "../src/router.mjs";

test("Reference READ capabilities exist and declare company scope from P0", () => {
  for (const id of [
    "customer.balance",
    "customer.lookup",
    "stock.balance",
    "invoice.lookup",
    "sales.summary",
  ]) {
    const cap = getCapability(id);
    assert.ok(cap, `${id} must exist in the contract`);
    assert.equal(cap.type, "READ", `${id} is a READ capability`);
    assert.equal(cap.risk.level, "READ");
    // plan2_final §24.2 — scope declared from P0 so P8 does not rewrite the registry
    assert.ok("company" in cap.authorization.scope, `${id} declares authorization.scope.company`);
  }
  assert.ok(listCapabilities().length >= 6);
});

test("payment.create is the Reference WRITE — HIGH, confirmation, idempotent, verified, reconciled", () => {
  const cap = getCapability("payment.create");
  assert.equal(cap.type, "WRITE");
  assert.equal(cap.risk.level, "HIGH");
  assert.equal(cap.risk.requires_confirmation, true);
  assert.equal(cap.execution.idempotent, true);
  assert.equal(cap.execution.verify_document, true);
  assert.equal(cap.execution.reconcile_on_unknown, true);
  assert.equal(cap.execution.write_doctype, "Payment Entry");
  assert.equal(cap.execution.correlation_field, "custom_ai_action_id");
  assert.equal(cap.execution.reference_field, "reference_no");
  assert.deepEqual(cap.amount_policy, {
    allow_explicit: true,
    allow_full_balance: true,
    allow_zero: false,
    allow_negative: false,
    clamp_to_outstanding: "refuse_not_clamp",
  });
  assert.ok(cap.errors.includes("INVALID_AMOUNT"));
  assert.ok(cap.errors.includes("SYSTEM_MAINTENANCE"));
});

test("contract validates — and FAILS CLOSED on a broken one (never warns)", () => {
  // The shipped contract is valid.
  assert.equal(validateContract(__contract), true);

  const clone = () => JSON.parse(JSON.stringify(__contract));

  // unknown type
  const t1 = clone();
  t1.capabilities["customer.balance"].type = "MAYBE";
  assert.throws(() => validateContract(t1), /unknown type/);

  // unknown risk
  const t2 = clone();
  t2.capabilities["customer.balance"].risk.level = "MEH";
  assert.throws(() => validateContract(t2), /unknown risk/);

  // a forbidden capability that is not CRITICAL would weaken the gate
  const t3 = clone();
  t3.capabilities["document.delete"].risk.level = "LOW";
  assert.throws(() => validateContract(t3), /forbidden_in_ai_path but risk/);

  // missing error codes: no structured refusal possible
  const t4 = clone();
  t4.capabilities["customer.balance"].errors = [];
  assert.throws(() => validateContract(t4), /at least one error code/);

  // a route group with no capability behind it
  const t5 = clone();
  t5.routing.push({ group: "ghost", keywords: ["abc"], capability_default: null });
  assert.throws(() => validateContract(t5), /maps to no capability/);

  // scope.company is mandatory from P0 (§24.2)
  const t6 = clone();
  delete t6.capabilities["customer.balance"].authorization.scope.company;
  assert.throws(() => validateContract(t6), /scope\.company/);

  // payment.create without the execution guarantees
  const t7 = clone();
  t7.capabilities["payment.create"].execution.verify_document = false;
  assert.throws(() => validateContract(t7), /execution\.verify_document/);
});

test("document.delete is FORBIDDEN_IN_AI_PATH and never executable", () => {
  const cap = getCapability("document.delete");
  assert.equal(isForbidden("document.delete"), true);
  assert.equal(cap.execution.forbidden_in_ai_path, true);
  assert.equal(cap.type, "WRITE");
  assert.equal(cap.risk.level, "CRITICAL");
  assert.ok(cap.execution.reason.length > 0);

  // The gateway guard refuses it, in code, with a structured code.
  assert.throws(
    () => assertCapabilityExecutable("document.delete"),
    (err) => err.code === "FORBIDDEN_IN_AI_PATH",
  );
  // ...and the executable list is derived from the contract, so it cannot
  // contain a forbidden capability by construction.
  assert.deepEqual(executableWriteActions(), ["create_payment_entry"]);
  assert.equal(capabilityForAction("delete_document"), "document.delete");
  assert.equal(capabilityForAction("create_payment_entry"), "payment.create");
  assert.equal(capabilityForAction("nonsense_action"), null);
});

test("assertCapabilityExecutable refuses READ capabilities and unknown ids", () => {
  assert.throws(() => assertCapabilityExecutable("customer.balance"), (e) => e.code === "CAPABILITY_NOT_WRITE");
  assert.throws(() => assertCapabilityExecutable("does.not.exist"), (e) => e.code === "CAPABILITY_NOT_FOUND");
  assert.equal(assertCapabilityExecutable("payment.create").risk.level, "HIGH");
});

test("routing is contract-driven and resolves the correct capability", () => {
  const cases = [
    ["công nợ của anh Nam là bao nhiêu", "customer.balance"],
    ["khách hàng còn nợ mấy", "customer.balance"],
    ["tìm khách Nguyễn Thị Lan", "customer.lookup"],
    ["hóa đơn chưa trả của chị Lan", "invoice.lookup"],
    ["doanh thu hôm nay bán được bao nhiêu", "sales.summary"],
    ["phiếu thu của anh Nam", "payment.history"],
    ["payment cho chị Lan 500 ngàn", "payment.create"],
    ["tồn kho cám heo còn bao nhiêu", "stock.balance"],
    ["xóa khoản vừa thu", "document.delete"],
  ];
  for (const [text, expected] of cases) {
    const hit = resolveCapability(text);
    assert.ok(hit, `"${text}" must resolve`);
    assert.equal(hit.id, expected, `"${text}" -> ${hit.id} (expected ${expected})`);
  }
  assert.equal(resolveCapability("thời tiết hôm nay đẹp"), null);

  // routeIntent stays the pipeline-facing surface and now carries the contract id
  const r = routeIntent("payment cho chị Lan 500 ngàn");
  assert.equal(r.group, "payment_write");
  assert.equal(r.capability, "payment.create");
  assert.equal(r.forbidden, false);
  assert.equal(routeIntent("xóa khoản vừa thu").forbidden, true);
});

test("operational controls are declared in the contract (kill switch + rate limit)", () => {
  const controls = operationalControls();
  assert.ok(controls.kill_switch.levels.includes("global_read_only"));
  assert.equal(controls.kill_switch.env, "COPILOT_GLOBAL_READ_ONLY");
  assert.ok(controls.kill_switch.flag_file.includes("read-only"));
  assert.equal(controls.rate_limit.per_user.read, "30/minute");
  assert.equal(controls.rate_limit.per_capability["payment.create"], "20/hour");
});
