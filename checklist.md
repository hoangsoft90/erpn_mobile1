# checklist.md — ERPNext Vietnamese Voice Copilot (erpn_mobile1)

Danh sách kiểm tra nhanh: **đã làm / chưa làm / cần hỏi lại**.
Bằng chứng chi tiết: `result*.txt` (mới nhất = result15) + `.plan/phases/*-result.md`.
Trạng thái roadmap chi tiết nằm ở `next.md` — file này KHÔNG nhân bản, chỉ tóm tắt.

---

## Yêu cầu sản phẩm gốc (KHÔNG xoá — tiêu chí nghiệm thu app)

- [ ] Mọi hành động thao tác app phải mượt, nếu có process ngầm phải show loading indicator
- [ ] Không giới hạn tính năng sử dụng, muốn sử dụng tính năng pro phải xem ads, và chỉ sử dụng được trong ngày. Ngày hôm sau muốn dùng pro tiếp phải xem ads.
- [ ] App không được giật lag ở mọi chức năng, mọi process nặng đều đưa vào background process, để UI mượt
- [ ] Mọi thao tác nếu lỗi / không cho phép phải thông báo qua toast notification
- [ ] Code ở Flutter & đồng bộ hoàn thiện ở native integration
- [ ] Data cần được đồng bộ, nếu có thể để 1 nơi, đừng để rải rác rồi quên đồng bộ — tránh lệch số liệu

> 6 mục trên là yêu cầu sản phẩm, không phải task. App giờ ĐÃ có giao diện chat
> (Phase 3) nhưng chưa mục nào verify được trên thiết bị thật — chờ APK CI.

---

## Đã làm ✅

### Phase 0 — Foundation & Verification
- Verify toàn bộ external dependency thật (npm/GitHub API/docs) → chốt: dsh runtime,
  pin `@casys/mcp-erpnext@3.0.4` + stdio, STT order (Web Speech → Cohere → Whisper → PhoWhisper),
  xây mới NLP/Router. Chi tiết: `phase-00-result.md`, `result1.txt`

### Phase 1 — Vietnamese NLP Pipeline (`src/vietnamese_nlp/`, Python stdlib thuần)
- Number normalizer → integer VND; kinship stripper 21 title; synonym mapper 10 nhóm intent;
  quantity extractor; CLI độc lập; fail-safe tiền là điểm cốt lõi
- **58/58 test PASS · money 259/259 = 100%** (corpus 3 miền, 37 negative)
- 2 đợt fix thật: 3 bug số-tiền-sai-im-lặng (result1) + 4 false positive & slang trẹo/chai &
  hậu tố dính liền (result2/3)
- **Đợt fix result9:** kinship CHỈ strip cụm xưng hô ĐẦU câu (title giữa câu là phần tên thật
  trong DB) — test corpus cập nhật theo, 58/58 vẫn xanh

### Phase 2 — MCP ERPNext read-only + skill layer + cầu nối
- Skill layer (`mcp-erpnext/`): readonly-guard chặn write ở tầng code, 12 tool đọc thật,
  chống bịa ID, markUntrusted; pin 3.0.4 lockfile; mock server đúng shape 3.0.4
- Cầu nối Python HTTP (`nlp_service/server.py`, stdlib, 127.0.0.1) — đúng quyết định đã khóa
- Copilot MCP server 1 tool `copilot_ask` cho dsh; env-switch real/mock (sai config → hard error)
- dsh 0.1.5-rc.1 headless E2E thật với ERPNext thật (269.000đ khớp 3 hóa đơn) — `result6.txt`
- **Đo accuracy thật theo exit-criteria (result9, commit `119edd4`): 18 câu tiếng Việt
  qua `answerQuestion()` với ERPNext thật — 27.8% → 61.1% → 18/18 = 100%** sau khi fix
  5 nhóm lỗi unit-xanh-không-bắt-được. **Test: 40/40 node · 58/58 Python**
- Fail-safe tiền củng cố: ambiguous fallback chỉ nhận fragment ≥ 2 từ, không thì null + hỏi lại

### Phase 3 — Flutter chat MVP (client đích đã chốt Flutter, không phải PWA)
- `apps/mobile` (Riverpod + dio): màn hình chat, lịch sử (SharedPreferences), empty state,
  SnackBar lỗi giữ text; gọi HTTP `/ask` wrapper trên VPS (không nhúng key vào app)
- `/ask` HTTP wrapper (`http-ask.mjs`) + GH Actions workflow build APK debug (artifact
  `erpn-chat-debug-apk`); sửa workflow thêm step build_runner (gitignore `*.g.dart` gây
  CI fail run 1)
- Flutter analyze 0 issue · 13/13 test · Node 40/40 · Python 58/58
- Bug thật sửa nổi bật: ChatBubble không bao giờ render answer (bắt bằng debug widget test)

### Hạ tầng dự án
- 4 commits: `33f9dc0` (Phase 1) → `0ac8e61` (Phase 2 real) → `590b1b2` (Phase 3) →
  `119edd4` (fix result9) → `87fcbb1`/`e2f5caf`/`49317a7` (Phase 5 router + review 2 vòng). Branch `change/flutter-chat-mvp`, remote origin = github.com/hoangsoft90/erpn_mobile1
- 2 project skills (`.agents/skills/`, local-only vì repo gitignore `.agents/`):
  `erpnext-mcp-connect` (kết nối/authorize ERPNext MCP) + `erpn-verify-first` (quy trình
  chống "code xong đi sửa" — 5 phiên bài học)

---

## Chưa làm / đang làm (thứ tự)

### Đang làm
- [x] **Code review sâu chuỗi client (result16, 2026-09-15): 7 lỗi thật đã sửa** — 3 crash router (upstream stream không error listener / client ngắt giữa request / models path — đều giết process), 2 stuck (http-ask không deadline → socket treo vô hạn; NLP fetch không AbortSignal), 2 logic Flutter (cold-start race ghi đè lịch sử; mounted guard sau await). **+3 regression test. Node 49/49 (9s) · router 8/8 · Flutter analyze 0 · Flutter 14/14.** 4 lỗi của chính agent trong đợt này (finding sai, Promise.race timer không clear, test thiếu override, str_replace miss) đã vào skill mục 6. Chờ duyệt commit
- [x] **Phase 5 — LLM Router nối upstream thật** (result15, 2026-09-15): endpoint chính thức điền xong (zen `opencode.ai/zen/v1` · gemini `generativelanguage.googleapis.com/v1beta/openai`); **2 bug router tự bắt khi chạy thật** (https transport + field `store` Gemini từ chối → `stripFields`) + `LLM_ROUTER_DEBUG=1`; **Gemini verify generate thật 200** qua router · **Zen bị chặn billing** (CreditsError: No payment method — glm-5.3-flash là PAID, big-pickle chỉ chạy trong OpenCode client); cơ chế dsh thật = cordis patch row (settings.yaml result6 lỗi thời) → skill mới `erpn-dsh-setup`; **E2E dsh→router→Gemini flaky do free tier 20 req/phút** (1 session dsh tốn 2–3 calls: 429 quota + 503 high demand nguyên văn trong result15 §6)
- [x] GH Actions run #2 ✅ **SUCCESS** (`result10.txt`): [run 34826575147](https://github.com/hoangsoft90/erpn_mobile1/actions/runs/34826575147) — build_runner/Analyze/Test/Build APK đều xanh; artifact `erpn-chat-debug-apk` (80MB zip) đã tải về VPS `/home/kythuat_hoangweb/erpn-apk/app-debug.apk`
- [x] **APK nối được VPS — endpoint security** ✅ (`result11.txt`, commit `c3d74c3`): http-ask bind policy (non-loopback BẮT BUỘC basic auth, public cần ASK_ALLOW_PUBLIC=1 — server tự từ chối cấu hình unsafe) + Flutter client gửi auth qua dart-define + CI build APK từ repo Variables/Secret. Verify thật: 401 không auth → 200 có auth → trả lời 269.000đ qua ERPNext thật. ⚠️ **Port 8788 bị cloud firewall hosting chặn từ internet** (read_url timeout) — cần user mở port HOẶC dùng Tailscale (đã cài, chờ login)
- [x] **Mandatory Sign-off Phase 5 ĐÃ KÝ (2026-09-15)**: `SIGNOFF-phase5-pii.md` — 4/4 quyết định đã điền. Hoàng xác nhận qua trao đổi trực tiếp: **KHÔNG PII scrubbing, KHÔNG LLM Router 2-tier** — gửi thẳng tên khách/số tiền cho LLM, free tier được dùng (rủi ro pháp lý chủ dự án tự chấp nhận, đã ghi minh bạch trong sign-off). **Gate MỞ** → phạm vi Phase 5 còn: LLM Router đơn giản + audit log (bỏ mục scrub)
- [x] **Phase 5 khởi động — LLM Router bản đơn giản** ✅ (result14): `scripts/llm-router.mjs` (proxy OpenAI-compatible 127.0.0.1:8900, fallback chain config-driven JSON, cooldown upstream lỗi 429/5xx/timeout) + `scripts/llm-router.config.json` (mock → zen → gemini-openai, 2 upstream thật còn PENDING verify key/baseURL) + audit JSONL `llm-router-audit/` (không chép nội dung câu hỏi). **Test: 7/7 router + 49/49 mcp-erpnext; E2E smoke thật qua mock-llm.** Còn lại Phase 5: nối dsh → router, verify rate limit/baseURL thật khi có key
- [x] **Tunnel localtunnel verify E2E thật (2026-09-14)** ✅: user chạy `lt -s erpn8788 --port 8788` trên **máy Mac** (forward qua SSH tới VPS) → từ VPS test qua tunnel: `/health` 3/3 = 200 · `/ask` HTTP 200 · **"Khách smoke 2026-09-13-p1done còn nợ 269.000đ (3 hóa đơn chưa trả)" khớp ground-truth result9**. Lưu ý: curl phải kèm header `bypass-tunnel-reminder: 1` (không có → 502 Bad Gateway từ tunnel server, dễ nhầm là service chết). Quy trình chuẩn hóa ở `mcp-erpnext/LOCAL-TEST.md` + npm script `start:ask`. ⚠️ URL tunnel public KHÔNG auth (http-ask bind loopback) — chỉ bật khi test, Ctrl-C ngay khi xong. COPILOT_BASE_URL cho APK có thể trỏ tunnel này (HTTPS qua firewall)
- [ ] **Chờ user dán 3 giá trị vào GitHub Settings** (token hiện tại chỉ-đọc, PUT 404): Variables `COPILOT_BASE_URL=https://erpn8788.loca.lt` (tunnel HTTPS đã verify E2E thật — result13; hoặc IP:8788 nếu hosting mở port/Tailscale) + `COPILOT_AUTH_USER=copilot` (user lấy từ `.env` ASK_USER), Secret `COPILOT_AUTH_PASSWORD` (= ASK_PASSWORD trong `.env`) → CI build APK cài được luôn. ⚠️ Tunnel chỉ sống khi `lt` đang chạy trên máy Mac của user — endpoint lâu dài cần Tailscale/hosting mở port
- [x] **Kịch bản thu âm** ✅ `docs/audio-collection-script.md`: 150 câu 3 miền có ground truth (A-G), chỉ tài liệu

- [x] **Commit đợt result17** ✅ `be57052` (đã duyệt + push): gateway mang `thought_signature` + harness E2E + docs
- [x] **Session E2E sau review (result18) — CHẶN BỞI QUOTA**: session nhận **6× 429 `RESOURCE_EXHAUSTED` "generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash"** + 1× 503 (nguyên văn trong result18 §D). ⚠️ **Số liệu ở bản đầu của mục này đã SAI và đã được sửa (result18 §J)**: tôi viết "audit có 20 lần 200 = chạm trần" nhưng **chính con số đó cũng sai** (đếm thô, chưa lọc `attempts` có `gemini`): đếm lại bằng script = **17** lần 200 qua provider thật trong ngày LỊCH = **10** trước + **7** từ mốc reset ~07:00 UTC (nửa đêm Pacific). Audit router thêm nữa **không ghi** các lần curl trực tiếp nên không phải sổ quota đầy đủ. Bằng chứng hành vi: 429 bền vững sau **>15 phút** im lặng (không phải trần theo phút), nhưng **mốc/định nghĩa bucket chưa xác lập chắc** (2 ứng viên: 7 theo mốc 07:00 UTC vs 17 qua router + ≥2 probe trực tiếp ≈ 19-20 theo mốc 00:00 UTC) → đã ghi cả hai con số thay vì khẳng định. Router KHÔNG lỗi (mọi 502 đều `attempts:[gemini-openai]` = đã thử thật). **Dừng theo kỷ luật, không retry trong ngày.** ⚠️ Turn replay tool chưa lần nào 200 ⇒ logic thought_signature **chưa verify live bằng code sau review** (mới hermetic 19/19) — phải nói rõ, không được coi là xong.
- [x] **E2E 0-quota XANH (bù cho hạn chế trên)** — mock LLM wildcard + mock ERPNext với code sau review: trả đúng `Nguyễn Thị Lan còn nợ 2.500.000đ`, audit 200×3 turn **gồm cả turn replay tool** (`messages:7`) ⇒ plumbing nguyên vẹn. Thêm `scripts/llm-router.mock.json`; phát hiện model filter loại mock (đúng thiết kế — mock không được trả lời thay LLM thật) nên mock upstream phải là wildcard (không khai `model`).
- [x] **Commit đợt result18** ✅ `8d9f04c` (đã duyệt + push): mock config 0-quota + docs.
- [x] **E2E lần 2 sau review (result19) — CHƯA CHẠY ĐƯỢC, và phép đếm quota cũ bị BÁC BỎ bằng chính lần chạy**: làm đúng §G.1 user chỉ định (đếm `status 200` qua router từ mốc 07:00Z + cộng probe trực tiếp = **8 < 20**; doc chính thức xác nhận "RPD quotas reset at midnight Pacific" = 07:00 UTC) → chạy **đúng 1 session** → **7×429** `generate_content_free_tier_requests, limit: 20, model: gemini-3.6-flash` (nguyên văn result19 §C). Sắp theo thời gian: 429 bắt đầu từ request **#17** và **mọi request sau đó đều 429** (kể cả lúc gần như idle) ⇒ con số 20 bị tiêu bởi nhiều nguồn `status 200` không thấy: **mỗi turn dsh = 6–8 request** provider, retry nội bộ, probe trực tiếp không qua audit. **Luật mới (dùng từ nay)**: ① đếm REQUEST GỬI TỚI PROVIDER (`attempts` chứa upstream thật), không đếm 200; ② ngân sách 20/ngày ≈ **1 session dsh**, không phải 20; ③ **429 đầu tiên trong ngày quota = hết ngày** → dừng MỌI request (probe "kiểm tra cho chắc" cũng là 1 request), chờ reset; ④ việc verify quan trọng chạy vào request ĐẦU TIÊN của ngày quota. Vẫn **chưa verify live** `thought_signature` (session chết ở turn đầu). ERPNext thật đã sống lại (ping 200) — chặng đó hết bị chặn.

### Bị chặn — chờ người thật (không phải việc agent)
- [ ] **Rotate key ERPNext** — user (Hoàng) làm trực tiếp trên server; trạng thái 2026-09-14:
      key cũ vẫn hợp lệ (HTTP 200), rotation chưa hiệu lực (`result9.txt` §1)
- [ ] **Thu 100–200 câu audio thật 3 miền** — điều kiện còn thiếu của Phase 1, chặn Phase 4 (STT)
- [ ] **Cài APK lên thiết bị thật tại điểm bán + test** — cần người thật. Endpoint đã có đường sống: tunnel `erpn8788.loca.lt` verify E2E (result13) — dùng ngay khi `lt` chạy; lâu dài chọn 1 trong 3 (result11 §5): Tailscale login (khuyến nghị) / hosting mở port 8788 / tunnel giữ nguyên. Sau đó user dán 3 giá trị GitHub Settings → CI build APK cài được
- [x] **Quyết định upstream LLM (user 2026-09-15)**: Zen ĐỂ SAU (billing-blocked giữ nguyên, không xóa config) · Gemini free tier được chấp nhận (không nâng paid; 429/503 = bình thường, retry ~60s). ⚠️ **Evidence result16 §6D: trần NGÀY (RPD=20) đã cạn hôm nay** (149 requests, 10 gemini 200) — "retry in Xs" của Google gây hiểu nhầm cho daily quota; E2E xanh chạy DUY NHẤT 1 session sau reset (~nửa đêm giờ Pacific ≈ 14-15h giờ VN)
- [x] **Review vòng 2 trên fix của mình (result16 §6C): 5 window-sau-await còn sót** — chain-loop abort check · models catch guard · exhausted-502 guard + audit 499 · debug-drain error listener · stripFields validation (string iterate ký tự xóa nhầm key im lặng). Router 10/10 (452ms) + 2 test mới (client-abort survival, stripFields). → **commit `49317a7` (đã duyệt + push)**
- [x] **E2E sau reset quota — 1 SESSION DUY NHẤT (result17, 2026-09-15 14:18 giờ VN)**: chạy đúng 1 lần, không retry. **Quota reset ĐÚNG dự đoán** — agent turn nhận **200** từ gemini-3.6-flash (latency 3.9s) ⇒ 429 trước đó đúng là daily cap. **NHƯNG session vẫn fail, thủ phạm là 2 bug THẬT của router mình viết**: ① 1 spike 503 làm chain RỖNG 30s → router từ chối 6 request tiếp theo NGAY (audit `attempts: []`, latency 2-3ms) mà không thử gì → dsh abort; ② báo lỗi SAI: "all upstreams failed (tried: none)" trong khi chưa hề thử. Đã fix (cooldown chỉ DEPRIORITISE, không disable đường duy nhất + phân biệt error type thật) + 3 test hồi quy → **router 13/13 · 562ms**. **Phát hiện thứ 3 (an toàn)**: `dsh` TỰ `process.loadEnvFile(<cwd>/.env)` lúc boot → `unset ERPNEXT_*` ở shell VÔ HIỆU, patch "ý định mock" bị ghi đè thành REAL (probe chứng minh, 0 quota) → fix bằng literal `''` → `mock -> mock (in-memory)`. Harness E2E giờ nằm trong repo: `mcp-erpnext/dsh-e2e.patch.yml` + `scripts/llm-router.e2e.json` (default MOCK, `E2E_TARGET=real` mới chạm ERPNext thật).
- [x] 🎉 **E2E XANH — chuỗi thật chạy hết (result17 §K, 2026-09-15 14:40 giờ VN)**: user báo ERPNext hết 500 → verify REST thật (ping 200, khách thật "Anh Ba — xây nhà") → lấy ground truth độc lập (ACC-SINV-2026-00047, outstanding **457.875**) → chạy **1 session**: dsh → router → Gemini → MCP tool → NLP → **ERPNext THẬT** trả nguyên văn *"Khách hàng **Khách làm tròn 2026-09-15-p1b-wf1-2** hiện còn nợ **457.875đ** (1 hóa đơn chưa thanh toán)."* — **khớp chính xác ground truth**, dsh exit 0. Session chịu **7 lần provider 503 high-demand** mà vẫn xong (trước fix cooldown chỉ 1 lần đã giết session).
- [x] **Root cause thứ 2 của chuỗi tool: Gemini 3.x bắt buộc `thought_signature`** (result17 §L) — turn thứ hai (có tool result) chết `400 (no body)`; tái hiện rẻ bằng payload tối giản → nguyên văn *"Function call is missing a thought_signature in functionCall parts... `default_api:copilot_ask`"*. Kiểm chứng: Gemini CÓ trả signature (`tool_calls[].extra_content.google.thought_signature`) nhưng dsh drop; **mọi model trên key đều chặn** (2.5-flash 404 user mới; flash-lite/3.1-flash-lite/3-flash-preview đều 400) ⇒ phải xử ở gateway. **Đã fix**: `ThoughtSignatureCache` + capture qua stream + inject lại khi id khớp, bật theo upstream `geminiThoughtSignatures`, cache có trần LRU → **router 17/17 (590ms)** gồm 1 test integration thật (SSE → turn sau upstream NHẬN được signature). **Test toàn bộ: router 17/17 · mcp-erpnext 49/49**
- [x] **Upstream `mac-custom` (LLM tự host trên Mac, KHÔNG quota) — verify + E2E XANH (result20, 2026-09-15)**: endpoint `https://llm9000.loca.lt/v1` model `oc/big-pickle` — tunnel flaky (502/408 lần đầu, retry được: probe 3 lần = 502, 502, **200 "Hello! How can I help you today?"**). Đã thêm ĐẦU chain CẢ 2 config (dev hàng ngày); gemini-openai GIỮ NGUYÊN chỉ để verify tương thích provider thật (`E2E_LLM_MODEL=real-gemini`, không sửa file — router route THEO TÊN MODEL nên patch dsh chọn model qua env). **E2E thật qua mac-custom: dsh exit 0, audit 5 req (408, 502, 200×3), 2 turn replay tool đều 200** — trả 457.875đ ✓ khớp ground truth. ⚠️ **BUG MỚI tìm thấy qua E2E này**: copilot_ask trả **269.000đ/3 hóa đơn** cho khách smoke mới trong khi ERPNext thật = **171.800đ/4 hóa đơn chưa trả** — traced đến tận dòng code: `listUnpaidInvoices` lọc `outstanding_amount > 0` **loại credit note âm** (−97.200đ); tool thô 3.0.4 trả ĐÚNG 5 hóa đơn, NLP resolve ĐÚNG khách, LLM chỉ đọc lại kết quả tool. Vùng tiền — KHÔNG tự sửa, chờ user duyệt hướng `> 0` → `!== 0` + test (result20 §4)
- [x] **Commit đợt result20** ✅ `a379a71` (đã duyệt + push): mac-custom ĐẦU chain 2 config + `dsh-e2e.patch.yml` (model qua `E2E_LLM_MODEL`) + docs + result19/20
- [x] **Fix credit-note ĐÃ ÁP DỤNG (result21, CHỜ DUYỆT COMMIT — vùng tiền)**: `outstanding_amount > 0` → `!== 0` ở `mcp-erpnext/src/skills/customer.mjs` (helper `listUnpaidInvoices` dùng CHUNG cho `getCustomerBalance` + sales) và `sales.mjs`; mock thêm credit note SINV-0004 (−320.000) + filter mock đổi theo; nhãn "hóa đơn chưa trả" → "**chứng từ** chưa thanh toán" + nhánh mới "hiện dư X" khi outstanding âm. **Verify THẬT** (probe gọi thẳng `answerQuestion` với ERPNext thật, không LLM — số tiền không phụ thuộc LLM): **457.875đ/1 chứng từ ✓** và **171.800đ/4 chứng từ ✓** (trước fix: 269.000đ/3). Test: Python 58/58 · mcp-erpnext 50/50 · Flutter 14/14
- [x] **Review vòng 2 đợt fix (result21 §6) — tìm thêm 3 lỗi THẬT trong chính đợt này**: **(A nặng)** `node --test` discover MỌI file trong `test/` nên 2 batch runner (`batch-accuracy.mjs` 18 câu + `batch-groundtruth.mjs` dump khách/hóa đơn THẬT) bị chạy như unit test → trong shell đã `source .env` sẽ bắn vào ERPNext THẬT + in tên khách/số tiền thật ra stdout; fix guard `NODE_TEST_CONTEXT` (probe: `child-v8` vs unset — guard argv[1] một mình SAI vì runner spawn từng file). **(B)** `http-ask.test.mjs` làm TREO cả suite >120s: shell leak `ASK_USER/ASK_PASSWORD` (test chỉ strip `ERPNEXT_*`) → `resolveBindPolicy` throw trong SETUP → child Python rò → không exit; fix strip `ASK_*` + đưa mọi setup vào try/finally. **(C)** 5 kỳ vọng eval cũ `"(N hóa đơn"` sẽ báo FAIL GIẢ sau khi đổi nhãn → thêm `DOC=/chứng từ|hóa đơn/`, chấm theo số tiền + số lượng
- [ ] **Chờ user bật lại `lt` trên máy Mac** — tunnel `llm9000.loca.lt` đã TẮT (3 lần probe đều **503 "Tunnel Unavailable"**) ⇒ E2E đầy đủ qua `mac-custom` chưa chạy được (result21 §5)

### Các phase kế tiếp (chi tiết ở `next.md`)
- Phase 4 (STT) — chặn bởi audio · Phase 5 (Gateway) — ĐÃ MỞ (sign-off 2026-09-15), router bản đơn giản đã code (result14) ·
  Phase 6 (Entity resolution + Proposal card) · Phase 7 (**write đầu tiên** — Go/No-Go gate) ·
  Phase 8–15 (jobs/TTS, proposal state machine, multi-user, write mở rộng, multi-tenant,
  hardening, store, monetization-ads giữa 13 và 14)

### Nợ kỹ thuật Phase 1 (làm khi có dữ liệu quyết định)
- [ ] `bạc` = mệnh giá nào? — chờ user (`ch-003`)
- [ ] Viết tắt `m` (= triệu nhưng cũng = mét) — đoán là nguy hiểm (`ch-004`)
- [ ] Cờ `approximate` cho "khoảng/hơn 10 triệu" · số âm/hoàn tiền · tiếng lóng miền Trung ·
      phân biệt câu hỏi/lệnh (Phase 6)

---

## Cần hỏi lại / chờ user quyết định

- [ ] **Review `.project/ai-rules.md`** (MỚI 2026-09-14): file bạn nhắc tới KHÔNG tồn tại trước đó — agent đã tổng hợp từ AGENTS.md + operating_rules + thực tế result1→11. Duyệt hoặc sửa theo ý bạn; sau đó đây là nguồn quy tắc số 1 của `.project/`
- [x] ~~**Upstream LLM (result15):** ① Zen ② Gemini~~ — **user đã trả lời 2026-09-15**: Zen để sau (giữ billing-blocked), Gemini giữ free tier. Lưu ý result17 đính chính: phần lớn "flaky" trước đây là **bug cooldown của router**, không phải free tier
- [x] ~~**ERPNext thật đang 500**~~ — user đã khắc phục cùng ngày (14:35 verify: ping 200 + đọc được khách thật) → E2E thật đã chạy xanh (result17 §K)
- [ ] **4 câu của Phase 15 (monetization):** ad provider · múi giờ tính "hết ngày" ·
      danh sách tính năng pro · có IAP bỏ ad không
- [ ] **`bạc` mệnh giá** (`ch-003`) + có chấp nhận `m` = triệu không (`ch-004`)
- [ ] **Vị trí OmniRoute/9Router + TAXPRO** — nếu mang code từ máy local sang thì refactor
      shared lib; trên máy này không có (đã chốt xây mới)
- [ ] Flutter client track chi tiết (navigation/state/token sâu hơn) — có cần phase riêng không,
      hay tích lũy dần trong Phase 4+ (hiện MVP đã có nền: Riverpod + 1 route + theme seed)

---

## Note

- Đừng báo "xong" bằng lời — mọi claim cần lệnh + output thật (`erpn-verify-first` skill).
- **Vùng tiền/số/phân quyền: AI KHÔNG tự ký duyệt, KHÔNG tự commit** — chờ user review.
- **Gate pháp lý Phase 5: ĐÃ KÝ 2026-09-15 (không scrub)** — quyết định lưu ở `SIGNOFF-phase5-pii.md`; các gate ký duyệt TƯƠNG TỰ về sau vẫn chờ user.
- Tool đang hỏng trong env này: AgentMemory (down) · MCP cocoindex/codebase-memory (không
  expose) · OCR (không chạy được) · Simplenote (không có) → Code Review thủ công, không tự cài.
