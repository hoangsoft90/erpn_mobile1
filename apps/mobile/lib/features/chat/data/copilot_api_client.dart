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
  CopilotApiClient({required this.dio});

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
