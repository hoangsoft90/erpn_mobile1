import 'dart:convert';
import 'dart:typed_data';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:erpn_mobile/app/providers.dart';
import 'package:erpn_mobile/core/settings/app_settings_service.dart';
import 'package:erpn_mobile/features/chat/data/copilot_api_client.dart';
import 'package:erpn_mobile/features/chat/data/photo_picker_service.dart';
import 'package:erpn_mobile/features/chat/presentation/screens/chat_screen.dart';

/// C1 (`plan3` Trụ C, `.plan/phases3/C1-camera-fallback-chat.md`).
///
/// The property these tests defend is the same shape as P6's for the microphone,
/// and it is absolute: **a photo is an input modality, not a command.** Reading
/// one may only put text in the editable field. It must never send on the user's
/// behalf, and it must never reach `/execute`.
///
/// Three further rules the phase asks for, each tested below rather than
/// asserted in a comment:
/// * a reading the server is not sure about (LOW_CONFIDENCE / NO_TEXT / an
///   unknown status) must fall back to manual entry — never be used silently;
/// * what the reader claimed (confidence, provider) is shown, and a MOCK reading
///   is labelled as a rehearsal, so a fixture can never pass as a document;
/// * cancelling the picker makes no request at all.
///
/// CI has no camera, so [PhotoPicker] is faked and the gateway is a mock adapter.
/// Hermetic: no network, no platform channel.

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

/// A camera under test control: it returns bytes or nothing, and it counts its
/// calls (a cancel that still produced a request would be a bug).
class _FakePicker implements PhotoPicker {
  _FakePicker({this.photo, this.throwOnPick = false});

  PickedPhoto? photo;
  bool throwOnPick;
  int pickCount = 0;

  @override
  Future<PickedPhoto?> pick() async {
    pickCount++;
    if (throwOnPick) throw StateError('camera unavailable');
    return photo;
  }
}

final _photo = PickedPhoto(
  bytes: Uint8List.fromList([0xFF, 0xD8, 0xFF, 0xE0, 1, 2, 3]),
  mimeType: 'image/jpeg',
);

const _answerResult = {
  'question': 'chị Lan còn nợ bao nhiêu',
  'normalized': {'text': 'Lan còn nợ bao nhiêu'},
  'routed': {'group': 'customer', 'matched': 'còn nợ'},
  'customer': {'id': 'CUST-001', 'name': 'Nguyễn Thị Lan'},
  'outstanding_vnd': 2500000,
  'open_invoices': 1,
  'answer': 'Nguyễn Thị Lan còn nợ 2.500.000đ (1 chứng từ chưa thanh toán).',
};

/// What `POST /ocr` answers. Defaults to a good, confident read.
Map<String, dynamic> _ocrResult({
  String status = 'OK',
  String text = 'HÓA ĐƠN 000123\nNguyễn Thị Lan\nCám heo 25kg x 10 bao',
  bool? usable,
  double? confidence = 0.93,
  double? minConfidence = 0.6,
  bool instructionPatternFound = false,
  bool mock = false,
  String provider = 'mock',
}) =>
    {
      'status': status,
      'text': text,
      'usable': usable ?? (status == 'OK'),
      'confidence': confidence,
      'min_confidence': minConfidence,
      'instruction_pattern_found': instructionPatternFound,
      'provider': provider,
      'model': 'vision-fixture',
      'mock': mock,
    };

class _Recorder {
  _Recorder({this.ocr, this.ocrStatus = 200, this.ocrError});

  Map<String, dynamic>? ocr;
  int ocrStatus;

  /// A server-side refusal instead of a reading (`{ok:false,error}`).
  String? ocrError;

  final List<String> paths = [];
  final List<Map<String, dynamic>> bodies = [];

  Handler get handler => (options) async {
        paths.add(options.path);
        final data = options.data;
        bodies.add(data is String
            ? jsonDecode(data) as Map<String, dynamic>
            : (data as Map<String, dynamic>? ?? const {}));
        if (options.path == '/ocr') {
          if (ocrStatus != 200) {
            return _json({'ok': false, 'error': ocrError ?? 'Ảnh không hợp lệ.'},
                ocrStatus);
          }
          return _json({'ok': true, 'result': ocr ?? _ocrResult()});
        }
        return _json({'ok': true, 'result': _answerResult});
      };
}

/// Minimal stand-in for the Settings screen's voice switch. The point of using
/// it here is to prove the camera channel does NOT inherit the dictation
/// convenience: a user who opted into auto-send for SPEECH did not opt into
/// auto-send for a photo.
class _FakeSettings extends AppSettingsService {
  _FakeSettings(this.voiceAutoSend) : super(prefs: null);

  @override
  final bool voiceAutoSend;
}

Future<void> _pumpChat(
  WidgetTester tester, {
  required _FakePicker picker,
  required _Recorder rec,
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
        photoPickerProvider.overrideWithValue(picker),
        if (voiceAutoSend)
          appSettingsServiceProvider.overrideWithValue(_FakeSettings(true)),
      ],
      child: const MaterialApp(home: ChatScreen()),
    ),
  );
  await tester.pumpAndSettle();
}

/// Tap the camera icon and wait for the sheet to appear.
Future<void> _tapCamera(WidgetTester tester) async {
  await tester.tap(find.byIcon(Icons.photo_camera_outlined));
  await tester.pumpAndSettle();
}

String _fieldText(WidgetTester tester) =>
    tester.widget<TextField>(find.byType(TextField)).controller!.text;

void main() {
  testWidgets('a photo becomes TEXT in the editable field — no send',
      (WidgetTester tester) async {
    final picker = _FakePicker(photo: _photo);
    final rec = _Recorder();
    await _pumpChat(tester, picker: picker, rec: rec);

    await _tapCamera(tester);

    expect(picker.pickCount, 1);
    expect(rec.paths, ['/ocr'],
        reason: 'reading a photo is the ONLY request the camera makes');
    // The recognised text is shown for review, editable, before any use.
    expect(find.textContaining('HÓA ĐƠN 000123'), findsOneWidget);

    await tester.tap(find.byKey(const Key('ocr-inject')));
    await tester.pumpAndSettle();

    expect(_fieldText(tester), startsWith('HÓA ĐƠN 000123'));
    expect(rec.paths, ['/ocr'],
        reason: 'injecting must NOT send — the user reads it and presses Gửi');
    expect(find.byType(AlertDialog), findsNothing);
  });

  testWidgets('the user can edit the injected text before sending',
      (WidgetTester tester) async {
    final picker = _FakePicker(photo: _photo);
    final rec = _Recorder();
    await _pumpChat(tester, picker: picker, rec: rec);

    await _tapCamera(tester);
    await tester.tap(find.byKey(const Key('ocr-inject')));
    await tester.pumpAndSettle();

    // The reader got the amount wrong — exactly the case plan3 §6.4 worries
    // about, and the reason the field is editable rather than a command.
    await tester.enterText(find.byType(TextField), 'chị Lan còn nợ bao nhiêu');
    await tester.tap(find.byIcon(Icons.send));
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ocr', '/ask']);
    expect(rec.bodies.last['text'], 'chị Lan còn nợ bao nhiêu');
  });

  testWidgets('camera flow never touches /execute', (WidgetTester tester) async {
    final picker = _FakePicker(photo: _photo);
    final rec = _Recorder();
    await _pumpChat(tester, picker: picker, rec: rec);

    await _tapCamera(tester);
    await tester.tap(find.byKey(const Key('ocr-inject')));
    await tester.pumpAndSettle();
    await tester.tap(find.byIcon(Icons.send));
    await tester.pumpAndSettle();

    expect(rec.paths.where((p) => p.contains('execute')), isEmpty,
        reason: 'a photo can never authorize a WRITE — confirm still required');
  });

  testWidgets('what the reader claimed is shown (confidence + provider)',
      (WidgetTester tester) async {
    final picker = _FakePicker(photo: _photo);
    final rec = _Recorder(
      ocr: _ocrResult(confidence: 0.93, minConfidence: 0.6, provider: 'router-vision'),
    );
    await _pumpChat(tester, picker: picker, rec: rec);

    await _tapCamera(tester);

    expect(find.textContaining('Độ tin cậy 93%'), findsOneWidget);
    expect(find.textContaining('tối thiểu 60%'), findsOneWidget);
    expect(find.textContaining('router-vision'), findsOneWidget);
  });

  testWidgets('a low-confidence read falls back to manual entry',
      (WidgetTester tester) async {
    final picker = _FakePicker(photo: _photo);
    final rec = _Recorder(
      ocr: _ocrResult(status: 'LOW_CONFIDENCE', confidence: 0.31, minConfidence: 0.6),
    );
    await _pumpChat(tester, picker: picker, rec: rec);

    await _tapCamera(tester);

    expect(find.byKey(const Key('ocr-inject')), findsNothing,
        reason: 'an unsure reading must never be offered for use');
    expect(find.textContaining('đọc không chắc'), findsOneWidget);

    await tester.tap(find.byKey(const Key('ocr-manual')));
    await tester.pumpAndSettle();
    expect(find.textContaining('nhập tay'), findsOneWidget);
    expect(_fieldText(tester), isEmpty);
  });

  testWidgets('no text found → manual entry, nothing to inject',
      (WidgetTester tester) async {
    final picker = _FakePicker(photo: _photo);
    final rec = _Recorder(ocr: _ocrResult(status: 'NO_TEXT', text: '', confidence: 0.1));
    await _pumpChat(tester, picker: picker, rec: rec);

    await _tapCamera(tester);

    expect(find.byKey(const Key('ocr-inject')), findsNothing);
    expect(find.textContaining('không đọc được chữ nào'), findsOneWidget);
  });

  // FAIL-CLOSED: a status this build does not know must not be treated as a good
  // read even when the payload claims `usable: true`. Otherwise a future server
  // vocabulary would silently mean "the photo was read correctly".
  testWidgets('an unknown status is refused even if usable claims true',
      (WidgetTester tester) async {
    final picker = _FakePicker(photo: _photo);
    final rec = _Recorder(
      ocr: _ocrResult(status: 'PARTIAL_V2', usable: true),
    );
    await _pumpChat(tester, picker: picker, rec: rec);

    await _tapCamera(tester);

    expect(find.byKey(const Key('ocr-inject')), findsNothing);
    expect(find.textContaining('không rõ ràng'), findsOneWidget);
  });

  testWidgets('instruction-shaped content in the photo is called out',
      (WidgetTester tester) async {
    final picker = _FakePicker(photo: _photo);
    final rec = _Recorder(ocr: _ocrResult(instructionPatternFound: true));
    await _pumpChat(tester, picker: picker, rec: rec);

    await _tapCamera(tester);

    expect(find.textContaining('giống chỉ dẫn hệ thống'), findsOneWidget);
  });

  // The mock provider answers every photo identically — a deployment left on it
  // must not present a fixture as the user's document.
  testWidgets('a mock reading is labelled as a rehearsal',
      (WidgetTester tester) async {
    final picker = _FakePicker(photo: _photo);
    final rec = _Recorder(ocr: _ocrResult(mock: true));
    await _pumpChat(tester, picker: picker, rec: rec);

    await _tapCamera(tester);

    expect(find.textContaining('bản đọc THỬ'), findsOneWidget);
  });

  testWidgets('cancelling the picker makes no request at all',
      (WidgetTester tester) async {
    final picker = _FakePicker(photo: null);
    final rec = _Recorder();
    await _pumpChat(tester, picker: picker, rec: rec);

    await _tapCamera(tester);

    expect(picker.pickCount, 1);
    expect(rec.paths, isEmpty);
    expect(find.byKey(const Key('ocr-inject')), findsNothing);
  });

  testWidgets('no camera on the device → clear message, no crash',
      (WidgetTester tester) async {
    final picker = _FakePicker(throwOnPick: true);
    final rec = _Recorder();
    await _pumpChat(tester, picker: picker, rec: rec);

    await _tapCamera(tester);

    expect(find.textContaining('Không mở được camera'), findsOneWidget);
    expect(rec.paths, isEmpty);
  });

  testWidgets('the server refuses the photo → its message, no send',
      (WidgetTester tester) async {
    final picker = _FakePicker(photo: _photo);
    final rec = _Recorder(ocrStatus: 413, ocrError: 'Ảnh quá lớn.');
    await _pumpChat(tester, picker: picker, rec: rec);

    await _tapCamera(tester);

    expect(find.textContaining('Ảnh quá lớn'), findsOneWidget);
    expect(rec.paths, ['/ocr']);
    expect(_fieldText(tester), isEmpty);
  });

  // The voice convenience must not leak into the camera: a photo is precisely
  // the input a human has to read before acting on.
  testWidgets('even with voice auto-send ON, a photo never auto-sends',
      (WidgetTester tester) async {
    final picker = _FakePicker(photo: _photo);
    final rec = _Recorder();
    await _pumpChat(tester, picker: picker, rec: rec, voiceAutoSend: true);

    await _tapCamera(tester);
    await tester.tap(find.byKey(const Key('ocr-inject')));
    await tester.pumpAndSettle();

    expect(rec.paths, ['/ocr'],
        reason: 'voiceAutoSend is a DICTATION setting, not a camera one');
  });
}
