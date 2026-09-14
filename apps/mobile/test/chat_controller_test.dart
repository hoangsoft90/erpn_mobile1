import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/chat/presentation/screens/chat_screen.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/chat_bubble.dart';

typedef Handler = Future<ResponseBody> Function(RequestOptions options);

class _MockAdapter implements HttpClientAdapter {
  _MockAdapter(this.handler);
  final Handler handler;

  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) =>
      handler(options);
}

ResponseBody _json(Object body, [int status = 200]) => ResponseBody.fromString(
      jsonEncode(body),
      status,
      headers: {
        Headers.contentTypeHeader: [Headers.jsonContentType],
      },
    );

const _answerResult = {
  'question': 'chị Lan còn nợ bao nhiêu',
  'normalized': {'text': 'Lan còn nợ bao nhiêu'},
  'routed': {'group': 'customer', 'matched': 'còn nợ'},
  'customer': {'id': 'CUST-001', 'name': 'Nguyễn Thị Lan'},
  'outstanding_vnd': 2500000,
  'open_invoices': 1,
  'answer': 'Nguyễn Thị Lan còn nợ 2.500.000đ (1 hóa đơn chưa trả).',
};

Future<void> _pumpApp(
  WidgetTester tester, {
  required Handler handler,
  SharedPreferences? prefs,
}) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter(handler),
          ),
        ),
      ],
      child: const MaterialApp(home: ChatScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('empty state shows example hint', (WidgetTester tester) async {
    await _pumpApp(tester, handler: (options) async => _json({'ok': true}));
    expect(find.textContaining('chị Lan còn nợ bao nhiêu'), findsOneWidget);
    expect(find.byType(ChatBubble), findsNothing);
  });

  testWidgets('send -> answer bubble + route label + input cleared',
      (WidgetTester tester) async {
    await _pumpApp(
      tester,
      handler: (options) async => _json({'ok': true, 'result': _answerResult}),
    );

    await tester.enterText(find.byType(TextField), 'chị Lan còn nợ bao nhiêu');
    await tester.tap(find.byIcon(Icons.send));
    await tester.pumpAndSettle();

    expect(
      find.text('Nguyễn Thị Lan còn nợ 2.500.000đ (1 hóa đơn chưa trả).'),
      findsOneWidget,
    );
    expect(find.text('route: customer'), findsOneWidget);
    // user bubble shows the question
    expect(find.text('chị Lan còn nợ bao nhiêu'), findsOneWidget);
    // input cleared after success
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.controller!.text, isEmpty);
  });

  testWidgets('server failure -> SnackBar + typed text kept',
      (WidgetTester tester) async {
    await _pumpApp(
      tester,
      handler: (options) async =>
          _json({'ok': false, 'error': 'missing required field: text'}, 400),
    );

    await tester.enterText(find.byType(TextField), 'câu hỏi bị lỗi');
    await tester.tap(find.byIcon(Icons.send));
    await tester.pump(); // request + state change
    await tester.pump(const Duration(milliseconds: 600)); // snackbar entrance

    expect(find.byType(SnackBar), findsOneWidget);
    expect(find.text('missing required field: text'), findsOneWidget);
    // typed text kept on failure (tasks.md 2.5)
    final field = tester.widget<TextField>(find.byType(TextField));
    expect(field.controller!.text, 'câu hỏi bị lỗi');
  });

  testWidgets('history restored from prefs and clear works',
      (WidgetTester tester) async {
    final prefs = _FakePrefs();
    await prefs.setString('chat_history_v1', jsonEncode([
      {
        'question': 'câu hỏi cũ',
        'answer': 'câu trả lời cũ',
        'ok': true,
        'ts': '2026-09-14T10:00:00.000',
        'routed_group': 'customer',
      }
    ]));

    await _pumpApp(tester, handler: (options) async => _json({'ok': true}), prefs: prefs);
    expect(find.text('câu trả lời cũ'), findsOneWidget);

    // clear via dialog
    await tester.tap(find.byIcon(Icons.delete_outline));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Xóa'));
    await tester.pumpAndSettle();
    expect(find.text('câu trả lời cũ'), findsNothing);
    expect(prefs.store.containsKey('chat_history_v1'), isFalse);
  });
}

/// Minimal SharedPreferences fake (no plugin channel in unit tests).
class _FakePrefs implements SharedPreferences {
  final Map<String, Object> store = {};

  @override
  dynamic noSuchMethod(Invocation invocation) {
    if (invocation.memberName == #getString &&
        invocation.positionalArguments.length == 1) {
      return store[invocation.positionalArguments.first as String];
    }
    if (invocation.memberName == #setString &&
        invocation.positionalArguments.length == 2) {
      store[invocation.positionalArguments[0] as String] =
          invocation.positionalArguments[1] as Object;
      return Future<bool>.value(true);
    }
    if (invocation.memberName == #remove &&
        invocation.positionalArguments.length == 1) {
      store.remove(invocation.positionalArguments.first as String);
      return Future<bool>.value(true);
    }
    return null; // unimplemented members return null like mocks would
  }
}
