/**
 * P0 §10.4 (+ B3) — operator migration: add the correlation field to EVERY
 * writable doctype.
 *
 * WHY A SCRIPT AND NOT THE AI PATH: this is a SCHEMA migration performed by a
 * human operator, not an ERPNext business transaction. It must NOT go through
 * the Safety Gateway (that gate exists to stop AI-initiated business writes),
 * and it must NOT be reachable from the /execute path. It talks to ERPNext's
 * REST API directly, with the operator's own credentials.
 *
 * WHY IT IS NO LONGER HARDCODED TO ONE DOCTYPE: B2 added Sales Order and B3
 * added Quotation, so a script that only knew "Payment Entry" would leave the
 * two new writes permanently unable to dedupe server-side (their executors
 * refuse to write without the field — fail-closed, but the feature would be
 * dead). The target list is therefore DERIVED FROM THE CONTRACT
 * (`execution.write_doctype` + `execution.correlation_field` of every
 * non-forbidden WRITE capability): a future write arrives in this script's scope
 * by being declared, not by someone remembering to edit a list here.
 *
 * IDEMPOTENT: reads `Custom Field` first and creates a field only when it is
 * missing, so running it twice is a no-op. Reversible: deleting the Custom Field
 * in the ERPNext UI removes the column and its unique index.
 *
 * Field spec (plan2_final §10.4 — "Data, unique=True, indexed"):
 *   fieldname    = custom_ai_action_id   (the contract's per-capability field)
 *   fieldtype    = Data
 *   unique       = 1   (DB-level half of the duplicate guard: two documents can
 *                       never share one action id, even under a race)
 *   search_index = 1   (reconcile looks the action up by this field)
 *
 * next3/B ADDED A SECOND FAMILY to the same derivation, not a second script: a
 * capability may also declare `business_doc_key.field` (today: Purchase Order),
 * the column holding the identity of the PAPER document the draft came from.
 * Same spec, same reasons, and one extra consequence an operator has to know:
 * `unique = 1` there means a CANCELLED purchase order keeps holding its invoice
 * key, so re-entering that same invoice afterwards is refused (by the executor
 * first, with the existing document named) until the old document is deleted or
 * its field cleared. That is the deliberate trade: a silent duplicate is worse
 * than a refusal a human can resolve.
 *
 * SECOND consequence of `unique = 1` + `no_copy = 0`, added in review 2026-09-25
 * and NOT measured on a real site (the migration has not been run there yet):
 * ERPNext COPIES a doc's fields when it AMENDS one, so the amended Purchase
 * Order would carry the cancelled document's key and collide with the unique
 * index — i.e. amending a keyed order may fail until the old order's field is
 * cleared. The alternative (`no_copy = 1`) is worse for this project: the
 * amendment would silently lose the key and the invoice would be enterable
 * again. If ERPNext's amend turns out to be blocked in practice, the fix is an
 * operator step (clear the field on the cancelled document), NOT a relaxed spec
 * here — a duplicate invoice in the books is not recoverable, an amend is.
 *
 * USAGE (from mcp-erpnext/, env from the repo .env — never pass secrets on the
 * command line, they end up in shell history):
 *   node scripts/add-correlation-field.mjs --plan-only     # no creds, no network
 *   set -a; source ../.env; set +a
 *   node scripts/add-correlation-field.mjs --dry-run       # read-only check
 *   node scripts/add-correlation-field.mjs                 # idempotent create
 *   node scripts/add-correlation-field.mjs "Sales Order"   # restrict to one
 *
 * Exit codes: 0 = present (created, already there, or plan printed), 1 = refused/failed.
 * Never prints credential values.
 */

import { getCapability, isForbidden, listCapabilities } from "../src/capability-contract.mjs";

const FIELDNAME_FALLBACK = "custom_ai_action_id";
const LABEL = "AI Action ID";
const DESCRIPTION =
  "ERPNext Voice Copilot — immutable action id (plan2_final §10.4). Ghi tự động khi tạo phiếu; KHÔNG sửa tay.";
const DOC_KEY_LABEL = "AI Business Doc Key";
const DOC_KEY_DESCRIPTION =
  "ERPNext Voice Copilot — khóa định danh TỜ chứng từ (next3/B): loại + MST/party + số HĐ + ngày. Ghi tự động khi tạo phiếu từ hóa đơn; KHÔNG sửa tay. Xóa/đổi giá trị = mất khả năng chống trùng cho tờ hóa đơn đó.";

const argv = process.argv.slice(2);
const planOnly = argv.includes("--plan-only");
const dryRun = argv.includes("--dry-run");
const only = argv.filter((a) => !a.startsWith("--"));

/**
 * Every (doctype, fieldname) pair the contract says a WRITE needs — derived, so
 * adding a write capability is what puts its doctype in scope here.
 */
function migrationTargets() {
  const seen = new Set();
  const targets = [];
  for (const id of listCapabilities()) {
    const cap = getCapability(id);
    if (!cap || cap.type !== "WRITE" || isForbidden(id)) continue;
    const ex = cap.execution ?? {};
    if (!ex.write_doctype) continue; // stub / non-idempotent write: nothing to correlate
    const fieldname = ex.correlation_field ?? FIELDNAME_FALLBACK;
    const key = `${ex.write_doctype}|${fieldname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({ capability: id, doctype: ex.write_doctype, fieldname });
  }
  return targets;
}

/**
 * The second family: (doctype, fieldname) pairs for DOCUMENT-IDENTITY keys — a
 * capability that declares `business_doc_key.field`. Derived for the same reason
 * as the correlation list: a write that dedupes on a paper document must not be
 * left without its column because someone forgot to edit a list here.
 */
function businessDocKeyTargets() {
  const seen = new Set();
  const targets = [];
  for (const id of listCapabilities()) {
    const cap = getCapability(id);
    if (!cap || cap.type !== "WRITE" || isForbidden(id)) continue;
    const doctype = cap.execution?.write_doctype;
    const fieldname = cap.business_doc_key?.field;
    if (typeof doctype !== "string" || doctype.trim() === "") continue;
    if (typeof fieldname !== "string" || fieldname.trim() === "") continue;
    const key = `${doctype}|${fieldname}`;
    if (seen.has(key)) continue;
    seen.add(key);
    targets.push({
      capability: id,
      doctype: doctype.trim(),
      fieldname: fieldname.trim(),
      label: DOC_KEY_LABEL,
      description: DOC_KEY_DESCRIPTION,
    });
  }
  return targets;
}

function die(message, code = 1) {
  process.stderr.write(`[correlation-field] ${message}\n`);
  process.exit(code);
}

// Both families. Each is deduped by (doctype|field) on its OWN; across the two
// the pairs stay distinct — a doctype can need two different columns for two
// different reasons (Purchase Order: the action id AND the document identity).
// A pair the families happened to share would reach `ensureOne` twice, which is
// idempotent (the second pass reports the existing field).
const targets = [...migrationTargets(), ...businessDocKeyTargets()]
  .filter((t) => only.length === 0 || only.includes(t.doctype))
  .sort((a, b) => a.doctype.localeCompare(b.doctype) || a.fieldname.localeCompare(b.fieldname));

if (targets.length === 0) {
  die(
    only.length > 0
      ? `không có WRITE capability nào khai write_doctype "${only.join(", ")}" trong contract`
      : "contract không khai WRITE capability nào có write_doctype — không có gì để migrate",
  );
}

if (planOnly) {
  process.stdout.write(`[correlation-field] PLAN (derived from capabilities.json — không gọi mạng)\n`);
  for (const t of targets) {
    // Quoted key=value, not a dotted display string: a doctype with a space
    // ("Payment Entry") is otherwise ambiguous to anything parsing this line,
    // which is how the first version of the guard test mis-read the plan.
    process.stdout.write(
      `[correlation-field]   doctype="${t.doctype}" field="${t.fieldname}" capability="${t.capability}"\n`,
    );
  }
  process.stdout.write("exit 0\n");
  process.exit(0);
}

const base = process.env.ERPNEXT_URL;
const key = process.env.ERPNEXT_API_KEY;
const secret = process.env.ERPNEXT_API_SECRET;

if (!base || !key || !secret) {
  die("cần ERPNEXT_URL + ERPNEXT_API_KEY + ERPNEXT_API_SECRET trong môi trường (source .env trước)");
}

const headers = {
  "Content-Type": "application/json",
  Accept: "application/json",
  Authorization: `token ${key}:${secret}`,
  // ngrok's free tier shows an interstitial to browsers; API clients skip it.
  "ngrok-skip-browser-warning": "1",
};

const root = base.replace(/\/+$/, "");
const endpoint = `${root}/api/resource/${encodeURIComponent("Custom Field")}`;

function findQuery(doctype, fieldname) {
  return `${endpoint}?fields=${encodeURIComponent(JSON.stringify(["name", "dt", "fieldname", "fieldtype", "unique", "search_index"]))}&filters=${encodeURIComponent(
    JSON.stringify([["dt", "=", doctype], ["fieldname", "=", fieldname]]),
  )}&limit_page_length=5`;
}

async function findExisting(doctype, fieldname) {
  const res = await fetch(findQuery(doctype, fieldname), { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // A 403 on the Custom Field resource is an authorization answer, not a
    // network blip: report it plainly and stop.
    die(`đọc Custom Field của ${doctype} thất bại: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json?.data ?? [];
}

async function ensureOne({ doctype, fieldname, capability, label = LABEL, description = DESCRIPTION }) {
  const existing = await findExisting(doctype, fieldname);
  if (existing.length > 0) {
    const row = existing[0];
    process.stdout.write(
      `[correlation-field] ĐÃ CÓ: ${row.name} (dt=${row.dt} fieldname=${row.fieldname} type=${row.fieldtype} unique=${row.unique}) — ${capability}\n`,
    );
    return { had: true };
  }
  if (dryRun) {
    process.stdout.write(`[correlation-field] THIẾU: ${doctype}.${fieldname} — dry-run, KHÔNG tạo (${capability})\n`);
    return { had: false };
  }
  process.stdout.write(`[correlation-field] chưa có ${fieldname} trên ${doctype} — đang tạo... (${capability})\n`);
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      doctype: "Custom Field",
      dt: doctype,
      fieldname,
      label,
      fieldtype: "Data",
      unique: 1,
      search_index: 1,
      in_list_view: 0,
      read_only: 0,
      allow_on_submit: 0,
      no_copy: 0,
      description,
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    die(`tạo Custom Field trên ${doctype} thất bại: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const created = await res.json();
  process.stdout.write(`[correlation-field] đã tạo: ${created?.data?.name ?? "(no name returned)"}\n`);

  // Verify by reading it back — the create response is not evidence.
  const after = await findExisting(doctype, fieldname);
  if (after.length === 0) die(`đọc lại KHÔNG thấy field vừa tạo trên ${doctype} — cần người kiểm tra ERPNext`);
  const row = after[0];
  process.stdout.write(
    `[correlation-field] VERIFIED: ${row.name} (dt=${row.dt} fieldname=${row.fieldname} type=${row.fieldtype} unique=${row.unique} search_index=${row.search_index})\n`,
  );
  return { had: false };
}

async function main() {
  process.stdout.write(`[correlation-field] target host: ${new URL(root).host}${dryRun ? " (DRY-RUN)" : ""}\n`);
  const missing = [];
  for (const t of targets) {
    const res = await ensureOne(t);
    if (!res.had) missing.push(t.doctype);
  }
  if (dryRun) {
    process.stdout.write(
      missing.length === 0
        ? "[correlation-field] DRY-RUN: mọi doctype đã có field — không cần làm gì\n"
        : `[correlation-field] DRY-RUN: cần migration cho: ${missing.join(", ")} (bỏ --dry-run để tạo)\n`,
    );
  }
}

main().catch((err) => die(`lỗi: ${err?.message ?? err}`));
