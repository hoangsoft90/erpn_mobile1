import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../app/providers.dart';
import '../../../../app/theme/app_theme.dart';
import '../../../../core/widgets/data_provenance.dart';
import '../../../chat/data/copilot_api_client.dart';
import '../../data/drill_models.dart';

/// P4-4 (plan4_final §4.4) — the list behind one metric on "Tóm tắt ngày".
///
/// Data does not come from the summary screen's response: the tapped metric only
/// names WHICH fixed drill id to open, and this screen reads `/read/drill` fresh
/// (the point of the tap is the documents behind the number, now). READ-only:
/// there is no confirm/execute affordance and no path to `/execute` — the same
/// posture as A1's list, which this screen deliberately mirrors (Back returns to
/// the summary; the number above is unchanged).
class DrillListScreen extends ConsumerStatefulWidget {
  const DrillListScreen({super.key, required this.intent});

  final DrillIntent intent;

  @override
  ConsumerState<DrillListScreen> createState() => _DrillListScreenState();
}

class _DrillListScreenState extends ConsumerState<DrillListScreen> {
  DrillScreenData? _data;
  String? _error;
  bool _loading = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  Future<void> _load() async {
    if (_loading) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      // P4-6: the intent may name the day to read (Hôm qua on the summary).
      // Null keeps the server's own "today" (§3.7) — this screen never invents
      // a date of its own.
      final data = await ref.read(copilotApiClientProvider).readDrill(
            drillId: widget.intent.drillId,
            date: widget.intent.date,
          );
      // The user can leave while the read is in flight; writing state after
      // dispose is the classic crash this project already paid for once.
      if (!mounted) return;
      setState(() {
        _data = data;
        _loading = false;
      });
    } on CopilotException catch (err) {
      if (!mounted) return;
      setState(() {
        _error = err.message;
        _loading = false;
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    // Prefer the SERVER's title once the read lands: the contract owns what a
    // drill is called, and the intent's label only covers the loading moment.
    final title = _data?.title ?? (widget.intent.title.isNotEmpty ? widget.intent.title : 'Chi tiết');
    return Scaffold(
      appBar: AppBar(
        title: Text(title),
        leading: BackButton(onPressed: () => Navigator.of(context).maybePop()),
      ),
      body: SafeArea(child: _body(context)),
    );
  }

  Widget _body(BuildContext context) {
    final data = _data;
    if (data == null && _loading) {
      return const Padding(
        padding: EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            CircularProgressIndicator(),
            SizedBox(height: AppSpacing.md),
            Text('Đang đọc dữ liệu mới nhất từ ERPNext…'),
          ],
        ),
      );
    }
    if (data == null) {
      return Padding(
        padding: const EdgeInsets.all(AppSpacing.lg),
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.error_outline, color: Theme.of(context).colorScheme.error),
            const SizedBox(height: AppSpacing.sm),
            // The reason comes from the server verbatim: a refusal
            // (UNKNOWN_DRILL_SCREEN / 403) and an unreachable ERPNext must not
            // look like "no documents today".
            Text(_error ?? 'Không đọc được dữ liệu.', textAlign: TextAlign.center),
            const SizedBox(height: AppSpacing.md),
            TextButton(
              key: const ValueKey('drill-retry'),
              onPressed: _load,
              child: const Text('Thử lại'),
            ),
          ],
        ),
      );
    }
    // §2.1/§2.2 — rows and figures are rendered only when the payload names the
    // REAL source; otherwise the panel REPLACES them (a warning above the money
    // would still be a screen showing money it cannot vouch for).
    if (!isRealProvenance(data.erpTarget)) {
      return InvalidProvenancePanel(erpTarget: data.erpTarget, onRetry: _load);
    }
    return RefreshIndicator(
      onRefresh: _load,
      child: ListView(
        // D4 (§2.4) — REQUIRED for pull-to-refresh to exist on a SHORT list: a
        // ListView whose content fits its viewport does not accept drags at all
        // (with the platform default physics), so there is no overscroll
        // notification for the RefreshIndicator to see and the gesture silently
        // does nothing. Found by the D4 refresh test (a 0-row drawer could not
        // be refreshed), not by reading the code.
        physics: const AlwaysScrollableScrollPhysics(),
        padding: const EdgeInsets.all(AppSpacing.md),
        children: [
          for (final line in data.summaryLines) _SummaryLine(line: line),
          // D3 (§3.4 / §2.2 `loadedPartial`) — a section that could not be read
          // is stated ABOVE the list: the rows below are real, but the picture
          // is not complete, and an unlabelled half-read day would read as a
          // whole one.
          if (data.partial)
            Padding(
              key: const ValueKey('drill-partial-banner'),
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Row(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Icon(Icons.info_outline,
                      size: 18, color: Theme.of(context).colorScheme.error),
                  const SizedBox(width: AppSpacing.xs),
                  Expanded(
                    child: Text(
                      data.sectionsFailed.isEmpty
                          ? 'Một phần dữ liệu chưa đọc được — danh sách dưới là phần đã đọc.'
                          : 'Chưa đọc được: ${data.sectionsFailed.join(', ')} — danh sách dưới là phần đã đọc.',
                      style: Theme.of(context)
                          .textTheme
                          .bodySmall
                          ?.copyWith(color: Theme.of(context).colorScheme.error),
                    ),
                  ),
                ],
              ),
            ),
          if (data.truncated)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.sm),
              // Says how many were left out instead of letting a capped page
              // read as the whole day.
              child: Text(
                'Hiện ${data.rows.length}/${data.totalDocuments} dòng — còn ${data.totalDocuments - data.rows.length} dòng khác.',
                style: Theme.of(context).textTheme.bodyMedium,
              ),
            ),
          const SizedBox(height: AppSpacing.sm),
          if (data.rows.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: AppSpacing.lg),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    // An empty list is an ANSWER here (the server read the day
                    // and found nothing), so it is stated plainly — never
                    // dressed as an error, and never as a zero the server did
                    // not send.
                    'Không có dòng nào trong mục này cho ngày ${data.date}.',
                    style: Theme.of(context).textTheme.bodyMedium,
                  ),
                  const SizedBox(height: AppSpacing.xs),
                  Text(
                    // §5 (review7 B.5): an empty state is ACTIONABLE — it says
                    // what the user can do next instead of just showing "0".
                    // The action itself lives in chat (this screen has no write
                    // affordance, deliberately).
                    'Cần tạo chứng từ? Nói trong chat (ví dụ: "đặt hàng cho chị Lan 10 bao cám") rồi bấm xác nhận.',
                    style: Theme.of(context)
                        .textTheme
                        .bodySmall
                        ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
                  ),
                ],
              ),
            )
          else
            for (final row in data.rows) _RowTile(row: row),
          const SizedBox(height: AppSpacing.md),
          Text(
            'Chỉ để xem. Mọi thay đổi tiền vẫn làm trong chat rồi bấm xác nhận.',
            style: Theme.of(context).textTheme.bodySmall,
          ),
          // D1 (§3.1) — the drawer's footnote and the OPTIONAL draft hint, both
          // WORDING the server owns: the figure above is the ledger's figure and
          // the hint says open drafts exist without changing it. Drawn only when
          // the server said something (absent = nothing to say, never "0").
          if (data.footnote != null)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Text(
                data.footnote!,
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          if (data.draftHintCount != null && data.draftHintAmountVnd != null)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Text(
                'Có ${data.draftHintCount} phiếu nháp chưa nộp (${_vnd(data.draftHintAmountVnd!)}đ).',
                style: Theme.of(context)
                    .textTheme
                    .bodySmall
                    ?.copyWith(color: Theme.of(context).colorScheme.onSurfaceVariant),
              ),
            ),
        ],
      ),
    );
  }
}

class _SummaryLine extends StatelessWidget {
  const _SummaryLine({required this.line});

  final DrillSummaryLine line;

  @override
  Widget build(BuildContext context) {
    final amount = line.amountVnd;
    final parts = <String>[
      if (amount != null) '${_vnd(amount)}đ',
      if (line.count != null) '${line.count}',
    ];
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Expanded(child: Text(line.label, style: Theme.of(context).textTheme.bodyMedium)),
          const SizedBox(width: AppSpacing.sm),
          Text(
            // A null amount is a COUNT, never "0đ": the server sends null for
            // lines that are not money, and this screen must not invent one.
            parts.isEmpty ? '—' : parts.join(' · '),
            style: Theme.of(context).textTheme.titleMedium,
          ),
        ],
      ),
    );
  }
}

class _RowTile extends StatelessWidget {
  const _RowTile({required this.row});

  final DrillRow row;

  @override
  Widget build(BuildContext context) {
    // P4-5: an app-draft row copies the document's own grand_total, but the
    // card leads with the DOCUMENT (name + type + status), not a money figure
    // — the block above is a COUNT, and the draft's value only becomes money
    // the moment it is submitted (until then it is a proposal, not books).
    final isAppDraft = row.kind == 'app_draft';
    // D2 (§3.3): a low-stock row carries a QUANTITY in amountVnd (the server
    // copies the Bin's actual_qty) — printing "đ" after it would claim the
    // shelf count is money. Unit-less, with the unit named by the server's own
    // summary line ("Tồn thấp — Kho: …").
    final isQuantity = row.kind == 'stock_low_item';
    return Card(
      margin: const EdgeInsets.symmetric(vertical: AppSpacing.xs),
      child: ListTile(
        title: Text(row.name, style: Theme.of(context).textTheme.titleSmall),
        subtitle: Text([if (row.date != null) row.date!, if (row.note.isNotEmpty) row.note].join(' · ')),
        trailing: isAppDraft
            ? const Text('—')
            : isQuantity
                ? Text(_vnd(row.amountVnd))
                : Text('${_vnd(row.amountVnd)}đ'),
      ),
    );
  }
}

/// Same one-liner the other money screens in this app use (`read_list_screen`,
/// `daily_summary_screen`) so a figure cannot look different across screens.
String _vnd(int n) => n.toString().replaceAllMapped(
      RegExp(r'(\d)(?=(\d{3})+$)'),
      (m) => '${m[1]}.',
    );
