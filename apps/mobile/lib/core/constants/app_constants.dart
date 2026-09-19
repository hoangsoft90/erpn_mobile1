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

  /// DSH mode (`.plan/dsh_end_to_end.md`): one /dsh/ask is an AGENT session —
  /// the measured real round trip through the router is ~20s, and the gateway
  /// itself kills a session at DSH_TIMEOUT_MS (180s). Deliberately LONGER than
  /// the gateway's own bound so the app waits for the gateway's answer (or its
  /// clean timeout copy) instead of cutting the connection first and showing
  /// "hết thời gian chờ" for a session the server would have finished.
  /// Normal mode keeps [askTimeout] — the two paths never share a bound.
  static const Duration dshTimeout = Duration(seconds: 210);

  // ---- Settings screen (2026-09-16) ----------------------------------------
  // Stored in the SAME SharedPreferences instance as history. Versioned keys
  // so a future change never misreads old data.

  /// Gateway base URL the app was pointed at via `--dart-define` when no
  /// value was saved in Settings yet. The Settings screen PRE-FILLS this value
  /// on first open (see [defaultGatewayBaseUrl]); it is NOT written
  /// automatically, so an existing APK keeps using its compiled-in URL until
  /// the user actually saves something.
  static const String gatewayBaseUrlStorageKey = 'settings_gateway_base_url_v1';
  static const String gatewayAuthUserStorageKey = 'settings_gateway_auth_user_v1';
  static const String gatewayAuthPasswordStorageKey =
      'settings_gateway_auth_password_v1';
  static const String maxChatItemsStorageKey = 'settings_max_chat_items_v1';

  /// F7-2 (user decision 2026-09-18): "allow real submission" — default OFF.
  /// Stored separately so the card copy and the executor both read the SAME
  /// frozen-at-proposal-time value.
  static const String allowSubmitPaymentStorageKey =
      'settings_allow_submit_payment_v1';

  /// P6 UX (user decision 2026-09-18): "Tự gửi sau khi nói xong" — default
  /// OFF, i.e. dictation keeps filling the field and the user presses Gửi.
  /// When ON, a FINAL speech result sends through the SAME Send path (POST
  /// /ask). It never confirms a proposal and never touches /execute.
  static const String voiceAutoSendStorageKey =
      'settings_voice_auto_send_v1';

  /// TTS (plan2 next2): "Đọc câu trả lời" — default OFF, i.e. answers stay
  /// silent. When ON, a NEW answer/proposal is read aloud by the ON-DEVICE
  /// engine (flutter_tts, vi-VN). Purely an accessibility/attention aid: it
  /// cannot confirm a proposal, reach /execute, or influence any safety flag
  /// (see `TtsService`), and it is independent of [voiceAutoSendStorageKey].
  static const String ttsEnabledStorageKey = 'settings_tts_enabled_v1';

  /// Pre-filled in the Settings screen for the current dev tunnel (Phase 3
  /// decision: localtunnel of the gateway on port 8788). Only a suggestion —
  /// never silently applied over `--dart-define`.
  static const String defaultGatewayBaseUrl = 'https://erpn8788.loca.lt';

  /// B.2 safety default: keep at most this many chat turns.
  static const int defaultMaxChatItems = 20;

  /// Below this, history would be uselessly short — the Settings screen and
  /// the service both clamp to it (never trust a hand-typed value).
  static const int minMaxChatItems = 5;
}
