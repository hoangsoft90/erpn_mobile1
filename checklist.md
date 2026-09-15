# checklist.md — ERPNext Vietnamese Voice Copilot (erpn_mobile1)

Danh sách kiểm tra nhanh: **đã làm / chưa làm / cần hỏi lại**.
Bằng chứng chi tiết: `result*.txt` (mới nhất = result9) + `.plan/phases/*-result.md`.
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
  `119edd4` (fix result9). Branch `change/flutter-chat-mvp`, remote origin = github.com/hoangsoft90/erpn_mobile1
- 2 project skills (`.agents/skills/`, local-only vì repo gitignore `.agents/`):
  `erpnext-mcp-connect` (kết nối/authorize ERPNext MCP) + `erpn-verify-first` (quy trình
  chống "code xong đi sửa" — 5 phiên bài học)
- Bộ tài liệu phiên mới: `.project/` (kiến thức tĩnh) + memory files root; `.project/openspec.md`
  là pointer (không nhân bản progress với checklist/next)

---

## Chưa làm / đang làm (thứ tự)

### Đang làm
- [x] GH Actions run #2 ✅ **SUCCESS** (`result10.txt`): [run 34826575147](https://github.com/hoangsoft90/erpn_mobile1/actions/runs/34826575147) — build_runner/Analyze/Test/Build APK đều xanh; artifact `erpn-chat-debug-apk` (80MB zip) đã tải về VPS `/home/kythuat_hoangweb/erpn-apk/app-debug.apk`
- [x] **APK nối được VPS — endpoint security** ✅ (`result11.txt`, commit `c3d74c3`): http-ask bind policy (non-loopback BẮT BUỘC basic auth, public cần ASK_ALLOW_PUBLIC=1 — server tự từ chối cấu hình unsafe) + Flutter client gửi auth qua dart-define + CI build APK từ repo Variables/Secret. Verify thật: 401 không auth → 200 có auth → trả lời 269.000đ qua ERPNext thật. ⚠️ **Port 8788 bị cloud firewall hosting chặn từ internet** (read_url timeout) — cần user mở port HOẶC dùng Tailscale (đã cài, chờ login)
- [x] **Mandatory Sign-off Phase 5 ĐÃ KÝ (2026-09-15)**: `SIGNOFF-phase5-pii.md` — 4/4 quyết định đã điền. Hoàng xác nhận qua trao đổi trực tiếp: **KHÔNG PII scrubbing, KHÔNG LLM Router 2-tier** — gửi thẳng tên khách/số tiền cho LLM, free tier được dùng (rủi ro pháp lý chủ dự án tự chấp nhận, đã ghi minh bạch trong sign-off). **Gate MỞ** → phạm vi Phase 5 còn: LLM Router đơn giản + audit log (bỏ mục scrub)
- [x] **Phase 5 khởi động — LLM Router bản đơn giản** ✅ (result14): `scripts/llm-router.mjs` (proxy OpenAI-compatible 127.0.0.1:8900, fallback chain config-driven JSON, cooldown upstream lỗi 429/5xx/timeout) + `scripts/llm-router.config.json` (mock → zen → gemini-openai, 2 upstream thật còn PENDING verify key/baseURL) + audit JSONL `llm-router-audit/` (không chép nội dung câu hỏi). **Test: 7/7 router + 49/49 mcp-erpnext; E2E smoke thật qua mock-llm.** Còn lại Phase 5: nối dsh → router, verify rate limit/baseURL thật khi có key
- [x] **Tunnel localtunnel verify E2E thật (2026-09-14)** ✅: user chạy `lt -s erpn8788 --port 8788` trên **máy Mac** (forward qua SSH tới VPS) → từ VPS test qua tunnel: `/health` 3/3 = 200 · `/ask` HTTP 200 · **"Khách smoke 2026-09-13-p1done còn nợ 269.000đ (3 hóa đơn chưa trả)" khớp ground-truth result9**. Lưu ý: curl phải kèm header `bypass-tunnel-reminder: 1` (không có → 502 Bad Gateway từ tunnel server, dễ nhầm là service chết). Quy trình chuẩn hóa ở `mcp-erpnext/LOCAL-TEST.md` + npm script `start:ask`. ⚠️ URL tunnel public KHÔNG auth (http-ask bind loopback) — chỉ bật khi test, Ctrl-C ngay khi xong. COPILOT_BASE_URL cho APK có thể trỏ tunnel này (HTTPS qua firewall)
- [ ] **Chờ user dán 3 giá trị vào GitHub Settings** (token hiện tại chỉ-đọc, PUT 404): Variables `COPILOT_BASE_URL=https://erpn8788.loca.lt` (tunnel HTTPS đã verify E2E thật — result13; hoặc IP:8788 nếu hosting mở port/Tailscale) + `COPILOT_AUTH_USER=copilot` (user lấy từ `.env` ASK_USER), Secret `COPILOT_AUTH_PASSWORD` (= ASK_PASSWORD trong `.env`) → CI build APK cài được luôn. ⚠️ Tunnel chỉ sống khi `lt` đang chạy trên máy Mac của user — endpoint lâu dài cần Tailscale/hosting mở port
- [x] **Kịch bản thu âm** ✅ `docs/audio-collection-script.md`: 150 câu 3 miền có ground truth (A-G), chỉ tài liệu

### Bị chặn — chờ người thật (không phải việc agent)
- [ ] **Rotate key ERPNext** — user (Hoàng) làm trực tiếp trên server; trạng thái 2026-09-14:
      key cũ vẫn hợp lệ (HTTP 200), rotation chưa hiệu lực (`result9.txt` §1)
- [ ] **Thu 100–200 câu audio thật 3 miền** — điều kiện còn thiếu của Phase 1, chặn Phase 4 (STT)
- [ ] **Cài APK lên thiết bị thật tại điểm bán + test** — cần người thật. Endpoint đã có đường sống: tunnel `erpn8788.loca.lt` verify E2E (result13) — dùng ngay khi `lt` chạy; lâu dài chọn 1 trong 3 (result11 §5): Tailscale login (khuyến nghị) / hosting mở port 8788 / tunnel giữ nguyên. Sau đó user dán 3 giá trị GitHub Settings → CI build APK cài được
- [ ] **LLM gateway thật (OpenAI-compatible)** — chờ user cấp; chỉ sửa `/tmp/dsh-home/settings.yaml`

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
