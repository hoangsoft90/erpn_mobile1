import 'dart:async';
import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/foundation.dart';

import '../../../core/constants/app_constants.dart';
import '../../../core/settings/app_settings_service.dart';
import '../../ops/data/daily_summary_models.dart';
import '../../ops/data/drill_models.dart';
import 'chat_models.dart';
import 'ocr_models.dart';

/// Failures carry Vietnamese messages — the UI shows them verbatim.
sealed class CopilotException implements Exception {
  const CopilotException(this.message);
  final String message;

  @override
  String toString() => message;
}

class CopilotNetworkException extends CopilotException {
  const CopilotNetworkException()
      : super('Không kết nối được máy chủ. Kiểm tra COPILOT_BASE_URL và mạng.');
}

class CopilotTimeoutException extends CopilotException {
  const CopilotTimeoutException()
      : super('Hết thời gian chờ máy chủ.');
}

class CopilotServerException extends CopilotException {
  const CopilotServerException(super.message);
}

/// The DSH gateway REFUSED the question before running anything — a write-shaped
/// question, a rate limit, an unsafe patch config. Keeping [code] separate from
/// [message] is what lets a caller/test tell "the gateway blocked this on
/// purpose" (DSH_WRITE_BLOCKED) apart from "the session broke".
class CopilotDshRefusedException extends CopilotException {
  const CopilotDshRefusedException(this.code, super.message);
  final String code;
}

/// One `/dsh/ask` answer. Deliberately narrow: the agent's text plus WHICH
/// target answered it. There is no proposal, no command id, and no confirm
/// affordance here — DSH mode is read-only on the server side (plan §11), so
/// the client has nothing to confirm and never calls /execute from this path.
@immutable
class DshAnswer {
  const DshAnswer({
    required this.answer,
    this.erpnextTarget,
    this.sessionId,
    this.conversationId,
  });

  final String answer;

  /// `REAL` / `MOCK` — echoed by the gateway from dsh's own stderr. Shown so a
  /// demo can never be mistaken for real ERPNext data.
  final String? erpnextTarget;

  /// The dsh runtime's session id for this call (audit correlation).
  final String? sessionId;

  /// NEXT6 Prompt-5: the conversation id the gateway ACTUALLY used — present
  /// even when the client omitted one (the server mints `randomUUID()`), so
  /// the controller can pin the thread the server answered in. Null only when
  /// an older gateway (or an error envelope) does not carry it.
  final String? conversationId;
}

/// Thin dio wrapper around the copilot HTTP contract:
///   POST `/ask`       {text} -> {ok:true, result:{...}} | {ok:false, error}
///   POST `/read/list` {screen, entity_id, limit?} -> the A1 drill-down view
///   GET  `/health`    -> {ok:true, service, port}
class CopilotApiClient {
  CopilotApiClient({
    required this.dio,
    this.settings,
    this.fallbackBaseUrl,
  }) {
    // Server policy (2026-09-14): non-loopback binds require HTTP basic auth.
    // The compiled-in credentials are the FALLBACK; a value saved in the
    // Settings screen takes precedence (see [_applySettings]).
    final user = const String.fromEnvironment('COPILOT_AUTH_USER');
    final pass = const String.fromEnvironment('COPILOT_AUTH_PASSWORD');
    if (user.isNotEmpty && pass.isNotEmpty) {
      _compiledAuthHeader =
          'Basic ${base64Encode(utf8.encode('$user:$pass'))}';
      dio.options.headers['authorization'] = _compiledAuthHeader;
    }
  }

  final Dio dio;

  /// Live user settings (nullable so unit tests can construct the client
  /// without one — behaviour then equals the pre-Settings app).
  final AppSettingsService? settings;

  /// The `--dart-define=COPILOT_BASE_URL` value, used when Settings holds no
  /// URL. Null in tests, where [Dio.options.baseUrl] is the base instead.
  final String? fallbackBaseUrl;

  /// Auth header compiled in via `--dart-define` (null when none) — restored
  /// whenever the Settings screen has no complete credentials saved.
  String? _compiledAuthHeader;

  /// Applies the CURRENT settings to the Dio options just before a request.
  ///
  /// Called on every [ask] so changing the URL/credentials in the Settings
  /// screen takes effect immediately, with no app restart and no cached copy.
  /// Precedence: saved settings > compiled-in dart-define > Dio defaults.
  ///
  /// PUBLIC because two widgets post `/execute` on the SAME Dio the client uses
  /// (the proposal card's confirm button and the M1 create-customer offer) and
  /// they must not skip this step: a non-loopback server requires basic auth on
  /// EVERY route (http-ask.mjs: "Non-loopback: every route (including /health)
  /// requires basic auth"), so a confirm sent without these headers is a 401 and
  /// the write never happens. Found in review 2026-09-24 — the raw-dio path had
  /// silently omitted it since Phase 7.
  void applySettings() => _applySettings();

  void _applySettings() {
    final s = settings;
    final savedBase = s?.gatewayBaseUrl ?? '';
    if (savedBase.isNotEmpty) {
      // Trim a trailing slash so '/ask' never becomes '//ask'.
      dio.options.baseUrl = savedBase.replaceAll(RegExp(r'/+$'), '');
    } else if (fallbackBaseUrl != null && fallbackBaseUrl!.isNotEmpty) {
      dio.options.baseUrl = fallbackBaseUrl!;
    }

    final user = s?.gatewayAuthUser ?? '';
    final pass = s?.gatewayAuthPassword ?? '';
    final auth = (user.isNotEmpty && pass.isNotEmpty)
        ? 'Basic ${base64Encode(utf8.encode('$user:$pass'))}'
        : _compiledAuthHeader;
    if (auth != null) {
      dio.options.headers['authorization'] = auth;
    } else {
      dio.options.headers.remove('authorization');
    }
  }

  /// Throws [CopilotException] subclasses — the controller maps them to UI
  /// state; the UI must never see a raw DioError.
  /// [entityId] is the customer the user picked in the candidate picker (P1
  /// §4.4). It is sent back so the server can re-validate it against a fresh
  /// ERPNext read — the id is a hint, never authority (the server refuses an id
  /// that is not in the list it just read).
  ///
  /// [submitNow] (F7-2): the app's "allow real submission" setting AS IT STOOD
  /// when this question was asked. The server freezes it into the proposal
  /// snapshot, so the card's wording and the execute behaviour can never
  /// diverge from what the user saw when they asked.
  /// DSH mode (`.plan/dsh_end_to_end.md`): the EXPLICIT opt-in agent path.
  ///
  /// Only the mode selector calls this — never `ask()`, never a fallback for an
  /// unknown question (plan §12 "KHÔNG AUTO FALLBACK"): the deterministic path
  /// owns every normal question, and this path exists only because the user
  /// chose it.
  ///
  /// [conversationId] maps to the gateway's per-conversation session context
  /// (bounded TTL server-side) so a follow-up like "thế còn tháng trước?" has
  /// something to refer to. One id per app session.
  Future<DshAnswer> dshAsk(String message, {String? conversationId}) async {
    _applySettings();
    try {
      final res = await dio.post<Map<String, dynamic>>(
        '/dsh/ask',
        data: {
          'message': message,
          if (conversationId != null && conversationId.isNotEmpty)
            'conversation_id': conversationId,
        },
        // Per-request override: the agent session outlives askTimeout.
        options: Options(
          receiveTimeout: AppConstants.dshTimeout,
          sendTimeout: AppConstants.dshTimeout,
        ),
      );
      final body = res.data ?? const {};
      if (body['ok'] != true) {
        throw CopilotDshRefusedException(
          (body['code'] as String?) ?? 'DSH_FAILED',
          (body['error'] as String?) ?? 'Phiên AI không trả về kết quả.',
        );
      }
      final result = body['result'];
      final answer =
          result is Map<String, dynamic> ? result['answer'] as String? : null;
      if (answer == null || answer.trim().isEmpty) {
        throw const CopilotServerException(
          'Phiên AI không trả về câu trả lời nào.',
        );
      }
      return DshAnswer(
        answer: answer.trim(),
        erpnextTarget: body['erpnext_target'] as String?,
        sessionId: body['dsh_session_id'] as String?,
        conversationId: body['conversation_id'] as String?,
      );
    } on DioException catch (err) {
      // The gateway answers NON-2xx with a JSON envelope and real Vietnamese
      // copy — surface its words and code rather than a generic failure.
      final data = err.response?.data;
      if (data is Map<String, dynamic>) {
        final serverError = data['error'];
        if (serverError is String && serverError.isNotEmpty) {
          if (err.response?.statusCode == 401) {
            throw const CopilotServerException(
              'Máy chủ yêu cầu xác thực nhưng app không có thông tin đăng nhập. '
              'APK cần build lại với --dart-define=COPILOT_AUTH_USER và '
              'COPILOT_AUTH_PASSWORD trỏ đúng máy chủ.',
            );
          }
          throw CopilotDshRefusedException(
            (data['code'] as String?) ?? 'DSH_FAILED',
            serverError,
          );
        }
      }
      if (err.type == DioExceptionType.connectionTimeout ||
          err.type == DioExceptionType.receiveTimeout ||
          err.type == DioExceptionType.sendTimeout) {
        throw const CopilotTimeoutException();
      }
      throw const CopilotNetworkException();
    }
  }

  /// [sourceDocument] (next3/B) is the identity of the PAPER document the
  /// sentence came from, when a reading produced one (`OcrSourceDocument`). It
  /// travels BESIDE the text because it must not travel INSIDE it: the pipeline
  /// reads an invoice number such as "00049" as an amount, so the number is
  /// never composed into the sentence.
  ///
  /// Omitted entirely when null — the server refuses a HALF identity (400)
  /// rather than quietly forgetting it, so this method never sends a partial one.
  /// For every capability that does not declare a document-identity layer the
  /// field is inert.
  Future<AskResult> ask(
    String text, {
    String? entityId,
    bool submitNow = false,
    Map<String, dynamic>? sourceDocument,
  }) async {
    _applySettings();
    try {
      final res = await dio.post<Map<String, dynamic>>(
        '/ask',
        data: {
          'text': text,
          if (entityId != null && entityId.isNotEmpty) 'entity_id': entityId,
          'submit_now': submitNow,
          'source_document': ?sourceDocument,
        },
      );
      final body = res.data ?? const {};
      final ok = body['ok'];
      if (ok is! bool || !ok) {
        throw CopilotServerException(
          (body['error'] as String?) ?? 'Máy chủ trả về kết quả không hợp lệ.',
        );
      }
      final result = body['result'];
      if (result is! Map<String, dynamic>) {
        throw CopilotServerException('Máy chủ trả thiếu trường result.');
      }
      return AskResult.fromJson(result);
    } on DioException catch (err) {
      _failFromDio(err);
    }
  }

  /// A1 (plan3 Trụ A) — the fresh, bounded READ behind a bubble drill-down.
  ///
  /// READ ONLY, and deliberately so: this method can fetch documents, and there
  /// is no counterpart that writes. [screen] and [entityId] come from the
  /// server's own UI intent; the server re-validates the id against live
  /// ERPNext data and refuses one it cannot find, so a stale/crafted id can only
  /// ever produce a refusal.
  Future<ReadScreenData> readList({
    required String screen,
    required String entityId,
    int? limit,
  }) async {
    _applySettings();
    try {
      // D4 (§2.4) — a bound on the WHOLE read, so this screen cannot spin: the
      // loop's own `_loading` flag would otherwise stay true while the server
      // answers nothing at all.
      final res = await dio
          .post<Map<String, dynamic>>(
            '/read/list',
            data: {
              'screen': screen,
              'entity_id': entityId,
              // Null-aware element: an omitted limit lets the server's contract
              // default apply instead of sending a meaningless 0.
              'limit': ?limit,
            },
          )
          .timeout(AppConstants.readTimeout);
      final body = res.data ?? const {};
      if (body['ok'] != true) {
        throw CopilotServerException(
          (body['error'] as String?) ?? 'Máy chủ trả về kết quả không hợp lệ.',
        );
      }
      final result = body['result'];
      if (result is! Map<String, dynamic>) {
        throw CopilotServerException('Máy chủ trả thiếu trường result.');
      }
      return ReadScreenData.fromJson(result);
    } on TimeoutException {
      throw const CopilotTimeoutException();
    } on DioException catch (err) {
      _failFromDio(err);
    }
  }

  /// P4-3 (plan4_final §4.2) — the drawer's OWN read route: the day's summary.
  ///
  /// Same posture as [readList] and it matters more here, because this is the
  /// screen a shop owner opens to look at money: READ ONLY, and there is no
  /// counterpart in this client that writes. The route never runs the NLP
  /// classifier (the capability id is GIVEN), so no sentence can talk its way
  /// into these numbers, and company scope is decided server-side — the client
  /// has no parameter for it.
  ///
  /// [date] is optional (`YYYY-MM-DD`); omitted, the server answers for TODAY at
  /// the shop (Asia/Ho_Chi_Minh), not the phone's today.
  ///
  /// Note the envelope: unlike `/ask` and `/read/list`, this route returns the
  /// §4.3 object itself (no `result` wrapper) — parsed as such on purpose.
  Future<DailySummary> dailySummary({String? date}) async {
    _applySettings();
    try {
      final res = await dio
          .get<Map<String, dynamic>>(
            '/read/daily-summary',
            // Null-aware entry: an omitted date lets the server's "today at the
            // shop" default apply instead of sending an empty string.
            queryParameters: {'date': ?date},
          )
          // D4 (§2.4) — total bound on the read (see [AppConstants.readTimeout]).
          .timeout(AppConstants.readTimeout);
      final body = res.data ?? const {};
      if (body['ok'] != true) {
        throw CopilotServerException(
          (body['error'] as String?) ?? 'Máy chủ trả về kết quả không hợp lệ.',
        );
      }
      // rawJson travels with the parsed object so the offline cache replays the
      // server's exact bytes rather than a re-serialised copy.
      return DailySummary.fromJson(body, rawJson: jsonEncode(body));
    } on TimeoutException {
      throw const CopilotTimeoutException();
    } on DioException catch (err) {
      _failFromDio(err);
    }
  }

  /// P4-4 (plan4_final §4.4) — the day drill behind a metric on "Tóm tắt ngày".
  ///
  /// [drillId] is an ID from a closed set the server declared, NOT a question:
  /// §4.4 forbids free text as the default way to pick a capability, and this
  /// client has no method that would let one in. READ ONLY — like
  /// [dailySummary], there is no writing counterpart here, and company/date
  /// scope stays server-side (an omitted [date] means today at the shop).
  ///
  /// Same envelope note as [dailySummary]: the payload IS the response body
  /// (no `result` wrapper), parsed as such on purpose.
  Future<DrillScreenData> readDrill({required String drillId, String? date}) async {
    _applySettings();
    try {
      final res = await dio
          .get<Map<String, dynamic>>(
            '/read/drill',
            queryParameters: {'drill_id': drillId, 'date': ?date},
          )
          // D4 (§2.4) — total bound on the read (see [AppConstants.readTimeout]).
          .timeout(AppConstants.readTimeout);
      final body = res.data ?? const {};
      if (body['ok'] == false) {
        throw CopilotServerException(
          (body['error'] as String?) ?? 'Máy chủ trả về kết quả không hợp lệ.',
        );
      }
      return DrillScreenData.fromJson(body);
    } on TimeoutException {
      throw const CopilotTimeoutException();
    } on DioException catch (err) {
      _failFromDio(err);
    }
  }

  /// C1 (`plan3` Trụ C) — the camera channel: send a PHOTO, get TEXT back.
  ///
  /// This is an INPUT method, and its shape says so: the response is a reading
  /// (status + text + how sure the reader was). It cannot return a proposal, it
  /// cannot carry a command id, and there is no counterpart here that executes
  /// anything — the text goes back to the user's editable field, and whatever
  /// they then send travels the ordinary `/ask` path.
  ///
  /// [bytes] must already be small: the gateway reads a body of at most 1 MB
  /// and base64 inflates it by ~4/3, which is why
  /// [SystemPhotoPicker] downscales before it ever gets here.
  Future<OcrRead> ocr({
    required Uint8List bytes,
    String mimeType = 'image/jpeg',
    String? hint,
  }) async {
    _applySettings();
    try {
      final res = await dio.post<Map<String, dynamic>>(
        '/ocr',
        data: {
          'image': base64Encode(bytes),
          'mime_type': mimeType,
          if (hint != null && hint.isNotEmpty) 'hint': hint,
        },
        options: Options(
          sendTimeout: AppConstants.ocrTimeout,
          receiveTimeout: AppConstants.ocrTimeout,
        ),
      );
      final body = res.data ?? const {};
      if (body['ok'] != true) {
        throw CopilotServerException(
          (body['error'] as String?) ?? 'Máy chủ trả về kết quả đọc ảnh không hợp lệ.',
        );
      }
      final result = body['result'];
      if (result is! Map<String, dynamic>) {
        // FAIL CLOSED: a reading without its shape is not a reading. Returning
        // an empty "success" here would let a photo silently become no text.
        throw CopilotServerException('Máy chủ trả thiếu trường result cho ảnh.');
      }
      return OcrRead.fromJson(result);
    } on DioException catch (err) {
      _failFromDio(err);
    }
  }

  /// C2 (`plan3` Trụ C) — turn a reading into SLOTS: what the photo appears to
  /// say, for the user to correct before anything is proposed.
  ///
  /// [kind] is a WORD the contract declares (`sales` / `purchase`) — never a
  /// capability id; the server maps it. [read] carries the provenance of the
  /// reading that produced [text], because the server refuses to seed a draft
  /// document from a low-confidence or MOCK reading (and the mock is the default
  /// provider, so this refusal is the ordinary case, not a rare one).
  ///
  /// The answer is slots, not a proposal: no price, no command id, and nothing
  /// here can execute. The corrected sentence goes back through [ask].
  Future<OcrSlots> ocrSlots({
    required String text,
    required String kind,
    required OcrRead read,
  }) async {
    _applySettings();
    try {
      final res = await dio.post<Map<String, dynamic>>(
        '/ocr/slots',
        data: {
          'text': text,
          'kind': kind,
          'ocr': read.provenance,
        },
        options: Options(
          sendTimeout: AppConstants.ocrTimeout,
          receiveTimeout: AppConstants.ocrTimeout,
        ),
      );
      final body = res.data ?? const {};
      if (body['ok'] != true) {
        throw CopilotServerException(
          (body['error'] as String?) ?? 'Máy chủ không đọc được các mục trong ảnh.',
        );
      }
      final result = body['result'];
      // FAIL CLOSED: a form built from a payload without the shape it claims
      // would show invented fields to the person about to confirm a document.
      if (result is! Map<String, dynamic> || result['capability'] is! String) {
        throw CopilotServerException('Máy chủ trả thiếu thông tin chứng từ cho ảnh.');
      }
      return OcrSlots.fromJson(result);
    } on DioException catch (err) {
      _failFromDio(err);
    }
  }

  /// A2/A3 (`.plan/next3/implementation.md`, `.plan/next4/A3-result.md`) — the
  /// SUPPLIER-FILE channel: send a HÓA ĐƠN ĐIỆN TỬ file and get back the SAME
  /// slots the camera produces ([OcrSlots]), so there is exactly ONE form and
  /// one pipeline for all three channels (photo, `.xml`, `.pdf`).
  ///
  /// Exactly ONE of [xml] (the file's own text, A2) or [pdfBase64] (the file's
  /// raw bytes, A3) travels per request — the route refuses BOTH with
  /// `EINVOICE_INPUT_AMBIGUOUS`, because the two are two READINGS of one
  /// document and picking between them silently means the user confirms a
  /// document that is not the file they attached. The app never parses either.
  ///
  /// The answer is slots, not a proposal: no price comes from the file, no
  /// command id exists, and nothing here can execute. An unknown supplier MST
  /// comes back as a WARNING with candidates — never an auto-created Supplier.
  /// The corrected sentence goes back through [ask].
  Future<OcrSlots> einvoiceSlots({String? xml, String? pdfBase64}) async {
    // XOR, mirrored from the server's own refusal — but caught HERE as a
    // programming error instead of spending a request to be told so.
    final hasXml = xml != null && xml.trim().isNotEmpty;
    final hasPdf = pdfBase64 != null && pdfBase64.trim().isNotEmpty;
    if (hasXml == hasPdf) {
      throw ArgumentError(
        'einvoiceSlots: gửi ĐÚNG MỘT trong xml (A2) hoặc pdf_base64 (A3)',
      );
    }
    _applySettings();
    try {
      final res = await dio.post<Map<String, dynamic>>(
        '/input/einvoice',
        // `kind` is a WORD from the contract's list — never a capability id, and
        // never something the caller chooses here: this channel offers exactly
        // one kind (`einvoice_policy.document_kinds` = ["purchase"]), and the
        // server owns the kind → capability mapping. A second kind would arrive
        // with its own UI choice, at which point this becomes a parameter.
        data: hasXml
            ? {'xml': xml, 'kind': 'purchase'}
            : {'pdf_base64': pdfBase64, 'kind': 'purchase'},
        options: Options(
          sendTimeout: AppConstants.ocrTimeout,
          receiveTimeout: AppConstants.ocrTimeout,
        ),
      );
      final body = res.data ?? const {};
      if (body['ok'] != true) {
        throw CopilotServerException(
          (body['error'] as String?) ?? 'Máy chủ không đọc được file hoá đơn này.',
        );
      }
      final result = body['result'];
      // FAIL CLOSED: a form built from a payload without the shape it claims
      // would show invented fields to the person about to confirm a document.
      // `kind` is checked too because [OcrSlots.fromJson] casts it: a payload
      // without it must become this one clean refusal, not a raw TypeError.
      if (result is! Map<String, dynamic> ||
          result['capability'] is! String ||
          result['kind'] is! String) {
        throw CopilotServerException('Máy chủ trả thiếu thông tin chứng từ cho file hoá đơn.');
      }
      return OcrSlots.fromJson(result);
    } on DioException catch (err) {
      _failFromDio(err);
    }
  }

  /// One mapping for every refusal the server can send, shared by the read
  /// methods so their error surfaces cannot drift apart. Never returns.
  Never _failFromDio(DioException err) {
    // Server-side 4xx/5xx already carry a clean JSON {ok:false,error} —
    // surface that message instead of a generic network error.
    final data = err.response?.data;
    if (data is Map<String, dynamic>) {
      final serverError = data['error'];
      if (serverError is String && serverError.isNotEmpty) {
        // 401 is actionable, not just an error string: it means the APK was
        // built without COPILOT_AUTH_* dart-defines while the server requires
        // auth. Say what to DO, in Vietnamese (server's "unauthorized" alone
        // is not actionable for the shop owner).
        if (err.response?.statusCode == 401) {
          throw const CopilotServerException(
            'Máy chủ yêu cầu xác thực nhưng app không có thông tin đăng nhập. '
            'APK cần build lại với --dart-define=COPILOT_AUTH_USER và '
            'COPILOT_AUTH_PASSWORD trỏ đúng máy chủ.',
          );
        }
        throw CopilotServerException(serverError);
      }
    }
    if (err.type == DioExceptionType.connectionTimeout ||
        err.type == DioExceptionType.receiveTimeout ||
        err.type == DioExceptionType.sendTimeout) {
      throw const CopilotTimeoutException();
    }
    throw const CopilotNetworkException();
  }
}
