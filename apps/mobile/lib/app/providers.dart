import 'package:dio/dio.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../core/constants/app_constants.dart';
import '../core/settings/app_settings_service.dart';
import '../core/tts/tts_service.dart';
import '../features/chat/data/chat_history_service.dart';
import '../features/chat/data/conversation_id_service.dart';
import '../features/chat/data/copilot_api_client.dart';
import '../features/chat/data/einvoice_file_picker.dart';
import '../features/chat/data/photo_picker_service.dart';
import '../features/chat/data/speech_service.dart';
import '../features/ops/data/daily_summary_cache.dart';

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
  (ref) => CopilotApiClient(
    dio: ref.watch(dioProvider),
    // Read on EVERY request (no cached-at-boot copy) so the Settings screen
    // takes effect immediately — see CopilotApiClient.ask().
    settings: ref.watch(appSettingsServiceProvider),
    fallbackBaseUrl: ref.watch(appEnvironmentProvider).copilotBaseUrl,
  ),
);

/// Overridden in main() after SharedPreferences.getInstance().
/// Null prefs = storage unavailable — the app still runs, history just
/// does not persist (fail-safe, tasks.md 2.4).
final sharedPreferencesProvider = Provider<SharedPreferences?>((ref) {
  throw UnimplementedError(
    'sharedPreferencesProvider must be overridden in main()',
  );
});

/// User-editable settings (gateway URL/auth, history cap). Backed by the same
/// SharedPreferences instance as the chat history. Its getters are read LIVE by
/// CopilotApiClient on every request, so a change applies with no restart.
final appSettingsServiceProvider = Provider<AppSettingsService>(
  (ref) => AppSettingsService(prefs: ref.watch(sharedPreferencesProvider)),
);

final chatHistoryServiceProvider = Provider<ChatHistoryService>(
  (ref) => ChatHistoryService(prefs: ref.watch(sharedPreferencesProvider)),
);

/// NEXT6 (G8): the persisted, scope-aware DSH conversation id. Convenience only
/// — not an authentication boundary (see conversation_id_service.dart).
final dshConversationServiceProvider = Provider<ConversationIdService>(
  (ref) => ConversationIdService(prefs: ref.watch(sharedPreferencesProvider)),
);

/// P4-3: the persisted last-read day summary, so reopening the drawer inside the
/// freshness window costs no ERP aggregate and an offline open still shows the
/// last known numbers (labelled as old) instead of a blank screen.
final dailySummaryCacheProvider = Provider<DailySummaryCache>(
  (ref) => DailySummaryCache(prefs: ref.watch(sharedPreferencesProvider)),
);

/// P6: platform STT for voice DICTATION into the input field. Overridden with a
/// fake in tests (CI has no microphone) — see
/// `features/chat/data/speech_service.dart` for the contract.
final speechServiceProvider = Provider<SpeechService>(
  (ref) => SystemSpeechService(),
);

/// C1 (plan3 Trụ C): the photo picker behind the camera icon. Overridden with a
/// fake in tests (CI has no camera or photo library) — see
/// `features/chat/data/photo_picker_service.dart` for the contract. Like the
/// speech service, it can only produce BYTES: it has no path to `/ask` and none
/// to `/execute`.
final photoPickerProvider = Provider<PhotoPicker>(
  (ref) => SystemPhotoPicker(),
);

/// A2 (`.plan/next3/implementation.md` workstream A): the file picker behind the
/// "HĐĐT XML" button. Overridden with a fake in tests (CI has no file chooser) —
/// see `features/chat/data/einvoice_file_picker.dart` for the contract. Like the
/// photo picker it can only hand back TEXT: it has no path to `/ask` and none to
/// `/execute`.
final einvoiceFilePickerProvider = Provider<EinvoiceFilePicker>(
  (ref) => SystemEinvoiceFilePicker(),
);

/// TTS (plan2 next2): reads a NEW answer aloud when the user enabled it.
/// Overridden with a fake in tests (CI has no speech engine) — see
/// `core/tts/tts_service.dart`. This is output only: it can never confirm or
/// execute anything.
final ttsServiceProvider = Provider<TtsService>(
  (ref) => FlutterTtsService(),
);
