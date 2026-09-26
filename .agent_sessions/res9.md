agent đã xong D1,  xem báo cáo .agent_sessions/res9.txt và đối chiếu  code mới nhất rồi đưa ra kết luận. Còn việc gì agent phải làm tiếp (nhớ rằng agent có quyền truy cập erpnext, việc của human agent có thể đảm nhiệm toàn bộ)?
------------------------
**Kết luận: D1 đạt — khớp `res9` + `D1-result.md` + code drawer.**

### Đã verify

| Hạng mục | |
|----------|--|
| Drill `receivable_customers` / `overdue_top` | ✅ |
| Drawer 2 mục bật (`drill:`), 3 mục còn `soon` D1c/D2/D3 | ✅ |
| GL raw, không trừ nháp PE; footnote server; hint optional | ✅ (theo result + verify site) |
| Suite | Node ~808 pass · Flutter 318 · falsify drill 20/20 |
| Deliverable | `D1-result.md` · `D0.7-result.md` (skip) |

---

### Agent làm tiếp (có ERPNext — gần như hết human ops)

| Thứ tự | Phase | Prompt | Ghi chú |
|--------|--------|--------|---------|
| 1 | **D1c** | `prompt-D1c-open-invoices.md` | HĐ chưa trả — SI `docstatus=1` + outstanding>0 |
| 2 | **D1.5** | `prompt-D1.5-permission.md` | Negative perm nếu site có 2 user; không thì ghi NO-GO |
| 3 | **D2** | `prompt-D2-stock-hot.md` | Cần **pin kho**: agent đặt `COPILOT_DEFAULT_WAREHOUSE` (vd `Kho Cám - MP` hoặc `Kho VLXD - MP` — **bạn chỉ cần chọn 1 tên**; agent tự `.env` + restart) |
| 4 | **D3** | `prompt-D3-app-drafts.md` | `GET /read/app-drafts` aggregate |
| 5 | **D4 → D5** | polish + docs | |
| 6 | **Commit** | Khi bạn duyệt | Diff đang gộp A3/D0.5/D1… |

**Env (agent làm được):**  
`COPILOT_COMPANY="Minh Phát Cám & VLXD"` + `COPILOT_DEFAULT_WAREHOUSE=…` nếu chưa có.

**Human thật sự còn:** chọn **1 kho default** (1 câu), duyệt **commit**, smoke **APK** (tuỳ).

---

### Prompt tối thiểu nếu gửi tiếp ngay

```text
Làm tuần tự: prompt-D1c → D1.5 → (sau khi user/chốt kho hoặc dùng Kho Cám - MP nếu tồn tại trên site) D2 → D3.
Mỗi phase: result file + ≥1 verify ERPNext thật.
Không commit trừ khi được lệnh. Không WRITE từ drawer.
```

**Một câu:** D1 **xong đúng plan**; agent **tiếp D1c → D2 (sau pin kho) → D3 → D4/D5**; human chỉ **chốt tên kho + commit**.