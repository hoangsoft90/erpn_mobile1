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

/// The verbatim shape of the proposal the B4 pipeline returns for
/// "đặt mua 2 bao cám heo tăng trọng 25kg từ Hà Tiên" (mock ERPNext): HIGH,
/// draft-only, lines priced from the BUYING table (295.000, not the 305.000 the
/// sales path uses), party kind = supplier.
Map<String, dynamic> _purchaseJson({Map<String, dynamic>? params}) => {
      'schema': 'erpn.proposal/v1',
      'action': 'create_purchase_order',
      'created_at': '2026-09-20T08:10:00.000Z',
      'risk': 'HIGH',
      'risk_display': {'icon': '🔴', 'label': 'Cần xác nhận'},
      'need_confirm': true,
      'need_double_confirm': false,
      'executable': false,
      'entity': {'kind': 'supplier', 'id': 'SUP-HATIEN', 'name': 'Hà Tiên'},
      'params': params ??
          {
            'lines': [
              {
                'item_code': 'CAM-HEO-25KG',
                'item_name': 'Cám heo tăng trọng 25kg',
                'qty': 2,
                'uom': 'Bao',
                'rate': 295000,
                'amount_vnd': 590000,
                'stock_uom': 'Bao',
                'conversion_factor': null,
                'uom_display': 'Đơn vị: Bao',
              },
            ],
            'line_count': 1,
            'estimated_total_vnd': 590000,
            'total_source': 'qty_x_erpnext_buying_rate',
            'price_side': 'buying',
            'submit_now': false,
          },
      'summary': 'Tạo đơn MUA NHÁP: 2 Bao Cám heo tăng trọng 25kg từ Hà Tiên',
      'proposal_id': 'prp_po_test',
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
  testWidgets('B4: the purchase card says ĐƠN MUA and shows the BUYING price',
      (tester) async {
    await tester.pumpWidget(_host(ActionProposal.fromJson(_purchaseJson())));
    expect(find.textContaining('Tạo đơn MUA NHÁP'), findsOneWidget);
    expect(find.textContaining('Xác nhận tạo đơn mua (NHÁP)'), findsOneWidget);
    // The three neighbours must not be reachable from this card's wording.
    expect(find.textContaining('Xác nhận tạo đơn (NHÁP)'), findsNothing,
        reason: 'a purchase order is not a sales order');
    expect(find.textContaining('Xác nhận tạo báo giá'), findsNothing);
    expect(find.textContaining('Xác nhận thu tiền'), findsNothing);
    // The line carries the rate ERPNext declares for the BUYING side.
    expect(find.textContaining('2 Bao · Cám heo tăng trọng 25kg'), findsOneWidget);
    expect(find.textContaining('295.000đ/dv'), findsOneWidget);
    expect(find.textContaining('305.000đ/dv'), findsNothing,
        reason: 'the selling price must never appear on a purchase card');
    expect(find.textContaining('Tạm tính: 590.000đ'), findsOneWidget);
  });

  testWidgets('B4: confirming posts the FROZEN lines, no submit flag, and the outcome reads as a PURCHASE',
      (tester) async {
    final requests = <dynamic>[];
    await tester.pumpWidget(_hostWithMock(
        ActionProposal.fromJson(_purchaseJson()), (options) async {
      requests.add(options.data);
      return _json({
        'ok': true,
        'replay': false,
        'result': {
          'erpnext_doc': 'PO-M001',
          'supplier': 'SUP-HATIEN',
          'lines': [
            {'item_code': 'CAM-HEO-25KG', 'item_name': 'Cám heo tăng trọng 25kg', 'qty': 2, 'uom': 'Bao', 'rate': 295000},
          ],
          'line_count': 1,
          'estimated_total_vnd': 590000,
          'erpnext_total_vnd': 590000,
          'price_side': 'buying',
          'docstatus': 0,
          'note': 'đơn MUA tạo ở trạng thái NHÁP (docstatus 0)',
        },
      });
    }));
    await tester.tap(find.textContaining('Xác nhận tạo đơn mua'));
    await tester.pumpAndSettle();

    expect(requests.length, 1, reason: 'exactly one /execute per press');
    final sent = jsonDecode(requests.single as String) as Map<String, dynamic>;
    expect(sent['proposal']['action'], 'create_purchase_order');
    final sentParams = sent['proposal']['params'] as Map<String, dynamic>;
    expect((sentParams['lines'] as List).length, 1,
        reason: 'the confirmed lines must round-trip (the executor re-validates them)');
    expect((sentParams['lines'] as List).first['stock_uom'], 'Bao',
        reason: 'a field the drift check reads must survive the client model');
    expect(sentParams['price_side'], 'buying');
    expect(sent.containsKey('submit_now'), isFalse,
        reason: 'a purchase order is draft-only — no submit flag may ever be sent');

    expect(find.textContaining('✅ Đã tạo đơn mua NHÁP: PO-M001 từ Hà Tiên'), findsOneWidget);
    expect(find.textContaining('MUA'), findsWidgets);
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('B4: a purchase order that drifts is refused in the card, not confirmed on old numbers',
      (tester) async {
    await tester.pumpWidget(_hostWithMock(
        ActionProposal.fromJson(_purchaseJson()),
        (options) async => _json({
              'ok': false,
              'code': 'PROPOSAL_VERSION_STALE',
              'legacy_code': 'PROPOSAL_STALE',
              'error':
                  'đề xuất đã lệch so với dữ liệu thật: CAM-HEO-25KG: giá mua đổi 295000 → 300000 — KHÔNG ghi, hãy xác nhận lại',
              'problems': ['CAM-HEO-25KG: giá mua đổi 295000 → 300000'],
            }, 409)));
    await tester.tap(find.textContaining('Xác nhận tạo đơn mua'));
    await tester.pumpAndSettle();
    expect(find.textContaining('đã lệch so với dữ liệu thật'), findsOneWidget);
    expect(find.textContaining('giá mua đổi'), findsOneWidget,
        reason: 'the refusal must name the BUYING price moving, not a sale');
    expect(find.byType(FilledButton), findsNothing,
        reason: 'a re-priced purchase must be re-asked');
  });

  testWidgets('B4: the duplicate refusal names the order, and pressing again REPLAYS the same command_id',
      (tester) async {
    final requests = <Map<String, dynamic>>[];
    await tester.pumpWidget(_hostWithMock(
        ActionProposal.fromJson(_purchaseJson()),
        (options) async {
      requests.add(jsonDecode(options.data as String) as Map<String, dynamic>);
      return _json({
        'ok': false,
        'code': 'PO_DUPLICATE_ACTION',
        'existing_doc': 'PO-M001',
        'error':
            'đơn mua PO-M001 đã tồn tại trên ERPNext với action id này — KHÔNG ghi lần nữa, kiểm tra ERPNext trước',
      }, 409);
    }));
    await tester.tap(find.textContaining('Xác nhận tạo đơn mua'));
    await tester.pumpAndSettle();
    expect(find.textContaining('PO-M001'), findsOneWidget,
        reason: 'a 409 that names the existing document is actionable');

    // The affordance stays (this card cannot know whether the user meant a
    // different order), so the safety lives in the key: the second press sends
    // the SAME command_id and the gateway replays instead of writing twice.
    await tester.tap(find.textContaining('Xác nhận tạo đơn mua'));
    await tester.pumpAndSettle();
    expect(requests.length, 2);
    expect(requests[0]['command_id'], isNotNull);
    expect(requests[1]['command_id'], requests[0]['command_id'],
        reason: 'a retry must replay, never write a second purchase order');
  });
}
