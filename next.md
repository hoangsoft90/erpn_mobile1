# next.md — Roadmap ERPNext Vietnamese Voice Copilot (erpn_mobile1)

Đường đi tính năng đã hoàn thành và sắp tới. Cập nhật sau mỗi phase lớn.
Chi tiết từng phase: `.plan/phases/phase-0N-*.md`. Bằng chứng: `resultNN.txt`.

**Định vị sản phẩm:** không phải "chatbot ERPNext", mà là **lớp AI UI trên ERPNext** —
`understand → plan → act → verify → report`. Chat/voice chỉ là phương thức nhập liệu.

---

## Đã hoàn thành

### Phase 0 — Foundation & Verification ✅ (`result1.txt`, `phase-00-result.md`)

Không viết code. Mục đích: chặn fabrication trước khi giao cho agent code (bài học từ `plan1_review1.md`).

- Verify toàn bộ external dependency bằng npm registry + GitHub API + docs chính thức
- **Pin `@casys/mcp-erpnext@3.0.4` + transport `stdio`** — né breaking change HTTP của 3.0.0 (stateless, đòi `MCP-Protocol-Version: 2026-07-28`, client TS SDK v1 bị reject)
- **Agent Runtime = dsh** (`deepseek-ai/deepseek-harness`), MCP client **built-in** (`@deepseek-ai/dsh-mcp-client`). Ghi nhận rủi ro: 20/20 version là `rc`/`alpha`, chưa có bản stable
- Chốt **2 trigger tách lớp khỏi dsh**: (1) ≥2 user cần credential khác nhau chạy đồng thời → Phase 10; (2) dsh breaking change làm hỏng production
- Thứ tự STT: Web Speech API → Cohere Transcribe → Whisper API → PhoWhisper CPU
- **Phát hiện ngược với review6:** 5 repo "DSH mobile" mà review6 gọi là bịa thì **đều tồn tại thật** (0–204 ★). Vẫn loại bỏ, nhưng vì lý do thẩm định an toàn, không phải "không tồn tại"
- Chốt **Xây mới** Vietnamese NLP + LLM Router (không có OmniRoute/9Router/TAXPRO trên máy)
- Thêm gate cứng **Mandatory Sign-off PII** vào `phase-05` (Nghị định 13/2023)

### Phase 1 — Vietnamese NLP Pipeline ✅ (`result1.txt`, `phase-01-result.md`)

Python, `src/vietnamese_nlp/`, **zero runtime dependency**.

- **Number normalizer → integer VND**: 14/14 dạng bắt buộc + mở rộng (`1tr5`, `1k5`, `230.000`, `1 500 000`, `0.5 triệu`, `2 triệu rưỡi`, `1 tỷ 200 triệu`, hậu tố tiền tệ…)
- **Fail-safe là điểm cốt lõi**: `"Bác Hai"`, `"hai trăm"`, `"2 triệu 500"` → **không** sinh số thay vì đoán sai
- **Kinship stripper**: 21 title; birth-order nickname (`Bác Hai`, `Cô Ba`, `Thím Mười`) là TÊN, nhưng `mươi` thì không (không làm hỏng `"ba mươi nghìn"`)
- **Synonym mapper**: 10 nhóm intent (payment, credit_sale, receivable, purchase, delivery, sale, stock_level, unit_price, advance_payment, offset); **sản phẩm không bị map** (`cám heo` giữ nguyên)
- **Quantity extractor**: `20 bao`, `25 ký`/`kg`, `tấn`, `tạ`, `yến`, `thùng`, `gói`…
- **CLI độc lập**: `python -m vietnamese_nlp --pretty "..."` → JSON
- **Test: 49/49 PASS** · **Money accuracy 234/234 = 100%** (lúc đầu; sau 2 đợt fix: **58/58 PASS · 259/259 = 100%** — 37 negative, corpus 259 case)
- **Fix 3 bug thật cho ra số tiền sai im lặng** (gộp nhầm amount cụm sau; `"không triệu"` → 1.000.000; guard bỏ sót số viết bằng chữ)
- **Challenge set 11 case** phơi rõ dạng chưa hỗ trợ (`2m5`, không dấu, `1 triệu 5`, `bạc`, hậu tố dính liền) — không trộn vào điểm số
- **Đợt fix sau (2026-09-13, xem `result2.txt`):** fix 4 false positive + thêm tiếng lóng `trẹo`/`chai` = triệu → **55/55 test PASS · money 247/247 = 100% · 33 negative case**

### Phase 2 (read-only) + Cầu nối dsh + ERPNext thật ✅ (`result4.txt`, `result5.txt`, `result6.txt`)

Chưa nối ERPNext thật (cần credential) — mọi thứ khác đã chạy được end-to-end.

- **Skill layer** (`mcp-erpnext/`): pin `@casys/mcp-erpnext@3.0.4` (lockfile verified) · readonly-guard chặn write ở tầng code, 12 tool đọc THẬT `erpnext_*` (skeleton đầu sai tên generic — sửa sau khi đọc source package) · mock server đúng shape 3.0.4 · JSON-RPC correlation hoàn chỉnh
- **Cầu nối Python** (`nlp_service/server.py`): `normalize()` qua HTTP localhost (stdlib, bind 127.0.0.1, /health + /normalize) — đúng quyết định cầu nối đã khóa
- **Copilot MCP server** (`copilot-server.mjs`): 1 tool `copilot_ask` cho dsh đăng ký — text → HTTP normalize → routeIntent → skill → mock → câu trả lời tiếng Việt xác định (không LLM bên trong). Mỗi nhóm skill 1 nhánh trả lời; fail-safe: không route/không tìm thấy khách → `answer: null` + reason, không bao giờ bịa ID
- **File đăng ký dsh** (`dsh.cordis.patch.yml`): cấu trúc byte-chính-xác từ example chính thức (curl + cat -A), validate YAML OK + biểu thức `!!js` resolve đúng file; **chưa exercised với dsh sống** (dsh chưa cài trên máy — `which dsh` trống; không có key/runtime LLM nào)
- **Test: 25/25 node --test PASS** (gồm 6 E2E spawn thật Python service + copilot + mock) · Python 58/58 PASS không regression · 7 transcript nguyên văn trong `result5.txt` — câu user yêu cầu: "chị Lan còn nợ bao nhiêu" → "Nguyễn Thị Lan còn nợ 2.500.000đ (1 hóa đơn chưa trả)."
- **2 lỗi tự bắt bằng test E2E** (không phải bằng đọc code): route payment/sales rơi nhánh balance (sai shape) → tách nhánh; factory `sales`/`payment` thiếu `findCustomer` → sửa ở router (chia sẻ code customer skill, không nhân bản)

---

## Sắp tới

### Ngay tiếp theo (thứ tự khuyến nghị)

1. ~~Commit Phase 1~~ ✅ **33f9dc0** (root commit, 55 files, 2026-09-14 — user duyệt).
2. ~~ERPNext thật~~ ✅ **ĐÃ NỐI 2026-09-14** (`result6.txt`): `.env` (git-ignored) + env-switch `pickServerScript` (đủ 3 var → real, thiếu → mock, sai → hard error); probe thật 125 tools; smoke dsh→copilot→REAL ERPNext trả đúng 269.000đ.
3. ~~Cài dsh + LLM backend~~ ✅ **dsh 0.1.5-rc.1 headless chạy thật** với mock LLM OpenAI-compatible (`scripts/mock-llm.mjs`); swap sang gateway thật = chỉ sửa settings.yaml (baseURL + apiKeyEnv), không đụng code.
4. **Rotate ERPNext key/secret** (đã đi qua chat) + **swap mock LLM → gateway thật** khi user cấp.
5. **Thu 100–200 câu audio thật 3 miền** — điều kiện còn thiếu của Phase 1, **bắt buộc trước Phase 4**
6. **Định nghĩa Flutter client track chi tiết** — phase-03 đã Flutter hoá nhưng track đầy đủ vẫn là khoảng trống lớn nhất; chặn `phase-04` (STT) và `phase-15` (ads). ✅ BƯỚC ĐẦU TIÊN ĐÃ CÓ 2026-09-14: Flutter chat MVP kỹ thuật xong (`result7.txt`, apps/mobile, Riverpod+GoRouter, GH Actions build APK) — chờ UI-checkpoint + commit + APK thật trên máy.

### Theo phase (`production_roadmap.md`)

| Phase | Nội dung | Write? | Ghi chú |
|---|---|---|---|
| 3 | MVP **Flutter** text chat (read-only) — file phase đã sửa từ PWA | Không | Giữ tên file `phase-03-mvp-pwa-text-chat.md` để tham chiếu cũ không gãy; nội dung đã là Flutter. Flutter UI gọi thẳng `nlp_service` + copilot HTTP (cầu nối đã có sẵn từ result5) |
| **15** | Monetization: pro qua xem ads, reset mỗi ngày | — | **Thứ tự thực thi: giữa 13 và 14** (đánh số 15 để không đổi số 13/14). Có phase rồi nhưng còn 4 câu cần quyết |
| 4 | Voice input/STT (hybrid) | Không | ⚠️ **Chặn bởi corpus audio thật** |
| 5 | AI Gateway core: auth, PII scrub, LLM Router, audit | Không | 🛑 **Mandatory Sign-off phải xong TRƯỚC khi code router** |
| 6 | Entity resolution + Action Proposal card | Không | Exit criteria có mục sign-off của Phase 5 |
| 7 | `create_payment_entry` + idempotency | **Có** | ⚠️ **Go/No-Go gate — write đầu tiên chạm tiền** |
| 8 | Background jobs, push notification, TTS readback | Có | "Ra lệnh rồi đi chỗ khác" |
| 9 | Proposal state machine (expiry, re-validation, saga) | Có | Undo ≠ delete document |
| 10 | Multi-user, RBAC, on-behalf-of credential | Có | **Trigger #1 để tách khỏi dsh** |
| 11 | Mở rộng write skills (sales, inventory, purchase) | Có | |
| 12 | Multi-tenant readiness | Có | Chỉ nếu có ý định SaaS |
| 13 | Production hardening + beta pilot | Có | Chaos test, đo success rate |
| 14 | Store submission + PII/Nghị định 13 sign-off | — | Audit thủ công, không chỉ unit test |

### Nợ kỹ thuật Phase 1 (làm khi có dữ liệu thật)

- Tiếng lóng miền Nam: ~~`trẹo`~~ / ~~`chai`~~ ✅ đã làm; `bạc` **còn nợ** (không có mệnh giá cố định — chờ user xác nhận); viết tắt `m` **còn nợ** (`m` = mét, đoán là nguy hiểm)
- ~~BUG hậu tố tiền tệ dính liền~~ ✅ **ĐÃ FIX 2026-09-13** (`result3.txt`): `"2000đ"`/`"5000vnd"`/`"500đồng"`/`"2tr5đ"`/`"230.000đ"`/`"1 500 000đ"` parse đúng; đồng thời chặn merge rác `2tr5k`/`2tr50`/`2024năm`/`2024rưỡi` (trước fix `"2tr5k"` = 2.500.000.000 và `"1 500 000đ"` = 1500 im lặng) → **58/58 PASS · 259/259 = 100%**
- Tiếng lóng `bạc` **còn nợ** (chờ user xác nhận mệnh giá); viết tắt `m` **còn nợ**
- Cờ `approximate` / so sánh (`"khoảng 10 triệu"`, `"hơn 10 triệu"`)
- Số âm / hoàn tiền (`"trả lại 500 nghìn"`)
- Tiếng lóng miền Trung (chưa khảo sát)
- Số trần ở cuối câu (`"2 triệu 500"`) — hiện từ chối có chủ đích
- Số trần 4 chữ số dạng năm (`"trả 2000"`) — từ chối có chủ đích; viết `2000 đ` hoặc `hai nghìn`

### Chưa có trong roadmap (cần user quyết)

- **Flutter client track** — `phase-03` đã sửa sang Flutter (2026-09-13), nhưng track chi tiết (navigation, state management, design token, native integration) **vẫn chưa có phase riêng**; `phase-04` (STT) và `phase-15` (ads) phụ thuộc vào nó
- Native integration (đồng bộ native — yêu cầu gốc trong `checklist.md`)
- ~~Monetization~~ → ✅ đã có `phase-15-monetization-ads.md`

---

## Gate quan trọng nhất (không được bỏ qua)

- **Trước Phase 7** (write đầu tiên chạm tiền): Phase 1–6 phải đạt exit criteria đầy đủ. Đây là điểm mà nếu bỏ qua, hậu quả là mất niềm tin người dùng vĩnh viễn — không phase sau nào cứu được.
- **Trước Phase 14** (publish): Phase 9 (race condition/saga) + PII scrubbing (Phase 5) phải **pass audit thủ công**, không chỉ pass unit test — nghĩa vụ pháp lý (Nghị định 13/2023).

## Nguyên tắc xuyên suốt (áp dụng MỌI phase)

1. **Read trước Write** — không phase write nào bắt đầu trước khi phase read-only tương ứng đạt ≥90% success rate đo thực tế.
2. **Không tin external reference chưa verify** — tự `npm view` / mở link / test call trước khi đưa vào code.
3. **Tái dùng trước khi xây mới** — kiểm tra OmniRoute/9Router + TAXPRO trước mỗi phase liên quan runtime/router/NLP.
4. **An toàn > tốc độ** — không cắt Compliance (PII/NĐ13), Idempotency, Proposal Confirmation để rút ngắn. Có thể cắt scope nghiệp vụ (ít skill hơn), **không cắt safety**.
5. **Exit criteria đo được** — không chuyển phase dựa trên cảm tính "chắc ổn rồi".

---

## Notes

- **Tool đang hỏng trong env này:** AgentMemory (down) · MCP `cocoindex-code`/`codebase-memory-mcp` (không expose) · OCR (không khả dụng) · Simplenote MCP (không có trong tool list). Code Review phải làm thủ công.
- **Vùng tiền/số: AI KHÔNG được tự ký duyệt** — mọi thay đổi chạm logic tiền phải user review trước khi commit.
- **Cầu nối Python ↔ Flutter/dsh = HTTP service nội bộ (localhost)** (chốt 2026-09-13) — 1 nguồn logic duy nhất, không port sang Dart. ✅ Phía Python+Node đã xây xong 2026-09-14 (`nlp_service/server.py` + `copilot-server.mjs`, `result5.txt`); chân Flutter nối vào sau (Phase 3).
- **Repo vẫn 0 commit** — user đã duyệt nguyên tắc commit gộp Phase 1 (sau khi fix bug hậu tố — đã fix xong), **chờ user gõ OK lần cuối**.
- **Đừng báo "xong" bằng lời** — mọi claim cần dòng code + output test thật.
- Mỗi phase lớn: cập nhật `resultNN.txt` + `checklist.md` + `features.md` + `next.md` + `handoff_<timestamp>.md`.
- `.plan/` bị gitignore → các file kết quả phase KHÔNG được commit; `result*.txt` / `checklist.md` / `features.md` / `next.md` / `handoff*.md` thì có.
