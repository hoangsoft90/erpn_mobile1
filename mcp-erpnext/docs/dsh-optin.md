# DSH opt-in — "Phân tích bằng AI" (P5, READ-only)

> Luật gốc: `plan2_final.md` §2 D2/D3/D8. **Path chính của app là deterministic:
> Flutter → :8788 (`/ask`) → NLP → Rule Router/Classifier → Skill → Safety → MCP.**
> dsh không phải fallback và không bao giờ được pipeline tự gọi.

## Hai chế độ chạy

| | Path chính (app) | dsh opt-in (advanced) |
|---|---|---|
| Ai bật | Luôn sẵn, không cần cấu hình | Người vận hành chủ động chạy `dsh web --patch mcp-erpnext/dsh.cordis.patch.yml` |
| Biến nhận diện | không có `COPILOT_DSH_CONTEXT` | `COPILOT_DSH_CONTEXT=1` (trong patch) |
| WRITE (thu tiền) | Cho phép qua proposal HIGH + confirm (Phase 7) | **Chặn ngay** — `DSH_WRITE_BLOCKED`, không tạo proposal |
| READ | Bình thường | Bình thường (cùng Skill Gateway, cùng entity resolver) |
| Learning log | Có (P4) | Có — câu bị chặn cũng là signal |

## Luật an toàn (đã có test chốt — `test/p5-dsh-optin.test.mjs`)

1. **D2 — không auto-fallback:** trong toàn bộ `src/` không có lệnh spawn dsh nào;
   unknown trả `UNKNOWN_INTENT`, không "đẩy qua dsh cho nó xử lý giùm".
2. **D8 — chỉ opt-in:** gate chỉ KÍCH HOẠT khi env đúng nguyên văn `1`
   (`"true"`/`"0"`/rỗng đều = không phải dsh); gate chỉ có thể CHẶN WRITE,
   không có nhánh nào cho phép dsh thêm quyền.
3. **D3 — không bypass:** dsh không thấy MCP ERPNext trực tiếp — chỉ thấy tool
   `copilot_ask`, đi qua đúng Contract/Skill/Safety như path chính.

## Luồng opt-in

```
Người vận hành                     dsh (Agent Runtime)
     │                                    │
     │ dsh web --patch dsh.cordis.patch.yml
     │───────────────────────────────────►│
     │                                    │ spawn copilot-server.mjs
     │                                    │   env: COPILOT_DSH_CONTEXT=1
     │                                    │ ▼
     │                              user hỏi "Phân tích bằng AI…"
     │                                    │ copilot_ask (READ) → trả lời
     │                                    │ copilot_ask (WRITE) → DSH_WRITE_BLOCKED
```

## Kiểm tra nhanh (khi dsh đã cài)

```bash
python3 -m nlp_service.server &                     # 8787
dsh web --patch mcp-erpnext/dsh.cordis.patch.yml
# trong dsh: hỏi "chị Lan còn nợ bao nhiêu"          → câu trả lời READ bình thường
#            hỏi "thu tiền cho chị Lan 50 nghìn"     → DSH_WRITE_BLOCKED (đúng thiết kế)
```
