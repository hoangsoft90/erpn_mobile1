import 'dart:convert';

import 'package:dio/dio.dart';

import '../../../core/settings/app_settings_service.dart';
import 'chat_models.dart';

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

/// Thin dio wrapper around the copilot HTTP contract:
///   POST `/ask`    {text} -> {ok:true, result:{...}} | {ok:false, error}
///   GET  `/health` -> {ok:true, service, port}
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
  Future<AskResult> ask(String text, {String? entityId, bool submitNow = false}) async {
    _applySettings();
    try {
      final res = await dio.post<Map<String, dynamic>>(
        '/ask',
        data: {
          'text': text,
          if (entityId != null && entityId.isNotEmpty) 'entity_id': entityId,
          'submit_now': submitNow,
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
}
