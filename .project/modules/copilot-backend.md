# Module: copilot-backend (Node + Python — backend của app)

Không phải code Flutter nhưng là "module" mà app phụ thuộc — ghi lại để
phiên sau hiểu端 nào thuộc app,端 nào thuộc backend.

## Thành phần

| Thành phần | File | Port | Ghi chú |
|---|---|---|---|
| NLP bridge | `nlp_service/server.py` | 8787 | stdlib `http.server`, bind **127.0.0.1**, `/health` + `/normalize`; zero dependency |
| Copilot HTTP | `mcp-erpnext/src/http-ask.mjs` | 8788 | bind 127.0.0.1 mặc định; `--host 0.0.0.0` là quyết định operator (LAN testing) |
| DSH gateway | `mcp-erpnext/src/dsh-gateway.mjs` | in-process | Chế độ AI: opt-in, pre-screen WRITE TRƯỚC khi spawn, guard patch phải có `COPILOT_DSH_CONTEXT`, TTL + concurrency; `resolveDshRuntime()` 6 mức + `dshSpawnPlan()` dùng chung với `scripts/dsh-remote-runner.mjs` |
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
| `POST /read/list {screen}` | → danh sách chỉ-đọc | màn đọc lấy từ `ui_screens` trong contract (không tự do client đặt tên); tối đa 5–10 dòng; **KHÔNG qua classifier** (server quyết định màn từ tham số tường minh) |
| `GET\|POST /read/daily-summary?date=` | → tóm tắt ngày | số do **SERVER** cộng (`ops.daily_summary`); company lấy từ **session** (không tin client); một nhánh lỗi ⇒ `partial:true` + `errors[]` — **không bịa 0**; date mặc định = ngày VN (Asia/Ho_Chi_Minh) |
| `GET\|POST /read/drill?screen=` | → list của 1 chỉ số | `drill_screens` = `sales_orders_today` · `invoices_today` · `receipts_today` · `overdue_customers` · `app_drafts_today`; structured request, **cấm** inject free-text vào classifier làm đường chính |
| `POST /ocr {image_base64, kind?}` | → text thô + provenance | OCR provider (`OCR_PROVIDER=mock` mặc định \| `router-vision`); raw text bọc `untrusted-data` **TRƯỚC** khi vào classifier/LLM; policy fail-closed trong `ocr_policy` |
| `POST /ocr/slots {image_base64, kind}` | → form slot + (nếu đủ) proposal NHÁP | `kind` do **USER** chọn (ảnh không tự quyết định là mua hay bán); id đọc từ tài liệu **KHÔNG** authoritative — qua đúng Safety Gateway |
| `POST /dsh/ask` | → chế độ AI (agent, OPT-IN) | `{message}` → `{answer, runtime, erpnext_target}`; chỉ đọc — WRITE bị `DSH_WRITE_BLOCKED` trước khi spawn; KHÔNG BAO GIỜ là fallback của `/ask` |
| `GET /dsh/health` | → runtime/patch THẬT | `source` (npx-pinned/legacy-tmp/…) + `--version` chạy thật — bằng chứng, không suy luận từ sự tồn tại của file |

## Skills (`mcp-erpnext/src/skills/`) — 18 capability trong `capabilities.json`
(9 trong số đó là WRITE có file skill; `document.delete` là WRITE khai báo nhưng không có skill; `sales.summary` là READ stub)

Mọi skill (kể cả WRITE) chỉ **build proposal / đọc dữ liệu**; câu trả lời tiếng Việt luôn
copy số từ ERPNext. Nhóm WRITE chỉ được gọi bởi `runExecute()` (Safety Gateway).

| Nhóm (contract id) | File | Docs | Function chính |
|---|---|---|---|
| customer.balance / customer.lookup | `customer.mjs` | READ | `getCustomerBalance` (`erpnext_customer_list/get`, receivable) |
| invoice.lookup | `sales.mjs` | READ | `listUnpaidInvoices` (`erpnext_sales_invoice_list`) |
| payment.history | `payment.mjs` | READ | `listPaymentEntries` (`erpnext_payment_entry_list`) |
| stock.balance | `inventory.mjs` | READ | `listInventory` (`erpnext_stock_balance`) |
| supplier.lookup | `purchasing.mjs` | READ | `resolveSupplier`/`findSupplier` |
| ops.daily_summary | `ops-summary.mjs` | READ | tổng hợp ngày **server-side** (SO tách submitted/draft · SI · PE · công nợ) — Flutter không cộng |
| payment.create | `payment-write.mjs` | WRITE | `buildPaymentProposal` / `executePaymentProposal` → **Payment Entry** |
| sales_order.create | `sales-order-write.mjs` | WRITE | → **Sales Order** |
| quotation.create | `quotation-write.mjs` | WRITE | → **Quotation** |
| purchase_order.create | `purchase-order-write.mjs` | WRITE | → **Purchase Order** |
| delivery.create | `delivery-write.mjs` | WRITE | → **Delivery Note** (bắt buộc có Sales Order đã submit; `against_sales_order`; pending = `qty − delivered_qty`, trừ cả nháp đã chiếm) |
| purchase_receipt.create | `purchase-receipt-write.mjs` | WRITE | → **Purchase Receipt** (theo PO đã submit: pending = `qty − received_qty − returned_qty`, `purchase_order_item`; hoặc direct supplier) |
| sales_invoice.create | `sales-invoice-write.mjs` | WRITE | → **Sales Invoice NHÁP** (từ 1..n Sales Order đã submit; draft-cover trừ nháp đã chiếm) |
| stock.adjustment | `stock-adjustment-write.mjs` | WRITE | → **Stock Entry Material Issue NHÁP** (xuất hủy hàng hỏng — 2 slot: số lượng + kho; không party, không tiền) |
| sales_return.create | `sales-return-write.mjs` | WRITE | → **Sales Invoice NHÁP `is_return=1`** (khách trả hàng — qty ÂM, `return_against` SI đã submit, trần = `qty − đã trả − nháp đang chiếm`) |
| customer.create | `customer-create.mjs` | **WRITE (master data)** | → **Customer record THẬT** (không có nháp — docstatus Customer không submit); pre-check trùng tên/SĐT/MST/fuzzy `⊂` ⇒ từ chối + nêu khách đã có; executor re-read trước ghi + verify sau; `custom_ai_action_id` bắt buộc trên Customer — thiếu ⇒ `CC_CORRELATION_FIELD_MISSING`; M1: entity là tên cần TẠO (chưa có id), route group `customer_create_write` đứng trước nhóm customer READ + `offer_create_customer` khi NO_MATCH đường bán/thu |
| sales.summary | — | **stub** | chưa skill: `KNOWN_INTENT_UNIMPLEMENTED`, `proposal: null` |
| document.delete | — | **WRITE khai báo, không có file skill** | risk **CRITICAL**, `double_confirm`, đòi quyền `System Manager`, `idempotent:false`, `forbidden_in_ai_path:true` ⇒ **không** có đường từ `/ask`/dsh; chỉ dùng thủ công có kiểm soát (đã dùng để xoá 2 PE demo) |

OCR: `src/ocr/ocr-provider.mjs` (interface + validate fail-closed) + `providers/mock-ocr.mjs`
(bắt buộc cho CI) + `providers/router-vision.mjs` (MVP thật, qua LLM Router) + `ocr-slots.mjs`.
**`src/ocr/**` KHÔNG được import `skills/`** (guard tĩnh: lớp OCR không được với tới executor).

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
npm run dsh:check                                   # runtime chế độ AI có chạy được không (exit code = sự thật)
```

## Trạng thái

- ✅ Read-only pipeline end-to-end + **phases2 P0–P8 đã commit hết**: Capability Contract + Safety Gateway (P0) · entity 4 trạng thái + snapshot (P1) · uncertainty + session context (P2) · LLM classifier (P3) · learning loop (P4) · DSH opt-in READ (P5) · voice dictation (P6) · job queue (P7) · authorization/RBAC (P8) · rate limit + correlation (P10 slice)
- ✅ **DSH end-to-end (2026-09-19)**: chế độ AI chỉ đọc `/dsh/ask` + `/dsh/health`; runtime **resolve tại chỗ** (pin `@deepseek-ai/dsh@0.1.5-rc.1` qua `npx`, `/tmp/dsh-run` chỉ là nhánh cuối khi tồn tại) — `result57/58/59.txt`
- ✅ Write thật: Phase 7 Stage B — `create_payment_entry` qua Safety Gateway, PE **nháp** (submit chỉ khi setting ON, frozen lúc hỏi — F7-2)
- ✅ **9 WRITE đã wire đủ vòng (proposal → confirm → `/execute`)**: `payment.create` · `sales_order.create` · `quotation.create` · `purchase_order.create` · `delivery.create` · `purchase_receipt.create` · `sales_invoice.create` · `stock.adjustment` · `sales_return.create` — tất cả NHÁP (`docstatus: 0`), idempotency + verify đọc lại + reconcile; **không có submit nào** ngoài cổng setting F7-2 (Payment Entry)
- ✅ **WRITE #10 master data (M1, 2026-09-23) `customer.create`** — Customer là record THẬT (không có nháp); an toàn nằm ở nút HIGH + pre-check business key + correlation field; Flutter (form/nút [Tạo khách mới]) đang làm — xem `result64.txt`
- ✅ **Ops/daily summary (plan4)**: `ops.daily_summary` + `/read/daily-summary` + drawer tóm tắt ngày + drill (`/read/drill`) + block `app_drafts` (chỉ đếm nháp do app tạo — lọc `custom_ai_action_id`)
- ✅ **Camera/OCR (Trụ C)**: `OcrProvider` + mock CI + router-vision + `POST /ocr` + `/ocr/slots` (ảnh → proposal NHÁP qua cùng Safety Gateway, `kind` do user chọn)
- ⏳ Còn lại: M1 Flutter (form Tên/SĐT/MST + nút [Tạo khách mới] — backend xong) · migration `custom_ai_action_id` trên Customer/DN/PR trên site thật · submit DN/PR/SO/QT/PO/SI = Go/No-Go riêng · saga §7 (chờ duyệt) · P10 full (DR/load/dashboard — infra) · deployment `COPILOT_USERS`/`COPILOT_COMPANY` (human)
