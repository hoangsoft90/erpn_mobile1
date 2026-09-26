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

/// A1 (plan3 Trụ A) — the STRUCTURED UI intent the server attaches to a READ
/// answer: which drill-down screen this answer may open and for which entity.
///
/// It is built server-side from the capability contract (`ui_screens`), so the
/// client never classifies the question itself: it either has an intent or it
/// shows no button. Both [screen] and [entityId] are required — a screen is
/// opened BY entity id, and without one there is nothing to open.
@immutable
class ReadUiIntent {
  const ReadUiIntent({
    required this.screen,
    required this.title,
    required this.entityId,
    this.entityName,
    this.entityKind = 'customer',
    this.limit = 5,
  });

  /// Null when the payload carries no usable intent (missing screen/entity id):
  /// the caller then shows no drill-down at all rather than guessing one.
  static ReadUiIntent? tryParse(Object? raw) {
    if (raw is! Map<String, dynamic>) return null;
    final screen = raw['screen'];
    if (screen is! String || screen.trim().isEmpty) return null;
    final entity = raw['entity'];
    if (entity is! Map<String, dynamic>) return null;
    final id = entity['id'];
    if (id is! String || id.trim().isEmpty) return null;
    return ReadUiIntent(
      screen: screen.trim(),
      title: (raw['title'] as String?)?.trim() ?? '',
      entityId: id.trim(),
      entityName: entity['name'] as String?,
      entityKind: (entity['kind'] as String?) ?? 'customer',
      limit: (raw['limit'] as num?)?.toInt() ?? 5,
    );
  }

  final String screen;

  /// Screen title, server-owned copy.
  final String title;

  /// The ERPNext id this screen reads. It is a hint the client echoes back —
  /// the server re-validates it against a fresh read and refuses an id it does
  /// not find (`/read/list`).
  final String entityId;
  final String? entityName;
  final String entityKind;
  final int limit;

  Map<String, dynamic> toJson() => {
        'screen': screen,
        'title': title,
        'entity': {'kind': entityKind, 'id': entityId, 'name': entityName},
        'limit': limit,
      };
}

/// M1 — the structured CREATE-CUSTOMER offer the server attaches when a WRITE
/// about a customer could not settle one (`offer_create_customer`), plus the one
/// the explicit "thêm khách …" command carries alongside its proposal.
///
/// Why this is a separate object rather than a proposal: on the NO_MATCH path
/// there IS no proposal (the server refused with MISSING_ENTITY) — the offer is
/// what turns that dead end into a form. The suggested [name] is a HINT parsed
/// from the sentence, not authority: the user edits it before anything is
/// written, and the server re-checks the business key on the real create.
@immutable
class CustomerCreateOffer {
  const CustomerCreateOffer({required this.name, this.mobileNo, this.taxId});

  /// Null when the payload carries no usable name — without one there is
  /// nothing to prefill and no form to open (fail closed, no half-built offer).
  static CustomerCreateOffer? tryParse(Object? raw) {
    if (raw is! Map<String, dynamic>) return null;
    final name = raw['name'];
    if (name is! String || name.trim().isEmpty) return null;
    return CustomerCreateOffer(
      name: name.trim(),
      mobileNo: (raw['mobile_no'] as String?)?.trim(),
      taxId: (raw['tax_id'] as String?)?.trim(),
    );
  }

  final String name;
  final String? mobileNo;
  final String? taxId;

  Map<String, dynamic> toJson() => {
        'name': name,
        if (mobileNo != null && mobileNo!.isNotEmpty) 'mobile_no': mobileNo,
        if (taxId != null && taxId!.isNotEmpty) 'tax_id': taxId,
      };
}

/// A1 — one row of a drill-down list (a document that still owes money).
@immutable
class ReadDocumentRow {
  const ReadDocumentRow({
    required this.name,
    required this.outstandingVnd,
    this.date,
    this.totalVnd = 0,
    this.isReturn = false,
  });

  final String name;
  final String? date;
  final int outstandingVnd;
  final int totalVnd;
  final bool isReturn;
}

/// A1 — the payload of `POST /read/list`: a fresh, BOUNDED view of one screen.
///
/// [totalDocuments] vs `rows.length` is deliberate: the server caps the list
/// (5–10, contract-declared) and says how many exist, so the UI can never
/// pretend a truncated list is the whole debt.
@immutable
class ReadScreenData {
  const ReadScreenData({
    required this.screen,
    required this.title,
    required this.entityId,
    this.entityName,
    this.limit = 5,
    this.outstandingVnd = 0,
    this.openDocuments = 0,
    this.totalDocuments = 0,
    this.truncated = false,
    this.rows = const <ReadDocumentRow>[],
    this.erpTarget,
    this.generatedAt,
  });

  factory ReadScreenData.fromJson(Map<String, dynamic> json) {
    final entity = json['entity'];
    final summary = json['summary'];
    final rawRows = json['rows'];
    return ReadScreenData(
      screen: json['screen'] as String? ?? '',
      title: json['title'] as String? ?? '',
      entityId: entity is Map<String, dynamic>
          ? (entity['id'] as String? ?? '')
          : '',
      entityName:
          entity is Map<String, dynamic> ? entity['name'] as String? : null,
      limit: (json['limit'] as num?)?.toInt() ?? 5,
      outstandingVnd: summary is Map<String, dynamic>
          ? ((summary['outstanding_vnd'] as num?)?.toInt() ?? 0)
          : 0,
      openDocuments: summary is Map<String, dynamic>
          ? ((summary['open_documents'] as num?)?.toInt() ?? 0)
          : 0,
      totalDocuments: (json['total_documents'] as num?)?.toInt() ?? 0,
      truncated: json['truncated'] == true,
      // `REAL` / `MOCK` / null from the server. Only `REAL` may be rendered
      // (§2.1): a missing value means the source is unknown, not assumed real.
      erpTarget: json['erp_target'] as String?,
      // Tolerant parse (the result40 lesson: one bad element must not wipe the
      // whole screen — and definitely not crash the app).
      rows: rawRows is List
          ? rawRows
              .whereType<Map<String, dynamic>>()
              .map(
                (r) => ReadDocumentRow(
                  name: r['name'] as String? ?? '',
                  date: r['date'] as String?,
                  outstandingVnd: (r['outstanding_vnd'] as num?)?.toInt() ?? 0,
                  totalVnd: (r['total_vnd'] as num?)?.toInt() ?? 0,
                  isReturn: r['is_return'] == true,
                ),
              )
              .where((r) => r.name.isNotEmpty)
              .toList(growable: false)
          : const <ReadDocumentRow>[],
      generatedAt: json['generated_at'] as String?,
    );
  }

  final String screen;
  final String title;
  final String entityId;
  final String? entityName;
  final int limit;

  /// The customer's whole receivable — the SAME number the chat answer showed
  /// (the server copies it from the balance skill; nothing is recomputed).
  final int outstandingVnd;
  final int openDocuments;
  final int totalDocuments;
  final bool truncated;
  final List<ReadDocumentRow> rows;

  /// `REAL` / `MOCK` / null — must be [realProvenance] before the figures above
  /// may be shown.
  final String? erpTarget;
  final String? generatedAt;
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
    this.readUi,
    this.customerCreateOffer,
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
      // A1: the server decides whether a drill-down exists; an unusable block
      // parses to null (no button) instead of a half-built screen.
      readUi: ReadUiIntent.tryParse(json['ui']),
      // M1: same rule — an offer without a usable name is no offer at all.
      customerCreateOffer: CustomerCreateOffer.tryParse(json['offer_create_customer']),
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

  /// A1 — the drill-down this answer offers, or null when it offers none.
  final ReadUiIntent? readUi;

  /// M1 — the create-customer offer, or null when this answer offers none.
  final CustomerCreateOffer? customerCreateOffer;

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
    this.aiFallbackOffered = false,
    this.readUi,
    this.customerCreateOffer,
  });

  /// [typedQuestion] is what the user actually typed — preferred over the
  /// server's echoed `question`, so the bubble always matches the input.
  /// [aiFallbackOffered] is CLIENT policy, not a server field: the caller has
  /// already decided (by reading the setting at answer time) whether an
  /// unrouted answer gets its "ask the AI" button. See the field's doc.
  factory ChatTurn.fromAskResult(
    AskResult r, {
    String? typedQuestion,
    bool aiFallbackOffered = false,
  }) =>
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
        aiFallbackOffered: aiFallbackOffered,
        // A1: the drill-down is part of the answer, so it survives a restart
        // with it — the user can still open the customer's documents later.
        readUi: r.readUi,
        // M1: same rule — an offer the user has not acted on yet must still be
        // there after a restart, or the only way to create the customer is to
        // re-say the sentence.
        customerCreateOffer: r.customerCreateOffer,
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
        aiFallbackOffered: json['ai_fallback_offered'] as bool? ?? false,
        readUi: ReadUiIntent.tryParse(json['read_ui']),
        customerCreateOffer:
            CustomerCreateOffer.tryParse(json['customer_create_offer']),
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

  /// Whether THIS message shows the "ask the AI" button
  /// (`.plan/next2/auto-fallback-dsh.md` §3): true only for an answer whose
  /// deterministic route found nothing, and only when the auto-fallback setting
  /// was OFF at the moment that answer arrived.
  ///
  /// It is frozen onto the turn on purpose — exactly the F7-2 rule. Flipping
  /// the switch later must not rewrite what a message already on screen does;
  /// the new setting governs the NEXT question. When the setting was ON the
  /// question was already carried to the AI path, so offering a button as well
  /// would describe a decision the app has taken.
  final bool aiFallbackOffered;

  /// A1 — the drill-down the SERVER offered on this answer (null = no button).
  ///
  /// Frozen onto the turn like [aiFallbackOffered]: the intent describes what
  /// this answer can open, so a later answer entering the chat must not add or
  /// remove a button on an older message.
  final ReadUiIntent? readUi;

  /// M1 — the create-customer offer this answer carried, if any.
  ///
  /// Only rendered when there is NO proposal on the turn (the offer exists to
  /// replace a missing card). It travels with the turn for the same reason
  /// [readUi] does: the affordance describes THIS answer.
  final CustomerCreateOffer? customerCreateOffer;

  /// True when this turn is waiting for the user to pick a customer: the server
  /// refused to guess and offered candidates instead (no proposal exists yet).
  bool get awaitingEntityPick => candidates.isNotEmpty && proposal == null;

  /// True when this turn offers to CREATE a customer the write could not find.
  /// Same shape as [awaitingEntityPick]: the turn is waiting on the user, and
  /// there is nothing to confirm until they act.
  bool get awaitingCustomerCreate =>
      customerCreateOffer != null && proposal == null;

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
    // M1: an unanswered create-customer offer is a pending WRITE intent exactly
    // like a card is — the user has been invited to create a real record. It is
    // an "awaiting the user" turn, so the trimmer must keep it for the same
    // reason it keeps a card (losing it would silently drop the only way to
    // create the customer without re-saying the sentence).
    if (awaitingCustomerCreate) return true;
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
        // Only written when true: every turn stored before this feature (and
        // every ordinary one) keeps its exact old JSON shape.
        if (aiFallbackOffered) 'ai_fallback_offered': true,
        // Only written when present: every turn stored before A1 (and every
        // read without a declared screen) keeps its exact old JSON shape.
        if (readUi != null) 'read_ui': readUi!.toJson(),
        // Same additive rule for M1: a turn without an offer writes the exact
        // old JSON shape, so old histories load unchanged.
        if (customerCreateOffer != null)
          'customer_create_offer': customerCreateOffer!.toJson(),
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

  /// The actions this client may confirm. MUST mirror the server's
  /// `executableWriteActions()` (the capability contract in mcp-erpnext): a HIGH
  /// card the server cannot execute must never be confirmable, and an executable
  /// write the client refuses to confirm would strand the shop with a card they
  /// can see but cannot act on. Pinned from BOTH sides —
  /// test/b2-sales-order.test.mjs parses this set and compares it with the
  /// contract, so the two cannot drift silently (B2 added create_sales_order,
  /// B3 added create_quotation — the same tripwire caught that omission: without
  /// an entry here the quotation card rendered with NO confirm button at all;
  /// B4's create_purchase_order is the same trap a third time).
  static const Set<String> _confirmableActions = {
    'create_payment_entry',
    'create_sales_order',
    'create_quotation',
    'create_purchase_order',
    // P9-A2: the draft Delivery Note. A test compares this set with the
    // server's executableWriteActions(), so this line and the contract's
    // executor registry cannot drift apart silently.
    'create_delivery_note',
    // P9-B: the draft Purchase Receipt (the delivery's supplier-party mirror).
    'create_purchase_receipt',
    // P9-D: the draft Sales Invoice. Same tripwire as the two lines above — a
    // test compares this set with the server's executableWriteActions(), so a
    // new WRITE cannot arrive with the button missing (or with a button the
    // server would refuse).
    'create_sales_invoice',
    // P9-E: the draft Stock Entry (Material Issue — xuất hủy hàng hỏng). The
    // ONLY write whose correctness depends on TWO spoken slots (quantity AND
    // warehouse), so the server raises `need_double_confirm` for it and the card
    // states that condition above the button. Same tripwire: this line and the
    // contract's executor registry cannot drift apart silently.
    'create_stock_adjustment',
    // P9-F: the draft Sales Return (is_return=1 — khách trả hàng). The ONLY
    // write whose quantity goes onto the wire NEGATIVE (the card shows the
    // positive number the user said) and whose stock direction is IN. Same
    // tripwire: this set and the server's executableWriteActions() are compared
    // by a test, so neither side can drift silently.
    'create_sales_return',
    // M1: the customer CREATE (master data — the write whose entity does not
    // exist until it is written). The offer card carries a name + optional
    // contact slots; confirming posts the SAME /execute door with the
    // proposal's command id. Same tripwire as above.
    'create_customer',
  };

  /// The confirm button shows ONLY for the HIGH-risk write actions above —
  /// Phase 7 had exactly one (payment), B2 added the draft Sales Order, B3 the
  /// draft Quotation, B4 the draft Purchase Order. READ cards never get it;
  /// CRITICAL would demand double-confirm UI anyway.
  bool get confirmable =>
      _confirmableActions.contains(action) && risk == 'HIGH' && entityId != null;

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
  String get commandId => commandIdSeed ?? (_commandIds[this] ??= newUuidV4());
}

/// Per-instance idempotency keys — lifetime == the proposal object's lifetime.
final Expando<String> _commandIds = Expando<String>('commandId');

/// UUID v4 (random). Pure Dart (Random.secure), no extra dependency.
///
/// Exported so a widget that must build its OWN idempotency key (M1's
/// create-customer offer, which has no server proposal until it asks for one)
/// uses the SAME generator as a proposal's command id — the server validates the
/// shape (idempotency.isValidCommandId), so a second home-made format would be
/// refused as an invalid command id.
String newUuidV4() {
  final rng = Random.secure();
  final b = List<int>.generate(16, (_) => rng.nextInt(256));
  b[6] = (b[6] & 0x0f) | 0x40; // version 4
  b[8] = (b[8] & 0x3f) | 0x80; // variant 10
  final h = b.map((x) => x.toRadixString(16).padLeft(2, '0')).join();
  return '${h.substring(0, 8)}-${h.substring(8, 12)}-${h.substring(12, 16)}-${h.substring(16, 20)}-${h.substring(20)}';
}
