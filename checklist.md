# checklist.md — ERPNext Vietnamese Voice Copilot (erpn_mobile1)

Danh sách kiểm tra nhanh: **đã làm / chưa làm / cần làm / cần hỏi lại**.
Cập nhật cùng lúc với `resultNN.txt` + `features.md` + `next.md` sau mỗi phase lớn.
Bằng chứng chi tiết nằm ở `.plan/phases/phase-0N-result.md` và `resultNN.txt` — file này chỉ tóm tắt trạng thái.

---

## Yêu cầu sản phẩm gốc (KHÔNG xoá — dùng làm tiêu chí nghiệm thu app)

- [ ] Mọi hành động thao tác app phải mượt, nếu có process ngầm phải show loading indicator
- [ ] Không giới hạn tính năng sử dụng, muốn sử dụng tính năng pro phải xem ads, và chỉ sử dụng được trong ngày. Ngày hôm sau muốn dùng pro tiếp phải xem ads.
- [ ] App không được giật lag ở mọi chức năng, mọi process nặng đều đưa vào background process, để UI mượt
- [ ] Mọi thao tác nếu lỗi / không cho phép phải thông báo qua toast notification
- [ ] Code ở Flutter & đồng bộ hoàn thiện ở native integration
- [ ] Data cần được đồng bộ, nếu có thể để 1 nơi, đừng để rải rác rồi quên đồng bộ — tránh lệch số liệu

> 6 mục trên là yêu cầu sản phẩm, không phải task. Chưa mục nào verify được vì app chưa có giao diện.
> **Lưu ý quan trọng:** mục cuối ("mỗi lần hoàn thành task lớn: code có thật, test PASS, có ghi result") — đừng chấp nhận "xong" chỉ bằng lời.

---

## Phase 0 — Foundation & Verification ✅ XONG

- [x] Verify `@casys/mcp-erpnext` trên npm + JSR — có thật, latest stable `3.0.4` (2026-09-07), dist-tag `next` = `3.1.0-beta.10`
- [x] Đọc CHANGELOG: chốt **breaking change `3.0.0` nằm ở HTTP transport** (stateless, đòi `MCP-Protocol-Version: 2026-07-28`; client pre-2026-07-28 bị reject) → **pin `3.0.4` + dùng `stdio`** để né hẳn
- [x] Verify DeepSeek Harness (dsh) — repo chính thức `deepseek-ai/deepseek-harness`, MIT, developer preview
- [x] Verify `@deepseek-ai/dsh-mcp-client` — có thật **và là built-in** (`@deepseek-ai/dsh` phụ thuộc trực tiếp)
- [x] Xác nhận rủi ro: **20/20 version dsh publish đều là `rc`/`alpha`**, chưa có bản stable; README tự nhận "THERE WILL BE COMPATIBILITY-BREAKING CHANGES"
- [x] Verify STT: Web Speech API có `vi-VN` on-device **nhưng Chrome for Android chỉ "partial support" và từ bản 152**
- [x] Verify Cohere Transcribe `cohere-transcribe-03-2026` — có thật, có tiếng Việt, nhưng **trial chỉ 1.000 call/tháng** → chỉ làm fallback
- [x] Verify free tier Gemini: **"Content used to improve our products" = Yes** → blocker pháp lý PII (Nghị định 13/2023)
- [x] Verify OpenCode Zen `big-pickle` — free nhưng "for a limited time", không có SLA
- [x] **Phát hiện: 5 repo "DSH mobile" mà review6 gọi là bịa — verify lại thì TẤT CẢ ĐỀU TỒN TẠI** (repo thật, có commit, 0–206 ★) → review6 sai, không phải review1 bịa. **Re-verify lần 2 (2026-09-13, xem `result4.txt`):** cả 5 mở được URL thật qua 2 lớp độc lập — GitHub API HTTP 200 (kèm stars/forks/license/pushed_at) VÀ fetch HTML trực tiếp github.com HTTP 200 (title khớp tên repo); 2 repo control (owner/repo không tồn tại) trả 404 ở CẢ 2 lớp xác nhận API/fetch thật. Kết luận: xác minh CÓ THẬT, giữ nguyên quyết định KHÔNG dùng (lý do thẩm định an toàn — third-party xử lý tiền/PII)
- [x] Search OmniRoute/9Router + TAXPRO trên máy — **không tìm thấy** → user xác nhận chốt **Xây mới**, không block
- [x] Chốt reuse `AGENTS.md` + Capability Matrix (đã có sẵn trong repo, adapt chứ không viết lại)
- [x] Thêm mục **Mandatory Sign-off** vào `.plan/phases/phase-05-ai-gateway-core.md` làm gate cứng trước khi code LLM Router
- [x] `.plan/phases/phase-00-result.md` (đủ 6 mục)

## Phase 1 — Vietnamese NLP Pipeline ✅ XONG (còn 1 điều kiện ngoài code)

- [x] Chốt với user: **Python** cho pipeline, **Flutter** là client đích
- [x] Number normalizer `src/vietnamese_nlp/money.py` — đủ 14 dạng bắt buộc của phase-01
- [x] Kinship stripper `kinship.py` — phủ **21/21** title
- [x] Domain synonym mapper `synonyms.py` — phủ **45/45** phrase, 10 nhóm intent
- [x] Quantity extractor `quantity.py` (bonus — `20 bao`, `25 ký`)
- [x] `pipeline.normalize(text) -> NormalizedResult` + CLI `python -m vietnamese_nlp` (JSON)
- [x] Unit test: **58 test PASS** (`PYTHONPATH=src python3 -m unittest discover -s tests`) — sau đợt fix hậu tố 2026-09-13
- [x] Corpus 3 miền: **259 money (37 negative) + 30 kinship + 45 synonym + 11 challenge** case
- [x] **Money accuracy 259/259 = 100%** (gate ≥95%) — Bắc/Trung/Nam đều 100%
- [x] Case fail-safe (không được sinh amount): 37/37 đúng
- [x] Zero runtime dependency (stdlib thuần) — không cần cài gì để chạy CI
- [x] Fix 3 bug thật cho ra **số tiền sai im lặng** (gộp nhầm amount câu sau; `"không triệu"` → 1.000.000; guard bỏ sót số viết bằng chữ) — xem result1.txt
- [x] `.plan/phases/phase-01-result.md` + `result1.txt`
- [x] `pyproject.toml`, `README.md`, `.gitignore` (thêm `__pycache__/`, `*.py[cod]`, `.venv/`)
- [ ] **Test set AUDIO thật 3 miền — CHƯA CÓ** (phase-01 yêu cầu "thu âm thật, không dùng TTS"). Hiện chỉ có text → **chặn ở Phase 4**, không chặn Phase 2

---

## Chưa làm — cần làm (theo thứ tự roadmap)

### Ngay tiếp theo
- [x] **Phase 2** — MCP server ERPNext read-only + skill layer ✅ **XONG 2026-09-14** (`result4.txt` skeleton + `result5.txt` wiring + `result6.txt` real): pin 3.0.4 (lockfile) · readonly-guard 12 tool đọc THẬT · **34/34 node --test PASS** · **đã nối ERPNext THẬT** (env-switch `pickServerScript`: đủ 3 var → real, thiếu → mock, sai → hard error; probe thật 125 tools + customer_list OK) · **dsmoke dsh thật end-to-end** (dsh 0.1.5-rc.1 headless + mock LLM OpenAI-compatible → câu trả lời đúng 269.000đ khớp 3 hóa đơn thật). Còn thiếu: audit log/rate limit (phase-05), dsh Web UI browser leg
- [x] **Cầu nối Python ↔ Flutter/dsh** ✅ ĐÃ XÂY 2026-09-14: `nlp_service/server.py` (stdlib, bind 127.0.0.1, GET /health + /normalize) — `copilot-server.mjs` gọi qua HTTP thật. ✅ Chân Flutter ĐÃ NỐI 2026-09-14: `apps/mobile` gọi HTTP `/ask` (`result7.txt`)
- [x] **Commit Phase 1** ✅ **33f9dc0** — root commit 55 files +6390 (2026-09-14, user duyệt "thấy ổn thì commit"), scope đúng kế hoạch, `.env` không bị add (verified `git check-ignore` trước staging + grep secrets chỉ có .env)
- [ ] Thu 100–200 câu **audio thật** 3 miền (cửa hàng/kho/ngoài đường) → điều kiện còn thiếu của phase-01, bắt buộc trước Phase 4

### Các phase sau (chi tiết ở `next.md` + `.plan/phases/`)
- [ ] Phase 3 — MVP **Flutter** text chat (read-only) — KỸ THUẬT XONG 2026-09-14 (`result7.txt`: apps/mobile + http-ask.mjs + GH Actions workflow; Node 36/36, Python 58/OK, Flutter 13/13, analyze 0 issue). CHỜ: UI-checkpoint user duyệt → commit → push GH → build APK thật
- [ ] Phase 4 — Voice input/STT (hybrid) — **bị chặn bởi corpus audio**
- [ ] Phase 5 — AI Gateway core (auth, PII scrub, LLM Router, audit) — **phải xong Mandatory Sign-off trước khi code router**
- [ ] Phase 6 — Entity resolution + Action Proposal card
- [ ] Phase 7 — `create_payment_entry` + idempotency (**write đầu tiên chạm tiền — Go/No-Go gate**)
- [ ] Phase 8 — Background jobs, push notification, TTS readback
- [ ] Phase 9 — Proposal state machine (expiry, re-validation, saga/compensation)
- [ ] Phase 10 — Multi-user, RBAC, on-behalf-of ERPNext credential (**Trigger #1 để tách khỏi dsh**)
- [ ] Phase 11 — Mở rộng write skills (sales, inventory, purchase)
- [ ] Phase 12 — Multi-tenant readiness (chỉ nếu có ý định SaaS)
- [ ] Phase 13 — Production hardening + beta pilot
- [ ] Phase 14 — Store submission + PII/Nghị định 13 sign-off
- [ ] Phase 15 — Monetization: pro qua xem ads, reset mỗi ngày (**thứ tự thực thi: giữa 13 và 14**)

### Đợt fix 2026-09-13 (xem `result2.txt`)
- [x] Fix **4 false positive** tìm được khi review: SĐT → 912.345.678 · `"mua 5 củ cải"` → 5.000.000 · `"doanh thu 2024"` → 2024 · `"nhà 1234"` → 1234
- [x] Thêm **shape guard** trong `money.py`: SĐT (`0` + 9–11 số) · năm 1900–2099 trần · sau từ định danh (`nhà`/`mã đơn`/`số lượng`) · `củ`/`chai` khi là vật thật (`củ cải`, `chai nước`)
- [x] Thêm **tiếng lóng miền Nam `trẹo` / `chai` = triệu** (theo quyết định user) + 5 case positive
- [x] Thêm **8 negative case** + 5 slang case vào corpus → 247 case, 33 negative
- [x] **Phát hiện BUG mới:** hậu tố tiền tệ **dính liền** số (`"2000đ"`, `"5000vnd"`, `"500đồng"`) không parse — có dấu cách (`"2000 đ"`) thì đúng. **Chưa fix** (cần sửa tokenizer — vùng tiền, phải user duyệt) → ghi `ch-012`/`ch-013`
- [x] Xác nhận hành vi đổi có chủ đích: `"trả 2000"` (4 chữ số dạng năm, không hậu tố) **bị từ chối** — fail-safe; viết `2000 đ` hoặc `hai nghìn`
- [x] Thêm `phase-15-monetization-ads.md` vào roadmap (theo quyết định user)
- [x] Ghi quyết định cầu nối **HTTP service nội bộ** + `"công nợ"` → `receivable` vào `next.md`/`features.md`/roadmap
- [ ] Khoảng trống mới phát hiện: **Flutter client track chưa có phase nào** — `phase-04` (STT) và `phase-15` (ads) đều phụ thuộc vào nó

### Nợ kỹ thuật đã biết của Phase 1
- [x] ~~Tiếng lóng miền Nam `trẹo` / `chai`~~ ✅ xong 2026-09-13
- [ ] `bạc` — chờ user xác nhận mệnh giá (`ch-003`)
- [ ] Viết tắt `m` (= triệu nhưng `m` cũng = mét) — đoán là nguy hiểm (`ch-004`)
- [x] ~~Hậu tố tiền tệ dính liền số~~ ✅ **ĐÃ FIX 2026-09-13** (user duyệt): lookahead `(?!\w)` → `(?!\d)` cho num/shorthand; thêm 3 guard chống merge rác (`2tr5k` · `2024năm` · `2tr50` vỡ token). Trước fix `"1 500 000đ"` im lặng trả **1500**. → **58/58 PASS · 259/259 = 100%** (xem `result3.txt`)
- [x] ~~Scale dính scale / số dính từ-số (`2tr5k`, `2024năm`, `2tr50`)~~ ✅ chặn fail-safe cùng đợt
- [ ] Cờ `approximate` cho `"khoảng 10 triệu"` / `"hơn 10 triệu"` (hiện trả số nhưng mất nghĩa xấp xỉ)
- [ ] Xử lý số âm / hoàn tiền (`"trả lại 500 nghìn"`)
- [ ] Phân biệt câu hỏi vs câu lệnh (việc của Phase 6)
- [ ] Tiếng lóng miền Trung chưa khảo sát (mới có `ngàn`, `chục`)

---

## Cần hỏi lại / chờ user quyết định

### Đã được trả lời ngày 2026-09-13
- [x] `"công nợ"` → **`receivable`** (giữ nguyên, không sửa code)
- [x] **Client stack = Flutter** (chốt) → `phase-03` (PWA) **phải sửa**
- [x] **Tiếng lóng miền Nam: CÓ** → đã làm `trẹo`/`chai`; `bạc` chờ mệnh giá
- [x] **Cầu nối Python ↔ Flutter/dsh = HTTP service nội bộ (localhost)**
- [x] **Monetization: CÓ** → đã thêm `phase-15-monetization-ads.md`
- [x] **Commit: CHƯA commit gì cả** → để untracked, commit gộp sau

### Còn treo
- [ ] **Định nghĩa Flutter client track** — khoảng trống lớn nhất; chặn `phase-04` (STT) và `phase-15` (ads).
- [ ] **Rotate ERPNext API key/secret** — key đã đi qua nội dung chat (plain text); `.env` đã git-ignored + chmod 600 nhưng nên đổi key trên ERPNext.
- [ ] **Swap mock LLM → gateway OpenAI-compatible thật** — chỉ sửa `/tmp/dsh-home/settings.yaml` (baseURL + apiKeyEnv), không đụng code; `scripts/mock-llm.mjs` dùng làm contract test.
- [ ] **dsh Web UI (browser) leg** — headless đã chạy thật; Web UI còn thiếu vì chưa mở browser (server `dsh web --patch ...` đã sẵn sàng + `--no-open`).
- [ ] **`bạc` = bao nhiêu?** Chờ user xác nhận mệnh giá mới làm (`ch-003`).
- [ ] **4 câu của Phase 15:** ad provider · múi giờ tính "hết ngày" · danh sách tính năng pro · có IAP bỏ ad không.
- [ ] **Vị trí OmniRoute/9Router + TAXPRO** — xác nhận không có trên máy này; nếu mang code từ máy local sang thì cần refactor thành shared lib (đã ghi trong next.md).

## Note

- Mỗi lần xong task lớn: kiểm tra **code có thật không, test có PASS không, có ghi result không**.
- Đừng báo "xong" bằng lời — mọi claim cần dòng code + output test thật.
- **Vùng tiền/số (money) KHÔNG được AI tự ký duyệt**: code Phase 1 chạm tiền, phải user review trước khi commit.
- Tool đang hỏng trong env này: **AgentMemory** (down), **MCP `cocoindex-code`/`codebase-memory-mcp`** (không expose), **OCR** (không chạy được), **Simplenote MCP** (không có trong tool list) → Code Review phải làm thủ công.
