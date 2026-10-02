# Kill-switch runbook (vận hành, không cần deploy)

> Mục đích: **chặn MỌI lệnh ghi trong vài giây** mà không cần sửa code/deploy, trong khi phần ĐỌC
> vẫn chạy bình thường. Đây là công cụ vận hành (plan2_final §24.3), không phải feature flag.
> Toàn bộ nội dung dưới đây bám theo code thật: `mcp-erpnext/src/kill-switch.mjs`,
> `mcp-erpnext/src/safety-gateway.mjs`, `mcp-erpnext/capabilities.json`.

## 1. Bật/tắt

| Mức | Cách bật | Hiệu lực | Gỡ |
|---|---|---|---|
| **global_read_only** (toàn hệ thống) | `touch mcp-erpnext/control/read-only.flag` | **NGAY** — cờ được đọc lại mỗi request (không cache) | `rm mcp-erpnext/control/read-only.flag` |
| global_read_only (qua env) | `COPILOT_GLOBAL_READ_ONLY=1` (nhận `1/true/yes/on`, không phân biệt hoa thường) | từ lúc **process khởi động** — env là biến của process, đổi env phải restart gateway | bỏ biến + restart |
| **disable_capability** (một capability) | `COPILOT_DISABLE_CAPABILITIES=payment.create` (nhiều thì ngăn bằng dấu phẩy) | như trên (theo process) | bỏ tên khỏi danh sách + restart |

`mcp-erpnext/control/` **đã nằm trong `.gitignore`** (dòng 66) ⇒ file cờ không bao giờ lọt vào commit.
Nếu muốn tác động tức thì mà không restart: **dùng flag file**, không dùng env.

## 2. Kỳ vọng khi đang bật

| Đường | Khi bảo trì |
|---|---|
| `GET /health` | vẫn 200 |
| `POST /ask` (ĐỌC) | **vẫn trả lời bình thường** (chỉ đọc) |
| `POST /execute` (GHI) | **503** `{"ok":false,"code":"SYSTEM_MAINTENANCE","level":"global_read_only","error":"…chế độ CHỈ ĐỌC…"}` |
| `POST /execute` với capability bị tắt | **503** `{"code":"CAPABILITY_DISABLED","level":"disable_capability",…}` |
| `POST /execute/cancel` | **vẫn chạy** — đây là NHẢ KHOÁ (đã đối soát ERPNext), không phải ghi; chặn nó sẽ đóng băng ý định mãi mãi |
| `command_id` của request bị từ chối | **KHÔNG bị tiêu tốn** — kill switch kiểm TRƯỚC cổng idempotency ⇒ tắt bảo trì rồi gửi lại ĐÚNG `command_id` đó là được |
| Lệnh đang EXECUTING lúc bật | hoàn thành nốt (không có lệnh nào bị cắt giữa chừng) |

## 3. Xác minh (chạy thật, không tin cảm giác)

```bash
# 1) bật
touch mcp-erpnext/control/read-only.flag

# 2) ĐỌC vẫn phải sống (đổi host/tunnel cho đúng môi trường)
curl -s -X POST http://127.0.0.1:8788/ask -H 'Content-Type: application/json' \
  -d '{"text":"chị Lan còn nợ bao nhiêu"}' | head -c 300

# 3) GHI phải bị từ chối 503 SYSTEM_MAINTENANCE (dùng command_id + proposal THẬT của bạn)
curl -s -o /tmp/ks.json -w '%{http_code}\n' -X POST http://127.0.0.1:8788/execute \
  -H 'Content-Type: application/json' \
  -d '{"command_id":"<uuid>","proposal":{...}}'
cat /tmp/ks.json     # phải thấy code SYSTEM_MAINTENANCE

# 4) audit: mỗi lần switch "cắn" đều ghi 1 dòng stderr của gateway
#    [kill-switch] <UTC ISO> SYSTEM_MAINTENANCE capability=payment.create source=safety-gateway

# 5) tắt
rm mcp-erpnext/control/read-only.flag
```

Test đã khoá sẵn các hành vi này (không cần diễn tập thủ công để tin code):
`mcp-erpnext/test/safety-gateway.test.mjs` — "kill switch: global_read_only refuses a NEW write with
SYSTEM_MAINTENANCE and burns nothing" + case flag-file + case `off` không được trip.

## 4. ⚠️ Tương tác với job queue (P7) — ĐỌC TRƯỚC KHI BẬT LÚC CÓ VIỆC ĐANG CHỜ

Job đang `QUEUED`/`RETRYING` mà bảo trì bật ⇒ lần retry kế tiếp nhận 503 `SYSTEM_MAINTENANCE`.
Verdict này **không** kèm `retry_same_command_id`, nên `JobQueue.drain()` coi là **non-retryable**:

```
$ node /tmp/probe    # probe trực tiếp trên JobQueue
outcome sau 1 lần drain khi bảo trì: [{"command_id":"cmd-f7","state":"FAILED","error":"hệ thống đang ở chế độ CHỈ ĐỌC..."}]
state: FAILED | attempts: 1
là terminal (không retry nữa)? true
```

Nghĩa là: **job chuyển FAILED ngay sau 1 lần bị chặn (không dùng hết 5 lượt), và không tự retry nữa.**
Ghi nhận (finding **F7**, 2026-09-18): `/jobs` gọi đó là "FAILED" dù **chưa từng thử ghi** — nhãn gây
hiểu sai, và ý định đã xác nhận bị dừng retry bởi một tình trạng CỐ Ý và TẠM THỜI. An toàn tiền KHÔNG
bị ảnh hưởng: chưa có gì được ghi, store không có record, nên người dùng bấm lại ĐÚNG `command_id`
sau bảo trì là chạy đúng 1 lần.

**✅ ĐÃ GIẢI QUYẾT — policy (a), chủ dự án chọn 2026-09-18: bảo trì KHÔNG phải một lần thử.**
- Lệnh trong hàng gặp kill switch ⇒ ở lại **RETRYING**, **không tiêu lượt thử**, **không FAILED**
  (refusal của kill switch xảy ra TRƯỚC khi thử ghi — bước 4 của gateway, trước freshness/idempotency).
- Tắt bảo trì xong, **lần drain kế tiếp tự nhặt lệnh lên chạy** (polling có sẵn của runner) —
  **không cần bấm lại `command_id` thủ công**. Verdict đúng 1 lần VERIFIED (test `result53.txt`).
- Hành vi GHI THẬT LỖI không đổi: verdict non-retryable (vd `PROPOSAL_STALE`) vẫn FAILED-terminal.
- Mã thuộc nhóm refusal tạm thời: `SYSTEM_MAINTENANCE` · `CAPABILITY_DISABLED`
  (`isTemporaryRefusal()` trong `job-queue.mjs`; JSONL ghi sự kiện `TEMPORARY_REFUSAL`).
- Cách vận hành giờ đây: bật bảo trì ⇒ **ghi lại giờ**; tắt xong ⇒ không phải làm gì thêm —
  runner tự chạy lại. Chỉ cần kiểm `/jobs` để xác nhận lệnh chuyển VERIFIED/FAILED đúng nghĩa.

## 5. Không thuộc phạm vi runbook này

- PII / Nghị định 13: xem `SIGNOFF-phase5-pii.md` (đã ký: không scrub).
- Backup/restore command store (P10 full) — chưa làm.
