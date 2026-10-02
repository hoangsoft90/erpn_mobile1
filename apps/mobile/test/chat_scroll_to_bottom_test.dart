import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/chat/presentation/screens/chat_screen.dart';

/// Scroll-to-bottom button on the chat list.
///
/// The properties these tests defend:
///  1. **Hidden when the list is short.** A list with nothing to scroll has
///     `maxScrollExtent == 0` and must never show the button.
///  2. **Hidden while at the bottom.** Sending scrolls to the bottom, so the
///     button is not on screen right after a turn lands.
///  3. **Shown once the user scrolls up, and it returns them to the bottom.**

const _askResult = {
  'question': 'chị Lan còn nợ bao nhiêu',
  'routed': {'group': 'customer', 'matched': 'còn nợ'},
  'customer': {'id': 'CUST-001', 'name': 'Nguyễn Thị Lan'},
  'outstanding_vnd': 2500000,
  'open_invoices': 1,
  'answer': 'Nguyễn Thị Lan còn nợ 2.500.000đ (1 chứng từ chưa thanh toán).',
};

class _MockAdapter implements HttpClientAdapter {
  @override
  void close({bool force = false}) {}

  @override
  Future<ResponseBody> fetch(
    RequestOptions options,
    Stream<Uint8List>? requestStream,
    Future<void>? cancelFuture,
  ) async =>
      ResponseBody.fromString(
        jsonEncode({'ok': true, 'result': _askResult}),
        200,
        headers: {
          Headers.contentTypeHeader: [Headers.jsonContentType],
        },
      );
}

Future<void> _pumpChat(WidgetTester tester) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(null),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter(),
          ),
        ),
      ],
      child: const MaterialApp(home: ChatScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _send(WidgetTester tester, String text) async {
  await tester.enterText(find.byType(TextField), text);
  await tester.tap(find.byTooltip('Gửi'));
  await tester.pumpAndSettle();
}

final _buttonFinder = find.byKey(const ValueKey('scroll-to-bottom'));

void main() {
  testWidgets('short list never shows the button', (tester) async {
    await _pumpChat(tester);
    await _send(tester, 'chị Lan còn nợ bao nhiêu');

    expect(_buttonFinder, findsNothing);

    // A drag on a list with nothing to scroll must not conjure the button.
    await tester.drag(find.byType(ListView), const Offset(0, 400));
    await tester.pumpAndSettle();
    expect(_buttonFinder, findsNothing);
  });

  testWidgets('button appears after scrolling up, then returns to the bottom',
      (tester) async {
    await _pumpChat(tester);
    // Enough turns to make the list scrollable on the test surface.
    for (var i = 0; i < 12; i++) {
      await _send(tester, 'câu hỏi số $i');
    }

    // Sending scrolls to the bottom ⇒ the button is not shown.
    expect(_buttonFinder, findsNothing);

    // Scroll UP (finger down) away from the newest message.
    await tester.drag(find.byType(ListView), const Offset(0, 500));
    await tester.pumpAndSettle();
    expect(_buttonFinder, findsOneWidget);

    // Tapping it jumps back to the bottom, which hides it again.
    await tester.tap(_buttonFinder);
    await tester.pumpAndSettle();
    expect(_buttonFinder, findsNothing);
  });

  testWidgets('clearing history must not leave the button stuck on a short list',
      (tester) async {
    await _pumpChat(tester);
    for (var i = 0; i < 12; i++) {
      await _send(tester, 'câu hỏi số $i');
    }

    // Scroll away from the bottom so the button is up.
    await tester.drag(find.byType(ListView), const Offset(0, 500));
    await tester.pumpAndSettle();
    expect(_buttonFinder, findsOneWidget);

    // Start a NEW conversation: the button must not survive it.
    await tester.tap(find.byTooltip('Xóa lịch sử'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Xóa'));
    await tester.pumpAndSettle();
    expect(_buttonFinder, findsNothing);

    // One short turn later there is still nothing to scroll to.
    await _send(tester, 'chị Lan còn nợ bao nhiêu');
    expect(_buttonFinder, findsNothing);
  });
}
