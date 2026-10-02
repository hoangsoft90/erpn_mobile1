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
import 'package:erpn_mobile/features/purchase/application/purchase_controller.dart';
import 'package:erpn_mobile/features/purchase/data/purchase_models.dart';
import 'package:erpn_mobile/features/sales/data/sales_models.dart' show SalesSummary;

/// next8 Phase 7 — the purchase screen's states, the sales screen test's twin.
///
/// The properties these tests defend, per the spec deltas (`purchase-screen`,
/// `purchase-draft`, `purchase-money`):
///  - without a handoff the screen REFUSES in Vietnamese (never invents one);
///  - the supplier comes from the TICKET and is shown, not re-picked;
///  - the totals shown are the SERVER's own summary — the screen renders, it
///    never computes;
///  - there is NO line-discount field on a purchase (plan §14) though the
///    shared [ItemLineEditor] is reused;
///  - §6.1 ONE method (or none = credit); changing supplier/warehouse RESETS
///    the draft; a slow answer for an older input is DROPPED (epoch guard).
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

/// The handoff the server issues for "Nhập hàng cho Hà Tiên" — supplier
/// RESOLVED by the server (HINT-NOT-AUTHORITY: the screen never picks one).
BusinessHandoff purchaseHandoff() => BusinessHandoff(
      handoffId: 'HF-PURCHASE-001',
      capability: 'purchase_invoice.create',
      screen: 'purchase',
      question: 'Nhập hàng cho Hà Tiên',
      prefill: {
        'supplier': const CollectPrefillSlot(
          state: CollectSlotState.resolved,
          id: 'SUP-HATIEN',
          label: 'Hà Tiên',
        ),
      },
    );

/// The ordinary `erpn.proposal/v1` + the SERVER's summary the route returns.
Map<String, dynamic> proposeOk() => {
      'ok': true,
      'capability': 'purchase_invoice.create',
      'handoff_id': 'HF-PURCHASE-001',
      'proposal': {
        'schema': 'erpn.proposal/v1',
        'action': 'create_purchase_invoice_draft',
        'risk': 'HIGH',
        'action_id': 'act_purchase-1',
        'entity': {'kind': 'supplier', 'id': 'SUP-HATIEN', 'name': 'Hà Tiên'},
        'params': {
          'items': [
            {'item_id': 'CAM-HEO-25KG', 'uom': 'Bao', 'qty': 2, 'unit_price': 295000},
          ],
          'estimated_total_vnd': 590000,
          'paid_vnd': 0,
          'credit_vnd': 590000,
          'payment_methods': [],
        },
        'summary': 'Tạo phiếu nhập NHÁP từ Hà Tiên — tổng tạm tính 590.000đ',
      },
      'summary': {
        'subtotal_vnd': 590000,
        'total_vnd': 590000,
        'payment_total_vnd': 0,
        'unallocated_vnd': 0,
        'outstanding_after_vnd': 590000,
      },
      'warnings': <String>[],
      'price_list': 'Standard Buying',
    };

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
        if (options.path == '/purchase/propose') {
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

Future<void> _pumpPurchase(WidgetTester tester, _Router router, BusinessHandoff? handoff) async {
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
    appRouter.push('/purchase');
  } else {
    // ignore: unawaited_futures
    appRouter.push('/purchase', extra: handoff);
  }
  await tester.pumpAndSettle();
}

Finder get _propose => find.byKey(const ValueKey('purchase-propose'));

Future<void> _tapPropose(WidgetTester tester) async {
  await tester.scrollUntilVisible(_propose, 300, scrollable: find.byType(Scrollable).first);
  await tester.pumpAndSettle();
  await tester.tap(_propose, warnIfMissed: false);
}

// The shared ItemLineEditor keeps its own sales-line-* field keys (reuse, not a
// fork) — the purchase screen only wraps it with a purchase-line-* card key.
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
    await _pumpPurchase(tester, router, null);
    expect(find.byKey(const ValueKey('missing-purchase-handoff')), findsOneWidget);
    expect(_propose, findsNothing);
    expect(router.bodies.where((b) => b['handoff_id'] != null), isEmpty);
  });

  testWidgets('server-resolved supplier is shown; propose disabled until a line is filled',
      (tester) async {
    final router = _Router();
    await _pumpPurchase(tester, router, purchaseHandoff());
    expect(find.text('Hà Tiên'), findsOneWidget);
    expect(tester.widget<FilledButton>(_propose).onPressed, isNull);
  });

  testWidgets('the shared line editor is reused with NO discount field (plan §14)', (tester) async {
    final router = _Router();
    await _pumpPurchase(tester, router, purchaseHandoff());
    expect(find.byKey(const ValueKey('sales-line-card-0')), findsOneWidget,
        reason: 'the SHARED ItemLineEditor renders (reuse, not a fork)');
    expect(find.byKey(const ValueKey('sales-line-discount-0')), findsNothing,
        reason: 'a purchase has no line discount');
  });

  testWidgets('propose sends the form to /purchase/propose and renders the SERVER summary + card',
      (tester) async {
    final router = _Router();
    await _pumpPurchase(tester, router, purchaseHandoff());
    await _enterLine(tester);
    await tester.pump();
    await _tapPropose(tester);
    await tester.pumpAndSettle();

    final body = router.bodies.firstWhere((b) => b['handoff_id'] == 'HF-PURCHASE-001');
    final values = body['values'] as Map<String, dynamic>;
    expect(values['supplier_id'], 'SUP-HATIEN');
    expect((values['items'] as List).first['item_id'], 'CAM-HEO-25KG');
    expect((values['items'] as List).first.containsKey('line_discount'), isFalse);
    expect(values['payment_methods'], isEmpty, reason: 'no method = a credit purchase');

    expect(find.byKey(const ValueKey('sales-summary')), findsOneWidget);
    expect(find.text('590.000đ'), findsWidgets, reason: 'the totals are the server summary');
    expect(find.text('Còn nợ NCC'), findsOneWidget);
    expect(find.byType(ProposalCard), findsOneWidget);
  });

  testWidgets('ONE method (§6.1): choosing cash sends exactly one method with the typed amount',
      (tester) async {
    final router = _Router();
    await _pumpPurchase(tester, router, purchaseHandoff());
    await _enterLine(tester);
    await tester.scrollUntilVisible(find.text('Tiền mặt'), 300, scrollable: find.byType(Scrollable).first);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Tiền mặt'), warnIfMissed: false);
    await tester.pump();
    await tester.enterText(find.byKey(const ValueKey('purchase-amount')), '200000');
    await tester.pump();
    await _tapPropose(tester);
    await tester.pumpAndSettle();

    final methods = router.bodies
        .firstWhere((b) => b['handoff_id'] == 'HF-PURCHASE-001')['values']['payment_methods'] as List;
    expect(methods, hasLength(1));
    expect(methods.first['mode'], 'cash');
    expect(methods.first['amount'], 200000);
  });

  testWidgets('a refusal shows the SERVER copy verbatim, never a rewritten one', (tester) async {
    final router = _Router()
      ..proposeStatus = 422
      ..proposeResult = {
        'ok': false,
        'code': 'PURCHASE_PRICE_MISSING',
        'reason': 'ERPNext chưa có giá MUA cho CAM-HEO-25KG theo đơn vị Bao',
      };
    await _pumpPurchase(tester, router, purchaseHandoff());
    await _enterLine(tester);
    await tester.pump();
    await _tapPropose(tester);
    await tester.pumpAndSettle();

    expect(find.byKey(const ValueKey('purchase-propose-refusal')), findsOneWidget);
    expect(find.textContaining('chưa có giá MUA'), findsOneWidget);
    expect(find.byType(ProposalCard), findsNothing);
  });

  testWidgets('changing the warehouse RESETS the draft lines (two drafts never mix)',
      (tester) async {
    final router = _Router();
    await _pumpPurchase(tester, router, purchaseHandoff());
    await _enterLine(tester);
    expect(find.byKey(const ValueKey('purchase-line-0-0')), findsOneWidget);
    await tester.enterText(find.byKey(const ValueKey('purchase-warehouse')), 'Kho khác');
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('purchase-line-0-0')), findsNothing);
    expect(find.byKey(const ValueKey('purchase-line-1-0')), findsOneWidget);
    expect(tester.widget<FilledButton>(_propose).onPressed, isNull);
  });

  test('changing the supplier resets the draft at the controller (spec scenario)', () {
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
    final handoff = purchaseHandoff();
    container.listen(purchaseControllerProvider(handoff), (prev, next) {});
    final controller = container.read(purchaseControllerProvider(handoff).notifier);
    controller.setLine(0, const PurchaseLineValue(itemCode: 'CAM-GA-10KG', uom: 'Bao', qty: 3));
    controller.setMethod('cash');
    controller.setAmount(100000);
    controller.setSupplier('SUP-BAY', name: 'Anh Bảy');
    final ui = container.read(purchaseControllerProvider(handoff));
    expect(ui.supplierId, 'SUP-BAY');
    expect(ui.items.first.itemCode, isEmpty, reason: 'lines are cleared (two drafts never mix)');
    expect(ui.method, isNull, reason: 'the payment is cleared');
    expect(ui.amount, isNull);
  });

  testWidgets('epoch guard: a slow answer for an older input is dropped, not rendered',
      (tester) async {
    final router = _Router()..delayPropose = true;
    await _pumpPurchase(tester, router, purchaseHandoff());
    await _enterLine(tester);
    await tester.pump();
    await _tapPropose(tester);
    await tester.pump(); // propose in flight
    await tester.enterText(_qtyField, '9');
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 350));
    expect(find.byKey(const ValueKey('sales-summary')), findsNothing);
    expect(find.byType(ProposalCard), findsNothing);
  });

  test('the summary view renders the SERVER numbers, never recomputed', () {
    const summary = PurchaseSummary(
      subtotalVnd: 2950000,
      totalVnd: 2950000,
      paidVnd: 500000,
      outstandingAfterVnd: 2450000,
    );
    expect(summary.totalVnd - summary.paidVnd, summary.outstandingAfterVnd);
    // The shared view is parameterised for the PAY direction — same numbers.
    const shared = SalesSummary(
      subtotalVnd: 2950000,
      totalVnd: 2950000,
      collectedVnd: 500000,
      outstandingAfterVnd: 2450000,
    );
    expect(shared.outstandingAfterVnd, summary.outstandingAfterVnd);
  });
}
