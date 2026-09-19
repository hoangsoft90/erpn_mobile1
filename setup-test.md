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
> `.plan/dsh_prompt_check.md` (topology local↔Mac + pin runtime) ·
> `human.md` (việc chỉ người thật làm được) · `faq.md` (câu hỏi dễ hiểu sai).

## 0. TL;DR — quickstart

```bash
# ── Cài ──────────────────────────────────────────────────────────────────────
cd mcp-erpnext && npm ci                                  # skill layer (@casys/mcp-erpnext@3.0.4)
cd ../apps/mobile && flutter pub get \
  && dart run build_runner build --delete-conflicting-outputs   # BẮT BUỘC (chưa có *.g.dart)
cd ../.. && npm install        # (tuỳ chọn) lấy runtime dsh đúng PIN ở package.json root

# ── Test — chạy TỪ REPO ROOT, không cần credential, không cần mạng ───────────
PYTHONPATH=src python3 -m unittest discover -s tests      # Python  — 62 test
(cd mcp-erpnext && npm test)                             # Node    — 307 test
node --test scripts/test/*.test.mjs                      # Router  — 19 test
(cd apps/mobile && flutter test && flutter analyze)      # Flutter — 150 test · analyze 0

# ── Chạy dev (các service — xem §4) ─────────────────────────────────────────
python3 -m nlp_service.server                            # 8787  NLP tiếng Việt
(cd mcp-erpnext && npm run start:ask)                    # 8788  gateway (http-ask)
node scripts/llm-router.mjs --config scripts/llm-router.mock.json   # 8900  LLM router
lt -s erpn8788 --port 8788                               # 8788  tunnel (tuỳ chọn)

# ── Kiểm tra chế độ AI/DSH (chỉ khi dùng "Phân tích bằng AI") ────────────────
npm run dsh:check          # pin + entry + version + marker cổng chặn ghi
npm run check:topology     # phiên sẽ chạy ở đâu: LOCAL_OK | REMOTE_OK | BLOCKED
npm run dsh:e2e:write-block   # câu lệnh ghi PHẢI bị từ chối trước khi chạy
```

> Số test ở trên là **số đo thật** (`result58.txt`), không phải ước lượng — nếu máy bạn ra số
> khác thì đọc tiếp: có test fail trước khi kịp khoe số.

## 1. Yêu cầu môi trường

| Thành phần | Yêu cầu | Đã verify trên |
|---|---|---|
| Python | **>= 3.10** (stdlib-only, **không cần pip install gì**) | 3.12.3 |
| Node.js | **>= 20** (`engines` của `mcp-erpnext/package.json`) | v24.20.0 |
| npm | đi kèm Node | 12.0.2 |
| Flutter | stable (Dart >= 3.x) — chỉ cần khi build/kiểm client | 3.47.2 stable |
| localtunnel | chỉ khi cần public endpoint cho APK (`npm i -g localtunnel`) | — |
| Java | 21 (chỉ cho CI build APK; không cần khi dev) | 21 (CI) |
| dsh runtime | **chỉ khi dùng chế độ "Phân tích bằng AI"** — `@deepseek-ai/dsh@0.1.5-rc.1` (pin ở `package.json` root) | 0.1.5-rc.1 |

Các lớp của hệ thống (**hai đường tách biệt — đừng trộn**):

```
Flutter app  ──►  POST /ask        (deterministic — đường CHÍNH, không bao giờ gọi dsh)
                        └──► nlp_service (Python, 8787) ──► skill layer ──► ERPNext

Flutter app (chế độ "Phân tích bằng AI", phải bật tay)
             ──►  POST /dsh/ask     (agent)  ──► dsh runtime ──► llm-router (8900) ──► LLM
                                     └──► CHỈ đọc; câu lệnh ghi bị TỪ CHỐI ngay ở gateway
```

- `/ask` trả lời theo rule/contract (nhanh, tất định, không tốn LLM). `/dsh/ask` là đường
  **agent** chỉ chạy khi người dùng chọn — và **không bao giờ** là fallback của `/ask`.

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

### 2.5 dsh runtime — CHỈ khi dùng chế độ "Phân tích bằng AI"

Gateway spawn runtime này cho mỗi phiên agent. Version **được pin** ở `package.json` root
(trước đây không pin ở đâu cả, và entry bị hardcode vào một máy ⇒ máy khác báo "khả dụng"
mà không chạy được gì).

```bash
npm install            # ở REPO ROOT — lấy đúng @deepseek-ai/dsh@0.1.5-rc.1
npm run dsh:check      # phải in RESULT: PASS và exit 0
```

`dsh:check` kiểm 6 thứ và **fail rõ ràng** (exit ≠ 0) nếu thiếu: node ≥ 20 · pin trong
`package.json` · entry tồn tại · version khớp pin · entry **chạy được** (`--version`) ·
patch có cờ `COPILOT_DSH_CONTEXT=1`. Entry được resolve từ package đã cài, không phải
đường dẫn cứng; muốn trỏ tay thì set `DSH_ENTRY`.

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

Các nhóm biến **chỉ có tác dụng khi bật tính năng tương ứng** (bỏ trống = mặc định an toàn):

| Nhóm | Tên biến | Mặc định khi bỏ trống | Ý nghĩa |
|---|---|---|---|
| Chế độ AI (DSH) | `DSH_MODE` | `local` | `local` = spawn trên máy gateway; `remote` = gọi runner trên Mac |
| | `DSH_ENTRY` / `DSH_PATCH` / `DSH_CWD` | resolve từ package / `mcp-erpnext/dsh-e2e.patch.yml` / repo root | Chỉ định tay runtime + patch + cwd |
| | `DSH_TIMEOUT_MS` / `DSH_MAX_TEXT` / `DSH_MAX_CONCURRENT` | 180000 / 2000 / 1 | Chặn phiên treo, câu quá dài, chạy chồng |
| | `DSH_SESSION_TTL_MS` / `DSH_MAX_SESSIONS` / `DSH_HOME_BASE` | 30 phút / 200 / tmpdir | Nhớ ngữ cảnh hội thoại + chặn phình bộ nhớ |
| | `DSH_REMOTE_URL` / `DSH_REMOTE_TOKEN_ENV` | — / `DSH_REMOTE_TOKEN` | Chỉ dùng khi `DSH_MODE=remote` |
| E2E (chỉ để test) | `E2E_TARGET` | mock | `real` mới cho phiên dsh chạm ERPNext thật (mặc định **mock** để không ai vô tình đọc dữ liệu thật) |
| | `E2E_LLM_MODEL` | `gemini/gemini-3.6-flash` → `mac-custom` | `real-gemini` ⇒ chọn `gemini-openai` (provider thật) |
| Phân quyền (P8) | `COPILOT_USERS` / `COPILOT_DEFAULT_PERMISSIONS` / `COPILOT_COMPANY` | chế độ single-tenant | Nhiều người dùng: JSON quyền tường minh; thiếu company ⇒ TỪ CHỐI khi đa người dùng |
| Vận hành | `COPILOT_GLOBAL_READ_ONLY` | tắt | Bật `1` ⇒ toàn hệ chuyển read-only (503 `SYSTEM_MAINTENANCE`) |
| | `COPILOT_RATE_LIMIT` | `on` | `off` để tắt giới hạn tần suất (chỉ khi debug) |
| | `LEARNING_LOG` / `LEARNING_LOG_DIR` | `on` / `learning-log/` trong repo | Nhật ký học (JSONL) — đặt trong repo, **không** dùng `/tmp` (bị dọn định kỳ) |
| | `JOB_QUEUE` / `JOB_QUEUE_DIR` / `JOB_QUEUE_*_MS` / `JOB_QUEUE_MAX_ATTEMPTS` | `on` / `job-queue/` trong repo | Hàng đợi retry cho lệnh ghi đã xác nhận khi ERPNext tạm hỏng |
| Classifier (P3) | `COPILOT_CLASSIFIER` / `_URL` / `_MODEL` / `_API_KEY_ENV` / `_MIN_CONFIDENCE` / `_TIMEOUT_MS` | tắt | Phân loại câu chưa route được (chỉ dùng khi bật rõ) |
| Mock ERPNext (test) | `MOCK_ERP_STATE` / `MOCK_ERP_FAIL_*` | — | Giả lập lỗi ghi/submit cho test — **không** đặt trong `.env` khi chạy thật |

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

- **`mac-custom`** (`gemini/gemini-3.6-flash`, key `MAC_LLM_API_KEY`) — **dev/test hàng
  ngày**, không tốn quota provider. ⚠️ Router **lọc chain theo `model`** nên request
  phải xin đúng tên model mới tới được upstream này.
  ⚠️ **DRIFT 2026-09-19**: tên model cũ `oc/big-pickle` **đã bị Mac khai tử** (403
  model-not-found — kiểm bằng `curl /v1/models`). `gemini/gemini-3.6-flash` là id đã
  verify sống trên endpoint đó VÀ có `tool_calls` thật. Giữ **tiền tố** `gemini/`:
  router so khớp model CHÍNH XÁC (`llm-router.mjs` `candidates()`), nên nó không bao
  giờ nhầm với `gemini-3.6-flash` (trần) của `gemini-openai`.
- **`gemini-openai`** (key `GEMINI_API_KEY`) — **verify tương thích provider thật**
  trước production (`thought_signature`…). Free tier **RPD=20** ⇒ KHÔNG dùng để dev
  hàng ngày; 429/503 trong free tier là bình thường, không phải bug.

Chạy router:

```bash
node scripts/llm-router.mjs                      # 127.0.0.1:8900, config mặc định
node scripts/llm-router.mjs --config scripts/llm-router.e2e.json
node --test scripts/test/*.test.mjs              # unit test router (19 test)
```

### 3.3b DSH agent runtime — PIN + topology (`result58.txt` §3)

Runtime này là **agent** (dsh) mà route `/dsh/ask` spawn; nó KHÔNG nằm trên đường
`/ask` thường. Version được **PIN ở `package.json` repo root** — đổi version là một
thay đổi có chủ ý, không phải hệ quả của `npm i`:

```bash
npm run dsh:check        # bash scripts/check-dsh-runtime.sh — exit code là nguồn sự thật
npm run check:topology   # LOCAL_OK | REMOTE_OK | BLOCKED (nơi phiên sẽ thật sự chạy)
```

Entry được resolve từ package ĐÃ CÀI (`resolveDshEntry()`), không hardcode một máy;
`DSH_ENTRY` luôn thắng khi cần chỉ định tay. `/dsh/health` trả `runtime` + `version`
+ `detail` — đọc được là biết máy này có chạy được hay không.

**Topology local vs remote** (`DSH_MODE`):

| Mode | Cấu hình | Chạy ở đâu |
|---|---|---|
| `local` (mặc định) | `DSH_ENTRY`/`DSH_PATCH` (+ pin) | ngay trên máy gateway |
| `remote` | `DSH_MODE=remote` `DSH_REMOTE_URL=https://…` `DSH_REMOTE_TOKEN=<random>` | trên máy Mac qua tunnel, qua `scripts/dsh-remote-runner.mjs` |

Trên máy Mac (máy sở hữu runtime):

```bash
DSH_REMOTE_TOKEN=<random ≥16 ký tự> node scripts/dsh-remote-runner.mjs --port 8799
lt -s dsh8799 --port 8799      # expose ra ngoài
```

Luật cứng: remote **không bao giờ** hạ cấp về local. Tunnel chết ⇒ từ chối
(`DSH_REMOTE_ERROR`), KHÔNG chạy local thay — để một lần chạy local không thể bị báo
cáo nhầm là “đã verify trên Mac”. Mọi response (thành công **và** thất bại) đều mang
field `runtime: local|remote`.

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
| T4 | `node scripts/llm-router.mjs --config scripts/llm-router.mock.json` (tuỳ chọn — chỉ khi dùng chế độ AI) | 8900 | `{"ready":true,"port":8900,...}` |
| T5 | `node scripts/mock-llm.mjs` (tuỳ chọn — LLM giả 0 quota cho T4) | 8899 | log khởi động |

Thứ tự: **T1 sẵn sàng → T2 sẵn sàng → curl local OK → mở tunnel → curl tunnel OK →
mới chạy Flutter**; chế độ AI thì thêm **T4 (router) sẵn sàng trước khi hỏi**. (Chi tiết:
`mcp-erpnext/LOCAL-TEST.md`.)

Nạp `.env` cho gateway (nhớ bỏ `ASK_*` khi bind loopback — server **từ chối start** nếu thấy
chúng trên loopback):

```bash
set -a; source .env; set +a
unset ASK_USER ASK_PASSWORD            # chỉ khi bind 127.0.0.1
cd mcp-erpnext && npm run start:ask
```

Giữ service sống giữa các block lệnh (bài học: process nền của một block có thể bị dọn khi
block kết thúc — "nlp_service chết giữa 2 lệnh" trong §6):

```bash
(setsid nohup python3 -m nlp_service.server > /tmp/nlp.log 2>&1 < /dev/null &)
(setsid nohup node mcp-erpnext/src/http-ask.mjs --port 8788 > /tmp/gw.log 2>&1 < /dev/null &)
```

## 5. Test

### 5.1 Unit — 4 bộ (không cần credential, không cần mạng)

```bash
# Python — vietnamese_nlp (62 test)
PYTHONPATH=src python3 -m unittest discover -s tests     # chạy từ REPO ROOT

# Node — skill layer + http-ask + idempotency + gateway DSH (307 test / 30 file)
cd mcp-erpnext && npm test

# Node — LLM router (19 test)
node --test scripts/test/*.test.mjs      # hoặc: cd scripts && node --test

# Flutter — widget/model/controller (150 test) + analyze
cd apps/mobile && flutter test && flutter analyze
```

Chạy **một phần** khi đang sửa hẹp (nhanh hơn nhiều so với cả suite):

```bash
cd mcp-erpnext && node --test test/dsh-gateway.test.mjs     # 38 test của gateway
cd mcp-erpnext && node --test test/http-ask.test.mjs        # 4 test route + CLI
cd mcp-erpnext && node --test test/p5-dsh-optin.test.mjs    # bất biến "/ask không gọi dsh"
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

Hai endpoint của **chế độ AI (DSH)** — đường agent tách biệt, chỉ đọc:

```bash
# Runtime có chạy được không + đang ở topology nào (không tốn LLM)
curl -s http://127.0.0.1:8788/dsh/health
# → {"ok":true,"available":true,"runtime":"local","version":"0.1.5-rc.1","detail":"..."}

# Hỏi bằng agent (tốn 1 phiên LLM; mặc định cần T4 router chạy)
curl -s -X POST http://127.0.0.1:8788/dsh/ask \
  -H "Content-Type: application/json" \
  -d '{"message":"Khách smoke 2026-09-15-p1b-wf1-2 còn nợ bao nhiêu?"}'
# → {"ok":true,"mode":"dsh","runtime":"local","erpnext_target":"REAL","result":{...}}

# Câu lệnh GHI gửi qua đường AI phải bị TỪ CHỐI NGAY (không spawn phiên nào)
curl -s -X POST http://127.0.0.1:8788/dsh/ask \
  -H "Content-Type: application/json" \
  -d '{"message":"thu tiền cho chị Lan 50 nghìn"}'
# → {"ok":false,"code":"DSH_WRITE_BLOCKED","refused":true}   (trả về trong ~100ms)
```

Đọc kết quả cho đúng: `runtime` nói phiên **chạy ở máy nào** (`local`/`remote`), `erpnext_target`
nói nó **chạm ERPNext thật hay mock** — hai field này là bằng chứng, đừng suy từ tên lệnh.

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

**6 script E2E/kiểm tra (exit code = nguồn sự thật, không cần đọc prose):**

| Lệnh | Việc |
|---|---|
| `npm run dsh:check` | pin + entry + version + chạy được + marker cổng chặn ghi |
| `npm run check:topology` | nơi phiên sẽ chạy (local/remote) + cross-check `/dsh/health` |
| `npm run dsh:e2e:read ["câu hỏi"]` | DSH READ thật qua gateway (mặc định câu smoke; thêm câu thứ 2 làm đối số) |
| `npm run dsh:e2e:write-block` | câu lệnh ghi phải bị TỪ CHỐI + đo thời gian (chứng minh không spawn) |
| `npm run check:ask-normal ["câu hỏi"]` | `/ask` không chạm dsh (audit delta = 0) |
| `COPILOT_BASE_URL=… bash scripts/check-dsh-topology.sh` | kiểm topology của gateway KHÁC (vd cổng remote) |

Env dùng chung cho script: `COPILOT_BASE_URL` (mặc định `http://127.0.0.1:8788`),
`ASK_USER`/`ASK_PASSWORD` (chỉ khi bind non-loopback), `DSH_E2E_TIMEOUT` (mặc định 240s).

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
| Request qua router trả 502 `all upstreams failed` | chain bị lọc theo `model` không khớp / upstream đang cooldown | xin đúng tên model (dev: `gemini/gemini-3.6-flash`) và thử lại sau cooldown |
| Request qua `mac-custom` trả **403 model-not-found** | model đã bị đổi/khai tử ở phía Mac (drift, đã xảy ra 2026-09-19 với `oc/big-pickle`) | gọi `GET https://llm9000.loca.lt/v1/models` xem id thật, rồi sửa `model` trong `llm-router*.json` + patch dsh |
| `curl https://<tunnel>.loca.lt/v1/models` trả **`503 Tunnel Unavailable`** | tunnel trên máy Mac đã tắt/hết hạn (localtunnel cấp URL động) | người thật phải bật lại `lt` trên Mac; đây là **BLOCKED_EXTERNAL**, không phải lỗi code — không tự đổi config để "chạy tạm" |
| Phiên `/dsh/ask` trả 502 kèm `all upstreams failed (tried: mac-custom)` | LLM upstream chết (tunnel/model drift/quota) — gateway vẫn đúng | xem dòng audit của router (`llm-router-audit/audit-*.jsonl`): `attempts` + `status` cho biết upstream nào hỏng thật |
| `/dsh/health` báo `available:false` dù có entry | patch thiếu `COPILOT_DSH_CONTEXT=1` (cổng chặn ghi của child sẽ không bao giờ chạy) | giữ nguyên — **đúng** thiết kế từ chối; thêm cờ vào patch hoặc dùng patch chuẩn |
| `/dsh/ask` trả `DSH_WRITE_BLOCKED` cho một câu bạn nghĩ là ĐỌC | câu đó bị `routeIntent` xếp vào nhóm ghi (vd có "thu tiền") | đọc lại câu hỏi; nếu thật sự là câu đọc thì đây là bug routing → báo, **đừng** nới cổng chặn |
| `npm run dsh:check` báo lệch version pin | runtime cài khác `package.json` | `npm install` ở repo root, hoặc set `DSH_ENTRY` trỏ đúng entry |
| Gateway **từ chối start** với `ASK_USER/ASK_PASSWORD make no sense on a loopback bind` | `.env` có `ASK_*` nhưng đang bind `127.0.0.1` | `unset ASK_USER ASK_PASSWORD` trước khi start (hoặc bind host non-loopback thật) |
| Script E2E báo `FAIL audit file missing` | `LEARNING_LOG_DIR` sai hoặc service chưa từng chạy | trỏ đúng thư mục (`learning-log/` trong repo) — script **cố ý** fail thay vì in PASS rỗng cho delta `0 → 0` |
| `curl` tới `mac-custom` lần đầu trả **408/502** | localtunnel chập chờn (đặc tính, có từ 2026-09-15) | gọi lại — audit sẽ ghi `attempts=['mac-custom'] status=408`, không phải lỗi code |
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
- **Chế độ AI (DSH) CHỬ ĐỌC**: câu lệnh ghi bị từ chối ở **gateway, trước khi spawn** (đo
  được ~100ms so với ~20s của một phiên thật) — không đề xuất, không nút xác nhận, không `/execute`.
- **Remote không bao giờ hạ cấp về local**: tunnel Mac chết ⇒ trả lỗi, **không** chạy trên
  máy gateway thay; mọi response (kể cả lỗi) đều mang `runtime` để biết phiên chạy ở đâu.
- **Không tự ký duyệt vùng tiền/gateway**: agent sửa xong thì **báo + chờ duyệt**, không tự
  commit (kể cả khi test xanh 100%).

## 8. Tham chiếu chéo

| Cần gì | Đọc |
|---|---|
| Quy trình 3 terminal đầy đủ | `mcp-erpnext/LOCAL-TEST.md` |
| Demo luồng ghi nháp (kịch bản STALE/EXPIRED/replay) | `docs/demo-payment-draft.md` |
| Test APK tại điểm bán | `docs/device-test-checklist.md` |
| Câu hỏi dễ hiểu sai / hiểu nhầm | `faq.md` |
| Quyết định pháp lý Phase 5 (không PII scrub) | `SIGNOFF-phase5-pii.md` |
| Topology DSH (local↔Mac), pin runtime, 6 script kiểm tra | `.plan/dsh_prompt_check.md` · `result58.txt` |
| Việc chỉ người thật làm được (tunnel, APK, submit, quyết định) | `human.md` |
| Bài học lỗi đã trải qua (đọc trước khi sửa) | `.agents/skills/erpn-verify-first/SKILL.md` · `LESSONS_LEARNED.md` |
| Trạng thái hiện tại + việc tiếp theo | `working.md` · `next.md` · `checklist.md` |
