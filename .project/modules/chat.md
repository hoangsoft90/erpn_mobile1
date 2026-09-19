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
| `lib/features/chat/data/speech_service.dart` | P6: interface `SpeechService` + `SystemSpeechService` (OS STT). Luôn xin `vi_VN` (`fallbackLocaleId`); `localeVerified` chỉ nói **danh sách máy có `vi` hay không** — KHÔNG phải "dùng được hay không", và **UI KHÔNG đọc giá trị này** (chỉ dùng nội bộ cho nhánh retry). `stop()`/`cancel()` tăng session token để bỏ kết quả đến muộn. Không có method gửi/execute |
| `lib/features/chat/application/chat_controller.dart` | `ChatController` @riverpod — `send()`, `confirmProposal()`, `clearHistory()`; đọc submit setting LÚC HỎI |
| `lib/features/chat/presentation/screens/chat_screen.dart` | list + `PipelineProgress` (4 pha) + `_InputBar` (mic 🎙) + footer URL + clear dialog |
| `lib/features/chat/presentation/widgets/proposal_card.dart` | Action Proposal: risk level, [Xác nhận], banner STALE/EXPIRED/PROBLEMS thay nút confirm (fail-closed), kết quả 3 trạng thái |
| `lib/features/chat/presentation/widgets/entity_picker.dart` | P1: AMBIGUOUS → user chọn, không auto-fuzzy cho WRITE |
| `lib/features/settings/presentation/screens/settings_screen.dart` | gateway URL/auth/max chat items/submit switch (dialog xác nhận riêng, mặc định OFF) |

## TTS — đọc câu trả lời (2026-09-19, `.plan/next2/tts-implementation-plan.md`)

- `lib/core/tts/tts_service.dart`: interface `TtsService` (`speak`/`stop`) + `FlutterTtsService`
  (`flutter_tts`, on-device, `vi-VN`, rate 0.55). Máy không có gói tiếng Việt ⇒ `speak()`
  no-op **im lặng** (không throw, không hiện lỗi) — câu trả lời vẫn hiển thị bình thường.
- Hook **DUY NHẤT** tại `ChatController._append()` (nơi duy nhất thêm turn MỚI).
  `build()` (khôi phục lịch sử) và `attachRejection()` (gắn banner vào card cũ) **KHÔNG** đọc.
  `pickEntity()` đi qua `send()` nên vẫn được đọc — đó là câu trả lời thật sự mới.
- Chỉ đọc `turn.answer` + `proposal.summary`; **không bao giờ** đọc `commandId`/`proposalId`/
  `params`. `sanitizeForSpeech()` gỡ markdown + mọi token dạng UUID.
- **Ranh giới:** TTS chỉ ĐỌC. Không method nào confirm/execute, không gọi `/execute`,
  không đọc/ghi cờ `executable`/`needConfirm`. `voiceAutoSend` (tự gửi CÂU HỎI) và
  `ttsEnabled` (đọc CÂU TRẢ LỜI) là 2 setting ĐỘC LẬP; không cái nào chạm đường ghi.
- `AndroidManifest.xml` cần `<queries>` `android.intent.action.TTS_SERVICE` (Android 11+).

## Ghi chú nền tảng — đừng suy diễn sai (P6)

- **Voice vẫn là "input modality" kể cả khi bật auto-send.** `voiceAutoSend` chỉ đổi THỜI ĐIỂM gửi
  (final STT ⇒ `onSend()`), cùng một đường `POST /ask`; nó không thể xác nhận đề xuất hay chạm
  `/execute` — nên bật ON không cần dialog xác nhận (khác công tắc nộp phiếu thật, thứ nằm trong
  đường tiền). Mọi luật chặn (final · có chữ · không loading · switch ON) đặt ở **một chỗ duy nhất**.
- **UI chỉ nói điều user HÀNH ĐỘNG ĐƯỢC.** Tín hiệu không actionable (thiếu `vi` trong `locales()`
  — user không thể "thêm locale" cho máy, mà gõ/đọc vẫn chạy) thì **không hiển thị gì**; gợi ý nhẹ
  vẫn là tiếng ồn (user báo lần 2 phải bỏ). Chỉ `denied` / `unavailable` / `error_language_*` mới hiện.
- **Danh sách của API ≠ năng lực thật của nền tảng.** `SpeechToText.locales()` chỉ liệt kê ngôn
  ngữ của recognizer **ON-DEVICE**; doc plugin ghi rõ list "may not be the complete list of
  languages available for online recognition" và **không có API** nào cho biết recognizer online
  hỗ trợ gì. Máy Android thường KHÔNG có `vi` trong list mà vẫn nhận tiếng Việt tốt (Gboard).
  ⇒ Thiếu `vi` trong list **không bao giờ** được dùng cho refusal/claim "máy không hỗ trợ tiếng Việt",
  và (từ UX follow-up 2026-09-18) **cũng không hiển thị gì cả** — chỉ dùng nội bộ cho nhánh retry
  khi platform từ chối locale.
- **Android nhận `_` trong tag locale**: plugin Kotlin đổi `vi_VN` → `vi-VN` trước
  `RecognizerIntent.EXTRA_LANGUAGE` ⇒ dùng `vi_VN` là hợp lệ.
- **`stop()` của plugin LUÔN bắn thêm 1 kết quả cuối** (doc nguyên văn) ⇒ guard "đã dừng thì bỏ
  kết quả đến muộn" phải được **thực thi** (session token), không chỉ ghi trong comment.

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
| gateway settings | `gatewayBaseUrl` / `gatewayAuthUser` / `gatewayAuthPassword` / `maxChatItems` / `allowSubmitPayment` / `voiceAutoSend` / `ttsEnabled` | `AppSettingsService` — key versioned `settings_*_v1`; đổi áp dụng NGAY (client đọc mỗi request). Mọi công tắc mang rủi ro mặc định OFF và fail-safe khi thiếu key/prefs hỏng |

## Trạng thái

- ✅ Done (phases2 P0–P8, Flutter 107 test · analyze 0): chat + proposal card + voice + settings + entity picker + PipelineProgress; stale/expired banner qua HTTP 409 thật (dio throw → đọc `err.response?.data`)
- ⏳ Pending: APK thật trên device (human) · Flutter poll `/jobs` sau execute queued (gap UX nhỏ)
  chung khi feature thứ 2 xuất hiện
- Bugs đã biết: không có open bug (4 bug lịch sử đã fix, xem `openspec.md`)
