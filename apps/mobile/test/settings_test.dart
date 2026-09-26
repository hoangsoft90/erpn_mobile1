import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/core/constants/app_constants.dart';
import 'package:erpn_mobile/core/settings/app_settings_service.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/settings/presentation/screens/settings_screen.dart';

class _FakePrefs implements SharedPreferences {
  _FakePrefs({this.failBoolWrites = false});

  final Map<String, Object> store = {};

  /// Storage that accepts strings but refuses bools — a partial write failure.
  /// The Save button must not report success when part of it did not persist.
  final bool failBoolWrites;

  @override
  dynamic noSuchMethod(Invocation invocation) {
    final args = invocation.positionalArguments;
    if (invocation.memberName == #getString && args.length == 1) {
      return store[args.first as String];
    }
    if (invocation.memberName == #getInt && args.length == 1) {
      return store[args.first as String] as int?;
    }
    if (invocation.memberName == #setString && args.length == 2) {
      store[args[0] as String] = args[1] as Object;
      return Future<bool>.value(true);
    }
    if (invocation.memberName == #setInt && args.length == 2) {
      store[args[0] as String] = args[1] as Object;
      return Future<bool>.value(true);
    }
    if (invocation.memberName == #getBool && args.length == 1) {
      return store[args.first as String] as bool?;
    }
    if (invocation.memberName == #setBool && args.length == 2) {
      if (failBoolWrites) throw StateError('bool write refused');
      store[args[0] as String] = args[1] as Object;
      return Future<bool>.value(true);
    }
    if (invocation.memberName == #remove && args.length == 1) {
      store.remove(args.first as String);
      return Future<bool>.value(true);
    }
    return null;
  }
}

class _MockAdapter implements HttpClientAdapter {
  _MockAdapter(this.handler);
  final Future<ResponseBody> Function(RequestOptions options) handler;

  /// Every request URI the client actually sent — lets a test assert the URL
  /// the app called without rebuilding anything.
  final List<Uri> requests = [];

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) {
    requests.add(options.uri);
    return handler(options);
  }
}

ResponseBody _okAnswer() => ResponseBody.fromString(
      jsonEncode({
        'ok': true,
        'result': {'question': 'q', 'answer': 'a'},
      }),
      200,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

void main() {
  group('AppSettingsService', () {
    test('defaults when nothing was ever saved', () {
      final s = AppSettingsService(prefs: _FakePrefs());
      expect(s.gatewayBaseUrl, isEmpty, reason: 'empty ⇒ caller falls back');
      expect(s.gatewayAuthUser, isEmpty);
      expect(s.gatewayAuthPassword, isEmpty);
      expect(s.maxChatItems, AppConstants.defaultMaxChatItems);
      expect(s.gatewayBaseUrlOrDefault, AppConstants.defaultGatewayBaseUrl);
    });

    test('null prefs (storage unavailable) still returns defaults', () {
      final s = AppSettingsService(prefs: null);
      expect(s.maxChatItems, AppConstants.defaultMaxChatItems);
      expect(s.gatewayBaseUrl, isEmpty);
    });

    test('saveGateway round-trips and rejects an invalid URL (fail-closed)',
        () async {
      final s = AppSettingsService(prefs: _FakePrefs());
      expect(await s.saveGateway(baseUrl: 'not a url', authUser: 'u', authPassword: 'p'),
          isFalse);
      expect(s.gatewayBaseUrl, isEmpty, reason: 'invalid input never stored');

      expect(
        await s.saveGateway(
          baseUrl: 'https://new.example:8788/',
          authUser: ' u ',
          authPassword: 'p',
        ),
        isTrue,
      );
      expect(s.gatewayBaseUrl, 'https://new.example:8788/');
      expect(s.gatewayAuthUser, 'u', reason: 'trimmed');
      expect(s.gatewayAuthPassword, 'p');
      expect(s.gatewayBaseUrlOrDefault, 'https://new.example:8788/');
    });

    test('maxChatItems is clamped to the floor, on read and on write', () async {
      final prefs = _FakePrefs();
      final s = AppSettingsService(prefs: prefs);
      expect(await s.saveMaxChatItems(2), AppConstants.minMaxChatItems);
      expect(s.maxChatItems, AppConstants.minMaxChatItems);
      // A hand-edited (too small) stored value is clamped on READ too.
      await prefs.setInt(AppConstants.maxChatItemsStorageKey, 1);
      expect(s.maxChatItems, AppConstants.minMaxChatItems);
      expect(await s.saveMaxChatItems(50), 50);
      expect(s.maxChatItems, 50);
    });

    test('allowSubmitPayment defaults OFF (absent key / null prefs / corrupted storage)', () async {
      final s = AppSettingsService(prefs: _FakePrefs());
      expect(s.allowSubmitPayment, isFalse,
          reason: 'the risky capability is never on by accident');
      expect(AppSettingsService(prefs: null).allowSubmitPayment, isFalse);
    });

    test('allowSubmitPayment round-trips ON and back OFF', () async {
      final prefs = _FakePrefs();
      final s = AppSettingsService(prefs: prefs);
      expect(await s.saveAllowSubmitPayment(true), isTrue);
      expect(prefs.store[AppConstants.allowSubmitPaymentStorageKey], true);
      expect(AppSettingsService(prefs: prefs).allowSubmitPayment, isTrue,
          reason: 'a NEW service instance reads it back (settings screen recreate)');
      expect(await s.saveAllowSubmitPayment(false), isTrue);
      expect(AppSettingsService(prefs: prefs).allowSubmitPayment, isFalse);
    });

    test('voiceAutoSend defaults OFF (absent key / null prefs)', () {
      expect(AppSettingsService(prefs: _FakePrefs()).voiceAutoSend, isFalse,
          reason: 'dictation must never send by accident');
      expect(AppSettingsService(prefs: null).voiceAutoSend, isFalse);
    });

    test('voiceAutoSend round-trips ON and back OFF', () async {
      final prefs = _FakePrefs();
      final s = AppSettingsService(prefs: prefs);
      expect(await s.saveVoiceAutoSend(true), isTrue);
      expect(prefs.store[AppConstants.voiceAutoSendStorageKey], true);
      expect(AppSettingsService(prefs: prefs).voiceAutoSend, isTrue,
          reason: 'a NEW instance reads it back (screen recreate)');
      expect(await s.saveVoiceAutoSend(false), isTrue);
      expect(AppSettingsService(prefs: prefs).voiceAutoSend, isFalse);
    });

    test('voiceAutoSend tolerates corrupted storage (fail-safe OFF)', () async {
      final prefs = _FakePrefs();
      // A wrong TYPE in the same key: the getter must not throw.
      prefs.store[AppConstants.voiceAutoSendStorageKey] = 'yes';
      expect(AppSettingsService(prefs: prefs).voiceAutoSend, isFalse);
    });

    test('ttsEnabled defaults OFF (absent key / null prefs / corrupted storage)',
        () async {
      expect(AppSettingsService(prefs: _FakePrefs()).ttsEnabled, isFalse,
          reason: 'answers are silent unless the user asked otherwise');
      expect(AppSettingsService(prefs: null).ttsEnabled, isFalse);
      final prefs = _FakePrefs();
      prefs.store[AppConstants.ttsEnabledStorageKey] = 'yes'; // wrong type
      expect(AppSettingsService(prefs: prefs).ttsEnabled, isFalse,
          reason: 'a corrupted value must not read as ON');
    });

    test('ttsEnabled round-trips ON and back OFF', () async {
      final prefs = _FakePrefs();
      final s = AppSettingsService(prefs: prefs);
      expect(await s.saveTtsEnabled(true), isTrue);
      expect(prefs.store[AppConstants.ttsEnabledStorageKey], true);
      expect(AppSettingsService(prefs: prefs).ttsEnabled, isTrue,
          reason: 'a NEW instance reads it back (screen recreate)');
      expect(await s.saveTtsEnabled(false), isTrue);
      expect(AppSettingsService(prefs: prefs).ttsEnabled, isFalse);
    });

    test('clear() forgets the TTS switch too', () async {
      final prefs = _FakePrefs();
      final s = AppSettingsService(prefs: prefs);
      await s.saveTtsEnabled(true);
      await s.clear();
      expect(prefs.store.containsKey(AppConstants.ttsEnabledStorageKey), isFalse);
      expect(AppSettingsService(prefs: prefs).ttsEnabled, isFalse);
    });

    test('isValidGatewayUrl', () {
      expect(AppSettingsService.isValidGatewayUrl('https://x.example'), isTrue);
      expect(AppSettingsService.isValidGatewayUrl('http://127.0.0.1:8788'), isTrue);
      expect(AppSettingsService.isValidGatewayUrl(''), isFalse);
      expect(AppSettingsService.isValidGatewayUrl('x.example'), isFalse);
      expect(AppSettingsService.isValidGatewayUrl('ftp://x.example'), isFalse);
      expect(AppSettingsService.isValidGatewayUrl('https://'), isFalse);
    });
  });

  group('CopilotApiClient reads settings on every request', () {
    test('saved URL and auth win over the compiled-in fallback', () async {
      final prefs = _FakePrefs();
      final settings = AppSettingsService(prefs: prefs);
      await settings.saveGateway(
        baseUrl: 'https://erpn8788.loca.lt/',
        authUser: 'user1',
        authPassword: 'pass1',
      );

      final adapter = _MockAdapter((options) async => _okAnswer());
      final dio = Dio(BaseOptions(baseUrl: 'http://compiled-fallback'))
        ..httpClientAdapter = adapter;
      final client = CopilotApiClient(
        dio: dio,
        settings: settings,
        fallbackBaseUrl: 'http://compiled-fallback',
      );

      await client.ask('q');
      expect(adapter.requests.single.toString(), 'https://erpn8788.loca.lt/ask',
          reason: 'trailing slash trimmed, saved URL used');
      expect(dio.options.headers['authorization'],
          'Basic ${base64Encode(utf8.encode('user1:pass1'))}');
    });

    test('empty settings fall back to the compiled-in URL (old APK unchanged)',
        () async {
      final adapter = _MockAdapter((options) async => _okAnswer());
      final dio = Dio(BaseOptions(baseUrl: 'http://compiled-fallback'))
        ..httpClientAdapter = adapter;
      final client = CopilotApiClient(
        dio: dio,
        settings: AppSettingsService(prefs: _FakePrefs()),
        fallbackBaseUrl: 'http://compiled-fallback',
      );

      await client.ask('q');
      expect(adapter.requests.single.toString(), 'http://compiled-fallback/ask');
    });

    test('ask() sends submit_now as told — OFF by default, ON when the caller (controller) passes the saved setting', () async {
      final prefs = _FakePrefs();
      final settings = AppSettingsService(prefs: prefs);
      final bodies = <dynamic>[];
      final adapter = _MockAdapter((options) async {
        // The client hands dio a Map (dio serialises it later), so at adapter
        // level the body may be either the Map itself or an encoded String.
        final d = options.data;
        bodies.add(d is String ? jsonDecode(d) as Map<String, dynamic> : d);
        return _okAnswer();
      });
      final dio = Dio(BaseOptions(baseUrl: 'http://mock.local'))
        ..httpClientAdapter = adapter;
      final client = CopilotApiClient(dio: dio, settings: settings);

      // Mirrors chat_controller.send(): the SETTING is read at ask time and
      // passed explicitly — the flag on the wire is the value the user's
      // setting held when THIS question was asked.
      await client.ask('q', submitNow: settings.allowSubmitPayment);
      expect(
        (bodies.last as Map<String, dynamic>)['submit_now'],
        isFalse,
        reason: 'default OFF is still sent explicitly (server freezes it)',
      );

      await settings.saveAllowSubmitPayment(true);
      await client.ask('q', submitNow: settings.allowSubmitPayment);
      expect(
        (bodies.last as Map<String, dynamic>)['submit_now'],
        isTrue,
        reason: 'the saved setting now travels on the wire',
      );
    });

    test('changing the URL applies IMMEDIATELY, no rebuild/restart', () async {
      final prefs = _FakePrefs();
      final settings = AppSettingsService(prefs: prefs);
      final adapter = _MockAdapter((options) async => _okAnswer());
      final dio = Dio(BaseOptions(baseUrl: 'http://compiled-fallback'))
        ..httpClientAdapter = adapter;
      final client = CopilotApiClient(dio: dio, settings: settings);

      await settings.saveGateway(
          baseUrl: 'https://first.example', authUser: '', authPassword: '');
      await client.ask('q');
      expect(adapter.requests.last.toString(), 'https://first.example/ask');

      // Same client instance — only the stored setting changes.
      await settings.saveGateway(
          baseUrl: 'https://second.example', authUser: '', authPassword: '');
      await client.ask('q');
      expect(adapter.requests.last.toString(), 'https://second.example/ask');
    });

    test('null settings keeps the pre-Settings behaviour (unit-test default)',
        () async {
      final adapter = _MockAdapter((options) async => _okAnswer());
      final dio = Dio(BaseOptions(baseUrl: 'http://mock.local'))
        ..httpClientAdapter = adapter;
      final client = CopilotApiClient(dio: dio); // no settings, no fallback
      await client.ask('q');
      expect(adapter.requests.single.toString(), 'http://mock.local/ask');
    });
  });

  group('SettingsScreen', () {
    Future<void> pump(WidgetTester tester, _FakePrefs prefs) async {
      // The form has outgrown the default 800x600 test viewport, and the body
      // is a LAZY ListView: whatever sits below the fold is never BUILT, so
      // finders miss it entirely. A taller surface keeps every control built
      // and visible — tests then tap what they mean instead of scrolling into
      // it (scroll-into-view used to silently miss the Save button).
      tester.view.physicalSize = const Size(1000, 2400);
      tester.view.devicePixelRatio = 1.0;
      addTearDown(tester.view.reset);
      await tester.pumpWidget(
        ProviderScope(
          overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
          child: const MaterialApp(home: SettingsScreen()),
        ),
      );
      await tester.pumpAndSettle();
    }

    /// Scrolls the settings ListView until [finder] exists AND is visible.
    /// `ensureVisible` is not enough: the form is a LAZY ListView, so a control
    /// below the fold has not been built at all (adding the voice section pushed
    /// the Save button out of the initial viewport).
    Future<void> scrollTo(WidgetTester tester, Finder finder) async {
      await tester.scrollUntilVisible(
        finder,
        200,
        scrollable: find.byType(Scrollable).first,
      );
      await tester.pumpAndSettle();
    }

    testWidgets('first open pre-fills the current dev tunnel', (tester) async {
      await pump(tester, _FakePrefs());
      expect(find.text(AppConstants.defaultGatewayBaseUrl), findsWidgets);
      expect(
        find.text(AppConstants.defaultMaxChatItems.toString()),
        findsOneWidget,
      );
    });

    testWidgets('F7-2: the submit switch exists and defaults OFF', (tester) async {
      final prefs = _FakePrefs();
      await pump(tester, prefs);
      expect(find.text('Cho phép nộp (submit) Payment Entry trên ERPNext'), findsOneWidget);
      expect(find.textContaining('TẮT: xác nhận'), findsOneWidget);
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isFalse,
      );
      expect(prefs.store.containsKey(AppConstants.allowSubmitPaymentStorageKey),
          isFalse, reason: 'nothing persisted until Save');
    });

    testWidgets('F7-2: turning ON requires the explicit dialog; Huỷ keeps OFF',
        (tester) async {
      final prefs = _FakePrefs();
      await pump(tester, prefs);
      await tester.tap(find.text('Cho phép nộp (submit) Payment Entry trên ERPNext'));
      await tester.pumpAndSettle();
      // The dialog is really there — a tap alone never enables the switch.
      expect(find.text('Cho phép nộp (submit) Payment Entry trên ERPNext?'), findsOneWidget);
      await tester.tap(find.text('Huỷ'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isFalse,
        reason: 'cancel must leave the switch untouched',
      );
      expect(prefs.store.containsKey(AppConstants.allowSubmitPaymentStorageKey),
          isFalse);
    });

    testWidgets('F7-2: confirming the dialog turns the switch ON; Save persists it',
        (tester) async {
      final prefs = _FakePrefs();
      await pump(tester, prefs);
      await scrollTo(tester, find.text('Cho phép nộp (submit) Payment Entry trên ERPNext'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cho phép nộp (submit) Payment Entry trên ERPNext'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Bật nộp phiếu thật'));
      await tester.pumpAndSettle();
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isTrue,
      );
      expect(find.textContaining('ĐANG BẬT: xác nhận'), findsOneWidget);
      await scrollTo(tester, find.text('Lưu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();
      expect(prefs.store[AppConstants.allowSubmitPaymentStorageKey], true);
    });

    testWidgets('F7-2: turning OFF needs no dialog and Save persists OFF',
        (tester) async {
      final prefs = _FakePrefs();
      await prefs.setBool(AppConstants.allowSubmitPaymentStorageKey, true);
      await pump(tester, prefs);
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isTrue,
        reason: 'a previously saved ON is restored on open',
      );
      await scrollTo(tester, find.text('Cho phép nộp (submit) Payment Entry trên ERPNext'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Cho phép nộp (submit) Payment Entry trên ERPNext'));
      await tester.pumpAndSettle();
      expect(find.text('Cho phép nộp (submit) Payment Entry trên ERPNext?'), findsNothing,
          reason: 'the safe direction never asks');
      expect(
        tester.widget<CheckboxListTile>(find.byType(CheckboxListTile)).value,
        isFalse,
      );
      await scrollTo(tester, find.text('Lưu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();
      expect(prefs.store[AppConstants.allowSubmitPaymentStorageKey], false);
    });

    testWidgets('P6 UX: the voice auto-send switch exists and defaults OFF',
        (tester) async {
      final prefs = _FakePrefs();
      await pump(tester, prefs);
      await scrollTo(tester, find.text('Tự gửi sau khi nói xong'));
      expect(find.text('Tự gửi sau khi nói xong'), findsOneWidget);
      // Anchored on the title: the screen now has more than one SwitchListTile
      // (voice auto-send + "Đọc câu trả lời"), so find.byType would be ambiguous.
      final sw = tester.widget<SwitchListTile>(
          find.widgetWithText(SwitchListTile, 'Tự gửi sau khi nói xong'));
      expect(sw.value, isFalse);
      expect(find.textContaining('TẮT: đọc xong'), findsOneWidget);
      expect(prefs.store.containsKey(AppConstants.voiceAutoSendStorageKey),
          isFalse, reason: 'nothing persisted until Save');
    });

    testWidgets('P6 UX: turning the voice switch ON needs no dialog and persists',
        (tester) async {
      final prefs = _FakePrefs();
      await pump(tester, prefs);
      await scrollTo(tester, find.text('Tự gửi sau khi nói xong'));
      await tester.pumpAndSettle();
      // No confirmation dialog: it only changes WHEN the client sends text the
      // user just spoke — it cannot confirm a proposal or reach /execute.
      await tester.tap(find.text('Tự gửi sau khi nói xong'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(
        tester
            .widget<SwitchListTile>(find.widgetWithText(
                SwitchListTile, 'Tự gửi sau khi nói xong'))
            .value,
        isTrue,
      );
      expect(find.textContaining('ĐANG BẬT: đọc xong'), findsOneWidget);
      expect(find.textContaining('vẫn phải bấm Xác nhận'), findsOneWidget,
          reason: 'the copy must say a payment still needs its own tap');

      await scrollTo(tester, find.text('Lưu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();
      expect(prefs.store[AppConstants.voiceAutoSendStorageKey], true);
      expect(
        AppSettingsService(prefs: prefs).voiceAutoSend,
        isTrue,
        reason: 'the chat screen reads it live on the next final result',
      );
    });

    testWidgets(
        'a switch that did not persist is reported, never called success',
        (tester) async {
      // Gateway (string) writes succeed, the switch (bool) write fails — the
      // old code only looked at the gateway result and said "Đã lưu" while the
      // switch was silently not stored (review 2026-09-18).
      final prefs = _FakePrefs(failBoolWrites: true);
      await pump(tester, prefs);
      await scrollTo(tester, find.text('Tự gửi sau khi nói xong'));
      await tester.tap(find.text('Tự gửi sau khi nói xong'));
      await tester.pumpAndSettle();

      await scrollTo(tester, find.text('Lưu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();

      expect(find.textContaining('Không lưu được cài đặt'), findsOneWidget);
      expect(find.textContaining('Đã lưu —'), findsNothing);
      expect(AppSettingsService(prefs: prefs).voiceAutoSend, isFalse,
          reason: 'nothing was stored ⇒ the app must not behave as ON');
    });

    testWidgets('TTS: the read-aloud switch exists, defaults OFF, nothing saved yet',
        (tester) async {
      final prefs = _FakePrefs();
      await pump(tester, prefs);
      await scrollTo(tester, find.text('Đọc câu trả lời'));
      expect(find.text('Đọc câu trả lời'), findsOneWidget);
      final sw = tester.widget<SwitchListTile>(
          find.widgetWithText(SwitchListTile, 'Đọc câu trả lời'));
      expect(sw.value, isFalse);
      expect(find.textContaining('TẮT: chỉ hiển thị'), findsOneWidget);
      expect(find.textContaining('gói tiếng Việt'), findsOneWidget,
          reason: 'the note explains why nothing is read on a bare device');
      expect(prefs.store.containsKey(AppConstants.ttsEnabledStorageKey), isFalse,
          reason: 'nothing persisted until Save');
    });

    testWidgets('TTS: turning it ON needs no dialog and Save persists it',
        (tester) async {
      final prefs = _FakePrefs();
      await pump(tester, prefs);
      await scrollTo(tester, find.text('Đọc câu trả lời'));
      await tester.pumpAndSettle();
      // No confirmation dialog: reading an answer aloud cannot confirm or
      // execute anything (unlike the submit switch, which does).
      await tester.tap(find.text('Đọc câu trả lời'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(
        tester
            .widget<SwitchListTile>(
                find.widgetWithText(SwitchListTile, 'Đọc câu trả lời'))
            .value,
        isTrue,
      );
      // Anchored on the TTS-ONLY sentence. The tempting phrase "vẫn phải bấm
      // Xác nhận khi thu tiền" is NOT unique: the voice switch's ON copy uses it
      // too, so asserting findsOneWidget on it only passes while that other
      // switch happens to be OFF (measured: 2 matches once both are ON). A test
      // whose uniqueness depends on another control's state is a latent flake.
      expect(
        find.textContaining('ĐANG BẬT: câu trả lời mới sẽ được đọc to'),
        findsOneWidget,
        reason: 'reading a proposal aloud must not look like confirming it',
      );

      await scrollTo(tester, find.text('Lưu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();
      expect(prefs.store[AppConstants.ttsEnabledStorageKey], true);
      expect(AppSettingsService(prefs: prefs).ttsEnabled, isTrue,
          reason: 'the controller reads it live on the next new turn');
    });

    testWidgets('invalid URL blocks save; the field shows the error',
        (tester) async {
      final prefs = _FakePrefs();
      await pump(tester, prefs);

      await tester.enterText(find.byType(TextFormField).first, 'nonsense');
      // The new F7-2 section pushed the Save button below the test viewport —
      // a bare tap() misses (silently), which made this test fail for the
      // wrong reason. Scroll it into view first.
      await scrollTo(tester, find.text('Lưu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();

      expect(find.textContaining('URL không hợp lệ'), findsOneWidget);
      expect(prefs.store.containsKey(AppConstants.gatewayBaseUrlStorageKey),
          isFalse);
    });

    testWidgets('max below the floor is BLOCKED before any write',
        (tester) async {
      final prefs = _FakePrefs();
      await pump(tester, prefs);

      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), 'https://erpn8788.loca.lt');
      await tester.enterText(fields.at(3), '3'); // below floor (5)

      await scrollTo(tester, find.text('Lưu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();

      expect(find.text('Tối thiểu ${AppConstants.minMaxChatItems}'),
          findsOneWidget);
      expect(prefs.store.containsKey(AppConstants.maxChatItemsStorageKey),
          isFalse,
          reason: 'validator blocks the save; nothing is persisted');
    });

    testWidgets('save persists URL/auth/max', (tester) async {
      final prefs = _FakePrefs();
      await pump(tester, prefs);

      final fields = find.byType(TextFormField);
      await tester.enterText(fields.at(0), 'https://erpn8788.loca.lt');
      await tester.enterText(fields.at(1), 'admin');
      await tester.enterText(fields.at(2), 'secret');
      await tester.enterText(fields.at(3), '30');

      await scrollTo(tester, find.text('Lưu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();

      expect(prefs.store[AppConstants.gatewayBaseUrlStorageKey],
          'https://erpn8788.loca.lt');
      expect(prefs.store[AppConstants.gatewayAuthUserStorageKey], 'admin');
      expect(prefs.store[AppConstants.gatewayAuthPasswordStorageKey], 'secret');
      expect(prefs.store[AppConstants.maxChatItemsStorageKey], 30);
      expect(find.textContaining('Đã lưu'), findsOneWidget);
    });

    testWidgets('D4: switching the gateway CLEARS the drawer day cache',
        (tester) async {
      // review6 / §2.4 — "đổi company/user trong Settings → clear state/cache
      // mọi list drawer". A different gateway is a different set of books: a day
      // cached from the old one must not open the drawer as if it were the new
      // one's numbers.
      final prefs = _FakePrefs();
      await prefs.setString(AppConstants.gatewayBaseUrlStorageKey, 'https://old.example');
      await prefs.setString(
        AppConstants.dailySummaryCacheStorageKey,
        '{"fetched_at":"2026-09-25T00:00:00.000Z","body":"{}"}',
      );
      await pump(tester, prefs);
      expect(prefs.store.containsKey(AppConstants.dailySummaryCacheStorageKey), isTrue,
          reason: 'precondition: the drawer had a cached day from the old server');

      await tester.enterText(find.byType(TextFormField).first, 'https://new.example');
      await scrollTo(tester, find.text('Lưu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();

      expect(prefs.store[AppConstants.gatewayBaseUrlStorageKey], 'https://new.example');
      expect(prefs.store.containsKey(AppConstants.dailySummaryCacheStorageKey), isFalse,
          reason: 'another server is another set of books — the cached day must not survive');
    });

    testWidgets('D4: switching the ACCOUNT alone also clears the day cache',
        (tester) async {
      final prefs = _FakePrefs();
      await prefs.setString(AppConstants.gatewayBaseUrlStorageKey, 'https://erpn8788.loca.lt');
      await prefs.setString(AppConstants.gatewayAuthUserStorageKey, 'user1');
      await prefs.setString(
        AppConstants.dailySummaryCacheStorageKey,
        '{"fetched_at":"2026-09-25T00:00:00.000Z","body":"{}"}',
      );
      await pump(tester, prefs);

      // URL untouched; only the login changes.
      await tester.enterText(find.byType(TextFormField).at(1), 'user2');
      await scrollTo(tester, find.text('Lưu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();

      expect(prefs.store[AppConstants.gatewayAuthUserStorageKey], 'user2');
      expect(prefs.store.containsKey(AppConstants.dailySummaryCacheStorageKey), isFalse,
          reason: 'another account may be scoped to other companies (COPILOT_USERS / User Permission)');
    });

    testWidgets('D4: saving the SAME server and account keeps the cached day (no pointless clear)',
        (tester) async {
      final prefs = _FakePrefs();
      await prefs.setString(AppConstants.gatewayBaseUrlStorageKey, 'https://erpn8788.loca.lt');
      await prefs.setString(AppConstants.gatewayAuthUserStorageKey, 'user1');
      await prefs.setString(
        AppConstants.dailySummaryCacheStorageKey,
        '{"fetched_at":"2026-09-25T00:00:00.000Z","body":"{}"}',
      );
      await pump(tester, prefs);

      // Only the chat-history cap changes; the drawer's day still belongs to
      // this very server.
      await tester.enterText(find.byType(TextFormField).at(3), '30');
      await scrollTo(tester, find.text('Lưu'));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();

      expect(prefs.store.containsKey(AppConstants.dailySummaryCacheStorageKey), isTrue,
          reason: 'an unrelated setting must not throw away a valid read');
    });
  });
}
