import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../app/theme/app_theme.dart';
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

class _ProposalCardState extends ConsumerState<ProposalCard> {
  bool _confirming = false;
  String? _result;
  String? _error;

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
        data: jsonEncode({'command_id': commandId, 'proposal': proposal.toJson()}),
      );
      final body = res.data ?? const {};
      if (body['ok'] == true) {
        final result = body['result'] as Map<String, dynamic>? ?? const {};
        setState(() {
          _result = body['replay'] == true
              ? 'Đã ghi nhận trước đó (chống trùng): ${result['erpnext_doc'] ?? '?'}'
              : 'Đã ghi phiếu thu: ${result['erpnext_doc'] ?? '?'} — ${result['paid_vnd'] ?? '?'}đ';
        });
      } else {
        setState(() => _error = '${body['error'] ?? 'xác nhận thất bại'}');
      }
    } catch (e) {
      setState(() => _error = 'Không gửi được lệnh xác nhận: $e');
    } finally {
      if (mounted) setState(() => _confirming = false);
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
          // Phase 7: the confirm button — ONLY for the one HIGH write.
          // command_id is generated per press; the SERVER dedupes replays.
          if (proposal.confirmable) ...[
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
