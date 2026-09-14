# .project/ — Knowledge Item cho phiên agent mới

**Đọc file này trước, rồi đi theo link.** Mục tiêu: mở lại project là hiểu
ngay app đang ở đâu, không phải đọc lại toàn bộ result*.txt.

## App này là gì (3 câu)

1. Flutter app tiếng Việt cho chủ tiệm bán cám/thức ăn chăn nuôi: hỏi
   **công nợ / hóa đơn / tồn kho** từ ERPNext bằng câu nói tự nhiên.
2. Pipeline chuẩn hóa tiếng Việt (Python) + skill layer read-only (Node)
   chạy **trước/sau LLM** — số tiền chỉ COPY từ ERPNext, không tự tính.
3. Hiện có màn hình text chat (Phase 3 done, commit `590b1b2`); STT là
   Phase 4, write vào ERPNext là Phase 7 (sau Go/No-Go gate).

## Điều hướng theo nhu cầu

| Tôi muốn biết... | Mở file |
|---|---|
| App cho ai, tech stack, SDK | [`overview.md`](overview.md) |
| Kiến trúc 3 tầng + cấu trúc thư mục + data flow 1 câu hỏi | [`architecture.md`](architecture.md) |
| Riverpod providers, GoRouter, deep link | [`state-routing.md`](state-routing.md) |
| Feature `chat` — API endpoints + local storage | [`modules/chat.md`](modules/chat.md) |
| Backend copilot — skills, env contract, cách chạy | [`modules/copilot-backend.md`](modules/copilot-backend.md) |
| ERPNext/dsh/GH Actions, secrets, PII gate | [`integrations.md`](integrations.md) |
| Màu/spacing/typography/widgets | [`design-system.md`](design-system.md) |
| Pattern đang dùng + vì sao chọn X thay vì Y + anti-pattern đã từng mắc | [`patterns.md`](patterns.md) |
| Done/đang làm/pending + bugs (open/fixed) + todos | [`openspec.md`](openspec.md) |

## File nào là nguồn sự thật khi xung đột?

1. Code + test trong repo (luôn thắng)
2. `result*.txt` (bằng chứng lệnh + output thật)
3. `AGENTS.md` + `operating_rules.md` (rule vận hành)
4. `checklist.md` / `next.md` (trạng thái từng mục)
5. `.project/` này (tóm tắt — cập nhật sau các phase lớn)

## 3 rule cần nhớ ngay (đọc AGENTS.md để biết đầy đủ)

1. **An toàn số tiền > độ phủ** — code chạm tiền AI không tự duyệt, không tự commit.
2. **Verify-first** — đọc source/contract thật trước khi đoán (skill `erpn-verify-first`).
3. **Không báo "xong" bằng lời** — lệnh + output thật, ghi `result*.txt`.
