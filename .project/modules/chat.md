# Module: chat

## Mô tả

Màn hình chat: user GÕ hoặc ĐỌC bằng giọng (P6: `speech_to_text` — transcript
terms đổ vào CHÍNH ô nhập, không auto-send) câu tiếng Việt tự nhiên →
copilot pipeline (NLP → authz → route → ERPNext) → câu trả lời + lịch sử
local + Action Proposal card (WRITE cần bấm [Xác nhận]).

## Files

| File | Vai trò |
|---|---|
| `lib/features/chat/data/chat_models.dart` | `AskResult` (parse `/ask`, đủ shape answer + ActionProposal + uncertainty), `ChatTurn` (history JSON, có command_id + rejection code/problems) |
| `lib/features/chat/data/copilot_api_client.dart` | dio POST `/ask` + `/execute`; đọc gateway URL/auth từ Settings mỗi request (rỗng ⇒ fallback dart-define); lỗi → sealed exception (message tiếng Việt) |
| `lib/features/chat/data/chat_history_service.dart` | SharedPreferences; trim theo `maxChatItems` (mặc định 20) — KHÔNG cắt turn có proposal PENDING |
| `lib/features/chat/data/speech_service.dart` | P6: interface `SpeechService` + `SystemSpeechService` (OS STT, `vi_VN`); không có method gửi/execute |
| `lib/features/chat/application/chat_controller.dart` | `ChatController` @riverpod — `send()`, `confirmProposal()`, `clearHistory()`; đọc submit setting LÚC HỎI |
| `lib/features/chat/presentation/screens/chat_screen.dart` | list + `PipelineProgress` (4 pha) + `_InputBar` (mic 🎙) + footer URL + clear dialog |
| `lib/features/chat/presentation/widgets/proposal_card.dart` | Action Proposal: risk level, [Xác nhận], banner STALE/EXPIRED/PROBLEMS thay nút confirm (fail-closed), kết quả 3 trạng thái |
| `lib/features/chat/presentation/widgets/entity_picker.dart` | P1: AMBIGUOUS → user chọn, không auto-fuzzy cho WRITE |
| `lib/features/settings/presentation/screens/settings_screen.dart` | gateway URL/auth/max chat items/submit switch (dialog xác nhận riêng, mặc định OFF) |

## API endpoints sử dụng

| Endpoint | Method | Request | Response |
|---|---|---|---|
| `/ask` (copilot, :8788) | POST | `{"text", "entity_id?", "submit_now?", "company?"}` | `200 {ok:true, result:{question, answer, routed, proposal?, uncertainty?, error_code?, reason?}}` |
| `/execute` | POST | `{command_id, proposal, dedup_ack?}` | `200 {ok:true, replay?}` · `409/403/503` refusal có copy TV · 429 rate limit (không đốt command_id) |
| `/execute/cancel` | POST | `{command_id}` | `200 {cancelled:true}` sau reconcile=0; `409` nếu ERPNext CÓ chứng từ |
| `/jobs` | GET | — | `{pending[], completed[], hidden}` — lọc theo actor (P8) |
| `/health` (copilot) | GET | — | `{ok:true, service:"copilot-ask", port}` |
| `/ask` — lỗi | — | thiếu/rỗng `text` | `400 {ok:false, error:"missing required field: text"}` |
| `/ask` — lỗi backend | — | — | `500 {ok:false, error}` (không stack trace) |

Contract chi tiết shape `result`: xem `.project/architecture.md` data flow +
`mcp-erpnext/test/http-ask.test.mjs` (test là spec sống).

## Local Storage

| Key | Nội dung | Ghi chú |
|---|---|---|
| `chat_history_v1` | JSON array `ChatTurn` (kèm proposal/command_id/rejection) | versioned — đổi schema thì bump, không phá dữ liệu cũ; lỗi storage nuốt im lặng |
| gateway settings | `gatewayBaseUrl` / `gatewayAuthUser` / `gatewayAuthPassword` / `maxChatItems` / submit switch | `AppSettingsService`; đổi áp dụng NGAY (client đọc mỗi request) |

## Trạng thái

- ✅ Done (phases2 P0–P8, Flutter 101 test · analyze 0): chat + proposal card + voice + settings + entity picker + PipelineProgress; stale/expired banner qua HTTP 409 thật (dio throw → đọc `err.response?.data`)
- ⏳ Pending: APK thật trên device (human) · Flutter poll `/jobs` sau execute queued (gap UX nhỏ)
  chung khi feature thứ 2 xuất hiện
- Bugs đã biết: không có open bug (4 bug lịch sử đã fix, xem `openspec.md`)
