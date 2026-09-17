# Handoff — 2026-09-17 (Phiên: result43 — hạ tầng dev + cap lịch sử chat + Settings screen)

> Đọc thêm: `result43.txt` (bằng chứng đầy đủ), `result42.txt`, `next.md`, `checklist.md`,
> `working.md`, `handoff_20260916-result39.md` (phiên trước).

## 1. Mốc hiện tại

- **HEAD = `c401b0f` — ĐÃ PUSH, branch `change/flutter-chat-mvp` đồng bộ origin**
  (`9f496bf..c401b0f`, gồm cả `4546997` F1/F3/F2 + `c401b0f` result43).
- **Sau đó: user report "lưu URL xong footer vẫn cũ" → 2 lỗi thật đã sửa trong `f28869a` (đã push)**:
  footer đọc tĩnh dart-define + plain Provider không notify ⇒ fix footer đọc URL hiệu lực + `ref.invalidate`
  sau Save (falsify đạt); Flutter **63/63**; run **`35175220731` SUCCESS** → **APK mới** ~80 MB (hết hạn
  2026-12-16): https://github.com/hoangsoft90/erpn_mobile1/actions/runs/35175220731
- GH Actions run `35173021349` (build đầu, headSha `c401b0f`) cũng SUCCESS — artifact CŨ, dùng APK của run mới:
  https://github.com/hoangsoft90/erpn_mobile1/actions/runs/35173021349
- ⚠️ Repo **CHƯA set GitHub Variables** (`actions/variables` rỗng) ⇒ APK có
  `COPILOT_BASE_URL`/auth **RỖNG** → rơi về `http://127.0.0.1:8788`. Cách dùng: cài APK rồi
  vào **⚙️ Settings nhập `https://erpn8788.loca.lt` + auth** (đợt result43 cho phép), không cần
  build lại. Điều kiện: `lt` đang chạy trên Mac + ERPNext reachable.
- **Phiên này (result43) — 3 việc, TẤT CẢ CHƯA COMMIT (chờ user duyệt):**
  - **A. Xác minh hạ tầng** (không sửa gì): `.env` đã đúng ngrok mới; verify bằng đọc thật
    `erpnext_customer_list` (3 khách thật) · `mac-custom` config khớp + tunnel sống (502→200) ·
    `erpn8788.loca.lt` = tunnel Gateway (port 8788). ⚠️ tunnel erpn8788 **hiện TẮT** (408/502,
    `lt` không chạy trên Mac) — tình trạng môi trường, không phải lỗi config.
  - **B. Giới hạn lịch sử chat** `maxChatItems` (mặc định 20, sàn 5, cấu hình được) — cắt turn
    cũ nhất, **TRỪ turn có proposal đang treo**.
  - **C. Màn hình Settings** (`/settings` + icon ⚙️) — đổi Gateway URL/auth/max, áp dụng ngay
    không cần build lại APK.
- Suite: **Python 60 · Node 120 · Router 19 · Flutter 62 (39→62) · analyze 0**.

## 2. File đã tạo / sửa (chưa commit)

**Mới:**
- `apps/mobile/lib/core/settings/app_settings_service.dart`
- `apps/mobile/lib/features/settings/presentation/screens/settings_screen.dart`
- `apps/mobile/test/chat_history_trim_test.dart` (9 test)
- `apps/mobile/test/settings_test.dart` (13 test)
- `apps/mobile/test/settings_navigation_test.dart` (1 test — chạy qua `appRouter` THẬT)
- `result43.txt` + handoff này

**Đã commit + push trong `c401b0f`** (docs bên dưới vẫn CHƯA commit).

**Sửa:** `app_constants.dart` (key + default/max/min) · `providers.dart` (+appSettingsServiceProvider,
client nhận settings/fallbackBaseUrl) · `app_router.dart` (+route) · `chat_screen.dart` (+icon ⚙️) ·
`chat_models.dart` (+`hasPendingProposal`) · `chat_history_service.dart` (+`trimTurns`, save maxItems) ·
`chat_controller.dart` (trim khi append) · `copilot_api_client.dart` (+`_applySettings()` mỗi request) ·
`test/chat_controller_test.dart` (override prefs + signature save) · `checklist.md` · `next.md` · `working.md`.

## 3. Review vòng sau — 2 lỗi thật đã sửa (chi tiết result43 §9)

- 🔴 **`attachRejection` cắt luôn card VỪA bị từ chối**: nó gọi cùng `trimTurns` sau khi đánh dấu
  rejected ⇒ card thành "đã kết thúc" và (thường cũ nhất) bị cắt ngay — user bấm Xác nhận, bị từ
  chối, **banner lý do biến mất**. Test chứng minh trước khi sửa (`Expected: <6> Actual: <5>`).
  **Fix**: BỎ trim ở đường đó (B.2 cắt "sau mỗi lần thêm turn"; từ chối không phải thêm turn).
- 🟡 Doc comment của provider mới bị dán lệch sang `sharedPreferencesProvider` (analyzer không báo).
- 🟡 **Hở test ở đường nối mới**: route `/settings` + ⚙️ không test nào chạm (harness cũ pump
  `MaterialApp(home:)` không router / render thẳng màn đích) ⇒ suite XANH nhưng đường nối chưa từng
  chạy; phát hiện khi user hỏi "viết xong đã test chưa?" → thêm `settings_navigation_test.dart`.
- 3 bài học mới **đã vào** `.agents/skills/erpn-verify-first/SKILL.md` (gitignored, không vào repo).

## 4. Chờ user

- **Duyệt commit đợt result43** (2 thư mục mới + 8 file Dart + 2 test + docs). Không tự commit.
- **Push `4546997`** (F1/F3/F2) + đợt docs (result37/39–43, setup-test.md, handoff37/39) — user chọn
  "commit docs riêng sau".
- Vẫn treo (không phải việc agent): SUBMIT phiếu thu · duyệt saga §7 · dán 3 giá trị GitHub Settings
  · test APK thiết bị thật · thu audio 150 câu · rotate key ERPNext · review `.project/ai-rules.md`.

## 5. Hạn chế đã ghi rõ (không giấu)

1. `/execute` trong ProposalCard đọc `dioProvider` trực tiếp ⇒ chỉ theo URL Settings SAU khi có
   ≥1 lần `/ask` (lúc đó `_applySettings` đã chạy). Trường hợp hẹp còn lại là fail-CLOSED.
2. Card ĐÃ ghi: kết quả chỉ trong RAM (option (b), result42) ⇒ model vẫn coi là "pending" ⇒ không
   bao giờ bị cắt. Giữ thừa an toàn hơn cắt nhầm.
3. Password gateway lưu SharedPreferences thường (app-private nhưng **CHƯA mã hoá**). Muốn mã hoá
   cần `flutter_secure_storage` — ngoài phạm vi yêu cầu.
