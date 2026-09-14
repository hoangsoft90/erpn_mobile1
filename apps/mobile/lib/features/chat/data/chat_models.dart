import 'package:flutter/foundation.dart';

/// Parsed body of one POST /ask response (`result` field).
///
/// Contract (verified from copilot-server.mjs answerQuestion()):
/// - `answer` is null (no route / customer not found), a String
///   (customer/sales/payment), or a List of String (inventory rows).
/// - `routed` is false OR {group, matched}.
/// - `customer` is {id, name} when one was resolved.
/// - `reason` explains a null answer (no route / customer not found).
@immutable
class AskResult {
  const AskResult({
    required this.question,
    required this.answer,
    this.routedGroup,
    this.routedMatched,
    this.customerId,
    this.customerName,
    this.outstandingVnd,
    this.openInvoices,
    this.normalizedText,
    this.amount,
    this.reason,
  });

  factory AskResult.fromJson(Map<String, dynamic> json) {
    final rawAnswer = json['answer'];
    String? answerText;
    if (rawAnswer is String) {
      answerText = rawAnswer;
    } else if (rawAnswer is List) {
      final lines = rawAnswer.whereType<String>().toList();
      answerText =
          lines.isEmpty ? null : lines.map((line) => '• $line').join('\n');
    }

    final routed = json['routed'];
    String? routedGroup;
    String? routedMatched;
    if (routed is Map<String, dynamic>) {
      routedGroup = routed['group'] as String?;
      routedMatched = routed['matched'] as String?;
    }

    final customer = json['customer'];
    String? customerId;
    String? customerName;
    if (customer is Map<String, dynamic>) {
      customerId = customer['id'] as String?;
      customerName = customer['name'] as String?;
    }

    final normalized = json['normalized'];
    String? normalizedText;
    int? amount;
    if (normalized is Map<String, dynamic>) {
      normalizedText = normalized['text'] as String?;
      amount = (normalized['amount'] as num?)?.toInt();
    }

    return AskResult(
      question: json['question'] as String? ?? '',
      answer: answerText,
      routedGroup: routedGroup,
      routedMatched: routedMatched,
      customerId: customerId,
      customerName: customerName,
      outstandingVnd: (json['outstanding_vnd'] as num?)?.toInt(),
      openInvoices: (json['open_invoices'] as num?)?.toInt(),
      normalizedText: normalizedText,
      amount: amount,
      reason: json['reason'] as String?,
    );
  }

  final String question;
  final String? answer;
  final String? routedGroup;
  final String? routedMatched;
  final String? customerId;
  final String? customerName;
  final int? outstandingVnd;
  final int? openInvoices;
  final String? normalizedText;
  final int? amount;
  final String? reason;

  bool get hasAnswer => answer != null && answer!.trim().isNotEmpty;
}

/// One chat turn as stored in local history (versioned key chat_history_v1).
@immutable
class ChatTurn {
  const ChatTurn({
    required this.question,
    required this.answer,
    required this.ok,
    required this.ts,
    this.routedGroup,
  });

  /// [typedQuestion] is what the user actually typed — preferred over the
  /// server's echoed `question`, so the bubble always matches the input.
  factory ChatTurn.fromAskResult(AskResult r, {String? typedQuestion}) =>
      ChatTurn(
        question:
            (typedQuestion != null && typedQuestion.trim().isNotEmpty)
                ? typedQuestion.trim()
                : r.question,
        answer: r.answer ?? r.reason ?? '',
        ok: r.hasAnswer,
        ts: DateTime.now(),
        routedGroup: r.routedGroup,
      );

  factory ChatTurn.fromJson(Map<String, dynamic> json) => ChatTurn(
        question: json['question'] as String? ?? '',
        answer: json['answer'] as String? ?? '',
        ok: json['ok'] as bool? ?? false,
        ts: DateTime.tryParse(json['ts'] as String? ?? '') ?? DateTime.now(),
        routedGroup: json['routed_group'] as String?,
      );

  final String question;
  final String answer;
  final bool ok;
  final DateTime ts;
  final String? routedGroup;

  Map<String, dynamic> toJson() => {
        'question': question,
        'answer': answer,
        'ok': ok,
        'ts': ts.toIso8601String(),
        if (routedGroup != null) 'routed_group': routedGroup,
      };
}
