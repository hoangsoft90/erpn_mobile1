import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/app/router/app_router.dart';
import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';

/// A1 (plan3 Trụ A) — UX-READ drill-down. The properties these tests defend:
///
///  1. **The SERVER decides.** A button exists only when the answer carried a
///     UI intent built from the capability contract; the client never decides
///     that a question was a "debt question".
///  2. **The screen is a FRESH read.** Tapping issues ONE `/read/list` for the
///     server-named screen + entity, so the list is current instead of a
///     re-render of the answer.
///  3. **No write path.** The drill-down performs no `/execute` request, ever —
///     the oracle is the request log of the Dio the client actually uses.
///  4. **An honest list.** A capped list says how many documents exist; a
///     refusal shows the server's words and can be retried; `/read` without an
///     intent refuses instead of rendering an empty (misleading) list.
///
/// The intent survives history restore too, so the button is still there after
/// an app restart.

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

/// The `/ask` answer for a debt question, with the server's UI intent.
Map<String, dynamic> _balanceAnswer({bool withUi = true}) => {
      'question': 'chị Lan còn nợ bao nhiêu',
      'normalized': {'text': 'Lan còn nợ bao nhiêu'},
      'routed': {'group': 'customer', 'matched': 'còn nợ'},
      'answer': 'Nguyễn Thị Lan còn nợ 2.500.000đ (1 chứng từ chưa thanh toán).',
      'customer': {'id': 'CUST-00001', 'name': 'Nguyễn Thị Lan'},
      'outstanding_vnd': 2500000,
      'open_invoices': 1,
      if (withUi)
        'ui': {
          'screen': 'customer_account',
          'title': 'Công nợ & chứng từ',
          'entity': {
            'kind': 'customer',
            'id': 'CUST-00001',
            'name': 'Nguyễn Thị Lan',
          },
          'limit': 5,
        },
    };

/// Answers `/ask` with [askResult] and `/read/list` with [readResult], recording
/// every request path + body so "no write happened" is observable.
class _Router {
  _Router({Map<String, dynamic>? askResult})
      : askResult = askResult ?? _balanceAnswer();

  final List<String> paths = [];
  final List<Map<String, dynamic>> bodies = [];

  final Map<String, dynamic> askResult;

  /// Set per test to make `/read/list` refuse (envelope + status).
  Map<String, dynamic>? readResult;
  int readStatus = 200;

  int calls(String path) => paths.where((p) => p == path).length;

  Handler get handler => (options) async {
        final raw = options.data;
        final body = raw is String
            ? jsonDecode(raw) as Map<String, dynamic>
            : (raw as Map<String, dynamic>? ?? const {});
        paths.add(options.path);
        bodies.add(body);
        if (options.path == '/read/list') {
          final err = readResult;
          if (err != null) return _json(err, readStatus);
          return _json({
            'ok': true,
            'result': {
              'screen': 'customer_account',
              'title': 'Công nợ & chứng từ',
              'entity': {
                'kind': 'customer',
                'id': 'CUST-00001',
                'name': 'Nguyễn Thị Lan',
              },
              'limit': 5,
              // The server sends provenance with every READ payload; only `REAL`
              // is rendered (§2.1). Without it the screen must hide figures.
              'erp_target': 'REAL',
              'generated_at': '2026-09-20T10:00:00.000Z',
              'summary': {'outstanding_vnd': 2500000, 'open_documents': 1},
              'total_documents': 1,
              'truncated': false,
              'rows': [
                {
                  'name': 'SINV-0001',
                  'date': '2026-09-01',
                  'outstanding_vnd': 2500000,
                  'total_vnd': 10500000,
                  'is_return': false,
                },
              ],
            },
          });
        }
        return _json({'ok': true, 'result': askResult});
      };
}

class _FakePrefs implements SharedPreferences {
  final Map<String, Object> store = {};

  @override
  dynamic noSuchMethod(Invocation invocation) {
    if (invocation.memberName == #getString) {
      return store[invocation.positionalArguments.first as String];
    }
    if (invocation.memberName == #setString) {
      store[invocation.positionalArguments[0] as String] =
          invocation.positionalArguments[1] as Object;
      return Future<bool>.value(true);
    }
    if (invocation.memberName == #remove) {
      store.remove(invocation.positionalArguments.first as String);
      return Future<bool>.value(true);
    }
    return null;
  }
}

/// Boots the REAL app router (so the `/read` route under test is the shipped
/// one, not a copy) with the client pointed at the mock adapter.
Future<void> _pumpChat(WidgetTester tester, _Router router) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(_FakePrefs()),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter(router.handler),
          ),
        ),
      ],
      child: MaterialApp.router(routerConfig: appRouter),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _ask(WidgetTester tester, String text) async {
  await tester.enterText(find.byType(TextField), text);
  await tester.tap(find.byTooltip('Gửi'));
  await tester.pumpAndSettle();
}

/// The answer text lives in Markdown spans, not in `Text.data`.
Finder _textIn(String needle) =>
    find.textContaining(needle, findRichText: true);

Finder get _drillDown => find.text('Xem công nợ & chứng từ');

void main() {
  setUp(() {
    // The app router is a singleton: a test that navigated must not leak its
    // location into the next one.
    appRouter.go('/chat');
  });

  testWidgets('the button appears ONLY for an answer the server gave a screen',
      (tester) async {
    final withUi = _Router();
    await _pumpChat(tester, withUi);
    await _ask(tester, 'chị Lan còn nợ bao nhiêu');
    expect(_drillDown, findsOneWidget,
        reason: 'the server named a screen for this answer');
    expect(withUi.calls('/ask'), 1);
    expect(withUi.calls('/read/list'), 0,
        reason: 'nothing is fetched until the user taps');

    // Same question, no `ui` block (e.g. an old server, or a capability with no
    // declared screen): no button, and the answer still shows.
    final noUi = _Router(askResult: _balanceAnswer(withUi: false));
    await _pumpChat(tester, noUi);
    await _ask(tester, 'chị Lan còn nợ bao nhiêu');
    expect(_textIn('2.500.000đ'), findsOneWidget);
    expect(_drillDown, findsNothing,
        reason: 'the client must not decide this was a debt question');
  });

  testWidgets('tapping reads the screen FRESH — one /read/list, never /execute',
      (tester) async {
    final router = _Router();
    await _pumpChat(tester, router);
    await _ask(tester, 'chị Lan còn nợ bao nhiêu');

    await tester.tap(_drillDown);
    await tester.pumpAndSettle();

    expect(router.calls('/read/list'), 1);
    expect(router.bodies.last['screen'], 'customer_account');
    expect(router.bodies.last['entity_id'], 'CUST-00001',
        reason: 'the id comes from the server-built intent');
    expect(router.bodies.last['limit'], 5);
    expect(
      router.paths.any((p) => p.contains('/execute')),
      isFalse,
      reason: 'the drill-down has no write path at all',
    );

    // The screen shows the fresh read, not the chat answer's text.
    expect(find.text('SINV-0001'), findsOneWidget);
    expect(find.text('2.500.000đ'), findsWidgets);
    expect(_textIn('Còn nợ 2.500.000đ'), findsOneWidget);
    expect(find.textContaining('chỉ để xem'), findsOneWidget);

    // Back returns to the chat, with the history intact.
    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();
    expect(_textIn('Nguyễn Thị Lan còn nợ'), findsOneWidget);
    expect(router.calls('/read/list'), 1, reason: 'going back reads nothing');
  });

  testWidgets('a MOCK read list renders NO figures — the debt number is replaced',
      (tester) async {
    final router = _Router()
      ..readResult = {
        'ok': true,
        'result': {
          'screen': 'customer_account',
          'title': 'Công nợ & chứng từ',
          'entity': {
            'kind': 'customer',
            'id': 'CUST-00001',
            'name': 'Nguyễn Thị Lan',
          },
          'limit': 5,
          'erp_target': 'MOCK',
          'summary': {'outstanding_vnd': 2500000, 'open_documents': 1},
          'total_documents': 1,
          'truncated': false,
          'rows': [
            {
              'name': 'SINV-0001',
              'date': '2026-09-01',
              'outstanding_vnd': 2500000,
              'total_vnd': 10500000,
              'is_return': false,
            },
          ],
        },
      };
    await _pumpChat(tester, router);
    await _ask(tester, 'chị Lan còn nợ bao nhiêu');
    await tester.tap(_drillDown);
    await tester.pumpAndSettle();

    expect(router.calls('/read/list'), 1,
        reason: 'the read still happens; only the rendering is refused');
    expect(_textIn('SINV-0001'), findsNothing);
    expect(_textIn('chứng từ chưa thanh toán'), findsNothing,
        reason: 'the debt summary line is a figure too — it goes with the list');
    expect(_textIn('Không hiện số liệu — máy chủ đang đọc dữ liệu giả lập'), findsOneWidget);
    expect(router.paths.any((p) => p.contains('/execute')), isFalse);
  });

  testWidgets('a capped list says how many documents exist', (tester) async {
    final router = _Router()
      ..readResult = {
        'ok': true,
        'result': {
          'screen': 'customer_account',
          'title': 'Công nợ & chứng từ',
          'entity': {
            'kind': 'customer',
            'id': 'CUST-00001',
            'name': 'Nguyễn Thị Lan',
          },
          'limit': 5,
          'erp_target': 'REAL',
          'summary': {'outstanding_vnd': 21000000, 'open_documents': 7},
          'total_documents': 7,
          'truncated': true,
          'rows': [
            for (var i = 1; i <= 5; i++)
              {
                'name': 'SINV-000$i',
                'date': '2026-09-0$i',
                'outstanding_vnd': 1000000 * i,
                'total_vnd': 1000000 * i,
                'is_return': false,
              },
          ],
        },
      };
    await _pumpChat(tester, router);
    await _ask(tester, 'chị Lan còn nợ bao nhiêu');
    await tester.tap(_drillDown);
    await tester.pumpAndSettle();

    expect(find.textContaining('Hiện 5/7 chứng từ'), findsOneWidget);
    expect(find.textContaining('Còn 2 chứng từ khác'), findsOneWidget,
        reason: 'a capped list must never look like the whole debt');
    expect(find.text('SINV-0005'), findsOneWidget);
  });

  testWidgets('a refusal shows the server words and can be retried',
      (tester) async {
    final router = _Router()
      ..readResult = {
        'ok': false,
        'code': 'CUSTOMER_NOT_FOUND',
        'error': 'không xác định được khách "CUST-99999" từ dữ liệu ERPNext',
      }
      ..readStatus = 404;
    await _pumpChat(tester, router);
    await _ask(tester, 'chị Lan còn nợ bao nhiêu');
    await tester.tap(_drillDown);
    await tester.pumpAndSettle();

    expect(find.textContaining('không xác định được khách'), findsOneWidget);
    expect(find.text('Thử lại'), findsOneWidget);

    router.readResult = null; // the retry succeeds
    router.readStatus = 200;
    await tester.tap(find.text('Thử lại'));
    await tester.pumpAndSettle();
    expect(router.calls('/read/list'), 2);
    expect(find.text('SINV-0001'), findsOneWidget);
  });

  testWidgets('/read without a server-built intent refuses instead of lying',
      (tester) async {
    final router = _Router();
    await _pumpChat(tester, router);
    await _ask(tester, 'chị Lan còn nợ bao nhiêu');
    expect(router.calls('/read/list'), 0);

    appRouter.go('/read');
    await tester.pumpAndSettle();
    expect(find.textContaining('chỉ mở được từ nút trên câu trả lời'), findsOneWidget);
    expect(router.calls('/read/list'), 0,
        reason: 'no intent ⇒ nothing is read, and no empty list is shown');
  });

  test('the intent survives history restore; a legacy turn has none', () {
    final turn = ChatTurn(
      question: 'chị Lan còn nợ bao nhiêu',
      answer: 'Nguyễn Thị Lan còn nợ 2.500.000đ',
      ok: true,
      ts: DateTime(2026, 9, 20, 10),
      routedGroup: 'customer',
      readUi: const ReadUiIntent(
        screen: 'customer_account',
        title: 'Công nợ & chứng từ',
        entityId: 'CUST-00001',
        entityName: 'Nguyễn Thị Lan',
        limit: 5,
      ),
    );
    final restored =
        ChatTurn.fromJson(jsonDecode(jsonEncode(turn.toJson())) as Map<String, dynamic>);
    expect(restored.readUi, isNotNull,
        reason: 'the button must still be there after a restart');
    expect(restored.readUi!.screen, 'customer_account');
    expect(restored.readUi!.entityId, 'CUST-00001');
    expect(restored.readUi!.limit, 5);

    // A turn stored before A1 keeps its exact old shape: no `read_ui` key, and a
    // missing key must never throw.
    final legacy = ChatTurn.fromJson(
      jsonDecode(jsonEncode({
        'question': 'q',
        'answer': 'a',
        'ok': true,
        'ts': '2026-09-01T00:00:00.000',
      })) as Map<String, dynamic>,
    );
    expect(legacy.readUi, isNull);
    expect(legacy.toJson().containsKey('read_ui'), isFalse);

    // A malformed intent parses to null (no half-built screen), never a throw.
    expect(ReadUiIntent.tryParse({'screen': 'x'}), isNull);
    expect(ReadUiIntent.tryParse({'screen': '', 'entity': {'id': 'C1'}}), isNull);
    expect(ReadUiIntent.tryParse({'screen': 'x', 'entity': {'id': '  '}}), isNull);
    expect(ReadUiIntent.tryParse('customer_account'), isNull);
  });
}
