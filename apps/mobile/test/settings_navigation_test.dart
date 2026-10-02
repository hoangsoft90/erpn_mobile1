import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';
import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/app/router/app_router.dart';
import 'package:erpn_mobile/core/constants/app_constants.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/settings/presentation/screens/settings_screen.dart';
/// Review gap (2026-09-17): the other tests pump `MaterialApp(home:)` (no
/// GoRouter) or the SettingsScreen directly, so the ⚙️ button and the
/// `/settings` route registration were NEVER exercised on the wire. This test
/// drives the REAL `appRouter`.
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
    if (invocation.memberName == #remove && args.length == 1) {
      store.remove(args.first as String);
      return Future<bool>.value(true);
    }
    return null;
  }
}
class _NeverCalledAdapter implements HttpClientAdapter {
  @override
  void close({bool force = false}) {}
  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<List<int>>? requestStream,
    Future<void>? cancelFuture,
  ) =>
      throw UnimplementedError('no request expected in this test');
}
void main() {
  // `appRouter` is a GLOBAL GoRouter instance shared by every test in this
  // process: a test that navigates (e.g. to /settings) LEAVES it there for the
  // next test — initialLocation only applies on first build. Reset before each
  // test so every test really starts on the chat screen.
  setUp(() {
    appRouter.go('/chat');
  });
  testWidgets('⚙️ on the chat screen opens Settings through the real router',
      (WidgetTester tester) async {
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(_FakePrefs()),
          copilotApiClientProvider.overrideWithValue(
            CopilotApiClient(
              dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
                ..httpClientAdapter = _NeverCalledAdapter(),
            ),
          ),
        ],
        child: MaterialApp.router(routerConfig: appRouter),
      ),
    );
    await tester.pumpAndSettle();
    // Chat screen is the initial route, with the gear affordance.
    expect(find.byIcon(Icons.settings_outlined), findsOneWidget);
    await tester.tap(find.byIcon(Icons.settings_outlined));
    await tester.pumpAndSettle();
    // Route actually resolved to the Settings screen (not an error screen).
    expect(find.byType(SettingsScreen), findsOneWidget);
    expect(find.text('Cài đặt'), findsOneWidget);
    expect(find.text('Gateway URL'), findsOneWidget);
    expect(find.text('Số tin nhắn tối đa'), findsOneWidget);
  });
  testWidgets(
      'the chat footer shows the URL saved in Settings immediately after Save',
      (WidgetTester tester) async {
    // Review gap found by the user (2026-09-17): the footer read only the
    // static dart-define value, so a successfully saved URL never showed up
    // after coming back from Settings. Regression: it must show the SAVED url,
    // not the compiled one.
    await tester.pumpWidget(
      ProviderScope(
        overrides: [
          sharedPreferencesProvider.overrideWithValue(_FakePrefs()),
          copilotApiClientProvider.overrideWithValue(
            CopilotApiClient(
              dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
                ..httpClientAdapter = _NeverCalledAdapter(),
            ),
          ),
        ],
        child: MaterialApp.router(routerConfig: appRouter),
      ),
    );
    await tester.pumpAndSettle();
    // The Settings form is a LAZY ListView taller than the default 800x600
    // test viewport: anything below the fold is never built, so finders miss
    // it (this test used to scroll into view and silently miss Save).
    tester.view.physicalSize = const Size(1000, 2400);
    tester.view.devicePixelRatio = 1.0;
    addTearDown(tester.view.reset);
    await tester.pumpAndSettle();
    // Before: footer shows the compiled default.
    expect(find.textContaining('COPILOT_BASE_URL:'), findsOneWidget);
    expect(
      find.textContaining(AppConstants.defaultCopilotBaseUrl),
      findsOneWidget,
    );
    // Open Settings, enter a new URL, Save.
    await tester.tap(find.byIcon(Icons.settings_outlined));
    await tester.pumpAndSettle();
    await tester.enterText(
      find.widgetWithText(TextFormField, 'Gateway URL'),
      'https://erpn8788.loca.lt',
    );
    await tester.ensureVisible(find.text('Lưu'));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Lưu'));
    await tester.pumpAndSettle();
    // Back to chat (system back) — the footer must show the SAVED url now.
    final navigator = tester.state<NavigatorState>(find.byType(Navigator));
    navigator.pop();
    await tester.pumpAndSettle();
    expect(
      find.textContaining('COPILOT_BASE_URL: https://erpn8788.loca.lt'),
      findsOneWidget,
      reason: 'the saved URL must be what the footer shows, not the stale '
          'dart-define value',
    );
    expect(
      find.textContaining(AppConstants.defaultCopilotBaseUrl),
      findsNothing,
    );
  });
}
