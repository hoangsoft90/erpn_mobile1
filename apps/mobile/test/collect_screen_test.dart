import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/app/router/app_router.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/collect/application/collect_controller.dart';
import 'package:erpn_mobile/features/collect/data/collect_models.dart';

/// next8 Phase 2 — the 20 §5.3 states of the collect screen (T1–T20).
///
/// The properties these tests defend, per the owner locks:
///  - §6.1: ONE payment method per collection (the UI cannot hold two, T20);
///  - §6.2: only correctly-typed accounts are offered, no silent cash
///    fallback (T17);
///  - §6.3: zero open invoices ⇒ the on-account path works and is copy-labelled
///    (T6); open invoices with nothing allocated ⇒ blocked with its copy (T19);
///  - §6.4: ≤10 rows + the honest "còn N kết quả" + working search (T14);
///  - no auto-allocation (F1's oracle, T9); no submission on mismatch (T12);
///    one tap = one request (T18); stale INVOICE_ALREADY_PAID reloads (T13)
///    and its reload cannot write state after the screen went away (T15c);
///    a stale handoff shows the SERVER's copy (T16); changing customer reloads
///    (T15, epoch guard) and clears every ticked allocation (T15b, driven at
///    the controller because the Phase-2 screen has no customer picker).
///
/// The screen is driven through the REAL app router (`/collect` extra) with the
/// client pointed at a mock Dio adapter — the same harness read_drilldown_test
/// uses, so what ships is what runs.
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

Map<String, dynamic> _slot(String state, {String? id, String? label, List<String>? candidates}) => {
      'state': state,
      'id': ?id,
      'label': ?label,
      'candidates': ?candidates,
    };

/// The handoff the server issues for "Thu tiền cho anh Ba ba triệu" (T1's
/// sentence shape): customer RESOLVED, amount RESOLVED, allocation state to be
/// answered by the read.
BusinessHandoff resolvedHandoff({
  Map<String, dynamic> customerSlot = const {},
  bool hasOpenInvoices = true,
}) {
  return BusinessHandoff(
    handoffId: 'HF-TEST-001',
    capability: 'payment.create',
    screen: 'collect',
    question: 'Thu tiền cho anh Ba ba triệu',
    prefill: {
      'customer': customerSlot.isNotEmpty
          ? CollectPrefillSlot.fromJson(customerSlot)
          : const CollectPrefillSlot(
              state: CollectSlotState.resolved, id: 'CUST-00001', label: 'Anh Ba'),
      'allocations': const CollectPrefillSlot(state: CollectSlotState.missing),
      'payment_methods': const CollectPrefillSlot(state: CollectSlotState.missing),
      'amount': const CollectPrefillSlot(state: CollectSlotState.resolved),
    },
    issuedAt: '2026-09-29T10:00:00.000Z',
  );
}

/// A handoff with NO usable customer slot (T3/T5's shape).
BusinessHandoff unresolvedHandoff(String state, {List<String>? candidates}) {
  return BusinessHandoff(
    handoffId: 'HF-TEST-002',
    capability: 'payment.create',
    screen: 'collect',
    question: 'thu tiền',
    prefill: {
      'customer': CollectPrefillSlot.fromJson(
          _slot(state, label: state == 'AMBIGUOUS' ? 'anh Ba' : null, candidates: candidates)),
      'allocations': const CollectPrefillSlot(state: CollectSlotState.missing),
      'payment_methods': const CollectPrefillSlot(state: CollectSlotState.missing),
      'amount': const CollectPrefillSlot(state: CollectSlotState.resolved),
    },
  );
}

/// The `/read/list` page the server would answer for the resolved customer.
Map<String, dynamic> readPage({
  List<Map<String, dynamic>> rows = const [
    {'name': 'SINV-0001', 'date': '2026-09-01', 'outstanding_vnd': 2500000, 'total_vnd': 10500000, 'is_return': false},
    {'name': 'SINV-0002', 'date': '2026-09-05', 'outstanding_vnd': 1200000, 'total_vnd': 1200000, 'is_return': false},
  ],
  int? matchedTotal,
  bool truncated = false,
}) =>
    {
      'screen': 'customer_account',
      'title': 'Công nợ & chứng từ',
      'entity': {'kind': 'customer', 'id': 'CUST-00001', 'name': 'Anh Ba'},
      'company': 'Demo Feed Co',
      'limit': 10,
      'erp_target': 'REAL',
      'generated_at': '2026-09-29T10:00:00.000Z',
      'summary': {'outstanding_vnd': 3700000, 'open_documents': rows.length, 'matched_total': matchedTotal ?? rows.length},
      'total_documents': rows.length,
      'truncated': truncated,
      'rows': rows,
    };

Map<String, dynamic> accountsPayload({
  List<Map<String, dynamic>>? cash,
  List<Map<String, dynamic>>? bank,
}) =>
    {
      'company': 'Demo Feed Co',
      'cash': cash ??
          [
            {'account': '1110 - Cash - DFC', 'label': '1110 - Cash', 'account_type': 'Cash', 'company': 'Demo Feed Co'},
          ],
      'bank': bank ??
          [
            {'account': '1120 - Bank - DFC', 'label': '1120 - Bank', 'account_type': 'Bank', 'company': 'Demo Feed Co'},
          ],
      'defaults': {
        'cash': '1110 - Cash - DFC',
        'bank': '1120 - Bank - DFC',
      },
      'resolved': {'Cash': (cash ?? const []).isNotEmpty, 'Bank': (bank ?? const []).isNotEmpty},
    };

/// Records every request path + body so "one tap = one request" and "no write
/// path" are observable on the Dio the client actually uses.
class _Router {
  _Router();

  final List<String> paths = [];
  final List<Map<String, dynamic>> bodies = [];
  final List<int> proposeStatuses = [];

  Map<String, dynamic> readPageResult = readPage();
  Map<String, dynamic> accountsResult = accountsPayload();
  Map<String, dynamic> proposeResult = {'ok': true, 'proposal': {'action': 'create_payment_entry'}};
  int proposeStatus = 200;
  int readStatus = 200;
  int accountsStatus = 200;

  // Delaying the read response lets a test prove the epoch guard: an OLD
  // response must never overwrite a NEWER customer's state.
  bool delayRead = false;

  int calls(String path) => paths.where((p) => p == path).length;

  Handler get handler => (options) async {
        paths.add(options.path);
        final raw = options.data;
        final body = raw is String
            ? jsonDecode(raw) as Map<String, dynamic>
            : (raw as Map<String, dynamic>? ?? const {});
        bodies.add(body);
        if (options.path == '/read/list') {
          // SNAPSHOT the payload AT REQUEST TIME: a slow response must carry
          // the data that existed when it was issued — that is exactly what a
          // stale response is, and what the epoch guard defends against.
          final page = readPageResult;
          if (delayRead) {
            delayRead = false;
            await Future<void>.delayed(const Duration(milliseconds: 300));
          }
          if (readStatus != 200) return _json(page, readStatus);
          return _json({'ok': true, 'result': page});
        }
        if (options.path == '/collect/accounts') {
          if (accountsStatus != 200) return _json(accountsResult, accountsStatus);
          return _json({'ok': true, 'result': accountsResult});
        }
        if (options.path == '/collect/propose') {
          proposeStatuses.add(proposeStatus);
          return _json(proposeResult, proposeStatus);
        }
        return _json({'ok': false, 'error': 'unexpected ${options.path}'}, 404);
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

/// Boots the REAL app router at `/chat`, then pushes `/collect` exactly the way
/// the chat screen does (the parsed FULL ticket as `extra`).
///
/// [settle] false leaves the FIRST read in flight (T15 uses it to overlap two
/// reads and exercise the epoch guard) — the test then pumps manually.
Future<void> _pumpCollect(WidgetTester tester, _Router router, BusinessHandoff handoff, {bool settle = true}) async {
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
  // ignore: unawaited_futures
  appRouter.push('/collect', extra: handoff);
  if (settle) {
    await tester.pumpAndSettle();
  } else {
    await tester.pump();
    await tester.pump();
  }
}

Finder get _confirm => find.byKey(const ValueKey('collect-confirm'));
Finder get _amountField => find.byKey(const ValueKey('collect-amount'));

/// Types the total into the method's amount field (the screen's ONE amount
/// input, T2's "số tiền trống" is simply not typing).
Future<void> _typeAmount(WidgetTester tester, String text) async {
  await tester.enterText(_amountField, text);
  await tester.pump();
}

/// Ticks one invoice chip (its prefill becomes the server's outstanding).
Future<void> _tickInvoice(WidgetTester tester, String id) async {
  // Scrolled-out rows tap nothing: bring the checkbox into the hit-test area
  // first (the same off-screen rule the method/confirm helpers follow).
  await tester.ensureVisible(find.byKey(ValueKey('invoice-check-$id')));
  await tester.pump();
  await tester.tap(find.byKey(ValueKey('invoice-check-$id')));
  await tester.pump();
}

Future<void> _chooseMethod(WidgetTester tester, String label) async {
  // The method block sits BELOW the fold on the test viewport — scroll it into
  // the hit-test area first (a tap at an off-screen offset is silently a no-op).
  await tester.ensureVisible(find.text(label));
  await tester.pump();
  await tester.tap(find.text(label), warnIfMissed: false);
  await tester.pump();
}

/// Scrolls the confirm button into view, then taps it (same off-screen rule).
Future<void> _tapConfirm(WidgetTester tester) async {
  await tester.ensureVisible(_confirm);
  await tester.pump();
  await tester.tap(_confirm, warnIfMissed: false);
  await tester.pump();
}

void main() {
  setUp(() {
    appRouter.go('/chat');
  });

  testWidgets('T1: resolved customer opens preselected, NOTHING auto-allocated, total not matching yet', (tester) async {
    final router = _Router();
    await _pumpCollect(tester, router, resolvedHandoff());
    expect(find.text('Anh Ba'), findsOneWidget);
    expect(find.byKey(ValueKey('invoice-check-SINV-0001')), findsOneWidget);
    // No auto-allocation: no invoice chip starts ticked.
    expect(tester.widget<Checkbox>(find.byKey(ValueKey('invoice-check-SINV-0001'))).value, isFalse);
    expect(tester.widget<Checkbox>(find.byKey(ValueKey('invoice-check-SINV-0002'))).value, isFalse);
    // Total not matching yet: the confirm button is OFF.
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNull);
  });

  testWidgets('T2: amount slot RESOLVED but no figure travels — the amount field starts EMPTY', (tester) async {
    final router = _Router();
    await _pumpCollect(tester, router, resolvedHandoff());
    // The handoff NEVER carries an authoritative number: the field is empty
    // even though the sentence said "ba triệu".
    expect(find.textContaining('3.000.000'), findsNothing);
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNull);
  });

  testWidgets('T3: MISSING customer — no read issued, confirm blocked', (tester) async {
    final router = _Router();
    await _pumpCollect(tester, router, unresolvedHandoff('MISSING'));
    expect(find.byKey(const ValueKey('collect-customer-missing')), findsOneWidget);
    expect(router.calls('/read/list'), 0, reason: 'no id ⇒ no read — never a guessed customer');
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNull);
  });

  testWidgets('T4: AMBIGUOUS customer — the ticket candidates are SHOWN, none auto-picked', (tester) async {
    final router = _Router();
    await _pumpCollect(
      tester,
      router,
      unresolvedHandoff('AMBIGUOUS', candidates: ['Anh Ba', 'Ba Sơn']),
    );
    // The label echoes inside "Câu nói: anh Ba"; the candidates render as
    // their own chips. NONE of them is a selection.
    expect(find.textContaining('Câu nói: anh Ba'), findsOneWidget);
    expect(find.byKey(const ValueKey('collect-candidate-Anh Ba')), findsOneWidget);
    expect(find.byKey(const ValueKey('collect-candidate-Ba Sơn')), findsOneWidget);
    expect(router.calls('/read/list'), 0);
  });

  testWidgets('T5: NO_MATCH customer — refusal copy, no invoice list, confirm blocked', (tester) async {
    final router = _Router();
    await _pumpCollect(tester, router, unresolvedHandoff('NO_MATCH'));
    expect(find.byKey(const ValueKey('collect-customer-missing')), findsOneWidget);
    expect(find.byKey(const ValueKey('collect-invoice-block')), findsNothing);
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNull);
  });

  testWidgets('T6: ZERO open invoices — on-account allowed with its copy (lock 6.3)', (tester) async {
    final router = _Router()..readPageResult = readPage(rows: []);
    await _pumpCollect(tester, router, resolvedHandoff());
    expect(find.byKey(const ValueKey('collect-on-account-copy')), findsOneWidget);
    await _typeAmount(tester, '3000000');
    await _chooseMethod(tester, 'Tiền mặt');
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNotNull, reason: 'zero open ⇒ empty allocation IS the legal shape');
  });

  testWidgets('T7: one invoice, paid in full — allocated equals outstanding', (tester) async {
    final router = _Router()..readPageResult = readPage();
    await _pumpCollect(tester, router, resolvedHandoff());
    await _tickInvoice(tester, 'SINV-0001'); // prefill = 2.500.000 (server's)
    await _typeAmount(tester, '2500000');
    await _chooseMethod(tester, 'Tiền mặt');
    await tester.pumpAndSettle();
    // The key IS on the total Text itself (not a parent) — read the widget.
    expect(
      tester.widget<Text>(find.byKey(const ValueKey('allocated-total'))).data,
      '2.500.000đ',
    );
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNotNull);
  });

  testWidgets('T8: one invoice, part payment — remaining shown', (tester) async {
    final router = _Router()..readPageResult = readPage();
    await _pumpCollect(tester, router, resolvedHandoff());
    await _tickInvoice(tester, 'SINV-0001');
    await tester.enterText(find.byKey(ValueKey('invoice-amount-SINV-0001')), '1000000');
    await tester.pump();
    await _typeAmount(tester, '1000000');
    await _chooseMethod(tester, 'Tiền mặt');
    await tester.pumpAndSettle();
    expect(find.textContaining('còn lại 2.500.000đ'), findsOneWidget);
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNotNull);
  });

  testWidgets('T9 + no auto-allocation: two invoices stay UNTICKED until the user ticks; totals must match by hand', (tester) async {
    final router = _Router()..readPageResult = readPage();
    await _pumpCollect(tester, router, resolvedHandoff());
    // The typed total is NOT spread over the invoices automatically:
    await _typeAmount(tester, '3700000');
    await tester.pump();
    expect(tester.widget<Checkbox>(find.byKey(ValueKey('invoice-check-SINV-0001'))).value, isFalse);
    expect(tester.widget<Checkbox>(find.byKey(ValueKey('invoice-check-SINV-0002'))).value, isFalse);
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNull, reason: 'nothing allocated ⇒ submit stays blocked (no FIFO/oldest/equal split)');
    // Allocate each by hand, and the submit unblocks:
    await _tickInvoice(tester, 'SINV-0001');
    await _tickInvoice(tester, 'SINV-0002');
    await _typeAmount(tester, '3700000');
    await _chooseMethod(tester, 'Tiền mặt');
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNotNull);
  });

  testWidgets('T10: amount above the outstanding — inline error, no submit', (tester) async {
    final router = _Router()..readPageResult = readPage();
    await _pumpCollect(tester, router, resolvedHandoff());
    await _tickInvoice(tester, 'SINV-0001');
    await tester.enterText(find.byKey(ValueKey('invoice-amount-SINV-0001')), '9999999');
    await tester.pump();
    expect(find.text('Số tiền phải lớn hơn 0 và không vượt quá số còn nợ.'), findsOneWidget);
    await _typeAmount(tester, '9999999');
    await _chooseMethod(tester, 'Tiền mặt');
    await tester.pumpAndSettle();
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNull);
  });

  testWidgets('T11: zero amount — inline error and blocked submit', (tester) async {
    final router = _Router()..readPageResult = readPage();
    await _pumpCollect(tester, router, resolvedHandoff());
    await _tickInvoice(tester, 'SINV-0001');
    await tester.enterText(find.byKey(ValueKey('invoice-amount-SINV-0001')), '0');
    await tester.pump();
    expect(find.text('Số tiền phải lớn hơn 0 và không vượt quá số còn nợ.'), findsOneWidget);
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNull);
  });

  testWidgets('T12: allocated total ≠ method total — blocked + warning', (tester) async {
    final router = _Router()..readPageResult = readPage();
    await _pumpCollect(tester, router, resolvedHandoff());
    await _tickInvoice(tester, 'SINV-0001'); // 2.500.000 prefill
    await _typeAmount(tester, '2000000');
    await _chooseMethod(tester, 'Tiền mặt');
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('mismatch-warning')), findsOneWidget);
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNull, reason: 'a mismatched total must never reach the server');
    expect(router.calls('/collect/propose'), 0);
  });

  testWidgets('T13: INVOICE_ALREADY_PAID — allocations dropped + re-read issued', (tester) async {
    final router = _Router()
      ..readPageResult = readPage()
      ..proposeResult = {'ok': false, 'code': 'INVOICE_ALREADY_PAID', 'reason': 'hoá đơn đã được thanh toán'};
    await _pumpCollect(tester, router, resolvedHandoff());
    await _tickInvoice(tester, 'SINV-0001');
    await _typeAmount(tester, '2500000');
    await _chooseMethod(tester, 'Tiền mặt');
    await tester.pumpAndSettle();
    final readsBefore = router.calls('/read/list');
    await _tapConfirm(tester);
    await tester.pumpAndSettle();
    expect(router.calls('/collect/propose'), 1);
    expect(router.calls('/read/list'), greaterThan(readsBefore), reason: 'the list is re-read after the race');
    expect(find.byKey(const ValueKey('collect-propose-refusal')), findsOneWidget);
    expect(find.text('hoá đơn đã được thanh toán'), findsOneWidget);
  });

  testWidgets('T14: 12 invoices — 10 shown, honest "còn N", search narrows via q', (tester) async {
    final rows = List.generate(12, (i) => {
          'name': 'SINV-${(i + 1).toString().padLeft(4, '0')}',
          'date': '2026-09-${(i % 28 + 1).toString().padLeft(2, '0')}',
          'outstanding_vnd': 100000 * (i + 1),
          'total_vnd': 100000 * (i + 1),
          'is_return': false,
        });
    // The SERVER clamps the page to the contract limit (10) — the mock answers
    // exactly what the real route serves: a full page + the honest totals.
    final router = _Router()
      ..readPageResult = readPage(rows: rows.take(10).toList(), matchedTotal: 12, truncated: true);
    await _pumpCollect(tester, router, resolvedHandoff());
    expect(find.byKey(ValueKey('invoice-tile-SINV-0001')), findsOneWidget);
    expect(find.byKey(ValueKey('invoice-tile-SINV-0011')), findsNothing, reason: 'page cap 10 — a long list never renders whole');
    expect(find.byKey(const ValueKey('collect-more-results')), findsOneWidget);
    expect(find.textContaining('Còn 2 kết quả khác'), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('collect-search')), '0005');
    await tester.pumpAndSettle();
    final readBody = router.bodies.lastWhere((b) => b.containsKey('q') || true);
    expect(readBody['q'], '0005', reason: 'the search text travels to the server (skill-side filter)');
  });

  testWidgets('T15: epoch guard — a SLOW old answer never overwrites the new state', (tester) async {
    final router = _Router()..delayRead = true;
    // settle:false ⇒ the FIRST read (epoch 1, snapshotting the OLD page) is
    // still in flight when the next step fires a newer one.
    await _pumpCollect(tester, router, resolvedHandoff(), settle: false);
    router.readPageResult = readPage(rows: [
      {'name': 'SINV-NEW-1', 'date': '2026-09-09', 'outstanding_vnd': 7000000, 'total_vnd': 7000000, 'is_return': false},
    ]);
    router.delayRead = false;
    // The second read (epoch 2) carries the NEW page and answers first; the
    // SLOW epoch-1 answer lands last with the OLD page. (Several manual pumps:
    // the first read is still pending, so pumpAndSettle would hang here.)
    await tester.pump(const Duration(milliseconds: 50));
    await tester.pump(const Duration(milliseconds: 50));
    await tester.enterText(find.byKey(const ValueKey('collect-search')), 'x');
    await tester.pump();
    await tester.pumpAndSettle();
    // The NEW data won — the late OLD answer was dropped by the epoch guard:
    expect(find.textContaining('SINV-NEW-1'), findsWidgets);
    expect(find.textContaining('SINV-0001'), findsNothing,
        reason: 'a stale response for the earlier epoch must be dropped, not merged');
  });

  testWidgets('T16: STALE_HANDOFF — the SERVER\'s Vietnamese refusal is shown verbatim, no resubmit of the old ticket', (tester) async {
    final router = _Router()
      ..readPageResult = readPage()
      ..proposeResult = {'ok': false, 'code': 'STALE_HANDOFF', 'reason': 'phiên thu tiền này không còn dùng được'};
    await _pumpCollect(tester, router, resolvedHandoff());
    await _tickInvoice(tester, 'SINV-0001');
    await _typeAmount(tester, '2500000');
    await _chooseMethod(tester, 'Tiền mặt');
    await tester.pumpAndSettle();
    await _tapConfirm(tester);
    await tester.pumpAndSettle();
    expect(find.text('phiên thu tiền này không còn dùng được'), findsOneWidget);
    expect(router.calls('/collect/propose'), 1, reason: 'no silent retry of a dead ticket');
  });

  testWidgets('T17: method without a correctly-typed account — blocked with its own copy, never a cash fallback (lock 6.2)', (tester) async {
    final router = _Router()
      ..readPageResult = readPage()
      ..accountsResult = accountsPayload(bank: []);
    await _pumpCollect(tester, router, resolvedHandoff());
    await _tickInvoice(tester, 'SINV-0001');
    await _typeAmount(tester, '2500000');
    await _chooseMethod(tester, 'Chuyển khoản');
    await tester.pumpAndSettle();
    expect(find.textContaining('Chưa có tài khoản nào đúng loại'), findsWidgets);
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNull, reason: 'an unresolved channel blocks — it never substitutes the cash account');
    // The CASH account name must NOT appear as a substitute for the bank row:
    expect(find.text('1110 - Cash - DFC'), findsNothing);
  });

  testWidgets('T18: double-tap confirm — the in-flight guard sends ONE request', (tester) async {
    final router = _Router()..readPageResult = readPage();
    await _pumpCollect(tester, router, resolvedHandoff());
    await _tickInvoice(tester, 'SINV-0001');
    await _typeAmount(tester, '2500000');
    await _chooseMethod(tester, 'Tiền mặt');
    await tester.pumpAndSettle();
    await tester.ensureVisible(_confirm);
    await tester.pump();
    await tester.tap(_confirm, warnIfMissed: false);
    // A second tap in the SAME frame window (before settle) must be a no-op:
    await tester.tap(_confirm, warnIfMissed: false);
    await tester.pumpAndSettle();
    expect(router.calls('/collect/propose'), 1, reason: 'one tap = one request');
  });

  testWidgets('T19: open invoices exist but NOTHING ticked — blocked with the allocation reminder (lock 6.3)', (tester) async {
    final router = _Router()..readPageResult = readPage();
    await _pumpCollect(tester, router, resolvedHandoff());
    await _typeAmount(tester, '3000000');
    await _chooseMethod(tester, 'Tiền mặt');
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('collect-allocation-required-copy')), findsOneWidget);
    expect(tester.widget<FilledButton>(_confirm).onPressed, isNull);
    expect(router.calls('/collect/propose'), 0);
  });

  testWidgets('T20: the UI cannot combine cash AND transfer — one segmented value + the lock copy (lock 6.1)', (tester) async {
    final router = _Router()..readPageResult = readPage();
    await _pumpCollect(tester, router, resolvedHandoff());
    expect(find.text('Mỗi lần thu một hình thức thanh toán.'), findsOneWidget);
    await _chooseMethod(tester, 'Tiền mặt');
    await tester.pump();
    final seg = tester.widget<SegmentedButton<String>>(
      find.byKey(const ValueKey('payment-method-segmented')),
    );
    expect(seg.selected, {'cash'}, reason: 'exactly ONE channel selected');
    expect(seg.multiSelectionEnabled, isFalse, reason: 'multi-selection is not even expressible');
    // Selecting the other channel REPLACES, never adds:
    await _chooseMethod(tester, 'Chuyển khoản');
    await tester.pump();
    expect(
      tester.widget<SegmentedButton<String>>(find.byKey(const ValueKey('payment-method-segmented'))).selected,
      {'bank_transfer'},
    );
  });

  test('T15b: re-resolving clears every allocation — a new customer never inherits the old ticked amounts', () async {
    // Driven at the CONTROLLER, not the screen: in Phase 2 the customer comes
    // from the handoff, so a "customer change" is a re-resolve, not a picker.
    // Without this the spec scenario "the old list and allocations are gone"
    // had no oracle at all (falsify F2 found exactly that hole).
    final router = _Router();
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(_FakePrefs()),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter(router.handler),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);

    final handoff = resolvedHandoff();
    // Keep the autoDispose provider alive the way the real screen does (a
    // widget that watches it) — a bare read would dispose it between awaits.
    final sub = container.listen(collectControllerProvider(handoff), (_, _) {});
    addTearDown(sub.close);
    final notifier = container.read(collectControllerProvider(handoff).notifier);
    await notifier.resolveCustomer();
    notifier.setAllocation('SINV-0001', 2500000, outstandingVnd: 2500000);
    expect(notifier.state.allocations, {'SINV-0001': 2500000},
        reason: 'the user allocated against the customer on screen');

    await notifier.resolveCustomer();

    expect(notifier.state.allocations, isEmpty,
        reason: 'T15b: changing customer must clear the allocations — the old '
            'amounts belong to the previous customer and must never be '
            'submitted against the new one');
  });

  test('T15c: the screen going away mid-reload must not throw on a disposed ref', () async {
    // The INVOICE_ALREADY_PAID branch awaits a RELOAD before it writes state.
    // Without a `ref.mounted` re-check after that await, the write throws
    // "Cannot use the Ref ... after it has been disposed" — the same class as
    // the propose-await guard, but one await later (audit 2026-09-29).
    final router = _Router()
      ..readPageResult = readPage()
      ..proposeResult = {
        'ok': false,
        'code': 'INVOICE_ALREADY_PAID',
        'reason': 'hoá đơn đã được thanh toán',
      };
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(_FakePrefs()),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter(router.handler),
          ),
        ),
      ],
    );
    final handoff = resolvedHandoff();
    container.listen(collectControllerProvider(handoff), (_, _) {});
    final notifier = container.read(collectControllerProvider(handoff).notifier);
    await notifier.resolveCustomer();
    notifier.setAllocation('SINV-0001', 2500000, outstandingVnd: 2500000);
    notifier.setAmount(2500000);
    notifier.setMethod('cash');

    // Delay the RELOAD's read so the screen can be torn down while the
    // controller is still waiting on it.
    router.delayRead = true;
    final inFlight = notifier.confirm();
    await Future<void>.delayed(const Duration(milliseconds: 150));
    container.dispose();

    final outcome = await inFlight;

    // With the guard the caller gets the SERVER's own result. Without it, the
    // disposed-ref exception is caught by confirm()'s own catch clause (which
    // then returns null), so the answer disappears — silently, because nothing
    // surfaces the swallowed exception. That is the difference asserted here.
    expect(outcome, isNotNull,
        reason: 'T15c: the post-reload state write must be SKIPPED — not throw '
            'and be swallowed into a null result');
    expect(outcome!.code, 'INVOICE_ALREADY_PAID',
        reason: 'the caller still receives the server result it asked for');
  });
}
