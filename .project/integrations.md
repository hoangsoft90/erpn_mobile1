# Tích hợp 3rd Party & Cấu hình Hệ thống

## Đã tích hợp

### ERPNext (qua MCP — lõi sản phẩm)

- Package: `@casys/mcp-erpnext@3.0.4` (**pin cứng** — breaking change 3.0.0
  ở HTTP transport; dùng stdio để né hẳn)
- Access: site thật qua gateway ngrok; auth Frappe `Authorization: token key:secret`
- Contract env: `ERPNEXT_URL` / `ERPNEXT_API_KEY` / `ERPNEXT_API_SECRET` —
  CHỈ nằm trong `.env` (chmod 600, git-ignored, `git check-ignore` verify
  trước staging)
- ⚠️ Key/secret đã từng đi qua plain chat → **phải rotate** (nhắc 3 lần)

### DeepSeek Harness (dsh) — Agent Runtime

- `dsh 0.1.5-rc.1` headless đã chạy thật. Runtime **resolve tự động** theo thứ tự
  `DSH_ENTRY` → `DSH_COMMAND` → package local → **`npx --yes @deepseek-ai/dsh@<pin>`**
  (pin đọc từ `package.json` root) → `/tmp/dsh-run` (chỉ khi tồn tại) → unavailable.
  Kiểm bằng `npm run dsh:check`; `/dsh/health` trả `source` (npx-pinned/legacy-tmp/…)
  + `--version` thật. **Không** còn coi `/tmp/dsh-run` là installation mặc định
  (2026-09-19: đường dẫn đó chỉ có trên 1 máy, Mac báo unavailable).
- Đăng ký copilot: `dsh web --patch mcp-erpnext/dsh.cordis.patch.yml` →
  tool `mcp__erpn_copilot__copilot_ask`
- LLM backend hiện tại: **mock OpenAI-compatible** (`scripts/mock-llm.mjs`);
  swap thật = sửa `/tmp/dsh-home/settings.yaml` (baseURL + apiKeyEnv), không
  đụng code
- `DSH_TELEMETRY_MODE=DISABLED` luôn set (dsh mặc định gửi telemetry ra ngoài)
- `DSH_MODE=local|remote`: remote gọi `scripts/dsh-remote-runner.mjs` trên Mac qua tunnel
  (token bắt buộc ≥16 ký tự, so bằng `timingSafeEqual`, fail-closed nếu thiếu token/entry/patch)
  — **không bao giờ** hạ cấp về local; mọi response mang `runtime: local|remote`
- 2 trigger tách khỏi dsh (đã chốt): ≥2 user credential khác nhau (Phase 10)
  · dsh breaking change phá production

### OCR (đọc ảnh chứng từ — Trụ C, 2026-09-20)

- Interface `OcrProvider` (`mcp-erpnext/src/ocr/ocr-provider.mjs`) → `{raw_text, confidences?,
  blocks?, provider, model?, ms?}` + **validate fail-closed** (shape sai ⇒ lỗi, KHÔNG `String()` hoá).
- Providers: **`mock` (mặc định — bắt buộc cho CI, không cần mạng)** · **`router-vision` (MVP
  thật) qua LLM Router**, không thêm vendor cloud mới. Env: `OCR_PROVIDER` · `OCR_ROUTER_URL`
  (fallback `LLM_ROUTER_URL`) · `OCR_VISION_MODEL`.
- Policy trong `capabilities.json → ocr_policy` (min_confidence, max_text_length, max_image_bytes,
  allowed_providers, require_wrap_before_llm, log_raw_image=false, authoritative_identifiers=false).
- Raw text **luôn** bọc `untrusted-data` trước classifier/LLM; `kind` (mua/bán) do **USER** chọn;
  không ghi ERPNext, không `/execute` từ đường OCR.

### GitHub Actions — CI/CD build APK

- Workflow: `.github/workflows/android-debug-apk.yml`
- Trigger: push/PR paths `apps/mobile/**` + `workflow_dispatch` — commit chỉ đổi
  backend/docs **KHÔNG** trigger (đúng thiết kế)
- Steps: Java 21 (temurin) → Flutter stable (subosito, cache) → pub get →
  `analyze --fatal-infos` → `test` → `build apk --debug` → artifact
  `erpn-chat-debug-apk`
- Quyết định user: **KHÔNG build APK trên VPS** (chỉ analyze/test trên VPS)
- ✅ Đã chạy XANH nhiều lần; run gần nhất **`35688782230`** (commit `53e1851`), artifact
  `erpn-chat-debug-apk` ~81 MB; trước đó `35435259669` (run #22, dispatch tay cho head `03338ae`, ~84 MB)
- 🔐 Trước khi push: `.env` phải `chmod 600`; .gitignore chặn `.chats/.review/.gemini/.opencode/initp`
  (4 thư mục này từng suýt lọt: `.chats/sess1.md` chứa token thật, `.review/*.md` = transcript chat);
  quy trình push + tham chiếu token (`GH_TOKEN`/`GH_REPO_URL` trong `.env`) ghi ở skill `erpn-deploy-github`
  (**không** chứa giá trị token)
- ⚠️ Commit chỉ đổi **backend/docs KHÔNG tự trigger** (đúng `paths` filter) ⇒ khi cần APK cho đợt
  chỉ-sửa-backend phải kích tay: `gh workflow run android-debug-apk.yml --ref change/flutter-chat-mvp`
- Muốn **verify nội dung APK** (không chỉ tin dấu xanh): `GH_TOKEN` nằm trong `.env`
  (chỉ tham chiếu TÊN biến, không dán giá trị) → `gh run download <id> -n erpn-chat-debug-apk` →
  grep `assets/flutter_assets/kernel_blob.bin` (**build debug**: Dart ở kernel, KHÔNG phải
  `libapp.so`); label app nằm trong `AndroidManifest.xml` (**string pool UTF-16LE** — `strings`
  thường không thấy; phải tìm trên file ĐÃ GIẢI NÉN, không tìm trên zip nén)

### LLM Router (Phase 5 — gateway nội bộ, không cloud bắt buộc)

- `scripts/llm-router.mjs` :8900 — config-driven fallback chain (`scripts/llm-router.config.json`)
- Upstreams: `mac-custom` (LLM tự host trên Mac qua `llm9000.loca.lt`, KHÔNG quota —
  đầu chain cho dev) · `gemini-openai` (free tier flaky — chỉ cho verify
  thought_signature qua `E2E_LLM_MODEL=real-gemini`) · Zen billing-blocked (để sau)
- Audit JSONL repo-local (KHÔNG /tmp — overlayfs container bị xoá khi restart)
- P3 classifier gọi qua router này; P5 dsh opt-in không đụng /ask
- ⚠️ **Drift model của Mac là chuyện thường**: `oc/big-pickle` từng bị khai tử (403 model-not-found)
  → đổi sang `gemini/gemini-3.6-flash` ở **3 chỗ** (2 router config + patch dsh + default classifier).
  Đổi model ⇒ phải sửa ĐỦ các chỗ, nếu không "một nửa hệ thống" chạy model chết.

### Authorization config (P8)

- `COPILOT_USERS` (JSON, tùy chọn): `{"user":{"permissions":["Accounts User"],"company":"X"}}`
  — đặt ⇒ multi_user; không đặt ⇒ single_tenant (hành vi cũ)
- `COPILOT_COMPANY`: pin company cho single-tenant; multi-user thiếu company ⇒
  `COMPANY_SCOPE_REQUIRED`
- `COPILOT_DEFAULT_PERMISSIONS`: thu hẹp quyền single-tenant (= rỗng ⇒ không có quyền nào)

## Chưa tích hợp (roadmap)

| Thứ | Phase | Ghi chú |
|---|---|---|
| STT cloud | 4 | **đã quyết KHÔNG dùng**: P6 dùng STT của OS (`speech_to_text`) — không corpus, không tự host model. Các phương án cũ (Cohere Transcribe / Whisper API / PhoWhisper CPU) giữ lại làm tài liệu, chỉ xét lại nếu STT OS không đủ tốt trên máy thật |
| LLM Router | 5 | AI Gateway core: auth, PII scrub, audit; **Mandatory Sign-off PII (Nghị định 13/2023) trước khi code** — Gemini free tier dùng data để cải thiện sản phẩm = blocker |
| Push notification | 8 | chưa chọn provider |
| Payment gateway / ads | 15 | monetization "pro xem ads reset mỗi ngày"; 4 câu chưa quyết (provider, timezone, feature list, IAP) |
| Firebase/Supabase | — | **KHÔNG dùng** — backend là ERPNext + Node/Python tự vận hành; nếu tương lai cần push/ads có thể cân nhắc lại, phải hỏi user |

## Cấu hình hệ thống đáng nhớ

- Flutter SDK: `/google/flutter/bin` (không trong PATH mặc định — phải export)
- Android SDK: `$HOME/Android/Sdk` — đã cài cmdline-tools + platform 36 +
  build-tools 36 (dùng cho cấu hình, KHÔNG build APK tại VPS)
- VPS thiếu: clang/cmake/ninja/libgtk-3-dev → không chạy Flutter desktop
- Disk từng ENOSPC tạm thời → build assets hỏng gây shader exception ảo
  trong `flutter test` → `flutter clean && flutter pub get` là hết
