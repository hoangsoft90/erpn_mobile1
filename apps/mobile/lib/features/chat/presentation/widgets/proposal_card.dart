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
      _error = null;
    });
    try {
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
        setState(() {
          _result = body['replay'] == true
              ? 'Đã ghi nhận trước đó (chống trùng): ${result['erpnext_doc'] ?? '?'}'
              // F7-2: a submit-now write reports THREE outcomes — draft only
              // (switch off), draft+submitted, and the PARTIAL case where the
              // draft exists but the submit failed (the user must finish on
              // ERPNext; the money record itself stands either way).
              : (submitOk == true
                  ? 'Đã ghi và NỘP phiếu thu: ${result['erpnext_doc'] ?? '?'} — ${result['paid_vnd'] ?? '?'}đ (công nợ đã giảm)'
                  : (submitOk == false
                      ? 'Đã tạo phiếu NHÁP: ${result['erpnext_doc'] ?? '?'} — NHƯNG submit lỗi: ${result['submit_error'] ?? '?'} — cần submit tay trên ERPNext'
                      : 'Đã ghi phiếu thu: ${result['erpnext_doc'] ?? '?'} — ${result['paid_vnd'] ?? '?'}đ'));
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
    if (code == 'PROPOSAL_STALE' || code == 'PROPOSAL_EXPIRED') {
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
    setState(
        () => _error = '${body['error'] ?? 'xác nhận thất bại'}');
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
            if (_result != null)
              Text(
                '✅ $_result',
                style: TextStyle(color: scheme.primary, fontWeight: FontWeight.w600),
              )
            else ...[
              FilledButton.icon(
                onPressed: _confirming ? null : _confirm,
                icon: _confirming
                    ? const SizedBox(
                        width: 14,
                        height: 14,
                        child: CircularProgressIndicator(strokeWidth: 2),
                      )
                    : const Icon(Icons.check, size: 16),
                label: Text(_confirming ? 'Đang ghi...' : 'Xác nhận thu tiền'),
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
