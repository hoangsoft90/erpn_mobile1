/// App-wide constants. No magic values scattered in widgets.
class AppConstants {
  AppConstants._();

  /// Copilot HTTP wrapper (mcp-erpnext/src/http-ask.mjs). Default is the
  /// localhost bridge used on the dev machine; on a real phone this must be
  /// the LAN IP of the host running the service (Phase 5 gateway will own
  /// the public endpoint).
  static const String defaultCopilotBaseUrl = 'http://127.0.0.1:8788';

  /// Versioned key so a future schema change never breaks old data.
  static const String chatHistoryStorageKey = 'chat_history_v1';

  /// Per tasks.md 2.2 — 15s for one /ask roundtrip (NLP + ERPNext).
  static const Duration askTimeout = Duration(seconds: 15);
}
