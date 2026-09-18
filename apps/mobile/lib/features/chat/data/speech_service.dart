import 'package:speech_to_text/speech_recognition_error.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

/// P6 (`plan2_final.md` §20, `.plan/phases2/p6-voice-stt.md`).
///
/// Voice is an INPUT MODALITY only:
///
/// ```text
/// mic → STT → text lands in the SAME editable field → USER edits → Send → /ask
/// ```
///
/// This interface deliberately exposes **no** way to send or execute anything —
/// the only method that can reach the gateway lives on the chat controller.
/// It exists so that (a) tests inject a fake (CI has no microphone) and (b) a
/// future engine swap (e.g. a self-hosted model) changes one file, never the
/// `/ask` pipeline or the Safety Gateway.
enum SpeechStatus {
  /// Not listening (also the "ready" result of a successful initialize).
  idle,

  /// Microphone is open and results are streaming in.
  listening,

  /// The user (or a policy) refused microphone access. Distinct from
  /// [unavailable] so the UI can tell the user HOW to fix it.
  denied,

  /// No recognizer on this device / the OS speech service is missing.
  unavailable,
}

/// One dictation session's callbacks. [onResult] receives the RUNNING transcript
/// (partial results included) — implementations replace, never append, so the
/// caller can rebuild the field from a fixed prefix. [isFinal] marks the end of
/// an utterance.
typedef SpeechResultCallback = void Function(String transcript, bool isFinal);

/// Lifecycle of a dictation session.
typedef SpeechStatusCallback = void Function(SpeechStatus status);

/// Thin, mockable wrapper over platform STT.
abstract class SpeechService {
  /// Prepares the recognizer and selects a locale.
  ///
  /// Returns [SpeechStatus.idle] when ready to listen, or [SpeechStatus.denied]
  /// / [SpeechStatus.unavailable] with the reason it cannot be used — the UI
  /// must surface that verbatim instead of failing silently.
  Future<SpeechStatus> initialize();

  /// The locale the recognizer is ASKED for — always Vietnamese after a
  /// successful [initialize], whether or not the device advertised it.
  String? get localeId;

  /// Whether the device's own locale list actually contained Vietnamese.
  ///
  /// `false` does NOT mean Vietnamese is unsupported: Android's list reports
  /// only the ON-DEVICE recognizer, and there is no API for the online one's
  /// languages (plugin doc, `locales()`). Google's online recognizer handles
  /// Vietnamese fine on a device whose list has no `vi` entry, so the UI may
  /// only show a soft "check the wording" note — never a refusal.
  bool get localeVerified;

  /// Whether a dictation session is currently open.
  bool get isListening;

  /// Opens the microphone and streams results. Refusal arrives as
  /// [SpeechStatus.denied]; a missing recognizer as [SpeechStatus.unavailable].
  /// Never returns text to the caller as "sent" — it only reports what was heard.
  Future<void> listen({
    required SpeechResultCallback onResult,
    required SpeechStatusCallback onStatus,
  });

  /// Stops and KEEPS the transcript recognized so far.
  Future<void> stop();

  /// Stops and discards (user aborted). No text is delivered afterwards.
  Future<void> cancel();
}

/// Real implementation over the `speech_to_text` plugin (Android
/// SpeechRecognizer / iOS Speech).
class SystemSpeechService implements SpeechService {
  SystemSpeechService({SpeechToText? speech})
      : _speech = speech ?? SpeechToText();

  final SpeechToText _speech;

  /// Asked for when the device's list has no Vietnamese entry. Android turns
  /// the `_` into `-` before handing it to `EXTRA_LANGUAGE`, so `vi_VN` is a
  /// valid BCP-47 tag (`vi-VN`).
  static const String fallbackLocaleId = 'vi_VN';

  bool _available = false;
  bool _permissionDenied = false;
  String? _localeId;
  bool _localeVerified = false;
  SpeechStatusCallback? _onStatus;

  /// Bumped on every listen/stop/cancel. A recognizer in teardown can still
  /// deliver one last result; comparing the token drops it, which is what the
  /// [stop]/[cancel] contract below actually promises. Without it a result
  /// arriving after stop() would reach a UI that has already moved on.
  int _session = 0;

  @override
  String? get localeId => _localeId;

  @override
  bool get localeVerified => _localeVerified;

  @override
  bool get isListening => _speech.isListening;

  @override
  Future<SpeechStatus> initialize() async {
    _permissionDenied = false;
    // initialize() prompts for the microphone on first call and returns false
    // when refused, when no recognizer exists, or when the service is missing.
    // The onError callback is the only way to tell those apart.
    _available = await _speech.initialize(
      onError: _handleError,
      onStatus: _handlePluginStatus,
    );
    if (!_available) {
      return _permissionDenied ? SpeechStatus.denied : SpeechStatus.unavailable;
    }
    await _pickVietnameseLocale();
    return SpeechStatus.idle;
  }

  /// Uses the device's own `vi*` entry when it has one. Otherwise still asks
  /// for [fallbackLocaleId] instead of giving up: an empty (or Vietnamese-less)
  /// `locales()` only describes the ON-DEVICE recognizer, and bugfix P6 showed
  /// the online one recognizing Vietnamese perfectly while this list had no
  /// `vi` entry — the old code then showed a bogus "no Vietnamese recognizer"
  /// warning and let the OS pick an arbitrary locale.
  Future<void> _pickVietnameseLocale() async {
    _localeVerified = false;
    try {
      final locales = await _speech.locales();
      for (final locale in locales) {
        if (locale.localeId.toLowerCase().startsWith('vi')) {
          _localeId = locale.localeId;
          _localeVerified = true;
          return;
        }
      }
    } catch (_) {
      // locales() is best-effort; the fallback below is the normal path.
    }
    _localeId = fallbackLocaleId;
  }

  @override
  Future<void> listen({
    required SpeechResultCallback onResult,
    required SpeechStatusCallback onStatus,
  }) async {
    final session = ++_session;
    _onStatus = onStatus;

    if (!_available) {
      final status = await initialize();
      if (status != SpeechStatus.idle) {
        onStatus(status);
        return;
      }
    }

    void forward(SpeechRecognitionResult result) {
      if (session != _session) return; // session ended — stale result
      onResult(result.recognizedWords, result.finalResult);
    }

    final requested = _localeId;
    try {
      await _startListening(forward, requested);
      onStatus(SpeechStatus.listening);
      return;
    } catch (_) {
      // Forcing a locale the device never advertised can make the platform
      // reject the session outright. That is NOT "no recognizer" — retry once
      // with the device default before saying the mic is unusable.
      if (requested == null || _localeVerified) {
        _available = false;
        onStatus(SpeechStatus.unavailable);
        return;
      }
      _localeId = null; // the device default takes over from here
    }

    try {
      await _startListening(forward, null);
      onStatus(SpeechStatus.listening);
    } catch (_) {
      // A platform that throws on listen() twice is unusable, not fatal.
      _available = false;
      onStatus(SpeechStatus.unavailable);
    }
  }

  Future<void> _startListening(
    SpeechResultListener onResult,
    String? localeId,
  ) =>
      _speech.listen(
        onResult: onResult,
        // A shop-counter utterance is short; a long open mic just burns battery.
        listenOptions: SpeechListenOptions(
          localeId: localeId,
          listenFor: const Duration(seconds: 30),
          pauseFor: const Duration(seconds: 3),
        ),
      );

  @override
  Future<void> stop() async {
    _session++; // drop any result still in flight
    _onStatus = null;
    await _speech.stop();
  }

  @override
  Future<void> cancel() async {
    _session++; // drop any result still in flight
    _onStatus = null;
    await _speech.cancel();
  }

  void _handleError(SpeechRecognitionError error) {
    // Checked BEFORE the `permanent` flag below: a language refusal must not
    // permanently disable the service. The online recognizer may still do
    // Vietnamese, so stop forcing the locale and let the next tap use the
    // device default — the reason is reported, but the mic stays usable.
    if (error.errorMsg == 'error_language_not_supported' ||
        error.errorMsg == 'error_language_unavailable') {
      _localeId = null;
      _localeVerified = false;
      _onStatus?.call(SpeechStatus.unavailable);
      return;
    }
    if (error.permanent) _available = false;
    if (error.errorMsg == 'error_permission') {
      _permissionDenied = true;
      _onStatus?.call(SpeechStatus.denied);
      return;
    }
    // Benign endings (no speech, timeout) are not errors worth telling the
    // user about — treat them as "stopped listening".
    if (error.errorMsg == 'error_no_match' ||
        error.errorMsg == 'error_speech_timeout') {
      _onStatus?.call(SpeechStatus.idle);
      return;
    }
    _onStatus?.call(SpeechStatus.unavailable);
  }

  void _handlePluginStatus(String status) {
    // Map the plugin's own status strings onto our lifecycle; anything we do
    // not recognise stays silent so the UI cannot get stuck "listening".
    if (status == 'done' || status == 'notListening') {
      _onStatus?.call(SpeechStatus.idle);
    }
  }
}
