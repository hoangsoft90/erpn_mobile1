import 'package:flutter/foundation.dart';

/// next8 Phase 1 — data contracts for the collect (thu tiền) flow.
///
/// Everything here is a TOLERANT parser of what the server sends, in the same
/// style as `chat_models.dart`: absent fields parse to null/empty (never throw),
/// because an older gateway must not wipe the form. And one rule is absolute —
/// the handoff carries no authoritative number, so no class here even has an
/// amount field: the amounts come from `/collect/propose` (the server's own
/// summary) at confirm time, never from the ticket.
///
/// Owner locks this layer must not contradict:
///  - §6.5: `capability` parses as the CANONICAL id the server sent
///    (`payment.create`); the alias `payment.collect` is a server-side name and
///    never becomes a different flow here.
///  - §6.1/§6.3: `CollectProposeResult.summary` is the SERVER's arithmetic —
///    the screen renders it, it does not recompute money for submission.

/// Slot states a handoff carries (same vocabulary as the server's
/// `business-handoff.mjs` and the entity-resolution policy).
@immutable
class CollectSlotState {
  const CollectSlotState._(this.value);
  final String value;

  static const resolved = CollectSlotState._('RESOLVED');
  static const ambiguous = CollectSlotState._('AMBIGUOUS');
  static const missing = CollectSlotState._('MISSING');
  static const noMatch = CollectSlotState._('NO_MATCH');

  static CollectSlotState? tryParse(Object? raw) {
    if (raw is! String) return null;
    switch (raw) {
      case 'RESOLVED':
        return resolved;
      case 'AMBIGUOUS':
        return ambiguous;
      case 'MISSING':
        return missing;
      case 'NO_MATCH':
        return noMatch;
      default:
        return null;
    }
  }

  @override
  bool operator ==(Object other) => other is CollectSlotState && other.value == value;
  @override
  int get hashCode => value.hashCode;
  @override
  String toString() => value;
}

/// One prefill slot of the ticket: a state plus (optional) hints. `id`/`label`
/// are what the sentence already resolved; `candidates` are picker rows for an
/// AMBIGUOUS slot. No number field exists on purpose.
@immutable
class CollectPrefillSlot {
  const CollectPrefillSlot({
    required this.state,
    this.id,
    this.label,
    this.candidates = const <String>[],
  });

  factory CollectPrefillSlot.fromJson(Map<String, dynamic> json) {
    return CollectPrefillSlot(
      state: CollectSlotState.tryParse(json['state']) ?? CollectSlotState.missing,
      id: json['id'] as String?,
      label: json['label'] as String?,
      // Tolerant (the result40 lesson): a non-list is an empty list, never a throw.
      candidates: json['candidates'] is List
          ? (json['candidates'] as List).whereType<String>().toList(growable: false)
          : const <String>[],
    );
  }

  final CollectSlotState state;
  final String? id;
  final String? label;
  final List<String> candidates;

  bool get isResolved => state == CollectSlotState.resolved;
}

/// The `business_handoff` object an /ask answer may carry for a routed collect
/// sentence. The screen it names (`collect`) is what Phase 2 opens; Phase 1 only
/// parses and stores it.
@immutable
class BusinessHandoff {
  const BusinessHandoff({
    required this.handoffId,
    required this.capability,
    required this.screen,
    required this.question,
    required this.prefill,
    this.issuedAt,
  });

  /// Parses the `business_handoff` block, or null when the answer carries none
  /// (most answers do not) or a shape this client cannot use.
  static BusinessHandoff? tryParse(Object? raw) {
    if (raw is! Map<String, dynamic>) return null;
    final handoffId = raw['handoff_id'] as String?;
    if (handoffId == null || handoffId.isEmpty) {
      // No id ⇒ nothing the propose route could ever accept; treat as absent.
      return null;
    }
    final type = raw['type'] as String?;
    if (type != null && type != 'business_handoff') {
      return null;
    }
    final rawPrefill = raw['prefill'];
    final prefill = <String, CollectPrefillSlot>{};
    if (rawPrefill is Map<String, dynamic>) {
      rawPrefill.forEach((key, value) {
        if (value is Map<String, dynamic>) {
          prefill[key] = CollectPrefillSlot.fromJson(value);
        }
      });
    }
    return BusinessHandoff(
      handoffId: handoffId,
      // §6.5: whatever the server put here IS the capability to propose with.
      capability: raw['capability'] as String? ?? 'payment.create',
      screen: raw['screen'] as String? ?? 'collect',
      question: raw['question'] as String? ?? '',
      prefill: prefill,
      issuedAt: raw['issued_at'] as String?,
    );
  }

  final String handoffId;
  final String capability;
  final String screen;
  final String question;
  final Map<String, CollectPrefillSlot> prefill;
  final String? issuedAt;

  CollectPrefillSlot slot(String name) => prefill[name] ?? const CollectPrefillSlot(state: CollectSlotState.missing);

  @override
  bool operator ==(Object other) =>
      other is BusinessHandoff &&
      other.handoffId == handoffId &&
      other.capability == capability &&
      other.screen == screen;
  @override
  int get hashCode => Object.hash(handoffId, capability, screen);
}

/// The body the confirm step sends to `POST /collect/propose`: the ticket id plus
/// what the user has filled in. Values are REQUESTS — the server re-validates all
/// of them against a fresh ERPNext read (never trusted, same as `entity_id`).
@immutable
class CollectProposalRequest {
  const CollectProposalRequest({
    required this.handoffId,
    required this.customerId,
    required this.allocations,
    required this.methods,
    this.conversationId,
    this.claimedTotalVnd,
  });

  final String handoffId;
  final String customerId;

  /// Which invoice gets how much. With open invoices this MUST be non-empty
  /// (lock §6.3); with none it MUST be empty (on-account).
  final List<CollectAllocationValue> allocations;

  /// Lock §6.1: the screen sends at most ONE method — cash OR bank transfer.
  final List<CollectMethodValue> methods;

  final String? conversationId;

  /// Optional self-check total. The server only ever compares it against its own
  /// arithmetic; it can make a request FAIL, never change what is written.
  final int? claimedTotalVnd;

  Map<String, dynamic> toJson() => {
        'handoff_id': handoffId,
        if (conversationId != null && conversationId!.isNotEmpty)
          'conversation_id': conversationId,
        'values': {
          'customer_id': customerId,
          'allocations': [for (final a in allocations) a.toJson()],
          'payment_methods': [for (final m in methods) m.toJson()],
          if (claimedTotalVnd != null) 'claimed_total_vnd': claimedTotalVnd,
        },
      };
}

@immutable
class CollectAllocationValue {
  const CollectAllocationValue({required this.invoiceId, required this.allocatedAmount});

  final String invoiceId;
  final int allocatedAmount;

  Map<String, dynamic> toJson() => {'invoice_id': invoiceId, 'allocated_amount': allocatedAmount};
}

@immutable
class CollectMethodValue {
  const CollectMethodValue({required this.mode, required this.amount, this.accountId});

  static const cash = CollectMethodValue(mode: 'cash', amount: 0);
  static const bankTransfer = CollectMethodValue(mode: 'bank_transfer', amount: 0);

  final String mode;
  final int amount;
  final String? accountId;

  Map<String, dynamic> toJson() => {
        'mode': mode,
        'amount': amount,
        if (accountId != null && accountId!.isNotEmpty) 'account_id': accountId,
      };
}

/// The server's answer to `/collect/propose` — the ordinary proposal object plus
/// the server's own summary. On refusal, `code`/`reason` carry the machine code
/// and Vietnamese copy the screen shows verbatim.
@immutable
class CollectProposeResult {
  const CollectProposeResult({
    required this.ok,
    this.capability,
    this.handoffId,
    this.proposal,
    this.invoice,
    this.outstandingVnd,
    this.summary,
    this.warnings = const <String>[],
    this.code,
    this.reason,
  });

  factory CollectProposeResult.fromJson(Map<String, dynamic> body) {
    final ok = body['ok'];
    final proposal = body['proposal'];
    return CollectProposeResult(
      ok: ok is bool && ok,
      capability: body['capability'] as String?,
      handoffId: body['handoff_id'] as String?,
      // Display-only in Phase 1 (same rule as AskResult): the confirm flow that
      // posts to /execute arrives with Phase 2/4 wiring and needs no change here.
      proposal: proposal is Map<String, dynamic> ? proposal : null,
      invoice: body['invoice'] as String?,
      outstandingVnd: (body['outstanding_vnd'] as num?)?.toInt(),
      summary: body['summary'] is Map<String, dynamic>
          ? CollectSummary.fromJson(body['summary'] as Map<String, dynamic>)
          : null,
      warnings: body['warnings'] is List
          ? (body['warnings'] as List).whereType<String>().toList(growable: false)
          : const <String>[],
      code: body['code'] as String?,
      reason: body['reason'] as String?,
    );
  }

  final bool ok;

  /// Canonical capability id (§6.5): `payment.create`, never the alias.
  final String? capability;
  final String? handoffId;

  /// `erpn.proposal/v1` — the SAME object the chat card renders.
  final Map<String, dynamic>? proposal;
  final String? invoice;
  final int? outstandingVnd;
  final CollectSummary? summary;
  final List<String> warnings;

  /// Machine refusal code (STALE_HANDOFF, PAYMENT_METHOD_COUNT_INVALID, ...).
  final String? code;
  final String? reason;
}

/// The SERVER's arithmetic (the screen renders it; it never recomputes money).
@immutable
class CollectSummary {
  const CollectSummary({
    required this.paymentTotalVnd,
    required this.allocatedTotalVnd,
    required this.unallocatedVnd,
  });

  factory CollectSummary.fromJson(Map<String, dynamic> json) => CollectSummary(
        paymentTotalVnd: (json['payment_total_vnd'] as num?)?.toInt() ?? 0,
        allocatedTotalVnd: (json['allocated_total_vnd'] as num?)?.toInt() ?? 0,
        unallocatedVnd: (json['unallocated_vnd'] as num?)?.toInt() ?? 0,
      );

  final int paymentTotalVnd;
  final int allocatedTotalVnd;
  final int unallocatedVnd;
}

/// ─── READ-only payloads for the collect screen (Phase 2, owner order a+b) ───
///
/// These models PARSE server reads. They carry no amount the user may submit:
/// the only numbers here are the ERPNext outstanding figures the form prefills
/// from (the server re-validates every one at propose time), and account NAMES
/// the site itself declares. Nothing here can write.

/// One open invoice row of `/read/list` (`customer_account` screen).
@immutable
class CollectOpenInvoice {
  const CollectOpenInvoice({
    required this.id,
    required this.outstandingVnd,
    this.date,
    this.totalVnd,
    this.isReturn = false,
  });

  factory CollectOpenInvoice.fromJson(Map<String, dynamic> json) =>
      CollectOpenInvoice(
        id: json['name'] as String? ?? '',
        outstandingVnd: (json['outstanding_vnd'] as num?)?.toInt() ?? 0,
        date: json['date'] as String?,
        totalVnd: (json['total_vnd'] as num?)?.toInt(),
        isReturn: json['is_return'] as bool? ?? false,
      );

  final String id;
  final int outstandingVnd;
  final String? date;
  final int? totalVnd;
  final bool isReturn;
}

/// The `/read/list` payload for the collect screen's invoice block.
///
/// §6.4 honesty: [matchedTotal] is the count the skill MATCHED after the full
/// read (the truth), [rows] is the bounded page (≤ the contract limit). A page
/// that is "full" only means the page is full — "there may be more" is what
/// [truncated] plus [matchedTotal] are allowed to say, never "that was all".
@immutable
class CollectOpenInvoicesPage {
  const CollectOpenInvoicesPage({
    required this.customerId,
    required this.rows,
    required this.matchedTotal,
    required this.truncated,
    this.company,
    this.outstandingVnd = 0,
  });

  factory CollectOpenInvoicesPage.fromJson(Map<String, dynamic> json) {
    final rows = json['rows'];
    return CollectOpenInvoicesPage(
      customerId:
          (json['entity'] is Map<String, dynamic>
              ? (json['entity'] as Map<String, dynamic>)['id'] as String?
              : null) ??
          '',
      company: json['company'] as String?,
      outstandingVnd:
          (json['summary'] is Map<String, dynamic>
              ? (json['summary'] as Map<String, dynamic>)['outstanding_vnd'] as num?
              : null)?.toInt() ??
          0,
      rows: rows is List
          ? rows
              .whereType<Map<String, dynamic>>()
              .map(CollectOpenInvoice.fromJson)
              .where((r) => r.id.isNotEmpty)
              .toList(growable: false)
          : const <CollectOpenInvoice>[],
      // The server's matched count wins; an older gateway without the field
      // falls back to the page length (its read WAS the whole list — cap 100).
      matchedTotal:
          (json['summary'] is Map<String, dynamic>
                  ? (json['summary'] as Map<String, dynamic>)['matched_total'] as num?
                  : null)
              ?.toInt() ??
              (rows is List ? rows.length : 0),
      truncated: json['truncated'] as bool? ?? false,
    );
  }

  final String customerId;
  final String? company;
  final int outstandingVnd;
  final List<CollectOpenInvoice> rows;
  final int matchedTotal;
  final bool truncated;
}

/// One money account (Cash or Bank leaf) the site declares.
@immutable
class CollectMoneyAccount {
  const CollectMoneyAccount({
    required this.account,
    required this.label,
    required this.accountType,
    required this.company,
  });

  factory CollectMoneyAccount.fromJson(Map<String, dynamic> json) =>
      CollectMoneyAccount(
        account: json['account'] as String? ?? '',
        label: json['label'] as String? ?? json['account'] as String? ?? '',
        accountType: json['account_type'] as String? ?? '',
        company: json['company'] as String? ?? '',
      );

  final String account;
  final String label;
  /// The ERPNext type — `'Cash'` or `'Bank'`. The screen matches it against
  /// the chosen method's channel; it never guesses from the name.
  final String accountType;
  final String company;

  bool get isCash => accountType == 'Cash';
  bool get isBank => accountType == 'Bank';
}

/// The `/collect/accounts` payload: the company's typed money accounts plus its
/// own declared defaults (preselected ONLY when they genuinely belong to the
/// type — the server already checked that; the screen trusts the grouping).
@immutable
class CollectAccountsData {
  const CollectAccountsData({
    required this.company,
    required this.cash,
    required this.bank,
    required this.defaultCash,
    required this.defaultBank,
  });

  factory CollectAccountsData.fromJson(Map<String, dynamic> json) {
    List<CollectMoneyAccount> list(Object? raw) => raw is List
        ? raw
            .whereType<Map<String, dynamic>>()
            .map(CollectMoneyAccount.fromJson)
            .where((a) => a.account.isNotEmpty)
            .toList(growable: false)
        : const <CollectMoneyAccount>[];
    final defaults = json['defaults'] is Map<String, dynamic>
        ? json['defaults'] as Map<String, dynamic>
        : const <String, dynamic>{};
    return CollectAccountsData(
      company: json['company'] as String? ?? '',
      cash: list(json['cash']),
      bank: list(json['bank']),
      defaultCash: defaults['cash'] as String?,
      defaultBank: defaults['bank'] as String?,
    );
  }

  final String company;
  final List<CollectMoneyAccount> cash;
  final List<CollectMoneyAccount> bank;
  final String? defaultCash;
  final String? defaultBank;

  /// Accounts of the channel a method uses (`cash` → Cash, `bank_transfer` →
  /// Bank). An unknown mode yields an empty list — the picker shows nothing
  /// rather than the wrong type (§6.2 posture, UI half).
  List<CollectMoneyAccount> forMode(String mode) =>
      mode == 'cash' ? cash : (mode == 'bank_transfer' ? bank : const <CollectMoneyAccount>[]);

  /// The default account of a channel, or null when the company declared none.
  String? defaultFor(String mode) =>
      mode == 'cash' ? defaultCash : (mode == 'bank_transfer' ? defaultBank : null);

  /// Whether the channel has at least one account to offer. A method whose
  /// channel is unresolved is BLOCKED with its own copy — never silently
  /// rerouted to the other channel (§6.2).
  bool resolves(String mode) => forMode(mode).isNotEmpty;
}
