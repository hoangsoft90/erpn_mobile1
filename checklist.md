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
- [x] GH Actions run #2 ✅ **SUCCESS** (`result10.txt`): [run 34826575147](https://github.com/hoangsoft90/erpn_mobile1/actions/runs/34826575147) — build_runner/Analyze/Test/Build APK đều xanh; artifact `erpn-chat-debug-apk` (80MB zip) đã tải về VPS `/home/kythuat_hoangweb/erpn-apk/app-debug.apk`. ⚠️ APK mặc định trỏ `127.0.0.1:8788` → cần `--dart-define` trỏ IP VPS khi test thật
- [ ] **Tài liệu Mandatory Sign-off Phase 5 (PII/Nghị định 13/2023)** — ✅ ĐÃ SOẠN: `SIGNOFF-phase5-pii.md` (root) — 4 phương án scrubbing khảo sát, bảng quyết định 0/4, **gate ĐÓNG**. 🛑 KHÔNG code LLM Router/PII scrubbing cho tới khi user KÝ file này (gate pháp lý cố ý, không phải gate kỹ thuật)

### Bị chặn — chờ người thật (không phải việc agent)
- [ ] **Rotate key ERPNext** — user (Hoàng) làm trực tiếp trên server; trạng thái 2026-09-14:
      key cũ vẫn hợp lệ (HTTP 200), rotation chưa hiệu lực (`result9.txt` §1)
- [ ] **Thu 100–200 câu audio thật 3 miền** — điều kiện còn thiếu của Phase 1, chặn Phase 4 (STT)
- [ ] **Cài APK lên thiết bị thật tại điểm bán + test** — cần người thật. APK đã ở VPS
      (`/home/kythuat_hoangweb/erpn-apk/app-debug.apk`); lưu ý build APK cần trỏ đúng server
      (mặc định `127.0.0.1:8788` chỉ dùng khi app chạy cùng máy service) + service bind `0.0.0.0`
- [ ] **LLM gateway thật (OpenAI-compatible)** — chờ user cấp; chỉ sửa `/tmp/dsh-home/settings.yaml`

### Các phase kế tiếp (chi tiết ở `next.md`)
- Phase 4 (STT) — chặn bởi audio · Phase 5 (Gateway) — chặn bởi Sign-off ký duyệt ·
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
- **Gate pháp lý Phase 5 là gate ký duyệt của user**, không tự chuyển sang code.
- Tool đang hỏng trong env này: AgentMemory (down) · MCP cocoindex/codebase-memory (không
  expose) · OCR (không chạy được) · Simplenote (không có) → Code Review thủ công, không tự cài.
