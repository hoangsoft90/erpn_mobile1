# Module: copilot-backend (Node + Python — backend của app)

Không phải code Flutter nhưng là "module" mà app phụ thuộc — ghi lại để
phiên sau hiểu端 nào thuộc app,端 nào thuộc backend.

## Thành phần

| Thành phần | File | Port | Ghi chú |
|---|---|---|---|
| NLP bridge | `nlp_service/server.py` | 8787 | stdlib `http.server`, bind **127.0.0.1**, `/health` + `/normalize`; zero dependency |
| Copilot HTTP | `mcp-erpnext/src/http-ask.mjs` | 8788 | bind 127.0.0.1 mặc định; `--host 0.0.0.0` là quyết định operator (LAN testing) |
| Copilot MCP | `mcp-erpnext/src/copilot-server.mjs` | stdio | tool `copilot_ask` cho dsh |
| MCP ERPNext | `@casys/mcp-erpnext@3.0.4` (pin) | stdio | 125 tool `erpnext_*`; env-switch mock/real |

## API endpoints (backend nội bộ)

| Endpoint | Method | Ghi chú |
|---|---|---|
| `POST /normalize {text}` | → `{ok:true, result:{text, amount, ...}}` | NLP chuẩn hóa: kinship strip, synonym map, money → int VND |
| `GET /health` | → `{ok:true, service:...}` | cả 2 service đều có |
| `POST /ask {text}` | → xem `modules/chat.md` | pipeline đầy đủ (rate limit → authz P8 → route → skill) |
| `POST /execute` | → Safety Gateway | CỬA DUY NHẤT ghi; idempotency + verify; 403 authz KHÔNG đốt `command_id` |
| `POST /execute/cancel` | → huỷ PENDING | chỉ sau reconcile=0; chỉ chủ lệnh/người có quyền (P8) |
| `GET /jobs` | → pending+completed | lọc theo actor (P8); job replay mang actor gốc |

## Skills business-level (read-only, trong `mcp-erpnext/src/skills/`)

| Nhóm | Function chính | Tool ERPNext thật |
|---|---|---|
| customer | `getCustomerBalance` | `erpnext_customer_list`, `erpnext_customer_get`, ...receivable... |
| sales | `listUnpaidInvoices` | `erpnext_sales_invoice_list` |
| payment | `listPaymentEntries` | `erpnext_payment_entry_list` |
| inventory | `listInventory` | `erpnext_stock_balance` |

## Env contract (từ source package — không đoán)

```
ERPNEXT_URL=...          # .env, chmod 600, git-ignored
ERPNEXT_API_KEY=...
ERPNEXT_API_SECRET=...   # auth: Authorization: token <key>:<secret>
```

Đủ 3 biến → spawn server thật; thiếu → mock; sai → hard error (không bao giờ
âm thầm rơi về mock). Code: `pickServerScript()` trong `copilot-server.mjs`.

## Chạy từ repo root

```bash
PYTHONPATH=src python3 -m nlp_service.server        # :8787
node mcp-erpnext/src/http-ask.mjs                   # :8788 (mock)
set -a; source .env; set +a; node mcp-erpnext/src/http-ask.mjs  # :8788 REAL
```

## Trạng thái

- ✅ Read-only pipeline end-to-end + **phases2 P0–P8 đã commit hết** (2026-09-18, xem `checklist.md` + `.plan/phases2/p*-result.md`): Capability Contract + Safety Gateway (P0) · entity 4 trạng thái + snapshot (P1) · uncertainty + session context (P2) · LLM classifier (P3) · learning loop (P4) · DSH opt-in READ (P5) · voice dictation (P6) · job queue (P7) · authorization/RBAC (P8) · rate limit + correlation (P10 slice)
- ✅ Write thật: Phase 7 Stage B — `create_payment_entry` qua Safety Gateway, PE **nháp** (submit chỉ khi setting ON, frozen lúc hỏi — F7-2)
- ⏳ Còn lại: P9 (skill mới — gate đã mở, chờ lệnh user) · saga §7 (chờ duyệt) · P10 full (DR/load/dashboard — infra) · deployment `COPILOT_USERS`/`COPILOT_COMPANY` (human)
