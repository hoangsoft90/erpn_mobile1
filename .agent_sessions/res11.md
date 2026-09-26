**Kết luận theo `res11`: 3 việc ops đã xong. Không còn backlog bắt buộc cho agent.**

### Đã đạt

| Việc | Bằng chứng |
|------|------------|
| Commit next5 | `17d6f9b` — drawer READ + provenance + A3 PDF… |
| Fix “Hôm qua” (số đúng ngày, bỏ delta) | `ed79f77` · Flutter 333 · falsify p44 38/38 |
| `.env` pin | `COPILOT_COMPANY` + `COPILOT_DEFAULT_WAREHOUSE="Kho Cám - MP"` |
| Push | **Chưa** (đúng nếu bạn chưa lệnh) |

---

### Agent còn làm gì?

| Việc | Bắt buộc? | Ghi chú |
|------|-----------|---------|
| **Push** remote | Chỉ khi bạn bảo | Agent làm được |
| Smoke APK / test tay UI | Nên có | **Human** (how-to-test.md) |
| `.plan/**` vào git | Tuỳ | Đang gitignore — agent chỉ commit nếu bạn bỏ ignore / force add |
| Falsify `p43-drawer-summary` 1 ca đỏ cũ | Không | Ngoài scope fix; sửa khi mở hygiene |
| `COPILOT_ERP_TARGET` trong `.env` | Không bắt buộc | Agent ghi thiếu; thêm nếu product cần nhãn target |
| Next feature (aging, Purchase Return…) | Không | Phải mở phase mới |

**Không còn phase next5 / fix “Hôm qua” để agent tự chạy.**

---

### Việc human thực sự

1. Test tay: Tóm tắt **Hôm nay / Hôm qua** + vài mục drawer (công nợ, nháp…).  
2. Quyết **push** hay không.  
3. (Tuỳ) Dọn file dirty cá nhân: `syncode`, `checklist1.md`, …

### Nếu muốn agent làm nốt 1 dòng

```text
git push origin <branch>   # chỉ khi tôi xác nhận push
```

**Một câu:** Code + commit + env **đã đóng**; agent **nghỉ** trừ khi bạn **push** hoặc mở **phase mới** — còn lại là **test tay / product**.