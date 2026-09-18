# Quản lý Trạng thái & Routing

## State management: Riverpod 3 (codegen `@riverpod`)

Blueprint khóa theo `architecture` skill — KHÔNG đổi sang Bloc/Redux/getx.

### Provider map (toàn bộ providers hiện có)

| Provider | Loại | File | Ghi chú |
|---|---|---|---|
| `appEnvironmentProvider` | `Provider<AppEnvironment>` | `app/providers.dart` | base URL từ dart-define `COPILOT_BASE_URL` (fallback khi Settings rỗng) |
| `appSettingsServiceProvider` | `Provider<AppSettingsService>` | `app/providers.dart` | gateway URL/auth/maxChatItems/submit switch (SharedPreferences); **invalidate sau Save** để UI rebuild |
| `dioProvider` | `Provider<Dio>` | `app/providers.dart` | baseUrl + timeout; URL hiệu lực = Settings > dart-define |
| `copilotApiClientProvider` | `Provider<CopilotApiClient>` | `app/providers.dart` | override trong test |
| `sharedPreferencesProvider` | `Provider<SharedPreferences?>` | `app/providers.dart` | **throw UnimplementedError** nếu không override ở `main()`; null = storage fail nhưng app vẫn chạy |
| `chatHistoryServiceProvider` | `Provider<ChatHistoryService>` | `app/providers.dart` | null-safe wrapper quanh prefs |
| `speechServiceProvider` | `Provider<SpeechService>` | `app/providers.dart` | P6: override trong test (`_FakeSpeech`) |
| `chatControllerProvider` | `@riverpod ChatController` (AsyncNotifier) | `features/chat/application/chat_controller.dart` | state = `AsyncValue<ChatState>`; autoDispose — test phải `container.listen` giữ alive |

### ChatState (shape state duy nhất hiện có)

```dart
```dart
ChatState {
  List<ChatTurn> turns;   // history; 1 turn = bubble + proposal + rejection (nếu có)
  bool isLoading;         // PipelineProgress + input disabled khi true
  String? lastError;      // SnackBar qua ref.listen; KHÔNG dialog chặn
}
```

Turn có proposal mang `command_id` (Expando cache theo proposal instance —
không đổi khi rebuild/recycle card; /ask mới = id mới). Trim lịch sử theo
`maxChatItems` nhưng KHÔNG BAO GIỜ cắt turn có proposal PENDING.

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
  routes: [
    GoRoute(path: '/chat', name: 'chat', pageBuilder: ... ChatScreen),
    GoRoute(path: '/settings', name: 'settings', pageBuilder: ... SettingsScreen),
  ],
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
