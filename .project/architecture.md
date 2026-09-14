# Kiến trúc Code

## Bức tranh tổng thể (3 tầng)

```
┌─────────────────────────────┐
│ Flutter app (apps/mobile)   │  UI + state — KHÔNG giữ key, KHÔNG logic tiền
│ Riverpod + GoRouter         │
└──────────────┬──────────────┘
               │ HTTP POST /ask  (dio, timeout 15s)
┌──────────────▼──────────────┐
│ Copilot HTTP wrapper (Node) │  mcp-erpnext/src/http-ask.mjs :8788
│ → answerQuestion()          │  routeIntent → skill → guard → MCP client
└──────────────┬──────────────┘
               │ HTTP (normalize)      │ stdio JSON-RPC (MCP)
┌──────────────▼─────────┐  ┌─────────▼──────────────────────┐
│ NLP bridge (Python)    │  │ @casys/mcp-erpnext@3.0.4       │
│ nlp_service :8787      │  │ mock-server.mjs HOẶC ERPNext   │
│ vietnamese_nlp.normalize│  │ thật (env-switch, .env)        │
└────────────────────────┘  └────────────────────────────────┘
```

Nguyên tắc bất di bất dịch: **số tiền chỉ COPY từ dữ liệu ERPNext** — không
có chỗ nào trong 3 tầng tự tính tiền. Fail-safe: không route/không thấy khách
→ `answer: null` + `reason`, không bịa dữ liệu.

## Cấu trúc thư mục Flutter (Feature-first — blueprint KHÓA)

```
apps/mobile/lib/
├── main.dart                  # bootstrap: prefs → ProviderScope override
├── app/
│   ├── providers.dart         # DI: env, dio, api client, prefs, history
│   ├── router/app_router.dart # GoRouter config
│   └── theme/app_theme.dart   # ThemeData từ design tokens
├── core/
│   └── constants/app_constants.dart  # base URL, storage key, timeout
├── features/
│   └── chat/
│       ├── data/              # models, API client, history service
│       ├── application/       # ChatController (@riverpod)
│       └── presentation/
│           ├── screens/chat_screen.dart
│           └── widgets/chat_bubble.dart
└── (shared/widgets/ — chưa có, tạo khi có widget thứ 2 tái dùng)
```

Quy tắc đặt file theo `architecture` skill: feature mới PHẢI theo khuôn
`features/<name>/{data,domain,application,presentation}` — không tạo cấu trúc
riêng từng feature. `domain/` chỉ tạo khi có entity/interface thật.

## Backend copilot (`mcp-erpnext/src/`)

| File | Vai trò |
|---|---|
| `http-ask.mjs` | HTTP `/ask` + `/health` — điểm cuối app gọi |
| `copilot-server.mjs` | `answerQuestion()` — normalize → route → skill → MCP; MCP server stdio cho dsh (`copilot_ask`) |
| `readonly-guard.mjs` | whitelist 12 tool đọc `erpnext_*` + `assertKnownId` + `markUntrusted` — enforce TRONG CODE |
| `client.mjs` | MCP stdio client, correlation JSON-RPC theo id |
| `mock-server.mjs` | mock ERPNext đúng shape 3.0.4 (dev/test không cần credential) |
| `router.mjs` | `routeIntent()` bảng từ khóa cố định → 4 nhóm skill (customer/sales/payment/inventory) |
| `index.mjs` | server thật 3.0.4 + `pickServerScript()` env-switch |

## Data Flow (1 câu hỏi đi hết vòng)

```
User gõ "chị Lan còn nợ bao nhiêu"
  → ChatController.send()                    (application/)
  → CopilotApiClient.ask()                   (data/, dio POST /ask)
  → http-ask.mjs → answerQuestion(text)
  → HTTP :8787/normalize                     (Python vietnamese_nlp)
      → text sạch + amount + intents         (kinship strip, synonym, money)
  → routeIntent(nlp.text)                    (bảng từ khóa → group=customer)
  → resolveCustomer()                        (erpnext_customer_list, unique-match)
  → skills.getCustomerBalance(id)            (assertKnownId → guard)
  → client.callTool("erpnext_...")           (stdio JSON-RPC)
  → mock HOẶC ERPNext thật (env-switch)
  → answer string tiếng Việt (số tiền copy từ rows)
  ← HTTP 200 {ok:true, result:{answer,...}}
  → AskResult.fromJson → ChatTurn → state + SharedPreferences
  → ChatBubble pair (hỏi/đáp)
```

Lỗi request KHÔNG tạo turn giả — chỉ `lastError` → SnackBar, giữ text đã gõ.

## Kiến trúc backend đã chốt (lý do ở `patterns.md`)

- Cầu nối Python ↔ Node = **HTTP localhost** (không Dart port, không subprocess)
- Read-only tuyệt đối ở mọi tầng hiện tại; write đầu tiên là Phase 7 (Go/No-Go gate)
- Mock-first: thêm tính năng trên mock đúng shape thật, nối thật = đổi binary spawn
