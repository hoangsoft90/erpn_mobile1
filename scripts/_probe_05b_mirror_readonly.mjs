#!/usr/bin/env node
/**
 * _probe_05b_mirror_readonly.mjs — ĐO THẬT nhưng KHÔNG GHI.
 *
 * Mục đích: với dữ liệu Mode of Payment HIỆN TẠI của shop, nhánh FINDING 2
 * ("phương thức ĐÃ CHỌN có TÊN đọc như kênh kia") có bật được không — và nhãn nào
 * của app (`cash` / `bank_transfer` / `Tiền mặt` / `Chuyển khoản`) sinh cảnh báo nào.
 *
 * Đây là đường ĐỌC THUẦN của chính bộ giải tiền đang dùng trong production:
 *   `resolveAdvanceAccounts` → `resolveAccountPlan` → `erpnext_doc_list(Mode of Payment)`
 *   + `erpnext_account_list` + `erpnext_doc_get(Company)`.
 * KHÔNG gọi `/execute`, KHÔNG tạo chứng từ, KHÔNG sửa/xoá dữ liệu ERPNext.
 *
 * File tạm (untracked, tiền tố `_probe_`): KHÔNG stage, KHÔNG commit.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const MCP_ROOT = path.join(ROOT, "mcp-erpnext");

/** Nạp `.env` (git-ignored): chỉ ERPNEXT_ / COPILOT_, KHÔNG in giá trị. */
function loadEnv(file) {
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    const [, key, raw] = m;
    if (!/^(ERPNEXT_|COPILOT_)/.test(key)) continue;
    const value = raw.trim().replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1");
    if (value && process.env[key] === undefined) process.env[key] = value;
  }
}
loadEnv(path.join(ROOT, ".env"));
delete process.env.COPILOT_MOCK_OK; // phải là deployment THẬT, không phải mock

const { createMcpClient } = await import(path.join(MCP_ROOT, "src/client.mjs"));
const { pickServerScript } = await import(path.join(MCP_ROOT, "src/copilot-server.mjs"));
const { resolveAdvanceAccounts } = await import(path.join(MCP_ROOT, "src/skills/payment-write.mjs"));

const LABELS = ["cash", "bank_transfer", "Tiền mặt", "Chuyển khoản", "Bank", "Wire Transfer"];
const COMPANY = process.env.COPILOT_COMPANY || null;

const mcp = createMcpClient({ serverScript: pickServerScript() });
await mcp.initialize();

const line = (s) => console.log(s);
line("=== MoP THẬT của site (đọc, không sửa) ===");
const modes = await mcp.callTool("erpnext_doc_list", {
  doctype: "Mode of Payment",
  fields: ["name", "enabled", "type"],
  limit: 50,
});
for (const m of modes?.data?.data ?? modes?.data ?? []) {
  line(`  ${m.name} | enabled=${m.enabled} | type=${m.type}`);
}
line(`\n=== Bộ giải tiền, company=${COMPANY ?? "(session default)"} — chỉ ĐỌC ===`);
for (const mode of LABELS) {
  try {
    const r = await resolveAdvanceAccounts(mcp, { direction: "receive", mode, company: COMPANY });
    line(
      `  nhãn ${JSON.stringify(mode).padEnd(16)} → mode=${JSON.stringify(r.mode).padEnd(16)}` +
        ` channel=${r.channel} account_type=${r.account_type}` +
        `\n      paidTo=${r.paidTo}\n      mode_warning=${r.mode_warning ?? "(không có)"}`,
    );
  } catch (err) {
    line(`  nhãn ${JSON.stringify(mode).padEnd(16)} → TỪ CHỐI ${err?.code ?? "?"}: ${err?.message ?? err}`);
  }
}
line("\nXONG — không có lệnh ghi nào được chạy.");
process.exit(0);
