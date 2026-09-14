# Module: chat (feature duy nhất hiện có)

## Mô tả

Màn hình chat text MVP read-only: user gõ câu hỏi tiếng Việt tự nhiên →
copilot pipeline (NLP → route → ERPNext) → câu trả lời + lịch sử local.

## Files

| File | Vai trò |
|---|---|
| `lib/features/chat/data/chat_models.dart` | `AskResult` (parse `/ask` result, đủ 3 shape answer: null/String/List), `ChatTurn` (history JSON) |
| `lib/features/chat/data/copilot_api_client.dart` | dio POST `/ask`; lỗi → `CopilotNetworkException` / `CopilotTimeoutException` / `CopilotServerException` (message tiếng Việt) |
| `lib/features/chat/data/chat_history_service.dart` | SharedPreferences `chat_history_v1`; load/save/clear đều fail-safe (không crash app) |
| `lib/features/chat/application/chat_controller.dart` | `ChatController` @riverpod — `send()`, `clearHistory()`; state `ChatState` |
| `lib/features/chat/presentation/screens/chat_screen.dart` | màn hình duy nhất: list + input + loading + footer URL + clear dialog |
| `lib/features/chat/presentation/widgets/chat_bubble.dart` | 1 turn = cặp bubble (user phải/primary, copilot trái; lỗi → errorContainer) |

## API endpoints sử dụng

| Endpoint | Method | Request | Response |
|---|---|---|---|
| `/ask` (copilot, :8788) | POST | `{"text": "<câu hỏi>"}` | `200 {ok:true, result:{question, answer, routed, customer, outstanding_vnd, open_invoices, normalized, reason?}}` |
| `/ask` — lỗi | — | thiếu/rỗng `text` | `400 {ok:false, error:"missing required field: text"}` |
| `/ask` — lỗi backend | — | — | `500 {ok:false, error}` (không stack trace) |
| `/health` (copilot) | GET | — | `{ok:true, service:"copilot-ask", port}` |

Contract chi tiết shape `result`: xem `.project/architecture.md` data flow +
`mcp-erpnext/test/http-ask.test.mjs` (test là spec sống).

## Local Storage

| Key | Nội dung | Ghi chú |
|---|---|---|
| `chat_history_v1` | JSON array `ChatTurn` `{question, answer, ok, ts, routed_group?}` | versioned — đổi schema thì bump `v2`, không phá dữ liệu cũ; lỗi storage nuốt im lặng (history là convenience, không phải data of record) |

## Trạng thái

- ✅ Done + committed (`590b1b2`): UI, controller, model, client, history, 13 test
- ⏳ Pending: chạy thật trên máy (cần APK từ GH Actions) · rename thành module
  chung khi feature thứ 2 xuất hiện
- Bugs đã biết: không có open bug (4 bug lịch sử đã fix, xem `openspec.md`)
