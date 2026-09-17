import 'package:shared_preferences/shared_preferences.dart';

import '../constants/app_constants.dart';

/// User-editable settings stored in the SAME SharedPreferences instance as the
/// chat history (see [ChatHistoryService] for the fail-safe convention).
///
/// Fail-safe contract, mirroring the history service: a null [SharedPreferences]
/// (bootstrap failure) or a platform error NEVER crashes the app — reads fall
/// back to defaults, writes are swallowed. Settings are a convenience, not data
/// of record.
///
/// Getters are SYNCHRONOUS: once the SharedPreferences instance exists, reading
/// a key is a plain map lookup. That is deliberate — [CopilotApiClient] re-reads
/// the settings on EVERY request so a change in the Settings screen applies
/// without restarting the app (no cached-at-boot copy).
class AppSettingsService {
  // ignore: prefer_initializing_formals — named param `prefs` stays public API
  AppSettingsService({required SharedPreferences? prefs}) : _prefs = prefs;

  final SharedPreferences? _prefs;

  /// The saved gateway base URL, or `''` when the user has never saved one.
  ///
  /// Empty is meaningful: it tells the caller to fall back to the compiled-in
  /// `--dart-define=COPILOT_BASE_URL` value. This is why the suggested default
  /// ([AppConstants.defaultGatewayBaseUrl]) is only PRE-FILLED in the Settings
  /// form and never returned here.
  String get gatewayBaseUrl =>
      _prefs?.getString(AppConstants.gatewayBaseUrlStorageKey)?.trim() ?? '';

  String get gatewayAuthUser =>
      _prefs?.getString(AppConstants.gatewayAuthUserStorageKey)?.trim() ?? '';

  String get gatewayAuthPassword =>
      _prefs?.getString(AppConstants.gatewayAuthPasswordStorageKey) ?? '';

  /// At most this many chat turns are kept. Always within
  /// [AppConstants.minMaxChatItems, ∞), defaulting to
  /// [AppConstants.defaultMaxChatItems] — a hand-edited value can never shrink
  /// history below the safe floor.
  int get maxChatItems {
    final stored = _prefs?.getInt(AppConstants.maxChatItemsStorageKey);
    if (stored == null) return AppConstants.defaultMaxChatItems;
    return clampMaxChatItems(stored);
  }

  /// The value to PRE-FILL the Settings form with on first open.
  String get gatewayBaseUrlOrDefault =>
      gatewayBaseUrl.isEmpty ? AppConstants.defaultGatewayBaseUrl : gatewayBaseUrl;

  /// A base URL is only accepted when it parses and is http/https with a host.
  static bool isValidGatewayUrl(String value) {
    final v = value.trim();
    if (v.isEmpty) return false;
    final uri = Uri.tryParse(v);
    if (uri == null) return false;
    if (uri.scheme != 'http' && uri.scheme != 'https') return false;
    return uri.host.isNotEmpty;
  }

  /// Enforce the floor on any incoming max-items value.
  static int clampMaxChatItems(int value) =>
      value < AppConstants.minMaxChatItems
          ? AppConstants.minMaxChatItems
          : value;

  /// Persists the gateway connection settings. [baseUrl] must already be
  /// validated by the caller (the Settings screen does this before enabling
  /// its Save button); invalid input is refused here too, fail-closed.
  Future<bool> saveGateway({
    required String baseUrl,
    required String authUser,
    required String authPassword,
  }) async {
    final prefs = _prefs;
    if (prefs == null) return false;
    final url = baseUrl.trim();
    if (!isValidGatewayUrl(url)) return false;
    try {
      await prefs.setString(AppConstants.gatewayBaseUrlStorageKey, url);
      await prefs.setString(
          AppConstants.gatewayAuthUserStorageKey, authUser.trim());
      await prefs.setString(
          AppConstants.gatewayAuthPasswordStorageKey, authPassword);
      return true;
    } catch (_) {
      // storage error — keep running with the previous/in-memory values
      return false;
    }
  }

  /// Persists the history cap, clamped to the floor. Returns the value that was
  /// actually stored (useful for the UI to normalise its field).
  Future<int> saveMaxChatItems(int value) async {
    final clamped = clampMaxChatItems(value);
    final prefs = _prefs;
    if (prefs == null) return clamped;
    try {
      await prefs.setInt(AppConstants.maxChatItemsStorageKey, clamped);
    } catch (_) {
      // ignore — next successful save rewrites it
    }
    return clamped;
  }

  /// Forgets everything this service stores (used by tests / a future "reset to
  /// default" action). Missing prefs is a no-op.
  Future<void> clear() async {
    final prefs = _prefs;
    if (prefs == null) return;
    try {
      await prefs.remove(AppConstants.gatewayBaseUrlStorageKey);
      await prefs.remove(AppConstants.gatewayAuthUserStorageKey);
      await prefs.remove(AppConstants.gatewayAuthPasswordStorageKey);
      await prefs.remove(AppConstants.maxChatItemsStorageKey);
    } catch (_) {
      // ignore
    }
  }
}
