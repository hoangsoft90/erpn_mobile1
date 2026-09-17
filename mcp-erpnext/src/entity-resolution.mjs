/**
 * Entity Resolution — the SECURITY boundary of plan2_final §4, not a search
 * helper. Two jobs:
 *
 *  1. NAME the resolution state (`EXACT_MATCH` | `FUZZY_SINGLE_MATCH` |
 *     `AMBIGUOUS_MATCH` | `NO_MATCH`) so the policy can be applied per risk.
 *  2. APPLY the contract's entity policy: for a WRITE the rule is
 *     **Exact only** — a fuzzy substring hit is never turned into an
 *     authoritative customer_id, no matter how confident anything upstream is
 *     (§4.3, §8 risk matrix: `Tạo payment | HIGH | Bắt buộc | Exact`).
 *
 * The classification is derived from the EXISTING resolver output
 * (`resolveCustomer` in copilot-server.mjs) instead of re-implementing the
 * scoring — that function is the one already measured against real data
 * (batch-accuracy result9), and a second matcher would be a second truth.
 */

/**
 * Resolution states (§4.1). Frozen: a typo like `FUZZY_SINGLE` must not
 * silently become a state that no policy covers.
 */
export const ENTITY_STATES = Object.freeze({
  EXACT_MATCH: "EXACT_MATCH",
  FUZZY_SINGLE_MATCH: "FUZZY_SINGLE_MATCH",
  AMBIGUOUS_MATCH: "AMBIGUOUS_MATCH",
  NO_MATCH: "NO_MATCH",
});

/** The state meaning "the user picked this candidate explicitly". */
export const PICKED_STATE = ENTITY_STATES.EXACT_MATCH;

/**
 * Classify an existing resolver result.
 *
 * @param {object} resolution output of resolveCustomer():
 *        { customer, ambiguous, candidates }
 * @param {object} [opts]
 * @param {string[]} [opts.candidates] candidate name fragments seen in the text
 *        (`nameCandidates(nlp.text)`); used to tell EXACT from FUZZY.
 * @param {(c:object)=>string|null} [opts.nameOf]
 * @param {string|null} [opts.pickedEntityId] an id the USER selected in the
 *        picker — the only way a non-exact match becomes authoritative.
 * @returns {{state:string, customer:object|null, candidates:string[],
 *            picked:boolean, fuzzy:boolean}}
 */
export function classifyResolution(resolution, opts = {}) {
  const { candidates = [], nameOf = defaultNameOf, pickedEntityId = null } = opts;
  const customer = resolution?.customer ?? null;
  const ambiguousFlag = resolution?.ambiguous === true;
  const list = resolution?.candidates ?? [];

  // Explicit user pick: authoritative by construction, but only for the id the
  // server already listed (see pickFromCandidates below) — the caller passes an
  // id that came from a tool result, never free text.
  if (pickedEntityId && customer && String(customer.name ?? customer.customer_name) === String(pickedEntityId)) {
    return { state: PICKED_STATE, customer, candidates: [], picked: true, fuzzy: false };
  }

  if (!customer) {
    return {
      state: ambiguousFlag ? ENTITY_STATES.AMBIGUOUS_MATCH : ENTITY_STATES.NO_MATCH,
      customer: null,
      candidates: list,
      picked: false,
      fuzzy: false,
    };
  }
  if (ambiguousFlag) {
    // resolveCustomer sets this when several customers matched the same
    // fragment and it had to fall back to one of them.
    return { state: ENTITY_STATES.AMBIGUOUS_MATCH, customer, candidates: list, picked: false, fuzzy: true };
  }

  const name = String(nameOf(customer) ?? "").toLowerCase();
  const id = String(customer.name ?? "").toLowerCase();
  const exact = candidates.some((c) => {
    const frag = String(c).toLowerCase();
    return frag === name || frag === id;
  });
  return {
    state: exact ? ENTITY_STATES.EXACT_MATCH : ENTITY_STATES.FUZZY_SINGLE_MATCH,
    customer,
    candidates: [],
    picked: false,
    fuzzy: !exact,
  };
}

function defaultNameOf(customer) {
  return customer?.customer_name ?? customer?.name ?? null;
}

/**
 * Apply the contract's policy for this state × capability.
 *
 * @param {string} state one of ENTITY_STATES
 * @param {object|null} capability contract entry (has entity_policy, or falls
 *        back to `defaults.entity_policy` — resolved by the caller contract)
 * @param {object|null} defaultsPolicy contract.defaults.entity_policy
 * @returns {{auto_select:boolean, require_picker:boolean, block:boolean, state:string, code:string|null}}
 */
export function entityPolicy(state, capability, defaultsPolicy = null) {
  const policy = capability?.entity_policy ?? defaultsPolicy;
  const rule = policy?.[state];
  if (!rule) {
    // Fail closed: an unpoliced state must not be treated as "carry on".
    return {
      auto_select: false,
      require_picker: false,
      block: true,
      state,
      code: "ENTITY_POLICY_MISSING",
    };
  }
  const code =
    rule.block === true
      ? "ENTITY_NOT_FOUND_BLOCKED"
      : rule.require_picker === true
        ? state === ENTITY_STATES.AMBIGUOUS_MATCH
          ? "AMBIGUOUS_ENTITY"
          : "ENTITY_PICK_REQUIRED"
        : null;
  return {
    auto_select: rule.auto_select === true,
    require_picker: rule.require_picker === true,
    block: rule.block === true,
    state,
    code,
  };
}

/**
 * Candidate list for the Flutter picker (§4.4: enough to tell them apart —
 * name, customer code, and nothing else unless policy allows it).
 *
 * @param {object[]} customers rows from the customer list
 * @param {{limit?:number}} [opts]
 */
export function pickerCandidates(customers, { limit = 5 } = {}) {
  return (customers ?? [])
    .slice(0, limit)
    .map((c) => ({
      id: c.name ?? null,
      name: c.customer_name ?? c.name ?? null,
      // Deliberately NOT phone/email: §4.4 says only "if policy allows".
      label: `${c.customer_name ?? c.name ?? "?"} (${c.name ?? "?"})`,
    }))
    .filter((c) => c.id);
}

/**
 * Customers to OFFER in the picker for this text.
 *
 * Fragments come from the caller (`nameCandidates(nlp.text)`) — this module
 * stays free of the resolver so it can be unit-tested on its own. Multi-word
 * fragments win over single tokens, so "trang trại minh anh" offers the two
 * real "Trang trại ..." customers before every customer containing "anh".
 *
 * @param {object[]} customers rows read from ERPNext
 * @param {string[]} fragments candidate phrases, as produced by nameCandidates
 * @param {{limit?:number}} [opts]
 */
export function pickerForText(customers, fragments = [], { limit = 5 } = {}) {
  const rows = customers ?? [];
  const ordered = [...fragments].sort((a, b) => b.length - a.length);
  const hits = [];
  for (const frag of ordered) {
    const f = String(frag).toLowerCase();
    if (f.length < 2) continue;
    for (const c of rows) {
      const name = String(c.customer_name ?? c.name ?? "").toLowerCase();
      const id = String(c.name ?? "").toLowerCase();
      if ((name.includes(f) || id.includes(f)) && !hits.some((h) => h.id === c.name)) hits.push(c);
    }
    if (hits.length >= limit) break;
  }
  return pickerCandidates(hits, { limit });
}

/**
 * Resolve an explicit user pick against a freshly-read candidate list.
 * Returns the customer row ONLY if the id really is in the list — an id that
 * came from the client is not trusted on its own (§4.2: never let anything
 * downstream invent an ERP id).
 *
 * @param {object[]} customers candidate rows already read from ERPNext
 * @param {string|null} pickedId
 * @returns {{ok:boolean, customer?:object, code?:string, error?:string}}
 */
export function pickFromCandidates(customers, pickedId) {
  if (typeof pickedId !== "string" || pickedId.trim() === "") {
    return { ok: false, code: "ENTITY_PICK_INVALID", error: "thiếu id khách đã chọn" };
  }
  const hit = (customers ?? []).find((c) => String(c.name) === pickedId.trim());
  if (!hit) {
    return {
      ok: false,
      code: "ENTITY_PICK_INVALID",
      error: `khách ${pickedId} không có trong danh sách vừa đọc từ ERPNext — không dùng id do client tự gửi`,
    };
  }
  return { ok: true, customer: hit };
}
