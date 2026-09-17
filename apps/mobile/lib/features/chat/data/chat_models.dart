import 'dart:math';

import 'package:flutter/foundation.dart';

/// P1 §4.4 — one candidate the user may pick when a WRITE could not settle the
/// customer by itself. `id` is the ERPNext id the picker sends back; it is
/// re-validated server-side, so this list is a suggestion, never authority.
@immutable
class EntityCandidate {
  const EntityCandidate({required this.id, this.name, this.label});

  factory EntityCandidate.fromJson(Map<String, dynamic> json) =>
      EntityCandidate(
        id: json['id'] as String? ?? '',
        name: json['name'] as String?,
        label: json['label'] as String?,
      );

  final String id;
  final String? name;
  final String? label;

  String get display => (label?.isNotEmpty == true)
      ? label!
      : ((name?.isNotEmpty == true) ? '$name ($id)' : id);

  Map<String, dynamic> toJson() => {
        'id': id,
        if (name != null) 'name': name,
        if (label != null) 'label': label,
      };
}

/// Parsed body of one POST /ask response (`result` field).
///
/// Contract (verified from copilot-server.mjs answerQuestion()):
/// - `answer` is null (no route / customer not found), a String
///   (customer/sales/payment), or a List of String (inventory rows).
/// - `routed` is false OR {group, matched}.
/// - `customer` is {id, name} when one was resolved.
/// - `reason` explains a null answer (no route / customer not found).
/// - P1: `error_code` names the refusal (ENTITY_PICK_REQUIRED, NLP_UNAVAILABLE,
///   PAYMENT_AMOUNT_MISSING, AMBIGUOUS_ENTITY...) and `candidates` carries the
///   picker options when the customer could not be settled for a write.
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
    this.errorCode,
    this.candidates = const <EntityCandidate>[],
    this.entityState,
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
      errorCode: json['error_code'] as String?,
      // Tolerant parse (the result40 lesson: a non-list here used to throw and
      // wipe the whole history on load).
      candidates: json['candidates'] is List
          ? (json['candidates'] as List)
              .whereType<Map<String, dynamic>>()
              .map(EntityCandidate.fromJson)
              .where((c) => c.id.isNotEmpty)
              .toList(growable: false)
          : const <EntityCandidate>[],
      entityState: json['entity'] is Map<String, dynamic>
          ? (json['entity'] as Map<String, dynamic>)['state'] as String?
          : null,
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

  /// P1 — the machine-readable refusal code from the pipeline, when there is
  /// no answer (ENTITY_PICK_REQUIRED, NLP_UNAVAILABLE, ...). Null on success.
  final String? errorCode;

  /// P1 §4.4 — picker options offered when a write needs the user to choose.
  final List<EntityCandidate> candidates;

  /// P1 §4.1 — the resolution state the server reached (EXACT_MATCH,
  /// FUZZY_SINGLE_MATCH, AMBIGUOUS_MATCH, NO_MATCH).
  final String? entityState;

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
    this.candidates = const <EntityCandidate>[],
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
        // P1: the picker lives on the turn, so it survives a restart — the
        // user can still choose which customer they meant after reopening.
        candidates: r.candidates,
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
        candidates: json['candidates'] is List
            ? (json['candidates'] as List)
                .whereType<Map<String, dynamic>>()
                .map(EntityCandidate.fromJson)
                .where((c) => c.id.isNotEmpty)
                .toList(growable: false)
            : const <EntityCandidate>[],
      );

  final String question;
  final String answer;
  final bool ok;
  final DateTime ts;
  final String? routedGroup;

  /// Phase 6 proposal card source (null = no proposal this turn).
  final ActionProposal? proposal;

  /// P1 §4.4 — candidates to offer while the customer is not settled.
  final List<EntityCandidate> candidates;

  /// True when this turn is waiting for the user to pick a customer: the server
  /// refused to guess and offered candidates instead (no proposal exists yet).
  bool get awaitingEntityPick => candidates.isNotEmpty && proposal == null;

  /// True while this turn carries an action proposal that has NO final outcome
  /// yet: not refused, and still offering its confirm affordance.
  ///
  /// Safety rule (2026-09-16, B.2): the chat trimmer must NEVER drop such a
  /// turn, no matter how old it is — losing the visible record of a pending
  /// write intent because the chat scrolled long is exactly the kind of silent
  /// data loss this project refuses. A refused card (`isRejected`) is terminal
  /// and trimmable; a plain read turn has no proposal and is trimmable.
  ///
  /// Limitation: a card that WAS executed successfully but whose result only
  /// lives in widget RAM (option (b), result42 — no schema change) still looks
  /// pending here, so it too is kept. Keeping an extra turn is safe; dropping a
  /// pending one is not, so the rule errs on the safe side.
  bool get hasPendingProposal {
    final p = proposal;
    if (p == null) return false;
    if (p.isRejected) return false;
    return p.confirmable;
  }

  Map<String, dynamic> toJson() => {
        'question': question,
        'answer': answer,
        'ok': ok,
        'ts': ts.toIso8601String(),
        if (routedGroup != null) 'routed_group': routedGroup,
        if (proposal != null) 'proposal': proposal!.toJson(),
        if (candidates.isNotEmpty)
          'candidates': candidates.map((c) => c.toJson()).toList(),
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
    required    this.entityKind,
    this.entityId,
    this.entityName,
    this.summary,
    this.commandIdSeed,
    this.createdAt,
    this.rejectionCode,
    this.rejectionProblems = const <String>[],
    this.params,
    this.proposalId,
    this.version,
    this.expiresAt,
    this.dedupRequiresAck = false,
    this.dedupMessage,
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
      // Restored history carries the key it was FIRST confirmed with, so a card
      // reopened after an app restart keeps its identity (see commandId).
      commandIdSeed: json['command_id'] as String?,
      // Phase 9: the server's build time MUST survive the round-trip too —
      // /execute refuses a proposal without it (or older than the TTL), so
      // dropping it here would make every confirm fail.
      createdAt: json['created_at'] as String?,
      // Phase 9 UI (result32): the /execute 409 carries WHY the card was
      // refused (PROPOSAL_STALE with problems[] / PROPOSAL_EXPIRED). The
      // controller attaches these back onto the card so the user sees the
      // concrete reason, not a generic failure.
      rejectionCode: json['rejection_code'] as String?,
      // Tolerant parse (review result40): a NON-list pushed a String through
      // `as List<dynamic>?` ⇒ TypeError ⇒ ChatHistoryService.load() catches it
      // and returns [] — one malformed turn silently wiped the WHOLE history.
      rejectionProblems: json['rejection_problems'] is List
          ? (json['rejection_problems'] as List)
              .map((p) => p.toString())
              .toList(growable: false)
          : const <String>[],
      // result33 review F4: the /execute money-shape gate reads
      // proposal.params.amount_vnd (http-ask.mjs) and 400s without it, and
      // detectDrift reads params.outstanding_vnd/invoice. The model used to
      // DROP params entirely — every real confirm press would have been a
      // 400, invisible to tests that never inspected the sent body.
      params: json['params'] is Map<String, dynamic>
          ? Map<String, dynamic>.unmodifiable(
              json['params'] as Map<String, dynamic>)
          : null,
      // P1 §9: the immutable snapshot's identity. These MUST round-trip —
      // /execute now refuses a proposal that cannot prove its version
      // (PROPOSAL_VERSION_STALE), so dropping them here would make every
      // confirm press fail. Exactly the result33-F4 lesson: a field the server
      // reads must exist in the model that echoes the proposal back.
      proposalId: json['proposal_id'] as String?,
      version: (json['version'] as num?)?.toInt(),
      expiresAt: json['expires_at'] as String?,
      // P1 §10.5: the business-dedup warning. `require_extra_confirm` is set by
      // the server when the same intent was proposed minutes ago; pressing
      // confirm after seeing the warning IS the acknowledgement (sent as
      // dedup_ack), so the flag has to survive restore too — otherwise a
      // restored card would look like a fresh intent and be refused.
      dedupRequiresAck: json['business_dedup'] is Map<String, dynamic> &&
          (json['business_dedup'] as Map<String, dynamic>)['require_extra_confirm'] ==
              true,
      dedupMessage: json['business_dedup'] is Map<String, dynamic>
          ? (json['business_dedup'] as Map<String, dynamic>)['message'] as String?
          : null,
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

  /// The idempotency key this proposal was restored with, if any. Null for a
  /// proposal that just arrived from /ask (a fresh intent).
  final String? commandIdSeed;

  /// When the SERVER built this proposal (ISO-8601). Phase 9 age gate: the
  /// server refuses to execute a proposal older than PROPOSAL_TTL_MS (default
  /// 10 minutes) or one missing this field entirely.
  final String? createdAt;

  /// Phase 9 UI: the machine-readable reason /execute refused this card
  /// (PROPOSAL_STALE / PROPOSAL_EXPIRED / ...). Null while the card is
  /// untouched — set by the controller after a 409 from /execute.
  final String? rejectionCode;

  /// Human-readable mismatches for PROPOSAL_STALE (debt changed, invoice
  /// moved...). Empty unless [rejectionCode] == PROPOSAL_STALE.
  final List<String> rejectionProblems;

  /// P1 §9 — identity + version of the immutable snapshot (server: buildProposal).
  final String? proposalId;
  final int? version;

  /// P1 §9 — when the server considers this proposal too old (ISO-8601).
  final String? expiresAt;

  /// P1 §10.5 — the server saw a similar intent recently: warn + extra confirm.
  final bool dedupRequiresAck;
  final String? dedupMessage;

  /// Operation parameters echoed back on /execute (result33 F4). The server's
  /// money-shape gate reads `params.amount_vnd` and the drift check reads
  /// `params.outstanding_vnd`/`params.invoice` from what the CLIENT sends, so
  /// the confirmed numbers must survive the model round-trip. Unmodifiable:
  /// a card's numbers are fixed at build time — re-asking builds a new
  /// proposal, editing this one in place would defeat the drift check.
  final Map<String, dynamic>? params;

  bool get isRejected => rejectionCode != null;

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
        if (createdAt != null) 'created_at': createdAt,
        // Persist the key so history restore cannot re-key the same card.
        'command_id': commandId,
        // result33 F4: keep the confirmed numbers on the wire (money-shape
        // gate + drift check read them server-side).
        if (params != null) 'params': params,
        // P1 §9: same rule for the snapshot identity — /execute refuses a
        // proposal that cannot prove its version.
        if (proposalId != null) 'proposal_id': proposalId,
        if (version != null) 'version': version,
        if (expiresAt != null) 'expires_at': expiresAt,
        // P1 §10.5: the paid-forward warning travels with the card so a
        // restored duplicate still asks for the extra confirmation. Emitted only
        // when there IS a warning — a normal proposal's payload is unchanged.
        if (dedupRequiresAck || dedupMessage != null)
          'business_dedup': {
            'require_extra_confirm': dedupRequiresAck,
            if (dedupMessage != null) 'message': dedupMessage,
          },
        // Phase 9 UI: the rejection survives history restore too — a stale
        // card reopened after a restart must still show WHY it was refused.
        if (rejectionCode != null) 'rejection_code': rejectionCode,
        if (rejectionProblems.isNotEmpty) 'rejection_problems': rejectionProblems,
      };

  /// The confirm button shows ONLY for HIGH-risk payment proposals — the one
  /// write Phase 7 allows. READ cards never get it; CRITICAL arrives in a
  /// later phase and would demand double-confirm UI anyway.
  bool get confirmable =>
      action == 'create_payment_entry' && risk == 'HIGH' && entityId != null;

  /// Idempotency key for the confirm flow — ONE per proposal INSTANCE.
  ///
  /// User decision 2026-09-16, implementing phase-07 spec "mất mạng → bấm
  /// Confirm lại → không ghi 2 lần": the key is created on first use and kept
  /// for every later press on the SAME card, so a retry after a network error
  /// sends the SAME key and the gateway store replays the first result instead
  /// of writing a second payment. A new /ask answer builds a new
  /// ActionProposal instance → a new key, because that is a new intent.
  ///
  /// The key is cached in an Expando rather than a field so ActionProposal
  /// stays @immutable, and rather than in widget state so a rebuilt/recycled
  /// card cannot silently lose it (which would re-open the double-write
  /// window this exists to close).
  ///
  /// Per-INSTANCE is not enough on its own (review 2026-09-16): the chat
  /// history is stored as JSON and re-parsed on app start, which builds a NEW
  /// ActionProposal — a fresh key for the same card, i.e. the same double-write
  /// window with a longer fuse. Hence [commandIdSeed]: `toJson` pins the key
  /// and `fromJson` restores it, so a card is keyed once for its whole life
  /// (including across restarts).
  String get commandId => commandIdSeed ?? (_commandIds[this] ??= _newUuidV4());
}

/// Per-instance idempotency keys — lifetime == the proposal object's lifetime.
final Expando<String> _commandIds = Expando<String>('commandId');

/// UUID v4 (random). Pure Dart (Random.secure), no extra dependency.
String _newUuidV4() {
  final rng = Random.secure();
  final b = List<int>.generate(16, (_) => rng.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}
