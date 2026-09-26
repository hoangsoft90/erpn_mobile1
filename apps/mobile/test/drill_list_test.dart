import 'dart:async';
import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/app/router/app_router.dart';
import 'package:erpn_mobile/core/constants/app_constants.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';

/// P4-4 (plan4_final §4.4) — tapping a metric on "Tóm tắt ngày" and the list it
/// opens.
///
/// The properties these tests defend:
///
///  1. **A tap sends an ID, not a question.** The request carries a fixed
///     `drill_id` from the set the server declared — the screen never invents
///     one and never sends text (§4.4 forbids free text as the default way to
///     pick a capability). Clicking a tap-derived route also must not put the
///     line through the chat pipeline.
///  2. **No write path.** Opening a list makes ONE `/read/drill` request and zero
///     `/execute` requests — asserted on the request log, not on the absence of a
///     visible button.
///  3. **A refusal is a refusal.** An unreadable drill (unknown id, denied
///     account, ERPNext down) shows the server's reason with a retry — it must
///     never look like "no documents today".
///  4. **A capped list says how many exist**, and an empty list is stated as an
///     answer (the server read the day and found nothing).
///  5. **`/drill` cannot be opened without an intent** (fail-closed route).
///
/// The screens are reached through the SHIPPED router, so the route under test
/// is the real one.

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

/// A day with nothing in it: enough for the summary screen to render its cards
/// (the drill entry points) without pretending the numbers matter here.
Map<String, dynamic> dayPayload() => {
      'ok': true,
      'meta': {
        'date': '2026-09-21',
        'timezone': 'Asia/Ho_Chi_Minh',
        'generated_at': '2026-09-21T08:30:00+07:00',
        'source': 'real',
        'erp_target': 'REAL',
        'company': 'Minh Phát Cám & VLXD',
        'partial': false,
        'errors': <Object>[],
      },
      'sales_orders': {
        'submitted': {'count': 0, 'amount': 0},
        'draft': {'count': 0, 'amount': 0},
      },
      'sales_invoices': {'count': 0, 'amount': 0, 'includes_draft': false},
      'receipts': {'against_invoice': 0, 'advances': 0, 'cash': 0, 'bank': 0, 'unclassified': 0, 'total': 0},
      'payments_out': {'cash': 0, 'bank': 0, 'unclassified': 0, 'total': 0, 'footnote': 'Chưa gồm chi qua Journal Entry'},
      'receivables': {'outstanding_total': 0, 'overdue_total': 0, 'overdue_count': 0, 'as_of': 'current'},
      'app_drafts': {'count': 0, 'by_type': <String, int>{}},
      'cash_drawer': null,
      'returns': null,
    };

/// The `/read/drill` payload as the server sends it (the body IS the payload —
/// no `result` wrapper, same as the summary).
Map<String, dynamic> drillPayload({
  String drill = 'sales_orders_today',
  String title = 'Đơn hàng hôm nay',
  int total = 2,
  bool truncated = false,
  List<Map<String, dynamic>>? rows,
  List<Map<String, dynamic>>? lines,
}) => {
      'drill': drill,
      'title': title,
      'date': '2026-09-21',
      'limit': 10,
      // Provenance the server now sends with the numbers; the screen renders
      // figures only for `REAL` (§2.1 — D0.5 chose "hide", not "label").
      'erp_target': 'REAL',
      'generated_at': '2026-09-21T08:31:00+07:00',
      'summary_lines': lines ??
          [
            {'label': 'Đã ghi', 'amount_vnd': 12000000, 'count': 1},
            {'label': 'Nháp', 'amount_vnd': 99000000, 'count': 1},
          ],
      'total_documents': total,
      'truncated': truncated,
      'rows': rows ??
          [
            {'name': 'SO-SUB', 'date': '2026-09-21', 'amount_vnd': 12000000, 'note': 'Đã ghi', 'kind': 'submitted'},
            {'name': 'SO-DRAFT', 'date': '2026-09-21', 'amount_vnd': 99000000, 'note': 'Nháp — chưa ghi sổ', 'kind': 'draft'},
          ],
    };

class _Server {
  _Server({Map<String, dynamic>? drillBody, Map<String, dynamic>? dayBody})
      : drillBody = drillBody ?? drillPayload(),
        dayBody = dayBody ?? dayPayload();

  Map<String, dynamic> drillBody;

  /// The day summary the drawer's badge is fed from (D4) — overridden by the
  /// badge tests so a positive draft count can be read.
  Map<String, dynamic> dayBody;

  /// When set, `/read/drill` answers with this status + body instead.
  int? failStatus;
  Map<String, dynamic>? failBody;
  Completer<void>? gate;
  bool offlineDrill = false;

  final List<String> paths = <String>[];
  final List<Map<String, dynamic>> drillQueries = <Map<String, dynamic>>[];

  Handler get handler => (options) async {
        paths.add(options.path);
        if (options.path == '/read/daily-summary') return _json(dayBody);
        if (options.path != '/read/drill') return _json({'ok': true, 'result': <String, dynamic>{}});
        drillQueries.add(Map<String, dynamic>.from(options.queryParameters));
        if (gate != null) await gate!.future;
        if (offlineDrill) {
          throw DioException(
            requestOptions: options,
            type: DioExceptionType.connectionError,
            message: 'no route to host',
          );
        }
        if (failStatus != null) return _json(failBody ?? {'ok': false, 'code': 'ERP_UNAVAILABLE', 'error': 'ERPNext tạm thời không đọc được'}, failStatus!);
        return _json(drillBody);
      };

  int get drillCalls => drillQueries.length;

  /// Every READ the drawer paths make (the day summary + the drills): the badge
  /// tests assert that opening the drawer adds nothing to this number.
  int get callsOrDrills =>
      drillQueries.length + paths.where((p) => p == '/read/daily-summary').length;
  bool get touchedExecute => paths.any((p) => p.contains('execute'));
}

class _FakePrefs implements SharedPreferences {
  final Map<String, Object> store = {};

  @override
  dynamic noSuchMethod(Invocation invocation) {
    if (invocation.memberName == #getString) {
      return store[invocation.positionalArguments.first as String];
    }
    if (invocation.memberName == #setString) {
      store[invocation.positionalArguments[0] as String] = invocation.positionalArguments[1] as Object;
      return Future<bool>.value(true);
    }
    if (invocation.memberName == #remove) {
      store.remove(invocation.positionalArguments.first as String);
      return Future<bool>.value(true);
    }
    return null;
  }
}

/// A tall surface so the whole day (and the whole list) is laid out: the screens
/// are lazy ListViews, and an assertion that silently skipped off-screen widgets
/// would not be checking the screen.
void _tallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1000, 3000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

Future<void> _pumpApp(WidgetTester tester, _Server server, {String route = '/summary'}) async {
  _tallViewport(tester);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(_FakePrefs()),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter(server.handler),
          ),
        ),
      ],
      child: MaterialApp.router(routerConfig: appRouter),
    ),
  );
  appRouter.go(route);
  await tester.pumpAndSettle();
}

Finder _text(String needle) => find.textContaining(needle, findRichText: true);

/// Tap the card whose drill id is [drillId] and wait for the list.
Future<void> _tapMetric(WidgetTester tester, String drillId) async {
  final card = find.byKey(ValueKey('drill-$drillId'));
  expect(card, findsOneWidget, reason: 'the summary must offer a drill for $drillId');
  await tester.tap(card);
  await tester.pumpAndSettle();
}

void main() {
  setUp(() {
    // The router is a singleton: a test that navigated must not leak its
    // location into the next one.
    appRouter.go('/chat');
  });

  testWidgets('tapping a metric sends ONE structured drill request and ZERO /execute',
      (tester) async {
    final server = _Server();
    await _pumpApp(tester, server);
    expect(server.drillCalls, 0, reason: 'the summary itself must not open any drill');

    await _tapMetric(tester, 'sales_orders_today');

    expect(server.drillCalls, 1);
    expect(server.drillQueries.single['drill_id'], 'sales_orders_today',
        reason: 'the request carries the declared ID — never a phrase');
    expect(server.touchedExecute, isFalse,
        reason: 'opening a list is a READ: no request may touch /execute');
  });

  testWidgets('the list renders the SERVER summary lines, the rows and a read-only note',
      (tester) async {
    final server = _Server();
    await _pumpApp(tester, server);
    await _tapMetric(tester, 'sales_orders_today');

    // The title comes from the server's contract, not from the local label.
    expect(_text('Đơn hàng hôm nay'), findsWidgets);
    expect(_text('12.000.000đ'), findsWidgets);
    expect(_text('99.000.000đ'), findsWidgets);
    expect(_text('SO-SUB'), findsOneWidget);
    expect(_text('Nháp — chưa ghi sổ'), findsOneWidget,
        reason: 'the row note comes from the server so a draft cannot be mislabelled');
    expect(_text('Chỉ để xem'), findsOneWidget);
    // No write affordance on a money screen: no input, no submit-style button.
    expect(find.byType(TextField), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
    expect(find.byType(ElevatedButton), findsNothing);
  });

  testWidgets('a drill payload with NO provenance renders NO figures (§2.1)', (tester) async {
    // The server always sends `erp_target` now; this is the defensive half of the
    // rule — an absent value means "unknown", and unknown must not be rendered.
    final body = drillPayload()..remove('erp_target');
    final server = _Server(drillBody: body);
    await _pumpApp(tester, server);
    await _tapMetric(tester, 'sales_orders_today');

    expect(server.drillCalls, 1,
        reason: 'the READ still happens — this is a rendering rule, not a refusal to read');
    expect(_text('12.000.000đ'), findsNothing,
        reason: 'a figure whose source cannot be named must not be rendered');
    expect(_text('99.000.000đ'), findsNothing);
    expect(_text('SO-SUB'), findsNothing);
    expect(_text('Không hiện số liệu — chưa rõ nguồn dữ liệu'), findsOneWidget);
    expect(server.touchedExecute, isFalse);
  });

  testWidgets('a MOCK drill is named as MOCK and STILL shows no figures', (tester) async {
    final server = _Server(drillBody: drillPayload()..['erp_target'] = 'MOCK');
    await _pumpApp(tester, server);
    await _tapMetric(tester, 'sales_orders_today');

    expect(_text('12.000.000đ'), findsNothing,
        reason: 'labelling a money screen is not enough — the figures are replaced');
    expect(_text('Không hiện số liệu — máy chủ đang đọc dữ liệu giả lập'), findsOneWidget);
  });

  testWidgets('a CAPPED list says how many rows exist instead of implying it is the whole day',
      (tester) async {
    final server = _Server(
      drillBody: drillPayload(total: 12, truncated: true),
    );
    await _pumpApp(tester, server);
    await _tapMetric(tester, 'receipts_today');

    expect(_text('Hiện 2/12'), findsOneWidget);
    expect(_text('còn 10 dòng khác'), findsOneWidget);
  });

  testWidgets('an unreadable drill shows the reason with a retry — never an empty list',
      (tester) async {
    final server = _Server()
      ..failStatus = 400
      ..failBody = {'ok': false, 'code': 'UNKNOWN_DRILL_SCREEN', 'error': 'drill "x" không có trong hợp đồng capability'};
    await _pumpApp(tester, server);
    await _tapMetric(tester, 'overdue_customers');

    expect(_text('không có trong hợp đồng'), findsOneWidget);
    // The failure must not be dressed as an empty day.
    expect(_text('Không có dòng nào'), findsNothing);

    // Retry is a real second request (and the failure is not cached).
    server.failStatus = null;
    server.drillBody = drillPayload(drill: 'overdue_customers', title: 'Khách quá hạn', total: 0, rows: []);
    await tester.tap(find.byKey(const ValueKey('drill-retry')));
    await tester.pumpAndSettle();
    expect(server.drillCalls, 2);
    expect(_text('Khách quá hạn'), findsWidgets);
  });

  testWidgets('an offline read is an error with a retry, not a quiet day', (tester) async {
    final server = _Server()..offlineDrill = true;
    await _pumpApp(tester, server);
    await _tapMetric(tester, 'app_drafts_today');

    // The reason shown is the client's own offline message (the API client
    // maps transport failures) — what matters is that a refusal surfaces WITH
    // its reason and a retry, and is never dressed as a quiet day.
    expect(_text('Không kết nối được máy chủ'), findsOneWidget);
    expect(find.byKey(const ValueKey('drill-retry')), findsOneWidget);
    expect(_text('Không có dòng nào'), findsNothing);
    expect(server.drillCalls, 1);
  });

  testWidgets('an empty drill is stated as an ANSWER (the server read the day and found nothing)',
      (tester) async {
    final server = _Server(
      drillBody: drillPayload(
        drill: 'app_drafts_today',
        title: 'Nháp app hôm nay',
        total: 0,
        rows: [],
        lines: [
          {'label': 'Nháp app hôm nay', 'amount_vnd': null, 'count': 0},
        ],
      ),
    );
    await _pumpApp(tester, server);
    await _tapMetric(tester, 'app_drafts_today');

    expect(_text('Không có dòng nào trong mục này cho ngày 2026-09-21'), findsOneWidget);
    // A count line is a count: a null amount must not be rendered as 0đ.
    expect(_text('0đ'), findsNothing);
    expect(_text('0'), findsWidgets);
    expect(find.byKey(const ValueKey('drill-retry')), findsNothing);
  });

  testWidgets('/drill without an intent is REFUSED (fail-closed), and issues no read',
      (tester) async {
    final server = _Server();
    await _pumpApp(tester, server, route: '/drill');

    expect(server.drillCalls, 0, reason: 'nothing may be read without a declared intent');
    expect(find.textContaining('chỉ mở được từ nút', findRichText: true), findsOneWidget);
  });

  testWidgets('P4-5: an app-draft row leads with the DOCUMENT — no fabricated 0đ, no write/delete affordance',
      (tester) async {
    // The drill row for a draft used to render amount_vnd (0) as "0đ" — a
    // number the block never claimed. P4-5 copies the document's own
    // grand_total from the server but the card shows "—" for drafts: the
    // block is a COUNT, and a draft is a proposal, not books. And per §5.3,
    // the screen must offer no submit/delete path at all.
    final server = _Server(
      drillBody: drillPayload(
        drill: 'app_drafts_today',
        title: 'Nháp app hôm nay',
        total: 1,
        rows: [
          {'name': 'PO-APP', 'date': '2026-09-21', 'amount_vnd': 99000000, 'note': 'Purchase Order · nháp (copilot tạo)', 'kind': 'app_draft'},
        ],
        lines: [
          {'label': 'Nháp app hôm nay', 'amount_vnd': null, 'count': 1},
        ],
      ),
    );
    await _pumpApp(tester, server);
    await _tapMetric(tester, 'app_drafts_today');

    // The document leads; the money side is an em-dash, never "0đ".
    expect(_text('PO-APP'), findsOneWidget);
    expect(_text('—'), findsOneWidget);
    expect(_text('0đ'), findsNothing);
    // No path to submit or delete a draft from here (§5.3 — read-only).
    for (final forbidden in ['Submit', 'Xác nhận', 'Gửi', 'Xoá', 'Xóa', 'Hủy phiếu', 'Ghi sổ']) {
      expect(find.textContaining(forbidden, findRichText: true), findsNothing,
          reason: 'the drill must not offer "$forbidden"');
    }
    expect(find.byType(TextField), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
    expect(server.paths.where((p) => p.contains('execute')), isEmpty);
  });

  testWidgets('Back returns to the summary, and the day is not re-read by the drill',
      (tester) async {
    final server = _Server();
    await _pumpApp(tester, server);
    await _tapMetric(tester, 'invoices_today');
    expect(server.drillCalls, 1);

    await tester.tap(find.byType(BackButton));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('drill-invoices_today')), findsOneWidget,
        reason: 'Back lands on the summary, with its cards still there');
    expect(server.drillCalls, 1, reason: 'returning must not fire another read');
  });

  // ───────────────────────── D1 — drawer debt views (§3.1) ─────────────────

  testWidgets('D1: the drawer opens Công nợ as a READ drill — GL figures, footnote, hint',
      (tester) async {
    final server = _Server(
      drillBody: drillPayload(
        drill: 'receivable_customers',
        title: 'Công nợ khách hàng',
        rows: [
          {'name': 'Chị Lan', 'date': null, 'amount_vnd': 20000000, 'note': '2 hóa đơn · quá hạn 11.000.000đ (2026-09-10)', 'kind': 'receivable_customer'},
          {'name': 'Anh Bảy', 'date': null, 'amount_vnd': 5000000, 'note': '1 hóa đơn', 'kind': 'receivable_customer'},
        ],
        lines: [
          {'label': 'Tổng còn nợ (theo sổ)', 'amount_vnd': 25000000, 'count': 2},
          {'label': 'Khách còn nợ', 'amount_vnd': null, 'count': 2},
        ],
      )
        ..['footnote'] = 'Theo sổ ERPNext đã ghi nhận (chưa trừ phiếu thu/chi nháp).'
        ..['draft_hint'] = {'count': 2, 'amount_vnd': 4000000},
    );
    await _pumpApp(tester, server, route: '/chat');
    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Công nợ (lối tắt)'));
    await tester.pumpAndSettle();

    // The tap sent the DECLARED id — a drawer entry is a fixed drill, never a
    // phrase and never an /execute.
    expect(server.drillCalls, 1);
    expect(server.drillQueries.single['drill_id'], 'receivable_customers');
    expect(server.touchedExecute, isFalse);
    // GL-raw figures render, with the footnote VERBATIM and the hint line —
    // the hint may sit under the figures but must not change them.
    expect(_text('Chị Lan'), findsOneWidget);
    expect(_text('20.000.000đ'), findsOneWidget);
    expect(_text('Theo sổ ERPNext đã ghi nhận (chưa trừ phiếu thu/chi nháp).'), findsOneWidget);
    expect(_text('Có 2 phiếu nháp chưa nộp (4.000.000đ).'), findsOneWidget);
    // The drawer's read-only posture carries over to the new views.
    expect(find.byType(TextField), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('D1: Nợ quá hạn / Nợ lâu opens overdue_top with days_overdue notes',
      (tester) async {
    final server = _Server(
      drillBody: drillPayload(
        drill: 'overdue_top',
        title: 'Nợ quá hạn / Nợ lâu',
        rows: [
          {'name': 'Anh Bảy', 'date': '2026-08-12', 'amount_vnd': 900000, 'note': 'Nợ lâu nhất 40 ngày · 1 hóa đơn', 'kind': 'overdue_top_customer'},
          {'name': 'Chị Lan', 'date': '2026-09-10', 'amount_vnd': 20000000, 'note': 'Nợ lâu nhất 11 ngày · 2 hóa đơn', 'kind': 'overdue_top_customer'},
        ],
        lines: [
          {'label': 'Tổng quá hạn', 'amount_vnd': 20900000, 'count': 3},
        ],
      )
        ..['footnote'] = 'Theo sổ ERPNext đã ghi nhận (chưa trừ phiếu thu/chi nháp).',
    );
    await _pumpApp(tester, server, route: '/chat');
    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Nợ quá hạn / Nợ lâu'));
    await tester.pumpAndSettle();

    expect(server.drillCalls, 1);
    expect(server.drillQueries.single['drill_id'], 'overdue_top');
    // The order on screen is the SERVER's order (oldest first here) — the
    // client renders rows as they come and never re-sorts money.
    expect(_text('Anh Bảy'), findsOneWidget);
    expect(_text('Nợ lâu nhất 40 ngày'), findsOneWidget);
    expect(_text('Chị Lan'), findsOneWidget);
    expect(_text('Nợ lâu nhất 11 ngày'), findsOneWidget);
    expect(_text('Theo sổ ERPNext đã ghi nhận'), findsOneWidget);
    // No hint was sent ⇒ no hint line, and no count rendered as 0đ either
    // (a money figure legitimately CONTAINS “0” — so assert the fabricated
    // shape, a bare leading zero, not any string containing a digit).
    expect(_text('phiếu nháp chưa nộp'), findsNothing);
    expect(find.text('0đ'), findsNothing);
    expect(server.touchedExecute, isFalse);
  });

  testWidgets('D1c: the drawer opens HĐ chưa trả as a READ drill — invoice rows, footnote',
      (tester) async {
    final server = _Server(
      drillBody: drillPayload(
        drill: 'unpaid_invoices',
        title: 'HĐ chưa trả',
        rows: [
          {'name': 'INV-1001', 'date': '2026-09-10', 'amount_vnd': 20000000, 'note': 'Chị Lan', 'kind': 'unpaid_invoice'},
          {'name': 'INV-1002', 'date': '2026-10-01', 'amount_vnd': 5000000, 'note': 'Anh Bảy', 'kind': 'unpaid_invoice'},
        ],
        lines: [
          {'label': 'Tổng còn phải thu', 'amount_vnd': 25000000, 'count': 2},
          {'label': 'Hóa đơn chưa trả', 'amount_vnd': null, 'count': 2},
        ],
      )
        ..['footnote'] = 'Theo sổ ERPNext đã ghi nhận (chưa trừ phiếu thu/chi nháp).'
        ..['draft_hint'] = {'count': 1, 'amount_vnd': 3000000},
    );
    await _pumpApp(tester, server, route: '/chat');
    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();
    await tester.tap(find.text('HĐ chưa trả'));
    await tester.pumpAndSettle();

    // The tap sent the DECLARED id — never a phrase, never an /execute.
    expect(server.drillCalls, 1);
    expect(server.drillQueries.single['drill_id'], 'unpaid_invoices');
    expect(server.touchedExecute, isFalse);
    // The row IS an invoice (§3.2 — no PE-able abstraction): mã HĐ leads, the
    // customer travels in the note, the money is the invoice's own outstanding.
    expect(_text('INV-1001'), findsOneWidget);
    expect(_text('20.000.000đ'), findsOneWidget);
    expect(_text('Chị Lan'), findsOneWidget);
    expect(_text('INV-1002'), findsOneWidget);
    // Server wording, verbatim; the optional hint renders when sent.
    expect(_text('Theo sổ ERPNext đã ghi nhận (chưa trừ phiếu thu/chi nháp).'), findsOneWidget);
    expect(_text('Có 1 phiếu nháp chưa nộp (3.000.000đ).'), findsOneWidget);
    // Read-only posture: no write affordance anywhere on the new view.
    expect(find.byType(TextField), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('D1c: no hint was sent ⇒ no hint line, and order is the SERVER\'s',
      (tester) async {
    final server = _Server(
      drillBody: drillPayload(
        drill: 'unpaid_invoices',
        title: 'HĐ chưa trả',
        rows: [
          {'name': 'INV-2', 'date': '2026-09-01', 'amount_vnd': 900000, 'note': 'Anh Bảy', 'kind': 'unpaid_invoice'},
          {'name': 'INV-1', 'date': '2026-09-02', 'amount_vnd': 20000000, 'note': 'Chị Lan', 'kind': 'unpaid_invoice'},
        ],
        lines: [
          {'label': 'Tổng còn phải thu', 'amount_vnd': 20900000, 'count': 2},
        ],
      ),
    );
    await _pumpApp(tester, server, route: '/chat');
    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();
    await tester.tap(find.text('HĐ chưa trả'));
    await tester.pumpAndSettle();

    expect(server.drillQueries.single['drill_id'], 'unpaid_invoices');
    // Server order preserved (client never re-sorts money): smaller-but-first
    // row stays first because the SERVER sent it first.
    expect(_text('INV-2'), findsOneWidget);
    expect(_text('INV-1'), findsOneWidget);
    // No footnote/hint sent ⇒ none invented client-side.
    expect(_text('Theo sổ ERPNext'), findsNothing);
    expect(_text('phiếu nháp chưa nộp'), findsNothing);
    expect(find.text('0đ'), findsNothing);
    expect(server.touchedExecute, isFalse);
  });

  testWidgets('D2: Tồn kho nóng renders QUANTITY rows — unit-less, no "đ", no money invented',
      (tester) async {
    final server = _Server(
      drillBody: drillPayload(
        drill: 'stock_low',
        title: 'Tồn kho nóng',
        rows: [
          {'name': 'CAM-GA-10KG', 'date': null, 'amount_vnd': 40, 'note': 'Kho Cám - MP', 'kind': 'stock_low_item'},
          {'name': 'CAM-HEO-25KG', 'date': null, 'amount_vnd': 120, 'note': 'Kho Cám - MP', 'kind': 'stock_low_item'},
        ],
        lines: [
          {'label': 'Tồn thấp — Kho: Kho Cám - MP', 'amount_vnd': null, 'count': 2},
          {'label': 'Tổng số lượng đang có', 'amount_vnd': null, 'count': 160},
        ],
      ),
    );
    await _pumpApp(tester, server, route: '/chat');
    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Tồn kho nóng'));
    await tester.pumpAndSettle();

    expect(server.drillCalls, 1);
    expect(server.drillQueries.single['drill_id'], 'stock_low');
    expect(server.touchedExecute, isFalse);
    // The qty leads (§3.3: low stock first — server's order kept), the
    // warehouse name rides in the note, and the number is UNIT-LESS: a shelf
    // count printed as "40đ" would claim goods are money.
    expect(_text('CAM-GA-10KG'), findsOneWidget);
    expect(find.text('40'), findsOneWidget);
    // The warehouse name appears in the header line AND in both row notes.
    expect(find.textContaining('Kho Cám - MP'), findsNWidgets(3));
    // A currency mark ENDS a figure ("…đ"); Vietnamese words legitimately
    // CONTAIN the letter đ ("đang", "để", "thay đổi"), so the fabricated-money
    // shape to forbid is a trailing đ, not any occurrence of the letter.
    expect(find.textContaining(RegExp(r'\d[\.,]?\d*đ$')), findsNothing,
        reason: 'no figure on this drill may render as money');
    // Header names the warehouse (§3.3 verbatim shape).
    expect(_text('Tồn thấp — Kho: Kho Cám - MP'), findsOneWidget);
    // Read-only posture holds here too.
    expect(find.byType(TextField), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('D3: Nháp hôm nay shows the PARTIAL banner naming the section that failed',
      (tester) async {
    final server = _Server(
      drillBody: drillPayload(
        drill: 'app_drafts_today',
        title: 'Nháp hôm nay',
        rows: [
          {'name': 'PE-DRAFT-APP', 'date': '2026-09-21', 'amount_vnd': 3000000, 'note': 'Payment Entry · nháp (copilot tạo)', 'kind': 'app_draft'},
        ],
        lines: [
          {'label': 'Nháp app hôm nay', 'amount_vnd': null, 'count': 1},
          {'label': 'Đọc được 3/4 loại chứng từ', 'amount_vnd': null, 'count': null},
        ],
      )
        ..['partial'] = true
        ..['sections'] = {
          'Payment Entry': {'ok': true, 'count': 1},
          'Sales Order': {'ok': true, 'count': 0},
          'Purchase Order': {'ok': true, 'count': 0},
          'Quotation': {'ok': false, 'code': 'ERP_UNAVAILABLE', 'error': 'timeout'},
        }
        ..['duplicates_dropped'] = 0,
    );
    await _pumpApp(tester, server, route: '/chat');
    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Nháp hôm nay'));
    await tester.pumpAndSettle();

    expect(server.drillCalls, 1, reason: 'ONE aggregate call — the client never fans out to the doctypes');
    expect(server.drillQueries.single['drill_id'], 'app_drafts_today');
    expect(server.touchedExecute, isFalse);
    // loadedPartial: the rows that DID answer are shown, and the banner names
    // what did not — an unlabelled half-read day would read as a whole one.
    expect(find.byKey(const ValueKey('drill-partial-banner')), findsOneWidget);
    expect(_text('Chưa đọc được: Quotation — danh sách dưới là phần đã đọc.'), findsOneWidget);
    expect(_text('PE-DRAFT-APP'), findsOneWidget);
    expect(_text('Đọc được 3/4 loại chứng từ'), findsOneWidget);
    // Read-only: this screen has no submit/bulk affordance at all.
    expect(find.byType(TextField), findsNothing);
    expect(find.byType(FilledButton), findsNothing);
    for (final forbidden in ['Submit', 'Gửi', 'Xác nhận', 'Duyệt']) {
      expect(find.textContaining(forbidden, findRichText: true), findsNothing,
          reason: 'the drafts list must not offer "$forbidden"');
    }
  });

  testWidgets('D3: a complete read shows NO banner, and an empty day is actionable',
      (tester) async {
    final server = _Server(
      drillBody: drillPayload(
        drill: 'app_drafts_today',
        title: 'Nháp hôm nay',
        rows: const [],
        lines: [
          {'label': 'Nháp app hôm nay', 'amount_vnd': null, 'count': 0},
          {'label': 'Đọc được 4/4 loại chứng từ', 'amount_vnd': null, 'count': null},
        ],
      )
        ..['partial'] = false
        ..['sections'] = {
          'Payment Entry': {'ok': true, 'count': 0},
          'Sales Order': {'ok': true, 'count': 0},
          'Purchase Order': {'ok': true, 'count': 0},
          'Quotation': {'ok': true, 'count': 0},
        },
    );
    await _pumpApp(tester, server, route: '/chat');
    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Nháp hôm nay'));
    await tester.pumpAndSettle();

    // A complete, empty day: no banner, the empty state is an ANSWER (§5) and
    // it says what to DO next instead of just showing zero.
    expect(find.byKey(const ValueKey('drill-partial-banner')), findsNothing);
    expect(find.textContaining('Không có dòng nào trong mục này'), findsOneWidget);
    expect(find.textContaining('Nói trong chat'), findsOneWidget);
    expect(find.text('0đ'), findsNothing);
    expect(server.touchedExecute, isFalse);
  });

  // ───────────────────────── D4 — polish (§7 D4) ─────────────────────────

  testWidgets('D4: pulling the drawer list down RE-READS it — a fresh read, not the payload on screen',
      (tester) async {
    // §2.4 / §3.1 "fresh read": the list the user is looking at is a moment in
    // time. Pull-to-refresh is the explicit way to ask again (the summary's own
    // freshness window must never make a drawer feel stuck on old money).
    final server = _Server(
      drillBody: drillPayload(
        drill: 'receivable_customers',
        title: 'Công nợ khách hàng',
        total: 0,
        rows: const [],
        lines: const [],
      ),
    );
    await _pumpApp(tester, server, route: '/chat');
    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Công nợ (lối tắt)'));
    await tester.pumpAndSettle();
    expect(server.drillCalls, 1);

    // A stepped DRAG, not a fling: RefreshIndicator only fires once the pull
    // passes ~25% of the viewport height, and this test's viewport is tall
    // (3000px) so the pull has to actually travel that far.
    final gesture =
        await tester.startGesture(tester.getCenter(find.byType(RefreshIndicator)));
    for (var i = 0; i < 4; i++) {
      await gesture.moveBy(const Offset(0, 300));
      await tester.pump(const Duration(milliseconds: 50));
    }
    await gesture.up();
    await tester.pumpAndSettle();

    expect(server.drillCalls, 2,
        reason: 'pull-to-refresh must issue a NEW read, never replay the cached payload');
    expect(server.touchedExecute, isFalse,
        reason: 'refreshing a list is still a READ');
  });

  testWidgets('D4: the drill title states the DAY it read — the summary filter travels with the payload',
      (tester) async {
    // D4 (§7: "title phản ánh filter"). The server titles a day-scoped drill from
    // the day it ACTUALLY read (drill-views.drillDayWord), and the screen prefers
    // that title over the local placeholder — so a list of yesterday's invoices
    // can never be headed "Hóa đơn hôm nay".
    final server = _Server(
      drillBody: drillPayload(
        drill: 'invoices_today',
        title: 'Hóa đơn đã xuất hôm qua',
        total: 1,
        rows: [
          {'name': 'INV-1', 'date': '2026-09-20', 'amount_vnd': 20000000, 'note': 'Đã ghi', 'kind': 'submitted'},
        ],
      ),
    );
    await _pumpApp(tester, server);
    await _tapMetric(tester, 'invoices_today');

    expect(_text('Hóa đơn đã xuất hôm qua'), findsWidgets,
        reason: 'the title must name the day the rows belong to');
    expect(find.text('Hóa đơn hôm nay'), findsNothing);
  });

  testWidgets('D4: a read that never answers is BOUNDED — the screen gives up, says so, and offers Thử lại',
      (tester) async {
    // §2.4: ~5–7s hard bound so a drawer never spins forever. The gate never
    // completes, so the ONLY way this test can reach an error is the bound
    // firing — and the spinner keeps animating, which is why the clock is
    // pumped instead of settled while the read is in flight.
    final server = _Server()..gate = Completer<void>();
    await _pumpApp(tester, server);
    await tester.tap(find.byKey(const ValueKey('drill-invoices_today')));
    await tester.pump();
    await tester.pump(AppConstants.readTimeout + const Duration(seconds: 1));
    // Explicit pumps, NOT pumpAndSettle: with the bound removed the spinner
    // animates forever and settle would hang for its full 10-minute timeout
    // (which would make this test's own falsification case look like a timeout
    // instead of a failure). Two frames are all the error UI needs.
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));

    expect(_text('Hết thời gian chờ máy chủ.'), findsOneWidget,
        reason: 'a read with no answer must end with the timeout copy, not an endless spinner');
    expect(find.byKey(const ValueKey('drill-retry')), findsOneWidget,
        reason: 'the user is told how to try again');
    expect(_text('Không có dòng nào'), findsNothing,
        reason: 'a timeout is an ERROR — it must never be dressed as a quiet day');
  });

  testWidgets('D4: the drawer badge shows the drafts count when it is POSITIVE, with no extra read',
      (tester) async {
    // §6: "Badge: D4 optional; fail → ẩn, không hiện 0; không block mở drawer".
    // The count is the one the summary ALREADY read — the drawer itself never
    // asks for anything, so a badge can never slow down or block opening it.
    final server = _Server(
      dayBody: dayPayload()..['app_drafts'] = {
        'count': 3,
        'by_type': <String, int>{'Purchase Order': 3},
      },
    );
    await _pumpApp(tester, server);
    expect(server.callsOrDrills, 1, reason: 'precondition: the day was read once');

    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('drawer-badge-app_drafts_today')), findsOneWidget);
    expect(find.text('3'), findsWidgets);
    expect(server.drillCalls, 0,
        reason: 'opening the drawer must cost NO read — the badge is fed by the summary');
  });

  testWidgets('D4: no badge when the count is 0 — a zero badge is a claim the server did not make',
      (tester) async {
    final server = _Server(); // dayPayload's app_drafts.count is 0
    await _pumpApp(tester, server);
    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('drawer-badge-app_drafts_today')), findsNothing);
  });

  testWidgets('D4: no badge when nothing was read (chat drawer), and opening it stays free',
      (tester) async {
    final server = _Server();
    await _pumpApp(tester, server, route: '/chat');
    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();

    // Chat has read nothing, so the count is UNKNOWN — unknown must not be
    // rendered as "0 phiếu nháp".
    expect(find.byKey(const ValueKey('drawer-badge-app_drafts_today')), findsNothing);
    expect(server.callsOrDrills, 0);
  });

  testWidgets('D1: footnote and hint are ABSENT when the server sends none',
      (tester) async {
    // The day drills never carry a footnote; the debt views must not grow one
    // from the client — the wording about WHAT the figures are is the
    // server's to say (and its absence must stay absence, not a local guess).
    final server = _Server();
    await _pumpApp(tester, server);
    await _tapMetric(tester, 'sales_orders_today');

    expect(_text('Theo sổ ERPNext'), findsNothing);
    expect(_text('phiếu nháp chưa nộp'), findsNothing);
  });
}
