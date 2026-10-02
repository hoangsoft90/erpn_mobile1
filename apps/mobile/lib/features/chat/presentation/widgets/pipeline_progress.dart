import 'dart:async';

import 'package:flutter/material.dart';

import '../../../../app/theme/app_theme.dart';

/// P2 deliverable 4 (plan2_final §24.11): a long pipeline must show WHERE it
/// is, not an endless spinner. The four phases are the real stages of the
/// gateway pipeline: normalize (hiểu) → entity resolve → policy/validate →
/// waiting for the user's confirm. The gateway does not (yet) stream a phase
/// ticker, so this widget advances the phases on a fixed cadence while the
/// request runs — the LABELS are the contract; a future streamed phase simply
/// replaces the timer with real events.
class PipelineProgress extends StatefulWidget {
  const PipelineProgress({super.key});

  @override
  State<PipelineProgress> createState() => _PipelineProgressState();
}

class _PipelineProgressState extends State<PipelineProgress> {
  static const _phases = ['Đang hiểu câu…', 'Đang tra khách…', 'Đang kiểm tra…', 'Chờ xác nhận'];
  static const _phaseDuration = Duration(milliseconds: 1600);
  Timer? _timer;
  int _phase = 0;

  @override
  void initState() {
    super.initState();
    // Periodic + cancel-in-dispose: no timer can outlive the widget (a chained
    // Future.delayed keeps a pending timer alive after teardown, which both
    // flutter_test rejects and a real re-build churns).
    _timer = Timer.periodic(_phaseDuration, (_) {
      if (!mounted) return;
      setState(() => _phase = (_phase + 1) % _phases.length);
    });
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: AppSpacing.md, vertical: AppSpacing.xs),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          LinearProgressIndicator(value: (_phase + 1) / _phases.length),
          const SizedBox(height: AppSpacing.xs),
          Text(_phases[_phase], style: theme.textTheme.labelSmall),
        ],
      ),
    );
  }
}
