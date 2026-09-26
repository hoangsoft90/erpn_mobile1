import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../app/theme/app_theme.dart';
import '../../application/chat_controller.dart';
import '../../data/chat_models.dart';
import '../../../../app/providers.dart';

/// Phase 6 — Action Proposal summary card (display-only).
///
/// Renders the erpn.proposal/v1 object as a human-readable card: risk badge,
/// action summary, and the resolved entity. NO confirm button exists here on
/// purpose — Phase 6 stops at display; the confirm-execute flow arrives with
/// Phase 7 (first write). Colors come from the theme, never hardcoded hex.
class ProposalCard extends ConsumerStatefulWidget {
  const ProposalCard({super.key, required this.proposal});

  final ActionProposal proposal;

  @override
  ConsumerState<ProposalCard> createState() => _ProposalCardState();
}

class _ProposalCardState extends ConsumerState<ProposalCard>
    with AutomaticKeepAliveClientMixin {
  /// F2 (result41, user decision 2026-09-16 — option b): `ListView.builder`
  /// DISPOSES off-screen items, so scrolling a confirmed card away and back
  /// used to rebuild it clean: the "Đã ghi phiếu thu …" line vanished and the
  /// [Xác nhận] button came BACK on a card that had already been written
  /// (probe P2 measured success=1/button=0 → success=0/button=1; the money was
  /// still safe because the retry reuses the same command_id and the server
  /// replays).
  ///
  /// Kept alive only while this card actually OWNS local state: an in-flight
  /// confirm, a write result, an error, or a locally stamped refusal. Untouched
  /// cards still scroll away normally, so long histories do not pin every card
  /// in memory. (A rejection is ALSO persisted at model level — see
  /// attachRejection — so that one survives a full restart; a write result does
  /// not, by design of option (b): no schema change.)
  @override
  bool get wantKeepAlive =>
      _confirming ||
      _result != null ||
      _error != null ||
      _rejectionCode != null;

  bool _confirming = false;
  String? _result;
  // P5-3: what the RESULT was, for the badge beside it. `submit_ok` is
  // deliberately TRI-state — true (the receipt was submitted), false (a draft
  // whose submit was refused), absent (this action has no submit step, e.g. an
  // order/quotation draft). It is read from the server's own field, never
  // inferred from the wording of [_result].
  bool? _submitOk;
  /// P5-2's classification of a refused submit (`permission` | `period_locked`
  /// | `workflow` | `other`), when the server sent one. Drives [_submitHint].
  String? _submitErrorKind;
  String? _error;
  // Phase 9 (result33 review): local rejection — the card shows the banner
  // IMMEDIATELY on a 409, even when this widget instance is not (yet) backed
  // by the controller's turn list. attachRejection() additionally persists
  // the reason so it survives restarts (the model-level path).
  String? _rejectionCode;
  List<String> _rejectionProblems = const [];

  @override
  void didUpdateWidget(covariant ProposalCard oldWidget) {
    super.didUpdateWidget(oldWidget);
    // The proposal instance was swapped (history restore / turn rebuild):
    // drop the local stamp unless the new instance carries its own, so a
    // stale stamp can never leak onto a different card.
    if (!identical(widget.proposal, oldWidget.proposal) &&
        !widget.proposal.isRejected) {
      _rejectionCode = null;
      _rejectionProblems = const [];
    }
  }

  /// Short alias so build() and helpers read like the old StatelessWidget.
  ActionProposal get proposal => widget.proposal;

  Future<void> _confirm() async {
    final proposal = widget.proposal;
    if (_confirming || !proposal.confirmable) return;
    setState(() {
      _confirming = true;
      _result = null;
      _submitOk = null;
      _submitErrorKind = null;
      _error = null;
    });
    try {
      // The SAME transport rules /ask uses: a non-loopback server requires basic
      // auth on EVERY route, so a confirm posted without these headers is a 401
      // and the write never happens (review finding 2026-09-24 — this raw-dio
      // path had skipped the settings since Phase 7).
      ref.read(copilotApiClientProvider).applySettings();
      final dio = ref.read(dioProvider);
      // Stable per proposal instance (user decision 2026-09-16): every retry on
      // this card reuses the SAME key, so an error-then-retry cannot write a
      // second payment — the server replays the first result instead.
      final commandId = proposal.commandId;
      final res = await dio.post<Map<String, dynamic>>(
        '/execute',
        data: jsonEncode({
          'command_id': commandId,
          'proposal': proposal.toJson(),
          // P1 §10.5: the server warned that this intent looks like one proposed
          // minutes ago. Pressing confirm AFTER that warning is shown is exactly
          // the acknowledgement it asks for — without it the server refuses with
          // BUSINESS_DEDUP_CONFIRM_REQUIRED, so sending it is what makes the
          // warned card usable at all.
          if (proposal.dedupRequiresAck) 'dedup_ack': true,
          // F7-2: submit_now was frozen into this card's params snapshot by the
          // SERVER when the question was asked — the card replays what the user
          // saw, not what the settings screen holds now.
          if (proposal.params?['submit_now'] == true) 'submit_now': true,
        }),
      );
      // The card can be unmounted while /execute is in flight (user navigates
      // away or clears history) — after the await the State may be defunct and
      // setState would throw "setState() called after dispose()" (review
      // result40, proven by probe P1/P1b). Every post-await branch is guarded;
      // the write itself already happened server-side and is idempotent, so
      // skipping the UI update loses nothing.
      if (!mounted) return;
      final body = res.data ?? const {};
      if (body['ok'] == true) {
        final result = body['result'] as Map<String, dynamic>? ?? const {};
        final submitOk = result['submit_ok'];
        // P5-3: the badge's inputs, taken as typed values. A server that
        // predates these fields sends neither — and then the badge falls back
        // to the draft tone, which is the truthful reading of "no submit step
        // was reported".
        final submitKind = result['submit_error_kind'];
        setState(() {
          _submitOk = submitOk is bool ? submitOk : null;
          _submitErrorKind = submitKind is String ? submitKind : null;
          // B2: an order and a payment land as different documents with
          // different fields — one success string would print "?đ" for an order
          // or claim a payment that never happened.
          _result = body['replay'] == true
              ? 'Đã ghi nhận trước đó (chống trùng): ${result['erpnext_doc'] ?? '?'}'
              : proposal.action == 'create_quotation'
                  ? _quotationSuccessText(result)
              : proposal.action == 'create_purchase_order'
                  ? _purchaseSuccessText(result)
              : proposal.action == 'create_sales_order'
                  ? _orderSuccessText(result)
              : proposal.action == 'create_delivery_note'
                  ? _deliverySuccessText(result)
              : proposal.action == 'create_purchase_receipt'
                  ? _receiptSuccessText(result)
              : proposal.action == 'create_sales_invoice'
                  ? _invoiceSuccessText(result)
              : proposal.action == 'create_sales_return'
                  ? _returnSuccessText(result)
              : proposal.action == 'create_stock_adjustment'
                  ? _stockSuccessText(result)
              : proposal.action == 'create_customer'
                  ? _customerSuccessText(result)
                  : (submitOk == true
                      ? 'Đã ghi và NỘP ${_paymentVoucher(result)}: ${result['erpnext_doc'] ?? '?'} — ${result['paid_vnd'] ?? '?'}đ (công nợ đã giảm)'
                      : (submitOk == false
                          ? 'Đã tạo phiếu NHÁP: ${result['erpnext_doc'] ?? '?'} — NHƯNG submit lỗi: ${result['submit_error'] ?? '?'} — cần submit tay trên ERPNext'
                          : 'Đã ghi ${_paymentVoucher(result)}: ${result['erpnext_doc'] ?? '?'} — ${result['paid_vnd'] ?? '?'}đ'));
        });
      } else {
        _handleRefusal(body);
      }
    } on DioException catch (err) {
      if (!mounted) return;
      // Server 4xx/5xx THROW in dio by default (validateStatus accepts only
      // 2xx) — a 409 PROPOSAL_STALE/EXPIRED lands HERE, not in res.data.
      // Without this branch the Phase 9 banner could never appear in a real
      // run (found in the result33 review; widget tests previously only fed
      // rejections straight into the model, never through the wire).
      final body = err.response?.data;
      if (body is Map<String, dynamic> && body.isNotEmpty) {
        _handleRefusal(body);
      } else {
        // No response at all (connection drop / timeout) — keep the network
        // message; retrying is safe (same command_id, server replays).
        setState(
            () => _error = 'Không gửi được lệnh xác nhận: ${err.message ?? err}');
      }
    } catch (e) {
      // NOTE: this catch also sees exceptions from OUR OWN code inside the try
      // (e.g. a parse error in _handleRefusal) — hence the mounted guard below
      // and the tolerant parsing inside _handleRefusal. Without both, the first
      // error was swallowed and re-thrown here as a bogus "network" message
      // (review result40).
      if (!mounted) return;
      setState(() => _error = 'Không gửi được lệnh xác nhận: $e');
    } finally {
      if (mounted) setState(() => _confirming = false);
    }
  }

  /// Phase 9 UI (result32): a refusal from /execute carries the concrete
  /// reason (code + problems[]). Stamp it locally (immediate banner) AND
  /// attach it via the controller (persisted across restarts).
  void _handleRefusal(Map<String, dynamic> body) {
    // Unmounted ⇒ nothing to render and ref.read would throw on a disposed
    // scope (review result40, probe P1).
    if (!mounted) return;
    final code = body['code'] as String?;
    // Tolerant parse (review result40, probe P4): a NON-list `problems` used to
    // throw a TypeError out of the DioException handler, which meant the banner
    // never rendered AND the confirm button stayed on a refused card —
    // fail-OPEN exactly where fail-closed matters. Any refusal must render.
    final problems = body['problems'] is List
        ? (body['problems'] as List)
            .map((p) => p.toString())
            .toList(growable: false)
        : <String>[];
    // P1 (server §12): a drift refusal carries the SPECIFIC taxonomy code
    // (PROPOSAL_VERSION_STALE / PROPOSAL_ENTITY_CHANGED) with the old generic
    // name only as `legacy_code`. B2's order tests found the card only knew the
    // legacy names — so on a REAL 409 the reason banner never stamped and the
    // confirm button STAYED on a card the server had just refused (fail-open;
    // the server refuses again, but the user is invited to press a dead button).
    // All stale/expiry forms must remove the affordance and persist the reason.
    if (code == 'PROPOSAL_STALE' ||
        code == 'PROPOSAL_VERSION_STALE' ||
        code == 'PROPOSAL_ENTITY_CHANGED' ||
        code == 'PROPOSAL_EXPIRED') {
      setState(() {
        _rejectionCode = code;
        _rejectionProblems = problems;
      });
      // Best-effort persistence — the standalone-card case (not backed by a
      // controller turn) simply no-ops inside attachRejection.
      // `code` is provably non-null here (compared to two non-null literals
      // above) — Dart does not promote through `==`, hence the `!`.
      ref
          .read(chatControllerProvider.notifier)
          .attachRejection(proposal, code: code!, problems: problems);
    }
    // PROMPT-4: an unverified WRITE comes back as 503 + retry_same_command_id
    // (the server kept the command PENDING and will RECONCILE against ERPNext
    // on the next press). There is no "200 PARTIAL" any more, so the banner
    // must say what the money state is AND that pressing again is safe — it
    // reuses THIS card's command_id and never creates a second document.
    final base = '${body['error'] ?? 'xác nhận thất bại'}';
    final retrySameCommandId = body['retry_same_command_id'] == true;
    setState(
        () => _error = retrySameCommandId
            ? '$base  •  Bấm [Xác nhận] lại để hệ thống ĐỐI SOÁT với ERPNext '
                'bằng ĐÚNG lệnh này — KHÔNG tạo phiếu mới.'
            : base);
  }

  /// The order outcome: which document, which lines, and ERPNext's OWN total —
  /// never our estimate. A total_note (ERPNext computed something different,
  /// e.g. it applied taxes) is shown, not swallowed: the shop must not read a
  /// number the ERP did not compute.
  String _orderSuccessText(Map<String, dynamic> result) => _lineDocSuccessText(
        result,
        noun: 'đơn',
        tail: ' — chưa submit, cần người quyết định trên ERPNext',
      );

  /// B3: a quotation lands differently from an order — it is an OFFER. The
  /// outcome must not read like a booked sale (the shop decides what to do with
  /// a quote; nobody is owed anything yet).
  String _quotationSuccessText(Map<String, dynamic> result) => _lineDocSuccessText(
        result,
        noun: 'báo giá',
        tail: ' — đây là ĐỀ NGHỊ, chưa phải đơn đã chốt; chưa submit',
      );

  /// B4: a purchase order is money going OUT to a supplier, not a receivable.
  /// The outcome names the supplier and never claims a sale happened — a "Đã
  /// tạo đơn" that read like a sale would tell the shop it had sold goods it
  /// actually just committed to buy.
  String _purchaseSuccessText(Map<String, dynamic> result) => _lineDocSuccessText(
        result,
        noun: 'đơn mua',
        // Name the supplier the user recognises (the card's snapshot), falling
        // back to the id the server echoes for a reconciled result.
        partySuffix: proposal.entityName?.isNotEmpty == true
            ? ' từ ${proposal.entityName}'
            : (result['supplier'] is String ? ' từ ${result['supplier']}' : null),
        tail: ' — cam kết MUA chưa chốt (giá mua), chưa submit',
      );

  /// P9-A2: a delivery note is goods LEAVING the shop against an order that
  /// already exists. The outcome names the document and never implies stock
  /// moved — only a submit on ERPNext does that, and chat never submits.
  String _deliverySuccessText(Map<String, dynamic> result) => _lineDocSuccessText(
        result,
        noun: 'phiếu giao hàng',
        tail: ' — phiếu NHÁP theo đơn, CHƯA trừ kho (submit là bước riêng trên ERPNext)',
      );

  /// P9-C: the voucher word for a payment result.
  ///
  /// The EXECUTED direction is the server's (`result.direction`, with
  /// `party_kind` as the older-payload fallback): one card can be money in or
  /// money out, and a pay-out must never read "phiếu thu". A payload that
  /// carries neither field (pre-P9-C replay) keeps the original wording.
  String _paymentVoucher(Map<String, dynamic> result) {
    if (result['direction'] == 'pay' || result['party_kind'] == 'supplier') {
      return 'phiếu chi';
    }
    return 'phiếu thu';
  }

  /// P9-B: a purchase receipt is goods ENTERING the shop against a purchase
  /// order. Same discipline as the delivery note: a DRAFT, stock untouched.
  String _receiptSuccessText(Map<String, dynamic> result) => _lineDocSuccessText(
        result,
        noun: 'phiếu nhận hàng',
        tail: ' — phiếu NHÁP theo đơn mua, CHƯA cộng kho (submit là bước riêng trên ERPNext)',
      );

  /// P9-D: a sales invoice is a DRAFT too, and the outcome must say both halves
  /// of what that means for money — no revenue/receivable booked yet, and no
  /// stock movement (chat never submits, and `update_stock` is sent 0).
  String _invoiceSuccessText(Map<String, dynamic> result) => _lineDocSuccessText(
        result,
        noun: 'hoá đơn',
        tail: ' — hoá đơn NHÁP theo đơn, CHƯA ghi doanh thu/công nợ và KHÔNG đụng kho '
            '(submit là bước riêng trên ERPNext)',
      );

  /// P9-F: a RETURN is the opposite of a sale — the outcome must not read like
  /// revenue. It names the invoice it links back to and says the goods are NOT
  /// back in stock yet (the draft moves nothing).
  String _returnSuccessText(Map<String, dynamic> result) => _lineDocSuccessText(
        result,
        noun: 'phiếu trả hàng',
        tail: ' — phiếu trả NHÁP theo hoá đơn ${result['return_against'] ?? '?'}: CHƯA nhận lại kho / CHƯA ghi công nợ '
            '(submit là bước riêng trên ERPNext)',
      );

  /// P9-E: the write-off is a STOCK document with no price and no party. It was
  /// missing a branch here (fell through to the payment fallback and read
  /// "Đã ghi phiếu thu … ?đ") — the exact money-language-on-a-non-money-action
  /// trap this chain exists to prevent.
  String _stockSuccessText(Map<String, dynamic> result) => _lineDocSuccessText(
        result,
        noun: 'phiếu xuất hủy',
        tail: ' — phiếu NHÁP: hàng CHƯA ra khỏi kho (submit là bước riêng trên ERPNext)',
      );

  /// M1: master data has NO draft — the outcome must say the record is REAL and
  /// must NOT reuse money words. It also states the follow-up is the user's next
  /// sentence (no auto order/payment), which is the M1 policy §5 default.
  String _customerSuccessText(Map<String, dynamic> result) {
    final doc = result['erpnext_doc'] ?? '?';
    final name = result['customer_name'] ?? proposal.entityName ?? '?';
    return 'Đã tạo khách hàng: $name ($doc) — record THẬT, có thể bán/thu cho khách này '
        '(KHÔNG tự tạo đơn/phiếu thu)';
  }

  String _lineDocSuccessText(
    Map<String, dynamic> result, {
    required String noun,
    required String tail,
    String? partySuffix,
  }) {
    final doc = result['erpnext_doc'] ?? '?';
    final lines = result['lines'] is List ? (result['lines'] as List) : const [];
    final summary = lines
        .whereType<Map>()
        .map((l) => '${l['qty']} ${l['uom'] ?? ''} ${l['item_name'] ?? l['item_code'] ?? ''}')
        .join(' + ');
    // Either key is the DOCUMENT's own total as ERPNext reported it, never our
    // arithmetic: the order-shaped documents return `erpnext_total_vnd`, an
    // invoice returns `erpnext_grand_total`. A missing one prints nothing.
    final total = result['erpnext_total_vnd'] ?? result['erpnext_grand_total'];
    final totalText = total is num ? _vnd(total) : null;
    final note = result['total_note'];
    final buffer = StringBuffer('Đã tạo $noun NHÁP: $doc');
    if (partySuffix != null && partySuffix.isNotEmpty) buffer.write(partySuffix);
    if (summary.isNotEmpty) buffer.write(' — $summary');
    if (totalText != null) buffer.write(' — tổng $totalTextđ');
    if (note is String && note.isNotEmpty) buffer.write(' ($note)');
    buffer.write(tail);
    return buffer.toString();
  }

  /// The `lines` array of a LINE document proposal (sales order / quotation /
  /// purchase order — all three carry the same params shape), one compact row
  /// each: "2 Bao · Cám heo tăng trọng 25kg · 305.000đ/dv". Rendered from the
  /// SNAPSHOT (params.lines) — never re-fetched, never edited in place.
  List<Widget> _soLineRows(ColorScheme scheme) {
    final lines = proposal.params?['lines'];
    if (lines is! List || lines.isEmpty) {
      return [
        Text(
          '⚠️ Đơn không có dòng hàng nào — không thể xác nhận',
          style: TextStyle(color: scheme.error, fontSize: 12),
        ),
      ];
    }
    return [
      for (final raw in lines)
        if (raw is Map)
          Padding(
            padding: const EdgeInsets.only(bottom: 2),
            child: Text(
              _soLineText(raw),
              style: TextStyle(color: scheme.onSurface, fontSize: 13),
            ),
          ),
    ];
  }

  String _soLineText(Map raw) {
    // Tolerant parse: the server echoes ITS OWN snapshot, but a malformed line
    // must degrade to a less pretty row, never to a card that throws.
    final qty = num.tryParse('${raw['qty']}') ?? raw['qty'];
    final uom = raw['uom'] ?? '';
    final name = raw['item_name'] ?? raw['item_code'] ?? '';
    final rate = num.tryParse('${raw['rate']}');
    // A delivery-note line carries NO price of its own: the price belongs to the
    // order and the goods. Printing "?đ/dv" there would read like a missing
    // number instead of "this line has no price", so the segment is omitted.
    final rateText = rate != null ? ' · ${_vnd(rate)}đ/dv' : '';
    // A converted line shows BOTH what the user said and what ERPNext stocks —
    // the same disclosure rule as the answer text (không quy đổi ẩn).
    final factor = num.tryParse('${raw['conversion_factor']}');
    final parsedQty = num.tryParse('${raw['qty']}');
    final conv = (factor != null && factor != 1 && parsedQty != null && raw['stock_uom'] is String)
        ? ' (=${_qty(parsedQty * factor)} ${raw['stock_uom']})'
        : '';
    return '$qty $uom · $name$rateText$conv';
  }

  String get _soTotalText {
    final total = proposal.params?['estimated_total_vnd'];
    return total is num ? _vnd(total) : '?';
  }

  /// A QUANTITY is not money: 1000 → "1000", 1500.5 → "1500.5". The money
  /// formatter's dot-thousands idiom mangles it (1 Tấn = 1.000 Kg reads wrong),
  /// which is the exact mistake this helper exists to prevent.
  String _qty(num v) {
    if (v == v.roundToDouble()) return v.toInt().toString();
    return '$v';
  }

  /// 3050000 → "3.050.000" (dot thousands, the convention the answers use).
  String _vnd(num v) {
    final s = v.round().abs().toString();
    final buf = StringBuffer();
    for (var i = 0; i < s.length; i++) {
      buf.write(s[i]);
      final left = s.length - 1 - i;
      if (left > 0 && left % 3 == 0) buf.write('.');
    }
    if (v.isNegative) return '-$buf';
    return buf.toString();
  }

  /// P5-3 (§4.1): the draft/submitted badge beside the result line.
  ///
  /// Both tones come from the scheme (house rule at the top of this file:
  /// never a hardcoded hex). Draft borrows the warning tone the dedup banner
  /// already uses ([tertiaryContainer]); submitted uses the primary tone.
  /// "Draft" is the tone for everything that is not a confirmed submit —
  /// including "no submit step reported", which is the honest reading.
  Widget _submitBadge(ColorScheme scheme) {
    final submitted = _submitOk == true;
    return Container(
      key: const ValueKey('submit-badge'),
      padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 2),
      decoration: BoxDecoration(
        color: submitted ? scheme.primaryContainer : scheme.tertiaryContainer,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        submitted ? 'ĐÃ NỘP' : 'NHÁP',
        style: TextStyle(
          color: submitted ? scheme.onPrimaryContainer : scheme.onTertiaryContainer,
          fontSize: 11,
          fontWeight: FontWeight.w600,
        ),
      ),
    );
  }

  /// The advice line for a refused submit (§4.2). Null when there is nothing
  /// honest to add: only the three classified refusals get a recommendation.
  String? get _submitHint {
    if (_submitOk != false) return null;
    switch (_submitErrorKind) {
      case 'permission':
        return 'Bạn không có quyền nộp phiếu thu — liên hệ quản trị viên ERPNext để được cấp quyền Submit.';
      case 'period_locked':
        return 'Kỳ kế toán đã khoá, không thể nộp vào ngày này — liên hệ kế toán.';
      case 'workflow':
        return 'Chứng từ cần được duyệt trước khi nộp.';
      default:
        return null;
    }
  }

  Color _riskColor(ColorScheme scheme) {
    switch (proposal.risk) {
      case 'CRITICAL':
        return scheme.error; // ⚫ spec: most severe — error tone
      case 'HIGH':
        return scheme.errorContainer;
      case 'LOW':
        return scheme.tertiaryContainer;
      case 'READ':
      default:
        return scheme.secondaryContainer;
    }
  }

  Color _onRiskColor(ColorScheme scheme) {
    switch (proposal.risk) {
      case 'CRITICAL':
        return scheme.onError;
      case 'HIGH':
        return scheme.onErrorContainer;
      case 'LOW':
        return scheme.onTertiaryContainer;
      case 'READ':
      default:
        return scheme.onSecondaryContainer;
    }
  }

  @override
  Widget build(BuildContext context) {
    // Required by AutomaticKeepAliveClientMixin: performs the keep-alive
    // bookkeeping (register/release) based on wantKeepAlive above.
    super.build(context);
    final scheme = Theme.of(context).colorScheme;
    final riskColor = _riskColor(scheme);
    final onRiskColor = _onRiskColor(scheme);

    return Container(
      margin: const EdgeInsets.only(top: AppSpacing.sm),
      padding: const EdgeInsets.all(AppSpacing.sm),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12), // radius.md
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          // Risk badge row
          Row(
            children: [
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: AppSpacing.sm,
                  vertical: 2,
                ),
                decoration: BoxDecoration(
                  color: riskColor,
                  borderRadius: BorderRadius.circular(8),
                ),
                child: Text(
                  '${proposal.riskIcon} ${proposal.riskLabel.isEmpty ? proposal.risk : proposal.riskLabel}',
                  style: TextStyle(
                    color: onRiskColor,
                    fontSize: 11,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              const Spacer(),
              Text(
                proposal.action,
                style: TextStyle(
                  color: scheme.onSurfaceVariant,
                  fontSize: 11,
                  fontStyle: FontStyle.italic,
                ),
              ),
            ],
          ),
          const SizedBox(height: AppSpacing.xs),
          // Summary / entity line — what the proposal is about.
          Text(
            proposal.summary?.isNotEmpty == true
                ? proposal.summary!
                : (proposal.entityName?.isNotEmpty == true
                    ? proposal.entityName!
                    : proposal.action),
            style: TextStyle(color: scheme.onSurface),
          ),
          // B2 (plan3_review3): a Sales Order proposal shows its LINES — the
          // thing actually being confirmed. A card that only said "tạo đơn"
          // would hide what is being ordered; a card that invented a total
          // would hide that the number is only an estimate. Both numbers are
          // shown, labelled as what they are (server arithmetic vs. ERPNext's).
          // Any LINE document shows its lines: order, quotation, (B4) the
          // purchase order, (P9-A2) the delivery note, and (P9-D) the sales
          // invoice — same params shape, one renderer. A delivery note has no
          // total of its own (the money is on the order), so that row is shown
          // only for the priced kinds: an "?đ" total on a shipping document
          // would invent a number.
          if (proposal.action == 'create_sales_order' ||
              proposal.action == 'create_quotation' ||
              proposal.action == 'create_purchase_order' ||
              proposal.action == 'create_delivery_note' ||
              proposal.action == 'create_sales_invoice' ||
              proposal.action == 'create_sales_return') ...[
            const SizedBox(height: AppSpacing.xs),
            ..._soLineRows(scheme),
            if (proposal.action != 'create_delivery_note') ...[
              const SizedBox(height: 2),
              Text(
                'Tạm tính: $_soTotalTextđ (theo giá ERPNext — số thật là tổng ERPNext tính khi ghi)',
                style: TextStyle(
                  color: scheme.onSurfaceVariant,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ] else ...[
              const SizedBox(height: 2),
              Text(
                'Theo đơn ${proposal.params?['against_sales_order'] ?? '?'} — phiếu giao không có giá riêng',
                style: TextStyle(
                  color: scheme.onSurfaceVariant,
                  fontSize: 12,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ],
          ],
          if (proposal.entityId?.isNotEmpty == true) ...[
            const SizedBox(height: 2),
            Text(
              'ID: ${proposal.entityId}',
              style: TextStyle(
                color: scheme.onSurfaceVariant,
                fontSize: 11,
                fontFamily: 'monospace',
              ),
            ),
          ],
          // P1 §10.5: the server saw the same intent (customer + amount) minutes
          // ago. The warning is shown BEFORE the button, and pressing confirm
          // afterwards is what sends dedup_ack — the user is told, then decides.
          // Never a silent block: an additional, legitimate payment is allowed.
          if (proposal.dedupRequiresAck) ...[
            const SizedBox(height: AppSpacing.xs),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpacing.xs),
              decoration: BoxDecoration(
                color: scheme.tertiaryContainer,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Text(
                proposal.dedupMessage ??
                    'Đề xuất này trùng ý định với một đề xuất gần đây — kiểm tra kỹ trước khi xác nhận.',
                style: TextStyle(color: scheme.onTertiaryContainer, fontSize: 12),
              ),
            ),
          ],
          // F7-2: what confirming will DO was frozen into the snapshot when the
          // question was asked (proposal.params.submit_now) — show it here so
          // the button never promises less or more than the server will do.
          if (proposal.params?['submit_now'] == true) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              '⚡ Khi bật: xác nhận sẽ TẠO phiếu và NỘP NGAY — công nợ khách giảm ngay.',
              style: TextStyle(color: scheme.error, fontSize: 12),
            ),
          ],
          // P9-E: a stock write-off is the ONE write whose result depends on TWO
          // slots the user SPOKE (how many AND out of which room). The server
          // raises `need_double_confirm` for it from the contract, and this line
          // is what makes that flag mean something on screen: a card that
          // stayed silent would let a shop owner confirm a quantity against the
          // wrong warehouse — the mistake this rule exists to prevent.
          if (proposal.confirmable && proposal.needDoubleConfirm) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              '⚠ Xác nhận kép: đúng SỐ LƯỢNG và đúng KHO ở trên — sai kho là sai chỗ kiểm kê.',
              style: TextStyle(color: scheme.error, fontSize: 12),
            ),
          ],
          // Phase 9 UI (result32/result33): a refused card shows WHY —
          // banner with the machine code + the human-readable problems[]
          // from the server. It replaces the confirm affordance: a stale
          // card must be re-asked, never confirmed on old numbers
          // (fail-closed, no silent clamp). Rejection comes from the model
          // (persisted, survives restart) OR the local stamp (immediate,
          // works even for a card not backed by the controller yet).
          if (proposal.isRejected || _rejectionCode != null) ...[
            const SizedBox(height: AppSpacing.xs),
            Container(
              width: double.infinity,
              padding: const EdgeInsets.all(AppSpacing.xs),
              decoration: BoxDecoration(
                color: scheme.errorContainer,
                borderRadius: BorderRadius.circular(8),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    (proposal.rejectionCode ?? _rejectionCode) ==
                            'PROPOSAL_EXPIRED'
                        ? '⏰ Đề xuất đã hết hạn — hãy hỏi lại để tạo đề xuất mới trên số liệu hiện tại'
                        : '🔄 Đề xuất đã lệch so với dữ liệu thật — KHÔNG ghi, hãy hỏi lại',
                    style: TextStyle(
                      color: scheme.onErrorContainer,
                      fontWeight: FontWeight.w600,
                      fontSize: 12,
                    ),
                  ),
                  if (proposal.rejectionProblems.isNotEmpty ||
                      _rejectionProblems.isNotEmpty) ...[
                    const SizedBox(height: 2),
                    ...(proposal.rejectionProblems.isNotEmpty
                            ? proposal.rejectionProblems
                            : _rejectionProblems)
                        .map(
                          (p) => Text(
                            '• $p',
                            style: TextStyle(
                              color: scheme.onErrorContainer,
                              fontSize: 11,
                            ),
                          ),
                        ),
                  ],
                ],
              ),
            ),
          ] else if (proposal.confirmable) ...[
            // Phase 7: the confirm button — ONLY for the one HIGH write.
            // command_id is stable for this CARD (created on first use, pinned
            // in toJson — see ActionProposal.commandId), so a retry after an
            // error replays instead of writing a second payment.
            const SizedBox(height: AppSpacing.sm),
            if (_result != null) ...[
              Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  // P5-3 review: the leading glyph follows the SAME state as the
                  // badge. A flat ✅ in front of "Đã tạo phiếu NHÁP … NHƯNG submit
                  // lỗi" claimed success on a line the badge was marking as draft.
                  // `false` is the only case that is genuinely not-done; `null`
                  // (older server, no submit step) keeps ✅ — nothing was refused.
                  Expanded(
                    child: Text(
                      '${_submitOk == false ? '⚠️' : '✅'} $_result',
                      style: TextStyle(color: scheme.primary, fontWeight: FontWeight.w600),
                    ),
                  ),
                  const SizedBox(width: AppSpacing.xs),
                  _submitBadge(scheme),
                ],
              ),
              // P5-2 + P5-3: a REFUSED submit gets one line of "what to do",
              // classified server-side. For `other` (or an older server) there
              // is nothing extra to say — ERPNext's own message is already in
              // the result line above, and inventing advice would be guessing.
              if (_submitHint != null) ...[
                const SizedBox(height: AppSpacing.xs),
                Text(
                  _submitHint!,
                  key: const ValueKey('submit-hint'),
                  style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12),
                ),
              ],
            ] else ...[
              FilledButton.icon(
                onPressed: _confirming ? null : _confirm,
                icon: _confirming
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.check, size: 16),
                // B2: the button says what confirming DOES. A generic
                // "Xác nhận" on an order card would let a shop owner confirm a
                // payment-shaped action they did not mean to take.
                label: Text(_confirming
                    ? 'Đang ghi...'
                    : proposal.action == 'create_quotation'
                        ? 'Xác nhận tạo báo giá (NHÁP)'
                    : proposal.action == 'create_purchase_order'
                        ? 'Xác nhận tạo đơn mua (NHÁP)'
                    : proposal.action == 'create_sales_order'
                        ? 'Xác nhận tạo đơn (NHÁP)'
                    : proposal.action == 'create_delivery_note'
                        ? 'Xác nhận tạo phiếu giao (NHÁP)'
                    : proposal.action == 'create_purchase_receipt'
                        ? 'Xác nhận tạo phiếu nhận hàng (NHÁP)'
                    // P9-D: an invoice carries money both ways in the shop's
                    // language ("xuất hoá đơn" is a receivable), so the button
                    // names the DOCUMENT, never the cash direction.
                    : proposal.action == 'create_sales_return'
                        // P9-F: the button names the REVERSAL — "trả hàng" is
                        // what the shop owner said, and the card promises a NHÁP.
                        ? 'Xác nhận trả hàng (NHÁP)'
                        : proposal.action == 'create_sales_invoice'
                        ? 'Xác nhận tạo hoá đơn (NHÁP)'
                    // P9-E: the button names the MOVE (hàng ra khỏi kho), not the
                    // document type — "xuất hủy" is what the shop owner said.
                    : proposal.action == 'create_stock_adjustment'
                        ? 'Xác nhận xuất hủy (NHÁP)'
                        // M1: master data — the ONE write with NO draft. Without
                        // this branch the label falls through to the payment
                        // direction chain and says "Xác nhận thu tiền" on a
                        // customer-create card (money language on a non-money
                        // action — the exact trap this chain exists to prevent).
                        : proposal.action == 'create_customer'
                            ? 'Xác nhận tạo khách hàng (record thật)'
                        // P9-C: a payment card is money IN or OUT — the button must
                        // not offer "thu tiền" on a pay-out order. Direction comes
                        // from the server's params (`pay` | `receive`).
                        : proposal.params?['direction'] == 'pay'
                            ? 'Xác nhận chi tiền (NHÁP)'
                            : 'Xác nhận thu tiền'),
              ),
            ],
            if (_error != null) ...[
              const SizedBox(height: AppSpacing.xs),
              Text(
                '⚠ $_error',
                style: TextStyle(color: scheme.error, fontSize: 12),
              ),
            ],
          ] else if (proposal.needConfirm) ...[
            const SizedBox(height: AppSpacing.xs),
            Text(
              proposal.needDoubleConfirm
                  ? '⚠ Sẽ cần xác nhận kép khi kích hoạt ghi (Phase 7)'
                  : 'Sẽ cần xác nhận khi kích hoạt ghi (Phase 7)',
              style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 11),
            ),
          ],
        ],
      ),
    );
  }
}
