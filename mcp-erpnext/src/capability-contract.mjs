/**
 * Capability Contract loader (P0, plan2_final §2 D5).
 *
 * `capabilities.json` is the SINGLE SOURCE OF TRUTH. This module loads it,
 * validates it FAIL-CLOSED at import time, and exposes the query surface the
 * rest of the system must use instead of hardcoding policy:
 *
 *   listRouting()        → ordered route table (router.mjs consumes this)
 *   listCapabilities()   → all capability ids
 *   getCapability(id)    → frozen contract entry | null
 *   capabilityForAction(action) → the capability declaring this proposal action
 *   resolveCapability(text) → { id, capability, group, matched } | null
 *   assertCapabilityExecutable(id) → throws unless the capability may execute
 *   isForbidden(id)      → true for capabilities that must never run on the AI path
 *
 * Validation rules (all throw, never warn):
 *  - every declared route group (except forbidden ones) maps to ≥1 capability
 *  - every capability has a known type, a known risk level, entities, errors
 *  - a capability marked `execution.forbidden_in_ai_path` must carry risk
 *    CRITICAL and can never be executable
 *  - unknown extra risk levels / types are refused (no silent defaults)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { RISK_ORDER } from "./risk-levels.mjs";
import { ENTITY_STATES } from "./entity-resolution.mjs";

const CONTRACT_PATH = process.env.ERPN_CAPABILITY_CONTRACT
  ? process.env.ERPN_CAPABILITY_CONTRACT
  : join(dirname(fileURLToPath(import.meta.url)), "..", "capabilities.json");

const KNOWN_TYPES = new Set(["READ", "WRITE"]);

/** Deep-freeze so no caller can mutate the contract in-process. */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value)) deepFreeze(v);
  }
  return value;
}

function loadContract(path = CONTRACT_PATH) {
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    throw new Error(`CAPABILITY_CONTRACT_UNREADABLE: ${path}: ${err?.message ?? err}`);
  }
  return parsed;
}

/**
 * Validate the contract. Every problem is fatal: a contract that cannot be
 * trusted must stop the process, not degrade into a weaker safety posture.
 * @param {object} contract
 */
/**
 * Entity-resolution policy is SAFETY policy (plan2_final §4.3): a WRITE must
 * never auto-select a fuzzy match, and a capability that cannot say what to do
 * per resolution state cannot be trusted. Validated fail-closed, with the
 * WRITE rule asserted explicitly so nobody can "relax" it by editing JSON.
 *
 * @param {string} id capability id
 * @param {object} cap capability entry
 * @param {object} contract full contract (for defaults)
 */
function validateEntityPolicy(id, cap, contract) {
  if (cap.execution?.forbidden_in_ai_path === true) return; // never runs on the AI path
  const policy = cap.entity_policy ?? contract.defaults?.entity_policy;
  if (!policy || typeof policy !== "object") {
    throw new Error(`CAPABILITY_CONTRACT_INVALID: ${id} has no entity_policy (and defaults declares none)`);
  }
  for (const state of Object.keys(ENTITY_STATES)) {
    const rule = policy[state];
    if (!rule || typeof rule !== "object") {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ${id} entity_policy is missing state ${state}`);
    }
    for (const key of ["auto_select", "require_picker", "block"]) {
      if (typeof rule[key] !== "boolean") {
        throw new Error(`CAPABILITY_CONTRACT_INVALID: ${id} entity_policy.${state}.${key} must be boolean`);
      }
    }
    if (rule.block === true && rule.auto_select === true) {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ${id} entity_policy.${state} both blocks and auto-selects`);
    }
  }
  if (cap.type === "WRITE" && policy.FUZZY_SINGLE_MATCH.auto_select !== false) {
    throw new Error(
      `CAPABILITY_CONTRACT_INVALID: ${id} is a WRITE but entity_policy.FUZZY_SINGLE_MATCH.auto_select is not false — plan2_final §4.3 forbids auto-selecting a fuzzy customer for a write`,
    );
  }
}

/**
 * Validate the READ drill-down screen table (A1, plan3 Trụ A).
 *
 * These screens are opened from a bubble and fetch ERPNext data, so the table is
 * a SAFETY surface, not a UI hint list: an undeclared screen can never be
 * requested from `/read/list`, and a screen may only be composed from READ
 * capabilities. Fail-closed like the rest of the contract — a screen that
 * cannot say which capability composes it, or that points at a WRITE, stops the
 * process instead of degrading into a weaker posture.
 *
 * @param {object} contract
 */
/**
 * Validate the UOM policy (B1, plan3_review3 §B.3).
 *
 * "Không quy đổi ẩn" is only true if the policy actually says so, so the four
 * rules that keep a conversion visible are asserted fail-closed: an unknown
 * UOM / ambiguous UOM / missing factor must ASK, and the two escapes that would
 * let code compute a factor ERPNext never declared (inverse, two-hop) must be
 * explicitly false. A contract that relaxes any of them stops the process.
 *
 * @param {object} contract
 */
function validateUomPolicy(contract) {
  const p = contract.defaults?.uom_policy;
  if (!p || typeof p !== "object") {
    throw new Error("CAPABILITY_CONTRACT_INVALID: defaults.uom_policy is required (B1 — UOM là policy an toàn)");
  }
  for (const key of ["unknown_uom", "ambiguous_uom", "missing_factor"]) {
    if (p[key] !== "ask") {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: defaults.uom_policy.${key} must be "ask" (không quy đổi ẩn)`);
    }
  }
  for (const key of ["allow_inverse_factor", "allow_two_hop_chain"]) {
    if (p[key] !== false) {
      throw new Error(
        `CAPABILITY_CONTRACT_INVALID: defaults.uom_policy.${key} must be false — chỉ hệ số TRỰC TIẾP từ ERPNext mới được dùng`,
      );
    }
  }
  if (p.always_show_conversion !== true) {
    throw new Error("CAPABILITY_CONTRACT_INVALID: defaults.uom_policy.always_show_conversion must be true");
  }
  if (!Array.isArray(p.ambiguous_uoms) || p.ambiguous_uoms.some((u) => typeof u !== "string" || u.trim() === "")) {
    throw new Error("CAPABILITY_CONTRACT_INVALID: defaults.uom_policy.ambiguous_uoms must be an array of non-empty strings");
  }
  if (p.default_uom_source !== "item") {
    throw new Error("CAPABILITY_CONTRACT_INVALID: defaults.uom_policy.default_uom_source must be \"item\" (đơn vị mặc định lấy từ mặt hàng)");
  }
}

/**
 * Validate the ORDER line policy (B2 — sales_order.create).
 *
 * A Sales Order has no single amount to gate, so the money risk lives in the
 * LINES. The three rules that decide whether a line can be written are
 * asserted fail-closed: a line limit exists (one sentence cannot produce an
 * unbounded order), quantity must be positive, and the PRICE MUST COME FROM
 * ERPNext — a contract that let a price come from the utterance would put a
 * number the shop never published onto a real order.
 *
 * @param {string} id capability id
 * @param {object} cap capability entry
 * @param {object} contract full contract (for the referenced uom policy)
 */
function validateLinePolicy(id, cap, contract) {
  const p = cap.line_policy;
  if (p === undefined) return;
  const fail = (msg) => {
    throw new Error(`CAPABILITY_CONTRACT_INVALID: ${id} ${msg}`);
  };
  if (!p || typeof p !== "object" || Array.isArray(p)) fail("line_policy must be an object");
  if (cap.type !== "WRITE") fail("declares line_policy but is not a WRITE capability");
  if (!Number.isInteger(p.max_lines) || p.max_lines < 1) fail("line_policy.max_lines must be a positive integer");
  // P9-F: the RETURN path stores NEGATIVE quantities (measured: the site's own
  // return invoices carry qty=-1/-8), so the validator must know both
  // directions instead of pretending every write is positive. The sign is read
  // by the SKILL (`qty_negative: true` ⇒ it may send qty<0 and MUST send
  // update_stock=1); anything else keeps the old positive-only rule.
  const qtyNegative = p.qty_negative === true;
  if (!qtyNegative && p.qty_positive !== true) fail('line_policy.qty_positive must be true (số lượng ≤ 0 không được vào đơn)');
  if (qtyNegative && (p.qty_positive === true || p.update_stock !== 1)) {
    fail("line_policy.qty_negative=true requires update_stock=1 (a return RECEIVES goods back) and qty_positive unset");
  }
  if (p.update_stock !== undefined && ![0, 1].includes(p.update_stock)) fail("line_policy.update_stock must be 0 or 1");
  if (p.rate_source !== "erpnext") fail('line_policy.rate_source must be "erpnext" (giá KHÔNG bao giờ lấy từ câu nói)');
  if (p.no_price !== "ask" && p.no_price !== "from_invoice") fail('line_policy.no_price must be "ask" or "from_invoice" (thiếu giá thì hỏi/lấy từ chứng từ gốc, không mặc định 0)');
  if (p.uom_policy_ref !== "defaults.uom_policy") fail('line_policy.uom_policy_ref must be "defaults.uom_policy"');
  if (!contract.defaults?.uom_policy) fail("declares line_policy but defaults.uom_policy is missing");
  // P9-E: a capability that writes a STOCK document must say which WAY the goods
  // move. Declared-or-absent, never blank: an empty string would let the skill's
  // fail-closed check read "declared" and then compare against nothing.
  if (p.entry_type !== undefined && (typeof p.entry_type !== "string" || p.entry_type.trim() === "")) {
    fail("line_policy.entry_type must be a non-empty string when declared");
  }
}

function validateUiScreens(contract) {
  const screens = contract.ui_screens;
  if (screens === undefined) return; // feature not declared = no drill-down anywhere
  if (screens === null || typeof screens !== "object" || Array.isArray(screens)) {
    throw new Error("CAPABILITY_CONTRACT_INVALID: ui_screens must be an object");
  }
  const ids = Object.keys(screens).filter((k) => k !== "comment");
  for (const id of ids) {
    const screen = screens[id];
    if (!screen || typeof screen !== "object") {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ui_screens.${id} must be an object`);
    }
    if (typeof screen.title !== "string" || screen.title.trim() === "") {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ui_screens.${id} needs a non-empty title`);
    }
    if (typeof screen.entity !== "string" || screen.entity.trim() === "") {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ui_screens.${id} needs an entity kind`);
    }
    if (typeof screen.list !== "string" || screen.list.trim() === "") {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ui_screens.${id} needs a list kind`);
    }
    const owner = contract.capabilities[screen.capability];
    if (!owner) {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ui_screens.${id} names unknown capability "${screen.capability}"`);
    }
    if (owner.type !== "READ") {
      throw new Error(
        `CAPABILITY_CONTRACT_INVALID: ui_screens.${id} is composed by "${screen.capability}" which is ${owner.type} — a drill-down reads, it never writes`,
      );
    }
    if (!Array.isArray(screen.offered_by) || screen.offered_by.length === 0) {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ui_screens.${id} needs offered_by (≥1 capability)`);
    }
    if (!screen.offered_by.includes(screen.capability)) {
      throw new Error(
        `CAPABILITY_CONTRACT_INVALID: ui_screens.${id} offered_by must include its own capability "${screen.capability}"`,
      );
    }
    for (const capId of screen.offered_by) {
      const cap = contract.capabilities[capId];
      if (!cap) {
        throw new Error(`CAPABILITY_CONTRACT_INVALID: ui_screens.${id} offers an unknown capability "${capId}"`);
      }
      if (cap.type !== "READ") {
        throw new Error(
          `CAPABILITY_CONTRACT_INVALID: ui_screens.${id} offers "${capId}" which is ${cap.type} — only a READ answer may offer a drill-down`,
        );
      }
    }
    const limit = screen.limit;
    if (!limit || typeof limit !== "object") {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ui_screens.${id} needs a limit block`);
    }
    for (const key of ["default", "min", "max"]) {
      if (!Number.isInteger(limit[key])) {
        throw new Error(`CAPABILITY_CONTRACT_INVALID: ui_screens.${id} limit.${key} must be an integer`);
      }
    }
    if (limit.min < 1 || limit.min > limit.default || limit.default > limit.max) {
      throw new Error(
        `CAPABILITY_CONTRACT_INVALID: ui_screens.${id} limit must satisfy 1 ≤ min ≤ default ≤ max (got ${limit.min}/${limit.default}/${limit.max})`,
      );
    }
  }
}

/**
 * Validate the fixed-id DAY drill-down table (P4-4, plan4_final §4.4).
 *
 * Same reasoning as `ui_screens` — this is a SAFETY surface, not a UI hint:
 * `/read/drill` refuses any id that is not declared here, and every declared id
 * must name the READ capability whose data it exposes (that is what
 * `authorize()` is run against). The differences from `ui_screens` are the ones
 * §4.4 asks for:
 *   - there is NO entity and NO `offered_by`: a day drill is opened by tapping a
 *     metric on the summary screen, not by resolving a customer, so the id is
 *     FIXED and carries no user text (`drill.sales_orders_today` and friends).
 *   - the id must be a plain slug: a drill id arriving from a client is matched
 *     literally, so one containing spaces/punctuation would be a way to smuggle
 *     a phrase into a lookup that is supposed to be a closed set.
 * Fail-closed like the rest of the contract: an id composed by a WRITE
 * capability, or a limit that is not 1 ≤ min ≤ default ≤ max, stops the process.
 *
 * @param {object} contract
 */
function validateDrillScreens(contract) {
  const drills = contract.drill_screens;
  if (drills === undefined) return; // feature not declared = no day drill anywhere
  if (drills === null || typeof drills !== "object" || Array.isArray(drills)) {
    throw new Error("CAPABILITY_CONTRACT_INVALID: drill_screens must be an object");
  }
  const ids = Object.keys(drills).filter((k) => k !== "comment");
  for (const id of ids) {
    const drill = drills[id];
    const fail = (msg) => {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: drill_screens.${id} ${msg}`);
    };
    if (!/^[a-z][a-z0-9_]*$/.test(id)) {
      fail("id must be a lowercase slug (a drill id is matched literally — it must not be able to carry a phrase)");
    }
    if (!drill || typeof drill !== "object" || Array.isArray(drill)) fail("must be an object");
    if (typeof drill.title !== "string" || drill.title.trim() === "") fail("needs a non-empty title");
    // D4 — `day_scoped`: the screen reads a DAY, so the server composes the
    // title from the day it actually read (drill-views `drillDayWord`). Two
    // things are therefore refused here rather than left to a reviewer:
    //   * a non-boolean flag (anything truthy-but-wrong would silently turn the
    //     composition on/off depending on how it was compared);
    //   * a BAKED-IN day word in a day-scoped title (`"Hóa đơn hôm nay"`),
    //     because the server then appends another one — and the screen ends up
    //     claiming "today" over yesterday's rows, which is the exact mislabel
    //     D4 exists to remove.
    if (drill.day_scoped !== undefined && typeof drill.day_scoped !== "boolean") {
      fail("day_scoped must be a boolean when present");
    }
    if (drill.day_scoped === true && /hôm nay|hôm qua|ngày\s+\d/i.test(drill.title)) {
      fail(`title "${drill.title}" must be day-NEUTRAL when day_scoped (the server appends the day it read — a baked-in day word would contradict it)`);
    }
    const owner = contract.capabilities[drill.capability];
    if (!owner) fail(`names unknown capability "${drill.capability}"`);
    if (owner.type !== "READ") {
      fail(`is composed by "${drill.capability}" which is ${owner.type} — a drill-down reads, it never writes`);
    }
    const limit = drill.limit;
    if (!limit || typeof limit !== "object") fail("needs a limit block");
    for (const key of ["default", "min", "max"]) {
      if (!Number.isInteger(limit[key])) fail(`limit.${key} must be an integer`);
    }
    if (limit.min < 1 || limit.min > limit.default || limit.default > limit.max) {
      fail(`limit must satisfy 1 ≤ min ≤ default ≤ max (got ${limit.min}/${limit.default}/${limit.max})`);
    }
  }
}

/**
 * C0 — OCR input layer policy (plan3 §6.4 / Trụ C).
 *
 * An OCR result is text produced from a photo: it is UNTRUSTED and it enters
 * the SAME pipeline as typed text. This block declares the boundary, and the
 * validation is deliberately one-directional: every value that would WEAKEN the
 * boundary is REFUSED (not warned about), so a later edit cannot quietly turn
 * "never log the image" or "never trust an id from a photo" into an option.
 */
function validateOcrPolicy(contract) {
  const p = contract.ocr_policy;
  if (p === undefined) return; // feature not declared = no OCR layer anywhere
  const fail = (msg) => {
    throw new Error(`CAPABILITY_CONTRACT_INVALID: ocr_policy ${msg}`);
  };
  if (!p || typeof p !== "object" || Array.isArray(p)) fail("must be an object");
  if (typeof p.min_confidence !== "number" || !(p.min_confidence > 0 && p.min_confidence <= 1)) {
    fail("min_confidence must be a number in (0, 1]");
  }
  if (!Number.isInteger(p.max_text_length) || p.max_text_length < 1) {
    fail("max_text_length must be a positive integer");
  }
  if (!Number.isInteger(p.max_image_bytes) || p.max_image_bytes < 1) {
    fail("max_image_bytes must be a positive integer (a photo the layer refuses to read at all must be a refusal, not an OOM)");
  }
  if (!Array.isArray(p.allowed_providers) || p.allowed_providers.length === 0) {
    fail("allowed_providers must be a non-empty array (an unknown provider id is refused, never silently mocked)");
  }
  if (p.allowed_providers.some((id) => typeof id !== "string" || id.trim() === "")) {
    fail("allowed_providers entries must be non-empty strings");
  }
  if (p.require_wrap_before_llm !== true) {
    fail('require_wrap_before_llm must be true (an OCR text reaching a prompt without <UNTRUSTED_DATA> is a bug)');
  }
  if (p.log_raw_image !== false) {
    fail('log_raw_image must be false (plan3 §6.4 PII: raw invoice images never reach a log)');
  }
  if (p.authoritative_identifiers !== false) {
    fail('authoritative_identifiers must be false (phases3 Cấm: "OCR authoritative id")');
  }
  if (p.low_confidence !== "ask") {
    fail('low_confidence must be "ask" (fail-closed: ask again instead of writing)');
  }

  // ── C2: the document kinds a PHOTO may become ────────────────────────────
  //
  // A photo carries no verb (measured), so the user picks the kind. This check
  // is what stops that mapping from becoming a back door: a kind may only point
  // at a capability that exists, is a DRAFT-ONLY write, and actually has an
  // executor. Pointing a kind at a stub (delivery / purchase_receipt) or at a
  // capability that could submit would make the contract invalid rather than
  // produce a form that cannot be honoured.
  const kinds = p.document_kinds;
  if (kinds === undefined) return; // OCR without document kinds = C1 only
  if (!kinds || typeof kinds !== "object" || Array.isArray(kinds)) {
    fail("document_kinds must be an object of {kind: {capability, party, label}}");
  }
  const entries = Object.entries(kinds).filter(([key]) => key !== "comment");
  if (entries.length === 0) fail("document_kinds must declare at least one kind");
  for (const [kind, spec] of entries) {
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      fail(`document_kinds.${kind} must be an object`);
    }
    const cap = contract.capabilities?.[spec.capability];
    if (!cap) {
      fail(`document_kinds.${kind} points at unknown capability "${spec.capability}"`);
    }
    // `executableWriteActions()` answers with proposal ACTION names, so the
    // capability ids are recovered from the contract itself rather than
    // comparing two different vocabularies (a stub would compare unequal by
    // accident and the check would look like it passed for the wrong reason).
    // Checked BEFORE draft_only so a stub gets the precise "no executor"
    // message instead of the misleading "could submit" one.
    const executableIds = listCapabilities().filter((id) =>
      executableWriteActions().includes(getCapability(id)?.proposal_action),
    );
    if (!executableIds.includes(spec.capability)) {
      fail(`document_kinds.${kind} → ${spec.capability} has no registered executor (a kind may not open a form for a stub)`);
    }
    if (cap.execution?.draft_only !== true) {
      fail(`document_kinds.${kind} → ${spec.capability} is not draft_only (a photo must never reach a submit-capable write)`);
    }
    if (!["customer", "supplier"].includes(spec.party)) {
      fail(`document_kinds.${kind}.party must be "customer" or "supplier"`);
    }
    if (typeof spec.label !== "string" || spec.label.trim() === "") {
      fail(`document_kinds.${kind}.label must be a non-empty string (the button the user taps)`);
    }
  }
}

/**
 * A1/A2 — the e-invoice (HÓA ĐƠN ĐIỆN TỬ XML) input channel's policy.
 *
 * Mirrors `validateOcrPolicy` deliberately, and for the same reason: every value
 * that would WEAKEN the untrusted boundary is REFUSED at load time rather than
 * warned about, so a later edit cannot quietly turn "never trust an id from a
 * file" or "read numbers strictly" into an option.
 *
 * The kind → capability table is NOT duplicated here: this block only lists
 * which of `ocr_policy.document_kinds` the FILE channel offers, and a name that
 * table does not declare makes the contract invalid.
 */
function validateEinvoicePolicy(contract) {
  const p = contract.einvoice_policy;
  if (p === undefined) return; // feature not declared = no file channel anywhere
  const fail = (msg) => {
    throw new Error(`CAPABILITY_CONTRACT_INVALID: einvoice_policy ${msg}`);
  };
  if (!p || typeof p !== "object" || Array.isArray(p)) fail("must be an object");
  if (!Number.isInteger(p.max_xml_bytes) || p.max_xml_bytes < 1) {
    fail("max_xml_bytes must be a positive integer (a file the layer refuses to read at all must be a refusal, not an OOM)");
  }
  if (!Number.isInteger(p.max_lines) || p.max_lines < 1) {
    fail("max_lines must be a positive integer");
  }
  if (p.require_untrusted_sanitize !== true) {
    fail("require_untrusted_sanitize must be true (text from a supplier's file is DATA, never instructions)");
  }
  // M1 (2026-09-25) — the two PDF caps are a SECURITY boundary, so they get the
  // same treatment as max_xml_bytes instead of the code default silently
  // covering for them. `max_pdf_bytes` caps what the user SENDS, `max_inflated_bytes`
  // caps what zlib PRODUCES from one stream; a non-integer value here falls back
  // to a default a future edit cannot see, and a huge one stops capping at all.
  // Both are optional (`undefined`) because a deployment may not offer the PDF
  // channel — but a DECLARED cap must be a real cap.
  for (const key of ["max_pdf_bytes", "max_inflated_bytes"]) {
    if (p[key] === undefined) continue;
    if (!Number.isInteger(p[key]) || p[key] < 1) {
      fail(`${key} must be a positive integer when declared (it caps untrusted input, so a weakened value is refused at load time)`);
    }
  }
  if (p.authoritative_identifiers !== false) {
    fail('authoritative_identifiers must be false (phases3 Cấm: no authoritative id from a document)')
  }
  if (p.source !== "einvoice_xml") {
    fail('source must be "einvoice_xml" (the slots carry it so a client can never mistake a file for a photo)');
  }
  const offered = p.document_kinds;
  if (!Array.isArray(offered) || offered.length === 0) {
    fail("document_kinds must be a non-empty array of kind names");
  }
  const known = Object.keys(contract.ocr_policy?.document_kinds ?? {}).filter((k) => k !== "comment");
  if (known.length === 0) {
    fail("document_kinds requires ocr_policy.document_kinds to exist — the kind → capability table has exactly one home");
  }
  for (const kind of offered) {
    if (typeof kind !== "string" || kind.trim() === "") {
      fail("document_kinds entries must be non-empty strings");
    }
    if (!known.includes(kind)) {
      fail(`document_kinds lists "${kind}", which ocr_policy.document_kinds does not declare`);
    }
  }
}

/**
 * C2 — the document kinds a photo may become, already validated at load time.
 *
 * @returns {Record<string, {capability:string, party:string, label:string}>}
 */
export function ocrDocumentKinds() {
  const kinds = ocrPolicy()?.document_kinds ?? {};
  return Object.fromEntries(Object.entries(kinds).filter(([key]) => key !== "comment"));
}

export function validateContract(contract) {
  if (contract?.schema !== "erpn.capability-contract/v1") {
    throw new Error(`CAPABILITY_CONTRACT_SCHEMA: expected erpn.capability-contract/v1, got ${contract?.schema}`);
  }
  if (!Array.isArray(contract.routing) || contract.routing.length === 0) {
    throw new Error("CAPABILITY_CONTRACT_INVALID: routing table is required and non-empty");
  }
  if (!contract.capabilities || typeof contract.capabilities !== "object") {
    throw new Error("CAPABILITY_CONTRACT_INVALID: capabilities map is required");
  }

  validateOcrPolicy(contract);
  validateEinvoicePolicy(contract);

  const ids = Object.keys(contract.capabilities);
  for (const id of ids) {
    const cap = contract.capabilities[id];
    if (!KNOWN_TYPES.has(cap.type)) {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ${id} has unknown type "${cap.type}"`);
    }
    const level = cap.risk?.level;
    if (!RISK_ORDER.includes(level)) {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ${id} has unknown risk "${level}"`);
    }
    if (!Array.isArray(cap.errors) || cap.errors.length === 0) {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ${id} must declare at least one error code`);
    }
    if (!cap.entities || !Array.isArray(cap.entities.required)) {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ${id} must declare entities.required`);
    }
    const forbidden = cap.execution?.forbidden_in_ai_path === true;
    if (forbidden && level !== "CRITICAL") {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ${id} is forbidden_in_ai_path but risk is ${level} (must be CRITICAL)`);
    }
    if (forbidden && cap.type !== "WRITE") {
      // a forbidden READ would be nonsense and a sign of a mis-edit
      throw new Error(`CAPABILITY_CONTRACT_INVALID: ${id} is forbidden but not a WRITE capability`);
    }
    if (cap.authorization?.scope && !("company" in cap.authorization.scope)) {
      throw new Error(
        `CAPABILITY_CONTRACT_INVALID: ${id} must declare authorization.scope.company (plan2_final §24.2 — scope from P0)`,
      );
    }
    validateEntityPolicy(id, cap, contract);
    validateLinePolicy(id, cap, contract);
    for (const flag of ["allow_submit", "draft_only"]) {
      const v = cap.execution?.[flag];
      if (v !== undefined && typeof v !== "boolean") {
        throw new Error(`CAPABILITY_CONTRACT_INVALID: ${id} execution.${flag} must be boolean`);
      }
    }
    // An idempotent WRITE must say WHERE its correlation lives (P0 §10.4) — the
    // rule used to be spelled out for payment.create only, so a second WRITE
    // (B2) could have declared `idempotent: true` without any server-side half.
    if (cap.type === "WRITE" && !forbidden && cap.execution?.idempotent === true) {
      for (const key of ["write_doctype", "correlation_field", "reference_field"]) {
        if (typeof cap.execution[key] !== "string" || cap.execution[key].trim() === "") {
          throw new Error(
            `CAPABILITY_CONTRACT_INVALID: ${id} is an idempotent WRITE and must declare execution.${key}`,
          );
        }
      }
    }
  }

  for (const route of contract.routing) {
    if (typeof route.group !== "string" || route.group.length === 0) {
      throw new Error("CAPABILITY_CONTRACT_INVALID: every routing entry needs a group");
    }
    if (!Array.isArray(route.keywords) || route.keywords.length === 0) {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: routing group "${route.group}" needs keywords`);
    }
    if (route.notIf !== undefined) {
      try {
        // eslint-disable-next-line no-new
        new RegExp(route.notIf);
      } catch (err) {
        throw new Error(`CAPABILITY_CONTRACT_INVALID: routing "${route.group}" notIf is not a valid regex: ${err.message}`);
      }
    }
    const mapped = ids.filter((id) => contract.capabilities[id].route_group === route.group);
    if (mapped.length === 0) {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: routing group "${route.group}" maps to no capability`);
    }
    if (route.capability_default && !mapped.includes(route.capability_default)) {
      throw new Error(
        `CAPABILITY_CONTRACT_INVALID: routing "${route.group}" default "${route.capability_default}" is not in that group`,
      );
    }
    if (route.forbidden) {
      for (const id of mapped) {
        if (contract.capabilities[id].execution?.forbidden_in_ai_path !== true) {
          throw new Error(
            `CAPABILITY_CONTRACT_INVALID: routing "${route.group}" is forbidden but capability ${id} is not marked forbidden_in_ai_path`,
          );
        }
      }
    }
  }

  // The Reference WRITE stays payment.create: the first write shipped, and the
  // one every later write is compared against (B2 adds a second WRITE without
  // relaxing anything here).
  const create = contract.capabilities["payment.create"];
  if (!create) throw new Error("CAPABILITY_CONTRACT_INVALID: payment.create is required (Reference WRITE)");
  if (create.type !== "WRITE" || create.risk.level !== "HIGH" || create.risk.requires_confirmation !== true) {
    throw new Error("CAPABILITY_CONTRACT_INVALID: payment.create must be WRITE / HIGH / requires_confirmation");
  }
  for (const flag of ["idempotent", "verify_document", "reconcile_on_unknown"]) {
    if (create.execution?.[flag] !== true) {
      throw new Error(`CAPABILITY_CONTRACT_INVALID: payment.create must declare execution.${flag}=true`);
    }
  }
  if (!create.execution.correlation_field || !create.execution.reference_field) {
    throw new Error("CAPABILITY_CONTRACT_INVALID: payment.create must declare correlation_field + reference_field");
  }

  validateUiScreens(contract);
  validateDrillScreens(contract);
  validateUomPolicy(contract);

  return true;
}

const CONTRACT = deepFreeze(loadContract());
validateContract(CONTRACT);

/** Ordered route table for router.mjs. */
export function listRouting() {
  return CONTRACT.routing;
}

/** @returns {string[]} every capability id */
export function listCapabilities() {
  return Object.keys(CONTRACT.capabilities);
}

/** @returns {object|null} frozen contract entry */
export function getCapability(id) {
  return CONTRACT.capabilities[id] ?? null;
}

/**
 * next3/B — the BUSINESS DOCUMENT KEY policy for a capability, or null when the
 * capability does not dedupe on document identity (every capability except the
 * purchase path today).
 *
 * Read through the contract by all three consumers on purpose: the /ask
 * boundary, the executor's probe, and the migration script that creates the
 * column. A field name repeated in three files is a field name that will drift.
 *
 * @param {string} capabilityId
 * @returns {{field:string, source:string, on_missing_field:string, on_missing_identity:string}|null}
 */
export function businessDocKeyPolicy(capabilityId) {
  const block = getCapability(capabilityId)?.business_doc_key;
  if (!block || typeof block !== "object") return null;
  const field = typeof block.field === "string" && block.field.trim() !== "" ? block.field.trim() : null;
  // A declaration without a column cannot be honoured — treat it as "this
  // capability has no document-identity layer" rather than writing a key into
  // nowhere (the fail-closed direction is the caller's refusal, not this null).
  if (!field) return null;
  return { ...block, field };
}

/** @returns {object|undefined} the operational-controls block */
export function operationalControls() {
  return CONTRACT.operational_controls;
}

/**
 * C0 — the OCR input-layer policy (threshold, length cap, provider allowlist).
 *
 * Every OCR decision that has a safety consequence reads it from here instead
 * of carrying a local constant, so the boundary is reviewable in one place and
 * the contract test can prove the values cannot be relaxed.
 *
 * @returns {object} frozen ocr_policy block
 */
export function ocrPolicy() {
  return CONTRACT.ocr_policy;
}

/**
 * A1/A2 — the e-invoice XML input-layer policy (byte cap, line cap, offered
 * kinds). Read from the contract by the parser AND the route, so the caps are
 * reviewable in one place and the contract test can prove they cannot be
 * relaxed.
 *
 * @returns {object} frozen einvoice_policy block
 */
export function einvoicePolicy() {
  return CONTRACT.einvoice_policy;
}

/**
 * A1/A2 — the DOCUMENT KINDS the file channel offers, resolved to their full
 * contract entries (capability + party + label) from the ONE kind table.
 *
 * @returns {Record<string, {capability:string, party:string, label:string}>}
 */
export function einvoiceDocumentKinds() {
  const all = ocrDocumentKinds();
  const offered = einvoicePolicy()?.document_kinds ?? [];
  return Object.fromEntries(offered.map((kind) => [kind, all[kind]]));
}

/**
 * EVERY document kind any input channel may hand over, from the contract.
 *
 * next3/B uses this at the `/ask` boundary: the identity attached to a sentence
 * has to be validated against a vocabulary that is the CONTRACT's, and a kind
 * one channel offers but another does not (today: the file channel offers only
 * `purchase` while the camera offers both) must not turn a well-formed identity
 * into a 400. Whether a capability CONSUMES the identity is a separate question,
 * answered by `business_doc_key` on that capability.
 *
 * @returns {string[]} sorted, de-duplicated kind names
 */
export function declaredDocumentKinds() {
  return [...new Set([...Object.keys(ocrDocumentKinds()), ...Object.keys(einvoiceDocumentKinds())])].sort();
}

/**
 * The ERPNext doctypes this project may CREATE, derived from the contract —
 * never a hardcoded list in the MCP client's write gate (B2).
 *
 * `submit` is separate and OPT-IN per capability: creating a draft and
 * submitting it are different commitments, so a capability that only ever
 * produces drafts (sales_order.create) cannot reach the submit path at all.
 * Forbidden capabilities are excluded even if they name a doctype.
 *
 * @returns {Record<string, {create:boolean, submit:boolean, capability:string}>}
 */
export function writeDoctypes() {
  const out = {};
  for (const id of listCapabilities()) {
    if (isForbidden(id)) continue;
    const cap = getCapability(id);
    const dt = cap.execution?.write_doctype;
    if (typeof dt !== "string" || dt.trim() === "") continue;
    out[dt.trim()] = {
      create: true,
      submit: cap.execution.allow_submit === true,
      capability: id,
    };
  }
  return out;
}

/**
 * The READ drill-down screens declared by the contract (A1).
 * @returns {object} frozen map screenId → screen definition
 */
export function listUiScreens() {
  const { comment, ...screens } = CONTRACT.ui_screens ?? {};
  return screens;
}

/** @returns {object|null} frozen screen definition */
export function getUiScreen(screenId) {
  if (typeof screenId !== "string" || screenId.trim() === "") return null;
  return listUiScreens()[screenId.trim()] ?? null;
}

/**
 * Which drill-down (if any) may an answer from this capability offer?
 * @param {string|null} capabilityId
 * @returns {{id:string, screen:object}|null}
 */
export function uiScreenForCapability(capabilityId) {
  if (!capabilityId) return null;
  for (const [id, screen] of Object.entries(listUiScreens())) {
    if (screen.offered_by?.includes(capabilityId)) return { id, screen };
  }
  return null;
}

/**
 * The fixed-id day drill table (P4-4). Same two accessors as `ui_screens`, but
 * no `offered_by`/entity: these ids are tapped from the summary screen, never
 * derived from a phrase.
 * @returns {object} id -> definition (comment stripped)
 */
export function listDrillScreens() {
  const { comment, ...drills } = CONTRACT.drill_screens ?? {};
  return drills;
}

/** @returns {object|null} frozen drill definition */
export function getDrillScreen(drillId) {
  if (typeof drillId !== "string" || drillId.trim() === "") return null;
  return listDrillScreens()[drillId.trim()] ?? null;
}

/**
 * Clamp a requested page size to what the screen declares. The bound is policy,
 * so it lives in the contract; the caller may ask for fewer rows than the
 * minimum only by omission (the minimum exists so a drill-down never returns a
 * list too short to be useful, and the maximum so one screen cannot dump an
 * unbounded export).
 *
 * @param {object} screen contract screen definition
 * @param {unknown} requested
 * @returns {number}
 */export function clampUiLimit(screen, requested) {
  const { default: def, min, max } = screen?.limit ?? {};
  if (!Number.isInteger(min) || !Number.isInteger(max) || !Number.isInteger(def)) {
    throw new Error("CAPABILITY_CONTRACT_INVALID: screen limit clamping failed");
  }
  // A REQUESTED page size only exists when the client actually sent one: `null`
  // (absent) must fall back to `default`, NOT become 0 and get clamped up to
  // `min` — that would silently shrink the page the contract promised.
  const want = requested === null || requested === undefined || requested === '' ? null : Number(requested);
  if (!Number.isFinite(want)) return def;
  return Math.min(max, Math.max(min, Math.trunc(want)));
}

/** @returns {boolean} true when the capability must never run on the AI path */
export function isForbidden(id) {
  return getCapability(id)?.execution?.forbidden_in_ai_path === true;
}

/**
 * Map a proposal action (e.g. "create_payment_entry") to its capability id.
 * @returns {string|null}
 */
export function capabilityForAction(action) {
  if (typeof action !== "string") return null;
  for (const id of listCapabilities()) {
    if (getCapability(id).proposal_action === action) return id;
  }
  return null;
}

/**
 * A capability that is declared but NOT implemented yet (`status: "stub"` or no
 * skill): the pipeline answers KNOWN_INTENT_UNIMPLEMENTED for it, so it must
 * never be counted as an executable WRITE — "declared" and "implemented" are
 * different states (B2: delivery.create / quotation.create).
 * @param {string} id
 */
export function isStub(id) {
  const cap = getCapability(id);
  return !cap || cap.status === "stub" || cap.skill === null || cap.skill === undefined;
}

/**
 * The WRITE capabilities this project may execute, derived from the contract
 * (NOT a hardcoded list). Forbidden capabilities are excluded by construction,
 * and so are stubs — a declared-but-unimplemented WRITE must not appear in an
 * error message as though it were runnable.
 * @returns {string[]} proposal action names
 */
export function executableWriteActions() {
  return listCapabilities()
    .filter((id) => {
      const cap = getCapability(id);
      return cap.type === "WRITE" && isForbidden(id) === false && !isStub(id);
    })
    .map((id) => getCapability(id).proposal_action);
}

/**
 * Throw unless a capability exists, is a WRITE, is not forbidden, declares
 * confirmation, and carries an idempotent execution policy. Used by the Safety
 * Gateway before anything reaches ERPNext.
 * @param {string} id
 */
export function assertCapabilityExecutable(id) {
  const cap = getCapability(id);
  if (!cap) {
    throw Object.assign(new Error(`CAPABILITY_NOT_FOUND: "${id}" is not in the capability contract`), {
      code: "CAPABILITY_NOT_FOUND",
    });
  }
  if (cap.type !== "WRITE") {
    throw Object.assign(new Error(`CAPABILITY_NOT_WRITE: "${id}" is ${cap.type} — the execute path only runs WRITE capabilities`), {
      code: "CAPABILITY_NOT_WRITE",
    });
  }
  if (isForbidden(id)) {
    throw Object.assign(
      new Error(`FORBIDDEN_IN_AI_PATH: "${id}" is ${cap.execution.reason ?? "forbidden"} — refused before ERPNext`),
      { code: "FORBIDDEN_IN_AI_PATH" },
    );
  }
  // Declared-but-unimplemented is reported as ITSELF (B2), not as the more
  // specific-looking "not idempotent" the stub happens to also be: the true
  // reason nothing can execute is that there is no skill behind the capability.
  // document.delete keeps FORBIDDEN_IN_AI_PATH because the forbidden check above
  // runs first — its refusal must never degrade to "unimplemented".
  if (isStub(id)) {
    throw Object.assign(
      new Error(`CAPABILITY_NOT_IMPLEMENTED: "${id}" is declared but has no skill — nothing can execute it`),
      { code: "CAPABILITY_NOT_IMPLEMENTED" },
    );
  }
  if (cap.risk?.requires_confirmation !== true) {
    throw Object.assign(new Error(`CAPABILITY_NO_CONFIRMATION: "${id}" does not require confirmation — refusing to execute`), {
      code: "CAPABILITY_NO_CONFIRMATION",
    });
  }
  if (cap.execution?.idempotent !== true) {
    throw Object.assign(
      new Error(`CAPABILITY_NOT_IDEMPOTENT: "${id}" does not declare an idempotent execution policy`),
      { code: "CAPABILITY_NOT_IDEMPOTENT" },
    );
  }
  return cap;
}

/**
 * Which capability does this (already normalized) text mean?
 *
 * Routing is contract-driven: the first route whose keywords match wins
 * (sentence-start anchored when the route says so, with its deny-list), then
 * the most specific capability inside that group by trigger match, falling
 * back to the group's declared default.
 *
 * @param {string} text normalized text (Phase 1 output)
 * @returns {{id:string, capability:object, group:string, matched:string, forbidden:boolean} | null}
 */
export function resolveCapability(text) {
  const raw = String(text ?? "").toLowerCase().replaceAll("khách hàng", "khách");
  const padded = ` ${raw} `;
  for (const route of listRouting()) {
    const hit = route.startsWith
      ? route.keywords.find((kw) => raw.startsWith(String(kw).toLowerCase()) && !(route.notIf && new RegExp(route.notIf).test(raw)))
      : route.keywords.find((kw) => padded.includes(String(kw).toLowerCase()));
    if (!hit) continue;
    const inGroup = listCapabilities().filter((id) => getCapability(id).route_group === route.group);
    const specific = inGroup.find((id) =>
      (getCapability(id).triggers ?? []).some((tr) => padded.includes(String(tr).toLowerCase())),
    );
    const id = specific ?? route.capability_default ?? inGroup[0];
    return {
      id,
      capability: getCapability(id),
      group: route.group,
      matched: String(hit).trim(),
      forbidden: isForbidden(id),
    };
  }
  return null;
}

/** Test seam — the validated contract (frozen). */
export const __contract = CONTRACT;
