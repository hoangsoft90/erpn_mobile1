import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../app/theme/app_theme.dart';
import '../../../chat/data/chat_models.dart';
import '../../../chat/presentation/widgets/proposal_card.dart';
import '../../../collect/data/collect_models.dart' show BusinessHandoff;
import '../../../collect/presentation/widgets/payment_method_section.dart';
import '../../../sales/data/sales_models.dart' show SalesLineValue, SalesSummary;
import '../../../sales/presentation/widgets/item_line_editor.dart';
import '../../../sales/presentation/widgets/sales_summary.dart';
import '../../application/purchase_controller.dart';
import '../../data/purchase_models.dart';

/// next8 Phase 7 — the dedicated PURCHASE screen (phase-07 §5.3).
///
/// Four blocks, one propose: **NCC · Hàng hoá · Thanh toán/Công nợ · Tổng**.
/// The ONLY network action of the screen is `/purchase/propose` (the proposal
/// object is rendered by the existing [ProposalCard]; the final confirm stays
/// the existing card `/execute` flow — no second write path).
///
/// The handoff arrives from the route (`/purchase` extra). Without one the
/// screen REFUSES in Vietnamese (spec scenario) instead of inventing a ticket,
/// and without a RESOLVED supplier slot it asks to re-open from chat — the form
/// never improvises a party (HINT-NOT-AUTHORITY).
///
/// Reuse discipline (spec `purchase-screen`): the goods editor is the SHARED
/// [ItemLineEditor] (`showDiscount: false` — plan §14 has no purchase discount),
/// the total is the SHARED [SalesSummaryView] with PAY-direction labels, and
/// the payment block is the SHARED [PaymentMethodSection]. No widget is forked.
class PurchaseScreen extends ConsumerStatefulWidget {
  const PurchaseScreen({super.key, required this.handoff});

  final BusinessHandoff handoff;

  @override
  ConsumerState<PurchaseScreen> createState() => _PurchaseScreenState();
}

class _PurchaseScreenState extends ConsumerState<PurchaseScreen> {
  late PurchaseController _controller;

  @override
  void initState() {
    super.initState();
    _controller = ref.read(purchaseControllerProvider(widget.handoff).notifier);
  }

  @override
  Widget build(BuildContext context) {
    final ui = ref.watch(purchaseControllerProvider(widget.handoff));
    return Scaffold(
      appBar: AppBar(title: const Text('Nhập hàng')),
      body: SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(AppSpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _SupplierBlock(ui: ui, controller: _controller),
              const SizedBox(height: AppSpacing.lg),
              _ItemsBlock(ui: ui, controller: _controller),
              const SizedBox(height: AppSpacing.lg),
              _PaymentBlock(ui: ui, controller: _controller),
              const SizedBox(height: AppSpacing.lg),
              _TotalBlock(ui: ui, controller: _controller),
            ],
          ),
        ),
      ),
    );
  }
}

// ── NCC + kho ────────────────────────────────────────────────────────────────

class _SupplierBlock extends StatelessWidget {
  const _SupplierBlock({required this.ui, required this.controller});

  final PurchaseUi ui;
  final PurchaseController controller;

  @override
  Widget build(BuildContext context) {
    final resolved = ui.supplierResolved == true && (ui.supplierId ?? '').trim().isNotEmpty;
    return Column(
      key: const ValueKey('purchase-supplier-block'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Nhà cung cấp', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        if (resolved)
          Text(
            ui.supplierName ?? ui.supplierId!,
            key: const ValueKey('purchase-supplier-name'),
            style: Theme.of(context).textTheme.bodyLarge,
          )
        else
          Text(
            'Chưa xác định được nhà cung cấp — quay lại chat để nói rõ tên NCC trước khi nhập hàng.',
            key: const ValueKey('purchase-supplier-missing'),
            style: Theme.of(context).textTheme.bodyMedium,
          ),
        const SizedBox(height: AppSpacing.sm),
        TextField(
          key: const ValueKey('purchase-warehouse'),
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

  final PurchaseUi ui;
  final PurchaseController controller;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const ValueKey('purchase-items-block'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text('Hàng hoá', style: Theme.of(context).textTheme.titleMedium),
            TextButton.icon(
              key: const ValueKey('purchase-add-line'),
              onPressed: controller.addLine,
              icon: const Icon(Icons.add),
              label: const Text('Thêm dòng'),
            ),
          ],
        ),
        const SizedBox(height: AppSpacing.sm),
        for (var i = 0; i < ui.items.length; i++)
          // The SHARED editor, with the sales-only discount field hidden
          // (plan §14: a purchase has no discount).
          ItemLineEditor(
            key: ValueKey('purchase-line-${ui.draftGen}-$i'),
            index: i,
            showDiscount: false,
            line: SalesLineValue(
              itemCode: ui.items[i].itemCode,
              uom: ui.items[i].uom,
              qty: ui.items[i].qty,
            ),
            onChanged: (l) => controller.setLine(
              i,
              PurchaseLineValue(itemCode: l.itemCode, uom: l.uom, qty: l.qty),
            ),
            onRemove: ui.items.length > 1 ? () => controller.removeLine(i) : null,
          ),
      ],
    );
  }
}

// ── Thanh toán / Công nợ ─────────────────────────────────────────────────────

class _PaymentBlock extends StatelessWidget {
  const _PaymentBlock({required this.ui, required this.controller});

  final PurchaseUi ui;
  final PurchaseController controller;

  @override
  Widget build(BuildContext context) {
    return Column(
      key: const ValueKey('purchase-payment-block'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Thanh toán & công nợ', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        // §6.1 — ONE method (or none = ghi công nợ). The typed amount travels
        // to the server as a REQUEST; the account is resolved server-side (§6.2).
        PaymentMethodSection(method: ui.method, onChanged: controller.setMethod),
        if (ui.method != null) ...[
          const SizedBox(height: AppSpacing.sm),
          TextField(
            key: const ValueKey('purchase-amount'),
            keyboardType: TextInputType.number,
            decoration: const InputDecoration(
              labelText: 'Số tiền trả NCC ngay (VND)',
              hintText: 'Ví dụ 500000 — phần còn lại là công nợ NCC',
            ),
            onChanged: (raw) =>
                controller.setAmount(int.tryParse(raw.replaceAll(RegExp(r'[^0-9]'), ''))),
          ),
        ],
      ],
    );
  }
}

// ── Tổng + propose ───────────────────────────────────────────────────────────

class _TotalBlock extends ConsumerWidget {
  const _TotalBlock({required this.ui, required this.controller});

  final PurchaseUi ui;
  final PurchaseController controller;

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final result = ui.result;
    final summary = result?.summary;
    final canPropose = controller.canPropose(ui);
    return Column(
      key: const ValueKey('purchase-total-block'),
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text('Tổng', style: Theme.of(context).textTheme.titleMedium),
        const SizedBox(height: AppSpacing.sm),
        if (summary != null && result!.ok)
          // The SHARED summary, with the PAY-direction labels: the payable is
          // shown as "Còn nợ NCC", NEVER as a "credit method" (spec scenario).
          SalesSummaryView(
            summary: SalesSummary(
              subtotalVnd: summary.subtotalVnd,
              totalVnd: summary.totalVnd,
              collectedVnd: summary.paidVnd,
              outstandingAfterVnd: summary.outstandingAfterVnd,
            ),
            collectedLabel: 'Đã trả NCC',
            outstandingLabel: 'Còn nợ NCC',
          )
        else
          Text(
            'Nhấn “Lập đề xuất” để máy chủ tính tổng từ ERPNext (giá MUA, thuế) — màn hình không tự cộng tiền.',
            key: const ValueKey('purchase-summary-hint'),
            style: Theme.of(context).textTheme.bodySmall,
          ),
        const SizedBox(height: AppSpacing.md),
        SizedBox(
          width: double.infinity,
          child: FilledButton(
            key: const ValueKey('purchase-propose'),
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
            ProposalCard(proposal: ActionProposal.fromJson(result.proposal!))
          else
            Text(
              result.reason ?? 'Không lập được phiếu nhập. Vui lòng thử lại.',
              key: const ValueKey('purchase-propose-refusal'),
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
              key: ValueKey('purchase-warning-${result!.warnings.indexOf(w)}'),
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
