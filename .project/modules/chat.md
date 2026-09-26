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
| `lib/features/chat/data/copilot_api_client.dart` | dio POST `/ask` + `/execute` + **`/dsh/ask` (`dshAsk()`, timeout riêng)**; đọc gateway URL/auth từ Settings mỗi request (rỗng ⇒ fallback dart-define); lỗi → sealed exception (message tiếng Việt) |
| `lib/features/chat/data/chat_history_service.dart` | SharedPreferences; trim theo `maxChatItems` (mặc định 20) — KHÔNG cắt turn có proposal PENDING |
| `lib/features/chat/data/ocr_models.dart` + `ocr_compose.dart` + `photo_picker_service.dart` | Trụ C: model slot/OCR, compose form → payload proposal, `image_picker` (không dùng camera quét tự động) |
| `lib/features/chat/data/speech_service.dart` | P6: interface `SpeechService` + `SystemSpeechService` (OS STT). Luôn xin `vi_VN` (`fallbackLocaleId`); `localeVerified` chỉ nói **danh sách máy có `vi` hay không** — KHÔNG phải "dùng được hay không", và **UI KHÔNG đọc giá trị này** (chỉ dùng nội bộ cho nhánh retry). `stop()`/`cancel()` tăng session token để bỏ kết quả đến muộn. Không có method gửi/execute |
| `lib/features/chat/application/chat_controller.dart` | `ChatController` @riverpod — `send()`, `confirmProposal()`, `clearHistory()`; đọc submit setting LÚC HỎI |
| `lib/features/chat/presentation/screens/chat_screen.dart` | list + `PipelineProgress` (4 pha) + `_InputBar` (mic 🎙) + **`_ModeBar`** (Chat thường / Phân tích bằng AI — `SegmentedButton`, state cục bộ, KHÔNG persist) + footer URL + clear dialog |
| `lib/features/chat/presentation/widgets/proposal_card.dart` | Action Proposal: risk level, [Xác nhận], banner STALE/EXPIRED/PROBLEMS thay nút confirm (fail-closed), kết quả 3 trạng thái |
| `lib/features/chat/presentation/widgets/entity_picker.dart` | P1: AMBIGUOUS → user chọn, không auto-fuzzy cho WRITE |
| `lib/features/chat/presentation/widgets/ocr_sheet.dart` + `ocr_slots_form.dart` | Sheet text OCR sửa được + form slot trước khi thành đề xuất (id từ ảnh KHÔNG tự động điền) |
| `lib/features/chat/presentation/widgets/ai_fallback_button.dart` | Nút "Hỏi AI câu này" — CHỈ hiện khi auto-fallback TẮT lúc câu trả lời đến (cờ nằm trong turn, không đọc setting hiện tại) |
| `lib/features/ops/...` | Feature `ops`: drawer + màn tóm tắt ngày + drill list (mục “Tóm tắt ngày” bên dưới) |
| `lib/core/tts/tts_service.dart` | TTS đọc câu trả lời (chỉ `turn.answer` + `proposal.summary`) |
| `lib/core/settings/app_settings_service.dart` | Mọi setting (gateway URL/auth · maxChatItems · allowSubmitPayment · voiceAutoSend · ttsEnabled · autoFallbackToAi) — key versioned `settings_*_v1`, đọc mỗi request, mặc định OFF |
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

## Chế độ AI — "Phân tích bằng AI" (DSH, chỉ đọc) — 2026-09-19

- Chọn chế độ bằng `SegmentedButton` trong `_InputBar`: **mặc định "Chat thường"**, lựa chọn
  **không ghi nhớ** (mỗi câu tự quyết — câu trước chọn AI không làm câu sau thành phiên agent).
- Chọn AI ⇒ `dshAsk()` → `POST /dsh/ask` (timeout riêng `dshTimeout`, dài hơn `/ask`). Đây là đường
  **agent**, TÁCH khỏi `/ask` tất định và **chưa bao giờ** là fallback của nó.
- Chỉ trả lời: **không** card đề xuất, **không** nút [Xác nhận], **không** đường tới `/execute`.
  Câu lệnh ghi bị gateway từ chối **TRƯỚC khi spawn** (`DSH_WRITE_BLOCKED`).
- Mọi response (kể cả lỗi) mang `runtime: local|remote` + `erpnext_target`; NLP chết ⇒ fail-closed.
- Lỗi phiên AI trả kèm `log_tail` = **lý do thật** của runtime/upstream (không chỉ "lỗi phiên").

## Bubble trả lời: markdown + cỡ chữ (2026-09-22)

- `chat_bubble.dart` render câu trả lời bằng `flutter_markdown_plus` (`MarkdownBody`) — đậm/
  danh sách/bảng trong câu trả lời hiển thị đúng thay vì lộ ký tự `**`. Bubble user vẫn text thuần.
- **TTS vẫn đọc bản ĐÃ GỠ markdown** (`sanitizeForSpeech`): hiển thị và đọc dùng 2 dạng khác nhau —
  đổi một bên không được làm bên kia đọc ra `*`/`#`.
- Không có setting cỡ chữ riêng: cỡ hiện tại là `textTheme.bodyMedium` của theme (vẫn 1 nguồn token).

## Tóm tắt ngày (P4 — feature `ops`, chỉ đọc)

- `AppDrawer` (nút mở ở chat) → `DailySummaryScreen` mặc định là mục **Tóm tắt ngày**; gọi
  `GET|POST /read/daily-summary?date=` — **không** đi qua classifier (structured request).
- Số do **server** cộng (`ops.daily_summary`), client không tự cộng; chỉ số hiển thị tách rõ
  SO `submitted` vs `draft`; nhãn **không** dùng chữ "Doanh thu" cho một con số `submitted`.
- States: skeleton → OK (+ stamp giờ) → **partial block** (một nhánh lỗi: hiện chữ "chưa lấy được",
  **TUYỆT ĐỐI không hiện 0 giả**) → offline (cache cũ). Footer `REAL|MOCK` + URL; pull-to-refresh;
  cache 30–60s (`daily_summary_cache_v1`).
- Tap 1 chỉ số → `DrillListScreen` (`/read/drill?screen=…`, list ≤10, Back về drawer) —
  màn đọc từ `drill_screens` trong contract, **không** gửi free-text vào classifier; có test
  khẳng định đường drill-down **không** gọi `/execute`.
- Chọn **Hôm nay | Hôm qua**: delta **tuyệt đối** (không %) cho `sales_invoices.amount` +
  `receipts.total`; công nợ vẫn là **hiện tại** kèm chú thích UI khi xem hôm qua.
- Block `app_drafts`: chỉ đếm nháp **do app tạo** (lọc `custom_ai_action_id`) — không đếm mọi draft của site.
- **Cấm trong drawer**: mọi nút ghi (thu/tạo/submit/xoá).

## Camera → đề xuất (Trụ C — OCR không có đường ghi)

- Ảnh → `POST /ocr` (provider `mock` mặc định, `router-vision` khi cấu hình) → `raw_text`
  **bọc untrusted** trước classifier/LLM; provider trả shape sai ⇒ fail-closed (không `String()`
  hoá để che lỗi wiring).
- **USER chọn `kind`** (mua/bán) — ảnh không tự quyết định là SO hay PO; `POST /ocr/slots` trả
  form sửa được, rồi mới thành proposal NHÁP qua **cùng** Safety Gateway/card (không có pipeline thứ hai).
- Id/khách đọc từ tài liệu **KHÔNG** authoritative: phải qua entity resolution + user xác nhận.
- **Không** log/ảnh raw, không ghi ERPNext, không `/execute` từ đường OCR.
- Flutter: `image_picker` (chụp/chọn ảnh), sheet text sửa được, form slot; không auto-submit.

## Voice-first + Huỷ + cap 25s (P5-4, `plan5_final` §6)

- **2 layout theo setting `voiceAutoSend`**: OFF = layout cũ nguyên vẹn (mic nhỏ trong input bar);
  ON = mic là CTA chính **trong cùng vùng input bar** (không thiết kế lại cả màn hình — tránh
  "muscle memory disruption"), TextField **vẫn hiển thị và dùng được** (text là fallback luôn sẵn sàng).
- Trạng thái "Đang nghe" có **nút Huỷ** riêng: Huỷ dừng ghi **và khôi phục field về text trước khi đọc**
  (partial đã stream vào field trong lúc nghe ⇒ phải khôi phục mới đúng nghĩa "không đưa transcript vào");
  khác tap-để-dừng (giữ transcript).
- **Cap 25s** (`AppConstants.voiceMaxRecordDuration`) cho mọi session ở cả 2 layout: hết giờ tự dừng
  **như thể tap-để-dừng** (giữ transcript, **không** Huỷ, **không** auto-send).
- `voiceSilenceTimeout` (mặc định 2200ms) là nguồn **duy nhất** cho cả Timer trong UI lẫn
  `listenFor`/`pauseFor` của recognizer (không literal rải rác).
- Bất biến không đổi: tự gửi (nếu bật) **chỉ** gọi `onSend()` → `/ask`, không bao giờ `/execute`,
  không tự xác nhận proposal.

## Auto AI fallback (`autoFallbackToAi`, mặc định OFF)

- Bật: câu trả lời có `error_code == UNKNOWN_INTENT` ⇒ **CLIENT** hỏi lại đúng câu đó qua `/dsh/ask`
  (**2 request riêng** — server không tự chuyển hướng, D2).
- Tắt: thay vào đó hiện nút **"Hỏi AI câu này"** trên chính bubble đó; nút chỉ hiện khi setting TẮT
  **lúc câu trả lời đến** (cờ nằm trong `ChatTurn.aiFallbackOffered`) ⇒ không xuất hiện trên tin đã xử lý.
- Cả 2 nhánh đều **chỉ đọc**: đường tất định vẫn là mặc định, không card, không `/execute`.

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
| `/dsh/ask` (chế độ AI) | POST | `{message, conversation_id?}` | `200 {ok, answer, runtime: local\|remote, erpnext_target, log_tail?}` · câu lệnh ghi ⇒ `200 + refused:true` (`DSH_WRITE_BLOCKED`, từ chối TRƯỚC khi spawn) · NLP chết ⇒ fail-closed |
| `/dsh/health` | GET | — | `{available, runtime, source (npx-pinned/legacy-tmp/…), version, detail (--version thật), patch_ok}` |
| `/read/daily-summary?date=` | GET\|POST | date optional (mặc định hôm nay, giờ VN) | `200 {ok, partial?, errors[], sales_orders{submitted,draft}, sales_invoices, receipts, payments_out, receivables, cash_drawer...}` |
| `/read/drill?screen=` | GET\|POST | `screen` ∈ `drill_screens` | `200 {ok, screen, rows[≤10]}` |
| `/read/list` | POST | `{screen}` (từ `ui_screens`) | `200 {ok, screen, rows[≤10]}` |
| `/ocr` | POST | `{image_base64, kind?}` | `200 {ok, text, provider, ms}` — text bọc untrusted; shape sai ⇒ fail-closed |
| `/ocr/slots` | POST | `{image_base64, kind}` | `200 {ok, slots, proposal?}` — proposal NHÁP qua Safety Gateway |
| `/health` (copilot) | GET | — | `{ok:true, service:"copilot-ask", port}` |
| `/ask` — lỗi | — | thiếu/rỗng `text` | `400 {ok:false, error:"missing required field: text"}` |
| `/ask` — lỗi backend | — | — | `500 {ok:false, error}` (không stack trace) |

Contract chi tiết shape `result`: xem `.project/architecture.md` data flow +
`mcp-erpnext/test/http-ask.test.mjs` (test là spec sống).

## Local Storage

| Key | Nội dung | Ghi chú |
|---|---|---|
| `chat_history_v1` | JSON array `ChatTurn` (kèm proposal/command_id/rejection/aiFallbackOffered) | versioned — đổi schema thì bump, không phá dữ liệu cũ; lỗi storage nuốt im lặng. **Cắt theo SỐ TURN** (`maxChatItems`, mặc định 20 — không cắt turn có proposal PENDING), **không** cắt theo tuổi (chưa có retention theo ngày) |
| `daily_summary_cache_v1` | JSON kết quả tóm tắt ngày | cache 30–60s để mở drawer không nhấp nháy; offline ⇒ hiện cache cũ kèm dấu |
| gateway settings | `gatewayBaseUrl` / `gatewayAuthUser` / `gatewayAuthPassword` / `maxChatItems` / `allowSubmitPayment` / `voiceAutoSend` / `ttsEnabled` | `AppSettingsService` — key versioned `settings_*_v1`; đổi áp dụng NGAY (client đọc mỗi request). Mọi công tắc mang rủi ro mặc định OFF và fail-safe khi thiếu key/prefs hỏng |

## Trạng thái

- ✅ Done (2026-09-22, **Flutter 265 test** · analyze 0): chat + proposal card + voice auto-send + TTS + settings + entity picker + PipelineProgress + **chế độ AI chỉ đọc** + **bubble markdown** + **voice-first layout/Huỷ/cap 25s** + **auto AI fallback** + **drawer tóm tắt ngày + drill** + **camera/OCR → proposal** (6 loại card nháp: thu · SO · báo giá · PO · phiếu giao · phiếu nhận); stale/expired banner qua HTTP 409 thật (dio throw → đọc `err.response?.data`)
- ⏳ Pending: APK thật trên device (human — gồm cả **smoke chế độ AI** + mic + camera) · Flutter poll `/jobs` sau execute queued (gap UX nhỏ) · `dailySummary` chưa có retention theo tuổi (đang cắt theo số turn)
- Bugs đã biết: không có open bug (4 bug lịch sử đã fix, xem `openspec.md`)
