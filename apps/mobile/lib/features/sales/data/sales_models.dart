import 'package:flutter/foundation.dart';

import '../../collect/data/collect_models.dart';

/// next8 Phase 6 — data contracts for the SALES (bán hàng) flow, the twin of
/// the collect feature's contracts. Same rules apply:
///  - every parser is TOLERANT (absent fields parse to null/empty, never
///    throw) so an older gateway cannot crash the screen;
///  - NO class here computes money: the totals live in [SalesSummary], which
///    is the SERVER's own arithmetic from `/sales/propose` — the screen renders
///    it and never recomputes it (spec `sales-screen`: "owns no money
///    authority"; tasks §4: "không parser tiền thứ hai trong Dart").
///
/// The two discount layers travel APART all the way to the server
/// (`items[].line_discount` vs `order_discount_vnd`) — folding them in Dart is
/// exactly falsify F1's mistake, mirrored client-side.

/// One goods line the seller typed. `qty` stays nullable while the field is
/// empty (the confirm gate refuses an incomplete line; the server re-validates
/// every value against a fresh ERPNext read anyway).
@immutable
class SalesLineValue {
  const SalesLineValue({
    this.itemCode = '',
    this.uom = '',
    this.qty,
    this.lineDiscount = 0,
  });

  final String itemCode;
  final String uom;
  final int? qty;
  final int lineDiscount;

  /// A line the form may submit: everything named, quantity a positive number.
  bool get complete =>
      itemCode.trim().isNotEmpty && uom.trim().isNotEmpty && (qty ?? 0) > 0;

  SalesLineValue copyWith({String? itemCode, String? uom, int? qty, int? lineDiscount}) =>
      SalesLineValue(
        itemCode: itemCode ?? this.itemCode,
        uom: uom ?? this.uom,
        qty: qty ?? this.qty,
        lineDiscount: lineDiscount ?? this.lineDiscount,
      );

  Map<String, dynamic> toJson() => {
        'item_id': itemCode.trim(),
        'uom': uom.trim(),
        'qty': qty ?? 0,
        'line_discount': lineDiscount,
      };
}

/// The body the confirm step sends to `POST /sales/propose`: the ticket id plus
/// what the seller filled in. Every value is a REQUEST — the server re-reads
/// ERPNext (customer, uom, price, accounts) before it computes anything, so
/// nothing here is authority (spec `sales-draft`).
@immutable
class SalesProposalRequest {
  const SalesProposalRequest({
    required this.handoffId,
    required this.customerId,
    required this.items,
    this.conversationId,
    this.warehouse,
    this.orderDiscountVnd = 0,
    this.methods = const <CollectMethodValue>[],
  });

  final String handoffId;
  final String customerId;
  final List<SalesLineValue> items;

  /// Omitted ⇒ the server uses its configured default warehouse and SAYS so.
  final String? warehouse;

  /// The ORDER-level discount (tầng 2) — kept apart from the lines' own
  /// `line_discount` (tầng 1).
  final int orderDiscountVnd;

  /// §6.1: the screen sends at most ONE method — cash OR bank transfer; empty
  /// means a pure credit sale (the remainder is a BALANCE on the result).
  final List<CollectMethodValue> methods;

  final String? conversationId;

  Map<String, dynamic> toJson() => {
        'handoff_id': handoffId,
        if (conversationId != null && conversationId!.isNotEmpty)
          'conversation_id': conversationId,
        'values': {
          'customer_id': customerId,
          if (warehouse != null && warehouse!.trim().isNotEmpty)
            'warehouse': warehouse!.trim(),
          'items': [for (final l in items) l.toJson()],
          'order_discount_vnd': orderDiscountVnd,
          'payment_methods': [for (final m in methods) m.toJson()],
        },
      };
}

/// The SERVER's arithmetic from `/sales/propose` (fields mirror the route's
/// `summary`). All tolerant: absent ⇒ 0, never a thrown parse.
@immutable
class SalesSummary {
  const SalesSummary({
    this.subtotalVnd = 0,
    this.lineDiscountVnd = 0,
    this.orderDiscountVnd = 0,
    this.totalVnd = 0,
    this.collectedVnd = 0,
    this.outstandingAfterVnd = 0,
  });

  factory SalesSummary.fromJson(Map<String, dynamic> json) => SalesSummary(
        subtotalVnd: (json['subtotal_vnd'] as num?)?.toInt() ?? 0,
        lineDiscountVnd: (json['line_discount_vnd'] as num?)?.toInt() ?? 0,
        orderDiscountVnd: (json['order_discount_vnd'] as num?)?.toInt() ?? 0,
        totalVnd: (json['total_vnd'] as num?)?.toInt() ?? 0,
        collectedVnd: (json['payment_total_vnd'] as num?)?.toInt() ??
            (json['collected_vnd'] as num?)?.toInt() ??
            0,
        outstandingAfterVnd: (json['outstanding_after_vnd'] as num?)?.toInt() ?? 0,
      );

  final int subtotalVnd;
  final int lineDiscountVnd;
  final int orderDiscountVnd;
  final int totalVnd;

  /// What the draft collects right now (0 = pure credit sale).
  final int collectedVnd;

  /// `credit = total − collected` — the SERVER's balance, rendered as-is.
  final int outstandingAfterVnd;
}

/// The server's answer to `/sales/propose` — the ordinary `erpn.proposal/v1`
/// (the SAME object the chat card renders) plus the server's own summary. On
/// refusal `code`/`reason` carry the machine code and Vietnamese copy the
/// screen shows verbatim.
@immutable
class SalesProposeResult {
  const SalesProposeResult({
    required this.ok,
    this.capability,
    this.handoffId,
    this.proposal,
    this.summary,
    this.warnings = const <String>[],
    this.priceList,
    this.code,
    this.reason,
  });

  factory SalesProposeResult.fromJson(Map<String, dynamic> body) {
    final proposal = body['proposal'];
    return SalesProposeResult(
      ok: body['ok'] is bool && body['ok'] as bool,
      capability: body['capability'] as String?,
      handoffId: body['handoff_id'] as String?,
      proposal: proposal is Map<String, dynamic> ? proposal : null,
      summary: body['summary'] is Map<String, dynamic>
          ? SalesSummary.fromJson(body['summary'] as Map<String, dynamic>)
          : null,
      warnings: body['warnings'] is List
          ? (body['warnings'] as List).whereType<String>().toList(growable: false)
          : const <String>[],
      priceList: body['price_list'] as String?,
      code: body['code'] as String?,
      reason: body['reason'] as String?,
    );
  }

  final bool ok;
  final String? capability;
  final String? handoffId;

  /// `erpn.proposal/v1` — rendered by the EXISTING ProposalCard; the confirm
  /// stays the one `/execute` door (no second write path on this screen).
  final Map<String, dynamic>? proposal;
  final SalesSummary? summary;
  final List<String> warnings;

  /// The price list the server resolved prices against (display only).
  final String? priceList;

  /// Machine refusal code (STALE_HANDOFF, SALES_PRICE_MISSING, …).
  final String? code;
  final String? reason;
}
