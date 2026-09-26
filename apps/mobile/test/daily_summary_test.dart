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
import 'package:erpn_mobile/features/ops/data/daily_summary_models.dart';
import 'package:erpn_mobile/features/ops/presentation/screens/daily_summary_screen.dart';

/// P4-3 (plan4_final §2, §6) — the drawer + "Tóm tắt ngày" screen.
///
/// The properties these tests defend, in the order money could go wrong:
///
///  1. **No fake zero.** A block the server could not read shows "Lỗi · Thử
///     lại" for that block and NO amount — "0đ" may only ever mean ERPNext
///     counted zero (§4.3).
///  2. **An empty day is still a real answer** — zeros render, with nothing
///     pretending to be an error.
///  3. **One aggregate per drawer open.** A cached day inside the freshness
///     window costs no request; pull-to-refresh and "Thử lại" are the override.
///  4. **Offline keeps the last numbers and SAYS they are old** (§6) instead of
///     going blank.
///  5. **Provenance is displayed, never invented.** REAL|MOCK comes from the
///     server; with no signal the footer says it does not know.
///  6. **No write path.** The screen and the drawer offer no create/submit/pay
///     affordance, and no request to `/execute` is ever made.
///  7. **The label is not "Doanh thu"** (§3.1): an order, an invoice and money
///     actually received are three different numbers.
///
/// The screen is reached through the SHIPPED router (`/summary`) so the route
/// under test is the real one, not a copy.

typedef Handler = Future<ResponseBody> Function(RequestOptions options);

/// The previous SHOP day, derived EXACTLY as the screen derives it
/// (`daily_summary_screen.dart` §3.7: VN midnight − 1 day).
///
/// These five P4-6 tests used to hard-code `'2026-09-20'`. That is a time
/// bomb: it matched only on the day the test was written, and on 2026-09-22
/// the suite went red (5 failures) with no code change at all — the client was
/// correctly asking for `2026-09-21`. Computing it here keeps the test and the
/// screen on ONE clock instead of two.
String _yesterdayVn() {
  final vnNow = DateTime.now().toUtc().add(const Duration(hours: 7));
  final vnMidnight = DateTime.utc(vnNow.year, vnNow.month, vnNow.day);
  final y = vnMidnight.subtract(const Duration(days: 1));
  String two(int n) => n.toString().padLeft(2, '0');
  return '${y.year}-${two(y.month)}-${two(y.day)}';
}

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

/// Distinct numbers per block, so an assertion naming an amount can only be
/// satisfied by the block that owns it.
const int kSoSubmitted = 10000000;
const int kSoDraft = 3000000;
const int kInvoice = 12500000;
const int kReceiptsTotal = 6030000;
const int kReceiptsCash = 4030000;
const int kReceiptsBank = 2000000;
const int kAgainstInvoice = 5000000;
const int kAdvances = 1030000;
const int kPaymentsOut = 1200000;
const int kOutstanding = 55500000;
const int kOverdue = 5500000;
const int kCashOpening = 1000000;
const int kCashClosing = 3830000;

/// The §4.3 object as `ops.daily_summary` sends it (measured against the real
/// route in result-p4-2.txt: the whole object, no `result` wrapper).
Map<String, dynamic> payload({
  Map<String, dynamic>? receipts,
  bool noReceipts = false,
  bool noAppDrafts = false,
  bool noCashDrawer = false,
  String? erpTarget = 'REAL',
  bool partial = false,
  List<Map<String, dynamic>> errors = const [],
  bool quiet = false,
}) {
  return {
    'ok': true,
    'meta': {
      'date': '2026-09-21',
      'timezone': 'Asia/Ho_Chi_Minh',
      'generated_at': '2026-09-21T08:30:00+07:00',
      'source': 'real',
      'erp_target': erpTarget,
      'company': 'Minh Phát Cám & VLXD',
      'partial': partial,
      'errors': errors,
    },
    'sales_orders': {
      'submitted': quiet ? {'count': 0, 'amount': 0} : {'count': 2, 'amount': kSoSubmitted},
      'draft': quiet ? {'count': 0, 'amount': 0} : {'count': 1, 'amount': kSoDraft},
    },
    'sales_invoices': quiet
        ? {'count': 0, 'amount': 0, 'includes_draft': false}
        : {'count': 3, 'amount': kInvoice, 'includes_draft': false},
    'receipts': noReceipts
        ? null
        : (receipts ??
            {
              'against_invoice': quiet ? 0 : kAgainstInvoice,
              'advances': quiet ? 0 : kAdvances,
              'cash': quiet ? 0 : kReceiptsCash,
              'bank': quiet ? 0 : kReceiptsBank,
              'unclassified': 0,
              'total': quiet ? 0 : kReceiptsTotal,
            }),
    'payments_out': quiet
        ? {'cash': 0, 'bank': 0, 'unclassified': 0, 'total': 0, 'footnote': 'Chưa gồm chi qua Journal Entry'}
        : {
            'cash': kPaymentsOut,
            'bank': 0,
            'unclassified': 0,
            'total': kPaymentsOut,
            'footnote': 'Chưa gồm chi qua Journal Entry',
          },
    'receivables': {
      'outstanding_total': kOutstanding,
      'overdue_total': kOverdue,
      'overdue_count': 2,
      'as_of': 'current',
    },
    'app_drafts': noAppDrafts ? null : {'count': 0, 'by_type': <String, int>{}},
    'cash_drawer': noCashDrawer
        ? null
        : {
            'opening': kCashOpening,
            'cash_in_today': quiet ? 0 : kReceiptsCash,
            'cash_out_today': kPaymentsOut,
            'expected_closing': kCashClosing,
            'account': '1110 - Tiền mặt - MP',
            'includes_bank': false,
          },
    'returns': null,
  };
}

/// Serves `/read/daily-summary`, records every path requested, and can fail on
/// demand. The payload is built at call time so one test can flip a knob.
class _Server {
  _Server({Map<String, dynamic>? body, this.erpTarget = 'REAL', this.byDate})
      : body = body ?? payload();

  Map<String, dynamic> body;
  String? erpTarget;
  bool offline = false;
  Completer<void>? gate;

  /// P4-6: per-date responses (the query's raw `date` value → body), so a test
  /// can give yesterday DIFFERENT numbers from today and assert on the delta.
  /// A date with no entry falls back to [body].
  final Map<String?, Map<String, dynamic>>? byDate;

  /// Dates whose read must FAIL (a real "yesterday unreadable" case).
  final Set<String?> failDates = <String?>{};

  final List<String> paths = <String>[];
  final List<String?> requestedDates = <String?>[];

  /// P4-6: what `/read/drill` was asked for — the day a drill must follow.
  final List<String?> drillDates = <String?>[];
  int calls = 0;

  Handler get handler => (options) async {
        paths.add(options.path);
        if (options.path != '/read/daily-summary') {
          if (options.path == '/read/drill') drillDates.add(options.queryParameters['date']);
          return _json({'ok': true, 'result': {}});
        }
        final askedDate = options.queryParameters['date'];
        requestedDates.add(askedDate);
        if (failDates.contains(askedDate)) {
          throw DioException(
            requestOptions: options,
            type: DioExceptionType.connectionError,
            message: 'no route to host',
          );
        }
        calls++;
        if (gate != null) await gate!.future;
        if (offline) {
          throw DioException(
            requestOptions: options,
            type: DioExceptionType.connectionError,
            message: 'no route to host',
          );
        }
        final forDate = byDate?[options.queryParameters['date']];
        return _json(forDate ?? body);
      };

  bool get touchedExecute =>
      paths.any((p) => p.contains('execute'));
}

/// Minimal fail-safe SharedPreferences double (same contract the services
/// document: null/absent keys read as "nothing stored").
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

/// Prime the persisted cache exactly the way [DailySummaryCache] writes it.
void _seedCache(
  _FakePrefs prefs,
  Map<String, dynamic> body, {
  required Duration age,
}) {
  prefs.store[AppConstants.dailySummaryCacheStorageKey] = jsonEncode({
    'fetched_at':
        DateTime.now().toUtc().subtract(age).toIso8601String(),
    'body': jsonEncode(body),
  });
}

/// A tall surface, so a whole day fits without scrolling: the screen is a lazy
/// ListView, and an assertion that silently skipped off-screen blocks would not
/// be checking the screen.
void _tallViewport(WidgetTester tester) {
  tester.view.physicalSize = const Size(1000, 3000);
  tester.view.devicePixelRatio = 1.0;
  addTearDown(tester.view.reset);
}

/// [settle] false is for the tests that must look at the screen WHILE a read is
/// still in flight (skeleton, and old-cached-data-before-the-refresh-lands); for
/// those the server is gated, so settling would wait forever.
Future<void> _pumpApp(
  WidgetTester tester,
  _Server server, {
  _FakePrefs? prefs,
  String route = '/summary',
  bool settle = true,
}) async {
  _tallViewport(tester);
  final p = prefs ?? _FakePrefs();
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(p),
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
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 50));
  }
}

/// D4: like [_pumpApp], but the API client comes from a LIVE provider that
/// depends on the settings service — so invalidating the settings (what the
/// Settings screen does after a Save) really does build a NEW client, which is
/// the event the mounted drawer listens for.
Future<void> _pumpAppWithLiveClient(
  WidgetTester tester,
  _Server server, {
  required _FakePrefs prefs,
}) async {
  _tallViewport(tester);
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(prefs),
        copilotApiClientProvider.overrideWith(
          (ref) => CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter(server.handler),
            settings: ref.watch(appSettingsServiceProvider),
          ),
        ),
      ],
      child: MaterialApp.router(routerConfig: appRouter),
    ),
  );
  appRouter.go('/summary');
  await tester.pumpAndSettle();
}

Finder _text(String needle) => find.textContaining(needle, findRichText: true);

/// Same grouping the money screens use, so an expected literal like
/// "55.500.000" matches the rendered form.
String _fmtVnd(int n) => n.toString().replaceAllMapped(
      RegExp(r'(\d)(?=(\d{3})+$)'),
      (m) => '${m[1]}.',
    );

void main() {
  setUp(() {
    // The router is a singleton: a test that navigated must not leak its
    // location into the next one.
    appRouter.go('/chat');
  });

  // ─────────────────────────── states (§6) ───────────────────────────

  testWidgets('loading shows a skeleton, never a zeroed day', (tester) async {
    final server = _Server()..gate = Completer<void>();
    // The request is in flight and nothing may be rendered as a number yet.
    await _pumpApp(tester, server, settle: false);

    expect(find.byKey(const ValueKey('summary-skeleton')), findsOneWidget);
    expect(_text('0đ'), findsNothing,
        reason: 'a slow read must not look like a day with no money in it');

    server.gate!.complete();
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('summary-skeleton')), findsNothing);
  });

  testWidgets('OK renders the numbers, the server stamp and REAL|MOCK + URL',
      (tester) async {
    final server = _Server();
    await _pumpApp(tester, server);

    expect(server.calls, 1, reason: 'P4-6: yesterday is read on demand, not on entry');
    // Every block, from the server's own numbers (formatted, never recomputed).
    expect(_text('10.000.000đ'), findsOneWidget);
    expect(_text('3.000.000đ'), findsOneWidget);
    expect(_text('12.500.000đ'), findsOneWidget);
    expect(_text('6.030.000đ'), findsOneWidget);
    expect(_text('55.500.000đ'), findsOneWidget);
    expect(_text('3.830.000đ'), findsOneWidget);
    // SO submitted and draft are SEPARATE lines (§10.1).
    expect(_text('Đã chốt (submitted) · 2 đơn'), findsOneWidget);
    expect(_text('Đang nháp · 1 đơn'), findsOneWidget);
    // Stamp + provenance + URL (§2, §6).
    expect(_text('Số liệu đọc lúc'), findsOneWidget);
    expect(_text('Ngày 2026-09-21'), findsOneWidget);
    expect(_text('REAL ERPNext'), findsWidgets);
    // The EFFECTIVE gateway URL: nothing saved in Settings here, so the footer
    // falls back to the compiled-in --dart-define value (the Dio in this test is
    // overridden directly, so it is deliberately not the base URL).
    expect(
      _text('COPILOT_BASE_URL: ${AppConstants.defaultCopilotBaseUrl}'),
      findsOneWidget,
    );
    expect(_text('DỮ LIỆU CŨ'), findsNothing);
    // §10.2: the payout figure always carries the Journal Entry footnote.
    expect(_text('Chưa gồm chi qua Journal Entry'), findsOneWidget);
  });

  testWidgets('a MOCK day says so, so a rehearsal cannot pass as the books',
      (tester) async {
    final server = _Server(body: payload(erpTarget: 'MOCK'), erpTarget: 'MOCK');
    await _pumpApp(tester, server);

    expect(_text('MOCK (dữ liệu giả lập)'), findsWidgets);
    expect(_text('Bộ dữ liệu giả lập'), findsOneWidget);
    expect(_text('REAL ERPNext'), findsNothing);
  });

  testWidgets('a MOCK day renders NO figures — a label is not enough (§2.1)',
      (tester) async {
    final server = _Server(body: payload(erpTarget: 'MOCK'), erpTarget: 'MOCK');
    await _pumpApp(tester, server);

    // Every money figure on the day is gone, not merely captioned.
    expect(_text('12.500.000đ'), findsNothing);
    expect(_text('10.000.000đ'), findsNothing);
    expect(_text('3.000.000đ'), findsNothing);
    expect(_text('Không hiện số liệu — máy chủ đang đọc dữ liệu giả lập'), findsOneWidget);
    // The reason travels with it (so an operator knows what to fix), and the
    // screen still refuses to claim the numbers are the shop's.
    expect(_text('MOCK (dữ liệu giả lập)'), findsWidgets);
  });

  testWidgets('a payload that does not name its source is NOT rendered as the books',
      (tester) async {
    final server = _Server(body: payload(erpTarget: null));
    await _pumpApp(tester, server);

    expect(_text('12.500.000đ'), findsNothing,
        reason: 'unknown provenance must not be read as “probably real”');
    expect(_text('Không hiện số liệu — chưa rõ nguồn dữ liệu'), findsOneWidget);
  });

  testWidgets('no server signal ⇒ the footer admits it, it does not say REAL',
      (tester) async {
    final server = _Server(body: payload(erpTarget: null));
    await _pumpApp(tester, server);

    expect(_text('Không rõ nguồn dữ liệu'), findsWidgets);
    expect(_text('REAL ERPNext'), findsNothing);
  });

  // ─────────────────── partial: never a fabricated zero ───────────────────

  testWidgets('a failed block shows Lỗi · Thử lại and NO 0đ in its place',
      (tester) async {
    final server = _Server(
      body: payload(
        noReceipts: true,
        partial: true,
        errors: [
          {'block': 'receipts', 'code': 'ERP_UNAVAILABLE'},
        ],
      ),
    );
    await _pumpApp(tester, server);

    expect(find.byKey(const ValueKey('summary-block-error-receipts')),
        findsOneWidget);
    expect(_text('Lỗi · chưa đọc được mục này (ERP_UNAVAILABLE)'), findsOneWidget);
    expect(_text('Thử lại'), findsOneWidget);
    // Nothing from the unread block is rendered — in particular not a zero.
    expect(_text('Tổng thu'), findsNothing);
    expect(_text('6.030.000đ'), findsNothing);
    expect(_text('Tiền khách trả hôm nay'), findsOneWidget,
        reason: 'the block is still named, so the user knows what is missing');
    // The blocks that DID succeed keep their real numbers.
    expect(_text('12.500.000đ'), findsOneWidget);
    expect(_text('10.000.000đ'), findsOneWidget);
    expect(find.byKey(const ValueKey('summary-partial-banner')), findsOneWidget);
  });

  testWidgets('an EMPTY object block is treated as unreadable, not as zero',
      (tester) async {
    // A malformed-but-object block must not be parsed into "Tổng thu 0đ" — that
    // is a money claim the server never made.
    final server = _Server(
      body: payload(receipts: <String, dynamic>{}, partial: true, errors: [
        {'block': 'receipts', 'code': 'ERP_UNAVAILABLE'},
      ]),
    );
    await _pumpApp(tester, server);

    expect(find.byKey(const ValueKey('summary-block-error-receipts')),
        findsOneWidget);
    expect(_text('Tổng thu'), findsNothing);
  });

  testWidgets('the real today: unreadable app_drafts does not blank the day',
      (tester) async {
    // This is the shape the live site returns right now (`custom_ai_action_id`
    // exists only on Payment Entry), so the screen must handle it as the
    // ordinary case: one named block with its error, everything else real.
    final server = _Server(
      body: payload(
        noAppDrafts: true,
        partial: true,
        errors: [
          {'block': 'app_drafts', 'code': 'ERP_UNAVAILABLE', 'detail': 'no field'},
        ],
      ),
    );
    await _pumpApp(tester, server);

    expect(find.byKey(const ValueKey('summary-block-error-app_drafts')),
        findsOneWidget);
    expect(_text('Số phiếu nháp'), findsNothing);
    expect(_text('12.500.000đ'), findsOneWidget);
    expect(_text('10.000.000đ'), findsOneWidget);
  });

  testWidgets('an empty day is a legitimate answer: zeros, and no error',
      (tester) async {
    final server = _Server(body: payload(quiet: true));
    await _pumpApp(tester, server);

    expect(_text('0đ'), findsWidgets);
    expect(_text('Chưa có phát sinh nào trong ngày'), findsOneWidget);
    expect(find.byKey(const ValueKey('summary-partial-banner')), findsNothing);
    expect(find.byKey(const ValueKey('summary-block-error-receipts')),
        findsNothing);
    expect(_text('Lỗi ·'), findsNothing);
  });

  testWidgets('a PARTIAL day whose flows read 0 is NOT called a quiet day',
      (tester) async {
    // The dangerous overlap: a block failed, so "all zeros" is only the zeros we
    // happen to have. Calling that a quiet day would turn an unread block into a
    // business statement.
    // Every day-flow block is present and reads 0 — the ONLY thing separating
    // this from a quiet day is the failed app_drafts read.
    final server = _Server(
      body: payload(
        quiet: true,
        noAppDrafts: true,
        partial: true,
        errors: [
          {'block': 'app_drafts', 'code': 'ERP_UNAVAILABLE'},
        ],
      ),
    );
    await _pumpApp(tester, server);

    expect(_text('Chưa có phát sinh nào trong ngày'), findsNothing);
    expect(find.byKey(const ValueKey('summary-block-error-app_drafts')),
        findsOneWidget);
  });

  testWidgets('an aged cache is labelled OLD at once, while the refresh runs',
      (tester) async {
    // The user is looking at numbers from 20 minutes ago during the whole
    // round trip — the label has to be there from the first frame, not only
    // after the request comes back.
    final prefs = _FakePrefs();
    _seedCache(prefs, payload(), age: const Duration(minutes: 20));
    final server = _Server()..gate = Completer<void>();
    await _pumpApp(tester, server, prefs: prefs, settle: false);

    expect(_text('DỮ LIỆU CŨ'), findsWidgets);
    expect(_text('12.500.000đ'), findsOneWidget);
    expect(server.calls, 1, reason: 'past the window it is already re-reading');

    server.gate!.complete();
    await tester.pumpAndSettle();
  });

  testWidgets('a cash drawer hidden by policy is SILENT, not an error',
      (tester) async {
    // No default cash account on the company ⇒ §3.6 hides the block, and that is
    // not a failure to report: the site is configured that way on purpose.
    final server = _Server(body: payload(noCashDrawer: true));
    await _pumpApp(tester, server);

    expect(_text('Két tiền mặt'), findsNothing);
    expect(_text('Lỗi ·'), findsNothing);
  });

  testWidgets('a cash drawer that could not be built SAYS so (§6 partial)',
      (tester) async {
    // Opening readable but the day's flows not: a "dự kiến" computed from half
    // the inputs would be invented money, so the block must refuse instead.
    final server = _Server(
      body: payload(
        noCashDrawer: true,
        partial: true,
        errors: [
          {'block': 'cash_drawer', 'code': 'PARTIAL_DATA'},
        ],
      ),
    );
    await _pumpApp(tester, server);

    expect(find.byKey(const ValueKey('summary-block-error-cash_drawer')),
        findsOneWidget);
    expect(_text('Dự kiến cuối ngày'), findsNothing);
  });

  // ───────────────────────── cache (§2: 30–60s) ─────────────────────────

  testWidgets('a fresh cached day costs NO request — re-opening the drawer is free',
      (tester) async {
    final prefs = _FakePrefs();
    _seedCache(prefs, payload(), age: const Duration(seconds: 5));
    final server = _Server()..offline = true; // would fail if it were called
    await _pumpApp(tester, server, prefs: prefs);

    expect(server.calls, 0, reason: 'inside the freshness window');
    expect(_text('12.500.000đ'), findsOneWidget,
        reason: 'the cached day is rendered');
    expect(_text('DỮ LIỆU CŨ'), findsNothing,
        reason: 'a few seconds old is still today\'s read, not old data');
  });

  testWidgets('a stale cache is re-read; when the gateway is down the OLD numbers stay, labelled',
      (tester) async {
    final prefs = _FakePrefs();
    _seedCache(prefs, payload(), age: const Duration(minutes: 20));
    final server = _Server()..offline = true;
    await _pumpApp(tester, server, prefs: prefs);

    expect(server.calls, 1, reason: 'past the window it must try again');
    expect(_text('DỮ LIỆU CŨ'), findsWidgets);
    expect(_text('12.500.000đ'), findsOneWidget,
        reason: 'the last known day is kept, not replaced by an error page');
    expect(_text('Chưa cập nhật được'), findsOneWidget);
    expect(find.byKey(const ValueKey('summary-stale-banner')), findsOneWidget);
    expect(_text('Không kết nối được máy chủ'), findsWidgets);
  });

  testWidgets('offline with NO cache refuses honestly instead of showing zeros',
      (tester) async {
    final server = _Server()..offline = true;
    await _pumpApp(tester, server);

    expect(_text('Lỗi · không đọc được tóm tắt ngày'), findsOneWidget);
    expect(_text('0đ'), findsNothing);
  });

  testWidgets('a corrupt cache does not block the live read', (tester) async {
    final prefs = _FakePrefs();
    prefs.store[AppConstants.dailySummaryCacheStorageKey] = '{"not":"a day"';
    final server = _Server();
    await _pumpApp(tester, server, prefs: prefs);

    expect(server.calls, 1);
    expect(_text('10.000.000đ'), findsOneWidget);
  });

  // ───────────────────── no write path, banned labels ─────────────────────

  testWidgets('the summary screen offers no write affordance and no /execute',
      (tester) async {
    final server = _Server();
    await _pumpApp(tester, server);

    expect(server.touchedExecute, isFalse);
    expect(find.byType(TextField), findsNothing,
        reason: 'no free-text entry here — §4.4 forbids typing at a classifier');
    for (final banned in [
      'Xác nhận',
      'Gửi',
      'Tạo phiếu',
      'Ghi nhận',
      'Submit',
    ]) {
      expect(_text(banned), findsNothing, reason: '"$banned" is a write affordance');
    }
    // Structural, not just wording: with nothing failed there is no button at
    // all on this screen (a retry is the only one that may exist, and only for a
    // failed block). P4-6: yesterday's read arriving with PARTIAL meta (the
    // test server answers the same body for both days) renders its own
    // per-block retries — still read-only affordances, never write ones.
    expect(find.byType(FilledButton), findsNothing);
    expect(find.byType(ElevatedButton), findsNothing);
    // (the AppBar's drawer IconButton is navigation, not a write affordance)
    // Every TextButton on this screen must be a RETRY or a DAY PICK (P4-6's
    // SegmentedButton renders as TextButtons internally): read rendered labels
    // through the widget tree rather than assuming the child's shape. Anything
    // else — a Submit/Xác nhận/Gửi in button form — fails here.
    final allowedLabels = {'Thử lại', 'Hôm nay', 'Hôm qua'};
    final labels = find.byType(TextButton).evaluate().map((e) {
      final text = find.descendant(
        of: find.byWidgetPredicate((w) => identical(w, e.widget)),
        matching: find.byType(Text),
      );
      return text.evaluate().map((t) => (t.widget as Text).data).join(' ');
    }).toSet();
    expect(labels.difference(allowedLabels), isEmpty,
        reason: 'only retries and the day picker may be buttons on a read screen (found: $labels)');
  });

  testWidgets('the screen never calls anything "Doanh thu" (§3.1)', (tester) async {
    final server = _Server();
    await _pumpApp(tester, server);

    expect(_text('Doanh thu'), findsNothing);
    // …and it names the two real things instead.
    expect(_text('Hóa đơn đã xuất hôm nay'), findsOneWidget);
    expect(_text('Tiền khách trả hôm nay'), findsOneWidget);
  });

  // ─────────────────── P4-6: hôm nay | hôm qua (§6) ───────────────────

  testWidgets('P4-6: the selector defaults to Hôm nay — opening the screen reads ONLY today',
      (tester) async {
    final server = _Server();
    await _pumpApp(tester, server);

    expect(find.byKey(const ValueKey('day-selector')), findsOneWidget);
    expect(_text('Hôm nay'), findsOneWidget);
    expect(_text('Hôm qua'), findsOneWidget);
    // Yesterday is OPTIONAL data: it must not cost an ERP read until asked for.
    expect(server.calls, 1);
    expect(server.requestedDates, [null],
        reason: 'today is asked for with NO date — the server decides the shop\'s day');
    // Today by default: the invoice card names hôm nay and shows TODAY's number.
    expect(_text('Hóa đơn đã xuất hôm nay (giá trị sau VAT)'), findsOneWidget);
    expect(_text('${_fmtVnd(kInvoice)}đ'), findsOneWidget);

    // Picking Hôm qua is what triggers the second read — for THAT day.
    await tester.tap(find.text('Hôm qua'));
    await tester.pumpAndSettle();
    expect(server.calls, 2);
    expect(server.requestedDates, [null, _yesterdayVn()],
        reason: 'the second read names the previous SHOP day, exactly once');
  });

  testWidgets('P4-6: picking Hôm qua swaps bán/thu to the PREVIOUS day\'s NUMBERS',
      (tester) async {
    final yesterdayBody = payload();
    // Distinct yesterday figures, so an assertion on an amount can only be met
    // by the previous day's read — never by a leftover of today's.
    (yesterdayBody['sales_invoices'] as Map<String, dynamic>)['amount'] = kInvoice - 2000000;
    (yesterdayBody['receipts'] as Map<String, dynamic>)['total'] = kReceiptsTotal + 500000;
    final server = _Server(
      byDate: {
        // The yesterday request carries the client-derived previous calendar day.
        _yesterdayVn(): yesterdayBody,
      },
    );
    await _pumpApp(tester, server);
    await tester.tap(find.text('Hôm qua'));
    await tester.pumpAndSettle();

    // BOTH the title AND the figure name the day being viewed. The bug this
    // closes was exactly the split: a "hôm qua" title over today's number.
    expect(_text('Hóa đơn đã xuất hôm qua (giá trị sau VAT)'), findsOneWidget);
    expect(_text('Tiền khách trả hôm qua'), findsOneWidget);
    expect(_text('${_fmtVnd(kInvoice - 2000000)}đ'), findsOneWidget,
        reason: 'the invoice card must show YESTERDAY\'s amount, not today\'s');
    expect(_text('${_fmtVnd(kReceiptsTotal + 500000)}đ'), findsOneWidget,
        reason: 'the receipts card must show YESTERDAY\'s total, not today\'s');
    // Today's own numbers are gone from those two cards while yesterday is shown.
    expect(_text('${_fmtVnd(kInvoice)}đ'), findsNothing);
    expect(_text('${_fmtVnd(kReceiptsTotal)}đ'), findsNothing);
    // The SO block is not one of the §6 day-scoped metrics: it keeps its
    // day-neutral title (and today's numbers).
    expect(_text('Đơn hàng (Sales Order) — gồm nháp'), findsOneWidget);
    // §6 forbade percentages; the screen must never render one.
    expect(find.textContaining('%', findRichText: true), findsNothing,
        reason: '§6: percentages mislead against an irregular day — absolute numbers only');
  });

  testWidgets('P4-6: a PARTIAL yesterday still shows its OWN numbers, never today\'s',
      (tester) async {
    final yesterdayBody = payload()..['meta']['partial'] = true;
    final server = _Server(
      byDate: {_yesterdayVn(): yesterdayBody},
    );
    await _pumpApp(tester, server);
    await tester.tap(find.text('Hôm qua'));
    await tester.pumpAndSettle();

    // Yesterday WAS read (partial = one block failed, not the whole day), so its
    // figures are shown under its OWN title — not replaced by today's.
    expect(_text('Hóa đơn đã xuất hôm qua (giá trị sau VAT)'), findsOneWidget);
    expect(_text('${_fmtVnd(kInvoice)}đ'), findsOneWidget);
    // The current-debt block is untouched by the day pick.
    expect(_text('Công nợ hiện tại (phải thu)'), findsOneWidget);
  });

  testWidgets('P4-6: a FAILED yesterday read shows NO figure under the hôm qua title',
      (tester) async {
    // The failure mode this fix must not miss: a "hôm qua" card may NEVER
    // silently fall back to today's number. It shows no figure at all, and
    // offers a retry. The read fails by DATE, so today's request still succeeds.
    final server = _Server()..failDates.add(_yesterdayVn());
    await _pumpApp(tester, server);
    await tester.tap(find.text('Hôm qua'));
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('summary-day-not-read-sales_invoices')),
        findsOneWidget);
    expect(find.byKey(const ValueKey('summary-day-not-read-receipts')),
        findsOneWidget);
    // Neither day's figure may appear under the "hôm qua" title.
    expect(_text('${_fmtVnd(kInvoice)}đ'), findsNothing);
    expect(_text('${_fmtVnd(kReceiptsTotal)}đ'), findsNothing);
    // The rest of the screen (current debt) is unaffected, and a failed
    // YESTERDAY is not a failure of THIS screen.
    expect(_text('Công nợ hiện tại (phải thu)'), findsOneWidget);
    expect(find.byKey(const ValueKey('summary-stale-banner')), findsNothing);
  });

  testWidgets('P4-6: viewing Hôm qua annotates the debt note; debt stays CURRENT',
      (tester) async {
    final server = _Server();
    await _pumpApp(tester, server);
    await tester.tap(find.text('Hôm qua'));
    await tester.pumpAndSettle();

    expect(_text('Đang xem HÔM QUA'), findsOneWidget);
    expect(_text('công nợ và số nháp vẫn là số HIỆN TẠI'), findsOneWidget);
    // The receivables block itself is untouched by the day pick — it keeps
    // today's (current) number even while viewing yesterday.
    expect(_text('${_fmtVnd(kOutstanding)}đ'), findsOneWidget);
  });

  testWidgets('P4-6: the drill follows the SELECTED day — it carries the date the SERVER named, and today sends none',
      (tester) async {
    final yesterdayBody = payload()..['meta'] = {
        ...payload()['meta'] as Map<String, dynamic>,
        'date': _yesterdayVn(),
      };
    final server = _Server(byDate: {_yesterdayVn(): yesterdayBody});
    await _pumpApp(tester, server);

    // Viewing TODAY: the drill sends NO date, so the server's own "today" applies.
    await tester.tap(find.byKey(const ValueKey('drill-invoices_today')));
    await tester.pumpAndSettle();
    expect(server.drillDates, [null],
        reason: 'today must not be asserted by the phone (§3.7)');

    // Back to the summary, then view YESTERDAY and drill again.
    await tester.pageBack();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Hôm qua'));
    // The yesterday read is on-demand and ASYNC: pumpAndSettle alone can return
    // before the response lands (a pending Future schedules no frame), which is
    // exactly how this test first passed with a null date. Pump, let the last
    // future settle, then pump the rebuild it triggers.
    await tester.pump();
    await tester.pumpAndSettle();
    // Precondition for the assertion below: the view really did switch days, and
    // that day's read actually landed (the delta only exists with both days).
    expect(_text('Tiền khách trả hôm qua'), findsOneWidget);
    expect(find.byKey(const ValueKey('summary-day-not-read-sales_invoices')),
        findsNothing,
        reason: 'precondition: yesterday\'s read landed, so the card shows it');
    await tester.tap(find.byKey(const ValueKey('drill-invoices_today')));
    await tester.pumpAndSettle();

    // The second drill must read the DAY BEING VIEWED, named by the server's own
    // meta.date for that response — never a date this phone computed.
    expect(server.drillDates, [null, _yesterdayVn()]);
  });

  // ────────────────────── D4: clear state on server switch ──────────────────────

  testWidgets('D4: a NEW server/account makes the MOUNTED drawer re-read — the old books never stay on screen',
      (tester) async {
    // §2.4 / review6. The Settings screen clears the PERSISTED cache (asserted in
    // settings_test.dart). This half is the other one: the summary screen that is
    // still mounted in the stack when the user comes back must not keep showing
    // the previous server's day. A Settings save invalidates the settings
    // service, which rebuilds the API client — the screen listens for exactly
    // that and re-reads.
    final server = _Server();
    final prefs = _FakePrefs();
    await _pumpAppWithLiveClient(tester, server, prefs: prefs);
    expect(server.calls, 1);

    ProviderScope.containerOf(
      tester.element(find.byType(DailySummaryScreen)),
      listen: false,
    ).invalidate(appSettingsServiceProvider);
    await tester.pumpAndSettle();

    expect(server.calls, 2,
        reason: 'another server/account must re-read, not replay the previous books');
    expect(server.requestedDates, [null, null],
        reason: 'the re-read is still "today at the shop" — the phone picks no day');
  });

  // ─────────────────────────── drawer (§2) ───────────────────────────

  testWidgets('the chat drawer leads with Tóm tắt ngày as the default item',
      (tester) async {
    final server = _Server();
    await _pumpApp(tester, server, route: '/chat');
    expect(server.calls, 0, reason: 'chat reads nothing until asked');

    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();

    expect(_text('Tóm tắt ngày'), findsOneWidget);
    expect(_text('Mặc định'), findsOneWidget);
    expect(_text('Hôm nay · giờ Việt Nam'), findsOneWidget);
    // Not-yet-built sections say so instead of offering a button that guesses.
    // (D1 enabled Công nợ + Nợ quá hạn; D1c enabled HĐ chưa trả; D2 enabled
    // Tồn kho nóng; D3 enabled Nháp hôm nay — the drawer's 5 items are now all
    // live, so NOTHING in it may still say "sắp có".)
    expect(_text('Sắp có (bước P4-4)'), findsNothing);
    expect(_text('Sắp có (bước D1c)'), findsNothing,
        reason: 'D1c turned HĐ chưa trả into a drill — it no longer says soon');
    expect(_text('Sắp có (bước D2)'), findsNothing,
        reason: 'D2 turned Tồn kho nóng into a drill — it no longer says soon');
    expect(_text('Sắp có (bước D3)'), findsNothing,
        reason: 'D3 turned Nháp hôm nay into a drill — it no longer says soon');
    // Still no write affordance in the drawer.
    for (final banned in ['Xác nhận', 'Thu tiền', 'Tạo phiếu', 'Submit']) {
      expect(_text(banned), findsNothing);
    }

    await tester.tap(find.text('Tóm tắt ngày'));
    await tester.pumpAndSettle();

    expect(server.calls, 1, reason: 'the drawer item opens the day summary');
    expect(server.touchedExecute, isFalse);
    expect(_text('THEO DÕI'), findsNothing, reason: 'the drawer closed');
  });

  testWidgets('from the summary screen the drawer shows the real provenance',
      (tester) async {
    final server = _Server(body: payload(erpTarget: 'MOCK'), erpTarget: 'MOCK');
    await _pumpApp(tester, server);

    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();

    expect(_text('MOCK (dữ liệu giả lập)'), findsWidgets);
    expect(_text('Cập nhật '), findsWidgets);
    expect(_text('Minh Phát Cám & VLXD'), findsWidgets);
  });

  testWidgets('Settings is still reachable from the drawer', (tester) async {
    final server = _Server();
    await _pumpApp(tester, server, route: '/chat');

    await tester.tap(find.byIcon(Icons.menu));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Server / đăng nhập'));
    await tester.pumpAndSettle();

    expect(_text('Cài đặt'), findsWidgets);
    expect(server.calls, 0, reason: 'opening Settings reads no day');
  });

  // ───────────────────────── parser (unit) ─────────────────────────

  group('DailySummary parsing', () {
    test('a null block stays null — it is not a zeroed block', () {
      final s = DailySummary.fromJson(payload(noReceipts: true));
      expect(s.receipts, isNull);
      expect(s.salesInvoices?.amount, kInvoice);
    });

    test('blocks parse independently: one bad shape does not wipe the day', () {
      final body = payload()
        ..['receipts'] = 'Internal Server Error'
        ..['sales_orders'] = null;
      final s = DailySummary.fromJson(body);
      expect(s.receipts, isNull);
      expect(s.salesOrders, isNull);
      expect(s.salesInvoices?.amount, kInvoice);
      expect(s.receivables?.outstandingTotal, kOutstanding);
      expect(s.cashDrawer?.expectedClosing, kCashClosing);
    });

    test('meta carries the day, the target and the per-block errors', () {
      final s = DailySummary.fromJson(payload(
        erpTarget: 'MOCK',
        partial: true,
        errors: [
          {'block': 'app_drafts', 'code': 'ERP_UNAVAILABLE', 'detail': 'no field'},
        ],
      ));
      expect(s.meta.date, '2026-09-21');
      expect(s.meta.timezone, 'Asia/Ho_Chi_Minh');
      expect(s.meta.erpTarget, 'MOCK');
      expect(s.meta.company, 'Minh Phát Cám & VLXD');
      expect(s.meta.partial, isTrue);
      expect(s.meta.errorFor('app_drafts')?.code, 'ERP_UNAVAILABLE');
      expect(s.meta.errorFor('receipts'), isNull);
      expect(s.meta.generatedAt, isNotNull);
    });

    test('unclassified money is preserved, not folded into cash or bank', () {
      final s = DailySummary.fromJson(payload(receipts: {
        'against_invoice': 0,
        'advances': 0,
        'cash': kReceiptsCash,
        'bank': 0,
        'unclassified': 500000,
        'total': kReceiptsCash + 500000,
      }));
      expect(s.receipts?.unclassified, 500000);
      expect(s.receipts?.cash, kReceiptsCash);
    });
  });
}
