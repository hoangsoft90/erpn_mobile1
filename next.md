# next.md — Roadmap ERPNext Vietnamese Voice Copilot (erpn_mobile1)

Đường đi tính năng đã hoàn thành và sắp tới. Bằng chứng từng phase: `result*.txt`.
Trạng thái tóm tắt (đã làm/chưa làm/chờ ai): `checklist.md` — hai file này không nhân bản nhau.

**Định vị sản phẩm:** không phải "chatbot ERPNext", mà là **lớp AI UI trên ERPNext** —
`understand → plan → act → verify → report`. Chat/voice chỉ là phương thức nhập liệu.
Client đích đã chốt: **Flutter** (không phải PWA).

---

## Đã hoàn thành

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

### ĐÃ DUYỆT — XONG trong phiên result31 (2026-09-16) · review vòng 2 kèm 2 fix — CHỜ DUYỆT COMMIT

0. ⏳ **Review vòng 2 (result31 §11) — đã vá, chờ duyệt cùng đợt**: **F1** anchor `startsWith` vẫn nuốt câu ĐỌC lịch sử (`'thanh toán gần nhất của chị Lan...'` → `'payment gần nhất...'` → routed payment_write SAI — probe `answerQuestion()` thật) ⇒ fix `notIf` deny-list (bao nhiêu/mấy/gần nhất/mới nhất/?) → câu hỏi rơi về nhóm payment ĐỌC; +1 test round 2, falsify đạt (gỡ gate → FAIL đúng assertion). **F2** `store.cancel()` ngoài try/catch — race với `/execute` đồng thời ⇒ throw uncaught ⇒ **Node ≥15 crash cả process** (bằng chứng cơ chế: async handler throw → exit 1; suite không bắt được vì child-process cách ly) ⇒ bọc try/catch → 409. **F3** reason dùng `rawText`. Suite sau review: **Node 119/119 · Python 60/60 · Flutter 29/29 · analyze 0**.

1. ✅ **Gộp 1 commit `eea0411`** (thay cho tách 3 — user quyết) + push: 37 files, +3794/−124 (Stage B + fix money/identity + Phase 9 safety + docs result24-30).
2. ✅ **Nối `buildPaymentProposal()` vào `routeIntent()`**: nhóm `payment_write` ĐẦU ROUTES, anchor `startsWith` đầu câu (synonym mapper biến "thu tiền" → "payment" đầu câu; nếu so substring sẽ nuốt câu đọc chứa "đã/chưa thanh toán") → "thu tiền cho chị Lan 500 ngàn" qua pipeline thật = proposal `create_payment_entry`/HIGH, amount từ NLP, invoice nợ cũ nhất; thiếu tiền ⇒ đề xuất THU HẾT nợ (vẫn HIGH, không ghi ngầm). Sửa chữ cũ "Phase 2 chỉ đọc" (grep 0 hit). E2E + widget test với JSON server trả về verbatim — nút [Xác nhận] hiện thật trên Flutter. Falsify: gỡ anchor → 15/16 FAIL; phá confirmable → widget FAIL; khôi phục xanh.
3. ✅ **Route `/execute/cancel`** (giải zombie PENDING result29 §10-F2): `store.cancel()` chỉ từ PENDING; COMPLETED ⇒ 409 + result; PENDING ⇒ `reconcilePaymentEntry()` trước — 0 chứng từ mới CANCELLED, thấy chứng từ ⇒ 409 + `erpnext_doc` (kèm test retry /execute cùng id → replay). 503 khi ERPNext chết lúc đối soát. Falsify: disable nhánh chặn → 13/14 FAIL đúng chỗ; khôi phục 14/14.
4. ✅ **Xoá 2 PE demo `ACC-PAY-2026-00114/00115`**: đọc source tìm tool thật (`erpnext_doc_delete` — draft OK, không cần cancel vì docstatus 0); gọi qua JSON-RPC thô MỘT LẦN theo lệnh user (đường xoá KHÔNG được mở vào code sản phẩm); verify độc lập: cả 2 GONE + `ACC-SINV-2026-00047` outstanding 457.875 Unpaid — GIỐNG HẾT trước xoá.
5. ✅ **faq.md** đầu-file + §3.2/§3.3/§9/§8 cập nhật khớp hành vi mới (nút [Xác nhận] chỉ hiện khi RA LỆNH ghi).
6. ⏳ **14 file kèm review-fix CHỜ DUYỆT COMMIT** (vùng tiền) — message đề xuất ở result31 §7.

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
