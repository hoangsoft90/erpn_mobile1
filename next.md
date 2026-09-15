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
- 2 project skills (`.agents/skills/`, local-only): `erpnext-mcp-connect` + `erpn-verify-first`
- Tài liệu phiên mới: `.project/` (kiến thức tĩnh) + memory files; `.project/openspec.md`
  là pointer — **1 nguồn sự thật duy nhất**: checklist.md (trạng thái) + next.md (roadmap)
  + result*.txt (bằng chứng)

---

## Sắp tới

### Đang chạy (không cần quyết thêm)

1. ~~GH Actions run #2~~ ✅ **XONG — run #2 + #3 đều SUCCESS** (`result10.txt`, `result11.txt`):
   run #3 (`c3d74c3`) build APK với dart-define `COPILOT_BASE_URL`/auth từ repo
   Variables/Secret. **Còn lại là việc user:** ① dán 3 giá trị GitHub Settings (token
   chỉ-đọc) ② chọn đường endpoint — port 8788 bị firewall hosting chặn từ internet
   (Tailscale khuyến nghị / mở port / ngrok) ③ cài APK thiết bị thật
2. **Mandatory Sign-off Phase 5** — ✅ ĐÃ KÝ 2026-09-15 (bảng 4/4 điền theo quyết định:
   KHÔNG scrub, KHÔNG 2-tier; free tier chấp nhận — `SIGNOFF-phase5-pii.md`). LLM Router
   bản đơn giản đã code (`scripts/llm-router.mjs` + config JSON + audit JSONL, 7/7 test,
   E2E smoke qua mock-llm — result14)

### Theo phase

| Phase | Nội dung | Write? | Điều kiện tiên quyết |
|---|---|---|---|
| 4 | Voice input/STT (hybrid): 🎤 → STT → user xem lại/sửa text → Gửi | Không | ⚠️ **Chặn bởi audio thật 3 miền** (100–200 câu, chờ người thật thu) |
| 5 | AI Gateway core: auth, PII scrub, LLM Router, audit | **ĐANG LÀM** — sign-off ĐÃ KÝ 2026-09-15 (không scrub, không 2-tier → phạm vi còn: router đơn giản + audit); LLM Router proxy đã code + 7/7 test (result14) | Còn: nối dsh → router, verify baseURL/key thật |
| 6 | Entity resolution + Action Proposal card (xác nhận tiếng Việt + Risk Level) | Không | Exit criteria Phase 5 |
| 7 | **`create_payment_entry` + idempotency** | **Có** | ⚠️ **Go/No-Go gate: Phase 1–6 exit criteria ĐỦ** — write đầu tiên chạm tiền |
| 8 | Background jobs + push notification + TTS readback | Có | Phase 7 |
| 9 | Proposal state machine (expiry, re-validation, saga/compensation) | Có | Undo ≠ delete document |
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
- **LLM gateway thật** — chờ user cấp; chỉ sửa settings.yaml, mock giữ làm contract test

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
