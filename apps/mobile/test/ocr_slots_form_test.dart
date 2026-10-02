import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/chat/data/photo_picker_service.dart';
import 'package:erpn_mobile/features/chat/presentation/screens/chat_screen.dart';

/// C2 (`plan3` Trụ C, `.plan/phases3/C2-camera-to-proposal.md`).
///
/// The property these tests defend: a photo may become a DRAFT DOCUMENT, but
/// only through the ordinary pipeline and only after the user has SEEN and
/// CORRECTED what the photo appeared to say. Concretely:
///
///  * the document KIND is the user's tap (a photo has no verb — measured: an
///    invoice reading routes to `invoice.lookup`), and the app asks the SERVER
///    for slots rather than deciding anything itself;
///  * the slots the server sends back are shown EDITABLE, and the sentence that
///    is sent carries the user's corrections;
///  * nothing here can execute: the only requests are `/ocr/slots` and the
///    ordinary `/ask`, and closing the form sends nothing at all;
///  * a reading the server refuses (low confidence, mock provider) never opens a
///    form, so a fixture cannot become a draft order.

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

class _FakePicker implements PhotoPicker {
  _FakePicker({this.photo});

  PickedPhoto? photo;

  @override
  Future<PickedPhoto?> pick() async => photo;
}

final _photo = PickedPhoto(
  bytes: Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]),
  mimeType: 'image/jpeg',
);

const _readText = 'HÓA ĐƠN Khách hàng: Nguyễn Thị Lan Cám heo tăng trọng 25kg 10 Bao';

const _answerResult = {
  'question': _readText,
  'normalized': {'text': _readText},
  'routed': {'group': 'sales_order_write', 'matched': 'đặt hàng'},
  'customer': {'id': 'CUST-001', 'name': 'Nguyễn Thị Lan'},
  'answer': 'Đề xuất TẠO ĐƠN NHÁP cho Nguyễn Thị Lan: 10 Bao Cám heo tăng trọng 25kg',
};

Map<String, dynamic> _read({
  String status = 'OK',
  double? confidence = 0.93,
  bool mock = false,
}) =>
    {
      'status': status,
      'text': _readText,
      'usable': status == 'OK',
      'confidence': confidence,
      'min_confidence': 0.6,
      'instruction_pattern_found': false,
      'provider': mock ? 'mock' : 'router-vision',
      'model': 'vision-1',
      'mock': mock,
    };

Map<String, dynamic> _slots({
  String kind = 'sales',
  String? partyName = 'Nguyễn Thị Lan',
  bool ambiguous = false,
  List<Map<String, dynamic>> lines = const [
    {
      'item_code': 'CAM-HEO-25KG',
      'item_name': 'Cám heo tăng trọng 25kg',
      'stock_uom': 'Bao',
      'qty': 10,
      'uom': 'Bao',
      'raw_quantity': '10 Bao',
    },
  ],
  List<Map<String, dynamic>> warnings = const [],
}) {
  final sales = kind == 'sales';
  return {
    'kind': kind,
    'capability': sales ? 'sales_order.create' : 'purchase_order.create',
    'label': sales ? 'Đơn bán' : 'Đơn mua',
    'text': _readText,
    'party': {
      'role': sales ? 'customer' : 'supplier',
      'resolved': partyName == null ? null : {'id': 'CUST-001', 'name': partyName},
      'ambiguous': ambiguous,
      'candidates': ambiguous
          ? [
              {'id': 'CUST-001', 'name': 'Nguyễn Thị Lan'},
              {'id': 'CUST-002', 'name': 'Nguyễn Thị Lan Anh'},
            ]
          : const [],
    },
    'lines': lines,
    'money_vnd': 3050000,
    'warnings': warnings,
    'provenance': {
      'from_photo': true,
      'provider': 'router-vision',
      'confidence': 0.93,
      'min_confidence': 0.6,
    },
  };
}

class _Recorder {
  _Recorder({this.read, this.slots, this.slotsRefusal});

  Map<String, dynamic>? read;
  Map<String, dynamic>? slots;

  /// `{code, error}` — the server's refusal instead of slots.
  Map<String, dynamic>? slotsRefusal;

  final List<String> paths = [];
  final List<Map<String, dynamic>> bodies = [];

  Handler get handler => (options) async {
        paths.add(options.path);
        final data = options.data;
        bodies.add(data is String
            ? jsonDecode(data) as Map<String, dynamic>
            : (data as Map<String, dynamic>? ?? const {}));
        if (options.path == '/ocr') {
          return _json({'ok': true, 'result': read ?? _read()});
        }
        if (options.path == '/ocr/slots') {
          if (slotsRefusal != null) {
            return _json({'ok': false, ...slotsRefusal!}, 409);
          }
          return _json({'ok': true, 'result': slots ?? _slots()});
        }
        return _json({'ok': true, 'result': _answerResult});
      };
}

Future<void> _pumpChat(WidgetTester tester, _Recorder rec) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [
        sharedPreferencesProvider.overrideWithValue(null),
        copilotApiClientProvider.overrideWithValue(
          CopilotApiClient(
            dio: Dio(BaseOptions(baseUrl: 'http://mock.local'))
              ..httpClientAdapter = _MockAdapter(rec.handler),
          ),
        ),
        photoPickerProvider.overrideWithValue(_FakePicker(photo: _photo)),
      ],
      child: const MaterialApp(home: ChatScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _openSheet(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.photo_camera_outlined));
  await tester.pumpAndSettle();
}

Future<void> _chooseKind(WidgetTester tester, String kind) async {
  await _openSheet(tester);
  await tester.tap(find.byKey(Key('ocr-kind-$kind')));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets('a confident reading offers the document kinds', (tester) async {
    final rec = _Recorder();
    await _pumpChat(tester, rec);

    await _openSheet(tester);

    expect(find.byKey(const Key('ocr-kind-sales')), findsOneWidget);
    expect(find.byKey(const Key('ocr-kind-purchase')), findsOneWidget);
    // The user's own route to the field is still there.
    expect(find.byKey(const Key('ocr-inject')), findsOneWidget);
  });

  // The kind is a DECISION (which document is this?), so it may only be offered
  // when the server would accept the reading as a basis for one. A mock reading
  // is the default provider's output — a fixture — and a low-confidence read is
  // explicitly "ask again" in the contract.
  testWidgets('a MOCK reading offers no document kind at all', (tester) async {
    final rec = _Recorder(read: _read(mock: true));
    await _pumpChat(tester, rec);

    await _openSheet(tester);

    expect(find.byKey(const Key('ocr-kind-sales')), findsNothing);
    expect(find.byKey(const Key('ocr-kind-purchase')), findsNothing);
  });

  testWidgets('a reading without a confidence offers no document kind',
      (tester) async {
    final rec = _Recorder(read: _read(confidence: null));
    await _pumpChat(tester, rec);

    await _openSheet(tester);

    expect(find.byKey(const Key('ocr-kind-sales')), findsNothing);
  });

  testWidgets('choosing a kind asks the server for slots and shows them prefilled',
      (tester) async {
    final rec = _Recorder();
    await _pumpChat(tester, rec);

    await _chooseKind(tester, 'sales');

    expect(rec.paths, ['/ocr', '/ocr/slots']);
    final request = rec.bodies.last;
    // The app sends the WORD plus the reading's own provenance — and it never
    // decides the capability itself.
    expect(request['kind'], 'sales');
    expect(request['text'], _readText);
    expect((request['ocr'] as Map)['status'], 'OK');
    expect((request['ocr'] as Map)['confidence'], 0.93);
    expect((request['ocr'] as Map)['mock'], false);
    expect(request.containsKey('capability'), isFalse);

    // Prefilled from the photo, and the sentence that would be sent is shown.
    expect(find.text('Nguyễn Thị Lan'), findsOneWidget);
    expect(find.text('Cám heo tăng trọng 25kg'), findsOneWidget);
    expect(
      find.textContaining('đặt hàng cho Nguyễn Thị Lan 10 Bao Cám heo tăng trọng 25kg'),
      findsOneWidget,
    );
    // What the reading could not work out is said out loud, not hidden.
    expect(find.textContaining('trên ảnh: "10 Bao"'), findsOneWidget);
  });

  testWidgets('the user corrects a misread quantity — the sentence carries it',
      (tester) async {
    final rec = _Recorder();
    await _pumpChat(tester, rec);
    await _chooseKind(tester, 'sales');

    // The reader saw "10" on a smudged receipt; the real order was 11.
    await tester.enterText(find.byKey(const Key('slot-qty-0')), '11');
    await tester.pumpAndSettle();
    expect(find.textContaining('11 Bao Cám heo'), findsOneWidget,
        reason: 'the preview must follow the correction, not stay on the photo');

    await tester.tap(find.byKey(const Key('slots-send')));
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ocr', '/ocr/slots', '/ask']);
    final sent = rec.bodies.last['text'] as String;
    expect(sent, 'đặt hàng cho Nguyễn Thị Lan 11 Bao Cám heo tăng trọng 25kg');
    // The price on the photo is a HINT on screen and must never enter the
    // question: rates only ever come from ERPNext (B2/B4 `rate_source`).
    expect(sent.contains('3.050.000'), isFalse);
    expect(RegExp(r'\d\s*đ').hasMatch(sent), isFalse,
        reason: 'a price must never travel in the question');
    expect(rec.paths.where((p) => p.contains('execute')), isEmpty);
  });

  testWidgets('closing the form sends nothing', (tester) async {
    final rec = _Recorder();
    await _pumpChat(tester, rec);
    await _chooseKind(tester, 'sales');

    await tester.tap(find.byKey(const Key('slots-close')));
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ocr', '/ocr/slots'],
        reason: 'a form the user closed must not become a question');
  });

  testWidgets('the whole photo → draft flow never touches /execute',
      (tester) async {
    final rec = _Recorder(slots: _slots(kind: 'purchase'));
    await _pumpChat(tester, rec);
    await _chooseKind(tester, 'purchase');

    // The purchase form asks the SUPPLIER question and names its source.
    expect(find.text('Ảnh → Đơn mua (NHÁP)'), findsOneWidget);
    expect(find.text('Nhà cung cấp'), findsOneWidget);

    await tester.tap(find.byKey(const Key('slots-send')));
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ocr', '/ocr/slots', '/ask']);
    expect(rec.paths.where((p) => p.contains('execute')), isEmpty,
        reason: 'confirming the proposal card is the ONLY path to a write');
    expect(find.byType(AlertDialog), findsNothing);
    expect(rec.bodies.last['text'], startsWith('đặt mua'));
  });

  // The default provider IS the mock, so "the reading is a fixture" is the
  // ordinary case, not an edge case — and the server is the one that decides.
  // Here the app accepted the reading (so the sheet offered the kinds) and the
  // SERVER refused it: the message is surfaced and nothing is sent.
  testWidgets('a server-refused reading opens no form and sends no question',
      (tester) async {
    final rec = _Recorder(
      slotsRefusal: {
        'code': 'OCR_READ_IS_MOCK',
        'error': 'bản đọc này là bản THỬ của máy chủ (mock) — không dựng đề xuất từ dữ liệu mô phỏng',
      },
    );
    await _pumpChat(tester, rec);

    await _chooseKind(tester, 'sales');

    expect(find.textContaining('bản THỬ'), findsOneWidget);
    expect(rec.paths, ['/ocr', '/ocr/slots']);
    expect(find.byKey(const Key('slots-send')), findsNothing);
    expect(find.byKey(const Key('slots-party')), findsNothing);
  });

  testWidgets('an ambiguous name is offered, never auto-picked', (tester) async {
    final rec = _Recorder(
      slots: _slots(
        partyName: null,
        ambiguous: true,
        warnings: const [
          {
            'code': 'AMBIGUOUS_CUSTOMER',
            'reason': 'tên khách trên ảnh khớp nhiều hồ sơ — chọn đúng người',
          },
        ],
      ),
      read: _read(),
    );
    await _pumpChat(tester, rec);
    await _chooseKind(tester, 'sales');

    expect(find.textContaining('khớp nhiều hồ sơ'), findsOneWidget);
    expect(find.widgetWithText(ActionChip, 'Nguyễn Thị Lan Anh'), findsOneWidget);

    // Before a choice, there is no party — so the sentence has nothing to name.
    expect(find.textContaining('đặt hàng cho 10 Bao'), findsOneWidget);
    await tester.tap(find.widgetWithText(ActionChip, 'Nguyễn Thị Lan Anh'));
    await tester.pumpAndSettle();
    expect(find.textContaining('đặt hàng cho Nguyễn Thị Lan Anh 10 Bao'),
        findsOneWidget);
  });

  testWidgets('what the reader could not work out is shown on the form',
      (tester) async {
    final rec = _Recorder(
      slots: _slots(
        lines: const [],
        partyName: null,
        warnings: const [
          {'code': 'SO_QTY_MISSING', 'reason': 'chưa rõ số lượng cho mặt hàng "Cám heo"'},
        ],
      ),
    );
    await _pumpChat(tester, rec);
    await _chooseKind(tester, 'sales');

    expect(find.textContaining('chưa rõ số lượng'), findsOneWidget);
    expect(find.textContaining('không cho ra dòng hàng nào'), findsOneWidget);
  });
}
