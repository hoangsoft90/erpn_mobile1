# next.md — Roadmap ERPNext Vietnamese Voice Copilot (erpn_mobile1)

Đường đi tính năng đã hoàn thành và sắp tới. Bằng chứng từng phase: `result*.txt`.
Trạng thái tóm tắt (đã làm/chưa làm/chờ ai): `checklist.md` — hai file này không nhân bản nhau.

**Định vị sản phẩm:** không phải "chatbot ERPNext", mà là **lớp AI UI trên ERPNext** —
`understand → plan → act → verify → report`. Chat/voice chỉ là phương thức nhập liệu.
Client đích đã chốt: **Flutter** (không phải PWA).

---

## Đã hoàn thành

### P0 (phases2) — Capability Contract + Safety foundation + Golden Dataset ✅ ĐÃ COMMIT `b4acdb1` (đã push) — `.plan/phases2/p0-result.md` §10

Lộ trình production trong `.plan/phases2/` (nguồn kiến trúc: `.plan/plan2_final.md`) — **không thay** lịch sử MVP ở `.plan/phases/`.

- **Capability Contract** `mcp-erpnext/capabilities.json` là single source of truth (router + skill + safety + authorization + test cùng đọc) — 7 capability, validate fail-closed
- **Safety Gateway** `src/safety-gateway.mjs` là cửa DUY NHẤT cho mọi WRITE; `/execute` không còn policy trong HTTP layer; có **test tĩnh no-bypass**
- **Kill switch** `global_read_only` (env hoặc flag file) ⇒ `503 SYSTEM_MAINTENANCE`, không tiêu tốn `command_id`
- **`custom_ai_action_id`** (unique+indexed) ĐÃ có trên ERPNext demo; `action_id` ghi khi tạo PE + reconcile theo field
- **Golden Dataset v1** 200 câu/6 bucket, runner chạy lõi deterministic — **6/6 bucket đạt ngưỡng**
- `document.delete` **không** tồn tại trên AI path (`403 FORBIDDEN_IN_AI_PATH`, không sinh proposal)
- **Vòng tự review sau P0 (2026-09-17) — 3 lỗi THẬT trong chính đợt refactor, đã sửa + falsify**: lỗi cấu hình ERPNext từng **giết cả process** (client được tạo NGOÀI `try` ⇒ unhandled rejection), từng **treo vĩnh viễn khoá ý định `(customer|invoice)`** (lỗi config để lại PENDING không `reference_no`), và **rò rỉ process con** khi `initialize()` fail. Kèm gia cố: `params.amount_vnd` thiếu ⇒ **TỪ CHỐI** (không để tầng dưới tự clamp tiền); test tĩnh no-bypass quét thêm `scripts/`. Bằng chứng: `result44.txt` §3–§9.
- Suite: Python 60 · **Node 156** · Flutter 63 · analyze 0

**Bước kỹ thuật tiếp theo = P1 → P2** (đã xong, xem 2 mục bên dưới) — **KHÔNG** nhảy P9 (skill mới) hay P5 (DSH trên `/ask`). Voice (**P6**, `speech_to_text` OS STT) **đã bỏ gate audio** 2026-09-18 — xem mục P6 bên dưới; không mở lại Phase 4/8/10–15 cũ.

### P1 (phases2) — Entity Execution Resilience ✅ ĐÃ COMMIT `ee93f13` (đã push 2026-09-17)

- **Entity 4 trạng thái** (`EXACT_MATCH`/`FUZZY_SINGLE_MATCH`/`AMBIGUOUS_MATCH`/`NO_MATCH`) theo contract `capabilities.json` (policy nằm trong contract, không hard-code) — `src/entity-resolution.mjs`
- **WRITE HIGH không auto-select fuzzy**; AMBIGUOUS → candidate picker Flutter (`entity_picker.dart` + `chat_bubble.dart` render) → `/ask` nhận `entity_id`, server **re-validate trên fresh ERPNext read** (id chỉ là hint, không phải authority)
- **Immutable proposal snapshot** (`proposal_id` + `version` + `expires_at` + entity/amount đóng băng lúc tạo) — confirm gửi kèm snapshot identity
- **Mã từ chối tách rõ**: `PROPOSAL_EXPIRED` (TTL) vs `PROPOSAL_VERSION_STALE` / `PROPOSAL_ENTITY_CHANGED` (re-validate lệch) — Flutter banner phân biệt, không còn gộp chung STALE
- **State machine subset + `UNKNOWN_EXECUTION_STATE` → RECONCILING** theo `custom_ai_action_id` — `src/execution-state.mjs`
- **Business dedup (fingerprint)**: cùng ý định (customer|invoice|amount) cảnh báo trước, confirm phải gửi `dedup_ack: true` — **không thay** `command_id` idempotency — `src/business-dedup.mjs`
- **Degraded: NLP down → chặn WRITE** phụ thuộc amount parse (fail-closed, không đoán số tiền)
- **Review vòng 2 (result45)**: fix harness Flutter `_bodyOf` (dio đưa request Map nguyên vào adapter — cast `as String` ném TypeError bị bọc thành "Không kết nối được máy chủ", capture rỗng); soi 2 điểm wiring: `/execute/cancel` là lock-release CỐ ÊN không qua kill-switch (đúng thiết kế, có comment), `entity_id` re-validate đúng — không sửa gì server
- Suite: Python 60 · **Node 172** · **Flutter 67** · analyze 0 — bằng chứng `result45.txt`

### P2 (phases2) — Session context + Uncertainty UX ✅ ĐÃ COMMIT `33ff725` (đã push)

- **Uncertainty taxonomy** `src/uncertainty.mjs`: 11 mã chuẩn + copy tiếng Việt BẮT BUỘC từng mã; `toUncertaintyCode()` map raw→chuẩn, unknown ⇒ null (không chế); mọi refusal trong copilot-server trả kèm `uncertainty:{code,message,detail}`
- **Session context** `src/session-context.mjs`: customer 30m · invoice 10m; provenance `user_selected`/`derived`; entry hết hạn bị XOÁ khi đọc
- **WRITE fail-closed theo context**: chỉ `user_selected`/exact trong TTL mới seed payment; derived (fuzzy READ) không bao giờ; hết hạn = như lần đầu nhắc (guard P1 hỏi lại)
- **KNOWN_INTENT_UNIMPLEMENTED**: capability stub (sales.summary, skill:null) trả "hiểu nhưng chưa có" — tín hiệu học cho P4; cần thêm "doanh thu" vào routing keywords sales (đã sửa contract)
- **Flutter PipelineProgress**: 4 nhãn pha (hiểu → tra khách → kiểm tra → chờ xác nhận) thay spinner trần; Timer.periodic cancel-in-dispose
- **Falsify 3 luật** (trên /tmp): gỡ provenance check → FAIL đúng assertion; gỡ TTL expiry → FAIL 2 test; hoán vị forbidden/stub → forbidden-path FAIL
- Deliverable 5 (optional, sửa amount trên card) ⏭ bỏ qua có lý do — chờ user
- Suite: Python 60 · **Node 181** · **Flutter 69** · analyze 0 — `.plan/phases2/p2-result.md`

### P3 (phases2) — LLM Classifier (async) + Regression gate ✅ ĐÃ COMMIT `c38e4ea` (đã push)

- **Classifier semantic-only** `src/classifier.mjs`: gọi LLM Router Phase 5 (`POST /v1/chat/completions`, OpenAI-compatible) — **không** agent loop, **không** DSH, **không** tool-call
- **Không bao giờ trả ERP id**: 2 lớp — regex `ID_LIKE_KEY` (`*_id`/`docname`/`erpnext_id`…) + allowlist `SLOT_KEYS` (text-only); ID chỉ từ Entity Resolver
- **Intent ∈ Contract**: `allowedIntents()` = contract trừ forbidden ⇒ model không được nêu `document.delete`; intent lạ ⇒ rơi về rule-only
- **Chỉ route, không hành động**: `routeByCapability(intent)` đưa vào ĐÚNG skill/Safety path cũ (forbidden/stub/Safety Gateway/entity resolver y hệt); confidence không bypass confirm/authz
- **Degraded** (LLM down/timeout 2500ms/malformed) → rule-only `UNKNOWN_INTENT`, không 500 mù; confidence thấp → `LOW_CONFIDENCE` (copy P2, `needs_clarification`)
- **Untrusted-data** wrap trước khi vào prompt (module P0 tái dùng)
- **CI gate mới**: `test/golden/classifier-cases.json` (9 case) + `test/p3-classifier-regression.test.mjs` — **mock LLM** (không provider/quota) ⇒ deterministic; `golden-dataset.json` 200 câu vẫn xanh
- Falsify 3 luật trên /tmp (F4 forbidden-offerable, F1 id-leak, F3 low-confidence) đều đỏ đúng chỗ; fix thêm 1 **test flaky có sẵn** (bucket 15-phút của P1 dedup)
- Suite: Python 60 · **Node 195** (181→195) · **Flutter 69** · analyze 0 — `.plan/phases2/p3-result.md` · `result47.txt`

### P4 (phases2) — Learning loop (human-approved) ✅ ĐÃ COMMIT `d7e9ba9` (đã push)

- **Signal log** `src/learning-log.mjs`: mỗi câu hỏi/câu trả lời → 1 dòng JSONL (`outcome` taxonomy, không secrets, text cap 500, UTC); never-throw (log hỏng không được làm hỏng câu trả lời); dir repo-local `learning-log/` (gitignored, KHÔNG /tmp — bài học result31)
- **Cluster report** `npm run learning:cluster` — READ-ONLY, nhóm UNKNOWN/UNIMPLEMENTED/LOW_CONFIDENCE theo tần suất + ví dụ nguyên văn, có gợi ý trigger để người sửa contract
- **Vòng thử thật**: log 9 câu → cluster chỉ ra `"doanh số …"` chưa route (5 biến thể) → người thêm trigger vào contract + golden +2 case → golden 7/7. Đây là đường DUY NHẤT để contract tiến hoá (không auto-write)
- Review vòng 2 bắt 2 lỗi: `copilotAsk` (đường dsh) chưa qua wrapper log; và claim “E2E 1 call = 1 dòng” chưa có test ⇒ viết test E2E thật (spawn NLP + copilot con)
- Suite: Python 60 · **Node 204** · Flutter 69 · analyze 0 — `result48.txt`

### P5 (phases2) — DSH explicit opt-in READ ✅ ĐÃ COMMIT `6318eca` (đã push)

- `src/dsh-optin.mjs`: dsh CHỈ chạy khi được spawn với `COPILOT_DSH_CONTEXT=1`; **`/ask` không có đường nào spawn dsh** (test tĩnh quét toàn bộ `src/`)
- Trong context dsh: mọi WRITE bị `DSH_WRITE_BLOCKED` TRƯỚC skill factory (`proposal: null`), READ vẫn trả lời bình thường; cả hai vẫn vào learning log
- `docs/dsh-optin.md` (2 chế độ + lệnh smoke); review vòng 2 fix 2 lỗi (`DSH_WRITE_BLOCKED` thiếu trong taxonomy P2; bị xếp nhầm bucket `error`)
- Suite: **Node 212** · `result49.txt`

### P7 (phases2) — Background job queue ✅ ĐÃ COMMIT `3e6240a` (đã push)

- `src/job-queue.mjs`: WRITE đã confirm mà ERP tạm down (verdict `retry_same_command_id`) → QUEUED; replay qua ĐÚNG `runExecute` (không có write path thứ hai); bounded retry; crash-recovery `RUNNING → RETRYING`; `release()` khi cancel; `completed()` cho report
- **`startJobRunner()` nối vào `main()`** — trước đó job được enqueue mà không ai drain (exit criteria P7 chỉ đúng khi chạy trong test); `GET /jobs` trả `pending` + `completed`
- Review tìm 5 finding, falsify 4 guard; TTS ⏭ skip có lý do (việc client, không cần cho exit criteria)
- Suite: **Node 228** · `result50.txt` + `.plan/phases2/p7-result.md`

### P10 SLICE — Rate limit + Correlation trail ✅ ĐÃ COMMIT `7cb2798` (đã push)

- **Rate limit thật** (trước đây chỉ khai trong contract, chưa ai enforce): per user (read 30/phút · write_proposal 10/phút · write_execute 5/phút) + per capability (`payment.create` 20/giờ); vượt ⇒ 429 + `Retry-After` + câu tiếng Việt
- **Vượt hạn mức KHÔNG đốt `command_id`**: charge TRƯỚC Safety Gateway (đo thật: `store.status(cid) = null`, 0 chứng từ; sau cửa sổ mở lại ghi đúng 1 lần)
- **Câu ĐỌC không tiêu ngân sách ghi** (`proposalBucketFor()` theo loại contract, vì mọi route ĐỌC cũng trả proposal)
- **Correlation §17** trên `/ask` + `/execute` + job runner qua `logEvent()` (`request_id/user_id/command_id/action_id/erp_document_id/capability/risk/latency_ms`)
- **3 lỗi thật của chính code vừa viết đã sửa**: viết lại `capabilityForAction` với nhánh không tồn tại (limit `payment.create` tắt lặng lẽ) · `export {x} from` không tạo binding (mọi `/ask` 500) · meter theo “có proposal” thay vì theo loại
- Suite: Python 60 · **Node 240** · Flutter 69 · analyze 0 · falsify 4 guard — `result51.txt` + `.plan/phases2/p10-result.md`
- **Gap giành cho P10 full**: restore drill · **chạy thử runbook** (đã viết `docs/kill-switch-runbook.md`, chưa diễn tập trên gateway thật) · dashboard/log query · load test · APK device (human) · compliance note · rate-limit store phân tán (hiện in-process, reset khi restart)
- **Review vòng 3 (2026-09-18, sau commit)**: **F5** đính chính claim "in-app polling" ở P7 (client KHÔNG poll `/jobs` — gap UX, không phải gap an toàn tiền) · **F6** bịt lỗ hổng bằng chứng: thêm test E2E cho đường per-capability (chính chỗ lỗi F1 từng hỏng im lặng) + falsify bằng cách tái tạo lỗi F1 · **F7 → ĐÃ GIẢI QUYẾT (xem dưới)**

- **Commit đợt review vòng 3**: `21d77ff` (test E2E per-capability + `docs/kill-switch-runbook.md`) · `d6295ab` (bài học vòng 3)

**Phases2 đã ĐÓNG: P0 `b4acdb1` · P1 `ee93f13` · P2 `33ff725` · P3 `c38e4ea` · P4 `d7e9ba9` · P5 `6318eca` · P6 `9b54d35` · P7 `3e6240a` · P8 `90401f0` · P10-slice `7cb2798`/`21d77ff`/`d6295ab` (tất cả đã push).**

### P8 (phases2) — Multi-user / RBAC / company scope ✅ ĐÃ COMMIT `90401f0` (đã push)

- **`src/authorization.mjs` (mới)** — boundary phân quyền server-side, đọc từ `capabilities.json` (không hardcode capability nào trong logic): `resolvePrincipal` · `checkPermissions` · `resolveCompanyScope` · `authorize` · `describeAuthorization`
- **2 chế độ**: `multi_user` (`COPILOT_USERS` JSON, tường minh) và `single_tenant` (mặc định — giữ hành vi cũ để **không chặn lệnh ghi khi nâng cấp**; đo thật: bỏ miễn trừ này làm đỏ **33 test**). Company: server-first (principal → `COPILOT_COMPANY` → request); multi-user thiếu company ⇒ `COMPANY_SCOPE_REQUIRED` (map về copy P2 `AUTHORIZATION_DENIED` để user luôn có chữ)
- **Wire**: `/ask` chặn **trước** `route.factory()` (không sinh proposal, không đọc ERPNext) · `/execute` chặn ở bước 1b **trước** idempotency (403, **không tiêu `command_id`**) · `/jobs` lọc theo actor · `/execute/cancel` chỉ chủ lệnh hoặc người có quyền · job replay mang `user_id` gốc ⇒ phân quyền **tính lại tại thời điểm ghi**
- **Audit**: `user_id`+`company` vào record idempotency và job; `logEvent` của `/execute` + `/cancel` nay dùng `principal.user_id` (một khái niệm "ai" duy nhất cho cả rate-limit/audit/job)
- **Test**: `test/p8-authorization.test.mjs` **+17** · **falsify 13 guard** (gồm 1 lần guard **không thể falsify** ⇒ phát hiện nhánh allow-list chưa từng được test) · self-review tìm **5 lỗi thật** (rò `/jobs` chéo user · cancel không kiểm ai · `COMPANY_SCOPE_REQUIRED` không có copy · audit ghi sai người · allow-list không test nào chạm) · **Node 267** (250→267)
- Bằng chứng: `.plan/phases2/p8-result.md`

### F7 + F7-2 + Golden gaps (2026-09-18) ✅ ĐÃ COMMIT `3b41313` · `eb4ba34` · `c5db7cc` (đã push)

- **F7 — policy (a) do user chọn**: refusal bảo trì (`SYSTEM_MAINTENANCE`/`CAPABILITY_DISABLED`) xảy ra **TRƯỚC khi thử ghi** ⇒ không phải một lần thử — `job-queue.mjs` thêm `isTemporaryRefusal()` + nhánh drain: job về lại RETRYING, attempts roll back về 0, backoff hẹn lại, JSONL ghi `TEMPORARY_REFUSAL`; tắt switch ⇒ tự chạy lại VERIFIED đúng 1 lần; lỗi ghi thật giữ nguyên FAILED-terminal. `result53.txt`
- **F7-2 — submit switch**: setting **"Cho phép nộp phiếu thu thật"** (mặc định OFF, dialog xác nhận riêng) · cờ **frozen vào proposal snapshot lúc hỏi** (không đọc lại lúc execute) · ON ⇒ sau draft OK gọi `erpnext_doc_submit` (tool thật, read từ source 3.0.4) qua write gate mở rộng fail-closed; submit lỗi giữa chừng ⇒ **PARTIAL** ("đã tạo nháp, submit lỗi: …, cần submit tay trên ERPNext") — không FAILED · Flutter 80/80 (+11 test) · falsify 3 lớp độc lập
- **Golden gaps k18/m15 sửa xong**: "một triệu hai" = 1.200.000 (shorthand có luật chặt chống va danh xưng); "Con Linh" resolve thành tên "Linh" — Golden runner **0 miss**, gate P9 mở · Python 62
- Suite: **Python 62 · Node 250 · Flutter 80 · analyze 0** — bằng chứng `result53.txt` + `result54.txt`

### P6 (phases2) — Voice / STT (`speech_to_text`) ✅ ĐÃ COMMIT `9b54d35` (đã push)

- **Gate 150 câu audio đã BỎ** (user, 2026-09-18): P6 dùng **STT của OS** (`speech_to_text` 7.5.0), không tự host model, không corpus riêng
- Luồng đúng luật `plan2_final` §20: 🎙 mic → STT → **text vào CHÍNH ô nhập editable** → user nhìn/sửa → **Gửi** → `POST /ask`; STT **không bao giờ tự gửi**, không có đường tới `/execute`
- `lib/features/chat/data/speech_service.dart`: interface mỏng `SpeechService` (mockable — CI không cần mic) + `SystemSpeechService`; `SpeechStatus` tách `denied` vs `unavailable` để thông báo đúng việc user cần làm
- Quyền: `RECORD_AUDIO` + `<queries>` `android.speech.RecognitionService` (Android 11+ package visibility). **Repo không có target iOS** ⇒ keys `Info.plist` ghi lại trong `p6-result.md` khi thêm iOS sau
- Locale: máy có `vi*` thì dùng entry đó; **không có (kể cả list rỗng) vẫn xin `vi_VN`**; dictation giữa lúc đang gõ không xoá chữ đã viết; partial result **thay** không nối; `dispose()` đóng mic
- **21 test**: `test/voice_input_test.dart` (15, mock STT) + `test/speech_service_test.dart` (6, chạy trên **subclass của plugin thật**) + **falsify 8 guard** (auto-send → 3 đỏ; nuốt im lặng khi bị từ chối quyền → 2 đỏ; bỏ qua `unavailable` → 2 đỏ; mic mở sau lưng request → 1 đỏ; **kết quả muộn ghi đè ô nhập → 2 đỏ; double-tap mở 2 phiên → 1 đỏ; cảnh báo che "Đang nghe…" → 1 đỏ; bỏ session token → 3 đỏ**) — khôi phục `diff clean`
- **Self-review sau khi viết tìm 4 lỗi THẬT đã sửa** (xem `p6-result.md` §"Vòng self-review"): kết quả STT đến muộn viết lại câu cũ vào ô vừa gửi (nặng nhất — plugin ghi rõ `stop()` LUÔN bắn thêm 1 kết quả) · `_notice`/`_listening` viết thành `else if` che mất phản hồi "Đang nghe…" · double-tap mở 2 phiên · `cancel()` hứa "không có text sau đó" mà không ai thực thi
- Suite: Python 62 · Node 267 · **Flutter 107** (80→107) · analyze 0 — `.plan/phases2/p6-result.md`
- **Bugfix P6 (2026-09-18) ✅ ĐÃ COMMIT `77e2b57` + docs `bbca7ca` (đã push) — `result55.txt`**: user báo trên máy thật "Gboard hiểu tiếng Việt nhưng app báo *Máy không có bộ nhận dạng tiếng Việt*". Gốc: doc plugin `locales()` ghi rõ danh sách đó **chỉ phủ recognizer ON-DEVICE**, có thể thiếu ngôn ngữ mà recognizer ONLINE vẫn nhận ⇒ coi `locales()` thiếu `vi` = "máy không hỗ trợ" là **suy diễn sai**. Sửa: luôn xin `vi_VN` + tín hiệu `localeVerified` tách khỏi "dùng được hay không" + retry 1 lần với locale mặc định khi platform từ chối + refusal ngôn ngữ **không** tắt service + UI **không hiện gì về locale** (bỏ luôn gợi ý nhẹ — cùng ngày, user yêu cầu; cảnh báo thật denied/unavailable/error_language_* vẫn giữ). +6 test, falsify 5 guard, Flutter 101→107.
- **P6 UX "Tự gửi sau khi nói xong" (⏳ CHỜ DUYỆT COMMIT)**: switch Settings mặc định OFF; ON ⇒ final STT + ô nhập có text ⇒ gọi cùng `onSend()` (`POST /ask`); partial/transcript rỗng không gửi; không auto-confirm WRITE/`/execute`. +13 test, falsify A/B/C, Flutter 107→**120** (`result55.txt` §10–§11); review vòng 3 gỡ guard chết thứ 3 (`_maybeAutoSend` còn 1 điều kiện) + sửa 2 doc sai + sửa báo-sai-kết-quả-lưu · ❓ **chờ user**: `pauseFor: 3s` ⇒ khi BẬT, ngập ngừng giữa câu là gửi câu nửa vời — chọn (a) giữ + ghi rõ cỡ 3 giây vào copy Settings / (b) tăng `pauseFor` khi BẬT / (c) chỉ auto-send khi user **bấm dừng mic** (`human.md` §1)
- **APK CI: ✅ đã build lại** — run `35367603981` success (artifact `erpn-chat-debug-apk`, 84.169.705 bytes), **xác minh binary chứa bản fix** (câu SAI cũ = 0 lần trong `kernel_blob.bin`) ⇒ plugin native build được trên CI
- **Gap còn lại (chỉ người thật)**: cài APK + smoke mic trên **máy thật có Gboard tiếng Việt** (checklist 7 bước trong `p6-result.md`, mục 7 đã sửa theo bugfix này) — theo dõi ở `human.md` §2

Bước kỹ thuật tiếp theo: **P9** (skill mới — **gate ĐÃ MỞ** sau khi Golden 0 miss, cần user ra lệnh) — riêng **P10 full** (DR drill, dashboard, load test, rate-limit store phân tán) vẫn hoãn.
### F7 — ĐÃ GIẢI QUYẾT (user chọn policy (a), 2026-09-18)

> **Luật mới: bảo trì/kill switch KHÔNG phải một lần thử.**
- `job-queue.mjs` thêm `isTemporaryRefusal()` (`SYSTEM_MAINTENANCE` · `CAPABILITY_DISABLED`): drain gặp
  refusal tạm thời ⇒ job về lại **RETRYING**, **roll back bộ đếm attempt** (chưa hề thử ghi thì không
  tính là thử), **không FAILED**, hẹn `next_attempt_at` theo backoff hiện có, JSONL ghi sự kiện
  `TEMPORARY_REFUSAL`.
- Tắt bảo trì xong ⇒ **lần drain kế tiếp tự nhặt lệnh lên** (polling có sẵn của runner) — không cần
  bấm lại `command_id`; chạy đúng 1 lần ⇒ VERIFIED (attempt đầu tiên THẬT mới được tính).
- Hành vi lỗi GHI THẬT không đổi: non-retryable (vd `PROPOSAL_STALE`) vẫn FAILED-terminal.
- Test: 3 case mới (giữ trạng thái + không tiêu attempt qua nhiều lần bảo trì · tắt switch → VERIFIED
  đúng 1 lần · lỗi thật vẫn FAILED). **Falsify**: gỡ nhánh tạm thời → 2 test ĐỎ đúng assertion
  (`expected RETRYING / actual FAILED`) — khôi phục byte-identical, 19/19 xanh. Bằng chứng `result53.txt`.
KHÔNG lùi về phase-04/08/10–15 cũ.

### Phase 0 — Foundation & Verification ✅ (`result1.txt`)

Không viết code. Chặn fabrication trước khi code (bài học `plan1_review1.md`).

- Pin `@casys/mcp-erpnext@3.0.4` + **stdio** (né breaking change HTTP 3.0.0:
  stateless, đòi `MCP-Protocol-Version: 2026-07-28`)
- **Agent Runtime = dsh** (`deepseek-ai/deepseek-harness`, MCP client built-in).
  Rủi ro ghi nhận: 20/20 version là rc/alpha. 2 trigger tách khỏi dsh:
  (1) ≥2 user cần credential khác nhau → Phase 10; (2) dsh breaking change phá production
- STT order: Web Speech API → Cohere Transcribe → Whisper API → PhoWhisper CPU
- Phát hiện ngược review6: 5 repo "DSH mobile" đều tồn tại thật — vẫn loại vì thẩm định an toàn
- Chốt xây mới NLP + LLM Router; gate **Mandatory Sign-off PII** thêm vào phase-05 (NĐ13/2023)

### Phase 1 — Vietnamese NLP Pipeline ✅ (`result1–3.txt`)

Python `src/vietnamese_nlp/`, stdlib thuần, chạy TRƯỚC LLM — cố định bằng code, không phụ thuộc prompt.

- Number normalizer → integer VND (14/14 dạng bắt buộc + mở rộng: `1tr5`, `230.000`,
  `1 500 000đ`, `0.5 triệu`, `2 triệu rưỡi`, `1 tỷ 200 triệu`, slang `trẹo`/`chai`…)
- **Fail-safe cốt lõi**: `"Bác Hai"`, `"hai trăm"`, `"2 triệu 500"` → KHÔNG sinh số thay vì đoán sai
- Kinship 21 title (birth-order nickname là tên); synonym 10 intent (sản phẩm không bị map:
  `cám heo` giữ nguyên); quantity extractor; CLI độc lập
- **58/58 test · money 259/259 = 100%** sau 2 đợt fix thật (3 bug sai im lặng; 4 false positive +
  hậu tố dính liền + chặn merge rác `2tr5k`)
- Đợt fix result9: kinship chỉ strip cụm xưng hô ĐẦU câu — title giữa câu là phần tên thật
  trong DB (`"Công trình nhà ông An"` có thật trong 26 khách)

### Phase 2 — MCP ERPNext read-only + skill layer + cầu nối + đo thật ✅ (`result4–9.txt`, commits `0ac8e61` + `119edd4`)

- Skill layer: readonly-guard chặn write ở tầng code; 12 tool đọc thật `erpnext_*`;
  `assertKnownId` (ID chỉ từ tool result); `markUntrusted` bọc dữ liệu ERPNext
- Cầu nối Python HTTP (`nlp_service/server.py`, stdlib, 127.0.0.1) — đúng quyết định cầu nối đã khóa
- Copilot MCP server 1 tool `copilot_ask` cho dsh; env-switch real/mock (thiếu var → mock,
  sai config → hard error, không bao giờ âm thầm rơi về mock)
- dsh 0.1.5-rc.1 headless E2E thật với ERPNext thật qua ngrok: *"Khách smoke 2026-09-13-p1done
  còn nợ 269.000đ (3 hóa đơn chưa trả)"* — khớp đúng 3 hóa đơn thật
- **Đo accuracy thật theo exit-criteria phase-02 (result9): 18 câu tiếng Việt đa dạng qua
  `answerQuestion()` với ERPNext thật** — expected lấy từ ground-truth dump cùng ngày
  (26 khách / 37 hóa đơn / 29 phiếu thu / 14 dòng tồn kho):
  **vòng 1 = 27.8% → vòng 2 = 61.1% → vòng 3 = 18/18 = 100%**
- **5 nhóm lỗi mà unit xanh (36/36) không bắt được** — đã fix kèm unit test bám theo:
  ① router nhóm customer (khách/nợ/còn lại) nuốt câu hỏi hóa đơn/kho → specific TRƯỚC customer
  ② nameCandidates prefix-only → tên giữa câu không bao giờ được thử → mọi token substring,
  dài nhất trước, fetch list 1 lần/câu (trước đây tới 100 MCP round-trips)
  ③ kinship strip title giữa câu phá tên thật → chỉ strip vocative đầu câu
  ④ payment tool 417 (site chặn field `currency`) rồi đòi `party_type` → fallback
  `erpnext_doc_list` + thêm param
  ⑤ inventory trả cả kho → lọc theo vật tư hỏi (word-prefix dài nhất, 2 passes)
- **An toàn tiền củng cố bằng chính batch test**: hỏi khách không tồn tại / fragment 1 từ khớp
  19 khách → trả null + lý do, KHÔNG chọn hộ khách nào (b07 từng trả nhầm 457.875đ của khách khác)
- **Test cuối: 40/40 node --test · 58/58 Python (money corpus nguyên vẹn)**

### Phase 3 — Flutter chat MVP ✅ (`result7–8.txt`, commit `590b1b2` + CI fix `119edd4`/`c3d74c3`)

- `apps/mobile` (Flutter 3.47.2 / Dart 3.13.2, Riverpod + dio, GoRouter 1 route): màn hình chat,
  lịch sử `chat_history_v1` (SharedPreferences), empty state, SnackBar lỗi giữ text,
  footer hiện `COPILOT_BASE_URL` đang nói với server nào
- HTTP `/ask` wrapper (`mcp-erpnext/src/http-ask.mjs`) — app không gọi MCP trực tiếp
- GH Actions `android-debug-apk`: analyze --fatal-infos → test → build APK debug (dart-define
  `COPILOT_BASE_URL`/auth từ repo Variables/Secret — artifact cài được lên máy thật) → artifact
  `erpn-chat-debug-apk`; **run 1 FAILURE** (gitignore `*.g.dart` không lên CI) → **run #2 + #3
  SUCCESS sau khi thêm step build_runner + dart-define** (`result10.txt`, `result11.txt`)
- Flutter analyze 0 issue · 13/13 test; bug thật nổi bật: ChatBubble không bao giờ render
  answer (bắt bằng debug test in toàn bộ Text trong tree)

### Hạ tầng dự án ✅

- Git: branch `change/flutter-chat-mvp`, remote `origin = github.com/hoangsoft90/erpn_mobile1`
  (setup trong phiên result9 từ `.env` GH_REPO_URL/GH_TOKEN); commits `33f9dc0` → `0ac8e61`
  → `590b1b2` → `119edd4`; `.env` git-ignored, secret scan trước mỗi commit
  (result9 đã redact key lộ khỏi file evidence trước khi commit)
- 2 project skills (`.agents/skills/`, local-only — user chốt 2026-09-16: KHÔNG vào repo):
  `erpnext-mcp-connect` + `erpn-verify-first`
  + `erpn-dsh-setup` (result15 — cài/chạy dsh + cơ chế cordis patch, thay công thức result6)
- Tài liệu phiên mới: `.project/` (kiến thức tĩnh) + memory files; `.project/openspec.md`
  là pointer — **1 nguồn sự thật duy nhất**: checklist.md (trạng thái) + next.md (roadmap)
  + result*.txt (bằng chứng)

---

## Sắp tới

### ĐÃ DUYỆT — XONG trong phiên result31 (2026-09-16) · review vòng 2 kèm 2 fix — ✅ COMMIT `bda54cf` ĐÃ PUSH

0. ✅ **Review vòng 2 (result31 §11) — ĐÃ COMMIT `bda54cf`**: **F1** anchor `startsWith` vẫn nuốt câu ĐỌC lịch sử (`'thanh toán gần nhất của chị Lan...'` → `'payment gần nhất...'` → routed payment_write SAI — probe `answerQuestion()` thật) ⇒ fix `notIf` deny-list (bao nhiêu/mấy/gần nhất/mới nhất/?) → câu hỏi rơi về nhóm payment ĐỌC; +1 test round 2, falsify đạt (gỡ gate → FAIL đúng assertion). **F2** `store.cancel()` ngoài try/catch — race với `/execute` đồng thời ⇒ throw uncaught ⇒ **Node ≥15 crash cả process** (bằng chứng cơ chế: async handler throw → exit 1; suite không bắt được vì child-process cách ly) ⇒ bọc try/catch → 409. **F3** reason dùng `rawText`. Suite sau review: **Node 119/119 · Python 60/60 · Flutter 29/29 · analyze 0**.

1. ✅ **Gộp 1 commit `eea0411`** (thay cho tách 3 — user quyết) + push: 37 files, +3794/−124 (Stage B + fix money/identity + Phase 9 safety + docs result24-30).
2. ✅ **Nối `buildPaymentProposal()` vào `routeIntent()`**: nhóm `payment_write` ĐẦU ROUTES, anchor `startsWith` đầu câu (synonym mapper biến "thu tiền" → "payment" đầu câu; nếu so substring sẽ nuốt câu đọc chứa "đã/chưa thanh toán") → "thu tiền cho chị Lan 500 ngàn" qua pipeline thật = proposal `create_payment_entry`/HIGH, amount từ NLP, invoice nợ cũ nhất; thiếu tiền ⇒ đề xuất THU HẾT nợ (vẫn HIGH, không ghi ngầm). Sửa chữ cũ "Phase 2 chỉ đọc" (grep 0 hit). E2E + widget test với JSON server trả về verbatim — nút [Xác nhận] hiện thật trên Flutter. Falsify: gỡ anchor → 15/16 FAIL; phá confirmable → widget FAIL; khôi phục xanh.
3. ✅ **Route `/execute/cancel`** (giải zombie PENDING result29 §10-F2): `store.cancel()` chỉ từ PENDING; COMPLETED ⇒ 409 + result; PENDING ⇒ `reconcilePaymentEntry()` trước — 0 chứng từ mới CANCELLED, thấy chứng từ ⇒ 409 + `erpnext_doc` (kèm test retry /execute cùng id → replay). 503 khi ERPNext chết lúc đối soát. Falsify: disable nhánh chặn → 13/14 FAIL đúng chỗ; khôi phục 14/14.
4. ✅ **Xoá 2 PE demo `ACC-PAY-2026-00114/00115`**: đọc source tìm tool thật (`erpnext_doc_delete` — draft OK, không cần cancel vì docstatus 0); gọi qua JSON-RPC thô MỘT LẦN theo lệnh user (đường xoá KHÔNG được mở vào code sản phẩm); verify độc lập: cả 2 GONE + `ACC-SINV-2026-00047` outstanding 457.875 Unpaid — GIỐNG HẾT trước xoá.
5. ✅ **faq.md** đầu-file + §3.2/§3.3/§9/§8 cập nhật khớp hành vi mới (nút [Xác nhận] chỉ hiện khi RA LỆNH ghi).
6. ✅ **Commit `bda54cf` ĐÃ PUSH** (2026-09-16): 18 files +978/−66 (14 file + result31.txt + 2 handoff); secret scan CLEAN; `.env`/`idempotency-store`/rác không stage.

### 🆕 Review code toàn bộ + 3 lỗi thật UI/an toàn (result40 → result42)

- **Review ~7.5k dòng** (Dart client · Node skill layer/router · Python bridge), tìm bằng probe chạy thật:
  - **F1 (crash)** `proposal_card._confirm()` cập nhật UI sau `await` ở 4 nhánh không kiểm `mounted`
    ⇒ `setState() called after dispose()` khi rời màn hình/xoá lịch sử lúc lệnh ghi đang bay → **ĐÃ SỬA** (4 guard).
  - **F3 (fail-OPEN ở đường an toàn)** `problems[]` không phải list ⇒ ném TypeError ⇒ banner KHÔNG hiện và
    **nút [Xác nhận] vẫn còn trên đề xuất đã bị từ chối**; cùng cast ở model còn xoá sạch lịch sử chat → **ĐÃ SỬA** (parse tolerant).
  - Cả 2 đã **falsify** (gỡ fix → test đỏ, khôi phục → xanh) + 4 test hồi quy (**Flutter 34 → 38**).
  - **F2 (UI nói ngược sự thật)** `ListView.builder` dispose card ngoài viewport ⇒ thẻ ĐÃ GHI bị dựng lại sạch,
    nút [Xác nhận] quay lại (probe P2: `success=1/button=0` → `success=0/button=1`) — user chọn **(b)
    `AutomaticKeepAliveClientMixin`** ⇒ **ĐÃ SỬA** (`wantKeepAlive` theo state cục bộ, không ghim mọi card).
  - **✅ CẢ 3 FIX ĐÃ COMMIT `4546997` (đã push cùng đợt `c401b0f`)** (`result41.txt` + `result42.txt`): 4 file Dart, 272+/8−;
    Flutter **39/39** (+5 test hồi quy F1×2 · F3 · F2).
- **Hạn chế của option (b)**: kết quả ghi nằm trong RAM ⇒ mất khi tắt app (option (a) mới persist — phải đổi schema).
  An toàn tiền KHÔNG phụ thuộc hiển thị: `command_id` được ghim trong history (`ChatTurn` round-trip test) nên lần bấm
  sau restart vẫn là **replay phía server**, không ghi phiếu thứ hai.
- **Saga/REVERSAL (phase-09 §7)**: ⏸️ **chờ duyệt** — KHÔNG code.

### Hạ tầng dev + 2 tính năng client (result43, 2026-09-17) ✅ ĐÃ COMMIT `c401b0f` + `f28869a` (đã push, APK CI XANH)

- **A) Xác minh hạ tầng sau khi tunnel đổi URL** (chỉ config, không code): `.env` đã đúng
  ngrok mới — verify bằng đọc thật `erpnext_customer_list` (3 khách) · `mac-custom` config
  khớp, tunnel sống (502→200) · `erpn8788.loca.lt` = tunnel Gateway (port 8788).
  ⚠️ tunnel erpn8788 hiện TẮT (tình trạng môi trường, không phải lỗi config).
- **B) Giới hạn lịch sử chat** `maxChatItems` (mặc định **20**, sàn 5, sửa được): cắt turn
  CŨ NHẤT khi vượt cap, **TRỪ turn có proposal đang treo** — luật nằm ở
  `ChatHistoryService.trimTurns` (pure) áp cho cả state lẫn storage; **falsify bắt buộc đạt**.
- **C) Màn hình Settings** (route `/settings` + icon ⚙️): đổi Gateway URL / auth user /
  auth password / max chat items — `CopilotApiClient` đọc settings MỖI request nên **áp dụng
  ngay, không cần build lại APK**; settings rỗng ⇒ vẫn dùng `--dart-define` (APK cũ không đổi).
- 🔎 **Review vòng sau tìm 3 vấn đề thật**: `attachRejection` từng cắt luôn card VỪA bị từ chối
  (banner lý do biến mất — test chứng minh `6→5` trước khi sửa) → đã bỏ trim ở đường đó;
  doc comment provider bị dán lệch (analyzer không báo) → đã sửa; **hở test ở đường nối mới**
  (route `/settings` + ⚙️ không test nào chạm vì harness cũ đi vòng qua nó) → đã thêm
  `test/settings_navigation_test.dart` chạy qua `appRouter` THẬT.
- **Suite: Python 60 · Node 120 · Router 19 · Flutter 62 (39→62) · analyze 0**.
- **✅ ĐÃ COMMIT `c401b0f` + PUSH + BUILD APK XANH** (user duyệt 2026-09-17): GH Actions run
  `35173021349` SUCCESS 5m0s → artifact `erpn-chat-debug-apk` (~80 MB, hạn 2026-12-16).
  ⚠️ Repo chưa set GitHub Variables ⇒ APK endpoint/auth rỗng → **dùng màn Settings trong app**
  để nhập `https://erpn8788.loca.lt` + auth (không cần build lại).
- **Hạn chế đã ghi rõ**: `/execute` đọc `dioProvider` trực tiếp nên chỉ theo URL mới SAU khi có
  ≥1 lần `/ask` (fail-CLOSED, không ghi sai); card đã ghi vẫn "pending" trong model nên không
  bao giờ bị cắt (an toàn > gọn); password lưu SharedPreferences thường (app-private, CHƯA mã hoá).

### Bước kỹ thuật tiếp theo (KHÔNG Phase 4/8/11)

- **MVP kỹ thuật Phase 7 + Phase 9 an toàn: ĐÃ XONG + ĐÃ COMMIT** (bda54cf + 31d485c).
  Mọi nhánh của luồng "hỏi nợ → thu tiền → xác nhận → ghi nháp → banner từ chối nếu lệch/hết hạn"
  đều có code + test; không còn khoảng trống kỹ thuật nào trong scope hiện tại.
- **✅ Đợt UI STALE + F4 (result32–34) ĐÃ COMMIT `31d485c` + PUSH** (user duyệt
  2026-09-16): 15 files +1006/−22 — 4 Dart + 4 docs + result32/33/34 + 3 handoff +
  runbook demo. Suite sau commit: **Python 60/60 · Node 119/119 · Flutter 34/34 ·
  analyze 0**.
- **KHÔNG mở Phase 4 (STT — chặn audio) / 8 (jobs/TTS) / 11 (write skills mới)**.
- Việc tiếp theo: người thật (APK thiết bị thật · SUBMIT phiếu thu · thu audio 150 câu ·
  dán GitHub Settings · rotate key) — hoặc **saga code khi user duyệt §7** (phase-09,
  REVERSING/REVERSED, 5 test mock). Runbook demo 1 trang: `docs/demo-payment-draft.md`.

### Đã xong trong phiên docs-sync (2026-09-16)

- openspec tasks.md: 5.9 → [x] (`6054458`) + mục §6 Phase 6–9 pointer — validate OK.
- **`LESSONS_LEARNED.md` (mới)**: chỉ mục 6 nhóm lỗi lặp + top bài học, nguồn đầy đủ = skill `erpn-verify-first`.
- handoff_20260916-0725.md · result30.txt.

### Đang chạy (không cần quyết thêm)

1. ~~GH Actions run #2~~ ✅ **XONG — run #2 + #3 đều SUCCESS** (`result10.txt`, `result11.txt`):
   run #3 (`c3d74c3`) build APK với dart-define `COPILOT_BASE_URL`/auth từ repo
   Variables/Secret. **Còn lại là việc user:** ① dán 3 giá trị GitHub Settings (token
   chỉ-đọc) ② cài APK thiết bị thật — endpoint lâu dài user chốt 2026-09-16 HOÃN
   (Cloud Shell = dev, Mac/ngrok/tunnel = demo tạm; VPS thật SAU khi app xong),
   dùng nguyên trạng tunnel khi dev ③ cài APK thiết bị thật
2. **Mandatory Sign-off Phase 5** — ✅ ĐÃ KÝ 2026-09-15 (bảng 4/4 điền theo quyết định:
   KHÔNG scrub, KHÔNG 2-tier; free tier chấp nhận — `SIGNOFF-phase5-pii.md`). LLM Router
   bản đơn giản đã code (`scripts/llm-router.mjs` + config JSON + audit JSONL, 7/7 test,
   E2E smoke qua mock-llm — result14)
3. **LLM Router nối upstream thật** — ✅ result15 (2026-09-15): endpoint chính thức điền xong
   (zen `opencode.ai/zen/v1` · gemini `…/v1beta/openai`); 2 bug router tự bắt khi chạy thật
   (https transport + field `store` Gemini từ chối → `stripFields` per-upstream) +
   `LLM_ROUTER_DEBUG=1`; **Gemini verify generate thật 200** qua router · **Zen bị chặn
   billing** (CreditsError: No payment method — glm-5.3-flash PAID, big-pickle chỉ chạy
   trong OpenCode client); cơ chế dsh thật = **cordis patch row override** (công thức
   settings.yaml của result6 lỗi thời) → skill mới `erpn-dsh-setup`; **E2E dsh→router→Gemini
   flaky do free tier 20 req/phút** (1 session dsh tốn 2–3 calls — 429 quota + 503 high
   demand, nguyên văn trong result15 §6). Còn lại Phase 5: user quyết định upstream
   (Zen nạp payment / bỏ; Gemini free hay paid)

### Theo phase

| Phase | Nội dung | Write? | Điều kiện tiên quyết |
|---|---|---|---|
| 4 | Voice input/STT (hybrid): 🎤 → STT → user xem lại/sửa text → Gửi | Không | ⚠️ **Chặn bởi audio thật 3 miền** (100–200 câu, chờ người thật thu) |
| 5 | AI Gateway core: auth, LLM Router, audit (scrub ĐÃ BỎ theo sign-off 2026-09-15) | **ĐANG LÀM** — upstream hàng ngày = **mac-custom** (LLM tự host trên Mac qua `llm9000.loca.lt`, KHÔNG quota — result20); gemini-openai giữ lại CHỈ để verify tương thích provider thật (thought_signature, `E2E_LLM_MODEL=real-gemini`); zen billing-blocked để sau. E2E mac-custom có bằng chứng hợp lệ = **result22** (4×200, `attempts=['mac-custom']`; claim audit của result20 đã bị đính chính — xem result22 §9B); bug credit-note **đã fix + commit `6054458` + verify thật 457.875đ/171.800đ** (result21); E2E đầy đủ qua `mac-custom` **đã XANH** (result22) | Còn lại: verify thought_signature live khi thuận tiện (chờ quota reset) |
| 6 | Entity resolution + Action Proposal card (xác nhận tiếng Việt + Risk Level) | Không | Exit criteria Phase 5 |
| 7 | **`create_payment_entry` + idempotency** | **Có** | **Giai đoạn A XONG + ĐÃ COMMIT `8ebfc0e` (result23) · Stage B + review + fix history + chaos ĐÃ COMMIT `eea0411` (result25-27)**: proposal HIGH dừng ở xác nhận + idempotency store + `/execute` MOCK + nút Flutter. ✅ Fix `command_id` ổn định theo proposal — đã xong + test (`result24.txt`). ✅ **Giai đoạn B ĐÃ CHẠY (user duyệt, ERPNext demo, quy trình như production — `result25.txt`)**: ghi thật `ACC-PAY-2026-00114` 10.000đ + verify độc lập + replay; phát hiện & fix BUG THẬT crash-recovery ghi phiếu thứ hai. ✅ **Review sau Stage B (`result26.txt`) — 5 lỗi thật đã sửa + falsify**: lỗi post-write bị đánh FAILED (đẩy sang command_id mới = ghi phiếu 2) · `amount_vnd: 0`/NaN bị thăng cấp thành thu TOÀN BỘ nợ · chọn đại mode ⇒ sai tài khoản · `<= 0` để lọt NaN · docs/bảng skill. Node 86 → **91/91** · Python 58/58 · Flutter 25/25 · analyze 0. ✅ **Vá lỗ hổng khoá idempotency khi KHÔI PHỤC HISTORY + 2 chaos test (`result27.txt`)**: `toJson/fromJson` nay ghim `command_id` ⇒ khoá sống theo card qua cả app restart (trước đó restore = UUID mới = ghi phiếu thứ hai); chaos test “**ERPNext ghi xong rồi mất response**” → retry reconcile về đúng document đó (đếm ledger thật = 1) + test “ERPNext chết lúc đối soát → 503, không ghi”. Node **93/93** · Python 58/58 · Flutter **27/27** · analyze 0. ✅ **`faq.md` + 2 bug thật đã vá (`result28.txt`)**: tên khách trùng từ-chỉ-số từng làm sai số tiền (`bác Hai 500 ngàn` → 2.500.000đ; `chị Bảy 300 ngàn` → 7.300.000đ) · danh xưng "chị" từng khớp sai khách (site có khách tên `Chị Tư — thầu nhỏ`) — cả hai đã fix + test + falsify. ⚠️ Khoảng trống đã phát hiện: `buildPaymentProposal()` chỉ được test gọi ⇒ nút [Xác nhận] không bao giờ hiện — **ĐÃ NỐI trong result31** (nhóm `payment_write` + anchor `startsWith`; E2E + widget test JSON verbatim). Node 97/97 · Python 60/60 · Flutter 27/27 tại thời điểm đó. ✅ **Skeleton Phase 9** (plan-only, `.plan/phases/phase-09-…md`) — đã grep xác nhận proposal chưa có `created_at`/snapshot và store chưa có TTL; expiry/stale/khoá `(customer, invoice)`/“không xoá document” là việc mới. ⏳ Chờ user: quyết SUBMIT phiếu (nháp nên công nợ chưa đổi) · 2 phiếu nháp demo ĐÃ XOÁ trong result31 (`erpnext_doc_delete`, verify hóa đơn gốc không đổi) · commit `eea0411` ĐÃ PUSH |
| 8 | Background jobs + push notification + TTS readback | Có | Phase 7 + Phase 9 |
| 9 | Proposal state machine (expiry, re-validation, saga/compensation) | Có (đổi hành vi) | **PHẦN AN TOÀN XONG + ĐÃ COMMIT `eea0411`**: ① TTL 10 phút (`proposal-freshness.mjs` `assertFresh`) → 409 `PROPOSAL_EXPIRED` trước `store.begin()` ② re-validate `detectDrift()` so snapshot với dữ liệu sống → 409 `PROPOSAL_STALE` + problems, KHÔNG ghi ③ intentKey `(customer\|invoice)` chặn ý định trùng đang PENDING (đính chính result29 §10-F1) ④ `created_at` ghim vào proposal + Dart (sống qua khôi phục history) ⑤ 409 intent-in-flight trả `clash_command_id` ⑥ **route `/execute/cancel` ĐÃ CÓ (result31)** — đường thoát zombie PENDING. **Còn thiếu (nâng cao)**: saga/undo-compensation; Flutter hiển thị lý do `PROPOSAL_STALE` chi tiết trên card |
| 10 | Multi-user, RBAC, on-behalf-of ERPNext credential | Có | **Trigger #1 tách khỏi dsh** |
| 11 | Mở rộng write skills (sales order, inventory, purchase) | Có | Phase 10 |
| 12 | Multi-tenant readiness | Có | Chỉ nếu có ý định SaaS |
| 13 | Production hardening + beta pilot (chaos test, success rate) | Có | |
| — | **Phase 15 — Monetization (pro qua ads, reset mỗi ngày) thực thi Ở GIỮA 13 và 14** | — | 4 câu chờ user: ad provider · múi giờ "hết ngày" · danh sách pro · IAP bỏ ad |
| 14 | Store submission + PII/NĐ13 sign-off thủ công | — | Phase 9 + PII scrubbing phải pass audit THỦ CÔNG |

### Chờ người thật (không phải việc agent)

- **Rotate key ERPNext** — Hoàng làm trực tiếp trên server (trạng thái: key cũ vẫn hợp lệ,
  result9 §1). Sau khi rotate: update `.env` qua SSH + probe lại + xóa giá trị cũ khỏi mọi file
- **Thu audio thật 3 miền** — mở khóa Phase 4
- **Cài APK + test tại điểm bán** — cần người thật
- **LLM upstream thật** — 2 quyết định user (result15): Zen nạp payment method hay bỏ upstream;
- **Fix bug credit-note — ĐÃ ÁP DỤNG + COMMIT `6054458` (result21)**: `outstanding_amount > 0` →
  `!== 0` trong `mcp-erpnext/src/skills/customer.mjs` (helper dùng chung cho cả `getCustomerBalance`
  và sales) + `sales.mjs`; mock thêm credit note SINV-0004 để có test hồi quy; nhãn "hóa đơn chưa trả"
  → "**chứng từ** chưa thanh toán" + nhánh "hiện dư X" khi outstanding âm. Verify THẬT bằng probe
  gọi thẳng `answerQuestion` với ERPNext thật (không LLM): **457.875đ/1 ✓** và **171.800đ/4 ✓**
- **Giữ `lt` sống trên máy Mac khi cần E2E** — tunnel `llm9000.loca.lt` chỉ hoạt động khi `lt`
  đang chạy; E2E đầy đủ qua mac-custom **đã XANH** (4/4 request 200 · `messages` 2→5→7→9 ⇒ có turn replay — result22 §4),
  nhưng phải bật lại `lt` mỗi lần chạy và dựng lại dsh nếu `/tmp` đã bị dọn;
  Gemini giữ free tier (không nâng paid). Mock giữ làm contract test; dsh trỏ router qua cordis patch
  (skill `erpn-dsh-setup`)

### Việc còn lại của Phase 5 (gateway)

- **Verify `thought_signature` LIVE** — chạy theo `docs/phase5-thought-signature-runbook.md`
  (1 session duy nhất sau mốc reset 07:00 UTC; không probe trước). Đã thất bại 4 lần liên
  tiếp vì quota, không phải logic; bằng chứng hiện có là hermetic (router 19/19).
  ⚠️ `GEMINI_API_KEY` dùng chung ⇒ "ngay sau reset" không đảm bảo có quota.

### Nợ kỹ thuật Phase 1 (khi có dữ liệu quyết định)

- `bạc` = mệnh giá nào (`ch-003`) · viết tắt `m` = triệu? (`ch-004`) · cờ `approximate`
  ("khoảng/hơn 10 triệu") · số âm/hoàn tiền · tiếng lóng miền Trung · phân biệt câu hỏi/lệnh (Phase 6)
- Số trần cuối câu (`"2 triệu 500"`) và 4 số dạng năm (`"trả 2000"`) — **từ chối có chủ đích**
  (fail-safe); viết `2000 đ` hoặc `hai nghìn`

---

## Gate quan trọng nhất (không được bỏ qua)

- **Trước Phase 7** (write đầu tiên chạm tiền): Phase 1–6 đạt exit criteria đầy đủ — điểm mà nếu
  bỏ qua, mất niềm tin người dùng vĩnh viễn, không phase sau nào cứu được.
- **Trước Phase 14** (publish): Phase 9 + PII scrubbing Phase 5 phải **pass audit thủ công**,
  không chỉ unit test — nghĩa vụ pháp lý (Nghị định 13/2023).

## Nguyên tắc xuyên suốt (áp dụng MỌI phase)

1. **Read trước Write** — phase write chỉ bắt đầu khi phase read-only tương ứng đạt ≥90% success
   rate **đo thật trên server thật** (chuẩn tham chiếu: result9 đo 18/18 bằng batch script).
2. **Không tin external reference chưa verify** — tự `npm view` / mở link / curl thật trước khi code.
3. **Tái dùng trước khi xây mới** — check OmniRoute/9Router + TAXPRO trước mỗi phase liên quan runtime/router/NLP.
4. **An toàn > tốc độ** — có thể cắt scope nghiệp vụ, KHÔNG cắt Compliance (PII/NĐ13),
   Idempotency, Proposal Confirmation.
5. **Exit criteria đo được** — không chuyển phase bằng cảm tính; unit xanh ≠ chạy thật.

## Notes

- **Tool đang hỏng trong env:** AgentMemory (down) · MCP cocoindex/codebase-memory (không expose) ·
  OCR (không chạy được) · Simplenote (không có) → Code Review thủ công, không tự cài.
- **Vùng tiền/số/phân quyền: AI KHÔNG tự ký duyệt/không tự commit** — chờ user review.
- **Cầu nối Python ↔ Flutter/dsh = HTTP service nội bộ (localhost)** (chốt 2026-09-13) —
  1 nguồn logic duy nhất, không port sang Dart.
- Mỗi phase lớn: cập nhật `resultNN.txt` + `checklist.md` + `features.md` + `next.md` + `handoff_<ts>.md`.
- `.plan/` bị gitignore → file kết quả phase KHÔNG commit; `result*.txt` / docs root thì có.
