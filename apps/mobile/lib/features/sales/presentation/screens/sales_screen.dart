import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../app/theme/app_theme.dart';
import '../../../chat/data/chat_models.dart';
import '../../../chat/presentation/widgets/proposal_card.dart';
import '../../../collect/data/collect_models.dart' show BusinessHandoff;
import '../../../collect/presentation/widgets/payment_method_section.dart';
import '../../application/sales_controller.dart';
import '../widgets/item_line_editor.dart';
import '../widgets/sales_summary.dart';

/// next8 Phase 6 — the dedicated SALES screen (phase-06 §5.4).
///
/// Four blocks, one propose: **Khách · Hàng hoá · Chiết khấu · Thu tiền/Tổng**.
/// The ONLY network action of the screen is `/sales/propose` (the proposal
/// object is rendered by the existing [ProposalCard]; the final confirm stays
/// the existing card `/execute` flow — no second write path).
///
/// The handoff arrives from the route (`/sales` extra). Without one the screen
/// REFUSES in Vietnamese (spec scenario) instead of inventing a ticket, and
/// without a RESOLVED customer slot it asks to re-open from chat — the form
/// never improvises a party (HINT-NOT-AUTHORITY).
class SalesScreen extends ConsumerStatefulWidget {
  const SalesScreen({super.key, required this.handoff});

  final BusinessHandoff handoff;

  @override
  ConsumerState<SalesScreen> createState() => _SalesScreenState();
}

class _SalesScreenState extends ConsumerState<SalesScreen> {
  late SalesController _controller;

  @override
  void initState() {
    super.initState();
    _controller = ref.read(salesControllerProvider(widget.handoff).notifier);
  }

  @override
  Widget build(BuildContext context) {
    final ui = ref.watch(salesControllerProvider(widget.handoff));
    return Scaffold(
      appBar: AppBar(title: const Text('Bán hàng')),
      // A SingleChildScrollView + Column, not a ListView: the form has FOUR
      // fixed blocks — every block stays BUILT so its state and its error copy
      // render even below the fold (same law as the collect screen).
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _CustomerBlock(ui: ui, controller: _controller),
              const SizedBox(height: AppSpacing.lg),
              _ItemsBlock(ui: ui, controller: _controller),
              const SizedBox(height: AppSpacing.lg),
              _DiscountBlock(ui: ui, controller: _controller),
              const SizedBox(height: AppSpacing.lg),
              _TotalBlock(ui: ui, controller: _controller),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Khách + kho ──────────────────────────────────────────────────────────────

class _CustomerBlock extends StatelessWidget {
  const _CustomerBlock({required this.ui, required this.controller});

  final SalesUi ui;
  final SalesController controller;

  @override
  Widget build(BuildContext context) {
    final resolved = ui.customerResolved == true && (ui.customerId ?? '').trim().isNotEmpty;
    return Column(
      key: const ValueKey('sales-customer-block'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Khách', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        if (resolved)
          Text(
            ui.customerName ?? ui.customerId!,
            key: const ValueKey('sales-customer-name'),
            style: Theme.of(context).textTheme.bodyLarge,
          )
        else
          Text(
            'Chưa xác định được khách — quay lại chat để nói rõ tên khách trước khi bán.',
            key: const ValueKey('sales-customer-missing'),
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        const SizedBox(height: AppSpacing.sm),
        TextField(
          key: const ValueKey('sales-warehouse'),
          decoration: const InputDecoration(
            labelText: 'Kho (để trống = kho mặc định của cửa hàng)',
            hintText: 'Kho Cám - MP',
          ),
          onChanged: controller.setWarehouse,
        ),
      ],
    );
  }
}

// ── Hàng hoá ─────────────────────────────────────────────────────────────────

class _ItemsBlock extends StatelessWidget {
  const _ItemsBlock({required this.ui, required this.controller});

  final SalesUi ui;
  final SalesController controller;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const ValueKey('sales-items-block'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('Hàng hoá', style: Theme.of(context).textTheme.titleMedium),
            TextButton.icon(
              key: const ValueKey('sales-add-line'),
              onPressed: controller.addLine,
              icon: const Icon(Icons.add),
              label: const Text('Thêm dòng'),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        for (var i = 0; i < ui.items.length; i++)
          ItemLineEditor(
            key: ValueKey('sales-line-${ui.draftGen}-$i'),
            index: i,
            line: ui.items[i],
            onChanged: (l) => controller.setLine(i, l),
            onRemove: ui.items.length > 1 ? () => controller.removeLine(i) : null,
          ),
      ],
    );
  }
}

// ── Chiết khấu (tầng 2 — khác bảng với CK dòng) ─────────────────────────────

class _DiscountBlock extends StatelessWidget {
  const _DiscountBlock({required this.ui, required this.controller});

  final SalesUi ui;
  final SalesController controller;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const ValueKey('sales-discount-block'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Chiết khấu toàn đơn', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.xs),
        Text(
          // The two layers stay VISIBLY separate on the form (spec: "visibly
          // separate from the line level") — the per-line discount lives in
          // each line editor above, never in this field.
          'Áp dụng một lần trên tổng đơn — khác với chiết khấu từng dòng ở khối Hàng hoá.',
          key: const ValueKey('sales-discount-note'),
          style: Theme.of(context).textTheme.bodySmall,
        ),
        const SizedBox(height: AppSpacing.sm),
        TextField(
          key: const ValueKey('sales-order-discount'),
          keyboardType: TextInputType.number,
          decoration: const InputDecoration(
            labelText: 'Số tiền chiết khấu toàn đơn (VND)',
            hintText: 'Ví dụ 200000 — để trống nếu không chiết khấu',
          ),
          onChanged: (raw) =>
              controller.setOrderDiscount(int.tryParse(raw.replaceAll(RegExp(r'[^0-9]'), ''))),
        ),
      ],
    );
  }
}

// ── Thu tiền + Tổng + propose ────────────────────────────────────────────────

class _TotalBlock extends ConsumerWidget {
  const _TotalBlock({required this.ui, required this.controller});

  final SalesUi ui;
  final SalesController controller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final result = ui.result;
    final summary = result?.summary;
    final canPropose = controller.canPropose(ui);
    return Column(
      key: const ValueKey('sales-total-block'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Thu tiền', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        // §6.1 — ONE method (or none = bán chịu). The typed amount travels to
        // the server as a REQUEST; the account is resolved server-side (§6.2).
        PaymentMethodSection(method: ui.method, onChanged: controller.setMethod),
        if (ui.method != null) ...[
          const SizedBox(height: AppSpacing.sm),
          TextField(
            key: const ValueKey('sales-amount'),
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'Số tiền thu ngay (VND)',
              hintText: 'Ví dụ 500000 — phần còn lại thành công nợ',
            ),
            onChanged: (raw) =>
                controller.setAmount(int.tryParse(raw.replaceAll(RegExp(r'[^0-9]'), ''))),
          ),
        ],
        const SizedBox(height: AppSpacing.md),
        Text('Tổng', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        if (summary != null && result!.ok)
          SalesSummaryView(summary: summary)
        else
          Text(
            'Nhấn “Lập đề xuất” để máy chủ tính tổng từ ERPNext (giá, thuế, chiết khấu) — màn hình không tự cộng tiền.',
            key: const ValueKey('sales-summary-hint'),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        const SizedBox(height: AppSpacing.md),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            key: const ValueKey('sales-propose'),
            onPressed: canPropose && !ui.proposing ? () => controller.propose() : null,
            child: ui.proposing
                ? const SizedBox(
                    height: 18,
                    width: 18,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                : const Text('Lập đề xuất'),
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
              // The server's own Vietnamese copy (STALE_HANDOFF,
              // SALES_PRICE_MISSING, …) — shown verbatim, never rewritten.
              result.reason ?? 'Không lập được hoá đơn bán. Vui lòng thử lại.',
              key: const ValueKey('sales-propose-refusal'),
              style: Theme.of(context)
                  .textTheme
                  .bodyMedium
                  ?.copyWith(color: Theme.of(context).colorScheme.error),
            ),
        ],
        for (final w in result?.warnings ?? const <String>[])
          Padding(
            padding: const EdgeInsets.only(top: AppSpacing.xs),
            child: Text(
              w,
              key: ValueKey('sales-warning-${result!.warnings.indexOf(w)}'),
              style: Theme.of(context).textTheme.bodySmall,
            ),
          ),
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
