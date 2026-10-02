import 'package:flutter/foundation.dart';

import '../../collect/data/collect_models.dart';

/// next8 Phase 7 — data contracts for the PURCHASE (nhập hàng) flow: NCC +
/// kho + dòng hàng (giá MUA) + (tuỳ chọn) trả NCC. The twin of the sales
/// feature's contracts, with the money direction flipped to PAY.
///
/// Same rules as the sales contracts:
///  - every parser is TOLERANT (absent fields parse to null/empty, never throw);
///  - NO class here computes money: the totals live in [PurchaseSummary], which
///    is the SERVER's own arithmetic from `/purchase/propose` (spec
///    `purchase-screen`: "owns no money authority").
///
/// plan §14 has NO discount for a purchase, so a line carries no discount field
/// at all — the payable is `purchase_total − actual_paid` (a BALANCE, not a
/// payment mode).

/// One goods line the owner typed. `qty` stays nullable while the field is
/// empty (the confirm gate refuses an incomplete line; the server re-validates
/// every value against a fresh ERPNext read — above all the BUYING price).
@immutable
class PurchaseLineValue {
  const PurchaseLineValue({this.itemCode = '', this.uom = '', this.qty});

  final String itemCode;
  final String uom;
  final int? qty;

  /// A line the form may submit: everything named, quantity a positive number.
  bool get complete => itemCode.trim().isNotEmpty && uom.trim().isNotEmpty && (qty ?? 0) > 0;

  PurchaseLineValue copyWith({String? itemCode, String? uom, int? qty}) => PurchaseLineValue(
        itemCode: itemCode ?? this.itemCode,
        uom: uom ?? this.uom,
        qty: qty ?? this.qty,
      );

  Map<String, dynamic> toJson() => {
        'item_id': itemCode.trim(),
        'uom': uom.trim(),
        'qty': qty ?? 0,
      };
}

/// The body the confirm step sends to `POST /purchase/propose`: the ticket id
/// plus what the owner filled in. Every value is a REQUEST — the server
/// re-reads ERPNext (supplier, uom, BUYING price, accounts) before it computes
/// anything (spec `purchase-draft`).
@immutable
class PurchaseProposalRequest {
  const PurchaseProposalRequest({
    required this.handoffId,
    required this.supplierId,
    required this.items,
    this.conversationId,
    this.warehouse,
    this.methods = const <CollectMethodValue>[],
  });

  final String handoffId;
  final String supplierId;
  final List<PurchaseLineValue> items;

  /// Omitted ⇒ the server uses its configured default warehouse and SAYS so.
  final String? warehouse;

  /// §6.1: the screen sends at most ONE method — cash OR bank transfer; empty
  /// means a pure credit purchase (the remainder is a BALANCE on the result).
  final List<CollectMethodValue> methods;

  final String? conversationId;

  Map<String, dynamic> toJson() => {
        'handoff_id': handoffId,
        if (conversationId != null && conversationId!.isNotEmpty) 'conversation_id': conversationId,
        'values': {
          'supplier_id': supplierId,
          if (warehouse != null && warehouse!.trim().isNotEmpty) 'warehouse': warehouse!.trim(),
          'items': [for (final l in items) l.toJson()],
          'payment_methods': [for (final m in methods) m.toJson()],
        },
      };
}

/// The SERVER's arithmetic from `/purchase/propose` (fields mirror the route's
/// `summary`). All tolerant: absent ⇒ 0, never a thrown parse.
@immutable
class PurchaseSummary {
  const PurchaseSummary({
    this.subtotalVnd = 0,
    this.totalVnd = 0,
    this.paidVnd = 0,
    this.outstandingAfterVnd = 0,
  });

  factory PurchaseSummary.fromJson(Map<String, dynamic> json) => PurchaseSummary(
        subtotalVnd: (json['subtotal_vnd'] as num?)?.toInt() ?? 0,
        totalVnd: (json['total_vnd'] as num?)?.toInt() ?? 0,
        paidVnd: (json['payment_total_vnd'] as num?)?.toInt() ?? (json['paid_vnd'] as num?)?.toInt() ?? 0,
        outstandingAfterVnd: (json['outstanding_after_vnd'] as num?)?.toInt() ?? 0,
      );

  final int subtotalVnd;
  final int totalVnd;

  /// What the draft pays the supplier right now (0 = pure credit purchase).
  final int paidVnd;

  /// `credit = purchase_total − paid` — the SERVER's balance, rendered as-is.
  final int outstandingAfterVnd;
}

/// The server's answer to `/purchase/propose` — the ordinary `erpn.proposal/v1`
/// plus the server's own summary. On refusal `code`/`reason` carry the machine
/// code and Vietnamese copy the screen shows verbatim.
@immutable
class PurchaseProposeResult {
  const PurchaseProposeResult({
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

  factory PurchaseProposeResult.fromJson(Map<String, dynamic> body) {
    final proposal = body['proposal'];
    return PurchaseProposeResult(
      ok: body['ok'] is bool && body['ok'] as bool,
      capability: body['capability'] as String?,
      handoffId: body['handoff_id'] as String?,
      proposal: proposal is Map<String, dynamic> ? proposal : null,
      summary: body['summary'] is Map<String, dynamic>
          ? PurchaseSummary.fromJson(body['summary'] as Map<String, dynamic>)
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
  final Map<String, dynamic>? proposal;
  final PurchaseSummary? summary;
  final List<String> warnings;
  final String? priceList;
  final String? code;
  final String? reason;
}
