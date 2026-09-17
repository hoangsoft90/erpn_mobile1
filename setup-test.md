# setup-test.md — Cài đặt · Cấu hình · Test

> Cẩm nang cho người mới clone repo: cài gì, cấu hình gì, chạy gì, test gì —
> theo **đúng** các lệnh đã verify trong repo (không phải lệnh "thường thì như vậy").
>
> ⚠️ **KHÔNG BAO GIỜ** dán giá trị thật của API key/secret/password vào file này,
> vào log, hay vào commit. Tài liệu chỉ nêu **TÊN biến**; giá trị thật nằm trong
> `.env` ở repo root (đã git-ignored) hoặc GitHub Settings.
>
> Đọc kèm: `mcp-erpnext/LOCAL-TEST.md` (quy trình 3 terminal) ·
> `docs/demo-payment-draft.md` (demo luồng ghi nháp) ·
> `docs/device-test-checklist.md` (test APK trên máy thật) ·
> `faq.md` (các câu hỏi dễ hiểu sai).

## 0. TL;DR — quickstart

```bash
# Cài
cd mcp-erpnext && npm ci
cd ../apps/mobile && flutter pub get && dart run build_runner build --delete-conflicting-outputs
cd ../..

# Test (không cần credential, không cần mạng)
PYTHONPATH=src python3 -m unittest discover -s tests      # Python
cd mcp-erpnext && npm test                               # Node (mcp-erpnext)
cd .. && node --test scripts/test/*.test.mjs             # Node (LLM router, 19 test)
cd apps/mobile && flutter test && flutter analyze        # Flutter

# Chạy dev (3 terminal — xem §4)
python3 -m nlp_service.server                            # T1: nlp 8787
cd mcp-erpnext && npm run start:ask                      # T2: http-ask 8788
lt -s erpn8788 --port 8788                               # T3: tunnel (tuỳ chọn)
```

## 1. Yêu cầu môi trường

| Thành phần | Yêu cầu | Đã verify trên |
|---|---|---|
| Python | **>= 3.10** (stdlib-only, **không cần pip install gì**) | 3.12.3 |
| Node.js | **>= 20** (`engines` của `mcp-erpnext/package.json`) | v24.20.0 |
| npm | đi kèm Node | 12.0.2 |
| Flutter | stable (Dart >= 3.x) — chỉ cần khi build/kiểm client | 3.47.2 stable |
| localtunnel | chỉ khi cần public endpoint cho APK (`npm i -g localtunnel`) | — |
| Java | 21 (chỉ cho CI build APK; không cần khi dev) | 21 (CI) |

Bốn lớp của hệ thống:

```
Flutter app / dsh ──► http-ask (Node, 8788) ──► mcp-erpnext skill layer ──► ERPNext
                              │
                              └──► nlp_service (Python, 8787) = vietnamese_nlp
```

- `src/vietnamese_nlp/` — chuẩn hoá tiếng Việt (số tiền, danh xưng, synonym). Thuần
  stdlib, không LLM, không mạng.
- `nlp_service/server.py` — cầu nối HTTP nội bộ Python ↔ Node (quyết định đã LOCKED:
  localhost HTTP, không port sang Dart, không subprocess).
- `mcp-erpnext/` — skill layer + MCP server + `http-ask.mjs` (REST wrapper) +
  idempotency store.
- `scripts/llm-router.mjs` — gateway OpenAI-compatible cho dsh (Phase 5).
- `apps/mobile/` — client Flutter (chat + proposal card).

## 2. Cài đặt

### 2.1 Python (không cần cài)

```bash
python3 -V                       # cần >= 3.10
PYTHONPATH=src python3 -m vietnamese_nlp "Anh Nam trả 10 triệu"   # smoke test
```

Không có `pip install -r requirements.txt` — cố ý zero-dependency. `pytest` chạy
được nếu máy có sẵn, nhưng runner chính là `unittest` (stdlib).

### 2.2 Node — skill layer + MCP

```bash
cd mcp-erpnext
npm ci            # cài đúng lockfile; pin @casys/mcp-erpnext@3.0.4
npm test          # node --test
```

### 2.3 Flutter — client

```bash
cd apps/mobile
flutter pub get
dart run build_runner build --delete-conflicting-outputs   # BẮT BUỘC
flutter test
flutter analyze
```

> **`*.g.dart` bị gitignore** (`.gitignore` dòng `*.g.dart`) ⇒ máy mới clone **phải**
> chạy `build_runner`, nếu không `flutter analyze`/`test` sẽ báo hàng loạt lỗi
> undefined provider. CI cũng có step này (`.github/workflows/android-debug-apk.yml`).

### 2.4 localtunnel (chỉ khi cần endpoint public)

```bash
npm i -g localtunnel
lt -s erpn8788 --port 8788
```

## 3. Cấu hình

### 3.1 `.env` ở repo root (git-ignored)

Tạo file `.env` tại **repo root** với các **tên biến** sau (giá trị do bạn tự điền —
`<key>`, `<secret>` là placeholder, không phải giá trị thật):

| Nhóm | Tên biến | Bắt buộc | Ý nghĩa |
|---|---|---|---|
| ERPNext target | `ERPNEXT_URL` | tuỳ chọn* | Base URL ERPNext (vd host ngrok) |
| | `ERPNEXT_API_KEY` | tuỳ chọn* | API key |
| | `ERPNEXT_API_SECRET` | tuỳ chọn* | API secret |
| HTTP auth | `ASK_USER` | không | User basic-auth cho `/ask` khi bind non-loopback |
| | `ASK_PASSWORD` | không | Password basic-auth (>= 8 ký tự) |
| | `ASK_ALLOW_PUBLIC` | không | `1` mới cho phép bind public không auth |
| | `ASK_HOST` / `ASK_PORT` | không | Override host/port của http-ask |
| LLM upstream | `MAC_LLM_API_KEY` | không | Key cho upstream `mac-custom` (chain ưu tiên dev) |
| | `ZEN_API_KEY` | không | Key cho upstream `zen` |
| | `GEMINI_API_KEY` | không | Key cho upstream `gemini-openai` |
| Khác | `NLP_SERVICE_PORT` | không | Đổi cổng nlp_service (mặc định 8787) |
| | `ERPN_IDEM_DIR` | không | Đổi thư mục idempotency store |
| | `LLM_ROUTER_CONFIG` / `LLM_ROUTER_DEBUG` / `LLM_ROUTER_AUDIT_DIR` | không | Cấu hình router |
| | `GH_REPO_URL` / `GH_TOKEN` | không | Cho tooling GitHub của máy dev — **không** đoạn code nào của app đọc 2 biến này |

\* **Quy tắc chọn target (fail-closed, không fallback âm thầm):**

| Trạng thái 3 biến `ERPNEXT_*` | Kết quả |
|---|---|
| **Đủ cả 3** | Dùng **ERPNext thật** |
| **Thiếu hoàn toàn** | Dùng **mock server** (an toàn cho test/CI) |
| **Thiếu một phần** | http-ask **từ chối start** (lỗi ngay, KHÔNG âm thầm dùng mock) |

Nạp `.env` vào shell khi chạy http-ask:

```bash
set -a; source ../.env; set +a     # KHÔNG echo giá trị ra màn hình/log
```

### 3.2 HTTP auth của `http-ask`

- Bind `127.0.0.1` (mặc định) → **không cần auth**.
- Bind non-loopback → **BẮT BUỘC** có `ASK_USER` + `ASK_PASSWORD`; server tự từ chối
  cấu hình thiếu auth (đúng thiết kế — xem `result11.txt` §5).
- Muốn public không auth phải set `ASK_ALLOW_PUBLIC=1` (không khuyến nghị: có tên
  khách + số tiền công nợ thật đi qua).

### 3.3 LLM Router (`scripts/`)

| File | Dùng khi |
|---|---|
| `llm-router.config.json` | Chạy thật (chain: `mac-custom` → `mock` → `zen` → `gemini-openai`) |
| `llm-router.e2e.json` | Verify E2E (chọn upstream qua `E2E_LLM_MODEL`) |
| `llm-router.mock.json` | Chạy 0-quota / test (upstream mock) |

Vai trò 2 upstream chính (xem `_note` trong config):

- **`mac-custom`** (`oc/big-pickle`, key `MAC_LLM_API_KEY`) — **dev/test hàng ngày**,
  không tốn quota provider. ⚠️ Router **lọc chain theo `model`** ⇒ request phải xin
  đúng tên model mới tới được upstream này.
- **`gemini-openai`** (key `GEMINI_API_KEY`) — **verify tương thích provider thật**
  trước production (`thought_signature`…). Free tier **RPD=20** ⇒ KHÔNG dùng để dev
  hàng ngày; 429/503 trong free tier là bình thường, không phải bug.

Chạy router:

```bash
node scripts/llm-router.mjs                      # 127.0.0.1:8900, config mặc định
node scripts/llm-router.mjs --config scripts/llm-router.e2e.json
node --test scripts/test/*.test.mjs              # unit test router (19 test)
```

### 3.4 Flutter — `--dart-define`

```bash
cd apps/mobile
flutter run \
  --dart-define=COPILOT_BASE_URL="https://erpn8788.loca.lt" \
  --dart-define=COPILOT_AUTH_USER="copilot" \
  --dart-define=COPILOT_AUTH_PASSWORD="<giá trị từ .env ASK_PASSWORD>"
```

CI build APK đọc từ **GitHub Settings** (không hardcode):

| Loại | Tên | Ý nghĩa |
|---|---|---|
| Variables | `COPILOT_BASE_URL` | Endpoint app gọi (vd `https://erpn8788.loca.lt`) |
| Variables | `COPILOT_AUTH_USER` | User basic-auth |
| Secrets | `COPILOT_AUTH_PASSWORD` | Password basic-auth (>= 8 ký tự) |

Kiểm tra app đang trỏ đâu: footer trên màn hình chat hiển thị `COPILOT_BASE_URL`.

## 4. Chạy dev — 3 terminal (thứ tự BẮT BUỘC, không đảo)

| Terminal | Lệnh | Cổng | Dòng sẵn sàng |
|---|---|---|---|
| T1 | `python3 -m nlp_service.server` (từ repo root) | 8787 | `{"ready": true, "port": 8787}` |
| T2 | `cd mcp-erpnext && npm run start:ask` | 8788 | `{"ready":true,"port":8788,"host":"127.0.0.1","auth":false}` |
| T3 | `lt -s erpn8788 --port 8788` (tuỳ chọn) | — | `your url is: https://erpn8788.loca.lt` |

Thứ tự: **T1 sẵn sàng → T2 sẵn sàng → curl local OK → mở tunnel → curl tunnel OK →
mới chạy Flutter**. (Chi tiết + biến thể: `mcp-erpnext/LOCAL-TEST.md`.)

## 5. Test

### 5.1 Unit — 4 bộ (không cần credential, không cần mạng)

```bash
# Python — vietnamese_nlp (60 test)
PYTHONPATH=src python3 -m unittest discover -s tests     # chạy từ REPO ROOT

# Node — skill layer + http-ask + idempotency (120 test)
cd mcp-erpnext && npm test

# Node — LLM router (19 test)
node --test scripts/test/*.test.mjs      # hoặc: cd scripts && node --test

# Flutter — widget/model/controller (34 test)
cd apps/mobile && flutter test && flutter analyze
```

> ⚠️ **Python phải chạy từ repo root** với `PYTHONPATH=src`. Chạy từ `apps/mobile`
> sẽ báo lỗi import — đó là sai cwd, không phải code lỗi.

### 5.2 Kiểm nhanh lớp NLP (CLI)

```bash
PYTHONPATH=src python3 -m vietnamese_nlp "Anh Nam trả 10 triệu 500 nghìn"
PYTHONPATH=src python3 -m vietnamese_nlp --pretty "Cô Ba mua 20 bao cám 25 ký, còn nợ 5 triệu"
echo "Bác Hai trả 2tr5" | PYTHONPATH=src python3 -m vietnamese_nlp
```

### 5.3 E2E qua HTTP (dùng mock hoặc ERPNext thật theo `.env`)

```bash
curl -s http://127.0.0.1:8788/health
# → {"ok":true,"service":"copilot-ask","port":8788}

# Đọc (an toàn)
curl -s -X POST http://127.0.0.1:8788/ask \
  -H "Content-Type: application/json" \
  -d '{"text":"chị Lan còn nợ bao nhiêu"}'

# Lệnh GHI → chỉ trả PROPOSAL (chưa ghi gì)
curl -s -X POST http://127.0.0.1:8788/ask \
  -H "Content-Type: application/json" \
  -d '{"text":"thu tiền cho chị Lan 500 ngàn"}'
# → result.proposal: action=create_payment_entry, risk=HIGH, params.amount_vnd=500000

# Xác nhận → phiếu thu NHÁP (docstatus 0)
CID=$(node -p 'require("node:crypto").randomUUID()')
curl -s -X POST http://127.0.0.1:8788/execute \
  -H "Content-Type: application/json" \
  -d "{\"command_id\":\"$CID\",\"proposal\":<dán nguyên proposal ở trên>}"

# Huỷ ý định chưa ghi (chỉ khi đã đối soát 0 chứng từ)
curl -s -X POST http://127.0.0.1:8788/execute/cancel \
  -H "Content-Type: application/json" -d "{\"command_id\":\"$CID\"}"
```

Qua tunnel thì thêm header `bypass-tunnel-reminder: 1` (không có → localtunnel trả
trang reminder/502, dễ nhầm là service chết).

Kịch bản an toàn để test tay (chi tiết `docs/demo-payment-draft.md` §5):

| Kịch bản | Cách làm | Kỳ vọng |
|---|---|---|
| Replay | gửi `/execute` lần 2 với **cùng** `command_id` | `"replay":true`, KHÔNG có phiếu thứ 2 |
| STALE | tạo proposal → đổi nợ trên ERPNext → xác nhận | `409 PROPOSAL_STALE` + `problems[]`, không ghi |
| EXPIRED | để quá TTL 10 phút rồi xác nhận | `409 PROPOSAL_EXPIRED`, không ghi |
| Cancel zombie | `/execute/cancel` cho PENDING | huỷ được nếu 0 chứng từ; `409` nếu đã ghi |

### 5.4 E2E qua dsh (agent runtime)

dsh gọi skill layer qua MCP (stdio) — cấu hình ở `mcp-erpnext/dsh.cordis.patch.yml`
(verify: `mcp-erpnext/dsh-e2e.patch.yml`). Cách cài/khôi phục dsh: xem skill skill
`erpn-dsh-setup`. Driver in transcript JSON-RPC nguyên văn (không cần dsh):

```bash
python3 -m nlp_service.server &                       # hoặc NLP_SERVICE_PORT=...
node scripts/ask-copilot.mjs "chị Lan còn nợ bao nhiêu"
node scripts/ask-copilot.mjs --raw "..."              # kèm dòng JSON-RPC thô
```

LLM mock để smoke 0-quota: `node scripts/mock-llm.mjs` (port `MOCK_LLM_PORT`, mặc định 8899).

### 5.5 APK trên máy thật

1. CI: push lên branch → workflow `android-debug-apk` → tải artifact
   `erpn-chat-debug-apk` (cần 3 giá trị GitHub Settings ở §3.4).
2. Cài APK, test theo `docs/device-test-checklist.md` (cài → đọc → ghi nháp →
   restart/replay → STALE/EXPIRED).

## 6. Sự cố thường gặp

| Hiện tượng | Nguyên nhân thật | Xử lý |
|---|---|---|
| `npm run start:ask` **từ chối start** | `.env` thiếu **một phần** `ERPNEXT_*` | Điền đủ cả 3, hoặc bỏ hết để dùng mock |
| Qua tunnel trả HTML/502 dù local OK | localtunnel trả trang reminder | thêm header `bypass-tunnel-reminder: 1` |
| Flutter báo undefined provider hàng loạt | chưa sinh `*.g.dart` | `dart run build_runner build --delete-conflicting-outputs` |
| `flutter test` fail shader `ink_sparkle.frag` | hết dung lượng đĩa (ENOSPC) làm hỏng build cache | `flutter clean && flutter pub get`; kiểm `df -h` |
| Python unittest lỗi import | chạy sai cwd | chạy từ repo root với `PYTHONPATH=src` |
| nlp_service "chết" giữa 2 lệnh | process nền không sống qua block lệnh mới | `curl health` ở đầu block, restart trong **cùng** block, hoặc `setsid` |
| Request qua router trả 502 `all upstreams failed` | chain bị lọc theo `model` không khớp / upstream đang cooldown | xin đúng tên model (vd `oc/big-pickle`) và thử lại sau cooldown |
| Gemini 429/503 | free tier RPD=20 (thiết kế, không phải bug) | dev hàng ngày dùng `mac-custom`; verify provider thật thì chạy 1 lần/ngày |
| `node --test` treo lâu | socket/timer giữ event loop | chờ dứt điểm; test phải tự đóng server (đã xử lý trong repo) |
| Idempotency mất sau reboot | `ERPN_IDEM_DIR` trỏ vào `/tmp` (ephemeral) | để mặc định trong repo (`mcp-erpnext/idempotency-store`, gitignored) |

## 7. An toàn (không bỏ qua)

- **Vùng tiền/số/phân quyền**: thay đổi phải được người thật duyệt trước khi commit.
  Agent không tự commit vùng này.
- **Chỉ phiếu NHÁP**: mọi lệnh ghi tạo `Payment Entry` ở `docstatus 0`. **SUBMIT là
  quyết định của người dùng**, không có đường nào trong code tự submit/cancel/delete.
- **Fail-closed**: thiếu/ lệch dữ liệu ⇒ từ chối kèm lý do, không "kẹp số im lặng",
  không fallback âm thầm.
- **Replay an toàn**: cùng `command_id` ⇒ replay, không bao giờ ghi 2 lần.
- **Tunnel là public**: đóng `lt` (Ctrl-C) ngay khi test xong; không để endpoint chạy
  unattended khi đang có dữ liệu thật.
- **Không lộ secret**: check `.gitignore` (`.env`, `*.g.dart`, `idempotency-store/`,
  `llm-router-audit/`) trước khi commit; tài liệu chỉ ghi **tên biến**.

## 8. Tham chiếu chéo

| Cần gì | Đọc |
|---|---|
| Quy trình 3 terminal đầy đủ | `mcp-erpnext/LOCAL-TEST.md` |
| Demo luồng ghi nháp (kịch bản STALE/EXPIRED/replay) | `docs/demo-payment-draft.md` |
| Test APK tại điểm bán | `docs/device-test-checklist.md` |
| Câu hỏi dễ hiểu sai / hiểu nhầm | `faq.md` |
| Quyết định pháp lý Phase 5 (không PII scrub) | `SIGNOFF-phase5-pii.md` |
| Bài học lỗi đã trải qua (đọc trước khi sửa) | `.agents/skills/erpn-verify-first/SKILL.md` · `LESSONS_LEARNED.md` |
| Trạng thái hiện tại + việc tiếp theo | `working.md` · `next.md` · `checklist.md` |
