import 'dart:convert';

import 'package:dio/dio.dart';

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
  CopilotApiClient({required this.dio}) {
    // Server policy (2026-09-14): non-loopback binds require HTTP basic auth.
    // The app sends credentials only when they were compiled in via dart-define
    // — no credentials in code, no silent fallback to anonymous.
    final user = const String.fromEnvironment('COPILOT_AUTH_USER');
    final pass = const String.fromEnvironment('COPILOT_AUTH_PASSWORD');
    if (user.isNotEmpty && pass.isNotEmpty) {
      dio.options.headers['authorization'] =
          'Basic ${base64Encode(utf8.encode('$user:$pass'))}';
    }
  }

  final Dio dio;

  /// Throws [CopilotException] subclasses — the controller maps them to UI
  /// state; the UI must never see a raw DioError.
  Future<AskResult> ask(String text) async {
    try {
      final res = await dio.post<Map<String, dynamic>>(
        '/ask',
        data: {'text': text},
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
