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
| `POST /ask {text}` | → xem `modules/chat.md` | pipeline đầy đủ |

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

- ✅ Done: pipeline read-only end-to-end (ERPNext thật 2026-09-14, `result6.txt`)
- ⏳ Pending: audit log/rate limit (Phase 5) · write skills (Phase 7+, gate)
