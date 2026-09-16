import 'package:flutter/material.dart';

import '../../../../app/theme/app_theme.dart';
import '../../data/chat_models.dart';

/// Phase 6 — Action Proposal summary card (display-only).
///
/// Renders the erpn.proposal/v1 object as a human-readable card: risk badge,
/// action summary, and the resolved entity. NO confirm button exists here on
/// purpose — Phase 6 stops at display; the confirm-execute flow arrives with
/// Phase 7 (first write). Colors come from the theme, never hardcoded hex.
class ProposalCard extends StatelessWidget {
  const ProposalCard({super.key, required this.proposal});

  final ActionProposal proposal;

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
          // Phase 6 status note — honest about what the card cannot do yet.
          if (proposal.needConfirm) ...[
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
