/**
 * M1 — `customer.create`, the FIRST write whose entity does not exist yet
 * (`.plan/next3/M1-customer-create-button.md`).
 *
 * What this file proves, in the order the risk appears:
 *
 *  1. THE CONTRACT IS THE ONLY DOOR: Customer is creatable but NEVER submittable
 *     (master data has no submit), and the action is in the executable set.
 *  2. THE BUSINESS KEY IS THE SAFETY STORY: unlike every other write there is no
 *     draft to hide behind — the record is REAL the moment create returns. So the
 *     pre-check must REFUSE a duplicate (exact name / SĐT / MST) and a FUZZY
 *     near-identity, and name the customer that already exists instead of cloning
 *     it. ERPNext itself does NOT dedupe (the mock mirrors that), so a silent
 *     clone here would split a shop's receivable across two masters.
 *  3. NOTHING IS WRITTEN BEFORE CONFIRM: the builder performs its checks and
 *     returns a proposal; the write spy proves zero ERPNext writes.
 *  4. THE CARD SAYS THE TRUTH: estimated contact fields are optional with a
 *     warning (policy §5 default), the entity id is the business key (no ERPNext
 *     id exists yet), and the follow-up is the user's next sentence.
 *  5. EXECUTE IS GUARDED: the master list is RE-read at execute (a duplicate that
 *     appeared between card and confirm refuses), no correlation field ⇒ no write
 *     at all, and the created row is READ BACK and checked.
 *  6. REGRESSION: the nine transaction writes are still executable, and a READ
 *     about an unknown customer never offers to create one.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(HERE, "..", "..");

import { executableWriteActions, getCapability, writeDoctypes } from "../src/capability-contract.mjs";
import {
  buildCustomerCreateData,
  buildCustomerCreateProposal,
  executeCustomerCreateProposal,
  findCustomerCollision,
  listCustomers,
  readProfileMasters,
  resolveProfileValues,
  profileReads,
} from "../src/skills/customer-create.mjs";
import { createMcpClient, MOCK_SERVER } from "../src/client.mjs";
import { routeIntent } from "../src/router.mjs";

/* --------------------------------------------------------------- fixtures -- */

/** The master list the pre-check runs on (shape = erpnext_customer_list rows). */
const ROWS = [
  { name: "CUST-00001", customer_name: "Nguyễn Thị Lan", mobile_no: "0901111111" },
  { name: "CUST-00002", customer_name: "Trần Văn Hai", tax_id: "0312345678" },
];

/*
 * M1-site fixtures — the site's OWN answers for the classification fields. The
 * leaf set deliberately has MORE THAN ONE leaf, so "no safe default" is a real
 * state here: the real site measured 8 leaves and no "Múa" group, which is what
 * made the hardcoded group an unwritable value.
 */
const GROUP_ROWS = [
  { name: "All Customer Groups", is_group: 1, parent_customer_group: null },
  { name: "Commercial", is_group: 0, parent_customer_group: "All Customer Groups" },
  { name: "Individual", is_group: 0, parent_customer_group: "All Customer Groups" },
];
const TERRITORY_ROWS = [
  { name: "All Territories", is_group: 1, parent_territory: null },
  { name: "Vietnam", is_group: 0, parent_territory: "All Territories" },
];
const DOCFIELD_ROWS = [
  { parent: "Customer", fieldname: "customer_type", fieldtype: "Select", options: "Company\nIndividual\nPartnership", default: "Company", reqd: 1 },
  { parent: "Customer", fieldname: "customer_group", fieldtype: "Link", options: "Customer Group", default: null, reqd: 0 },
  { parent: "Customer", fieldname: "territory", fieldtype: "Link", options: "Territory", default: null, reqd: 0 },
];

/** The three classification reads the builder needs, backed by the fixtures. */
function fakeProfileReads({ groups = GROUP_ROWS, territories = TERRITORY_ROWS, fields = DOCFIELD_ROWS } = {}) {
  return {
    listCustomerGroups: async () => ({ data: { doctype: "Customer Group", count: groups.length, data: groups } }),
    listTerritories: async () => ({ data: { doctype: "Territory", count: territories.length, data: territories } }),
    listCustomerFieldSpecs: async () => ({ data: { doctype: "DocField", count: fields.length, data: fields } }),
  };
}

/** A skills bag with the reads the builder uses + a write spy that must not fire. */
function fakeSkills(rows = ROWS, profile = {}) {
  const spy = { reads: 0, writes: 0 };
  return {
    spy,
    ...fakeProfileReads(profile),
    listCustomers: async () => {
      spy.reads += 1;
      return { data: { doctype: "Customer", count: rows.length, data: rows } };
    },
    callWriteTool: async () => {
      spy.writes += 1;
      throw new Error("the builder must never write");
    },
  };
}

/** Build a proposal with the classification env vars neutralised (they leak in
 *  from a real deployment, and a test that depends on the shell is not a test). */
async function withoutProfileEnv(fn) {
  const names = ["COPILOT_DEFAULT_CUSTOMER_GROUP", "COPILOT_DEFAULT_TERRITORY", "COPILOT_DEFAULT_CUSTOMER_TYPE"];
  const prev = names.map((n) => [n, process.env[n]]);
  for (const n of names) delete process.env[n];
  try {
    // `await` INSIDE the try: the builder reads process.env after its awaits, so
    // restoring the vars before it resolves would test the shell, not the code.
    return await fn();
  } finally {
    for (const [n, v] of prev) {
      if (v === undefined) delete process.env[n];
      else process.env[n] = v;
    }
  }
}

async function refusal(promise, code) {
  await assert.rejects(promise, (err) => {
    assert.equal(err?.code, code, `expected ${code}, got ${err?.code}: ${err?.message}`);
    assert.ok(String(err?.message ?? "").length > 0, "a refusal must explain itself");
    return true;
  });
}

/* ------------------------------------------------ 1. contract + write gate -- */

test("M1 contract: customer.create is a real WRITE — creatable, NEVER submittable", () => {
  const cap = getCapability("customer.create");
  assert.equal(cap.type, "WRITE");
  assert.equal(cap.route_group, "customer_create_write");
  assert.equal(cap.proposal_action, "create_customer");
  assert.equal(cap.skill, "skills/customer-create.mjs#buildCustomerCreateProposal");
  assert.equal(cap.risk.level, "HIGH");
  assert.equal(cap.risk.requires_confirmation, true);
  assert.equal(cap.execution.write_doctype, "Customer");
  assert.equal(cap.execution.correlation_field, "custom_ai_action_id");
  // Master data: no draft, no submit. `draft_only: false` is the honest
  // declaration — a Customer is REAL the moment it is created, and the safety
  // story therefore lives in the confirm button + the business key pre-check.
  assert.equal(cap.execution.allow_submit, false);
  assert.equal(cap.entities.required.includes("customer_name"), true);
  assert.equal(cap.field_policy.duplicate, "refuse_return_existing");
  assert.equal(cap.field_policy.created_as, "active_record");
  assert.equal(cap.field_policy.auto_follow_up, "none");

  // The client gate derives its allow-list from the SAME contract.
  const allowed = writeDoctypes()["Customer"];
  assert.equal(allowed.create, true);
  // NEVER submittable: master data has no submit in ERPNext, and a chat path
  // that could submit it would be a doctype the site does not have.
  assert.equal(allowed.submit, false);
  assert.ok(executableWriteActions().includes("create_customer"));
});

test("M1 write gate: submitting a Customer is refused in code (master data has no submit)", async () => {
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    await assert.rejects(
      () => client.callWriteTool("erpnext_doc_submit", { doctype: "Customer", name: "CUST-00001" }),
      /WRITE_REFUSED/,
    );
  } finally {
    await client.close().catch(() => {});
  }
});

/* ------------------------------------------------- 2. the business key ----- */

test("M1 pre-check: exact name / SĐT / MST each refuse with their OWN code, fuzzy too", () => {
  const norm = (s) => String(s ?? "").trim();
  const cases = [
    [{ customer_name: "Nguyễn Thị Lan" }, "exact_name", "CC_DUPLICATE_NAME", "CUST-00001"],
    [{ customer_name: "Nguyễn Văn Tèo", mobile_no: "0901111111" }, "mobile", "CC_DUPLICATE_MOBILE", "CUST-00001"],
    [{ customer_name: "Nguyễn Văn Tèo", tax_id: "0312345678" }, "tax_id", "CC_DUPLICATE_TAX_ID", "CUST-00002"],
    // A NEW master must not be born inside the shadow of a near-identical one.
    [{ customer_name: "Lan" }, "fuzzy", "CC_FUZZY_MATCH", "CUST-00001"],
  ];
  for (const [want, kind, code, existing] of cases) {
    const hit = findCustomerCollision(ROWS, want);
    assert.ok(hit, `${code} should have matched for ${norm(want.customer_name)}`);
    assert.equal(hit.kind, kind);
    assert.equal(hit.code, code);
    assert.equal(hit.existing.name, existing);
  }

  // An empty contact pair is NOT a collision: the contract requires the name
  // only, and a walk-in may have neither field at hand.
  assert.equal(findCustomerCollision(ROWS, { customer_name: "Phạm Thị Mới", mobile_no: "", tax_id: "" }), null);
});

test("M1 pre-check: the fuzzy rule matches WORDS, not letters (the site has a customer named “A”)", () => {
  // MEASURED on the real site 2026-09-24: it has a customer literally named "A".
  // The first fuzzy rule was a raw substring test, and `"khách test app m1".includes("a")`
  // is true (the "a" inside "app"), so EVERY create was refused with
  // CC_FUZZY_MATCH — the whole feature was dead on the site it was built for.
  const rows = [{ name: "A", customer_name: "A", mobile_no: null, tax_id: null }];
  assert.equal(
    findCustomerCollision(rows, { customer_name: "Khách Test App M1" }),
    null,
    "a one-letter existing name must not match a name that merely contains that letter",
  );
  assert.equal(findCustomerCollision(rows, { customer_name: "Minh Phát A" })?.kind, "fuzzy");
  // …and a name that really USES the word still refuses (the guard is narrower,
  // not dead).
  const hit = findCustomerCollision(rows, { customer_name: "Khách A" });
  assert.equal(hit?.kind, "fuzzy");
  assert.equal(hit?.code, "CC_FUZZY_MATCH");
  assert.equal(hit?.existing.name, "A");
});

test("M1 builder: a duplicate REFUSES and names the existing customer (never clones)", async () => {
  const skills = fakeSkills();
  await refusal(
    buildCustomerCreateProposal(skills, { name: "Nguyễn Thị Lan" }),
    "CC_DUPLICATE_NAME",
  );
  // The refusal carries the id so the answer/card can say WHICH customer it is.
  await assert.rejects(
    () => buildCustomerCreateProposal(skills, { name: "Nguyễn Thị Lan" }),
    (err) => {
      assert.equal(err.existing_id, "CUST-00001");
      assert.match(err.message, /ĐÃ CÓ trên ERPNext/);
      return true;
    },
  );
  assert.equal(skills.spy.writes, 0, "a pre-check refusal writes nothing");
});

test("M1 builder: an unknown name yields a HIGH offer card and ZERO writes", async () => {
  const skills = fakeSkills();
  const { proposal, warnings, action_id } = await withoutProfileEnv(() =>
    buildCustomerCreateProposal(skills, {
      name: "  Nguyễn   Văn Tèo ",
      mobile: " 0901234567 ",
    }),
  );

  assert.equal(skills.spy.writes, 0, "the builder must never write");
  assert.equal(skills.spy.reads, 1, "one master-list read is the whole pre-check");

  assert.equal(proposal.action, "create_customer");
  assert.equal(proposal.risk, "HIGH");
  assert.equal(proposal.need_confirm, true);
  assert.equal(proposal.entity.kind, "customer");
  // No ERPNext id exists yet: the entity id IS the business key.
  assert.equal(proposal.entity.id, "Nguyễn Văn Tèo");
  assert.equal(proposal.params.customer_name, "Nguyễn Văn Tèo");
  assert.equal(proposal.params.mobile_no, "0901234567");
  assert.equal(proposal.params.submit_now, undefined, "master data has nothing to submit");
  assert.equal(typeof action_id, "string");
  // M1-site: the ONLY warning here is the classification one (two leaf groups,
  // none configured). The contact-pair warning must NOT be present — a contact
  // field was given.
  assert.equal(warnings.some((w) => /SĐT\/MST/.test(w)), false, JSON.stringify(warnings));
  assert.equal(warnings.some((w) => /customer_group/.test(w)), true, JSON.stringify(warnings));
});

test("M1 builder: no SĐT/MST is a WARNING, not a block (policy §5 default)", async () => {
  const { proposal, warnings } = await withoutProfileEnv(() =>
    buildCustomerCreateProposal(fakeSkills(), { name: "Nguyễn Văn Tèo" }),
  );
  assert.equal(warnings.filter((w) => /SĐT\/MST/.test(w)).length, 1, JSON.stringify(warnings));
  assert.match(warnings.find((w) => /SĐT\/MST/.test(w)), /SĐT\/MST/);
  // Still proposable: the shop must never be stuck at the counter.
  assert.equal(proposal.params.customer_name, "Nguyễn Văn Tèo");
  assert.equal(proposal.params.mobile_no, undefined);
});

test("M1 builder: a sentence without a name refuses CC_NAME_MISSING", async () => {
  await refusal(buildCustomerCreateProposal(fakeSkills(), { name: "   " }), "CC_NAME_MISSING");
});

test("M1 payload: the correlation field carries the action id (the only server-side dedup)", () => {
  const data = buildCustomerCreateData({
    name: "Nguyễn Văn Tèo",
    mobile: "0901234567",
    tax: null,
    actionId: "act-1",
    correlation: "custom_ai_action_id",
  });
  assert.equal(data.doctype, "Customer");
  assert.equal(data.customer_name, "Nguyễn Văn Tèo");
  assert.equal(data.mobile_no, "0901234567");
  assert.equal(data.tax_id, undefined, "an absent slot must not be sent as an empty string");
  assert.equal(data.custom_ai_action_id, "act-1");
  // M1-site: with no resolved classification the payload carries NONE of the
  // three keys. This is the guard against a literal coming back: `customer_group:
  // "Múa"` was a group the real site never had, so every create died with
  // LinkValidationError.
  assert.equal(data.customer_group, undefined);
  assert.equal(data.territory, undefined);
  assert.equal(data.customer_type, undefined);
  assert.equal(JSON.stringify(data).includes("Múa"), false, "no hardcoded group may reappear");
});

/* -------------------------------------------- 2b. classification (M1-site) -- */

/*
 * The failure this whole section defends against, in one line: the first
 * version hardcoded `customer_group: "Múa"`, a group the real site never had,
 * so the ONE thing this feature does could not be done on the site it was
 * built for. The mock used to accept any group string, which is why no test
 * saw it — so the mock now validates Links like ERPNext and the tests below
 * pin every branch of the resolution order.
 */

test("M1-site: the classification is read from the SITE, not assumed (site default wins when nothing else is set)", async () => {
  const { values, sources, warnings } = await withoutProfileEnv(async () => {
    const masters = await readProfileMasters(fakeSkills());
    return resolveProfileValues(masters, {}, {});
  });
  // `customer_type` is reqd with its own default ⇒ the site's own declaration
  // is the value (nobody had to configure anything).
  assert.equal(values.customer_type, "Company");
  assert.equal(sources.customer_type, "site_default");
  // Two leaves ⇒ no safe pick for customer_group, and it is NOT required ⇒
  // left EMPTY, with a warning that names how to configure it. A guess here is
  // a wrong report; null is honest.
  assert.equal(values.customer_group, undefined);
  assert.match(warnings.join(" "), /customer_group/);
  assert.match(warnings.join(" "), /COPILOT_DEFAULT_CUSTOMER_GROUP/);
  // One leaf ⇒ the site has answered unambiguously.
  const single = await readProfileMasters(
    fakeSkills(ROWS, { groups: [{ name: "Enterprise", is_group: 0 }], territories: [{ name: "Vietnam", is_group: 0 }] }),
  );
  const only = resolveProfileValues(single, {}, {});
  assert.equal(only.values.customer_group, "Enterprise");
  assert.equal(only.sources.customer_group, "site_only_leaf");
  assert.equal(only.values.territory, "Vietnam");
});

test("M1-site: the user's own choice wins, then the operator's env default", async () => {
  const masters = await readProfileMasters(fakeSkills());
  // The app's form value beats everything (it is a choice among EXISTING values).
  const picked = resolveProfileValues(masters, { customer_group: "Commercial" }, { COPILOT_DEFAULT_CUSTOMER_GROUP: "Individual" });
  assert.equal(picked.values.customer_group, "Commercial");
  assert.equal(picked.sources.customer_group, "user");
  // With no pick, the declared env default applies.
  const fromEnv = resolveProfileValues(masters, {}, { COPILOT_DEFAULT_CUSTOMER_GROUP: "Individual" });
  assert.equal(fromEnv.values.customer_group, "Individual");
  assert.equal(fromEnv.sources.customer_group, "env");
});

test("M1-site: a configured value the site does NOT have is a REFUSAL (a typo must be loud)", async () => {
  const masters = await readProfileMasters(fakeSkills());
  // This is the original bug, expressed as configuration: "Múa" does not exist.
  await refusal(
    Promise.resolve().then(() => resolveProfileValues(masters, {}, { COPILOT_DEFAULT_CUSTOMER_GROUP: "Múa" })),
    "CC_PROFILE_INVALID",
  );
  await refusal(
    Promise.resolve().then(() => resolveProfileValues(masters, { customer_group: "Múa" }, {})),
    "CC_PROFILE_INVALID",
  );
  // A Select outside the site's own options is refused the same way.
  await refusal(
    Promise.resolve().then(() => resolveProfileValues(masters, {}, { COPILOT_DEFAULT_CUSTOMER_TYPE: "Cong ty" })),
    "CC_PROFILE_INVALID",
  );
});

test("M1-site: a REQUIRED field with no safe value REFUSES; an optional one is left empty", async () => {
  // The site makes customer_group mandatory and offers two leaves: nothing may
  // be invented, so the create stops at the card with an actionable message.
  const masters = await readProfileMasters(
    fakeSkills(ROWS, {
      fields: DOCFIELD_ROWS.map((f) => (f.fieldname === "customer_group" ? { ...f, reqd: 1 } : f)),
    }),
  );
  await refusal(
    Promise.resolve().then(() => resolveProfileValues(masters, {}, {})),
    "CC_PROFILE_REQUIRED",
  );
});

test("M1-site: the card and the execute payload carry the RESOLVED classification", async () => {
  const built = await withoutProfileEnv(() =>
    buildCustomerCreateProposal(fakeSkills(), { name: "Nguyễn Văn Tèo", mobile: "0901234567" }),
  );
  // The proposal carries what WILL be sent (so the executor re-validates the
  // same values the user saw) and the source of each one.
  assert.equal(built.proposal.params.customer_type, "Company");
  assert.equal(built.proposal.params.customer_group, undefined);
  // (`extra` is spread onto the proposal itself — `warnings`, `profile` and
  // `action_id` are top-level keys, not nested under `extra`.)
  assert.equal(built.proposal.profile.sources.customer_type, "site_default");
  const data = buildCustomerCreateData({
    name: "Nguyễn Văn Tèo",
    profile: built.proposal.profile.values,
    actionId: "act-2",
    correlation: "custom_ai_action_id",
  });
  assert.equal(data.customer_type, "Company");
});

test("M1-site: the pre-check reads the WHOLE master, not one page", async () => {
  const calls = [];
  const fakeMcp = {
    callTool: async (tool, args) => {
      calls.push([tool, args]);
      return { data: { data: [] } };
    },
  };
  await listCustomers(fakeMcp);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "erpnext_customer_list");
  // MEASURED on the real site: 123 customers and a 100-row read let a card be
  // built for a customer that already existed (row 122). `limit: 0` is Frappe's
  // "no limit" — and the pinned tool offers no offset, so there is no page two.
  assert.equal(
    calls[0][1].limit,
    0,
    "a page size makes the duplicate check silently blind past that row",
  );
});

test("M1-site regression: the mock now REFUSES what the real site refused (the original bug is visible)", async () => {
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    // This is the EXACT failure the first version shipped: the group does not
    // exist on the site. The mock used to accept any string, which is why no
    // test could see it — now the mock mirrors ERPNext's own link validation.
    await assert.rejects(
      () =>
        client.callWriteTool("erpnext_doc_create", {
          doctype: "Customer",
          data: { customer_name: "Khách Múa", customer_group: "Múa" },
        }),
      /LinkValidationError: Could not find Customer Group: Múa/,
    );
    // A Select outside the site's own options is refused the same way…
    await assert.rejects(
      () =>
        client.callWriteTool("erpnext_doc_create", {
          doctype: "Customer",
          data: { customer_name: "Khách Sai Loại", customer_type: "Công ty" },
        }),
      /not a valid value for customer_type/,
    );
    // …while a payload with no classification at all is ACCEPTED, and the site
    // fills its own default for the reqd field (so "we could not resolve it"
    // never blocks a counter sale).
    const ok = await client.callWriteTool("erpnext_doc_create", {
      doctype: "Customer",
      data: { customer_name: "Khách Chưa Phân Loại" },
    });
    const created = ok?.data?.data ?? ok?.data ?? {};
    assert.equal(created.customer_type, "Company", "the site's own default fills the reqd Select");
    assert.equal(created.customer_group, null, "an omitted optional Link stays null, never invented");
  } finally {
    await client.close().catch(() => {});
  }
});

test("M1-site: an ERPNext that cannot be classified at all refuses instead of guessing", async () => {
  const built = await withoutProfileEnv(() =>
    buildCustomerCreateProposal(fakeSkills(ROWS, { fields: [] }), { name: "Nguyễn Văn Tèo" }),
  );
  // No DocField answers ⇒ no Select options ⇒ the reqd-ness is unknown. Omitting
  // a field ERPNext may not require is safe (the site applies its own default),
  // so this must still be proposable — but it must NOT invent a value.
  assert.equal(built.proposal.params.customer_type, undefined);
  // A read that FAILS is a different fact from "the site has none": refuse.
  await refusal(
    buildCustomerCreateProposal(
      {
        listCustomers: async () => ({ data: { data: ROWS } }),
        listCustomerGroups: async () => {
          throw new Error("boom");
        },
        listTerritories: async () => ({ data: { data: TERRITORY_ROWS } }),
        listCustomerFieldSpecs: async () => ({ data: { data: DOCFIELD_ROWS } }),
      },
      { name: "Nguyễn Văn Tèo" },
    ),
    "ERP_UNAVAILABLE",
  );
});

/* ------------------------------------------------------------- 3. routing -- */

test("M1 routing: the CREATE command reaches customer_create_write; a debt QUESTION stays a read", () => {
  for (const text of ["thêm khách Nguyễn Văn Tèo", "tạo khách Nguyễn Văn Tèo", "khách mới Nguyễn Văn Tèo"]) {
    const route = routeIntent(text);
    assert.equal(route?.group, "customer_create_write", text);
    assert.equal(route?.capability, "customer.create", text);
  }
  // The group declares startsWith + notIf, and notIf is only consulted when
  // startsWith is set — so killing startsWith would let a question open a card.
  const read = routeIntent("công nợ của Nguyễn Thị Lan");
  assert.notEqual(read?.group, "customer_create_write");
  assert.notEqual(read?.capability, "customer.create");
});

/* ------------------------------------------------- 4. execute + the mock --- */

/** Strip ERPNEXT_* so the child always talks to the in-memory mock. */
const MOCK_ENV = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^ERPNEXT_/.test(k)));

/** Read the mock's persisted rows (absent file ⇒ the mock never wrote). */
function stateRows(key) {
  const file = process.env.MOCK_ERP_STATE;
  if (!file || !existsSync(file)) return [];
  try {
    return JSON.parse(readFileSync(file, "utf8"))[key] ?? [];
  } catch {
    return [];
  }
}

test("M1 execute: a confirmed create writes ONE real record, and reads it back", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "m1-cc-"));
  const prevState = process.env.MOCK_ERP_STATE;
  process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    const built = await (async () => {
      // Build through the SKILL against the live mock list, exactly like the
      // server does — so the pre-check reads the same master table the execute
      // re-read will.
      const skills = {
        listCustomers: async () => client.callTool("erpnext_customer_list", { limit: 100 }),
        // The real classification reads, against the mock's own masters — so
        // this test also proves the mock answers Customer Group / Territory /
        // DocField the way the real `erpnext_doc_list` does.
        ...profileReads(client),
      };
      return withoutProfileEnv(() => buildCustomerCreateProposal(skills, { name: "Nguyễn Văn Tèo", mobile: "0901234567" }));
    })();

    const store = { ref: null, done: null, setReference(_c, r) { this.ref = r; }, complete(_c, r) { this.done = r; } };
    const result = await executeCustomerCreateProposal(
      client,
      built.proposal,
      "cmd-m1-1",
      store,
    );

    assert.match(result.erpnext_doc, /^CUST-M001$/);
    assert.equal(result.customer_name, "Nguyễn Văn Tèo");
    assert.equal(result.mobile_no, "0901234567");
    assert.match(result.note, /record THẬT/);
    assert.match(result.note, /KHÔNG tự động tạo đơn\/phiếu thu/);

    const rows = stateRows("customers_created");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].docstatus, 0, "Customer is master data — never submits");
    assert.equal(rows[0].mobile_no, "0901234567");
    assert.equal(rows[0].custom_ai_action_id, built.proposal.action_id);
    assert.equal(store.done.erpnext_doc, "CUST-M001", "the command is completed with the real id");
  } finally {
    await client.close().catch(() => {});
    if (prevState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = prevState;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M1-site execute: the resolved classification reaches the ERPNext payload and is verified back", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "m1-cc-profile-"));
  const prevState = process.env.MOCK_ERP_STATE;
  process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
  process.env.COPILOT_DEFAULT_CUSTOMER_GROUP = "Commercial";
  process.env.COPILOT_DEFAULT_TERRITORY = "Vietnam";
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    const skills = {
      listCustomers: async () => client.callTool("erpnext_customer_list", { limit: 100 }),
      ...profileReads(client),
    };
    const built = await buildCustomerCreateProposal(skills, { name: "Nguyễn Văn Tèo" });
    assert.equal(built.proposal.params.customer_group, "Commercial");
    assert.equal(built.proposal.profile.sources.customer_group, "env");

    const store = { ref: null, done: null, setReference(_c, r) { this.ref = r; }, complete(_c, r) { this.done = r; } };
    const result = await executeCustomerCreateProposal(client, built.proposal, "cmd-m1-profile", store);

    // What ERPNext actually stored — not what we hoped.
    const rows = stateRows("customers_created");
    assert.equal(rows.length, 1);
    assert.equal(rows[0].customer_group, "Commercial", "the resolved group is what the site receives");
    assert.equal(rows[0].territory, "Vietnam");
    assert.equal(rows[0].customer_type, "Company");
    assert.equal(result.customer_group, "Commercial");
    // At EXECUTE the value arrives inside `params`, so it is validated as a
    // request-supplied candidate (source "user") — the env attribution belongs
    // to the ASK-time resolution asserted above. Both paths run the same
    // validation against the live site; the label only says where it came from.
    assert.equal(result.profile_sources.customer_group, "user");
  } finally {
    await client.close().catch(() => {});
    if (prevState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = prevState;
    delete process.env.COPILOT_DEFAULT_CUSTOMER_GROUP;
    delete process.env.COPILOT_DEFAULT_TERRITORY;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M1 execute: no correlation field ⇒ NO write at all (fail closed)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "m1-cc-nofield-"));
  const prevState = process.env.MOCK_ERP_STATE;
  const prevKnob = process.env.MOCK_ERP_CC_NO_CORRELATION_FIELD;
  process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
  process.env.MOCK_ERP_CC_NO_CORRELATION_FIELD = "1";
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    const built = await withoutProfileEnv(() =>
      buildCustomerCreateProposal(
        {
          listCustomers: async () => client.callTool("erpnext_customer_list", { limit: 100 }),
          ...profileReads(client),
        },
        { name: "Nguyễn Văn Tèo" },
      ),
    );
    await refusal(
      executeCustomerCreateProposal(client, built.proposal, "cmd-m1-nofield", {
        setReference() {},
        complete() {},
      }),
      "CC_CORRELATION_FIELD_MISSING",
    );
    // The whole point: the site cannot dedupe this doctype, so nothing is written.
    assert.equal(stateRows("customers_created").length, 0);
  } finally {
    await client.close().catch(() => {});
    if (prevState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = prevState;
    if (prevKnob === undefined) delete process.env.MOCK_ERP_CC_NO_CORRELATION_FIELD;
    else process.env.MOCK_ERP_CC_NO_CORRELATION_FIELD = prevKnob;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("M1 execute: a customer that appeared between card and confirm REFUSES (no clone)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "m1-cc-drift-"));
  const prevState = process.env.MOCK_ERP_STATE;
  process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
  const client = createMcpClient({ serverScript: MOCK_SERVER });
  try {
    // The card was built for a name that did NOT exist...
    const built = await withoutProfileEnv(() =>
      buildCustomerCreateProposal(
        { listCustomers: async () => ({ data: { data: [] } }), ...fakeProfileReads() },
        { name: "Nguyễn Thị Lan" },
      ),
    );
    // ...and by confirm time the site has that customer (created at the desk).
    await refusal(
      executeCustomerCreateProposal(client, built.proposal, "cmd-m1-drift", {
        setReference() {},
        complete() {},
      }),
      "CC_DUPLICATE_NAME",
    );
    assert.equal(stateRows("customers_created").length, 0, "the re-read is what prevents the clone");
  } finally {
    await client.close().catch(() => {});
    if (prevState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = prevState;
    rmSync(dir, { recursive: true, force: true });
  }
});

/* -------------------------------------------- 5. HTTP /execute end-to-end -- */

/**
 * Run the FULL write path (/execute over HTTP → Safety Gateway → executor →
 * mock ERPNext). Mirrors the payment/delivery/SO harness so all write paths are
 * exercised identically.
 */
async function withExecuteServer(fn, extraEnv = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), "m1-cc-http-"));
  const prevState = process.env.MOCK_ERP_STATE;
  const prevExtra = {};
  process.env.MOCK_ERP_STATE = path.join(dir, "mock-erp.json");
  for (const [k, v] of Object.entries(extraEnv)) {
    prevExtra[k] = process.env[k];
    process.env[k] = v;
  }
  let server = null;
  try {
    const { createAskServer } = await import("../src/http-ask.mjs");
    const { IdempotencyStore } = await import("../src/idempotency.mjs");
    const store = new IdempotencyStore(dir);
    server = createAskServer({ port: 0, host: "127.0.0.1", idemStore: store });
    const port = await new Promise((res, rej) => {
      server.once("error", rej);
      server.listen(0, "127.0.0.1", () => res(server.address().port));
    });
    const base = `http://127.0.0.1:${port}`;
    const post = async (body, p = "/execute") => {
      const r = await fetch(`${base}${p}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      return { status: r.status, body: await r.json() };
    };
    const built = await withoutProfileEnv(() =>
      buildCustomerCreateProposal(
        { listCustomers: async () => ({ data: { data: ROWS } }), ...fakeProfileReads() },
        { name: "Nguyễn Văn Tèo", mobile: "0901234567" },
      ),
    );
    return await fn({ post, store, proposal: built.proposal });
  } finally {
    server?.close();
    if (prevState === undefined) delete process.env.MOCK_ERP_STATE;
    else process.env.MOCK_ERP_STATE = prevState;
    for (const [k, v] of Object.entries(prevExtra)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

test("M1 HTTP /execute: a confirmed create writes ONE record; a replay writes nothing more", async () => {
  await withExecuteServer(async ({ post, proposal, store }) => {
    const cid = randomUUID();
    const first = await post({ command_id: cid, proposal });
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(first.body.replay, false);
    assert.equal(first.body.result.erpnext_doc, "CUST-M001");
    assert.equal(stateRows("customers_created").length, 1);

    const again = await post({ command_id: cid, proposal });
    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.replay, true);
    assert.equal(again.body.result.erpnext_doc, "CUST-M001");
    assert.equal(stateRows("customers_created").length, 1, "one command ⇒ one record");
    assert.equal(store.status(cid).status, "COMPLETED");
  });
});

test("M1 HTTP /execute: an UNCONFIRMED offer writes nothing (no request ⇒ no record)", async () => {
  await withExecuteServer(async () => {
    // Nothing is posted: this is the checklist's A2 / D2 case — the offer was
    // shown, the user did not press.
    assert.equal(stateRows("customers_created").length, 0);
  });
});

test("M1 HTTP /execute: without the correlation field the gateway answers 500 and writes nothing", async () => {
  await withExecuteServer(
    async ({ post, proposal }) => {
      const r = await post({ command_id: randomUUID(), proposal });
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(r.body.code, "CC_CORRELATION_FIELD_MISSING");
      assert.equal(stateRows("customers_created").length, 0);
    },
    { MOCK_ERP_CC_NO_CORRELATION_FIELD: "1" },
  );
});

/* ------------------------------------------------- 6. end-to-end pipeline -- */

async function startNlpService() {
  const child = spawn("python3", ["-m", "nlp_service.server", "--port", "0"], {
    cwd: path.join(REPO),
    stdio: ["ignore", "pipe", "inherit"],
  });
  const port = await new Promise((resolve, reject) => {
    child.stdout.on("data", (d) => {
      const m = String(d).match(/"port":\s*(\d+)/);
      if (m) resolve(Number(m[1]));
    });
    child.on("exit", (code) => reject(new Error(`nlp service exited early (${code})`)));
    setTimeout(() => reject(new Error("nlp service: no ready line in 5s")), 5000);
  });
  return { child, port };
}

function startCopilot(port, extraEnv = {}) {
  const child = spawn(process.execPath, [path.join(REPO, "mcp-erpnext", "src", "copilot-server.mjs")], {
    env: { ...MOCK_ENV, NLP_SERVICE_PORT: String(port), ...extraEnv },
    stdio: ["pipe", "pipe", "inherit"],
  });
  const pending = new Map();
  let nextId = 1;
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString();
    let nl;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      let msg;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      const entry = pending.get(msg.id);
      if (!entry) continue;
      pending.delete(msg.id);
      if (msg.error) entry.reject(new Error(`MCP_ERROR ${msg.error.code}: ${msg.error.message}`));
      else entry.resolve(msg.result);
    }
  });
  const request = (method, params) => {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  };
  return {
    child,
    request,
    async call(text, extraArgs = {}) {
      const res = await request("tools/call", { name: "copilot_ask", arguments: { text, ...extraArgs } });
      assert.equal(res.isError, undefined, `tool error: ${res.content?.[0]?.text}`);
      return res.structuredContent ?? JSON.parse(res.content[0].text);
    },
    async close() {
      child.stdin.end();
      await new Promise((r) => child.once("exit", r));
    },
  };
}

test("M1 E2E /ask: “thêm khách <mới>” returns a HIGH card + the offer, and writes nothing", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("thêm khách Nguyễn Văn Tèo");
    assert.equal(out.routed.group, "customer_create_write", JSON.stringify(out.routed));
    assert.equal(out.proposal?.action, "create_customer", JSON.stringify(out.proposal));
    assert.equal(out.proposal.risk, "HIGH");
    assert.equal(out.proposal.need_confirm, true);
    assert.equal(out.proposal.params.customer_name, "Nguyễn Văn Tèo");
    assert.equal(out.offer_create_customer?.name, "Nguyễn Văn Tèo");
    // Asking is not writing.
    assert.equal(Object.prototype.hasOwnProperty.call(out, "erpnext_doc"), false, JSON.stringify(out.erpnext_doc));
    assert.match(out.answer, /record thật/i);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("M1 E2E /ask: a name that ALREADY exists is an ANSWER (no card), naming the customer", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("thêm khách Nguyễn Thị Lan");
    assert.equal(out.proposal, null, JSON.stringify(out.proposal));
    assert.ok(String(out.reason ?? "").length > 0, "a refusal must explain itself");
    assert.match(out.reason, /ĐÃ CÓ trên ERPNext/);
    assert.equal(out.existing_customer?.id, "CUST-00001");
    assert.match(out.error_code, /CC_/);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("M1 E2E /ask: a WRITE about an unknown customer offers to create one; a READ does NOT", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port);
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });

    // D1: the write cannot settle a party ⇒ MISSING_ENTITY + the structured
    // offer. No card, because there is nothing to confirm yet.
    const write = await copilot.call("thu tiền Nguyễn Văn Tèo 500 nghìn");
    assert.equal(write.error_code, "MISSING_ENTITY", JSON.stringify(write));
    assert.equal(write.proposal, null);
    assert.ok(write.offer_create_customer, JSON.stringify(write.offer_create_customer));
    assert.ok(String(write.offer_create_customer.name ?? "").length > 0);

    // D4: a READ must stay an answer — offering to create on a debt question
    // would invite a record the user never asked for.
    const read = await copilot.call("công nợ của Nguyễn Văn Tèo");
    assert.notEqual(read.routed?.group, "customer_create_write", JSON.stringify(read.routed));
    assert.equal(read.offer_create_customer, undefined, JSON.stringify(read.offer_create_customer));
    assert.equal(read.proposal, null);
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

test("M1 safety: in the read-only AI mode (dsh) a create-customer command is BLOCKED before any skill runs", async () => {
  const nlp = await startNlpService();
  const copilot = startCopilot(nlp.port, { COPILOT_DSH_CONTEXT: "1" });
  try {
    await copilot.request("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "0" } });
    const out = await copilot.call("thêm khách Nguyễn Văn Tèo");
    assert.equal(out.error_code, "DSH_WRITE_BLOCKED", JSON.stringify(out));
    assert.equal(out.proposal, null, "the read-only mode never produces a write card");
    // The READ path in the same process is untouched.
    const read = await copilot.call("Nguyễn Thị Lan còn nợ bao nhiêu");
    assert.equal(read.customer?.id, "CUST-00001", JSON.stringify(read));
  } finally {
    await copilot.close();
    nlp.child.kill();
  }
});

/* ----------------------------------------------------------- 7. regression -- */

test("M1 regression: the nine transaction writes are still executable (M1 added the 10th)", () => {
  const actions = executableWriteActions();
  for (const action of [
    "create_payment_entry",
    "create_sales_order",
    "create_quotation",
    "create_purchase_order",
    "create_delivery_note",
    "create_purchase_receipt",
    "create_sales_invoice",
    "create_stock_adjustment",
    "create_sales_return",
    "create_customer",
  ]) {
    assert.ok(actions.includes(action), `${action} must stay executable`);
  }
  assert.equal(actions.length, 10, `unexpected action set: ${actions.join(", ")}`);
});
