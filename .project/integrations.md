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

- `dsh 0.1.5-rc.1` headless đã chạy thật; cài ở `/tmp/dsh-run` (scratch —
  mất khi reboot, cài lại = `npm i`)
- Đăng ký copilot: `dsh web --patch mcp-erpnext/dsh.cordis.patch.yml` →
  tool `mcp__erpn_copilot__copilot_ask`
- LLM backend hiện tại: **mock OpenAI-compatible** (`scripts/mock-llm.mjs`);
  swap thật = sửa `/tmp/dsh-home/settings.yaml` (baseURL + apiKeyEnv), không
  đụng code
- `DSH_TELEMETRY_MODE=DISABLED` luôn set (dsh mặc định gửi telemetry ra ngoài)
- 2 trigger tách khỏi dsh (đã chốt): ≥2 user credential khác nhau (Phase 10)
  · dsh breaking change phá production

### GitHub Actions — CI/CD build APK

- Workflow: `.github/workflows/android-debug-apk.yml`
- Trigger: push/PR paths `apps/mobile/**` + `workflow_dispatch`
- Steps: Java 21 (temurin) → Flutter stable (subosito, cache) → pub get →
  `analyze --fatal-infos` → `test` → `build apk --debug` → artifact
  `erpn-chat-debug-apk`
- Quyết định user: **KHÔNG build APK trên VPS** (chỉ analyze/test trên VPS)
- Chưa chạy lần nào — chờ user cấp GitHub repo để push

## Chưa tích hợp (roadmap)

| Thứ | Phase | Ghi chú |
|---|---|---|
| STT | 4 | thứ tự chốt: Web Speech API → Cohere Transcribe (`cohere-transcribe-03-2026`, trial 1.000 call/tháng) → Whisper API → PhoWhisper CPU; **chặn bởi corpus audio thật 3 miền** |
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
