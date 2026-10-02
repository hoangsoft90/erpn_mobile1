#!/usr/bin/env node
/**
 * Falsification harness for M1 (`customer.create` — the first write whose entity
 * does not exist until it is written). Each case deletes ONE guard and the NAMED
 * test must go red.
 *
 * Why this file exists rather than a one-off script: a guard nobody can re-run
 * is decoration, and P9-B taught the harder half of the lesson — a mutation that
 * comes back GREEN can mean the guard is dead OR that the case points at the
 * wrong test. Both are reported here, and the anchor/restore discipline lives in
 * `lib/harness.mjs` (baseline control first, moved anchor reported, restore
 * byte-identical, Ctrl-C restores).
 *
 * What is being defended, in the order the record appears:
 *
 *  - the ROUTING half: a create COMMAND opens the create group (the deny-list
 *    only applies because the group declares `startsWith`);
 *  - the NAME half: the proposed name is the sentence MINUS the command verbs —
 *    if the whole sentence is proposed, the business key checked is not the one
 *    the user meant;
 *  - the BUSINESS KEY half: exact name / SĐT / MST and a FUZZY near-identity all
 *    refuse and name the existing customer (ERPNext itself does NOT dedupe, so a
 *    silent clone splits a shop's receivable);
 *  - the STALENESS half: the master list is re-read at execute, so a customer
 *    created between card and confirm refuses instead of cloning;
 *  - the EVIDENCE half: the created row is READ BACK through the shared
 *    unwrapper — the bug this case pins (a hand-rolled one-level unwrap made
 *    every real create report CC_WRITE_UNVERIFIED) is exactly the kind of quiet
 *    failure the read-back exists to catch;
 *  - the ONCE-ONLY half: without the correlation field there is no server-side
 *    dedup, so nothing may be written;
 *  - the DOOR half: the executor is named in exactly ONE table (the gateway), so
 *    removing the entry must refuse every write;
 *  - and the master-data half: Customer is creatable but never submittable.
 */
import { runCases, PATHS } from "./lib/harness.mjs";

const SKILL = "src/skills/customer-create.mjs";
const CONTRACT = "capabilities.json";
const SERVER = "src/copilot-server.mjs";
const GATEWAY = "src/safety-gateway.mjs";
const SUITE = "test/m1-customer-create.test.mjs";

const CASES = [
  {
    name: "A. the create keyword no longer routes — “thêm khách …” stops reaching the create group",
    file: CONTRACT,
    old: '        "thêm khách",\n        "them khach",',
    new: '        "thêm kháchX",\n        "them khachX",',
    only: "M1 routing: the CREATE command reaches customer_create_write; a debt QUESTION stays a read",
  },
  {
    name: "B. the proposed name keeps its command verbs — the business key checked is not the one meant",
    file: SERVER,
    old: "  return m || null;",
    new: '  return String(text ?? "") || null;',
    only: "M1 E2E /ask: “thêm khách <mới>” returns a HIGH card + the offer, and writes nothing",
  },
  {
    name: "C. the builder stops refusing a duplicate — a customer gets cloned",
    file: SKILL,
    old: '  const collision = findCustomerCollision(rows, { customer_name: name, mobile_no: mobile, tax_id: tax });\n  if (collision) {\n    const e = collision.existing;\n    const label = e?.customer_name ?? e?.name ?? "?";\n    const id = e?.name ?? "?";\n    if (collision.kind === "fuzzy") {',
    new: '  const collision = findCustomerCollision(rows, { customer_name: name, mobile_no: mobile, tax_id: tax });\n  if (false) {\n    const e = collision.existing;\n    const label = e?.customer_name ?? e?.name ?? "?";\n    const id = e?.name ?? "?";\n    if (collision.kind === "fuzzy") {',
    only: "M1 builder: a duplicate REFUSES and names the existing customer (never clones)",
  },
  {
    name: "D. the FUZZY near-identity check is gone — a new master is born in the shadow of an existing one",
    file: SKILL,
    old: "    return hasRun(name, have) || hasRun(have, name);",
    new: "    return false;",
    only: "M1 pre-check: exact name / SĐT / MST each refuse with their OWN code, fuzzy too",
  },
  {
    name: "E. the EXECUTOR stops re-reading the master list — a customer created between card and confirm is cloned",
    file: SKILL,
    old: '  const collision = findCustomerCollision(rows, { customer_name: name, mobile_no: mobile, tax_id: tax });\n  if (collision) {\n    const e = collision.existing;\n    throw refuse(',
    new: '  const collision = findCustomerCollision(rows, { customer_name: name, mobile_no: mobile, tax_id: tax });\n  if (false) {\n    const e = collision.existing;\n    throw refuse(',
    only: "M1 execute: a customer that appeared between card and confirm REFUSES (no clone)",
  },
  {
    name: "F. the read-back unwraps ONE level instead of two — verify sees undefined and every create reports UNVERIFIED",
    file: SKILL,
    old: "  const doc = docOf(res);\n  const problems = [];",
    new: "  const doc = res?.data ?? res ?? {};\n  const problems = [];",
    only: "M1 execute: a confirmed create writes ONE real record, and reads it back",
  },
  {
    name: "G. no correlation field is no longer a refusal — a write happens with no server-side dedup",
    file: SKILL,
    old: "  if (probe.correlation_field_unavailable) {",
    new: "  if (false) {",
    only: "M1 execute: no correlation field ⇒ NO write at all (fail closed)",
  },
  {
    name: "H. the gateway stops registering the executor — the only door for this write is gone",
    file: GATEWAY,
    old: '  "customer.create": {',
    new: '  "customer.createX": {',
    only: "M1 HTTP /execute: a confirmed create writes ONE record; a replay writes nothing more",
  },
  {
    name: "I. the create offer is attached to READS too — a debt question invites a record the user never asked for",
    file: SERVER,
    old: '      const isCustomerWriteNoMatch =\n        getCapability(route.capability)?.type === "WRITE" && partyKind === "customer" && !ambiguous && !isCashExpense;',
    new: '      const isCustomerWriteNoMatch =\n        partyKind === "customer" && !ambiguous && !isCashExpense;',
    only: "M1 E2E /ask: a WRITE about an unknown customer offers to create one; a READ does NOT",
  },
  {
    name: "K. the hardcoded group comes back — the payload again carries a value the site never had",
    file: SKILL,
    old: "    ...(profile.customer_group ? { customer_group: profile.customer_group } : {}),",
    new: '    customer_group: profile.customer_group ?? "Múa",',
    only: "M1 payload: the correlation field carries the action id (the only server-side dedup)",
  },
  {
    name: "L. a configured value is no longer checked against the site — a typo silently sends an unknown group",
    file: SKILL,
    old: "      if (!known.includes(value)) {",
    new: "      if (false) {",
    only: "M1-site: a configured value the site does NOT have is a REFUSAL (a typo must be loud)",
  },
  {
    name: "M. the site's own default is ignored — a Select that already has an answer is left unresolved",
    file: SKILL,
    old: '    if (!value && meta.kind === "select" && meta.default && known.includes(meta.default)) {',
    new: "    if (false) {",
    only: "M1-site: the classification is read from the SITE, not assumed (site default wins when nothing else is set)",
  },
  {
    name: "N. the executor drops the resolved classification — the site receives a create it cannot classify",
    file: SKILL,
    // Anchored on the two lines that only the CREATE call has: `profile:
    // profile.values,` also appears in the verify call, and a one-line anchor
    // would have mutated the wrong one (the P9-A2 lesson, re-applied).
    old: "    correlation: field,\n    profile: profile.values,",
    new: "    correlation: field,\n    profile: {},",
    only: "M1-site execute: the resolved classification reaches the ERPNext payload and is verified back",
  },
  {
    name: "O. the master read goes back to one page — the duplicate check is blind past that row",
    file: SKILL,
    old: '  return mcp.callTool("erpnext_customer_list", { limit: 0 });',
    new: '  return mcp.callTool("erpnext_customer_list", { limit: 100 });',
    only: "M1-site: the pre-check reads the WHOLE master, not one page",
  },
  {
    name: "P. the fuzzy rule compares raw letter-substrings again — a one-letter existing name matches every name containing that letter",
    file: SKILL,
    old: "    return hasRun(name, have) || hasRun(have, name);",
    new: '    return String(have ?? "").includes(name) || name.includes(String(have ?? ""));',
    only: "M1 pre-check: the fuzzy rule matches WORDS, not letters (the site has a customer named “A”)",
  },
  {
    name: "J. Customer becomes SUBMITTABLE — a doctype with no submit is reached from chat",
    file: CONTRACT,
    old: '        "write_doctype": "Customer",\n        "correlation_field": "custom_ai_action_id",\n        "reference_field": "custom_ai_action_id",\n        "allow_submit": false,',
    new: '        "write_doctype": "Customer",\n        "correlation_field": "custom_ai_action_id",\n        "reference_field": "custom_ai_action_id",\n        "allow_submit": true,',
    only: "M1 write gate: submitting a Customer is refused in code (master data has no submit)",
  },
];

process.exit(
  runCases(CASES, { title: "M1 customer.create", nodeFiles: { default: SUITE }, root: PATHS.ROOT }) === 0
    ? 0
    : 1,
);
