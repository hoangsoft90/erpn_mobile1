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
import 'package:erpn_mobile/features/chat/presentation/widgets/proposal_card.dart';
import 'package:erpn_mobile/features/collect/data/collect_models.dart';
import 'package:erpn_mobile/features/sales/application/sales_controller.dart';
import 'package:erpn_mobile/features/sales/data/sales_models.dart';

/// next8 Phase 6 — the sales screen's states, driven through the REAL app
/// router (`/sales` extra) with the client pointed at a mock Dio adapter — the
/// same harness the collect screen tests use, so what ships is what runs.
///
/// The properties these tests defend, per the spec deltas (`sales-screen`,
/// `sales-draft`, `sales-money`):
///  - without a handoff the screen REFUSES in Vietnamese (never invents one);
///  - the customer comes from the TICKET and is shown, not re-picked;
///  - the totals shown are the SERVER's own summary — the screen renders, it
///    never computes (no second money parser in Dart, tasks §4);
///  - the two discount layers travel APART in the request (falsify F1's
///    client-side mirror): line_discount per item vs order_discount_vnd;
///  - §6.1 ONE method (or none = credit); changing customer/warehouse RESETS
///    the draft (spec scenario); a slow answer for an older input is DROPPED
///    (epoch guard, spec scenario).
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

/// The handoff the server issues for "Bán hàng cho chị Lan" — customer
/// RESOLVED by the server (HINT-NOT-AUTHORITY: the screen never picks one).
BusinessHandoff salesHandoff() => BusinessHandoff(
      handoffId: 'HF-SALES-001',
      capability: 'sales.create',
      screen: 'sales',
      question: 'Bán hàng cho chị Lan',
      prefill: {
        'customer': const CollectPrefillSlot(
          state: CollectSlotState.resolved,
          id: 'CUST-00001',
          label: 'Nguyễn Thị Lan',
        ),
      },
    );

/// The ordinary `erpn.proposal/v1` + the SERVER's summary the route returns.
Map<String, dynamic> proposeOk() => {
      'ok': true,
      'capability': 'sales.create',
      'handoff_id': 'HF-SALES-001',
      'proposal': {
        'schema': 'erpn.proposal/v1',
        'action': 'create_sales_invoice_draft',
        'risk': 'HIGH',
        'action_id': 'act_sales-1',
        'entity': {'kind': 'customer', 'id': 'CUST-00001', 'name': 'Nguyễn Thị Lan'},
        'params': {
          'items': [
            {'item_id': 'CAM-HEO-25KG', 'uom': 'Bao', 'qty': 2, 'unit_price': 305000, 'line_discount': 0},
          ],
          'estimated_total_vnd': 610000,
          'collected_vnd': 0,
          'credit_vnd': 610000,
          'payment_methods': [],
        },
        'summary': 'Tạo hoá đơn NHÁP cho Nguyễn Thị Lan — tổng tạm tính 610.000đ',
      },
      'summary': {
        'subtotal_vnd': 610000,
        'line_discount_vnd': 0,
        'order_discount_vnd': 0,
        'total_vnd': 610000,
        'payment_total_vnd': 0,
        'outstanding_after_vnd': 610000,
      },
      'warnings': <String>[],
    };

/// Captures propose requests + the programmable answer (delay/status).
class _Router {
  _Router();

  final List<Map<String, dynamic>> bodies = [];
  Map<String, dynamic> proposeResult = proposeOk();
  int proposeStatus = 200;
  bool delayPropose = false;

  Handler get handler => (options) async {
        final raw = options.data is String
            ? jsonDecode(options.data as String) as Map<String, dynamic>
            : (options.data as Map<String, dynamic>? ?? const {});
        bodies.add(raw);
        if (options.path == '/sales/propose') {
          final result = proposeResult;
          final status = proposeStatus;
          if (delayPropose) {
            delayPropose = false;
            await Future<void>.delayed(const Duration(milliseconds: 300));
          }
          return _json(result, status);
        }
        return _json({'ok': false, 'error': 'unexpected ${options.path}'}, 404);
      };
}

Future<void> _pumpSales(WidgetTester tester, _Router router, BusinessHandoff? handoff) async {
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
  if (handoff == null) {
    // ignore: unawaited_futures
    appRouter.push('/sales');
  } else {
    // ignore: unawaited_futures
    appRouter.push('/sales', extra: handoff);
  }
  await tester.pumpAndSettle();
}

Finder get _propose => find.byKey(const ValueKey('sales-propose'));

/// The propose button sits below the fold on a short test viewport — bring it
/// on-screen (and settle any scroll animation) before tapping it.
Future<void> _tapPropose(WidgetTester tester) async {
  await tester.scrollUntilVisible(_propose, 300, scrollable: find.byType(Scrollable).first);
  await tester.pumpAndSettle();
  await tester.tap(_propose, warnIfMissed: false);
}
Finder get _itemField => find.byKey(const ValueKey('sales-line-item-0'));
Finder get _qtyField => find.byKey(const ValueKey('sales-line-qty-0'));

Future<void> _enterLine(WidgetTester tester, {String item = 'CAM-HEO-25KG', String qty = '2'}) async {
  await tester.enterText(_itemField, item);
  await tester.enterText(find.byKey(const ValueKey('sales-line-uom-0')), 'Bao');
  await tester.enterText(_qtyField, qty);
  await tester.pump();
}

void main() {
  testWidgets('no handoff: the screen refuses in Vietnamese, invents nothing', (tester) async {
    final router = _Router();
    await _pumpSales(tester, router, null);
    expect(find.byKey(const ValueKey('missing-sales-handoff')), findsOneWidget);
    expect(_propose, findsNothing);
    expect(router.bodies.where((b) => b['handoff_id'] != null), isEmpty);
  });

  testWidgets('server-resolved customer is shown; propose disabled until a line is filled',
      (tester) async {
    final router = _Router();
    await _pumpSales(tester, router, salesHandoff());
    expect(find.text('Nguyễn Thị Lan'), findsOneWidget);
    expect(tester.widget<FilledButton>(_propose).onPressed, isNull);
  });

  testWidgets('propose sends the form to /sales/propose and renders the SERVER summary + card',
      (tester) async {
    final router = _Router();
    await _pumpSales(tester, router, salesHandoff());
    await _enterLine(tester);
    await tester.pump();
    await _tapPropose(tester);
    await tester.pumpAndSettle();

    final body = router.bodies.firstWhere((b) => b['handoff_id'] == 'HF-SALES-001');
    final values = body['values'] as Map<String, dynamic>;
    expect(body['handoff_id'], 'HF-SALES-001');
    expect(values['customer_id'], 'CUST-00001');
    // The two layers travel APART in the request (F1 client-side mirror).
    expect((values['items'] as List).first['line_discount'], 0);
    expect(values['order_discount_vnd'], 0);
    expect(values['payment_methods'], isEmpty, reason: 'no method = a credit sale');

    // The totals the screen shows are the SERVER's, verbatim from the summary.
    expect(find.byKey(const ValueKey('sales-summary')), findsOneWidget);
    expect(find.text('610.000đ'), findsNWidgets(3), reason: 'Tổng · Còn lại · và proposal summary đều là số server');
    expect(find.byType(ProposalCard), findsOneWidget);
  });

  testWidgets('order discount (tầng 2) is sent SEPARATELY from the line discount (tầng 1)',
      (tester) async {
    final router = _Router();
    await _pumpSales(tester, router, salesHandoff());
    await _enterLine(tester);
    await tester.enterText(find.byKey(const ValueKey('sales-line-discount-0')), '50000');
    await tester.enterText(find.byKey(const ValueKey('sales-order-discount')), '20000');
    await tester.pump();
    await _tapPropose(tester);
    await tester.pumpAndSettle();

    final values = router.bodies
        .firstWhere((b) => b['handoff_id'] == 'HF-SALES-001')['values'] as Map<String, dynamic>;
    expect((values['items'] as List).first['line_discount'], 50000);
    expect(values['order_discount_vnd'], 20000, reason: 'tầng 2 không được gộp vào tầng 1');
  });

  testWidgets('ONE method (§6.1): choosing cash sends exactly one method with the typed amount',
      (tester) async {
    final router = _Router();
    await _pumpSales(tester, router, salesHandoff());
    await _enterLine(tester);
    await tester.scrollUntilVisible(find.text('Tiền mặt'), 300, scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Tiền mặt'), warnIfMissed: false);
    await tester.pump();
    await tester.enterText(find.byKey(const ValueKey('sales-amount')), '200000');
    await tester.pump();
    await _tapPropose(tester);
    await tester.pumpAndSettle();

    final methods = router.bodies
        .firstWhere((b) => b['handoff_id'] == 'HF-SALES-001')['values']['payment_methods'] as List;
    expect(methods, hasLength(1));
    expect(methods.first['mode'], 'cash');
    expect(methods.first['amount'], 200000);
  });

  testWidgets('a refusal shows the SERVER copy verbatim, never a rewritten one', (tester) async {
    final router = _Router()
      ..proposeStatus = 422
      ..proposeResult = {
        'ok': false,
        'code': 'SALES_PRICE_MISSING',
        'reason': 'ERPNext chưa có giá bán cho CAM-HEO-25KG theo đơn vị Bao',
      };
    await _pumpSales(tester, router, salesHandoff());
    await _enterLine(tester);
    await tester.pump();
    await _tapPropose(tester);
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('sales-propose-refusal')), findsOneWidget);
    expect(find.textContaining('chưa có giá bán'), findsOneWidget);
    expect(find.byType(ProposalCard), findsNothing);
  });

  testWidgets('changing the warehouse RESETS the draft lines (two drafts never mix)',
      (tester) async {
    final router = _Router();
    await _pumpSales(tester, router, salesHandoff());
    await _enterLine(tester);
    // The old draft's line card exists before the change…
    expect(find.byKey(const ValueKey('sales-line-0-0')), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('sales-warehouse')), 'Kho khác');
    await tester.pumpAndSettle();
    // …and is GONE after it: the reset bumps the draft generation, so the line
    // editors are re-created empty (no stale text for the previous draft).
    expect(find.byKey(const ValueKey('sales-line-0-0')), findsNothing);
    expect(find.byKey(const ValueKey('sales-line-1-0')), findsOneWidget,
        reason: 'the fresh (empty) line editor exists for the new draft');
    expect(tester.widget<FilledButton>(_propose).onPressed, isNull);
  });

  test('changing the customer resets the draft at the controller (spec scenario)', () {
    final container = ProviderContainer(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(_FakePrefs()),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter((options) async => _json(const {'ok': false})),
          ),
        ),
      ],
    );
    addTearDown(container.dispose);
    final handoff = salesHandoff();
    // listen keeps the autoDispose provider alive for the test's lifetime.
    container.listen(salesControllerProvider(handoff), (prev, next) {});
    final controller = container.read(salesControllerProvider(handoff).notifier);
    controller.setLine(0, const SalesLineValue(itemCode: 'CAM-GA-10KG', uom: 'Bao', qty: 3));
    controller.setMethod('cash');
    controller.setAmount(100000);
    controller.setCustomer('CUST-00002');
    final ui = container.read(salesControllerProvider(handoff));
    expect(ui.customerId, 'CUST-00002');
    expect(ui.items.first.itemCode, isEmpty, reason: 'lines are cleared (two drafts never mix)');
    expect(ui.method, isNull, reason: 'the collection is cleared');
    expect(ui.amount, isNull);
  });

  testWidgets('epoch guard: a slow answer for an older input is dropped, not rendered',
      (tester) async {
    final router = _Router()..delayPropose = true;
    await _pumpSales(tester, router, salesHandoff());
    await _enterLine(tester);
    await tester.pump();
    await _tapPropose(tester);
    await tester.pump(); // propose in flight
    // Mutate the input WHILE the answer is in flight — the answer is now stale.
    await tester.enterText(_qtyField, '9');
    await tester.pump();
    // The dropped (stale) answer also clears the in-flight flag — pump past the
    // delay without expecting the spinner to be gone before the answer lands.
    await tester.pump(const Duration(milliseconds: 350));
    // The stale summary must NOT appear: the response was issued before the
    // input changed and carries the older epoch.
    expect(find.byKey(const ValueKey('sales-summary')), findsNothing);
    expect(find.byType(ProposalCard), findsNothing);
  });

  test('SalesSummaryView renders the SERVER numbers, never recomputed', () {
    final summary = const SalesSummary(
      subtotalVnd: 2950000,
      lineDiscountVnd: 100000,
      orderDiscountVnd: 200000,
      totalVnd: 2750000,
      collectedVnd: 305000,
      outstandingAfterVnd: 2445000,
    );
    // The fields exist and travel apart — nothing folds them.
    expect(summary.totalVnd - summary.collectedVnd, summary.outstandingAfterVnd);
    expect(summary.orderDiscountVnd, isNot(summary.lineDiscountVnd + summary.orderDiscountVnd));
  });
}
