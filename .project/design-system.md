# Design System & UI Components

Nguồn sự thật: `openspec/config.yaml` (mục context, "Design tokens") +
`lib/app/theme/app_theme.dart`. Widget KHÔNG dùng số magic — mọi giá trị qua
theme/tokens.

## Màu sắc chủ đạo

| Token | Giá trị | Nguồn |
|---|---|---|
| primary | Material 3 seed `Color(0xFF6750A4)` | user chưa cung cấp brand color — dùng baseline M3 |
| surface | theo `ColorScheme.fromSeed` (light) | |
| error | `#B3261E` (M3 baseline) | |
| Bubble user | `colorScheme.primaryContainer` / text `onPrimaryContainer` | |
| Bubble copilot | `surfaceContainerHighest` / `onSurface` | |
| Bubble lỗi | `errorContainer` / `onErrorContainer` | |

Đổi brand color thật = sửa 1 chỗ seed trong `app_theme.dart` + ghi lại vào
`openspec/config.yaml`.

## Spacing (AppSpacing — static const)

| Token | dp |
|---|---|
| xs | 4 |
| sm | 8 |
| md | 16 |
| lg | 24 |
| xl | 32 |

Dùng: `AppSpacing.md`… — không viết `EdgeInsets.all(13)`.

## Radius / Elevation

| Token | Giá trị | Dùng ở |
|---|---|---|
| radius.sm/md/lg | 8 / 12 / 16 | bubble + input + card đều dùng `radius.md` (12) |
| elevation.card | 1 | CardTheme |
| elevation.dialog | 3 | dialog xác nhận xóa lịch sử |

## Typography

- **Material 3 default (Roboto)** — user chưa chỉ định font khác
- Text theme qua `Theme.of(context).textTheme` (bodyMedium, labelSmall…)
- Footer URL: `labelSmall`; route label trong bubble: fontSize 11 (alpha 0.7)

## Shared Widgets / Common Components

| Widget | Đường dẫn | Tái sử dụng |
|---|---|---|
| `ChatBubble` | `features/chat/presentation/widgets/chat_bubble.dart` | widget đặc thù chat — render 1 turn thành cặp bubble; chưa có widget chung nào khác |

**Chưa có thư viện shared widgets** (`shared/widgets/` trống — không tồn tại
chưa tạo). Quy tắc (skill design-system): trước khi tạo widget mới, kiểm tra
`shared/widgets/` đã có chưa; widget dùng chung từ lần tái dùng thứ 2 mới
đưa lên `shared/`, tránh trừu tượng hóa sớm.

## Widget hướng dẫn hiện hành

- Mọi màu từ `Theme.of(context).colorScheme` — không hex rời rạc
- Mọi khoảng cách từ `AppSpacing` — không số magic
- SnackBar cho lỗi (không dialog chặn); dialog chỉ cho xác nhận phá dữ liệu
- Loading: `LinearProgressIndicator` dưới list, input disable khi chờ
- Empty state: icon + gợi ý ví dụ câu hỏi (không để màn hình trắng)
