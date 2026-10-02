import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/core/tts/tts_service.dart';

/// TTS (`.plan/next2/tts-implementation-plan.md` §3).
///
/// The fake here is the PLATFORM CHANNEL (`flutter_tts`), not the Dart wrapper:
/// these tests therefore exercise the real [FlutterTtsService] code — the same
/// object the app builds — instead of a re-implementation of it.
///
/// The property that matters most is the fail-safe one: a device with no
/// Vietnamese voice must stay SILENT and never throw. A missing voice package
/// is not an error the user can act on mid-conversation, and reading aloud is
/// only a courtesy on top of the answer already on screen.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  const channel = MethodChannel('flutter_tts');

  /// Every method the service invoked, in order.
  late List<String> calls;

  /// What the fake engine answers `isLanguageAvailable` with.
  late bool languageAvailable;

  /// When set, the fake engine throws on this method name.
  String? failOn;

  setUp(() {
    calls = <String>[];
    languageAvailable = true;
    failOn = null;
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      if (failOn != null && call.method == failOn) {
        throw PlatformException(code: 'engine_error');
      }
      if (call.method == 'isLanguageAvailable') return languageAvailable;
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, null);
  });

  test('speak() configures vi-VN once and then reads the text', () async {
    final tts = FlutterTtsService();
    await tts.speak('Chị Lan còn nợ 2.500.000đ');
    await tts.speak('Câu thứ hai');

    expect(calls, [
      'setLanguage',
      'setSpeechRate',
      'setPitch',
      'isLanguageAvailable',
      // First utterance…
      'stop',
      'speak',
      // …second utterance interrupts and speaks again.
      'stop',
      'speak',
    ], reason: 'configuration runs at most once; every speak is preceded by stop');
  });

  test('no Vietnamese voice package ⇒ speak() is a silent no-op', () async {
    languageAvailable = false;
    final tts = FlutterTtsService();

    // Must not throw…
    await expectLater(tts.speak('Chị Lan còn nợ 2.500.000đ'), completes);

    // …and must not reach the engine.
    expect(calls.contains('speak'), isFalse,
        reason: 'an unavailable voice must not attempt to speak');
    expect(calls.contains('stop'), isFalse);
  });

  test('empty / whitespace text never opens the engine at all', () async {
    final tts = FlutterTtsService();
    await tts.speak('');
    await tts.speak('   ');
    expect(calls, isEmpty, reason: 'nothing to say ⇒ no engine traffic');
  });

  test('a platform error is swallowed (reading is never fatal)', () async {
    failOn = 'speak';
    final tts = FlutterTtsService();
    await expectLater(tts.speak('câu trả lời'), completes);

    failOn = 'setLanguage';
    final tts2 = FlutterTtsService();
    await expectLater(tts2.speak('câu trả lời'), completes,
        reason: 'a broken engine degrades to silence, never to an exception');
  });

  test('a device that answers something other than true is treated as missing',
      () async {
    // isLanguageAvailable is platform-typed `dynamic`; a null/non-bool answer
    // must NOT be read as "available" (fail-safe direction).
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(channel, (call) async {
      calls.add(call.method);
      if (call.method == 'isLanguageAvailable') return null;
      return null;
    });
    final tts = FlutterTtsService();
    await tts.speak('câu trả lời');
    expect(calls.contains('speak'), isFalse);
  });

  test('stop() is safe when nothing is speaking / engine is broken', () async {
    failOn = 'stop';
    final tts = FlutterTtsService();
    await expectLater(tts.stop(), completes);
  });
}
