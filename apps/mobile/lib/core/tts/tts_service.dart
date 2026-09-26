import 'package:flutter_tts/flutter_tts.dart';

/// TTS (`.plan/next2/text-to-speed.md`, `tts-implementation-plan.md`): reading a
/// NEW answer aloud through the **on-device** engine (Google Text-to-Speech on
/// Android, Apple TTS on iOS). No network, no backend, no cost.
///
/// Deliberately its own abstraction — exactly like [SpeechService] for STT and
/// [CopilotApiClient] for HTTP — so that:
///  * the controller/widget layer never touches a platform plugin directly, and
///  * tests inject a fake (CI has no speech engine).
///
/// **Safety boundary (plan §6):** this interface can only READ text out loud.
/// There is intentionally no method that confirms, executes, or mutates
/// anything — a spoken payment proposal is an announcement, never an action.
/// [speak] must never be wired to a confirm/execute path.
abstract class TtsService {
  /// Reads [text] aloud in Vietnamese, interrupting anything already speaking
  /// (answers can arrive back-to-back and must not overlap).
  Future<void> speak(String text);

  /// Stops any in-progress utterance.
  Future<void> stop();
}

/// Real implementation over the `flutter_tts` plugin.
///
/// Fail-safe by contract: a missing Vietnamese voice package, a platform
/// without a TTS engine, or any plugin error turns [speak] into a SILENT
/// no-op. Reading aloud is a convenience — it must never throw, never block
/// the chat, and never show an error the user cannot act on (the same rule the
/// P6 locale hint learned the hard way). The answer already shows on the card.
class FlutterTtsService implements TtsService {
  FlutterTtsService({FlutterTts? tts}) : _tts = tts ?? FlutterTts();

  /// Vietnamese (BCP-47). Google TTS ships `vi-VN`.
  static const String languageTag = 'vi-VN';

  /// Vietnamese read slightly slower than the platform default is easier to
  /// follow at a shop counter. Fixed for the MVP — no settings slider yet.
  static const double speechRate = 0.55;
  static const double pitch = 1.0;

  final FlutterTts _tts;

  /// Memoised so the one-time configuration runs at most once even when several
  /// answers arrive before the first one finishes initialising.
  Future<void>? _init;

  /// Whether the device actually has a Vietnamese voice installed. Set during
  /// initialisation; when false, [speak] is a no-op instead of a dead end.
  bool _languageAvailable = false;

  Future<void> _ensureInitialized() => _init ??= _initialize();

  Future<void> _initialize() async {
    try {
      // Deliberately NOT calling awaitSpeakCompletion(true): with the default
      // (off) the plugin's speak() future resolves once speech STARTS, so the
      // chat is never held open for the length of an utterance — a long answer
      // would otherwise delay the input field from clearing.
      await _tts.setLanguage(languageTag);
      await _tts.setSpeechRate(speechRate);
      await _tts.setPitch(pitch);
      // Returns true/false per the plugin's contract. Anything other than a
      // literal `true` (null on an engine that does not answer) is treated as
      // "no Vietnamese voice" rather than assumed to be available.
      _languageAvailable = (await _tts.isLanguageAvailable(languageTag)) == true;
    } catch (_) {
      _languageAvailable = false;
    }
  }

  @override
  Future<void> speak(String text) async {
    final trimmed = text.trim();
    if (trimmed.isEmpty) return; // nothing to say — never open the engine
    await _ensureInitialized();
    if (!_languageAvailable) return;
    try {
      // Interrupt the previous utterance first: two answers read at once is
      // worse than a slightly clipped first one.
      await _tts.stop();
      await _tts.speak(trimmed);
    } catch (_) {
      // Engine hiccup — reading is optional and must not surface anywhere.
    }
  }

  @override
  Future<void> stop() async {
    try {
      await _tts.stop();
    } catch (_) {
      // nothing speaking / engine gone — nothing to do
    }
  }
}
