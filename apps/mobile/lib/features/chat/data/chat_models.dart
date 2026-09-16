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
    this.proposal,
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

    // Phase 6: the erpn.proposal/v1 object (copilot-server.mjs
    // action-proposal.mjs). Absent on early returns, explicit null when a
    // route matched but nothing could be proposed.
    final rawProposal = json['proposal'];
    final proposal = rawProposal is Map<String, dynamic>
        ? ActionProposal.fromJson(rawProposal)
        : null;

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
      proposal: proposal,
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

  /// Phase 6 action proposal (erpn.proposal/v1) — display-only for now;
  /// the confirm-execute flow arrives with Phase 7.
  final ActionProposal? proposal;

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
    this.proposal,
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
        proposal: r.proposal,
      );

  factory ChatTurn.fromJson(Map<String, dynamic> json) => ChatTurn(
        question: json['question'] as String? ?? '',
        answer: json['answer'] as String? ?? '',
        ok: json['ok'] as bool? ?? false,
        ts: DateTime.tryParse(json['ts'] as String? ?? '') ?? DateTime.now(),
        routedGroup: json['routed_group'] as String?,
        proposal: json['proposal'] is Map<String, dynamic>
            ? ActionProposal.fromJson(json['proposal'] as Map<String, dynamic>)
            : null,
      );

  final String question;
  final String answer;
  final bool ok;
  final DateTime ts;
  final String? routedGroup;

  /// Phase 6 proposal card source (null = no proposal this turn).
  final ActionProposal? proposal;

  Map<String, dynamic> toJson() => {
        'question': question,
        'answer': answer,
        'ok': ok,
        'ts': ts.toIso8601String(),
        if (routedGroup != null) 'routed_group': routedGroup,
        if (proposal != null) 'proposal': proposal!.toJson(),
      };
}

/// Phase 6 — one action proposal (erpn.proposal/v1, action-proposal.mjs).
///
/// Display-only in Phase 6: the card renders [riskIcon], [riskLabel],
/// [summary] and the entity. There is deliberately NO confirm button yet —
/// nothing exists to confirm-execute until Phase 7.
@immutable
class ActionProposal {
  const ActionProposal({
    required this.schema,
    required this.action,
    required this.risk,
    required this.riskIcon,
    required this.riskLabel,
    required this.needConfirm,
    required this.needDoubleConfirm,
    required this.executable,
    required this.entityKind,
    this.entityId,
    this.entityName,
    this.summary,
  });

  factory ActionProposal.fromJson(Map<String, dynamic> json) {
    // Fail-CLOSED parsing (review 2026-09-16): a missing/invalid risk field
    // must NOT quietly render as the green READ badge. Unknown risk ⇒ UNKNOWN
    // styling via _riskColor's default branch and needConfirm = true, so a
    // corrupted payload can never look safer than it is.
    final rawRisk = json['risk'];
    final risk = rawRisk is String && rawRisk.isNotEmpty
        ? rawRisk
        : 'UNKNOWN';
    final display = json['risk_display'];
    final entity = json['entity'];
    final parsedNeedConfirm = json['need_confirm'];
    final parsedNeedDouble = json['need_double_confirm'];
    final parsedExecutable = json['executable'];
    return ActionProposal(
      schema: json['schema'] as String? ?? 'erpn.proposal/v1',
      action: json['action'] as String? ?? '',
      risk: risk,
      riskIcon: display is Map<String, dynamic>
          ? display['icon'] as String? ?? ''
          : '',
      riskLabel: display is Map<String, dynamic>
          ? display['label'] as String? ?? ''
          : (risk == 'UNKNOWN' ? 'Không rõ mức rủi ro' : ''),
      needConfirm: parsedNeedConfirm is bool
          ? parsedNeedConfirm
          : risk != 'READ', // unknown ⇒ treat as needing confirmation
      needDoubleConfirm: parsedNeedDouble is bool
          ? parsedNeedDouble
          : risk == 'UNKNOWN',
      executable: parsedExecutable is bool
          ? parsedExecutable
          : false, // unknown ⇒ never claim executable
      entityKind:
          entity is Map<String, dynamic> ? entity['kind'] as String? : null,
      entityId: entity is Map<String, dynamic> ? entity['id'] as String? : null,
      entityName:
          entity is Map<String, dynamic> ? entity['name'] as String? : null,
      summary: json['summary'] as String?,
    );
  }

  final String schema;
  final String action;
  final String risk; // READ / LOW / HIGH / CRITICAL
  final String riskIcon;
  final String riskLabel;
  final bool needConfirm;
  final bool needDoubleConfirm;
  final bool executable;
  final String? entityKind;
  final String? entityId;
  final String? entityName;
  final String? summary;

  Map<String, dynamic> toJson() => {
        'schema': schema,
        'action': action,
        'risk': risk,
        'risk_display': {'icon': riskIcon, 'label': riskLabel},
        'need_confirm': needConfirm,
        'need_double_confirm': needDoubleConfirm,
        'executable': executable,
        'entity': {
          'kind': entityKind,
          'id': entityId,
          'name': entityName,
        },
        if (summary != null) 'summary': summary,
      };

  /// The confirm button shows ONLY for HIGH-risk payment proposals — the one
  /// write Phase 7 allows. READ cards never get it; CRITICAL arrives in a
  /// later phase and would demand double-confirm UI anyway.
  bool get confirmable =>
      action == 'create_payment_entry' && risk == 'HIGH' && entityId != null;
}
