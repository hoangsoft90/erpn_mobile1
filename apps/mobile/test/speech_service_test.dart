import 'package:flutter_test/flutter_test.dart';
import 'package:speech_to_text/speech_recognition_error.dart';
import 'package:speech_to_text/speech_recognition_result.dart';
import 'package:speech_to_text/speech_to_text.dart';

import 'package:erpn_mobile/features/chat/data/speech_service.dart';

/// P6: `SystemSpeechService` is tested against a SUBCLASS of the real plugin,
/// not a re-implementation of its behaviour.
///
/// The behaviour under test comes straight from the plugin's own doc:
/// *"Stopping a listen session will cause a final result to be sent."* So a
/// result genuinely can arrive after `stop()` — the service must drop it,
/// otherwise the utterance the user just sent reappears in the cleared field.
class _FakePlugin extends SpeechToText {
  _FakePlugin({this.localeList = const ['vi_VN:Vietnamese']})
      : super.withMethodChannel();

  SpeechResultListener? listener;

  /// Named to avoid colliding with the plugin's own inherited `errorListener`.
  SpeechErrorListener? lastErrorListener;
  int stopCount = 0;
  int cancelCount = 0;
  bool _listening = false;

  /// What the platform reports as available. Android reports only the ON-DEVICE
  /// recognizer's languages, so this is routinely empty/incomplete (bug P6).
  final List<String> localeList;

  /// Every localeId the service actually asked the platform for, in order.
  final List<String?> localeAttempts = <String?>[];

  /// When set, the platform REJECTS a listen for this locale the way Android
  /// does when it cannot honour `EXTRA_LANGUAGE` (the plugin turns that into a
  /// `ListenFailedException`).
  String? rejectLocale;

  @override
  bool get isListening => _listening;

  @override
  Future<bool> initialize({
    SpeechErrorListener? onError,
    SpeechStatusListener? onStatus,
    debugLogging = false,
    Duration finalTimeout = SpeechToText.defaultFinalTimeout,
    List<SpeechConfigOption>? options,
  }) async {
    lastErrorListener = onError;
    return true;
  }

  /// Stands in for the OS reporting a recognition error mid-session (the
  /// plugin routes it to the listener given to `initialize`).
  void callError(SpeechRecognitionError error) => lastErrorListener?.call(error);

  @override
  Future<List<LocaleName>> locales() async => localeList
      .map((entry) => entry.split(':'))
      .map((parts) => LocaleName(parts[0], parts.length > 1 ? parts[1] : ''))
      .toList();

  // Signature mirrors the plugin's own (deprecated params included) so the
  // override is exact.
  // ignore: deprecated_member_use_from_same_package
  @override
  Future<void> listen({
    SpeechResultListener? onResult,
    Duration? listenFor,
    Duration? pauseFor,
    String? localeId,
    SpeechSoundLevelChange? onSoundLevelChange,
    cancelOnError = false,
    partialResults = true,
    onDevice = false,
    ListenMode listenMode = ListenMode.confirmation,
    sampleRate = 0,
    SpeechListenOptions? listenOptions,
  }) async {
    final asked = listenOptions?.localeId ?? localeId;
    localeAttempts.add(asked);
    if (rejectLocale != null && asked == rejectLocale) {
      throw ListenFailedException('error_language_not_supported');
    }
    listener = onResult;
    _listening = true;
  }

  @override
  Future<void> stop() async {
    stopCount++;
    _listening = false;
  }

  @override
  Future<void> cancel() async {
    cancelCount++;
    _listening = false;
  }

  /// What the OS does during teardown: flush one last result.
  void deliver(String words, {bool isFinal = true}) =>
      listener?.call(SpeechRecognitionResult(
        <SpeechRecognitionWords>[SpeechRecognitionWords(words, null, 1.0)],
        isFinal ? ResultType.finalResult.value : ResultType.partial.value,
      ));
}

void main() {
  late _FakePlugin plugin;
  late SystemSpeechService service;
  late List<String> heard;

  setUp(() {
    plugin = _FakePlugin();
    service = SystemSpeechService(speech: plugin);
    heard = <String>[];
  });

  Future<void> startListening() => service.listen(
        onResult: (text, _) => heard.add(text),
        onStatus: (_) {},
      );

  test('initialize picks the Vietnamese locale when the device has one',
      () async {
    expect(await service.initialize(), SpeechStatus.idle);
    expect(service.localeId, 'vi_VN');
  });

  test('a result during the session reaches the caller', () async {
    await service.initialize();
    await startListening();

    plugin.deliver('chị Lan');
    expect(heard, ['chị Lan']);
  });

  test('stop() drops the final result the plugin flushes on teardown',
      () async {
    await service.initialize();
    await startListening();
    plugin.deliver('chị Lan');
    expect(heard, ['chị Lan']);

    await service.stop();
    plugin.deliver('chị Lan còn nợ bao nhiêu');

    expect(heard, ['chị Lan'],
        reason: 'the teardown flush must not reach a caller that moved on');
    expect(plugin.stopCount, 1);
  });

  test('cancel() drops everything afterwards (documented contract)', () async {
    await service.initialize();
    await startListening();

    await service.cancel();
    plugin.deliver('chị Lan', isFinal: false);

    expect(heard, isEmpty);
    expect(plugin.cancelCount, 1);
  });

  test('a NEW session after stop receives results again', () async {
    await service.initialize();
    await startListening();
    await service.stop();
    plugin.deliver('bỏ đi');

    await startListening();
    plugin.deliver('chị Lan');

    expect(heard, ['chị Lan'],
        reason: 'the guard must expire with the old session, not mute forever');
  });

  // ────────────────────── bug P6: the locale list is NOT the truth ──────────
  //
  // "Android: The list of languages is based on the locales supported by the
  // on device recognizer. This list may not be the complete list of languages
  // available for online recognition." — the plugin's own doc for locales().
  // So a device with no `vi` in the list (or an empty list) must STILL be
  // asked for Vietnamese, instead of silently falling back to the OS default
  // locale and telling the user Vietnamese is missing.

  test('a locale list WITHOUT vi still asks for vi_VN (bug P6)', () async {
    final plugin = _FakePlugin(localeList: const ['en_US:English']);
    final svc = SystemSpeechService(speech: plugin);

    expect(await svc.initialize(), SpeechStatus.idle);
    expect(svc.localeId, SystemSpeechService.fallbackLocaleId,
        reason: 'the online recognizer may well support Vietnamese');
    expect(svc.localeVerified, isFalse,
        reason: 'the UI may only hint — not claim Vietnamese is unsupported');

    await svc.listen(onResult: (_, _) {}, onStatus: (_) {});
    expect(plugin.localeAttempts, [SystemSpeechService.fallbackLocaleId]);
  });

  test('an EMPTY locale list still asks for vi_VN (bug P6)', () async {
    final plugin = _FakePlugin(localeList: const []);
    final svc = SystemSpeechService(speech: plugin);

    expect(await svc.initialize(), SpeechStatus.idle);
    expect(svc.localeId, SystemSpeechService.fallbackLocaleId);
    expect(svc.localeVerified, isFalse);

    await svc.listen(onResult: (_, _) {}, onStatus: (_) {});
    expect(plugin.localeAttempts, [SystemSpeechService.fallbackLocaleId]);
  });

  test('an advertised vi locale is used as-is and counts as verified',
      () async {
    final plugin = _FakePlugin();
    final svc = SystemSpeechService(speech: plugin);

    await svc.initialize();
    expect(svc.localeId, 'vi_VN');
    expect(svc.localeVerified, isTrue);
  });

  test('a platform that REJECTS the forced locale is retried with the default',
      () async {
    final plugin = _FakePlugin(localeList: const ['en_US:English'])
      ..rejectLocale = SystemSpeechService.fallbackLocaleId;
    final svc = SystemSpeechService(speech: plugin);
    final statuses = <SpeechStatus>[];

    await svc.initialize();
    await svc.listen(onResult: (_, _) {}, onStatus: statuses.add);

    expect(plugin.localeAttempts,
        [SystemSpeechService.fallbackLocaleId, null],
        reason: 'retry once with the device default, not give up');
    expect(statuses, [SpeechStatus.listening],
        reason: 'the retry succeeded — the mic is NOT unavailable');
  });

  test('a verified locale is NOT retried — a real failure still surfaces',
      () async {
    final plugin = _FakePlugin()..rejectLocale = 'vi_VN';
    final svc = SystemSpeechService(speech: plugin);
    final statuses = <SpeechStatus>[];

    await svc.initialize();
    expect(svc.localeVerified, isTrue);
    await svc.listen(onResult: (_, _) {}, onStatus: statuses.add);

    expect(plugin.localeAttempts, ['vi_VN'],
        reason: 'honouring the device list must not degrade into a silent retry');
    expect(statuses, [SpeechStatus.unavailable]);
  });

  test('a language refusal drops the forced locale but keeps the mic usable',
      () async {
    final plugin = _FakePlugin(localeList: const ['en_US:English']);
    final svc = SystemSpeechService(speech: plugin);
    final statuses = <SpeechStatus>[];

    await svc.initialize();
    await svc.listen(onResult: (_, _) {}, onStatus: statuses.add);

    // The recognizer reports the refusal through onError, not by throwing.
    plugin.callError(
      SpeechRecognitionError('error_language_not_supported', true),
    );

    expect(statuses.last, SpeechStatus.unavailable,
        reason: 'the user must be told this attempt failed');
    expect(svc.localeId, isNull,
        reason: 'the next attempt should use the device default locale');

    // …and the service must NOT be permanently disabled.
    plugin.localeAttempts.clear();
    await svc.listen(onResult: (_, _) {}, onStatus: statuses.add);
    expect(plugin.localeAttempts, [null],
        reason: 'a language refusal is not "this phone has no recognizer"');
  });
}
