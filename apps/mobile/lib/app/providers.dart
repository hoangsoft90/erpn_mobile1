import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/constants/app_constants.dart';
import '../features/chat/data/chat_history_service.dart';
import '../features/chat/data/copilot_api_client.dart';

/// Environment injected at bootstrap (dart-define overrides the default).
class AppEnvironment {
  const AppEnvironment({required this.copilotBaseUrl});

  final String copilotBaseUrl;

  /// `flutter run --dart-define=COPILOT_BASE_URL=http://192.168.x.x:8788`
  static const String copilotBaseUrlFromEnv = String.fromEnvironment(
    'COPILOT_BASE_URL',
    defaultValue: AppConstants.defaultCopilotBaseUrl,
  );

  static const AppEnvironment defaults = AppEnvironment(
    copilotBaseUrl: copilotBaseUrlFromEnv,
  );
}

final appEnvironmentProvider = Provider<AppEnvironment>(
  (ref) => AppEnvironment.defaults,
);

final dioProvider = Provider<Dio>((ref) {
  final base = ref.watch(appEnvironmentProvider).copilotBaseUrl;
  return Dio(
    BaseOptions(
      baseUrl: base,
      connectTimeout: AppConstants.askTimeout,
      receiveTimeout: AppConstants.askTimeout,
      responseType: ResponseType.json,
    ),
  );
});

final copilotApiClientProvider = Provider<CopilotApiClient>(
  (ref) => CopilotApiClient(dio: ref.watch(dioProvider)),
);

/// Overridden in main() after SharedPreferences.getInstance().
/// Null prefs = storage unavailable — the app still runs, history just
/// does not persist (fail-safe, tasks.md 2.4).
final sharedPreferencesProvider = Provider<SharedPreferences?>((ref) {
  throw UnimplementedError(
    'sharedPreferencesProvider must be overridden in main()',
  );
});

final chatHistoryServiceProvider = Provider<ChatHistoryService>(
  (ref) => ChatHistoryService(prefs: ref.watch(sharedPreferencesProvider)),
);
