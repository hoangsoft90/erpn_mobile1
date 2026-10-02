# Learning Loop Workflow — P4 (human-approved)

> Luật gốc: `plan2_final.md` §12 + `phases2/p4-learning-loop.md`. Pipeline **KHÔNG BAO GIỜ**
> tự ghi vào Capability Contract. Mọi thay đổi trigger = quyết định của con người sau khi
> xem báo cáo cluster, và phải đi qua regression gate trước khi merge.

## Vòng lặp (mỗi 1–2 tuần hoặc khi muốn rà)

```
observations.jsonl  ──►  learning:cluster  ──►  HUMAN REVIEW
   (tự ghi từ /ask)       (báo cáo nhóm)          │
                                                  ▼
                              quyết định: thêm/sửa trigger trong
                              capabilities.json? (có thể KHÔNG)
                                                  │
                                                  ▼
                     golden-dataset.json += case mới (cả case ĐỨNG lẫn
                     case phản ví dụ nếu muốn chặn misroute)
                                                  │
                                                  ▼
                     npm test (golden + classifier regression phải xanh)
                                                  │
                                                  ▼
                                  commit + push (như mọi thay đổi contract)
```

## Bước 1 — Xem báo cáo cluster

```bash
cd mcp-erpnext
npm run learning:cluster            # log mặc định: <repo>/learning-log/
npm run learning:cluster -- --min 3   # chỉ cụm ≥3 lần
npm run learning:cluster -- --dir /path/to/other-log
```

Báo cáo in: tổng quan outcome (answered là mẫu số), các cụm
UNKNOWN_INTENT / KNOWN_INTENT_UNIMPLEMENTED / LOW_CONFIDENCE xếp theo tần suất,
kèm tối đa 3 câu ví dụ nguyên văn cho mỗi cụm.

## Bước 2 — Quyết định của người (KHÔNG để agent tự quyết)

Với mỗi cụm, hỏi:
1. Ý đằng sau các câu này có phải một capability hiện có không?
   - **Có** → thêm keyword/trigger vào nhóm đó (bước 3a).
   - **Có nhưng skill chưa có** → nếu là business cần thật, lên kế hoạch skill
     mới (phase riêng) — KHÔNG thêm trigger trỏ vào stub chỉ để đổi mã lỗi.
   - **Không thuộc domain / cố ý không hỗ trợ** (vd "xóa khách hàng") →
     KHÔNG làm gì; UNKNOWN_INTENT là câu trả lời đúng, cụm này chỉ là nhiễu
     (nhật ký để đối chiếu sau này khi hỏi lại).
2. Thêm trigger có **ăn cắp** câu của nhóm khác không? Kiểm bằng probe:
   `routeIntent('<câu của nhóm khác>')` trước/sau khi sửa. Đặc biệt cẩn thận
   với nhóm customer (broad, đứng cuối) — bài học result9 ("còn bao nhiêu"
   từng ăn cắp "còn nợ").

## Bước 3a — Sửa capabilities.json

Thêm keyword vào mảng `keywords` của group tương ứng, hoặc trigger vào
`capabilities.<id>.triggers`. Giữ style một-dòng của file (diff chỉ được
là những dòng thật sự đổi — luật numstat của result46 §6b).

## Bước 3b — Bổ sung golden case

`test/golden/golden-dataset.json`: chèn case mới ngay sau khối bucket tương
ứng, id đánh dấu phụ (r24a/r24b…). Mỗi trigger mới PHẢI có ít nhất 1 case
golden khoá hành vi mới, nếu không có regression nào bảo vệ nó.

## Bước 4 — Regression gate

```bash
cd mcp-erpnext
env -u ERPNEXT_URL -u ERPNEXT_API_KEY -u ERPNEXT_API_SECRET node --test
# → golden + classifier regression phải xanh; suite không regress
```

Đỏ ở đâu → sửa trigger (hoặc bỏ quyết định), KHÔNG nới assertion cho vừa.

## Bước 5 — Commit

Commit như mọi thay đổi contract (message kiểu
`feat: add "<trigger>" trigger to <group> — from learning cluster round N`).
File log `learning-log/` KHÔNG bao giờ được commit (gitignored).

## Bảo vệ có sẵn

| Bảo vệ | Ở đâu |
|---|---|
| Log không bao giờ làm vỡ câu trả lời | `learning-log.mjs` never-throw (test §2) |
| Log không vào git | `.gitignore` `learning-log/` (test §5) |
| Log không nằm /tmp (bài học result31 audit bị dọn) | mặc định `<repo>/learning-log/`, đổi được bằng `LEARNING_LOG_DIR` |
| Tắt log khi cần (vd môi trường audit) | env `LEARNING_LOG=off` |
| Script cluster chỉ ĐỌC, không sửa contract | `scripts/learning-cluster.mjs` không có đường ghi nào về capabilities.json |
| Text trong log bị chặn 500 ký tự | `learning-log.mjs` MAX_TEXT_LEN |
| Mọi timestamp UTC | `new Date(now).toISOString()` — đối chiếu audit luôn quy về UTC |
