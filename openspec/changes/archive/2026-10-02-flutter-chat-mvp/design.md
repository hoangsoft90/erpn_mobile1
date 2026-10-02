## Context

Pipeline đọc đã chạy thật end-to-end (`result6.txt`): dsh → copilot MCP server → HTTP normalize (Python) → ERPNext thật. Cầu nối HTTP nội bộ đã khóa là phương thức duy nhất nối client vào pipeline — không port NLP sang Dart. Toolchain đã verify trên VPS: Flutter 3.47.2 stable (`/google/flutter/bin`), Android SDK 36 + build-tools 36 cài tại `~/Android/Sdk`, Linux desktop toolchain ✗ (chưa build desktop được), Chrome ✗. Quyết định user 2026-09-14: **KHÔNG build APK trên VPS** — sẽ push lên GitHub repo user cấp và build APK bằng GitHub Actions. `openspec` CLI không có trong PATH, dùng qua `npx @fission-ai/openspec`.

## Goals / Non-Goals

**Goals:**
- 1 màn hình chat Flutter chạy thật, gọi được `answerQuestion` payload của copilot qua HTTP.
- Lịch sử local, loading/toast đúng yêu cầu gốc `checklist.md`.
- `flutter analyze` + `flutter test` xanh trong CI và trên VPS.
- GH Actions workflow build APK debug (tên artifact rõ ràng, giữ sẵn cho release sau).

**Non-Goals:**
- Voice/STT (Phase 4), write (`create_payment_entry`, Phase 7), auth/PII gateway (Phase 5).
- Multi-screen navigation phức tạp, theming đầy đủ (Flutter client track chi tiết là khoảng trống riêng — làm song song/later).
- HTTPS (thuộc Phase 5); MVP nội bộ dùng HTTP trong LAN.

## Decisions

1. **State management: `StatefulWidget` + `setState` thuần cho MVP** — 1 màn hình, không cần Riverpod/Provider ngay; khi Flutter client track được định nghĩa (navigation/state/design token) mới nâng cấp có chủ đích. Tránh chọn framework state cho cả app khi chỉ có 1 screen.
2. **HTTP client: `package:http`** (đủ chuẩn, được maintain bởi dart.dev) — 1 hàm POST `/ask` là đủ; không thêm dio/getx.
3. **Payload khớp copilot hiện có**: app hiểu shape `answerQuestion` của `copilot-server.mjs` (`question`, `answer`, `reason`, `routed{group}`, `customer{id,name}`, `outstanding_vnd`, `rows`...). Hiển thị: `answer` khi có, `reason` khi `answer == null`; line nhỏ dưới câu trả lời: nhóm route + tên khách + (nếu có) `outstanding_vnd` đã format sẵn **bởi bridge** (format dùng `formatVnd` của bridge, không format lại trong app).
4. **Lịch sử local: `shared_preferences`** lưu JSON list các lượt chat (chấp nhận cho MVP vài trăm tin nhắn; không cần sqlite). Key `chat_history_v1` — versioned để nâng cấp schema sau không mất dữ liệu user.
5. **Endpoint app gọi: copilot HTTP chuẩn bị nhỏ thêm** — copilot hiện là MCP stdio; cho app gọi qua HTTP, thêm 1 **HTTP wrapper tối giản** chạy cạnh `nlp_service` (Node, cùng pattern stdlib, không thêm framework): POST `/ask` → gọi `answerQuestion()` → trả JSON. Lý do: tái dùng nguyên pipeline + guard đã test 34/34, không nhân bản logic route vào client. App chỉ biết 1 endpoint `/ask`.
6. **Config lúc build**: `const String.fromEnvironment('COPILOT_BASE_URL', defaultValue: 'http://10.0.2.2:8788')` — không secret nào trong app (read-only); hiển thị địa chỉ đang dùng ở footer màn hình chat.
7. **CI: GitHub Actions workflow** chuẩn bị sẵn trong repo (`.github/workflows/android-debug-apk.yml`) — chỉ chạy khi user push lên repo user cấp; build `flutter build apk --debug` + upload artifact. Không chạy local.

## Risks / Trade-offs

- **HTTP wrapper mới (Decision 5)** là surface mới — nhỏ, có test riêng (node --test), không đụng guard copilot.
- **shared_preferences**: lịch sử mất khi uninstall — chấp nhận cho MVP (khoảng trống sync server đã ghi trong checklist gốc).
- **Không chạy được app desktop trên VPS** (thiếu libgtk): UI verify bằng unit/widget test + screenshot từ build sau; nếu cần xem UI sớm, cài libgtk deps là 1 lệnh apt (chỉ khi user yêu cầu).
- **NGrok URL không ổn định định danh**: ERPNext URL nằm trên VPS server-side, app KHÔNG biết gì về nó — app chỉ biết `COPILOT_BASE_URL` (LAN/VPS), giảm rủi ro lộ endpoint ERPNext ra app.

## Open Questions

(Không có — các quyết định nhỏ đã ghi rõ ở Decisions; Flutter client track chi tiết là khoảng trống được phép để sau.)
