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

- Change đang mở: **`flutter-chat-mvp`** trên branch `change/flutter-chat-mvp` — kỹ thuật XONG;
  commit gần nhất **`f82f656` (P9-D, user duyệt riêng vùng số tiền)**, trước đó `47558ce` (docs) ·
  `8a692f1` (Flutter kênh file HĐĐT + thẻ tạo khách) · `7ca1409` (server A3 PDF + B + M1-site).
  Suite hiện tại: Python 62 · **Node 793** (791 pass, 2 fail `dsh-gateway` môi trường từ B0) ·
  **Flutter 310/310** · analyze 0. Đợt 2026-09-25 đã commit: **A3 PDF có lớp chữ** · **B chống trùng theo tỜ HĐ**
  (migration `custom_business_doc_key` trên Purchase Order **ĐÃ CHẠY + VERIFY** trên site thật) · **M1-site
  E2E đạt** · **A2/A3 phần Flutter** (picker `.xml`+`.pdf`) · **P9-D** (nháp PE phủ bớt nợ) ⇒ tổng **10 WRITE** (9 nháp + 1 master).
  Xem root `checklist.md`/`next.md`/`working.md`/`result70.txt` + `tasks.md` §6.26–6.29.
  **Chờ user**: (1) quyết **A3 H1/M1/M2** đã đề xuất **chưa sửa** (định danh `invoice_no`/trần inflate/`readDate` — chạm
  khoá chống trùng) · (2) device smoke (mic + chế độ AI + camera + nút chọn file `.pdf`) · (3) bật lại `lt` trên Mac
  (BLOCKED_EXTERNAL `llm9000.loca.lt` 503) → `openspec archive` → merge master.
- Tiến độ chi tiết của change: xem `checklist.md` + `openspec/changes/flutter-chat-mvp/tasks.md`
  (§6.9–6.16 ghi đủ hash từng phase phases2); roadmap = `.plan/phases2/` (supersede `.plan/phases/`).
