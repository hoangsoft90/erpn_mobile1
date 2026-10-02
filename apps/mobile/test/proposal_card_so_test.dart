import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/features/chat/data/chat_models.dart';
import 'package:erpn_mobile/features/chat/presentation/widgets/proposal_card.dart';

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

/// The verbatim shape of the proposal the B2 E2E pipeline returns for
/// "đặt hàng cho Nguyễn Thị Lan 2 bao cám heo tăng trọng 25kg" (mock ERPNext):
/// HIGH, draft-only, lines with ERPNext prices, no amount_vnd.
Map<String, dynamic> _orderJson({Map<String, dynamic>? params}) => {
      'schema': 'erpn.proposal/v1',
      'action': 'create_sales_order',
      'created_at': '2026-09-20T07:40:00.000Z',
      'risk': 'HIGH',
      'risk_display': {'icon': '🔴', 'label': 'Cần xác nhận'},
      'need_confirm': true,
      'need_double_confirm': false,
      'executable': false,
      'entity': {'kind': 'customer', 'id': 'CUST-00001', 'name': 'Nguyễn Thị Lan'},
      'params': params ??
          {
            'lines': [
              {
                'item_code': 'CAM-HEO-25KG',
                'item_name': 'Cám heo tăng trọng 25kg',
                'qty': 2,
                'uom': 'Bao',
                'rate': 305000,
                'amount_vnd': 610000,
                'stock_uom': 'Bao',
                'conversion_factor': null,
                'uom_display': 'Đơn vị: Bao',
              },
              {
                'item_code': 'CAM-GA-10KG',
                'item_name': 'Cám gà thịt 10kg',
                'qty': 3,
                'uom': 'Bao',
                'rate': 250000,
                'amount_vnd': 750000,
                'stock_uom': 'Bao',
                'conversion_factor': null,
                'uom_display': 'Đơn vị: Bao',
              },
            ],
            'line_count': 2,
            'estimated_total_vnd': 1360000,
            'total_source': 'qty_x_erpnext_rate',
            'submit_now': false,
          },
      'summary':
          'Tạo đơn NHÁP: 2 Bao Cám heo tăng trọng 25kg + 3 Bao Cám gà thịt 10kg cho Nguyễn Thị Lan',
      'proposal_id': 'prp_test',
      'version': 1,
    };

Widget _host(ActionProposal proposal) => MaterialApp(
      home: Scaffold(body: ProposalCard(proposal: proposal)),
    );

Widget _hostWithMock(ActionProposal proposal, Handler handler) => ProviderScope(
      overrides: [
        dioProvider.overrideWith((ref) {
          final dio = Dio(BaseOptions(baseUrl: 'http://mock'));
          dio.httpClientAdapter = _MockAdapter(handler);
          return dio;
        }),
        // The confirm path applies the client's settings (base URL + basic auth)
        // before POSTing /execute — a protected server answers 401 otherwise.
        sharedPreferencesProvider.overrideWithValue(null),
      ],
      child: MaterialApp(
        home: Scaffold(body: ProposalCard(proposal: proposal)),
      ),
    );

void main() {
  testWidgets('B2: the order card names the action and shows every line from the snapshot',
      (tester) async {
    await tester.pumpWidget(_host(ActionProposal.fromJson(_orderJson())));
    expect(find.textContaining('Xác nhận tạo đơn (NHÁP)'), findsOneWidget,
        reason: 'an order card must not ask to "thu tiền"');
    expect(find.textContaining('Xác nhận thu tiền'), findsNothing);
    expect(find.textContaining('2 Bao · Cám heo tăng trọng 25kg'), findsOneWidget);
    expect(find.textContaining('3 Bao · Cám gà thịt 10kg'), findsOneWidget);
    expect(find.textContaining('305.000đ/dv'), findsOneWidget,
        reason: 'the unit price ERPNext declared is visible, not only totals');
    expect(find.textContaining('Tạm tính: 1.360.000đ'), findsOneWidget,
        reason: 'the estimate is labelled as an estimate');
    expect(find.textContaining('chưa submit'), findsNothing,
        reason: 'the submit warning belongs to the OUTCOME, not the offer');
  });

  testWidgets('B2: a converted line shows the factor it will be billed in (không quy đổi ẩn)',
      (tester) async {
    final json = _orderJson(params: {
      'lines': [
        {
          'item_code': 'KG-ITEM',
          'item_name': 'Kg Item',
          'qty': 1,
          'uom': 'Tấn',
          'rate': 21000000,
          'amount_vnd': 21000000,
          'stock_uom': 'Kg',
          'conversion_factor': 1000,
          'uom_display': 'quy đổi: 1 Tấn = 1000 Kg',
        },
      ],
      'line_count': 1,
      'estimated_total_vnd': 21000000,
      'total_source': 'qty_x_erpnext_rate',
      'submit_now': false,
    });
    await tester.pumpWidget(_host(ActionProposal.fromJson(json)));
    expect(find.textContaining('1 Tấn · Kg Item'), findsOneWidget);
    expect(find.textContaining('(=1000 Kg)'), findsOneWidget,
        reason: 'the quantity ERPNext will store is shown next to what was said');
  });

  testWidgets('B2: confirming posts the FROZEN lines and no submit flag; the outcome is draft-only',
      (tester) async {
    final requests = <dynamic>[];
    await tester.pumpWidget(
        _hostWithMock(ActionProposal.fromJson(_orderJson()), (options) async {
      requests.add(options.data);
      return _json({
        'ok': true,
        'replay': false,
        'result': {
          'erpnext_doc': 'SO-M001',
          'customer': 'CUST-00001',
          'lines': [
            {'item_code': 'CAM-HEO-25KG', 'item_name': 'Cám heo tăng trọng 25kg', 'qty': 2, 'uom': 'Bao', 'rate': 305000},
            {'item_code': 'CAM-GA-10KG', 'item_name': 'Cám gà thịt 10kg', 'qty': 3, 'uom': 'Bao', 'rate': 250000},
          ],
          'line_count': 2,
          'estimated_total_vnd': 1360000,
          'erpnext_total_vnd': 1468800,
          'total_note': 'ERPNext tính 1.468.800đ (có thuế/chiết khấu) — số tạm tính chỉ để hiển thị trước khi ghi',
          'docstatus': 0,
        },
      });
    }));
    await tester.tap(find.textContaining('Xác nhận tạo đơn'));
    await tester.pumpAndSettle();

    expect(requests.length, 1, reason: 'exactly one /execute per press');
    final sent = jsonDecode(requests.single as String) as Map<String, dynamic>;
    expect(sent['proposal']['action'], 'create_sales_order');
    final sentParams = sent['proposal']['params'] as Map<String, dynamic>;
    expect((sentParams['lines'] as List).length, 2,
        reason: 'the confirmed lines must round-trip (the executor re-validates them)');
    expect((sentParams['lines'] as List).first['rate'], 305000);
    expect((sentParams['lines'] as List).first['stock_uom'], 'Bao',
        reason: 'a field the drift check reads must survive the client model');
    expect(sent.containsKey('submit_now'), isFalse,
        reason: 'an order is draft-only — no submit flag may ever be sent');

    expect(find.textContaining('Đã tạo đơn NHÁP: SO-M001'), findsOneWidget);
    // The summary line and the success line both name the item — match the
    // success one specifically.
    expect(find.textContaining('✅ Đã tạo đơn NHÁP: SO-M001'), findsOneWidget);
    expect(find.textContaining('tổng 1.468.800đ'), findsOneWidget,
        reason: "ERPNext's own total, not our estimate");
    expect(find.textContaining('(ERPNext tính 1.468.800đ'), findsOneWidget,
        reason: 'a difference between the estimate and the ERP total is disclosed');
    expect(find.textContaining('chưa submit'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('B2: a refusal keeps the confirm affordance off and shows the concrete reason',
      (tester) async {
    await tester.pumpWidget(_hostWithMock(ActionProposal.fromJson(_orderJson()),
        (options) async => _json({
              'ok': false,
              'code': 'PROPOSAL_VERSION_STALE',
              'legacy_code': 'PROPOSAL_STALE',
              'error': 'đề xuất đã lệch so với dữ liệu thật: CAM-HEO-25KG: giá đổi 305000 → 310000 — KHÔNG ghi, hãy xác nhận lại',
              'problems': ['CAM-HEO-25KG: giá đổi 305000 → 310000'],
            }, 409)));
    await tester.tap(find.textContaining('Xác nhận tạo đơn'));
    await tester.pumpAndSettle();
    expect(find.textContaining('đã lệch so với dữ liệu thật'), findsOneWidget);
    expect(find.textContaining('giá đổi 305000'), findsOneWidget);
    // The REAL server names a drift refusal PROPOSAL_VERSION_STALE (legacy_code
    // PROPOSAL_STALE) — the card must remove the affordance for that form too.
    expect(find.byType(FilledButton), findsNothing,
        reason: 'a re-priced order must be re-asked, never confirmed on old numbers');
  });

  testWidgets('B2: an order proposal with NO lines cannot be confirmed into a blind write',
      (tester) async {
    final json = _orderJson(params: {
      'lines': <dynamic>[],
      'line_count': 0,
      'estimated_total_vnd': 0,
      'submit_now': false,
    });
    await tester.pumpWidget(_host(ActionProposal.fromJson(json)));
    expect(find.textContaining('không có dòng hàng nào'), findsOneWidget);
  });

  testWidgets('B2: the order card keeps its result through a ListView recycle (F2 rule)',
      (tester) async {
    var writes = 0;
    final proposal = ActionProposal.fromJson(_orderJson());
    Widget host(Handler handler) => ProviderScope(
          overrides: [
            dioProvider.overrideWith((ref) {
              final dio = Dio(BaseOptions(baseUrl: 'http://mock'));
              dio.httpClientAdapter = _MockAdapter(handler);
              return dio;
            }),
            sharedPreferencesProvider.overrideWithValue(null),
          ],
          child: MaterialApp(
            home: Scaffold(
              body: ListView.builder(
                itemCount: 60,
                itemBuilder: (context, index) => index == 0
                    ? ProposalCard(proposal: proposal)
                    : SizedBox(height: 120, child: Text('filler $index')),
              ),
            ),
          ),
        );

    await tester.pumpWidget(host((options) async {
      writes++;
      return _json({
        'ok': true,
        'replay': false,
        'result': {
          'erpnext_doc': 'SO-M002',
          'lines': [
            {'item_code': 'CAM-HEO-25KG', 'item_name': 'Cám heo tăng trọng 25kg', 'qty': 2, 'uom': 'Bao', 'rate': 305000},
          ],
          'erpnext_total_vnd': 610000,
          'docstatus': 0,
        },
      });
    }));
    await tester.tap(find.textContaining('Xác nhận tạo đơn'));
    await tester.pumpAndSettle();
    expect(find.textContaining('Đã tạo đơn NHÁP: SO-M002'), findsOneWidget);

    await tester.drag(find.byType(ListView), const Offset(0, -5000));
    await tester.pumpAndSettle();
    await tester.drag(find.byType(ListView), const Offset(0, 6000));
    await tester.pumpAndSettle();

    expect(find.textContaining('Đã tạo đơn NHÁP: SO-M002'), findsOneWidget,
        reason: 'the order result must survive the recycle like a payment result does');
    expect(find.byType(FilledButton), findsNothing);
    expect(writes, 1, reason: 'recycling must not fire a second /execute');
  });
}
