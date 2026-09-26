# Kiến trúc Code

> Cập nhật 2026-09-22: thêm **6 nhóm WRITE nháp** (payment · sales_order · quotation ·
> purchase_order · delivery · purchase_receipt), **ops/daily summary + drill** (`/read/*`)
> và **camera/OCR** (`/ocr`, `/ocr/slots` → proposal qua cùng Safety Gateway).
> Cập nhật 2026-09-19: thêm đường DSH — chế độ AI chỉ đọc (`/dsh/ask`) + resolver
> runtime (`npx --yes @deepseek-ai/dsh@<pin>`, KHÔNG hardcode đường dẫn một máy).
> Trước đó (2026-09-18): các tầng phases2 (Safety Gateway, authorization,
> job queue, learning log) và voice input. Trạng thái tiến độ KHÔNG ở đây — xem
> `openspec.md` (pointer) + root docs.

## Bức tranh tổng thể

```
┌──────────────────────────────────────┐
│ Flutter app (apps/mobile)            │  UI + state — KHÔNG giữ key, KHÔNG logic tiền
│ Riverpod + GoRouter                  │  chat + settings + proposal card + voice (STT OS)
└──────────────┬───────────────────────┘
               │ HTTP POST /ask · /execute · /execute/cancel · /jobs   (dio)
┌──────────────▼───────────────────────┐
│ Gateway (Node) :8788 http-ask.mjs    │  bind/auth policy + rate limit + correlation
│  ├─ /ask    → answerQuestion()       │  NLP → route → (authz) → skill → guard → MCP
│  ├─ /execute → Safety Gateway        │  CỬA DUY NHẤT cho WRITE (idempotency + verify)
│  ├─ /execute/cancel → reconcile-verified unlock
│  ├─ /jobs   → JobQueue report (per-actor)
│  ├─ /read/* → ops (daily summary server-side) + drill list + read-list
│  ├─ /ocr + /ocr/slots → ảnh → text bọc untrusted → slot/form (kind do USER)
│  ├─ /dsh/ask   → CHẾ ĐỘ AI (opt-in): pre-screen WRITE TRƯỚC khi spawn
│  ├─ /dsh/health → runtime + patch thật (source + --version)
│  └─ startJobRunner() — retry ERP-down writes nền
└──────┬──────────────┬────────────────┘
       │ HTTP (normalize)  │ stdio JSON-RPC (MCP)
┌──────▼──────────┐  ┌─────▼──────────────────────────┐
│ NLP (Python)    │  │ @casys/mcp-erpnext@3.0.4 pin   │
│ :8787           │  │ mock-server.mjs HOẶC ERPNext   │
│ vietnamese_nlp  │  │ thật (env-switch, .env)        │
└─────────────────┘  └────────────────────────────────┘
```

Nguyên tắc bất di bất dịch: **số tiền chỉ COPY từ dữ liệu ERPNext** — không
có chỗ nào tự tính tiền. Fail-safe: không route/không thấy khách →
`answer: null` + `reason` + uncertainty copy tiếng Việt, không bịa dữ liệu.

## Các lớp an toàn (thứ tự chạy của 1 lệnh ghi)

```
Flutter [Xác nhận] → POST /execute {command_id, proposal, dedup_ack}
  1. rate limit (429 — KHÔNG đốt command_id)          rate-limit.mjs (P10)
  2. Safety Gateway runExecute():
     1a. capability contract (forbidden → 403)         capability-contract.mjs (P0)
     1b. AUTHORIZATION (permissions + company scope)   authorization.mjs (P8)
     2-3. request shape + amount policy (STRICT)
     4. kill switch (503 SYSTEM_MAINTENANCE)           kill-switch.mjs
     5. freshness + snapshot integrity + business dedup  (P1/§10.5)
     6. idempotency gate (command_id; lưu user_id+company)
     7. execute → verify → replay/reconcile
  ERP-down/unverified ⇒ 503 retry_same_command_id ⇒ JobQueue (P7)
  — job replay mang user_id gốc, authorization tính lại LÚC GHI
```

WRITE chỉ đi qua `runExecute()` (test tĩnh no-bypass quét `src/` + `scripts/`).
DSH không bao giờ là fallback của `/ask` (P5, opt-in `COPILOT_DSH_CONTEXT=1`,
WRITE trong context dsh bị chặn `DSH_WRITE_BLOCKED`).

## Cấu trúc thư mục Flutter (Feature-first — blueprint KHÓA)

```
apps/mobile/lib/
├── main.dart                  # bootstrap: prefs → ProviderScope override
├── app/
│   ├── providers.dart         # DI: env, dio, api client, prefs, history, speech
│   ├── router/app_router.dart # GoRouter: /chat, /settings
│   └── theme/app_theme.dart   # ThemeData từ design tokens
├── core/constants/app_constants.dart
└── features/
    ├── chat/
    │   ├── data/              # models, copilot_api_client, history_service, speech_service, ocr_*
    │   ├── application/       # ChatController (@riverpod)
    │   └── presentation/
    │       ├── screens/chat_screen.dart   # list + PipelineProgress + _InputBar (mic 🎙) + _ModeBar
    │       └── widgets/       # chat_bubble (markdown) · proposal_card · pipeline_progress ·
    │                          # entity_picker · ocr_sheet · ocr_slots_form · ai_fallback_button
    ├── ops/                   # tóm tắt ngày (P4)
    │   ├── data/              # daily_summary_models, daily_summary_cache, drill_models
    │   └── presentation/      # screens/{daily_summary_screen, drill_list_screen} + widgets/app_drawer
    └── settings/presentation/screens/settings_screen.dart  # gateway URL/auth/max chat/submit switch
```

`lib/core/`: `constants/app_constants.dart` (mọi key storage + hằng voice `voiceMaxRecordDuration=25s`,
`voiceSilenceTimeout=2200ms`) · `settings/app_settings_service.dart` · `tts/tts_service.dart`.

Quy tắc đặt file theo `architecture` skill: feature mới PHẢI theo khuôn
`features/<name>/{data,domain,application,presentation}`.

## Backend copilot (`mcp-erpnext/src/`) — các module chính

| File | Vai trò |
|---|---|
| `http-ask.mjs` | Gateway HTTP: `/ask` `/health` `/execute` `/execute/cancel` `/jobs`; bind+basic auth; rate limit; correlation; `startJobRunner()` trong `main()` |
| `copilot-server.mjs` | `answerQuestion()`: normalize → route → **authorization (P8)** → skill → guard; MCP server stdio cho dsh (`copilot_ask`); session context + uncertainty (P2); classifier LLM (P3) |
| `capability-contract.mjs` | `capabilities.json` = single source of truth (7 capability, validate fail-closed); `capabilityForAction` |
| `safety-gateway.mjs` | `runExecute()` — CỬA DUY NHẤT cho WRITE; thứ tự gate xem sơ đồ trên |
| `authorization.mjs` | P8: `resolvePrincipal` (multi_user `COPILOT_USERS` / single_tenant), `checkPermissions`, `resolveCompanyScope` (server-first + allow-list), `authorize` |
| `idempotency.mjs` | command store persistent (không /tmp, atomic); record mang `user_id`+`company` (P8) |
| `job-queue.mjs` | P7: retry ERP-down writes; `TEMPORARY_REFUSAL_CODES` (maintenance/authz refusal không tiêu attempt — F7 policy (a)); job mang actor |
| `proposal-freshness.mjs` / `entity-resolution.mjs` / `business-dedup.mjs` | P1/Phase 9: TTL, drift, intent lock, 4 trạng thái entity |
| `uncertainty.mjs` | P2: taxonomy 11 mã + copy tiếng Việt BẮT BUỘC (`toUncertaintyCode` — mọi refusal ra user phải có chữ) |
| `session-context.mjs` | P2: provenance + TTL; WRITE fail-closed chỉ nhận `user_selected`/exact |
| `classifier.mjs` | P3: LLM Router cho câu keyword-router không hiểu; semantic-only, KHÔNG trả ERP id; LLM down ⇒ rule-only |
| `learning-log.mjs` | P4/P10: JSONL never-throw; correlation §17; `scripts/learning-cluster.mjs` READ-ONLY |
| `dsh-optin.mjs` | P5: DSH explicit opt-in READ (D2/D8) |
| `dsh-gateway.mjs` | Chế độ AI (`/dsh/ask`): pre-screen WRITE trước khi spawn (`DSH_WRITE_BLOCKED`), guard patch phải có `COPILOT_DSH_CONTEXT`, session TTL + concurrency; `resolveDshRuntime()` 6 mức + `dshSpawnPlan()` = chỗ DUY NHẤT quyết định spawn (argv-shaped, không shell string), dùng chung với `scripts/dsh-remote-runner.mjs` |
| `speech_service` (Flutter side) | P6: `speech_to_text` OS STT; interface không có method gửi/execute ⇒ không có đường voice → WRITE |
| `untrusted-data.mjs` | wrap/strip injection pattern từ tên khách/output ERPNext |
| `readonly-guard.mjs` | whitelist tool đọc + `assertKnownId` + `markUntrusted` |
| `mock-server.mjs` | mock ERPNext đúng shape 3.0.4 (+ fault injection: `MOCK_ERP_FAIL_*`, `erpnext_doc_submit`) |
| `router.mjs` | `routeIntent()` đọc trigger từ contract; nhóm WRITE: `payment_write` · `sales_order_write` · `quotation_write` · `purchase_order_write` · `delivery_write` · `purchase_receipt_write` (mỗi nhóm cần `startsWith` + `notIf` deny-list để câu HỎI không mở card) |
| `skills/ops-summary.mjs` | `ops.daily_summary` — cộng số **server-side** (SO submitted/draft tách · SI · PE · công nợ · block `app_drafts` theo `custom_ai_action_id`); partial + `errors[]` thay vì bịa 0 |
| `skills/delivery-write.mjs` | WRITE #5 — `Delivery Note`: resolve Sales Order đã submit, pending = `qty − delivered_qty` (**trừ cả nháp DN đã chiếm**), chặn nêu cùng item 2 lần |
| `skills/purchase-receipt-write.mjs` | WRITE #6 — `Purchase Receipt`: theo PO đã submit (`purchase_order_item`, pending = `qty − received_qty − returned_qty`) hoặc direct supplier |
| `ocr/ocr-provider.mjs` + `ocr/providers/*` + `ocr/ocr-slots.mjs` | Trụ C: interface `OcrProvider` + validate fail-closed + `mock-ocr` (CI) + `router-vision` (MVP) + slot extraction. **Cấm import `skills/`** (guard tĩnh); raw text bọc `untrusted-data` trước classifier/LLM |

## Data Flow (1 câu hỏi đi hết vòng)

```
User gõ HOẶC đọc bằng giọng (STT → cùng ô input, không auto-send)
  → ChatController.send()                    (application/)
  → CopilotApiClient.ask()                   (dio POST /ask; URL/auth đọc từ Settings mỗi request)
  → http-ask.mjs (rate limit → answerQuestion)
  → HTTP :8787/normalize                     (Python vietnamese_nlp)
  → routeIntent / classifier                 (contract trigger; LLM chỉ cho unknown)
  → authorize(capability, principal)         (P8 — denied ⇒ không proposal, 0 ERPNext read)
  → resolveCustomer() (4 trạng thái P1; AMBIGUOUS → Flutter picker → server re-validate)
  → skills.getCustomerBalance(id) / buildPaymentProposal()  (write: proposal HIGH, dừng)
  → client.callTool("erpnext_...")           (stdio JSON-RPC; mock HOẶC thật)
  → answer tiếng Việt (số tiền COPY) + ActionProposal v1 + uncertainty copy
  ← HTTP 200 → AskResult → ChatTurn (lưu command_id; có proposal → ProposalCard)
  → WRITE: /execute {command_id} → Safety Gateway → chứng từ **NHÁP** (`docstatus: 0`) của một trong
    6 nhóm: PE (phiếu thu) · Sales Order · Quotation · Purchase Order · Delivery Note · Purchase Receipt
    (submit chỉ có ở Payment Entry, khi setting ON, frozen vào snapshot lúc hỏi;
    lỗi submit giữa chừng ⇒ PARTIAL không FAILED)
```

```
TÓM TẮT NGÀY (P4 — đọc, không qua classifier):
  AppDrawer → GET /read/daily-summary?date=  → ops.daily_summary (company từ SESSION)
  → SO tách submitted/draft · SI · thu (TM/CK/ứng trước) · chi + chú thích “chưa gồm JE” · công nợ
  → partial block khi 1 nhánh lỗi · cache 30–60s · footer REAL|MOCK + URL
  → tap chỉ số → /read/drill?screen=… (list ≤10, Back về drawer; KHÔNG /execute)
```

```
CAMERA → ĐỀXUẤT (Trụ C — OCR KHÔNG có đường ghi):
  Ảnh → POST /ocr (mock mặc định / router-vision) → raw text bọc `untrusted-data`
  → USER chọn kind (mua/bán) → POST /ocr/slots → form sửa được → proposal NHÁP
  → cùng Safety Gateway + cùng card (không pipeline thứ hai, id từ tài liệu KHÔNG authoritative)
```

```
CHẾ ĐỘ AI (opt-in — KHÔNG BAO GIỜ là fallback của /ask):
  ChatController.send() → CopilotApiClient.dshAsk()  (timeout riêng)
  → POST /dsh/ask → dsh-gateway: pre-screen WRITE ⇒ DSH_WRITE_BLOCKED TRƯỚC khi spawn
  → dsh runtime (resolver: DSH_ENTRY → DSH_COMMAND → package local → npx-pinned →
    /tmp/dsh-run CHỈ khi file tồn tại → unavailable)
  → LLM Router → copilot_ask → CÙNG pipeline đọc
  — KHÔNG card đề xuất, KHÔNG nút xác nhận, KHÔNG đường tới /execute
```

Lỗi request KHÔNG tạo turn giả — chỉ `lastError` → SnackBar, giữ text đã gõ.

## Kiến trúc backend đã chốt (lý do ở `patterns.md`)

- Cầu Python ↔ Node = **HTTP localhost** (1 nguồn logic NLP, không lệch số)
- Mock-first: mock đúng shape 3.0.4; nối thật = đổi binary spawn
- WRITE duy nhất qua Safety Gateway; mọi refusal có copy tiếng Việt
- Phân quyền server-side đọc từ contract — prompt KHÔNG bao giờ là quyền
- An toàn số tiền > độ phủ; ambiguous → hỏi lại là recoverable
- Chế độ AI (dsh) là **opt-in**, không bao giờ là fallback của `/ask`; runtime **resolve tại chỗ** và in ra nguồn thắng (`npm run dsh:check`) thay vì hardcode đường dẫn của một máy
