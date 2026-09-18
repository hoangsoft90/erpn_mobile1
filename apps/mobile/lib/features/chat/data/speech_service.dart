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

  /// The Vietnamese locale actually in use, or null when the device only offers
  /// non-Vietnamese locales (the UI shows a "may be inaccurate" note).
  String? get localeId;

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

  bool _available = false;
  bool _permissionDenied = false;
  String? _localeId;
  SpeechStatusCallback? _onStatus;

  /// Bumped on every listen/stop/cancel. A recognizer in teardown can still
  /// deliver one last result; comparing the token drops it, which is what the
  /// [stop]/[cancel] contract below actually promises. Without it a result
  /// arriving after stop() would reach a UI that has already moved on.
  int _session = 0;

  @override
  String? get localeId => _localeId;

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
    _localeId = await _pickVietnameseLocale();
    return SpeechStatus.idle;
  }

  /// `vi_VN` when the device has one (the phase's preference); null otherwise,
  /// in which case we let the OS use its default locale and the UI warns.
  Future<String?> _pickVietnameseLocale() async {
    try {
      final locales = await _speech.locales();
      for (final locale in locales) {
        if (locale.localeId.toLowerCase().startsWith('vi')) {
          return locale.localeId;
        }
      }
    } catch (_) {
      // locales() is best-effort; the OS default is an acceptable fallback.
    }
    return null;
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

    try {
      await _speech.listen(
        onResult: (SpeechRecognitionResult result) {
          if (session != _session) return; // session ended — stale result
          onResult(result.recognizedWords, result.finalResult);
        },
        // A shop-counter utterance is short; a long open mic just burns battery.
        listenOptions: SpeechListenOptions(
          localeId: _localeId,
          listenFor: const Duration(seconds: 30),
          pauseFor: const Duration(seconds: 3),
        ),
      );
      onStatus(SpeechStatus.listening);
    } catch (_) {
      // A platform that throws on listen() is unusable, not fatal to the app.
      _available = false;
      onStatus(SpeechStatus.unavailable);
    }
  }

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
