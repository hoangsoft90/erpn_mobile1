**Kết luận: Prompt-4 đạt (fix targeted PE submit/reconcile). Chưa commit.**

### Đối chiếu `res15` ↔ code

| Hạng mục | |
|----------|--|
| Root cause | Submit fail vẫn `complete()` với `docstatus:0` → retry báo sai |
| Fix | `PAYMENT_WRITE_UNVERIFIED` → **PENDING** + reconcile; chỉ complete khi `docstatus===1` |
| Files | `payment-write.mjs` · `safety-gateway.mjs` · mock knob test |
| Suite | payment 44/44 · p9-pay 31/31 · full 842/844 (2 dsh) |
| Result | `.plan/next6-result4.md` |
| ERPNext thật vòng này | **Chưa** (mock biên) |
| Commit | ❌ vùng số tiền |

---

### Agent còn làm gì?

| Việc | Bắt buộc? | Agent làm được? |
|------|-----------|-----------------|
| **Smoke PE thật** trên site (`submit_now` → REST `docstatus=1`; lost-submit → retry cùng `command_id` không duplicate) | **Nên** trước coi P4 “đóng production” | **Có** (có ERPNext) |
| **Commit** P4 (+ test P3 còn treo) | Khi bạn duyệt | **Có** |
| **Push** | Khi bạn lệnh | **Có** |
| Flutter xử lý 503 (thay PARTIAL) | Tuỳ UX | **Có** nếu mở task |
| **Prompt-5** (`.plan/next6-prompt5.md` đã có) | Tiếp roadmap next6 | **Có** sau khi bạn gửi / chốt |
| Đổi session P2/P3 | Không | — |

**Human:** duyệt commit tiền; optional nhìn UI 503 trên máy.

---

### Thứ tự gợi ý

```text
1) (Khuyến nghị) Vòng PE thật trên site — ghi vào next6-result4 hoặc next6-smoke-pe.md
2) Commit: test P3 + feat P4 (tách hoặc 2 commit)
3) (Tuỳ) Flutter 503 banner
4) Sang next6-prompt5.md khi bạn muốn
```

**Một câu:** P4 **code/test xong**; agent **nên smoke PE ERPNext + commit khi duyệt**, rồi **Prompt-5** — không còn implement P4 bắt buộc.
------------
soạn prompt theo thứ tự gợi ý đó để gửi agent
---
```text
Project: /Users/hoang/htdocs/erpnext/erpn_mobile1

Làm theo đúng thứ tự 1 → 2 → (3 tuỳ) → dừng trước Prompt-5 trừ khi tôi gửi next6-prompt5.

════════════════════════════════════
1) Smoke Payment Entry THẬT trên ERPNext (P4)
════════════════════════════════════
Đọc: .plan/next6-result4.md · .plan/next6-prompt4.md · payment-write.mjs

Env: source .env (COPILOT_COMPANY, submit policy nếu có). KHÔNG COPILOT_MOCK_OK cho vòng thật.

Chứng minh (ghi file .plan/next6-smoke-pe.md):
a) submit_now=true (hoặc setting app tương đương) → create → submit → verify REST: PE docstatus===1; không claim success nếu ≠1.
b) Mô phỏng/mất response sau submit (hoặc force path UNVERIFIED nếu an toàn) → command PENDING → retry CÙNG command_id/action_id → reconcile thấy đúng 1 PE, docstatus=1, KHÔNG tạo phiếu thứ 2.
c) Cross-check: list PE trước/sau (số lượng + name).

CẤM: xóa/hủy PE đã submit; JE; đổi session P2/P3; scale DSH.

Nếu site chặn submit (Mode of Payment / quyền): ghi rõ blocker + fail-closed; không bịa PASS.

════════════════════════════════════
2) Commit (khi smoke xong hoặc smoke ghi blocker rõ)
════════════════════════════════════
User CHO PHÉP commit. Không push trừ khi tin nhắn có chữ "push".

Gợi ý 2 commit tách:
- test(dsh): Prompt-3 lifecycle/partial/timeout/global=1 (file test còn uncommitted từ P3)
- fix(payment): P4 submit verify — không complete khi chưa docstatus=1; reconcile retry (kèm test payment/p9-pay)

Secret scan trước stage. Không stage .env, syncode, checklist1, faq1, icon.png, query_customer.py.
Ghi hash vào .plan/next6-smoke-pe.md hoặc next6-result4.md § commit.

════════════════════════════════════
3) (Tuỳ — làm nếu còn thời gian / không phá scope)
════════════════════════════════════
Flutter: khi execute trả 503 PAYMENT_WRITE_UNVERIFIED / retry_same_command_id — banner tiếng Việt rõ (không còn giả định 200 PARTIAL). Test widget tối thiểu.
CẤM: đổi flow confirm; auto-retry vô hạn.

════════════════════════════════════
4) DỪNG
════════════════════════════════════
KHÔNG tự mở .plan/next6-prompt5.md trong phiên này.
Khi xong: tóm tắt 15 dòng — smoke PE names, commit hashes, Flutter có/không, suite numbers.
```