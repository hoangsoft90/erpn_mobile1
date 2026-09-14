# Quản lý Trạng thái & Routing

## State management: Riverpod 3 (codegen `@riverpod`)

Blueprint khóa theo `architecture` skill — KHÔNG đổi sang Bloc/Redux/getx.

### Provider map (toàn bộ providers hiện có)

| Provider | Loại | File | Ghi chú |
|---|---|---|---|
| `appEnvironmentProvider` | `Provider<AppEnvironment>` | `app/providers.dart` | base URL từ dart-define `COPILOT_BASE_URL` |
| `dioProvider` | `Provider<Dio>` | `app/providers.dart` | baseUrl + connect/receive timeout 15s |
| `copilotApiClientProvider` | `Provider<CopilotApiClient>` | `app/providers.dart` | override trong test |
| `sharedPreferencesProvider` | `Provider<SharedPreferences?>` | `app/providers.dart` | **throw UnimplementedError** nếu không override ở `main()`; null = storage fail nhưng app vẫn chạy |
| `chatHistoryServiceProvider` | `Provider<ChatHistoryService>` | `app/providers.dart` | null-safe wrapper quanh prefs |
| `chatControllerProvider` | `@riverpod ChatController` (AsyncNotifier) | `features/chat/application/chat_controller.dart` | state = `AsyncValue<ChatState>` |

### ChatState (shape state duy nhất hiện có)

```dart
ChatState {
  List<ChatTurn> turns;   // history; 1 turn = 1 cặp bubble hỏi/đáp
  bool isLoading;         // input disabled + LinearProgress khi true
  String? lastError;      // SnackBar qua ref.listen; KHÔNG dialog chặn
}
```

### Quy ước quan trọng

- Sinh file `.g.dart` bằng `dart run build_runner build --delete-conflicting-outputs`
- Widget KHÔNG giữ business state (không setState cho logic) — chỉ controller
- Trả lời send(): `Future<bool>` — `true` = clear input; `false` = GIỮ text + set lastError
- Test override: `sharedPreferencesProvider.overrideWithValue(...)` +
  `copilotApiClientProvider.overrideWithValue(...)` (xem `test/chat_controller_test.dart`)

## Routing: GoRouter 18

```dart
// app/router/app_router.dart — toàn bộ cấu hình hiện tại
GoRouter(
  initialLocation: '/chat',
  routes: [ GoRoute(path: '/chat', name: 'chat', pageBuilder: ... ChatScreen) ],
  errorBuilder: ...  // scaffold tiếng Việt
)
```

- `MaterialApp.router(routerConfig: appRouter, theme: AppTheme.light())`
- Quy ước đặt tên (skill architecture): path `/kebab-case`, name `camelCase`
- Route mới đăng ký trong `app/router/` — cấm `Navigator.push` rời rạc

## Deep link

**Chưa có.** Không cấu hình intent-filter/assetlinks; khi cần (Phase 6+
proposal card từ notification), thêm theo workflow của skill
`flutter-setup-declarative-routing` (Manifest + assetlinks.json, hosted
`/.well-known/`). Việc này phải đi qua user vì đổi AndroidManifest.
