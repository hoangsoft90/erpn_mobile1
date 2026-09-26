import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/core/settings/app_settings_service.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/chat/data/einvoice_file_picker.dart';
import 'package:erpn_mobile/features/chat/data/ocr_models.dart';
import 'package:erpn_mobile/features/chat/presentation/screens/chat_screen.dart';

/// A2 + A3 (`.plan/next3/implementation.md`, `.plan/next4/A3-result.md`): the
/// HĐĐT FILE channel in the app — a `.xml` file's text (A2) and a `.pdf` file's
/// bytes (A3).
///
/// The property these tests defend: **a supplier's file is an input modality,
/// not a command.** It may become a DRAFT document, but only through the form
/// the camera already uses and through the one existing pipeline. Concretely:
///
///  * the file is sent as TEXT to `POST /input/einvoice` and parsed by the
///    gateway only — the app has no XML parser (a second parser is a second
///    reading of the same document);
///  * what comes back is SLOTS shown EDITABLE, and the sentence sent carries the
///    user's corrections, composed by the SAME `OcrCompose` the camera uses;
///  * nothing here can execute: the only requests are `/input/einvoice` and the
///    ordinary `/ask`, and closing the form sends nothing;
///  * an unknown supplier MST stays a WARNING with candidates — never an
///    auto-created Supplier, never an auto-picked party;
///  * a file the app or the server refuses produces a Vietnamese message and
///    NO request/`/ask` at all.

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

/// A file chooser under test control: it returns a file or nothing, and counts
/// its calls (a cancel that still produced a request would be a bug).
class _FakeFilePicker implements EinvoiceFilePicker {
  _FakeFilePicker({this.file, this.refusal, this.throwOnPick = false});

  PickedEinvoiceFile? file;

  /// A refusal of the picked FILE (empty / too large / not text).
  EinvoiceFileException? refusal;
  bool throwOnPick;
  int pickCount = 0;

  @override
  Future<PickedEinvoiceFile?> pick() async {
    pickCount++;
    if (throwOnPick) throw StateError('no file chooser');
    final r = refusal;
    if (r != null) throw r;
    return file;
  }
}

const _xmlText = '<HDon><DLHDon><TTChung><SHDon>0000123</SHDon></TTChung></DLHDon></HDon>';

final _file = PickedXmlFile(xml: _xmlText, name: 'hd-0000123.xml');

/// A3 — the PDF half. The bytes are deliberately NOT a real PDF: the app must
/// never read them, so every assertion below is about WHICH FORM they travel in
/// (base64 in `pdf_base64`, and `xml` absent), never about their content. A
/// fixture that happened to be a valid PDF would make these tests pass for the
/// wrong reason if a client-side reader ever appeared.
final _pdfBytes = Uint8List.fromList(utf8.encode('%PDF-1.7 (fixture, never parsed)'));
final _pdfFile = PickedPdfFile(bytes: _pdfBytes, name: 'hd-0000123.pdf');

const _answerResult = {
  'question': 'đặt mua 10 Bao Cám gà thịt 25kg từ Đại lý Cám Bình Dương',
  'normalized': {'text': 'đặt mua 10 Bao Cám gà thịt 25kg từ Đại lý Cám Bình Dương'},
  'routed': {'group': 'purchase_order_write', 'matched': 'đặt mua'},
  'supplier': {'id': 'SUP-BINH-DUONG', 'name': 'Đại lý Cám Bình Dương'},
  'answer': 'Đề xuất TẠO ĐƠN MUA NHÁP cho Đại lý Cám Bình Dương: 10 Bao Cám gà thịt 25kg',
};

/// What `POST /input/einvoice` answers — the real shape `buildEinvoiceSlots`
/// returns (mcp-erpnext/src/einvoice/einvoice-slots.mjs), including the
/// `source_document` block and the file-only provenance flags.
Map<String, dynamic> _slots({
  String? partyName = 'Đại lý Cám Bình Dương',
  List<Map<String, dynamic>> lines = const [
    {
      'item_code': 'CAM-GA-10KG',
      'item_name': 'Cám gà thịt 10kg',
      'stock_uom': 'Bao',
      'qty': 10,
      'uom': 'Bao',
      'raw_quantity': '10 Bao',
    },
  ],
  List<Map<String, dynamic>> warnings = const [],
  List<Map<String, dynamic>> candidates = const [],
  Map<String, dynamic>? sourceDocument,
  String kind = 'purchase',
}) =>
    {
      'kind': kind,
      'capability': 'purchase_order.create',
      'label': 'Đơn mua',
      'text': 'hoá đơn 1-0000123 · ngày 2026-09-24 · người bán Đại lý Cám Bình Dương',
      'party': {
        'role': 'supplier',
        'resolved':
            partyName == null ? null : {'id': 'SUP-BINH-DUONG', 'name': partyName},
        'ambiguous': false,
        'candidates': candidates,
        'matched_by': 'tax_id',
        'claimed_tax_id': '0300000002',
      },
      'lines': lines,
      'money_vnd': 4427500,
      'warnings': warnings,
      // next3/B: the identity block. The DEFAULT is a HALF identity (no date,
      // no MST) on purpose — that is the ordinary shape for a reading that only
      // got the goods, and the app must not send it.
      'source_document': sourceDocument ??
          {
            'source': 'einvoice_xml',
            'invoice_no': '0000123',
            'total_vnd': 4427500,
          },
      'provenance': {
        'from_file': true,
        'source': 'einvoice_xml',
        'invoice_no': '0000123',
        'invoice_date': '2026-09-24',
        'parsed_lines': 1,
      },
    };

class _Recorder {
  _Recorder({this.slots, this.slotsRefusal, this.refusalStatus = 400});

  Map<String, dynamic>? slots;

  /// The server's own refusal instead of slots: `{code, error}` in Vietnamese.
  Map<String, dynamic>? slotsRefusal;
  int refusalStatus;

  final List<String> paths = [];
  final List<Map<String, dynamic>> bodies = [];

  Handler get handler => (options) async {
        paths.add(options.path);
        final data = options.data;
        bodies.add(data is String
            ? jsonDecode(data) as Map<String, dynamic>
            : (data as Map<String, dynamic>? ?? const {}));
        if (options.path == '/input/einvoice') {
          if (slotsRefusal != null) {
            return _json({'ok': false, ...slotsRefusal!}, refusalStatus);
          }
          return _json({'ok': true, 'result': slots ?? _slots()});
        }
        return _json({'ok': true, 'result': _answerResult});
      };
}

/// Stand-in for the Settings screen's voice switch, so the SECOND input-bar
/// layout can be exercised here too (same helper shape as `chat_camera_test`).
class _FakeSettings extends AppSettingsService {
  _FakeSettings(this.voiceAutoSend) : super(prefs: null);

  @override
  final bool voiceAutoSend;
}

Future<void> _pumpChat(
  WidgetTester tester,
  _Recorder rec,
  _FakeFilePicker picker, {
  bool voiceAutoSend = false,
}) async {
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
        einvoiceFilePickerProvider.overrideWithValue(picker),
        if (voiceAutoSend)
          appSettingsServiceProvider.overrideWithValue(_FakeSettings(true)),
      ],
      child: const MaterialApp(home: ChatScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> _tapXml(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.description_outlined));
  await tester.pumpAndSettle();
}

void main() {
  // ───────────────────────────────────────────────────────────────────────────
  // The picker's own rules — pure, no plugin, no device.
  // ───────────────────────────────────────────────────────────────────────────

  // `phases3` CẤm + the A2 task: ONE XML parser, and it is the gateway's
  // (`mcp-erpnext/src/einvoice/einvoice-xml.mjs`). The app may only move the
  // file's TEXT around — a second parser is a second reading of the same
  // document, i.e. a way for the user to confirm one thing and the file to have
  // said another. Static, repo-wide, so it cannot be forgotten in a later edit.
  test('the app contains no XML parser at all', () {
    final offenders = <String>[];
    for (final entity in Directory('lib').listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      final source = entity.readAsStringSync();
      if (RegExp(r'package:xml/|XmlDocument|XmlElement|parseXml\s*\(')
          .hasMatch(source)) {
        offenders.add(entity.path);
      }
    }
    expect(offenders, isEmpty,
        reason: 'the gateway owns the only XML parser; found: $offenders');
  });

  // A3: the same tripwire for the OTHER reader. A PDF reader on the client would
  // be a second reading of the same document — and the A3 spike showed how many
  // ways a text layer can be misread (labels sitting next to labels, a bare "so"
  // inside "mã số thuế", FlateDecode bombs). The bytes go up untouched.
  test('the app contains no PDF reader at all', () {
    final offenders = <String>[];
    for (final entity in Directory('lib').listSync(recursive: true)) {
      if (entity is! File || !entity.path.endsWith('.dart')) continue;
      final source = entity.readAsStringSync();
      if (RegExp(r'package:pdf/|package:pdfx/|PdfDocument|PdfReader|PDFDocument|'
              r'syncfusion_flutter_pdf|pdf_render')
          .hasMatch(source)) {
        offenders.add(entity.path);
      }
    }
    expect(offenders, isEmpty,
        reason: 'the gateway owns the only PDF reader; found: $offenders');
  });

  // A3: which READER a file needs is decided by the file's own name, and an
  // unknown name is refused rather than guessed. A provider that ignores the
  // chooser's filter can hand back anything.
  test('the picked file is routed by extension, and anything else is refused', () {
    final pdf = decodeEinvoiceFile(_pdfBytes, 'hoa-don.PDF');
    expect(pdf, isA<PickedPdfFile>());
    expect((pdf as PickedPdfFile).base64, base64Encode(_pdfBytes),
        reason: 'the wire form is the class\'s business, not the screen\'s');

    final xml = decodeEinvoiceFile(Uint8List.fromList(utf8.encode(_xmlText)), 'hd.XML');
    expect(xml, isA<PickedXmlFile>());

    expect(
      () => decodeEinvoiceFile(_pdfBytes, 'bao-cao.docx'),
      throwsA(isA<EinvoiceFileException>()
          .having((e) => e.message, 'message', contains('Chỉ nhận file'))),
    );
    expect(
      () => decodeEinvoiceFile(_pdfBytes, 'khong-co-duoi'),
      throwsA(isA<EinvoiceFileException>()),
    );
  });

  test('an empty PDF is refused, not sent', () {
    expect(
      () => decodeEinvoicePdf(Uint8List(0), 'a.pdf'),
      throwsA(isA<EinvoiceFileException>()
          .having((e) => e.message, 'message', contains('rỗng'))),
    );
  });

  // The PDF cap is 650 KB (the server's own `max_pdf_bytes`), NOT the 950 KB the
  // XML channel uses — and it is what keeps the base64 body under 1 MB.
  test('a PDF over the policy cap is refused with its size in the message', () {
    expect(
      () => decodeEinvoicePdf(Uint8List(einvoiceMaxPdfBytes + 1), 'big.pdf'),
      throwsA(isA<EinvoiceFileException>()
          .having((e) => e.message, 'message', contains('vượt mức'))),
    );
    expect(einvoiceMaxPdfBytes, lessThan(einvoiceMaxXmlBytes),
        reason: 'base64 inflates the file ~4/3 — the PDF cap must stay under the XML one');
  });

  test('the file is decoded as text, and a UTF-8 BOM is stripped', () {
    final withBom = Uint8List.fromList(
      [0xEF, 0xBB, 0xBF, ...utf8.encode(_xmlText)],
    );
    expect(decodeEinvoiceXml(withBom, 'a.xml').xml, _xmlText);
  });

  test('an empty file is refused, not sent', () {
    expect(
      () => decodeEinvoiceXml(Uint8List(0), 'a.xml'),
      throwsA(isA<EinvoiceFileException>()
          .having((e) => e.message, 'message', contains('rỗng'))),
    );
  });

  test('a whitespace-only file is refused', () {
    expect(
      () => decodeEinvoiceXml(Uint8List.fromList(utf8.encode('   \n ')), 'a.xml'),
      throwsA(isA<EinvoiceFileException>()),
    );
  });

  // The cap mirrors the server's own policy; the point is that the user gets a
  // sentence rather than an opaque transport error (and we do not spend a 1 MB
  // upload to learn the file was never going to fit).
  test('a file over the policy cap is refused with its size in the message', () {
    final big = Uint8List(einvoiceMaxXmlBytes + 1);
    expect(
      () => decodeEinvoiceXml(big, 'big.xml'),
      throwsA(isA<EinvoiceFileException>()
          .having((e) => e.message, 'message', contains('vượt mức'))),
    );
  });

  // A wrong decode produces mojibake that still parses as XML — a form full of
  // corrupted names the user would then confirm. So: refuse, never repair.
  test('bytes that are not UTF-8 are refused (never decoded as Latin-1)', () {
    expect(
      () => decodeEinvoiceXml(Uint8List.fromList([0x3C, 0x80, 0x3E]), 'a.xml'),
      throwsA(isA<EinvoiceFileException>()
          .having((e) => e.message, 'message', contains('UTF-8'))),
    );
  });

  // ...unless a BOM says otherwise: a BOM is unambiguous, so UTF-16 decodes.
  test('a UTF-16 file is decoded when its BOM says so', () {
    final le = Uint8List.fromList(
      [0xFF, 0xFE, 0x3C, 0x00, 0x61, 0x00, 0x2F, 0x00, 0x3E, 0x00],
    );
    final be = Uint8List.fromList(
      [0xFE, 0xFF, 0x00, 0x3C, 0x00, 0x61, 0x00, 0x2F, 0x00, 0x3E],
    );
    expect(decodeEinvoiceXml(le, 'a.xml').xml, '<a/>');
    expect(decodeEinvoiceXml(be, 'a.xml').xml, '<a/>');
  });

  // ───────────────────────────────────────────────────────────────────────────
  // The channel in the app
  // ───────────────────────────────────────────────────────────────────────────

  testWidgets('a file becomes SLOTS → a corrected sentence → the ONE pipeline',
      (WidgetTester tester) async {
    final rec = _Recorder();
    final picker = _FakeFilePicker(file: _file);
    await _pumpChat(tester, rec, picker);

    await _tapXml(tester);

    expect(picker.pickCount, 1);
    expect(rec.paths, ['/input/einvoice'],
        reason: 'reading a file is the ONLY request this button makes');
    final request = rec.bodies.first;
    expect(request['xml'], _xmlText,
        reason: 'the file travels as TEXT — the gateway owns the only parser');
    expect(request['kind'], 'purchase',
        reason: 'a WORD from the contract, never a capability id');
    expect(request.containsKey('capability'), isFalse);

    // The form says FILE, not "Ảnh" — and the source line is honest too.
    expect(find.text('File hoá đơn → Đơn mua (NHÁP)'), findsOneWidget);
    expect(find.textContaining('trên file hoá đơn: "10 Bao"'), findsOneWidget);
    // Prefilled from the file, editable.
    expect(find.text('Đại lý Cám Bình Dương'), findsOneWidget);

    // The user corrects a misread quantity — the sentence must follow.
    await tester.enterText(find.byKey(const Key('slot-qty-0')), '12');
    await tester.pumpAndSettle();
    expect(find.textContaining('12 Bao Cám gà thịt 10kg'), findsOneWidget);

    await tester.tap(find.byKey(const Key('slots-send')));
    await tester.pumpAndSettle();

    expect(rec.paths, ['/input/einvoice', '/ask']);
    expect(
      rec.bodies.last['text'],
      'đặt mua 12 Bao Cám gà thịt 10kg từ Đại lý Cám Bình Dương',
    );
    expect(rec.paths.where((p) => p.contains('execute')), isEmpty,
        reason: 'a file can never authorize a WRITE — [Xác nhận] still required');
    expect(find.textContaining('Đã gửi câu từ file hd-0000123.xml'), findsOneWidget);
  });

  // The button was added to BOTH input-bar layouts (default + voice-first), so
  // both are pinned — a layout that silently lost the affordance is exactly the
  // kind of drift a claim in a comment cannot prevent.
  testWidgets('the voice-first layout has the XML button too, and it works',
      (WidgetTester tester) async {
    final rec = _Recorder();
    final picker = _FakeFilePicker(file: _file);
    await _pumpChat(tester, rec, picker, voiceAutoSend: true);
    // Which row is on screen is the whole point of this test — assert it, so a
    // future change to the settings seam cannot make this pass by accident by
    // rendering the DEFAULT row's button instead.
    expect(find.byKey(const ValueKey('input-voice-first')), findsOneWidget);

    await _tapXml(tester);

    expect(picker.pickCount, 1);
    expect(rec.paths, ['/input/einvoice']);
    expect(find.text('File hoá đơn → Đơn mua (NHÁP)'), findsOneWidget);
  });

  testWidgets('cancelling the file chooser makes no request at all',
      (WidgetTester tester) async {
    final rec = _Recorder();
    final picker = _FakeFilePicker(file: null);
    await _pumpChat(tester, rec, picker);

    await _tapXml(tester);

    expect(picker.pickCount, 1);
    expect(rec.paths, isEmpty);
    expect(find.byKey(const Key('slots-send')), findsNothing);
  });

  testWidgets('a file the app cannot send → its own Vietnamese reason, no request',
      (WidgetTester tester) async {
    final rec = _Recorder();
    final picker = _FakeFilePicker(
      refusal: const EinvoiceFileException('File XML rỗng — bạn chọn đúng file.'),
    );
    await _pumpChat(tester, rec, picker);

    await _tapXml(tester);

    expect(find.textContaining('File XML rỗng'), findsOneWidget);
    expect(rec.paths, isEmpty);
  });

  testWidgets('no file chooser on the device → clear message, no crash',
      (WidgetTester tester) async {
    final rec = _Recorder();
    final picker = _FakeFilePicker(throwOnPick: true);
    await _pumpChat(tester, rec, picker);

    await _tapXml(tester);

    expect(find.textContaining('Không mở được trình chọn file'), findsOneWidget);
    expect(rec.paths, isEmpty);
  });

  // A3 — the PDF half of the same channel: bytes up as base64, `xml` absent
  // (the route refuses BOTH), and then the SAME form, the SAME sentence, the
  // SAME one pipeline. No second path exists for PDF.
  testWidgets('a .pdf becomes SLOTS through the SAME form and pipeline',
      (WidgetTester tester) async {
    final rec = _Recorder(
      slots: _slots(sourceDocument: {
        'source': 'einvoice_pdf',
        'invoice_no': '0000123',
        'invoice_date': '2026-09-24',
        'total_vnd': 4427500,
      }),
    );
    final picker = _FakeFilePicker(file: _pdfFile);
    await _pumpChat(tester, rec, picker);

    await _tapXml(tester);

    expect(picker.pickCount, 1);
    expect(rec.paths, ['/input/einvoice'],
        reason: 'reading a file is the ONLY request this button makes');
    final request = rec.bodies.first;
    expect(request['pdf_base64'], base64Encode(_pdfBytes),
        reason: 'the PDF travels as its raw bytes, base64 — no client-side read');
    expect(request.containsKey('xml'), isFalse,
        reason: 'XOR: the route refuses a request carrying both readings');
    expect(request['kind'], 'purchase');

    // The sheet is the file sheet, and says so for a PDF too.
    expect(find.text('File hoá đơn → Đơn mua (NHÁP)'), findsOneWidget);

    await tester.tap(find.byKey(const Key('slots-send')));
    await tester.pumpAndSettle();

    expect(rec.paths, ['/input/einvoice', '/ask']);
    expect(rec.paths.where((p) => p.contains('execute')), isEmpty,
        reason: 'a PDF can never authorize a WRITE — [Xác nhận] still required');
    expect(find.textContaining('Đã gửi câu từ file hd-0000123.pdf'), findsOneWidget);
  });

  // The remedy for a scan is the CAMERA, and that is the server's own sentence —
  // the app must not paraphrase it into something less actionable, and must not
  // invent numbers to fill a form from a PDF it could not read.
  testWidgets('a scanned PDF (422 NO_TEXT) keeps the server reason, points at the camera',
      (WidgetTester tester) async {
    final rec = _Recorder(
      refusalStatus: 422,
      slotsRefusal: {
        'code': 'EINVOICE_PDF_NO_TEXT',
        'error':
            'PDF này không có lớp chữ (bản scan) — bạn dùng nút camera để chụp ảnh hoá đơn',
      },
    );
    await _pumpChat(tester, rec, _FakeFilePicker(file: _pdfFile));

    await _tapXml(tester);

    expect(find.textContaining('không có lớp chữ'), findsOneWidget);
    expect(find.textContaining('camera'), findsOneWidget);
    expect(rec.paths, ['/input/einvoice'],
        reason: 'no form opened, so no /ask was ever sent');
    expect(find.byKey(const Key('slots-send')), findsNothing);
    expect(find.byKey(const Key('slot-qty-0')), findsNothing);
  });

  // The server owns the parse. Its refusal is already a Vietnamese sentence the
  // user can act on, so it is surfaced verbatim — and no form appears, so a
  // half-read file can never become a confirmable document.
  testWidgets('a server refusal (not an invoice) opens no form and sends nothing',
      (WidgetTester tester) async {
    final rec = _Recorder(
      refusalStatus: 400,
      slotsRefusal: {
        'code': 'XML_NOT_INVOICE',
        'error': 'file XML không có phần dữ liệu hóa đơn (DLHDon) — không phải hóa đơn điện tử',
      },
    );
    await _pumpChat(tester, rec, _FakeFilePicker(file: _file));

    await _tapXml(tester);

    expect(find.textContaining('không phải hóa đơn điện tử'), findsOneWidget);
    expect(rec.paths, ['/input/einvoice']);
    expect(find.byKey(const Key('slots-send')), findsNothing);
    expect(find.byKey(const Key('slots-party')), findsNothing);
  });

  testWidgets('an incomplete invoice (422) keeps the server reason and no form',
      (WidgetTester tester) async {
    final rec = _Recorder(
      refusalStatus: 422,
      slotsRefusal: {
        'code': 'EINVOICE_INCOMPLETE',
        'error': 'file XML còn 1 chỗ chưa đọc được: dòng 1: không đọc được thành số',
      },
    );
    await _pumpChat(tester, rec, _FakeFilePicker(file: _file));

    await _tapXml(tester);

    expect(find.textContaining('không đọc được thành số'), findsOneWidget);
    expect(find.byKey(const Key('slots-send')), findsNothing);
  });

  // THE master-data rule of this phase: an MST the site does not know is a
  // WARNING naming it, plus a supplier the user must pick. Never a creation.
  testWidgets('an unknown supplier MST is a warning + candidates, never a create',
      (WidgetTester tester) async {
    final rec = _Recorder(
      slots: _slots(
        partyName: null,
        candidates: const [
          {'name': 'Đại lý Cám Bình Dương'},
          {'name': 'Cửa hàng Cám Bình An'},
        ],
        warnings: const [
          {
            'code': 'SUPPLIER_NOT_FOUND',
            'reason':
                'MST 0300000009 không có trong danh mục nhà cung cấp của ERPNext — '
                    'chọn đúng đối tác đã có (KHÔNG tự tạo mới)',
          },
        ],
      ),
    );
    await _pumpChat(tester, rec, _FakeFilePicker(file: _file));

    await _tapXml(tester);

    expect(find.textContaining('KHÔNG tự tạo mới'), findsOneWidget);
    expect(find.widgetWithText(ActionChip, 'Cửa hàng Cám Bình An'), findsOneWidget);

    // With no party resolved, the sentence names none — not a dangling "từ",
    // and not an invented supplier. The user must choose.
    expect(find.text('đặt mua 10 Bao Cám gà thịt 10kg'), findsOneWidget);
    await tester.tap(find.widgetWithText(ActionChip, 'Đại lý Cám Bình Dương'));
    await tester.pumpAndSettle();
    expect(
      find.text('đặt mua 10 Bao Cám gà thịt 10kg từ Đại lý Cám Bình Dương'),
      findsOneWidget,
    );

    // And nothing was written anywhere on this path.
    expect(rec.paths, ['/input/einvoice']);
    expect(rec.bodies.every((b) => !b.containsKey('capability')), isTrue);
  });

  testWidgets('what the file could not resolve is shown on the form',
      (WidgetTester tester) async {
    final rec = _Recorder(
      slots: _slots(
        lines: const [
          {
            'item_code': null,
            'item_name': 'Bao bì nilon loại 50kg',
            'qty': 2,
            'uom': 'Kg',
            'raw_quantity': '2 Kg',
          },
        ],
        warnings: const [
          {
            'code': 'PO_ITEM_UNRESOLVED',
            'reason': 'dòng 1: chưa có mặt hàng "Bao bì nilon loại 50kg" trong danh mục '
                'ERPNext — chọn mặt hàng hoặc nhập tay (KHÔNG tự tạo mặt hàng mới)',
          },
        ],
      ),
    );
    await _pumpChat(tester, rec, _FakeFilePicker(file: _file));

    await _tapXml(tester);

    expect(find.textContaining('KHÔNG tự tạo mặt hàng mới'), findsOneWidget);
    // The document's own words are kept, with no invented item id.
    expect(find.text('Bao bì nilon loại 50kg'), findsOneWidget);
  });

  testWidgets('closing the form sends nothing', (WidgetTester tester) async {
    final rec = _Recorder();
    await _pumpChat(tester, rec, _FakeFilePicker(file: _file));

    await _tapXml(tester);
    await tester.tap(find.byKey(const Key('slots-close')));
    await tester.pumpAndSettle();

    expect(rec.paths, ['/input/einvoice'],
        reason: 'a form the user closed must not become a question');
  });

  // The file carries a total (4.427.500); a rate only ever comes from ERPNext,
  // so the number is a comparison hint on screen and never travels in the
  // question.
  testWidgets('the total printed on the file never enters the question',
      (WidgetTester tester) async {
    final rec = _Recorder();
    await _pumpChat(tester, rec, _FakeFilePicker(file: _file));

    await _tapXml(tester);
    expect(find.textContaining('chỉ để đối chiếu'), findsOneWidget);

    await tester.tap(find.byKey(const Key('slots-send')));
    await tester.pumpAndSettle();

    final sent = rec.bodies.last['text'] as String;
    expect(sent.contains('4.427.500'), isFalse);
    expect(RegExp(r'\d\s*đ').hasMatch(sent), isFalse);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // next3/B — the DOCUMENT IDENTITY the file carries.
  //
  // The server dedupes a written draft on it, and it must NOT travel inside the
  // sentence (the pipeline reads "0000123" as an amount), so it goes beside it.
  // ───────────────────────────────────────────────────────────────────────────

  /// A COMPLETE identity — what a well-formed HĐĐT gives.
  const fullIdentity = {
    'source': 'einvoice_xml',
    'invoice_no': '0000123',
    'invoice_series': '1C25TAA',
    'invoice_date': '2026-09-24',
    'seller_tax_id': '0300000002',
    'seller_name': 'Đại lý Cám Bình Dương',
    'total_vnd': 4427500,
  };

  testWidgets('a complete file identity travels BESIDE the sentence, not inside it',
      (WidgetTester tester) async {
    final rec = _Recorder(slots: _slots(sourceDocument: fullIdentity));
    await _pumpChat(tester, rec, _FakeFilePicker(file: _file));

    await _tapXml(tester);
    await tester.tap(find.byKey(const Key('slots-send')));
    await tester.pumpAndSettle();

    expect(rec.paths, ['/input/einvoice', '/ask']);
    final ask = rec.bodies.last;
    final identity = ask['source_document'] as Map<String, dynamic>?;
    expect(identity, isNotNull,
        reason: 'without it the same file sent twice writes TWO drafts');
    expect(identity!['kind'], 'purchase');
    expect(identity['invoice_no'], '0000123');
    expect(identity['invoice_date'], '2026-09-24');
    expect(identity['seller_tax_id'], '0300000002');
    expect(identity['invoice_series'], '1C25TAA');
    // The identity is IDENTITY ONLY: a total read off the file is display-only
    // and must not travel (rates come from ERPNext, always).
    expect(identity.containsKey('total_vnd'), isFalse);
    expect(identity.containsKey('money_vnd'), isFalse);
    // …and the number is NOT in the question, where it would be read as money.
    expect((ask['text'] as String).contains('0000123'), isFalse);
  });

  testWidgets('a HALF identity is omitted entirely — the question still goes',
      (WidgetTester tester) async {
    // The default fixture is exactly this case: the file gave a number but no
    // date and no MST. Sending it would be a 400 (the server refuses a half
    // identity rather than forgetting it), which would turn the shop's purchase
    // question into a transport error. Omitting it is the honest answer.
    final rec = _Recorder();
    await _pumpChat(tester, rec, _FakeFilePicker(file: _file));

    await _tapXml(tester);
    await tester.tap(find.byKey(const Key('slots-send')));
    await tester.pumpAndSettle();

    expect(rec.paths, ['/input/einvoice', '/ask']);
    expect(rec.bodies.last.containsKey('source_document'), isFalse);
    expect(rec.bodies.last['text'], startsWith('đặt mua'));
  });

  // The model's own rules, exercised without a widget: the app must send an
  // identity the SERVER will accept, or send none at all.
  group('OcrSourceDocument', () {
    Map<String, dynamic> full() {
      final slot = OcrSourceDocument.fromJson(
        {
          'invoice_no': '0000123',
          'invoice_date': '2026-09-24',
          'seller_tax_id': '0300000002',
          'invoice_series': '1C25TAA',
          'total_vnd': 4427500,
        },
        kind: 'purchase',
      );
      return slot!.toAskJson();
    }

    test('a full identity maps to exactly the fields /ask validates', () {
      expect(full(), {
        'kind': 'purchase',
        'invoice_no': '0000123',
        'invoice_date': '2026-09-24',
        'seller_tax_id': '0300000002',
        'invoice_series': '1C25TAA',
      });
    });

    test('anything less than number + date + MST is null, never a partial map', () {
      final incomplete = <Map<String, dynamic>>[
        {},
        {'invoice_no': '0000123'},
        {'invoice_no': '0000123', 'invoice_date': '2026-09-24'},
        {'invoice_no': '0000123', 'seller_tax_id': '0300000002'},
        {'invoice_date': '2026-09-24', 'seller_tax_id': '0300000002'},
        // Present but empty/blank: a whitespace MST is not an MST.
        {'invoice_no': '0000123', 'invoice_date': '2026-09-24', 'seller_tax_id': '   '},
        // Wrong types must not be coerced into a "field".
        {'invoice_no': 123, 'invoice_date': '2026-09-24', 'seller_tax_id': '0300000002'},
      ];
      for (final raw in incomplete) {
        expect(OcrSourceDocument.fromJson(raw, kind: 'purchase'), isNull,
            reason: 'must not send a half identity: $raw');
      }
      expect(OcrSourceDocument.fromJson(null, kind: 'purchase'), isNull);
      expect(OcrSourceDocument.fromJson('nope', kind: 'purchase'), isNull);
      // A payload without a kind cannot label the document it is about.
      expect(
        OcrSourceDocument.fromJson(
          {'invoice_no': '1', 'invoice_date': '2026-09-24', 'seller_tax_id': '2'},
          kind: '',
        ),
        isNull,
      );
    });

    test('the kind comes from the payload, so a sales reading is labelled sales', () {
      final slot = OcrSourceDocument.fromJson(
        {'invoice_no': '0000123', 'invoice_date': '2026-09-24', 'seller_tax_id': '0300000002'},
        kind: 'sales',
      );
      expect(slot!.toAskJson()['kind'], 'sales');
    });
  });
}
