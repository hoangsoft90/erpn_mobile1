#!/usr/bin/env node
/**
 * _probe_05b_bank_mop.mjs — VÒNG GHI NHÁP THẬT (ĐÚNG 1 LẦN) để chứng minh F-P5-2.
 *
 * Owner cho phép 2026-09-30 (trong phiên): "1 vòng ghi NHÁP thật để chứng minh MoP
 * bank (rồi xoá đúng phiếu đó bằng aki/bench)".
 *
 * Chạy ĐÚNG chuỗi thật của app:  /ask  →  /collect/propose  →  /execute.
 * KHÔNG submit (proposal mở màn hình thu tiền luôn khoá submit_now=false).
 * KHÔNG tự xoá: xoá làm riêng ở bước sau (bench force=1) để có 2 mốc bằng chứng.
 *
 * Bằng chứng kỳ vọng (đọc lại bằng REST sau khi ghi):
 *   - mode_of_payment là 1 phương thức type=Bank của site (KHÔNG phải "Cash"),
 *   - mode_substituted_from = "bank_transfer",
 *   - paid_to (đọc lại bằng REST/mcp) = "1210 - ACB 110296868 - MP",
 *   - docstatus = 0.
 *
 * File này là harness tạm (untracked, tiền tố `_probe_`): KHÔNG stage, KHÔNG commit.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MCP_ROOT = path.join(ROOT, "mcp-erpnext");

/** Nạp `.env` của repo (git-ignored) — chỉ lấy các biến ERPNEXT_ , COPILOT_ , ASK_ ; KHÔNG in. */
function loadEnv(file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, rawValue] = m;
    // KHÔNG nạp ASK_*: `ASK_USER`/`ASK_PASSWORD` bị chính gateway từ chối khi bind loopback
    // (xem `resolveBindPolicy`) — probe này bind 127.0.0.1 nên chỉ cần ERPNEXT_/COPILOT_.
    if (!/^(ERPNEXT_|COPILOT_)/.test(key)) continue;
    const value = rawValue.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (value && process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv(path.join(ROOT, ".env"));
// MUST be a real deployment: the mock is opt-in and this probe is worthless against it.
delete process.env.COPILOT_MOCK_OK;

const { createAskServer } = await import(path.join(MCP_ROOT, "src/http-ask.mjs"));
const { IdempotencyStore } = await import(path.join(MCP_ROOT, "src/idempotency.mjs"));
const { JobQueue, jobQueueConfig } = await import(path.join(MCP_ROOT, "src/job-queue.mjs"));
const { buildHandoff, handoffStore } = await import(path.join(MCP_ROOT, "src/business-handoff.mjs"));

// F-P5-1 measurement mode: khi cần đo TẦNG PROPOSE (không phải tầng chat), tự dựng
// ticket trong CÙNG tiến trình (đúng shape handoff của màn hình thu tiền) rồi đi tiếp.
// Dùng cho ca khách nằm ngoài 100 dòng đầu: `/ask` có thể đã từ chối ở tầng entity
// (MISSING_ENTITY) trước khi tới propose — falsify ở propose cần đường này.
const FORCE_HANDOFF = process.env.PROBE_FORCE_HANDOFF === "1";
function makeHandoff() {
  const built = buildHandoff({
    capability: "payment.create",
    principalId: "local",
    conversationId: "probe-05b",
    screen: "collect",
    prefill: {
      customer: { state: "RESOLVED", id: CUSTOMER, label: CUSTOMER },
      amount: { state: "MISSING" },
      allocations: { state: "MISSING" },
      payment_methods: { state: "MISSING" },
    },
  });
  handoffStore.put(built, { principalId: "local", conversationId: "probe-05b" });
  return built;
}

const CUSTOMER = process.argv[2] ?? "lan";
const INVOICE = process.argv[3] ?? "ACC-SINV-2026-01285";
const AMOUNT = Number(process.argv[4] ?? 50000);
const MODE = "bank_transfer";

const post = async (base, route, body) => {
  const res = await fetch(`${base}${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
};

const dir = mkdtempSync(path.join(tmpdir(), "probe-05b-"));
const server = createAskServer({
  port: 0,
  host: "127.0.0.1",
  env: process.env,
  idemStore: new IdempotencyStore(dir),
  jobs: new JobQueue({ config: { ...jobQueueConfig(), dir } }),
});

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`[probe] ERPNext target = ${process.env.ERPNEXT_URL} (masked)`);
  console.log(`[probe] site company pin = ${process.env.COPILOT_COMPANY ?? "(chưa pin)"}`);

  // 1) /ask — lấy ticket của màn hình thu tiền (đường vào DUY NHẤT của WRITE).
  const ask = await post(base, "/ask", { text: `thu tiền cho ${CUSTOMER}` });
  let handoff = ask.body?.result?.business_handoff;
  console.log(`[1/3] /ask → ${ask.status} · error_code=${ask.body?.result?.error_code ?? "-"}`);
  console.log(`      handoff=${handoff?.handoff_id ?? "KHÔNG CÓ"} · screen=${handoff?.screen ?? "-"}`);
  console.log(`      prefill.customer=${JSON.stringify(handoff?.prefill?.customer ?? null)}`);
  if (!handoff?.handoff_id) {
    if (!FORCE_HANDOFF) {
      console.log("[STOP] không có ticket ⇒ KHÔNG ghi gì. (đặt PROBE_FORCE_HANDOFF=1 để đo riêng tầng propose)");
      process.exit(2);
    }
    handoff = makeHandoff();
    console.log(`      [FORCE_HANDOFF] tự dựng ticket trong tiến trình: ${handoff.handoff_id}`);
  }

  // 2) /collect/propose — server tự đọc hoá đơn sống + tự chọn tài khoản theo kênh.
  const values = {
    customer_id: handoff.prefill?.customer?.id ?? CUSTOMER,
    allocations: [{ invoice_id: INVOICE, allocated_amount: AMOUNT }],
    payment_methods: [{ mode: MODE, amount: AMOUNT }],
  };
  const proposed = await post(base, "/collect/propose", { handoff_id: handoff.handoff_id, values });
  console.log(`[2/3] /collect/propose → ${proposed.status} · ok=${proposed.body?.ok} · code=${proposed.body?.code ?? "-"}`);
  if (proposed.body?.ok !== true) {
    console.log(`      reason=${proposed.body?.reason ?? "-"}`);
    console.log("[STOP] propose không dựng được ⇒ KHÔNG ghi gì.");
    process.exit(3);
  }
  console.log(`      proposal=[${proposed.body.proposal.action}] amount_vnd=${proposed.body.proposal.params.amount_vnd}` +
    ` · mode="${proposed.body.proposal.params.mode ?? "-"}"` +
    ` · account=${proposed.body.proposal.params.account ?? "-"}`);
  console.log(`      invoice=${proposed.body.invoice} · outstanding_vnd=${proposed.body.outstanding_vnd}` +
    ` · summary=${JSON.stringify(proposed.body.summary)}`);
  console.log(`      warnings=${JSON.stringify(proposed.body.warnings ?? [])}`);

  // 3) /execute — ĐÚNG 1 lần, khoá DRAFT (không submit).
  const commandId = randomUUID();
  const executed = await post(base, "/execute", { command_id: commandId, proposal: proposed.body.proposal });
  const r = executed.body?.result ?? {};
  console.log(`[3/3] /execute → ${executed.status} · ok=${executed.body?.ok} · code=${executed.body?.code ?? "-"} · replay=${executed.body?.replay ?? false}`);
  console.log("      ── KẾT QUẢ THẬT ──");
  for (const k of ["erpnext_doc", "docstatus", "mode_of_payment", "mode_substituted_from", "mode_warning", "paid_vnd", "reference_no", "submitted", "submit_requested"]) {
    if (r[k] !== undefined) console.log(`      ${k} = ${JSON.stringify(r[k])}`);
  }
  console.log(`      invoices = ${JSON.stringify(r.invoices ?? [])} · allocated_vnd=${r.allocated_vnd} · unallocated_vnd=${r.unallocated_vnd}`);
  console.log(`      command_id = ${commandId}`);
  console.log("[DONE] chỉ ĐỌC thêm để verify: paid_to phải là tài khoản ngân hàng (1210), docstatus=0.");
  console.log("[NEXT] xoá đúng chứng từ này bằng bench force=1 rồi verify outstanding/GL không đổi.");
} finally {
  server.close();
  rmSync(dir, { recursive: true, force: true });
}
