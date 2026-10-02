# Runbook vận hành — ERPNext Vietnamese Voice Copilot

> Dành cho NGƯỜI VẬN HÀNH (owner / người trực máy chủ), không cần đọc code.
> Bám theo code thật: `mcp-erpnext/src/http-ask.mjs`, `nlp_service/server.py`,
> `mcp-erpnext/src/kill-switch.mjs`, `.github/workflows/android-debug-apk.yml`.
> Phase 10 — deployment & ops readiness.

## 0. Thành phần & cổng

| Thành phần | Lệnh | Cổng | Ghi chú |
|---|---|---|---|
| NLP bridge (Python) | `PYTHONPATH=src python3 -m nlp_service.server --port 8787` | 8787 | stdlib, **chỉ bind `127.0.0.1`** (khoá trong code) |
| Gateway copilot (Node) | `node mcp-erpnext/src/http-ask.mjs --port 8788` | 8788 | mặc định bind `127.0.0.1`; non-loopback **bắt buộc** auth |
| LLM router (tuỳ chọn, chế độ AI) | `node scripts/llm-router.mjs` | 8900 | chỉ cần cho "Phân tích bằng AI" |
| App Flutter | APK (CI build) | — | trỏ tới gateway qua `COPILOT_BASE_URL` |

**Ranh giới ERPNext**: gateway đọc/ghi ERPNext bằng `ERPNEXT_URL` + token trong `.env`.
Backup ERPNext **thuộc owner site**, không thuộc repo này.

> **Credential ERPNext (từ 2026-10-01)**: gateway **KHÔNG** còn chạy bằng `Administrator`.
> `.env` dùng user riêng **`ai-copilot@<site-host>`** — System User, **đúng 4 role**
> (`Sales User` · `Purchase User` · `Stock User` · `Accounts User`), không Manager/System Manager.
> Nếu cần gán lại role/sinh key: dùng **creds admin** (bản `.env.bak.*` đầu tiên) — user giới hạn
> **không** đọc được `Has Role` và **403** ở `generate_keys` (đúng thiết kế).

**Kênh deploy hiện tại (2026-10-01)** — gateway chạy trên **Mac của owner**, mở qua **Tailscale**:
`http://mac-mini-ca-hoang.tail54c58.ts.net:8788`. Tailscale đã mã hoá transport (WireGuard) nên
**không cần reverse proxy/TLS riêng**; **điện thoại phải nằm trong tailnet**. CI nhúng endpoint
vào APK qua GitHub variable `COPILOT_BASE_URL`; auth là `COPILOT_AUTH_USER` (var) +
`COPILOT_AUTH_PASSWORD` (secret), **khớp** `ASK_USER`/`ASK_PASSWORD` của gateway.
⚠️ Gateway phải bind **non-loopback** (`--host 0.0.0.0` hoặc IP Tailscale), nếu không điện thoại
không tới được; non-loopback **bắt buộc** có `ASK_USER`/`ASK_PASSWORD` (≥8 ký tự).

## 1. Khởi động / dừng

```bash
cd <repo>

# (một lần) nạp biến môi trường — KHÔNG in giá trị ra màn hình/chat
set -a; source .env; set +a

# NLP (nền, đọc vẫn cần)
PYTHONPATH=src python3 -m nlp_service.server --port 8787 &

# Gateway — loopback (chỉ dùng trong máy dev):
node mcp-erpnext/src/http-ask.mjs --port 8788

# Gateway — mở cho máy thật trong LAN/VPS (BẮT BUỘC có auth):
ASK_USER=<user> ASK_PASSWORD=<>=8 ký tự> \
  node mcp-erpnext/src/http-ask.mjs --port 8788 --host <IP-LAN>
```

Dừng: `Ctrl-C`, hoặc `pkill -f "http-ask.mjs"` / `pkill -f "nlp_service[.]server"`.
Dòng báo khởi động in ra host/port/auth + nhãn ERPNext target (`REAL`/`MOCK`).

> **Bẫy**: `ASK_USER`/`ASK_PASSWORD` cạnh bind **loopback** ⇒ server **từ chối chạy**
> (cố ý). Non-loopback mà thiếu auth ⇒ **cũng từ chối** chạy (không bao giờ mở công khai
> không xác thực). Đây là code, không phải quy ước.

## 2. Kiểm tra sức khoẻ

```bash
curl -s http://127.0.0.1:8788/health          # {"ok":true,"service":"copilot-ask","port":8788}
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8787/health   # 200
# non-loopback: MỌI route (kể cả /health) cần basic auth
curl -s -u "$ASK_USER:$ASK_PASSWORD" https://<host>/health

# chế độ AI (nếu dùng): runtime + patch thật
curl -s -u "$ASK_USER:$ASK_PASSWORD" https://<host>/dsh/health
```

Trên app: **Cài đặt → "Kiểm tra kết nối"** gọi đúng `/health` và báo OK/lỗi ngay,
không cần lưu trước.

## 3. Đổi endpoint (không build lại app)

Hai nguồn, ưu tiên: **giá trị đã lưu trong Cài đặt** > **`--dart-define=COPILOT_BASE_URL`** (CI).

- **Trên máy người dùng**: Cài đặt → Gateway URL (+ auth) → Lưu (áp dụng ngay, không restart).
- **Cho bản phát hành**: CI (**GitHub → Settings → Variables/Secrets**) truyền
  `vars.COPILOT_BASE_URL` (+ `vars.COPILOT_AUTH_USER`, `secret.COPILOT_AUTH_PASSWORD`)
  vào `--dart-define` khi build. **Repo hiện 0/0 ⇒ APK rơi về loopback** (xem §8).
- **Không** hardcode endpoint vào repo; **không** dùng tunnel dev (localtunnel) làm production
  (URL đổi theo phiên, không SLA).

## 4. Bảo vệ gateway (tối thiểu)

- Non-loopback ⇒ **bắt buộc basic auth** (`ASK_USER` + `ASK_PASSWORD` ≥ 8 ký tự) cho **mọi** route.
- `/execute` là **cửa GHI duy nhất** — không mở route ghi thứ hai, không nới CORS/rate để "cho dễ test".
- TLS: đặt sau reverse proxy (nginx/Cloudflare…) — **ai giữ chứng chỉ, cách gia hạn do owner chốt**
  (Phase này chưa cấu hình; verify trên máy thật trước khi phát hành).
- Log: **không** chứa secret/PII; có correlation id xuyên `/ask → /execute → job`.

## 5. Kill switch (chặn ghi trong vài giây)

Runbook đầy đủ: [`kill-switch-runbook.md`](kill-switch-runbook.md). Tóm tắt:

```bash
touch mcp-erpnext/control/read-only.flag    # BẬT: ghi bị 503 SYSTEM_MAINTENANCE, đọc vẫn chạy
rm    mcp-erpnext/control/read-only.flag    # TẮT (lệnh đang chờ tự chạy lại)
```

Mọi lần bật/tắt **phải ghi biên bản** (thời điểm, lệnh, kết quả — mẫu ở
`.plan/next8/_kill_switch_drill_minutes.json`). Drill Phase 10: **PASS** (OFF→ghi 200 ·
ON→503 SYSTEM_MAINTENANCE · đọc 200 · OFF→ghi 200).

## 6. Khi có lỗi 500 / app không trả lời

1. `/health` của gateway + NLP còn sống không? (401 ⇒ thiếu auth; 000 ⇒ process chết)
2. Gateway in nhãn ERPNext target: `REAL` hay `MOCK`? `MOCK` ⇒ thiếu/sai `ERPNEXT_*` (§ ERR).
3. ERPNext có tới được không (§8 checklist).
4. Xem stderr gateway (mã lỗi thật, không stack) — **không dán nội dung `.env` vào đâu**.
5. Nếu là lỗi GHI: gửi lại **đúng `command_id` cũ** (idempotency) — không tạo lệnh mới để "thử lại".

## 7. Rollback

- **App**: quay lại APK artifact trước (GitHub Actions → run → artifact `erpn-chat-debug-apk`).
- **Code**: `git revert <sha>` (không `reset --hard`, không force-push).
- **Ghi chứng từ**: chứng từ do app tạo là **NHÁP** ⇒ huỷ/xoá có kiểm soát trên ERPNext;
  đối soát theo `custom_ai_action_id` / `reference_no`, **không theo tên** (tên chứng từ bị tái dùng).

## 8. Backup / restore cấu hình (ai giữ, ở đâu)

| Thứ | Ai giữ | Ở đâu | Tần suất |
|---|---|---|---|
| `.env` máy chủ (secret) | owner | máy chủ, `chmod 600`, **ngoài repo** | khi đổi credential |
| `control/` (kill-switch flag) | người vận hành | máy chủ, git-ignored | — |
| APK artifact | owner | GitHub Actions artifacts | theo mỗi bản phát hành |
| ERPNext | **owner site** | hệ thống backup của site | ranh giới owner |

**Diễn tập restore cấu hình gateway** (backup chỉ đáng tin khi restore được): copy `.env`
(+ `control/`) ra chỗ an toàn, khôi phục vào máy chủ, khởi động lại, `/health` = 200.

## 9. Quan sát & ngưỡng

- `/health` các dịch vụ · số job tồn (`GET /jobs`) · tỉ lệ 4xx/5xx trên stderr gateway.
- **Khi nào bật kill switch**: nghi ngờ ghi sai / ERPNext bảo trì / đổi credential —
  bật là dừng ghi ngay, đọc vẫn phục vụ.

## 10. Việc CÒN BLOCK trước khi phát hành (chờ owner)

Xem `.plan/next8/phase10-result.md` §BLOCK. Tóm tắt: **URL máy chủ thật** (chưa có ⇒ không bịa),
**GitHub vars/secrets** (đang 0/0), **rotate credential ERPNext** (từng lộ qua chat),
**TLS/reverse proxy** (ai giữ), **user ERP riêng** (gateway đang chạy bằng `Administrator`).

## 11. Liên hệ

Do **owner dự án** quyết định (Phase này chưa có thông tin liên hệ chính thức — ghi TODO).
