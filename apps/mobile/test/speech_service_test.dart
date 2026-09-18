import 'package:flutter_test/flutter_test.dart';
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
  _FakePlugin() : super.withMethodChannel();

  SpeechResultListener? listener;
  int stopCount = 0;
  int cancelCount = 0;
  bool _listening = false;

  @override
  bool get isListening => _listening;

  @override
  Future<bool> initialize({
    SpeechErrorListener? onError,
    SpeechStatusListener? onStatus,
    debugLogging = false,
    Duration finalTimeout = SpeechToText.defaultFinalTimeout,
    List<SpeechConfigOption>? options,
  }) async =>
      true;

  @override
  Future<List<LocaleName>> locales() async =>
      [LocaleName('vi_VN', 'Vietnamese')];

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

  test('a device with no Vietnamese locale reports null and stays usable',
      () async {
    final other = _NoLocalePlugin();
    final svc = SystemSpeechService(speech: other);

    expect(await svc.initialize(), SpeechStatus.idle);
    expect(svc.localeId, isNull);
  });
}

class _NoLocalePlugin extends _FakePlugin {
  @override
  Future<List<LocaleName>> locales() async =>
      [LocaleName('en_US', 'English')];
}
