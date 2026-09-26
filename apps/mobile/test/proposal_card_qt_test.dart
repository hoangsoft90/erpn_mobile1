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

/// The verbatim shape of the proposal the B3 pipeline returns for
/// "báo giá cho Nguyễn Thị Lan 2 bao cám heo tăng trọng 25kg" (mock ERPNext):
/// HIGH, draft-only, lines with ERPNext prices, `offer: true`.
Map<String, dynamic> _quotationJson({Map<String, dynamic>? params}) => {
      'schema': 'erpn.proposal/v1',
      'action': 'create_quotation',
      'created_at': '2026-09-20T08:10:00.000Z',
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
            'offer': true,
          },
      'summary':
          'Tạo báo giá NHÁP: 2 Bao Cám heo tăng trọng 25kg + 3 Bao Cám gà thịt 10kg cho Nguyễn Thị Lan',
      'proposal_id': 'prp_qt_test',
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
  testWidgets('B3: the quotation card says BÁO GIÁ — never a sale or a payment',
      (tester) async {
    await tester.pumpWidget(_host(ActionProposal.fromJson(_quotationJson())));
    expect(find.textContaining('Tạo báo giá NHÁP'), findsOneWidget);
    expect(find.textContaining('Xác nhận tạo báo giá (NHÁP)'), findsOneWidget);
    expect(find.textContaining('Xác nhận thu tiền'), findsNothing);
    expect(find.textContaining('Xác nhận tạo đơn'), findsNothing,
        reason: 'a quotation is an offer, not a booked order');
    // Every line of the offer is visible, with ERPNext's declared unit price.
    expect(find.textContaining('2 Bao · Cám heo tăng trọng 25kg'), findsOneWidget);
    expect(find.textContaining('3 Bao · Cám gà thịt 10kg'), findsOneWidget);
    expect(find.textContaining('305.000đ/dv'), findsOneWidget);
    expect(find.textContaining('Tạm tính: 1.360.000đ'), findsOneWidget,
        reason: 'the estimate is labelled as an estimate');
  });

  testWidgets('B3: confirming posts the FROZEN lines, no submit flag, and the outcome reads as an OFFER',
      (tester) async {
    final requests = <dynamic>[];
    await tester.pumpWidget(_hostWithMock(
        ActionProposal.fromJson(_quotationJson()), (options) async {
      requests.add(options.data);
      return _json({
        'ok': true,
        'replay': false,
        'result': {
          'erpnext_doc': 'QTN-M001',
          'customer': 'CUST-00001',
          'lines': [
            {'item_code': 'CAM-HEO-25KG', 'item_name': 'Cám heo tăng trọng 25kg', 'qty': 2, 'uom': 'Bao', 'rate': 305000},
            {'item_code': 'CAM-GA-10KG', 'item_name': 'Cám gà thịt 10kg', 'qty': 3, 'uom': 'Bao', 'rate': 250000},
          ],
          'line_count': 2,
          'estimated_total_vnd': 1360000,
          'erpnext_total_vnd': 1360000,
          'docstatus': 0,
          'note': 'báo giá tạo ở trạng thái NHÁP (docstatus 0) — đây là ĐỀ NGHỊ, không phải đơn đã chốt; submit là bước riêng trên ERPNext',
        },
      });
    }));
    await tester.tap(find.textContaining('Xác nhận tạo báo giá'));
    await tester.pumpAndSettle();

    expect(requests.length, 1, reason: 'exactly one /execute per press');
    final sent = jsonDecode(requests.single as String) as Map<String, dynamic>;
    expect(sent['proposal']['action'], 'create_quotation');
    final sentParams = sent['proposal']['params'] as Map<String, dynamic>;
    expect((sentParams['lines'] as List).length, 2,
        reason: 'the confirmed lines must round-trip (the executor re-validates them)');
    expect((sentParams['lines'] as List).first['stock_uom'], 'Bao',
        reason: 'a field the drift check reads must survive the client model');
    expect(sent.containsKey('submit_now'), isFalse,
        reason: 'a quotation is draft-only — no submit flag may ever be sent');

    expect(find.textContaining('✅ Đã tạo báo giá NHÁP: QTN-M001'), findsOneWidget);
    expect(find.textContaining('ĐỀ NGHỊ'), findsOneWidget,
        reason: 'the outcome must not let an offer read as a booked sale');
    expect(find.byType(FilledButton), findsNothing);
  });

  testWidgets('B3: a quotation that drifts is refused in the card, not confirmed on old numbers',
      (tester) async {
    await tester.pumpWidget(_hostWithMock(
        ActionProposal.fromJson(_quotationJson()),
        (options) async => _json({
              'ok': false,
              'code': 'PROPOSAL_VERSION_STALE',
              'legacy_code': 'PROPOSAL_STALE',
              'error':
                  'đề xuất đã lệch so với dữ liệu thật: CAM-HEO-25KG: giá đổi 305000 → 310000 — KHÔNG ghi, hãy xác nhận lại',
              'problems': ['CAM-HEO-25KG: giá đổi 305000 → 310000'],
            }, 409)));
    await tester.tap(find.textContaining('Xác nhận tạo báo giá'));
    await tester.pumpAndSettle();
    expect(find.textContaining('đã lệch so với dữ liệu thật'), findsOneWidget);
    expect(find.byType(FilledButton), findsNothing,
        reason: 'a re-priced offer must be re-asked');
  });

  testWidgets('B3: the duplicate refusal names the quotation, and pressing again REPLAYS the same command_id',
      (tester) async {
    final requests = <Map<String, dynamic>>[];
    await tester.pumpWidget(_hostWithMock(
        ActionProposal.fromJson(_quotationJson()),
        (options) async {
      requests.add(jsonDecode(options.data as String) as Map<String, dynamic>);
      return _json({
        'ok': false,
        'code': 'QT_DUPLICATE_ACTION',
        'existing_doc': 'QTN-M001',
        'error':
            'báo giá QTN-M001 đã tồn tại trên ERPNext với action id này — KHÔNG ghi lần nữa, kiểm tra ERPNext trước',
      }, 409);
    }));
    await tester.tap(find.textContaining('Xác nhận tạo báo giá'));
    await tester.pumpAndSettle();
    expect(find.textContaining('QTN-M001'), findsOneWidget,
        reason: 'a 409 that names the existing document is actionable');

    // The affordance deliberately STAYS (this card cannot know whether the user
    // meant a different offer), so the safety has to live in the key: the second
    // press sends the SAME command_id, and the gateway replays the first command
    // instead of writing a second quotation.
    await tester.tap(find.textContaining('Xác nhận tạo báo giá'));
    await tester.pumpAndSettle();
    expect(requests.length, 2);
    expect(requests[0]['command_id'], isNotNull);
    expect(requests[1]['command_id'], requests[0]['command_id'],
        reason: 'a retry must replay, never write a second offer');
  });
}
