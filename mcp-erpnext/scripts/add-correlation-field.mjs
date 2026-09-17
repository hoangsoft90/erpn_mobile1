/**
 * P0 §10.4 — operator migration: add `custom_ai_action_id` to Payment Entry.
 *
 * WHY A SCRIPT AND NOT THE AI PATH: this is a SCHEMA migration performed by a
 * human operator, not an ERPNext business transaction. It must NOT go through
 * the Safety Gateway (that gate exists to stop AI-initiated business writes),
 * and it must NOT be reachable from the /execute path. It talks to ERPNext's
 * REST API directly, with the operator's own credentials.
 *
 * IDEMPOTENT: it reads `Custom Field` first and creates the field only when it
 * is missing, so running it twice is a no-op. Reversible: deleting the Custom
 * Field in the ERPNext UI removes the column and the unique index.
 *
 * Field spec (plan2_final §10.4 — "Data, unique=True, indexed"):
 *   dt         = Payment Entry
 *   fieldname  = custom_ai_action_id
 *   fieldtype  = Data
 *   unique     = 1   (DB-level half of the duplicate guard: two documents can
 *                     never share one action id, even under a race)
 *   search_index = 1 (reconcile looks the action up by this field)
 *
 * USAGE (from mcp-erpnext/, env from the repo .env — never pass secrets on the
 * command line, they end up in shell history):
 *   set -a; source ../.env; set +a
 *   node scripts/add-correlation-field.mjs
 *
 * Exit codes: 0 = present (created or already there), 1 = refused/failed.
 * Never prints credential values.
 */

const DT = "Payment Entry";
const FIELDNAME = "custom_ai_action_id";
const LABEL = "AI Action ID";

const base = process.env.ERPNEXT_URL;
const key = process.env.ERPNEXT_API_KEY;
const secret = process.env.ERPNEXT_API_SECRET;

function die(message, code = 1) {
  process.stderr.write(`[correlation-field] ${message}\n`);
  process.exit(code);
}

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
const query = `${endpoint}?fields=${encodeURIComponent(JSON.stringify(["name", "dt", "fieldname", "fieldtype", "unique", "search_index"]))}&filters=${encodeURIComponent(
  JSON.stringify([["dt", "=", DT], ["fieldname", "=", FIELDNAME]]),
)}&limit_page_length=5`;

async function findExisting() {
  const res = await fetch(query, { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    // A 403 on the Custom Field resource is an authorization answer, not a
    // network blip: report it plainly and stop.
    die(`đọc Custom Field thất bại: HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  const json = await res.json();
  return json?.data ?? [];
}

async function main() {
  process.stdout.write(`[correlation-field] target host: ${new URL(root).host}\n`);
  const existing = await findExisting();
  if (existing.length > 0) {
    const row = existing[0];
    process.stdout.write(
      `[correlation-field] ĐÃ CÓ: ${row.name} (dt=${row.dt} fieldname=${row.fieldname} type=${row.fieldtype} unique=${row.unique})\n`,
    );
    process.stdout.write("[correlation-field] no-op — không tạo gì thêm\n");
    return;
  }

  process.stdout.write(`[correlation-field] chưa có ${FIELDNAME} trên ${DT} — đang tạo...\n`);
  const res = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      doctype: "Custom Field",
      dt: DT,
      fieldname: FIELDNAME,
      label: LABEL,
      fieldtype: "Data",
      unique: 1,
      search_index: 1,
      in_list_view: 0,
      read_only: 0,
      allow_on_submit: 0,
      no_copy: 0,
      description:
        "ERPNext Voice Copilot — immutable action id (plan2_final §10.4). Ghi tự động khi tạo phiếu; KHÔNG sửa tay.",
    }),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    die(`tạo Custom Field thất bại: HTTP ${res.status} ${body.slice(0, 300)}`);
  }
  const created = await res.json();
  process.stdout.write(`[correlation-field] đã tạo: ${created?.data?.name ?? "(no name returned)"}\n`);

  // Verify by reading it back — the create response is not evidence.
  const after = await findExisting();
  if (after.length === 0) die("đọc lại KHÔNG thấy field vừa tạo — cần người kiểm tra ERPNext");
  const row = after[0];
  process.stdout.write(
    `[correlation-field] VERIFIED: ${row.name} (dt=${row.dt} fieldname=${row.fieldname} type=${row.fieldtype} unique=${row.unique} search_index=${row.search_index})\n`,
  );
}

main().catch((err) => die(`lỗi: ${err?.message ?? err}`));
