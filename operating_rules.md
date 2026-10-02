# operating_rules.md — Rule riêng của project

> Chỉ chứa rule CỤ THỂ của project này, không lặp AGENTS.md. Rule vận hành
> chung (retrieval, code review, graceful degradation) nằm ở AGENTS.md.

## Domain tiền & ERPNext

1. **Số tiền chỉ COPY từ dữ liệu ERPNext** — cấm tính cộng/trừ/gộp tiền ở
   client hay copilot. Tổng outstanding do backend trả sẵn; Flutter chỉ render.
2. **Fail-safe money:** parse ambiguous → KHÔNG sinh số (không đoán). Negative
   corpus (37 case) phải luôn xanh — sửa money.py không được phá hướng fail.
3. **Read-only đến khi có Go/No-Go gate** (Phase 7): không viết code write
   (`create_payment_entry`, update doc...) dưới mọi hình thức, kể cả "thử".
4. ERPNext ID (customer/invoice/...) chỉ đến từ tool result trước đó — không
   tự ghép/tự bịa ID.
5. Data ERPNext là **untrusted** khi hiển thị — qua `markUntrusted`, không
   nhúng thẳng vào prompt/template không escape.

## Secrets & môi trường

6. Credentials ERPNext CHỈ trong `.env` (chmod 600). Cấm dán key/secret vào:
   cordis patch, README, result*.txt, handoff, skill, log, chat.7. ERPNext key/secret hiện tại ĐÃ lộ qua plain chat — coi là đã bị lộ cho đến khi user xác nhận đã rotate; không echo giá trị cũ.
8. Không bao giờ build APK release/sign trên VPS; không commit keystore/key
   properties.

## Quá trình & commit

9. Bằng chứng hay lời: mọi claim "xong" kèm lệnh + output thật trong
   `resultNN.txt` (đánh số tiếp theo, mới nhất = số lớn nhất).
10. Commit chỉ khi user duyệt (UI-checkpoint hoặc câu OK rõ ràng). Scope
    commit: đúng plan; KHÔNG `.env`, `node_modules`, `build`, `.plan/`,
    `.gemini/`, `.opencode/`, `initp`; `.agents/` để gitignore (local-only).
11. `working.md` + docs (checklist/features/next + result + handoff mới) cập
    nhật sau mỗi thay đổi lớn — đây là điều kiện để phiên sau hiểu project.
12. OpenSpec: change mở hiện tại là `flutter-chat-mvp` — code Phase 3 follow
    scope trong `proposal.md`/`tasks.md`; đổi scope phải hỏi user trước.

## Flutter & code style

13. Blueprint khóa: Riverpod codegen + GoRouter + Feature-first. Package mới
    ngoài danh sách duyệt → DỪNG, hỏi user (đã duyệt: riverpod, go_router,
    dio, shared_preferences + build_runner/riverpod_generator dev).
14. Không số magic trong widget — màu/spacing/radius qua theme + `AppSpacing`
    (tokens ghi ở `openspec/config.yaml`).
15. Lịch sử chat là convenience — mất/không load được KHÔNG được crash app
    (nuốt lỗi storage, app vẫn chạy).
16. Test file `_test.dart`; sau sửa code chạy TOÀN BỘ suite liên quan
    (Node: `cd mcp-erpnext && node --test` · Python: `PYTHONPATH=src python3
    -m unittest discover -s tests` · Flutter: `flutter analyze && flutter test`).

## Khi nào DỪNG hỏi user (tổng hợp nhanh)

- Code chạm tiền / phân quyền / ràng buộc cứng → xin duyệt trước commit.
- Thêm package/dependency mới (cả Dart, npm, Python).
- Đổi quyết định đã khóa (runtime dsh, pin 3.0.4, cầu nối HTTP, Flutter client,
  STT order, monetization có làm).
- Tool/service cần cài đặt mới (dsh, LLM key, OCR...).
- Đụng `.plan/phases/` (chỉ sửa khi user yêu cầu rõ — root docs là nguồn sự thật).
