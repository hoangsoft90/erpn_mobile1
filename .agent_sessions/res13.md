**Kết luận: Next6 Prompt-2 (Session Isolation) — code + test đạt; chưa commit.**

### Đối chiếu `res13` ↔ repo

| Yêu cầu | Bằng chứng |
|---------|------------|
| Session key = principal + conversation | ✅ `dshSessionKey()` trong `dsh-gateway.mjs` |
| Test isolation | ✅ `test/next6-session-isolation.test.mjs` |
| Result | ✅ `.plan/next6-result2.md` |
| Suite | 14/14 isolation · full 832/834 (2 dsh env) · Flutter 338 · analyze 0 |
| OpenSpec | Agent báo valid |
| Commit / push | ❌ Chưa (vùng authz: idempotency + safety-gateway) |

---

### Agent còn làm gì?

| Việc | Bắt buộc? |
|------|-----------|
| **Commit** `next6-session-isolation` (tách PR/commit) | **Ops** — khi bạn duyệt |
| **Push** | Chỉ khi bạn lệnh |
| Prompt-3 / gap còn lại (clear endpoint server, SESSION_LIMIT 503 low…) | **Không** trừ plan next6 còn phase |
| Smoke 2 user ERPNext thật | Agent **làm được** nếu bạn yêu cầu |
| next5 / drawer / P9 | **Không** — đã đóng |

**Human thực sự:** duyệt commit (trust boundary); optional test tay 2 tài khoản chat.

---

### Prompt nếu muốn agent đóng nốt

```text
Commit riêng next6-session-isolation (không gộp next5).
Message rõ: session key principal+conversation, lock, WRITE isolation.
Không push trừ khi tôi ghi push.
(Tuỳ) 1 vòng smoke 2 conversation / 2 principal trên site.
```

**Một câu:** Isolation **code xong + test xanh**; agent **chỉ còn commit/(tuỳ) push/smoke** — không còn feature gap bắt buộc từ Prompt-2.
--------------
**Được — chuyển Prompt-3 được.**

### Vì sao OK

| Prompt-2 (đã xong) | Prompt-3 (tiếp) |
|--------------------|-----------------|
| Session key principal+conversation | Lifecycle đủ 8 bước / request |
| Per-conversation lock (một phần) | Siết serialize, timeout cleanup, partial **không** commit context |
| WRITE isolation cross-user | Giữ **DSH_MAX_CONCURRENT=1**, phân biệt busy |
| Flutter conversation id persist | Không scale concurrency; không đụng PE |

Prompt-3 **không** phụ thuộc commit Prompt-2 về mặt kỹ thuật; phụ thuộc **code + `next6-result2.md`** (đã có).

### Nên làm trước (ops, không chặn)

```text
(Tuỳ) Commit riêng next6-session-isolation trước khi diff Prompt-3 phình thêm.
```

### Gửi agent

```text
Đọc và làm đúng .plan/next6-prompt3.md
+ .plan/next6_final.md · next6-audit1.md · next6-result2.md
Không Payment Entry · không scale concurrency · output .plan/next6-result3.md
```

**Một câu:** **Sang Prompt-3 được ngay**; commit P2 là **nên**, không phải **gate**.