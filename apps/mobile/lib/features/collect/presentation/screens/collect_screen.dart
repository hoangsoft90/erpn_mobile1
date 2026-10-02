import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../app/theme/app_theme.dart';
import '../../../chat/presentation/widgets/proposal_card.dart';
import '../../../chat/data/chat_models.dart';
import '../../application/collect_controller.dart';
import '../../data/collect_models.dart' hide CollectSummary;
import '../widgets/account_picker.dart';
import '../widgets/collect_summary.dart';
import '../widgets/invoice_allocation_tile.dart';
import '../widgets/payment_method_section.dart';

/// next8 Phase 2 — the dedicated collection screen (phase-02 §1).
///
/// Four blocks, one confirm: Khách · Hoá đơn · Phương thức · Tổng, and a
/// single `XÁC NHẬN THU` action whose ONLY consequence is `/collect/propose`
/// (the ordinary proposal object rendered by the existing [ProposalCard]; the
/// final confirm stays the existing card flow — phase-02 §3, no private
/// `/execute` path).
///
/// The handoff arrives from the route (`/collect` extra). Without one the
/// screen REFUSES in Vietnamese (T5) instead of inventing a ticket.
class CollectScreen extends ConsumerStatefulWidget {
  const CollectScreen({super.key, required this.handoff});

  final BusinessHandoff handoff;

  @override
  ConsumerState<CollectScreen> createState() => _CollectScreenState();
}

class _CollectScreenState extends ConsumerState<CollectScreen> {
  late CollectController _controller;

  @override
  void initState() {
    super.initState();
    _controller = ref.read(collectControllerProvider(widget.handoff).notifier);
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _controller.resolveCustomer();
    });
  }

  @override
  Widget build(BuildContext context) {
    final ui = ref.watch(collectControllerProvider(widget.handoff));
    return Scaffold(
      appBar: AppBar(title: const Text('Thu tiền')),
      // A SingleChildScrollView + Column, not a ListView: the form has SIX fixed
      // blocks (a shop's collect form, not an endless feed) — every block stays
      // BUILT, so a block below the fold still renders its state and its error
      // copy (a lazy viewport would blank them until scrolled into view).
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _CustomerBlock(ui: ui),
              const SizedBox(height: AppSpacing.lg),
              _InvoiceBlock(ui: ui, controller: _controller),
              const SizedBox(height: AppSpacing.lg),
              _MethodBlock(ui: ui, controller: _controller),
              const SizedBox(height: AppSpacing.lg),
              _SummaryBlock(ui: ui, controller: _controller),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Khách ────────────────────────────────────────────────────────────────────

class _CustomerBlock extends StatelessWidget {
  const _CustomerBlock({required this.ui});

  final CollectUi ui;

  @override
  Widget build(BuildContext context) {
    final slotResolved = ui.customerResolved == true;
    return Column(
      key: const ValueKey('collect-customer-block'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Khách', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        if (slotResolved)
          Text(
            ui.customerName ?? ui.customerId ?? '',
            key: const ValueKey('collect-customer-name'),
            style: Theme.of(context).textTheme.bodyLarge,
          )
        else ...[
          Text(
            'Chưa xác định được khách — quay lại chat để nói rõ tên khách.',
            key: const ValueKey('collect-customer-missing'),
            style: Theme.of(context).textTheme.bodyMedium,
          ),
          if (ui.customerName != null && ui.customerName!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Text(
                'Câu nói: ${ui.customerName}',
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
          // T4: the ticket's own candidates are SHOWN as chips — the screen
          // never PICKS one (§6.3 posture: không tự chọn). Picking happens in
          // chat by re-saying the sentence with the chosen name.
          for (final c in ui.customerCandidates)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Text(
                c,
                key: ValueKey('collect-candidate-$c'),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
        ],
      ],
    );
  }
}

// ── Hoá đơn ───────────────────────────────────────────────────────────────

class _InvoiceBlock extends ConsumerWidget {
  const _InvoiceBlock({required this.ui, required this.controller});

  final CollectUi ui;
  final CollectController controller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    // T3/T5: without a RESOLVED customer there is no list to show — a default
    // empty page here would read as "no debt", which is a wrong money signal.
    if (ui.customerResolved != true) {
      return const SizedBox.shrink();
    }
    if (ui.invoicesLoading && ui.invoices.matchedTotal == 0) {
      return const Padding(
        padding: EdgeInsets.all(AppSpacing.lg),
        child: Center(child: CircularProgressIndicator()),
      );
    }
    if (ui.invoicesError != null) {
      return Column(
        key: const ValueKey('collect-invoices-error'),
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            'Không đọc được hoá đơn: ${ui.invoicesError}',
            style: Theme.of(context)
                .textTheme
                .bodySmall
                ?.copyWith(color: Theme.of(context).colorScheme.error),
          ),
          TextButton(
            onPressed: () => controller.resolveCustomer(),
            child: const Text('Thử lại'),
          ),
        ],
      );
    }
    final page = ui.invoices;
    return Column(
      key: const ValueKey('collect-invoice-block'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('Hoá đơn', style: Theme.of(context).textTheme.titleMedium),
            if (page.matchedTotal > 0)
              Text(
                page.truncated
                    ? 'hiện ${page.rows.length}/${page.matchedTotal} kết quả'
                    : '${page.matchedTotal} kết quả',
                key: const ValueKey('collect-invoice-count'),
                style: Theme.of(context).textTheme.bodySmall,
              ),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        TextField(
          key: const ValueKey('collect-search'),
          decoration: const InputDecoration(
            prefixIcon: Icon(Icons.search),
            hintText: 'Tìm theo số, ngày, số tiền…',
          ),
          onChanged: (q) {
            controller.setSearchQuery(q);
            controller.search(q);
          },
        ),
        const SizedBox(height: AppSpacing.sm),
        if (page.matchedTotal == 0) ...[
          // §6.3: zero open invoices is the LEGITIMATE on-account path — not an
          // error, not a dead end. The screen says what will happen and lets
          // the confirm through with an empty allocation.
          const Text(
            'Thu không gắn hoá đơn (ứng trước / chưa phân bổ).',
            key: ValueKey('collect-on-account-copy'),
          ),
        ] else ...[
          ...page.rows.map((inv) {
            final selected = ui.allocations.containsKey(inv.id);
            return InvoiceAllocationTile(
              key: ValueKey('invoice-tile-${inv.id}'),
              invoice: inv,
              selected: selected,
              amount: ui.allocations[inv.id],
              onToggle: (on) => on == true
                  ? controller.setAllocation(inv.id, inv.outstandingVnd,
                      outstandingVnd: inv.outstandingVnd)
                  : controller.clearAllocation(inv.id),
              onAmountChanged: (raw) {
                final v = int.tryParse(raw.replaceAll(RegExp(r'[^0-9]'), ''));
                controller.setAllocation(inv.id, v, outstandingVnd: inv.outstandingVnd);
              },
            );
          }),
          // §6.4: a page that is full only means the page is full. The honest
          // "còn N kết quả" comes from the server's matched count.
          if (page.truncated && page.matchedTotal > page.rows.length)
            Padding(
              padding: const EdgeInsets.only(top: AppSpacing.xs),
              child: Text(
                'Còn ${page.matchedTotal - page.rows.length} kết quả khác — dùng ô tìm kiếm để thu hẹp.',
                key: const ValueKey('collect-more-results'),
                style: Theme.of(context).textTheme.bodySmall,
              ),
            ),
        ],
      ],
    );
  }
}

// ── Phương thức ──────────────────────────────────────────────────────────

class _MethodBlock extends ConsumerWidget {
  const _MethodBlock({required this.ui, required this.controller});

  final CollectUi ui;
  final CollectController controller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        PaymentMethodSection(
          method: ui.method,
          onChanged: controller.setMethod,
        ),
        const SizedBox(height: AppSpacing.sm),
        if (ui.method != null) ...[
          if (!ui.accounts.resolves(ui.method!))
            Text(
              AccountPicker.blockCopy,
              key: const ValueKey('account-blocked-inline'),
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: Theme.of(context).colorScheme.error),
            )
          else
            AccountPicker(
              accounts: ui.accounts.forMode(ui.method!),
              selected: ui.account,
              onChanged: (a) => a == null ? null : controller.setAccount(a),
            ),
        ],
      ],
    );
  }
}

// ── Tổng + confirm ───────────────────────────────────────────────────────

class _SummaryBlock extends ConsumerWidget {
  const _SummaryBlock({required this.ui, required this.controller});

  final CollectUi ui;
  final CollectController controller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final allocated = controller.allocatedTotal(ui);
    final payment = controller.paymentTotal(ui);
    final canSubmit = controller.canSubmit(ui);
    final result = ui.result;
    // T10/T11 — the out-of-range reason (when there is one), so the confirm
    // button being off is never a mystery.
    final openCount = ui.invoices.matchedTotal;
    final needsAllocationHint = openCount > 0 && ui.allocations.isEmpty && payment > 0;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        TextField(
          key: const ValueKey('collect-amount'),
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(
            labelText: 'Số tiền thu',
            hintText: 'Nhập số tiền thu (ví dụ 3000000)',
          ),
          onChanged: (raw) =>
              controller.setAmount(int.tryParse(raw.replaceAll(RegExp(r'[^0-9]'), ''))),
        ),
        const SizedBox(height: AppSpacing.sm),
        CollectSummary(allocatedTotalVnd: allocated, paymentTotalVnd: payment),
        const SizedBox(height: AppSpacing.md),
        if (needsAllocationHint)
          const Text(
            'Khách còn hoá đơn mở — hãy tích chọn hoá đơn cần gạch nợ.',
            key: ValueKey('collect-allocation-required-copy'),
          ),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            key: const ValueKey('collect-confirm'),
            onPressed: canSubmit && !ui.submitting ? () => controller.confirm() : null,
            child: ui.submitting
                ? const SizedBox(
                    height: 18,
                    width: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('XÁC NHẬN THU'),
          ),
        ),
        if (result != null) ...[
          const SizedBox(height: AppSpacing.md),
          if (result.ok && result.proposal != null)
            // The SAME card the chat renders: the proposal is a draft, its
            // confirm/execute stays the existing flow (no second write path).
            ProposalCard(proposal: ActionProposal.fromJson(result.proposal!))
          else
            Text(
              // T16: the server's own Vietnamese copy for STALE_HANDOFF and
              // every other refusal — shown verbatim, never rewritten.
              result.reason ?? 'Không lập được phiếu thu. Vui lòng thử lại.',
              key: const ValueKey('collect-propose-refusal'),
              style: Theme.of(context)
                  .textTheme
                  .bodyMedium
                  ?.copyWith(color: Theme.of(context).colorScheme.error),
            ),
        ],
        if (ui.lastError != null)
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.sm),
            child: Text(
              ui.lastError!,
              style: Theme.of(context)
                  .textTheme
                  .bodySmall
                  ?.copyWith(color: Theme.of(context).colorScheme.error),
            ),
          ),
      ],
    );
  }
}
