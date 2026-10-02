import 'package:flutter/foundation.dart';

/// P4-3 — the payload of `GET|POST /read/daily-summary` (plan4_final §4.3).
///
/// Three shape rules this parser defends, because the screen inherits them:
///
///  * **A block is REAL or NULL — never 0-instead-of-unknown.** A failing ERP
///    branch arrives as `null` plus an entry in `meta.errors`, so a "0đ" on
///    screen can only ever be a zero ERPNext actually measured (§4.3, §6).
///  * **Every block parses INDEPENDENTLY.** One malformed block must not wipe
///    the rest of the day, and must never crash the drawer — the same tolerant
///    parse the A1 list uses (result40 lesson).
///  * **Nothing is computed here.** Amounts are copied exactly as the server
///    sent them; the client never sums, converts or rounds money, so this screen
///    and the chat answer cannot disagree.
@immutable
class DailySummary {
  const DailySummary({
    required this.meta,
    this.salesOrders,
    this.salesInvoices,
    this.receipts,
    this.paymentsOut,
    this.receivables,
    this.appDrafts,
    this.cashDrawer,
    this.rawJson = '',
  });

  factory DailySummary.fromJson(
    Map<String, dynamic> json, {
    String rawJson = '',
  }) {
    final meta = json['meta'];
    return DailySummary(
      meta: DailySummaryMeta.fromJson(
        meta is Map<String, dynamic> ? meta : const {},
      ),
      salesOrders: _block(json['sales_orders'], SalesOrdersBlock.fromJson),
      salesInvoices:
          _block(json['sales_invoices'], SalesInvoicesBlock.fromJson),
      receipts: _block(json['receipts'], ReceiptsBlock.fromJson),
      paymentsOut: _block(json['payments_out'], PaymentsOutBlock.fromJson),
      receivables: _block(json['receivables'], ReceivablesBlock.fromJson),
      appDrafts: _block(json['app_drafts'], AppDraftsBlock.fromJson),
      cashDrawer: _block(json['cash_drawer'], CashDrawerBlock.fromJson),
      rawJson: rawJson,
    );
  }

  final DailySummaryMeta meta;

  /// `null` = the server could not read this block (see [meta.errors]) — the UI
  /// shows the error for exactly that block. Never substitute a 0 here.
  final SalesOrdersBlock? salesOrders;
  final SalesInvoicesBlock? salesInvoices;
  final ReceiptsBlock? receipts;
  final PaymentsOutBlock? paymentsOut;
  final ReceivablesBlock? receivables;
  final AppDraftsBlock? appDrafts;

  /// `null` too when the company has no `default_cash_account` configured — the
  /// block is hidden then (§3.6/§10.3), which is NOT an error.
  final CashDrawerBlock? cashDrawer;

  /// The bytes this object was parsed from, verbatim. The cache replays these
  /// instead of re-serialising a parsed copy that could drift from the parser.
  final String rawJson;
}

/// §4.3 `meta` — when the day was read, from where, and what failed.
@immutable
class DailySummaryMeta {
  const DailySummaryMeta({
    this.date,
    this.timezone = 'Asia/Ho_Chi_Minh',
    this.generatedAt,
    this.source,
    this.erpTarget,
    this.company,
    this.partial = false,
    this.errors = const <SummaryBlockError>[],
  });

  factory DailySummaryMeta.fromJson(Map<String, dynamic> json) {
    final rawErrors = json['errors'];
    return DailySummaryMeta(
      date: json['date'] as String?,
      timezone: (json['timezone'] as String?) ?? 'Asia/Ho_Chi_Minh',
      generatedAt: DateTime.tryParse((json['generated_at'] as String?) ?? ''),
      source: json['source'] as String?,
      // `REAL` | `MOCK` from the server (copilot-server.mjs#erpTargetLabel).
      // Null when the server did not say — the footer then says so instead of
      // printing an invented "REAL".
      erpTarget: json['erp_target'] as String?,
      company: json['company'] as String?,
      partial: json['partial'] == true,
      errors: rawErrors is List
          ? rawErrors
              .whereType<Map<String, dynamic>>()
              .map(SummaryBlockError.fromJson)
              .toList(growable: false)
          : const <SummaryBlockError>[],
    );
  }

  final String? date;
  final String timezone;

  /// When the server assembled these numbers (ISO-8601). Shown as the stamp.
  final DateTime? generatedAt;
  final String? source;
  final String? erpTarget;
  final String? company;

  /// True when at least one block failed — the screen shows per-block errors.
  final bool partial;
  final List<SummaryBlockError> errors;

  /// The refusal recorded for one block (`receipts`, `app_drafts`, …), if any.
  SummaryBlockError? errorFor(String block) {
    for (final e in errors) {
      if (e.block == block) return e;
    }
    return null;
  }
}

/// One failed block: `{block, code, detail?}` (§4.3).
@immutable
class SummaryBlockError {
  const SummaryBlockError({required this.block, required this.code, this.detail});

  factory SummaryBlockError.fromJson(Map<String, dynamic> json) =>
      SummaryBlockError(
        block: json['block'] as String? ?? '',
        code: json['code'] as String? ?? 'ERP_UNAVAILABLE',
        detail: json['detail'] as String?,
      );

  final String block;
  final String code;
  final String? detail;
}

/// A `{count, amount}` pair (§10.1: submitted and draft are separate pairs).
@immutable
class CountAmount {
  const CountAmount({this.count = 0, this.amount = 0});

  factory CountAmount.fromJson(Map<String, dynamic>? json) => CountAmount(
        count: _int(json?['count']),
        amount: _int(json?['amount']),
      );

  final int count;
  final int amount;
}

/// Sales orders for the day — submitted and draft kept APART (§10.1).
@immutable
class SalesOrdersBlock {
  const SalesOrdersBlock({this.submitted = const CountAmount(), this.draft = const CountAmount()});

  factory SalesOrdersBlock.fromJson(Map<String, dynamic> json) =>
      SalesOrdersBlock(
        submitted: CountAmount.fromJson(
          json['submitted'] is Map<String, dynamic>
              ? json['submitted'] as Map<String, dynamic>
              : null,
        ),
        draft: CountAmount.fromJson(
          json['draft'] is Map<String, dynamic>
              ? json['draft'] as Map<String, dynamic>
              : null,
        ),
      );

  final CountAmount submitted;

  /// Drafts are shown, never merged into [submitted] (§3.3).
  final CountAmount draft;
}

/// Sales invoices for the day — `grand_total`, i.e. AFTER VAT (§10.5).
@immutable
class SalesInvoicesBlock {
  const SalesInvoicesBlock({
    this.count = 0,
    this.amount = 0,
    this.includesDraft = false,
  });

  factory SalesInvoicesBlock.fromJson(Map<String, dynamic> json) =>
      SalesInvoicesBlock(
        count: _int(json['count']),
        amount: _int(json['amount']),
        includesDraft: json['includes_draft'] == true,
      );

  final int count;
  final int amount;
  final bool includesDraft;
}

/// Money received today (§3.2): split by money account and by how it was
/// allocated. [total] is the server's own sum — the client never adds up.
@immutable
class ReceiptsBlock {
  const ReceiptsBlock({
    this.againstInvoice = 0,
    this.advances = 0,
    this.cash = 0,
    this.bank = 0,
    this.unclassified = 0,
    this.total = 0,
  });

  factory ReceiptsBlock.fromJson(Map<String, dynamic> json) => ReceiptsBlock(
        againstInvoice: _int(json['against_invoice']),
        advances: _int(json['advances']),
        cash: _int(json['cash']),
        bank: _int(json['bank']),
        unclassified: _int(json['unclassified']),
        total: _int(json['total']),
      );

  final int againstInvoice;

  /// Received without allocating an invoice (deposit / prepayment).
  final int advances;
  final int cash;
  final int bank;

  /// Received but the money account has no `account_type` — never guessed into
  /// cash or bank, and shown as its own line so the split still adds up.
  final int unclassified;
  final int total;
}

/// Money paid out today. V1 is Payment Entry `Pay` only (§10.2).
@immutable
class PaymentsOutBlock {
  const PaymentsOutBlock({
    this.cash = 0,
    this.bank = 0,
    this.unclassified = 0,
    this.total = 0,
    this.footnote,
  });

  factory PaymentsOutBlock.fromJson(Map<String, dynamic> json) =>
      PaymentsOutBlock(
        cash: _int(json['cash']),
        bank: _int(json['bank']),
        unclassified: _int(json['unclassified']),
        total: _int(json['total']),
        footnote: json['footnote'] as String?,
      );

  final int cash;
  final int bank;
  final int unclassified;
  final int total;

  /// The fixed "Chưa gồm chi qua Journal Entry" line, server-owned copy.
  final String? footnote;
}

/// Debt RIGHT NOW — not an as-of figure for the selected day (§3.4).
@immutable
class ReceivablesBlock {
  const ReceivablesBlock({
    this.outstandingTotal = 0,
    this.overdueTotal = 0,
    this.overdueCount = 0,
  });

  factory ReceivablesBlock.fromJson(Map<String, dynamic> json) =>
      ReceivablesBlock(
        outstandingTotal: _int(json['outstanding_total']),
        overdueTotal: _int(json['overdue_total']),
        overdueCount: _int(json['overdue_count']),
      );

  final int outstandingTotal;
  final int overdueTotal;
  final int overdueCount;
}

/// Draft documents the copilot itself created today (§4.4).
@immutable
class AppDraftsBlock {
  const AppDraftsBlock({this.count = 0, this.byType = const <String, int>{}});

  factory AppDraftsBlock.fromJson(Map<String, dynamic> json) {
    final raw = json['by_type'];
    final byType = <String, int>{};
    if (raw is Map) {
      for (final entry in raw.entries) {
        byType['${entry.key}'] = _int(entry.value);
      }
    }
    return AppDraftsBlock(count: _int(json['count']), byType: byType);
  }

  final int count;
  final Map<String, int> byType;
}

/// Expected cash drawer (§3.6) — opening from the GL, flows from THIS response.
@immutable
class CashDrawerBlock {
  const CashDrawerBlock({
    this.opening = 0,
    this.cashInToday = 0,
    this.cashOutToday = 0,
    this.expectedClosing = 0,
    this.account,
  });

  factory CashDrawerBlock.fromJson(Map<String, dynamic> json) =>
      CashDrawerBlock(
        opening: _int(json['opening']),
        cashInToday: _int(json['cash_in_today']),
        cashOutToday: _int(json['cash_out_today']),
        expectedClosing: _int(json['expected_closing']),
        account: json['account'] as String?,
      );

  final int opening;
  final int cashInToday;
  final int cashOutToday;

  /// `opening + cashIn − cashOut`, computed by the SERVER — the client only
  /// prints it, so this figure can never drift from the two it is made of.
  final int expectedClosing;
  final String? account;
}

/// A block map, or null when the server sent a non-object (`null`, a string,
/// an error shape) — "unreadable" and "empty" must not collapse into each other.
///
/// An EMPTY object counts as unreadable too. Every real block carries at least
/// its identifying numbers, so `{}` is a malformed payload — and parsing it into
/// an all-zero block would print "Tổng thu 0đ", a money claim the server never
/// made. Unknown must stay visibly unknown (§4.3).
T? _block<T>(Object? raw, T Function(Map<String, dynamic>) parse) {
  if (raw is! Map<String, dynamic> || raw.isEmpty) return null;
  try {
    return parse(raw);
  } catch (_) {
    return null; // one bad block must not take the screen down
  }
}

int _int(Object? value) {
  if (value is num) return value.toInt();
  if (value is String) return int.tryParse(value) ?? 0;
  return 0;
}
