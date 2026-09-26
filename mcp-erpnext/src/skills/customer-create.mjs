/**
 * Skill: customer.create WRITE (M1 — tạo khách mới bằng nút cho phép).
 *
 * Master data, not a transaction: ERPNext Customer has NO draft state (docstatus
 * is fixed at 0 and never submits), so the whole safety story lives in TWO
 * places — the HIGH confirm button (the proposal stops at the card) and the
 * BUSINESS KEY pre-check (a duplicate name/mobile/tax id must never clone).
 *
 * Policy defaults (M1 spec §5, user has not overridden):
 *   - customer_name REQUIRED; mobile_no / tax_id are the optional contact pair
 *   - a duplicate business key REFUSES creation and names the existing customer
 *     (never silently reuses it — the user decides on the real site or in chat)
 *   - a FUZZY name match refuses too: a new customer may not borrow the
 *     near-identity of an existing one ("Lan" vs "Nguyễn Thị Lan" is a
 *     different person until the user says otherwise)
 *   - created as a REAL record after the user confirms the card (no draft)
 *   - NO auto follow-up: the result carries the id; the next sentence decides
 *
 * This is the FIRST write whose entity does not exist yet, so `entity.id` is a
 * business key (the normalized name), NOT an ERPNext id — ERPNext assigns the
 * real id (CUST-xxxx) at create time. Everything downstream reads it back.
 *
 * ── M1-site (2026-09-24): NO HARDCODED CLASSIFICATION ──────────────────────
 * The first version shipped `customer_group: "Múa"` + `customer_type:
 * "Individual"` as literals. MEASURED on the real site: there is no Customer
 * Group called "Múa" (the site's leaf groups are Commercial, Hộ nhỏ, Individual,
 * Trại lớn, Trại vừa, Đại lý cấp 2, Government, Non Profit), so EVERY create
 * died with `LinkValidationError` — the feature could not work on the site it
 * was built for, and no mock test could see it because the mock happily accepted
 * any group string. The classification is therefore RESOLVED from data, in this
 * order, per field (declared in `field_policy.profile`):
 *
 *   1. the user's own choice (params from the app), validated against the site
 *   2. the operator's environment default (`COPILOT_DEFAULT_*`)
 *   3. what the SITE declares: the only leaf ⇒ that leaf; a Select's own default
 *   4. otherwise ⇒ REFUSE when the field is required, leave it EMPTY when it is
 *      not (a null classification is honest; a guessed group is a wrong report)
 *
 * A value coming from (1) or (2) that the site does not have is a REFUSAL, never
 * a silent fallback: a typo in an environment variable must be loud, and a
 * client may pick among existing groups but may not invent one.
 */

import { assertReadOnly } from "../readonly-guard.mjs";
import { buildProposal } from "../action-proposal.mjs";
import { getCapability } from "../capability-contract.mjs";
import { classifyDriftCode } from "../proposal-freshness.mjs";
// docOf/rowsOf are the SHARED unwrappers of a tool result. The client wraps
// every result as {__untrusted, source, data: <handler payload>} and the handler
// payload nests again (`{data: rows}`); hand-rolling the unwrap here (one level
// instead of two) made the read-back see `undefined` for every field — the
// created customer was real, but verify reported CC_WRITE_UNVERIFIED on it and
// the command stayed PENDING. Found by the M1 suite, 2026-09-24: the skill was
// the only one in the repo not using these helpers.
import { docOf, newActionId, refuse, rowsOf } from "./sales-order-write.mjs";

/** The ONE doctype this skill may create (master data). */
export const WRITE_DOCTYPE = "Customer";

/** The capability that owns this skill — policy is read THROUGH the contract. */
export const CAPABILITY_ID = "customer.create";

/** The code prefix for every refusal this path can emit (contract taxonomy). */
const CODE_PREFIX = "CC_";

/** Contract policy block, read per call (a missing block is a hard bug). */
function policies() {
  const cap = getCapability(CAPABILITY_ID);
  if (!cap) throw new Error("CC_CONTRACT_MISSING: customer.create is not in the capability contract");
  return { cap, field: cap.field_policy };
}

/**
 * The duplicate stance, read from the contract rather than hardcoded. The ONLY
 * stance this skill implements is refuse-and-name-the-existing: a contract that
 * stops saying so is not "create anyway" — it is a refusal (fail closed, same
 * shape as the P9-F entry_type guard).
 */
function duplicateStance() {
  const declared = policies().field?.duplicate ?? null;
  if (declared !== "refuse_return_existing") {
    throw refuse(
      `${CODE_PREFIX}PURPOSE_UNSUPPORTED`,
      declared === null
        ? "contract chưa khai field_policy.duplicate cho customer.create — không tạo master data khi CHÍNH SÁCH trùng chưa được tuyên bố (M1, fail closed)"
        : `contract khai field_policy.duplicate="${declared}" nhưng skill chỉ hỗ trợ "refuse_return_existing" (M1)`,
    );
  }
  return declared;
}

/**
 * What a created customer IS, read from the contract. Customer has no draft —
 * a contract declaring something else describes a document ERPNext does not
 * have, and the guard must not pretend it was honoured.
 */
function createdAs() {
  const declared = policies().field?.created_as ?? null;
  if (declared !== "active_record") {
    throw refuse(
      `${CODE_PREFIX}PURPOSE_UNSUPPORTED`,
      declared === null
        ? "contract chưa khai field_policy.created_as cho customer.create — không tạo master data khi TRẠNG THÁI tạo chưa được tuyên bố (M1, fail closed)"
        : `contract khai field_policy.created_as="${declared}" nhưng Customer chỉ có trạng thái record thật ("active_record") (M1)`,
    );
  }
  return declared;
}

/**
 * The classification fields and where each one's default may come from, read
 * from the contract (`field_policy.profile.fields`). The shape is the policy:
 * a field with `link` is validated against that doctype's LEAVES; a field with
 * `select_of` is validated against that doctype's own DocField options. A
 * contract that stops declaring the block is a refusal, not "send nothing" —
 * sending nothing by accident is exactly how a site ends up with unclassified
 * master data nobody can report on.
 */
function profileSpec() {
  const fields = policies().field?.profile?.fields ?? null;
  if (!fields || typeof fields !== "object" || Object.keys(fields).length === 0) {
    throw refuse(
      `${CODE_PREFIX}PURPOSE_UNSUPPORTED`,
      "contract chưa khai field_policy.profile.fields cho customer.create — không tạo Customer khi CHƯA biết field phân loại nào sẽ gửi và lấy default từ đâu (M1-site, fail closed)",
    );
  }
  return fields;
}

/* ------------------------------------------------------------- reads ------ */

/**
 * Guarded read: the WHOLE customer master list (the pre-check works off it).
 *
 * `limit: 0` — not a page size. MEASURED on the real site 2026-09-24: the site
 * had 123 customers, this read asked for 100, and `/ask "thêm khách Khách lẻ
 * Minh Phát"` happily built a HIGH card for a customer that EXISTS (row 122 of
 * 123) — pressing it would have created a second master and split that shop's
 * receivable, which is the exact harm this skill exists to prevent. In Frappe,
 * `limit_page_length=0` means "no limit"; measured end-to-end through the pinned
 * tool: `limit=20 → 20 rows`, `limit=100 → 100`, `limit=0 → all 123`.
 *
 * Deliberately unbounded rather than paginated: the tool exposes `limit` but NO
 * offset (verified in the pinned package source), so there is no second page to
 * ask for. A truncated master read makes the duplicate check silently wrong,
 * which is worse than a bigger read.
 */
export async function listCustomers(mcp) {
  assertReadOnly("erpnext_customer_list");
  return mcp.callTool("erpnext_customer_list", { limit: 0 });
}

/** Guarded read: one Customer document (the executor's read-back). */
export async function getCustomerDoc(mcp, name) {
  assertReadOnly("erpnext_customer_get");
  return mcp.callTool("erpnext_customer_get", { name: String(name) });
}

/**
 * Guarded read: the Customer Group master. Only LEAVES may be sent on a
 * document — ERPNext rejects a group node (`is_group = 1`) the way Desk does.
 */
export async function listCustomerGroups(mcp) {
  assertReadOnly("erpnext_doc_list");
  return mcp.callTool("erpnext_doc_list", {
    doctype: "Customer Group",
    fields: ["name", "is_group", "parent_customer_group"],
    limit: 200,
  });
}

/** Guarded read: the Territory master (same leaf rule as Customer Group). */
export async function listTerritories(mcp) {
  assertReadOnly("erpnext_doc_list");
  return mcp.callTool("erpnext_doc_list", {
    doctype: "Territory",
    fields: ["name", "is_group", "parent_territory"],
    limit: 200,
  });
}

/**
 * Guarded read: the DocField definitions of Customer. This is where the site
 * states, on the record, which classification fields are REQUIRED and, for a
 * Select, which values are legal + which one it defaults to. Reading the rule
 * from the site (instead of restating it here) is what keeps "the site's own
 * default" from drifting away from the site.
 */
export async function listCustomerFieldSpecs(mcp) {
  assertReadOnly("erpnext_doc_list");
  return mcp.callTool("erpnext_doc_list", {
    doctype: "DocField",
    filters: [["parent", "=", "Customer"]],
    fields: ["fieldname", "fieldtype", "options", "default", "reqd"],
    limit: 200,
  });
}

/** The three reads the profile resolver needs, bound to one client. */
export function profileReads(mcp) {
  return {
    listCustomerGroups: () => listCustomerGroups(mcp),
    listTerritories: () => listTerritories(mcp),
    listCustomerFieldSpecs: () => listCustomerFieldSpecs(mcp),
  };
}

/**
 * Reconcile a command against ERPNext — READ ONLY (lost-response retry path).
 * Looks the action id up on the correlation field through the generic list
 * tool, the same way every other write path does.
 */
export async function reconcileCustomer(mcp, reference, { actionId = null } = {}) {
  const field = getCapability(CAPABILITY_ID)?.execution?.correlation_field ?? "custom_ai_action_id";
  const value = actionId ?? reference;
  try {
    const res = await mcp.callTool("erpnext_doc_list", {
      doctype: WRITE_DOCTYPE,
      fields: ["name", "customer_name", "mobile_no", "tax_id", field],
      filters: [[field, "=", value]],
      limit: 5,
    });
    const rows = rowsOf(res);
    return {
      found: rows.length > 0,
      count: rows.length,
      doc: rows[0] ?? null,
      duplicates: rows.length > 1,
      correlation_field: field,
      correlation_field_unavailable: false,
    };
  } catch (err) {
    return {
      found: false,
      count: 0,
      doc: null,
      duplicates: false,
      correlation_field: field,
      correlation_field_unavailable: true,
      error: err?.message ?? String(err),
    };
  }
}

/* ---------------------------------------------------- classification (M1-site) -- */

/**
 * Read the live site's own answers for every declared classification field.
 *
 * One read per source, all in parallel, and each is a READ through the guarded
 * whitelist. A failed read is a refusal (ERP_UNAVAILABLE) rather than an empty
 * list: "the site did not answer" and "the site has no groups" are different
 * facts, and treating the first as the second would silently drop a required
 * classification.
 *
 * @param {{listCustomerGroups: Function, listTerritories: Function, listCustomerFieldSpecs: Function}} reads
 * @returns {Promise<Record<string, {kind:string, labels:string[], leaves?:string[], options?:string[], default?:string|null, reqd:boolean}>>}
 */
export async function readProfileMasters(reads) {
  const spec = profileSpec();
  const needsMaster = Object.values(spec).some((rules) => rules?.link);
  let fieldRows = [];
  let groups = [];
  let territories = [];
  try {
    [fieldRows, groups, territories] = await Promise.all([
      reads.listCustomerFieldSpecs(),
      needsMaster && Object.values(spec).some((r) => r?.link === "Customer Group")
        ? reads.listCustomerGroups()
        : Promise.resolve(null),
      needsMaster && Object.values(spec).some((r) => r?.link === "Territory")
        ? reads.listTerritories()
        : Promise.resolve(null),
    ]);
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được danh mục phân loại khách hàng từ ERPNext: ${err?.message ?? err}`);
  }

  const fieldOf = (name) => rowsOf(fieldRows).find((r) => String(r.fieldname ?? "") === name) ?? null;
  const leavesOf = (res) =>
    rowsOf(res)
      .filter((r) => Number(r.is_group ?? 1) === 0)
      .map((r) => String(r.name ?? "").trim())
      .filter(Boolean);

  const out = {};
  for (const [name, rules] of Object.entries(spec)) {
    const doc = fieldOf(name);
    const reqd = Number(doc?.reqd ?? 0) === 1;
    if (rules?.link) {
      const leaves = rules.link === "Customer Group" ? leavesOf(groups) : leavesOf(territories);
      out[name] = { kind: "link", doctype: rules.link, leaves, options: leaves, reqd };
    } else {
      out[name] = {
        kind: "select",
        doctype: rules?.select_of ?? null,
        options: String(doc?.options ?? "")
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
        default: doc?.default != null && String(doc.default).trim() !== "" ? String(doc.default).trim() : null,
        reqd,
      };
    }
  }
  return out;
}

/**
 * Decide the value to send for every classification field.
 *
 * The order is the contract's policy, not a preference: a value the user picked
 * wins, then the operator's env default, then what the site itself declares. A
 * configured-but-unknown value REFUSES (a typo must be loud). A field that is
 * required and left unresolved REFUSES; an optional one is left EMPTY and
 * reported as a warning (see the header: null is honest, a guess is not).
 *
 * @param {object} masters output of readProfileMasters
 * @param {object} explicit { customer_group?, territory?, customer_type? }
 * @param {object} env environment to read the declared env vars from
 */
export function resolveProfileValues(masters, explicit = {}, env = process.env) {
  const spec = profileSpec();
  const values = {};
  const sources = {};
  const warnings = [];
  const missingRequired = [];

  for (const [name, rules] of Object.entries(spec)) {
    const meta = masters?.[name] ?? {};
    const known =
      meta.kind === "link"
        ? Array.isArray(meta.leaves)
          ? meta.leaves
          : []
        : Array.isArray(meta.options)
          ? meta.options
          : [];
    const envVar = rules?.env ? String(rules.env) : null;

    /** Validate one candidate against the LIVE site; refuse when it is unknown. */
    const pick = (raw, source) => {
      const value = String(raw ?? "").trim();
      if (!value) return null;
      if (!known.includes(value)) {
        throw refuse(
          `${CODE_PREFIX}PROFILE_INVALID`,
          `${source} "${value}" nhưng ERPNext không có giá trị này cho ${name}` +
            (meta.doctype ? ` (${meta.doctype})` : "") +
            (known.length ? ` — các giá trị hợp lệ: ${known.slice(0, 12).join(", ")}` : " — site chưa khai giá trị nào"),
        );
      }
      return value;
    };

    let value = null;
    let source = null;

    // 1. the user's own choice (params from the app) — a client may pick among
    //    EXISTING values, it may not invent one.
    if (explicit?.[name] != null && String(explicit[name]).trim() !== "") {
      value = pick(explicit[name], `app gửi ${name} =`);
      source = "user";
    }
    // 2. the operator's declared default.
    if (!value && envVar && env?.[envVar] != null && String(env[envVar]).trim() !== "") {
      value = pick(env[envVar], `biến ${envVar} khai ${name} =`);
      source = "env";
    }
    // 3. what the SITE itself declares: a Select's own default, or the only
    //    leaf that exists.
    if (!value && meta.kind === "select" && meta.default && known.includes(meta.default)) {
      value = meta.default;
      source = "site_default";
    }
    if (!value && meta.kind === "link" && known.length === 1) {
      value = known[0];
      source = "site_only_leaf";
    }
    // 4. nothing safe.
    if (!value) {
      if (meta.reqd) {
        missingRequired.push({ name, candidates: known, envVar });
      } else {
        warnings.push(
          `${name}: chưa chọn được giá trị an toàn nên sẽ để TRỐNG` +
            (envVar ? ` — đặt ${envVar}` : "") +
            (known.length ? ` hoặc chọn một trong: ${known.slice(0, 12).join(", ")}` : ""),
        );
      }
      continue;
    }
    values[name] = value;
    sources[name] = source;
  }

  if (missingRequired.length > 0) {
    const first = missingRequired[0];
    throw refuse(
      `${CODE_PREFIX}PROFILE_REQUIRED`,
      `ERPNext BẮT BUỘC field ${missingRequired.map((m) => m.name).join(", ")} khi tạo Customer nhưng chưa chọn được giá trị an toàn` +
        (first.envVar ? ` — đặt biến ${first.envVar}` : "") +
        (first.candidates.length ? ` (giá trị hợp lệ: ${first.candidates.slice(0, 12).join(", ")})` : ""),
    );
  }

  return { values, sources, warnings };
}

/* -------------------------------------------------------------- builder --- */

/** Normalized display name for the card — collapsed spaces, trimmed. */
function normalizeName(raw) {
  return String(raw ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Stage A — build the create-customer proposal. STOPS at the card: 0 write.
 *
 * @param {object} skills reads bag { listCustomers, listCustomerGroups,
 *        listTerritories, listCustomerFieldSpecs }
 * @param {object} resolved { name, mobile?, tax? } — parsed by the caller from
 *        the sentence or from the app's form (both land in the same slots)
 * @param {object} _opts unused, kept for the builder signature convention
 */
export async function buildCustomerCreateProposal(skills, resolved = {}, _opts = {}) {
  duplicateStance();
  createdAs();
  const { cap } = policies();

  const name = normalizeName(resolved.name);
  if (!name) {
    throw refuse(`${CODE_PREFIX}NAME_MISSING`, "chưa rõ TÊN khách cần tạo — tên là bắt buộc (vd \"thêm khách Nguyễn Văn A\")");
  }
  const mobile = String(resolved.mobile ?? "").trim();
  const tax = String(resolved.tax ?? "").trim();
  // Policy default §5 is "name + at least one of {mobile, tax}" — but a shop
  // walk-in may genuinely have neither at hand. The CONTRACT's required list
  // is the hard rule (name only); this soft rule is a WARNING the card shows,
  // so the user decides with the fact on screen instead of being blocked.
  const warnings = [];
  if (!mobile && !tax) {
    warnings.push("chưa có SĐT/MST — sau này khó phân biệt khách trùng tên; nên bổ sung trên ERPNext");
  }

  // 1. PRE-CHECK the business key against the live master list. This read is
  //    the whole point of the skill: a duplicate that reached ERPNext would
  //    clone a real customer (and split their receivable across two masters).
  let rows = [];
  try {
    rows = rowsOf(await skills.listCustomers());
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc được danh mục khách hàng từ ERPNext: ${err?.message ?? err}`);
  }
  const collision = findCustomerCollision(rows, { customer_name: name, mobile_no: mobile, tax_id: tax });
  if (collision) {
    const e = collision.existing;
    const label = e?.customer_name ?? e?.name ?? "?";
    const id = e?.name ?? "?";
    if (collision.kind === "fuzzy") {
      throw refuse(
        collision.code,
        `đã có khách "${label}" (${id}) tên GẦN GIỐNG "${name}" — không tạo khách mới trong bóng của khách có sẵn; nếu đúng là người khác, hãy nói rõ tên đầy đủ khác biệt, hoặc tạo trực tiếp trên ERPNext`,
        { existing_id: id, existing_name: label },
      );
    }
    throw refuse(
      collision.code,
      `khách này ĐÃ CÓ trên ERPNext: "${label}" (${id}) — không tạo bản sao; dùng khách có sẵn để bán/thu, hoặc kiểm tra lại thông tin`,
      { existing_id: id, existing_name: label },
    );
  }

  // 2. The classification to SEND (M1-site). Resolved from the live site before
  //    the card, so the user sees exactly which group/territory/type the record
  //    will carry — and so a site that cannot be classified safely fails HERE,
  //    at the card, instead of after the button.
  const masters = await readProfileMasters(skills);
  const profile = resolveProfileValues(masters, {}, process.env);
  warnings.push(...profile.warnings);

  // 3. The card. entity.id is the business key (no ERPNext id exists yet);
  //    the executor replaces the whole entity with the REAL row after create.
  const proposal = buildProposal({
    action: "create_customer",
    risk: "HIGH",
    entity: {
      kind: "customer",
      id: name,
      name,
    },
    params: {
      customer_name: name,
      ...(mobile ? { mobile_no: mobile } : {}),
      ...(tax ? { tax_id: tax } : {}),
      // Carried so the executor validates the SAME values the user saw, and so
      // a client that re-sends params cannot silently change the classification.
      ...profile.values,
    },
    summary: `Tạo khách hàng MỚI: ${name}${mobile ? ` · SĐT ${mobile}` : ""}${tax ? ` · MST ${tax}` : ""}`,
    extra: {
      warnings,
      profile: { values: profile.values, sources: profile.sources },
      action_id: newActionId(),
      schema_note:
        "params là ĐỀ XUẤT lấy từ câu nói/form — execute đọc LẠI danh mục khách + danh mục phân loại trước khi ghi (trùng thì TỪ CHỐI) và verify bằng cách đọc lại Customer sau ghi; Customer là record thật (không có nháp), tạo xong KHÔNG tự động bán/thu",
    },
  });

  return { proposal, warnings, profile, action_id: proposal.action_id };
}

/* ------------------------------------------------------------- executor -- */

/**
 * The REAL create payload (pure — unit-testable without network).
 *
 * `profile` carries the RESOLVED classification. Every key is conditional: an
 * unresolved optional field is OMITTED (not sent as ""), which is the only
 * honest way to say "this site has no safe default" — ERPNext stores null. No
 * literal classification may ever appear here again (M1-site).
 */
export function buildCustomerCreateData({ name, mobile, tax, actionId, correlation, profile = {} }) {
  return {
    doctype: WRITE_DOCTYPE,
    customer_name: name,
    ...(profile.customer_group ? { customer_group: profile.customer_group } : {}),
    ...(profile.territory ? { territory: profile.territory } : {}),
    ...(profile.customer_type ? { customer_type: profile.customer_type } : {}),
    ...(mobile ? { mobile_no: mobile } : {}),
    ...(tax ? { tax_id: tax } : {}),
    [correlation]: actionId ?? null,
    remarks: "ERPNext Voice Copilot · xác nhận bởi người dùng (nút Tạo khách) · M1",
  };
}

/**
 * Read the created customer back and check it carries what we intended.
 *
 * Only what we SENT is asserted. A classification we deliberately left empty is
 * NOT compared: ERPNext may apply its own default there, and claiming a value we
 * never asked for would be a fabricated check. What matters is that no field we
 * DID send came back different — that is the difference between "the site stored
 * my group" and "the site silently dropped it".
 */
export async function verifyWrittenCustomer(mcp, docName, { name, mobile, tax, actionId, profile = {} }) {
  const res = await getCustomerDoc(mcp, docName);
  // `docOf` (not a hand-rolled `res.data`) — see the import note above.
  const doc = docOf(res);
  const problems = [];
  const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  if (norm(doc.customer_name ?? "") !== norm(name)) problems.push(`customer_name=${doc.customer_name}`);
  if (mobile && String(doc.mobile_no ?? "") !== mobile) problems.push(`mobile_no=${doc.mobile_no}`);
  if (tax && String(doc.tax_id ?? "") !== tax) problems.push(`tax_id=${doc.tax_id}`);
  for (const [field, expected] of Object.entries(profile)) {
    if (!expected) continue;
    if (String(doc[field] ?? "") !== String(expected)) problems.push(`${field}=${doc[field]}`);
  }
  const field = getCapability(CAPABILITY_ID)?.execution?.correlation_field ?? "custom_ai_action_id";
  if (actionId && Object.prototype.hasOwnProperty.call(doc, field) && String(doc[field] ?? "") !== String(actionId)) {
    problems.push(`${field}=${doc[field]}`);
  }
  if (problems.length) {
    throw refuse(
      `${CODE_PREFIX}WRITE_UNVERIFIED`,
      `đọc lại Customer ${docName} thấy sai lệch: ${problems.join(", ")} — cần đối soát thủ công`,
      { doc },
    );
  }
  return doc;
}

/**
 * Stage B — execute a CONFIRMED create proposal. Called only from the Safety
 * Gateway AFTER the idempotency gate. The master list is RE-READ before the
 * write (a duplicate that appeared between card and confirm refuses), the
 * classification is re-resolved against the site, and the created row is read
 * back after it.
 */
export async function executeCustomerCreateProposal(mcp, proposal, commandId, store, { company = null } = {}) {
  const name = String(proposal.params?.customer_name ?? "").replace(/\s+/g, " ").trim();
  const mobile = String(proposal.params?.mobile_no ?? "").trim();
  const tax = String(proposal.params?.tax_id ?? "").trim();
  if (!name) {
    throw refuse(`${CODE_PREFIX}NAME_MISSING`, "đề xuất không có tên khách — không tạo Customer rỗng");
  }

  // 1. Correlation field: the only server-side dedup this doctype has.
  const field = getCapability(CAPABILITY_ID)?.execution?.correlation_field ?? "custom_ai_action_id";
  const probe = await reconcileCustomer(mcp, commandId, { actionId: proposal.action_id ?? null });
  if (probe.correlation_field_unavailable) {
    throw refuse(
      `${CODE_PREFIX}CORRELATION_FIELD_MISSING`,
      `ERPNext chưa có field "${field}" trên ${WRITE_DOCTYPE} — không có cách chống trùng phía server, KHÔNG tạo khách (chạy migration trước)`,
    );
  }
  if (probe.found) {
    throw refuse(
      `${CODE_PREFIX}DUPLICATE_ACTION`,
      `Customer ${probe.doc?.name ?? "?"} đã tồn tại trên ERPNext với action id này — KHÔNG tạo lần nữa, kiểm tra ERPNext trước`,
      { existing_doc: probe.doc?.name ?? null },
    );
  }

  // 2. RE-READ the master list: the business key must still be free. A customer
  //    created on the site (or by a racing command) between card and confirm
  //    is exactly the clone this skill exists to prevent.
  let rows = [];
  try {
    rows = rowsOf(await listCustomers(mcp));
  } catch (err) {
    throw refuse("ERP_UNAVAILABLE", `không đọc lại được danh mục khách hàng: ${err?.message ?? err}`);
  }
  const collision = findCustomerCollision(rows, { customer_name: name, mobile_no: mobile, tax_id: tax });
  if (collision) {
    const e = collision.existing;
    throw refuse(
      collision.kind === "fuzzy" ? `${CODE_PREFIX}FUZZY_MATCH` : collision.code,
      `danh mục khách đã đổi kể từ khi đề xuất được tạo: khách "${e?.customer_name ?? e?.name ?? "?"}" (${e?.name ?? "?"}) ${
        collision.kind === "fuzzy" ? "tên gần giống" : "trùng thông tin"
      } — KHÔNG tạo, hãy xác nhận lại`,
      { existing_doc: e?.name ?? null, drift_code: classifyDriftCode([collision.kind]) },
    );
  }

  // 3. RE-RESOLVE the classification against the live site. The card's values
  //    travel in params (validated again here — they are candidates, not
  //    authority), and a site that lost the group between card and confirm
  //    refuses instead of writing an unclassifiable record.
  const masters = await readProfileMasters(profileReads(mcp));
  const profile = resolveProfileValues(
    masters,
    {
      customer_group: proposal.params?.customer_group,
      territory: proposal.params?.territory,
      customer_type: proposal.params?.customer_type,
    },
    process.env,
  );

  // 4. Register the ERPNext-side reference BEFORE the write (crash safety).
  store.setReference(commandId, commandId);

  if (typeof mcp.callWriteTool !== "function") {
    throw refuse(`${CODE_PREFIX}CLIENT_UNAVAILABLE`, "this MCP client has no write method");
  }
  const data = buildCustomerCreateData({
    name,
    mobile,
    tax,
    actionId: proposal.action_id ?? null,
    correlation: field,
    profile: profile.values,
  });
  const res = await mcp.callWriteTool("erpnext_doc_create", { doctype: WRITE_DOCTYPE, data });
  const doc = res?.data?.data ?? res?.data ?? res ?? {};
  const docName = doc?.name ?? null;
  if (!docName) {
    throw refuse(`${CODE_PREFIX}WRITE_UNVERIFIED`, "ERPNext không trả về document name — coi như chưa ghi xong, cần reconcile");
  }

  // 5. VERIFY by reading the document back — the write response is not evidence.
  const verified = await verifyWrittenCustomer(mcp, docName, {
    name,
    mobile,
    tax,
    actionId: proposal.action_id ?? null,
    profile: profile.values,
  });

  const result = {
    erpnext_doc: docName,
    customer: docName,
    customer_name: verified.customer_name ?? name,
    mobile_no: mobile || null,
    tax_id: tax || null,
    customer_group: profile.values.customer_group ?? verified.customer_group ?? null,
    territory: profile.values.territory ?? verified.territory ?? null,
    customer_type: profile.values.customer_type ?? verified.customer_type ?? null,
    profile_sources: profile.sources,
    profile_warnings: profile.warnings,
    action_id: proposal.action_id ?? null,
    reference_no: commandId,
    company: company ?? null,
    note: "đã tạo Customer record THẬT — có thể bán/thu cho khách này; KHÔNG tự động tạo đơn/phiếu thu",
  };
  store.complete(commandId, result);
  return result;
}

/* --------------------------------------------------------- pre-check util -- */

/**
 * The duplicate pre-check, over the WHOLE customer list.
 *
 * Three kinds of collision, each with its own code so the card can say WHAT is
 * already there (a bare "duplicate" would send the user hunting):
 *   - exact name match            ⇒ CC_DUPLICATE_NAME
 *   - same mobile (non-empty)     ⇒ CC_DUPLICATE_MOBILE
 *   - same tax id (non-empty)     ⇒ CC_DUPLICATE_TAX_ID
 * A near-but-not-exact name is a refusal too (CC_FUZZY_MATCH) — a NEW master
 * record must not be born inside the shadow of a near-identical one.
 *
 * @param {Array<object>} rows customer master rows
 * @param {{customer_name: string, mobile_no?: string|null, tax_id?: string|null}} want
 */
export function findCustomerCollision(rows, want) {
  const norm = (s) => String(s ?? "").trim().toLowerCase().replace(/\s+/g, " ");
  const name = norm(want.customer_name);
  const mobile = String(want.mobile_no ?? "").trim();
  const tax = String(want.tax_id ?? "").trim();

  const exact = rows.find((r) => norm(r.customer_name ?? r.name) === name);
  if (exact) {
    return { kind: "exact_name", code: `${CODE_PREFIX}DUPLICATE_NAME`, existing: exact };
  }
  if (mobile) {
    const byMobile = rows.find((r) => String(r.mobile_no ?? "").trim() === mobile);
    if (byMobile) return { kind: "mobile", code: `${CODE_PREFIX}DUPLICATE_MOBILE`, existing: byMobile };
  }
  if (tax) {
    const byTax = rows.find((r) => String(r.tax_id ?? "").trim() === tax);
    if (byTax) return { kind: "tax_id", code: `${CODE_PREFIX}DUPLICATE_TAX_ID`, existing: byTax };
  }
  // Fuzzy: one name containing the other as a run of WHOLE WORDS — "Lan" ⊂
  // "Nguyễn Thị Lan". Neither direction auto-creates.
  //
  // Whole words, not raw substrings. MEASURED on the real site 2026-09-24: it
  // has a customer literally named "A", and a raw `"khách test app m1".includes("a")`
  // is true (the "a" inside "app") — so the guard refused CC_FUZZY_MATCH for
  // essentially EVERY new name and the one thing this feature does could not be
  // done. A one-letter existing name may only collide with a name that really
  // uses that word ("Khách A"), never with any name that merely contains that
  // letter somewhere.
  const tokens = (s) => norm(s).split(" ").filter(Boolean);
  const hasRun = (needle, haystack) => {
    const n = tokens(needle);
    const h = tokens(haystack);
    if (n.length === 0 || n.length > h.length) return false;
    for (let i = 0; i + n.length <= h.length; i += 1) {
      if (n.every((t, j) => h[i + j] === t)) return true;
    }
    return false;
  };
  const fuzzy = rows.find((r) => {
    const have = r.customer_name ?? r.name;
    return hasRun(name, have) || hasRun(have, name);
  });
  if (fuzzy) {
    return { kind: "fuzzy", code: `${CODE_PREFIX}FUZZY_MATCH`, existing: fuzzy };
  }
  return null;
}
