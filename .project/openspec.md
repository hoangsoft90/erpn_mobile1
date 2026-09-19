# OpenSpec — pointer, KHÔNG nhân bản

> **Quyết định 2026-09-14 (user: "đừng duy trì song song"):** file này KHÔNG còn
> lưu bảng tiến độ / bug / todos — nội dung đó chỉ nằm ở **một** nơi duy nhất
> (bảng dưới). File trước đây từng nhân bản danh sách bug + tiến độ → đã xóa để
> tránh lệch số liệu giữa 2 bản.

## Nguồn sự thật duy nhất cho mỗi loại thông tin

| Cần gì | Đọc ở đâu | Ghi chú |
|---|---|---|
| Đã làm / chưa làm / cần hỏi lại | `checklist.md` (root) | cập nhật sau mỗi phase lớn |
| Roadmap + phase kế tiếp | `next.md` (root) | kèm gate Go/No-Go |
| Tính năng hiện tại/tương lai | `features.md` (root) | |
| Bằng chứng (lệnh + output thật) | `resultNN.txt` (root) | mới nhất = số lớn nhất |
| Nhật ký việc đang mở | `working.md` (root) | |
| Chi tiết OpenSpec change đang mở | `openspec/changes/flutter-chat-mvp/` | proposal/spec/design/tasks |
| Kiến thức tĩnh (kiến trúc, design system, patterns, modules) | các file khác trong `.project/` | không trùng với progress |

## Trạng thái OpenSpec change (chỉ 2 dòng, đổi theo change)

- Change đang mở: **`flutter-chat-mvp`** trên branch `change/flutter-chat-mvp` — kỹ thuật XONG và
  **phases2 P0–P8 đã commit hết** (HEAD `bbca7ca`, đã push; suite Python 62 · Node 267 · **Flutter 107** ·
  analyze 0); APK CI xanh (run `35367603981`, đã xác minh binary chứa bugfix P6 `77e2b57`).
  **Chờ**: device smoke phần mic (human) → `openspec archive` → merge master.
- Tiến độ chi tiết của change: xem `checklist.md` + `openspec/changes/flutter-chat-mvp/tasks.md`
  (§6.9–6.16 ghi đủ hash từng phase phases2); roadmap = `.plan/phases2/` (supersede `.plan/phases/`).
