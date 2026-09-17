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
  final Map<String, Object> store = {};

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
      await tester.pumpWidget(
        ProviderScope(
          overrides: [sharedPreferencesProvider.overrideWithValue(prefs)],
          child: const MaterialApp(home: SettingsScreen()),
        ),
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

    testWidgets('invalid URL blocks save; the field shows the error',
        (tester) async {
      final prefs = _FakePrefs();
      await pump(tester, prefs);

      await tester.enterText(find.byType(TextFormField).first, 'nonsense');
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

      await tester.tap(find.text('Lưu'));
      await tester.pumpAndSettle();

      expect(prefs.store[AppConstants.gatewayBaseUrlStorageKey],
          'https://erpn8788.loca.lt');
      expect(prefs.store[AppConstants.gatewayAuthUserStorageKey], 'admin');
      expect(prefs.store[AppConstants.gatewayAuthPasswordStorageKey], 'secret');
      expect(prefs.store[AppConstants.maxChatItemsStorageKey], 30);
      expect(find.textContaining('Đã lưu'), findsOneWidget);
    });
  });
}
