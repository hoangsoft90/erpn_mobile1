# Demo — thu tiền tạo phiếu NHÁP (Phase 7 + 9, không submit)

> Runbook 1 trang cho buổi demo. Toàn bộ luồng: hỏi nợ → "thu tiền cho <khách> <số>" →
> proposal HIGH → xác nhận → phiếu thu **NHÁP** trên ERPNext (docstatus 0 — **KHÔNG
> submit**; công nợ chỉ đổi khi người thật submit trên UI ERPNext).
> Tài liệu chỉ tham chiếu **tên biến** (`<key>`/`<secret>` trong `.env`, git-ignored) —
> không dán giá trị thật vào đây. Cấu trúc 3 terminal giống `mcp-erpnext/LOCAL-TEST.md`.

## 0. Chuẩn bị (1 lần)

- `.env` ở repo root có: `ERPNEXT_URL` + `ERPNEXT_API_KEY` + `ERPNEXT_API_SECRET`
  (đủ cả 3 → ERPNext thật; thiếu hoàn toàn → mock; thiếu một phần → http-ask **từ chối start**).
- App Flutter: build APK với `--dart-define=COPILOT_BASE_URL=https://erpn8788.loca.lt`
  (CI đã làm qua repo Variables/Secret) — hoặc demo bằng curl ở mục 3.

## 1. Terminal 1 — NLP service (từ repo root)

```bash
python3 -m nlp_service.server
```
Chờ: `{"ready": true, "port": 8787}`

## 2. Terminal 2 — http-ask (từ `mcp-erpnext/`)

```bash
cd mcp-erpnext
set -a; source ../.env; set +a   # nạp ERPNEXT_* (KHÔNG echo giá trị)
npm run start:ask
```
Chờ: `{"ready":true,"port":8788,"host":"127.0.0.1","auth":false}`

## 3. Verify local (trước khi mở tunnel)

```bash
# 3a. Hỏi nợ (đọc)
curl -s -X POST http://127.0.0.1:8788/ask \
  -H "Content-Type: application/json" \
  -d '{"text":"chị Lan còn nợ bao nhiêu"}'
# → answer "…còn nợ <số>đ (N chứng từ chưa thanh toán)"

# 3b. Lệnh thu tiền (GHI) — trả proposal create_payment_entry / HIGH
curl -s -X POST http://127.0.0.1:8788/ask \
  -H "Content-Type: application/json" \
  -d '{"text":"thu tiền cho chị Lan 500 ngàn"}'
# → result.proposal: action=create_payment_entry, risk=HIGH,
#   params.amount_vnd=500000, created_at (TTL 10 phút)
```

## 4. Xác nhận ghi phiếu NHÁP (lấy từ 3b)

```bash
CID=$(node -p 'require("node:crypto").randomUUID()')   # command_id mới MỖI proposal mới; giữ nguyên khi retry (uuidgen không có sẵn trên host — dùng node)
curl -s -X POST http://127.0.0.1:8788/execute \
  -H "Content-Type: application/json" \
  -d "{\"command_id\":\"$CID\",\"proposal\":<dán nguyên proposal từ 3b>}"
# → {"ok":true,"replay":false,"result":{"erpnext_doc":"ACC-PAY-…","paid_vnd":500000}}
# Phiếu trên ERPNext = DRAFT (docstatus 0). Trên app: bấm nút [Xác nhận thu tiền].
```

- **Bấm lại cùng card** (mất mạng, thiếu phản hồi) → gửi lại **cùng** `command_id`
  → `"replay":true` — KHÔNG bao giờ ghi phiếu thứ hai.
- **Huỷ ý định chưa ghi** (zombie PENDING):
  `curl -X POST .../execute/cancel -d '{"command_id":"<CID>"}'` — chỉ huỷ khi
  chưa có chứng từ nào trên ERPNext (server tự đối soát, trả 409 nếu đã ghi).

## 5. Kịch bản STALE / EXPIRED (điểm nhấn an toàn)

- **STALE**: sau bước 3b, đổi nợ của khách đó (thu/xuất trên UI ERPNext) rồi mới
  xác nhận → `409 PROPOSAL_STALE` + `problems[]` ("nợ đã đổi từ X sang Y…") —
  **KHÔNG ghi**, app hiện banner 🔄 thay nút xác nhận.
- **EXPIRED**: chờ quá 10 phút (TTL) rồi xác nhận → `409 PROPOSAL_EXPIRED` —
  banner ⏰, phải hỏi lại để có proposal mới trên số liệu hiện tại.
- **Không clamp im lặng**: số lệch = từ chối + lý do, không bao giờ ghi số khác
  số user đã xác nhận.

## 6. Kết thúc demo

- Phiếu NHÁP demo: giữ lại làm bằng chứng hoặc xoá tay trên UI ERPNext —
  **agent không tự submit/cancel/delete** (không có đường nào trong code).
- KHÔNG submit phiếu thu trong demo — submit là quyết định của user (công nợ
  chỉ đổi khi submit).
