## Why

Phase 0–2 đã có pipeline đọc hoạt động thật end-to-end (dsh → copilot → ERPNext thật, trả đúng số tiền từ hóa đơn — `result6.txt`), nhưng chưa có giao diện nào: mọi câu hỏi phải gõ qua CLI hoặc dsh headless. phase-03 yêu cầu **một client dùng được bởi người thật trước khi đầu tư vào voice**, để đo baseline lỗi của riêng pipeline (normalize → route → ERPNext) mà không thêm biến số voice làm nhiễu. Client đích đã chốt là **Flutter** (2026-09-13, không phải PWA).

## What Changes

- Tạo Flutter app đầu tiên tại `apps/mobile/` trong repo (monorepo 1 nguồn sự thật): 1 màn hình chat tối giản — lịch sử hội thoại lưu local, ô nhập text, hiển thị câu trả lời kèm trạng thái route/resolve.
- App gọi HTTP service nội bộ (đúng kiến trúc cầu nối đã khóa): gửi câu hỏi tiếng Việt, nhận JSON `answerQuestion` của copilot (`answer`, `routed`, `customer`, `outstanding_vnd`...). Không nhúng ERPNext/LLM key vào app.
- Chỉ READ-ONLY: 4 nhóm skill Phase 2, không có code write nào, không voice.
- Chuẩn bị CI build APK trên **GitHub Actions** (user cấp repo; KHÔNG build APK trên VPS) + hỗ trợ chạy desktop Linux trên VPS để smoke UI nhanh khi có deps.
- Kèm script đơn giản để đo baseline: số câu trả lời đúng/sai theo đánh giá người dùng (ghim sau khi test với 1–2 người dùng thật theo exit criteria phase-03).

## Capabilities

### New Capabilities
- `chat-client`: màn hình chat Flutter read-only — gửi câu hỏi tiếng Việt, hiển thị câu trả lời từ HTTP bridge, lưu lịch sử local, báo lỗi bằng toast, loading indicator khi chờ.

### Modified Capabilities

( Không có — pipeline Phase 1/2 không đổi requirement nào.)

## Impact

- **Code mới**: `apps/mobile/` (Flutter project), không đụng `src/vietnamese_nlp/`, `mcp-erpnext/`, `nlp_service/`.
- **CI**: thêm workflow GitHub Actions build APK debug/release-signed-later; workflow không chạy cho đến khi user cấp repo và push.
- **Cấu hình**: app đọc địa chỉ service từ build-time env (`--dart-define`), mặc định `http://<VPS-LAN>:8787` khi dev — không hardcode secret (không có secret nào cần thiết cho read-only).
- **Rủi ro chấp nhận**: HTTP (không HTTPS) trong giai đoạn MVP nội bộ — service chỉ bind localhost/LAN của VPS, không dữ liệu PII nào gửi đi ngoài câu hỏi; HTTPS thuộc Phase 5 (Gateway) theo roadmap.
