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

  /// NEXT6 (G8): the persisted DSH conversation id. Stored with a scope line
  /// (`server|user`) so switching gateway/account starts a NEW conversation
  /// instead of continuing the old one's context. Convenience only — NOT an
  /// authentication boundary (see conversation_id_service.dart).
  static const String dshConversationStorageKey = 'dsh_conversation_id_v1';

  /// P4-3: the last `/read/daily-summary` body + when it was fetched, so the
  /// drawer can show the numbers it already has instead of an empty screen when
  /// the gateway is unreachable. Versioned like the history key.
  static const String dailySummaryCacheStorageKey = 'daily_summary_cache_v1';

  /// P4-3 (plan4_final §2): how long a fetched day summary counts as FRESH.
  /// Inside this window the drawer re-renders what it has and spends no ERP
  /// aggregate; pull-to-refresh is the explicit way past it. The plan suggests
  /// 30–60s; 45s sits in the middle so the number is defensible either way.
  static const Duration summaryCacheWindow = Duration(seconds: 45);

  /// Per tasks.md 2.2 — 15s for one /ask roundtrip (NLP + ERPNext).
  static const Duration askTimeout = Duration(seconds: 15);

  /// D4 (drawer-plan-final §2.4): the HARD bound on one drawer READ
  /// (`/read/daily-summary`, `/read/drill`, `/read/list`).
  ///
  /// The plan asks for a list read to fail in ~5–7s with a clear error instead
  /// of spinning; 7s is the top of that range, and it is a TOTAL bound applied
  /// with `Future.timeout` rather than Dio's `receiveTimeout` (which only
  /// bounds the gap BETWEEN bytes, so a server that trickles nothing would
  /// still hang). A read that trips this becomes [CopilotTimeoutException]
  /// ("Hết thời gian chờ máy chủ.") with the screen's [Thử lại] — never a
  /// continue-to-spin and never a fabricated empty list.
  ///
  /// Deliberately its own constant: `/ask` (15s) and the long DSH/OCR paths
  /// have their own bounds, and a drawer read must not inherit a longer one
  /// just because a later feature raised it.
  static const Duration readTimeout = Duration(seconds: 7);

  /// DSH mode (`.plan/dsh_end_to_end.md`): one /dsh/ask is an AGENT session —
  /// the measured real round trip through the router is ~20s, and the gateway
  /// itself kills a session at DSH_TIMEOUT_MS (180s). Deliberately LONGER than
  /// the gateway's own bound so the app waits for the gateway's answer (or its
  /// clean timeout copy) instead of cutting the connection first and showing
  /// "hết thời gian chờ" for a session the server would have finished.
  /// Normal mode keeps [askTimeout] — the two paths never share a bound.
  static const Duration dshTimeout = Duration(seconds: 210);

  /// C1 (plan3 Trụ C): one `/ocr` round trip sends a PHOTO to a vision model,
  /// which is heavier than an /ask. Deliberately LONGER than the server's own
  /// bound (`OCR_TIMEOUT_MS`, default 20s) so the client waits for the server's
  /// clean refusal (503 OCR_PROVIDER_FAILED) instead of cutting the connection
  /// first and showing "hết thời gian chờ" for a read the server would have
  /// answered. A timeout here must never look like "the photo had no text".
  static const Duration ocrTimeout = Duration(seconds: 30);

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

  /// Auto AI fallback (`​.plan/next2/auto-fallback-dsh.md`) — "Tự động chuyển
  /// sang AI khi không tìm thấy nghiệp vụ phù hợp" — default OFF.
  ///
  /// When ON, a `/ask` answer with `error_code == UNKNOWN_INTENT` makes the
  /// CLIENT ask the same question down `/dsh/ask` (two separate requests — the
  /// server never redirects, D2). When OFF the same answer instead offers a
  /// button on that message. Either way the deterministic path stays the
  /// default; this only decides what happens AFTER it says it does not know.
  static const String autoFallbackToAiStorageKey =
      'settings_auto_fallback_to_ai_v1';

  /// Pre-filled in the Settings screen for the current dev tunnel (Phase 3
  /// decision: localtunnel of the gateway on port 8788). Only a suggestion —
  /// never silently applied over `--dart-define`.
  static const String defaultGatewayBaseUrl = 'https://erpn8788.loca.lt';

  /// B.2 safety default: keep at most this many chat turns.
  static const int defaultMaxChatItems = 20;

  /// Below this, history would be uselessly short — the Settings screen and
  /// the service both clamp to it (never trust a hand-typed value).
  static const int minMaxChatItems = 5;

  // ---- P5-4 (plan5_final §6 + §7 items 3/4): voice timers, ONE home each ----
  // These used to be literals buried in SystemSpeechService._startListening
  // (30s/3s), invisible from the voice-first layout that must coordinate with
  // them. §7 item 3 pins the hard cap; §6 requires the VAD value to be
  // "đọc từ config" rather than hardcoded in several places.

  /// Hard cap on one dictation session (§7 item 3: pinned at 25s for BOTH the
  /// READ and the WRITE path in V1). When it fires, the session stops the way a
  /// user tap-to-stop would: the transcript heard so far is KEPT (it flows into
  /// the field, and auto-send may run) — it must NOT behave like Huỷ, which
  /// discards the transcript. Also passed to the recognizer itself as
  /// `listenFor`, so the platform cuts the session off even without our timer.
  static const Duration voiceMaxRecordDuration = Duration(seconds: 25);

  /// Silence that ends an utterance (the recognizer's `pauseFor`). §6: "VAD
  /// timeout đọc từ config, mặc định 2.2 giây" — down from the old 3s literal
  /// so a shorter pause between sentences still ends the turn in voice-first
  /// mode (§1.2 — longer is better for typed dictation, but the default must
  /// serve the default setting first).
  static const Duration voiceSilenceTimeout = Duration(milliseconds: 2200);
}
