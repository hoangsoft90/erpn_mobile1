# Kiến trúc Code

> Cập nhật 2026-09-18: bổ sung các tầng phases2 (Safety Gateway, authorization,
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
    │   ├── data/              # models, copilot_api_client, history_service, speech_service
    │   ├── application/       # ChatController (@riverpod)
    │   └── presentation/
    │       ├── screens/chat_screen.dart   # list + PipelineProgress + _InputBar (mic 🎙)
    │       └── widgets/       # chat_bubble, proposal_card, pipeline_progress, entity_picker
    └── settings/presentation/screens/settings_screen.dart  # gateway URL/auth/max chat/submit switch
```

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
| `speech_service` (Flutter side) | P6: `speech_to_text` OS STT; interface không có method gửi/execute ⇒ không có đường voice → WRITE |
| `untrusted-data.mjs` | wrap/strip injection pattern từ tên khách/output ERPNext |
| `readonly-guard.mjs` | whitelist tool đọc + `assertKnownId` + `markUntrusted` |
| `mock-server.mjs` | mock ERPNext đúng shape 3.0.4 (+ fault injection: `MOCK_ERP_FAIL_*`, `erpnext_doc_submit`) |
| `router.mjs` | `routeIntent()` đọc trigger từ contract; nhóm `payment_write` (notIf deny-list) |

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
  → WRITE: /execute {command_id} → Safety Gateway → PE nháp (submit chỉ khi setting ON,
    frozen vào snapshot lúc hỏi; lỗi submit giữa chừng ⇒ PARTIAL không FAILED)
```

Lỗi request KHÔNG tạo turn giả — chỉ `lastError` → SnackBar, giữ text đã gõ.

## Kiến trúc backend đã chốt (lý do ở `patterns.md`)

- Cầu Python ↔ Node = **HTTP localhost** (1 nguồn logic NLP, không lệch số)
- Mock-first: mock đúng shape 3.0.4; nối thật = đổi binary spawn
- WRITE duy nhất qua Safety Gateway; mọi refusal có copy tiếng Việt
- Phân quyền server-side đọc từ contract — prompt KHÔNG bao giờ là quyền
- An toàn số tiền > độ phủ; ambiguous → hỏi lại là recoverable
