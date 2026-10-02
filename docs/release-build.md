# Release build & signing (Q7) — checklist cho OWNER

> Phase 11, quyết định tồn đọng **Q7** (keystore + `flutter build apk --release`).
> **Trạng thái hiện tại: 🔴 BLOCK ký** — chưa có keystore/secret của owner.
> Agent đã dựng sẵn workflow + config plugin; **không** sinh keystore trong repo,
> **không** tự ký, **không** tự nhận là đã phát hành.

## 1. Vì sao cần owner

Keystore release là **danh tính phát hành** của app: mất key ⇒ không thể cập nhật
app đã cài (phải xin package name mới); lộ key + password ⇒ người khác ký được APK
mạo danh. Đây là vùng **bất khả hoàn tác + tin cậy** ⇒ agent không tự tạo/giữ.

## 2. Việc owner làm (1 lần)

### 2.1 Tạo keystore (trên máy owner, KHÔNG trong repo)

```bash
keytool -genkeypair -v \
  -keystore ~/erpn-release.jks \
  -alias erpn \
  -keyalg RSA -keysize 2048 -validity 10000 \
  -storetype JKS
# → trả lời họ tên/tổ chức; ĐẶT storePassword + keyPassword (≥ 8 ký tự), KHÔNG dùng lại
```

Giữ `~/erpn-release.jks` + 2 mật khẩu ở nơi an toàn (password manager). **Không**
đưa file `.jks`/mật khẩu vào repo, chat, hay ảnh chụp.

### 2.2 Nạp 4 secret vào GitHub repo (`hoangsoft90/erpn_mobile1`)

Settings ▸ Secrets and variables ▸ Actions ▸ **New repository secret**:

| Secret | Giá trị |
|---|---|
| `KEYSTORE_BASE64` | `base64 -w0 ~/erpn-release.jks` (một dòng, không xuống hàng) |
| `KEY_ALIAS` | `erpn` (alias đã đặt ở 2.1) |
| `KEY_PASSWORD` | mật khẩu của alias |
| `STORE_PASSWORD` | mật khẩu của keystore |

(3 biến `COPILOT_BASE_URL` / `COPILOT_AUTH_USER` / `COPILOT_AUTH_PASSWORD` đã có từ Phase 10.)

## 3. Việc agent đã chuẩn bị

- `.github/workflows/android-release-apk.yml` — build **`flutter build apk --release`** trên CI:
  - chạy **chỉ khi owner** đẩy tag `v*` hoặc bấm *Run workflow*;
  - **chặn** nếu thiếu 1 trong 4 secret (không tạo APK nửa vời);
  - giải mã keystore vào đường dẫn **gitignore** trong CI rồi ghi `key.properties`;
  - **từ chối** endpoint rỗng/loopback (Phase 10 F1);
  - **verify APK không debug-signed** (`apksigner --print-certs`, chặn `CN=Android Debug`) — F1;
  - xuất sha256 + artifact `erpn-chat-release-apk`.
- `apps/mobile/android/app/build.gradle.kts` — đọc `key.properties` khi có; ký bằng
  key release; **thiếu** `key.properties` thì fallback debug (dev) — CI luôn có file
  nên không bao giờ ship bản fallback (đã bị chặn ở bước verify).
- `apps/mobile/pubspec.yaml` — `version: 1.0.0+2` (bản release CI đầu tiên).

## 4. Chạy & kiểm

1. Owner nạp 4 secret (2.2).
2. Owner đẩy tag (`git tag v1.0.0 && git push origin v1.0.0`) **hoặc** bấm Run workflow.
3. CI xanh ⇒ tải `erpn-chat-release-apk`; ghi **run id + sha256** vào `.plan/next8/phase11-result.md`.
4. Xác minh cục bộ (tùy chọn):
   ```bash
   apksigner verify --print-certs app-release.apk   # phải KHÔNG có CN=Android Debug
   sha256sum app-release.apk
   ```
5. Cài lên máy thật rồi làm `todo-test.md` (A1–A9).

## 5. Nếu CHƯA có keystore

Workflow **fail sớm** với thông điệp BLOCK — không có APK nào được tạo. Đây là
hành vi đúng: release ký bằng debug key là lỗi nghiêm trọng (F1).

## 6. Rollback

Xem `docs/runbook.md` §rollback + `.plan/next8/phase11-result.md` §rollback:
giữ **APK release tốt gần nhất** (sha256 trong phase11-result) để cài đè; nếu bản
mới lỗi ⇒ cài lại bản cũ; kill switch `mcp-erpnext/control/read-only.flag` để
chặn WRITE khẩn cấp; khôi phục cấu hình gateway theo `docs/runbook.md`.
