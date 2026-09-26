**Kết luận theo `res12`: Next6 Prompt-1 (Audit & Baseline) đã xong. Không còn việc audit; agent chờ Prompt-2 để code.**

### Đã đạt

| | |
|--|--|
| Deliverable | `.plan/next6-audit1.md` (local, gitignore) |
| Baseline | Node 818/820 (2 dsh) · Flutter 333 · analyze 0 |
| Code đổi | **Không** (đúng audit-only) |
| 11 gap | G1–G11 đã liệt kê (session key thiếu principal, lock, cross-user context, idempotency user, …) |

---

### Agent làm tiếp

| Việc | Ai |
|------|-----|
| **Prompt-2: implement session isolation** (sửa G1–G11 theo audit) | **Agent** — cần bạn **gửi prompt 2** |
| Tạo OpenSpec `next6-session-isolation` | Agent (đầu prompt 2) |
| File dự kiến | `dsh-gateway.mjs` · `http-ask.mjs` · `idempotency.mjs` · `safety-gateway.mjs` · `copilot-server.mjs` · test + Flutter `chat_controller` |
| **Không** sửa `payment-write` / `authorization` (audit: đã đạt) | — |
| Push / phase product mới | Chỉ khi bạn lệnh |

**Human:** soạn/gửi **Prompt-2**; không bắt buộc đụng ERPNext cho bước isolation (agent tự test + site nếu cần).

---

### Nếu chưa có prompt 2 — khung gửi agent

```text
Đọc .plan/next6-audit1.md. Implement NEXT6 session isolation theo gap G1–G11.
Ưu tiên: G1 principal trong session key · G2 per-conversation lock · G3 sessionContext không cross-user · G4/G5 bind user trên begin/proposal.
Tạo openspec/changes/next6-session-isolation/ trước khi sửa source.
Test isolation 2 user / 2 conversation. Không đụng payment-write trừ regression.
Result: .plan/next6-session-result.md + suite numbers.
```

**Một câu:** Prompt-1 **đóng**; agent **chỉ còn chờ Prompt-2 (code isolation)** — không còn việc “treo” khác.