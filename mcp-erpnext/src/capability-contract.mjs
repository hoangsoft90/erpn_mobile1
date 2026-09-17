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

  // The write path must declare where its correlation lives (P0 §10.4).
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

/** @returns {object|undefined} the operational-controls block */
export function operationalControls() {
  return CONTRACT.operational_controls;
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
 * The WRITE capabilities this project may execute, derived from the contract
 * (NOT a hardcoded list). Forbidden capabilities are excluded by construction.
 * @returns {string[]} proposal action names
 */
export function executableWriteActions() {
  return listCapabilities()
    .filter((id) => {
      const cap = getCapability(id);
      return cap.type === "WRITE" && isForbidden(id) === false;
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
