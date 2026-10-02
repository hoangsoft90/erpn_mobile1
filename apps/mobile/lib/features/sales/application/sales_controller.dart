import 'package:flutter/foundation.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../collect/data/collect_models.dart';
import '../data/sales_models.dart';
import '../data/sales_repository.dart';

part 'sales_controller.g.dart';

/// next8 Phase 6 — the sales (bán hàng) screen's state and rules.
///
/// What this controller exists to enforce:
///  - The screen owns NO money authority: the totals shown are the SERVER's
///    own arithmetic from `/sales/propose` ([SalesUi.result].summary) — nothing
///    here computes a total, and the only "calculator" is the propose round
///    trip (spec `sales-screen`: "owns no money authority"; tasks §4: "không
///    parser tiền thứ hai trong Dart").
///  - Two discount layers travel APART all the way to the request:
///    [SalesLineValue.lineDiscount] (tầng 1, per line) vs [SalesUi.orderDiscount]
///    (tầng 2, order level) — folding them in Dart is falsify F1, mirrored
///    client-side.
///  - §6.1 ONE payment method: [SalesUi.method] is a single nullable value —
///    the type cannot even express a second simultaneous method; a pure credit
///    sale is method == null (the remainder is the SERVER's balance number).
///  - Changing the customer or the warehouse RESETS the lines and the money
///    already typed (spec scenario: two customers' data never mix).
///  - Stale-response guard: EVERY input mutation bumps [_epoch], and every
///    response carries the epoch it was issued under — a slow answer for an
///    earlier input is dropped and can never overwrite the current draft
///    (spec scenario: "a slow answer arrives after the input changed").
@riverpod
class SalesController extends _$SalesController {
  /// Monotonic token — bumped on every input mutation and on every propose
  /// request; responses carry the epoch they were issued under.
  int _epoch = 0;

  /// The epoch the CURRENT (latest) propose was issued under — lets a stale
  /// response know whether it still owns the in-flight spinner or a newer
  /// propose has started since.
  int _proposeEpoch = -1;

  @override
  SalesUi build(BusinessHandoff handoff) {
    // Sync on purpose: the customer comes from the TICKET (server-resolved),
    // so the screen has a well-defined initial state on frame one and no read
    // is needed before the first frame.
    final slot = handoff.slot('customer');
    final resolved = slot.isResolved && (slot.id ?? '').isNotEmpty;
    return SalesUi(
      customerId: resolved ? slot.id : null,
      customerName: slot.label,
      customerResolved: resolved,
    );
  }

  SalesRepository get _repo => ref.read(salesRepositoryProvider);

  int _bump() => ++_epoch;

  /// The USER names a different customer. Everything the previous customer's
  /// draft carried is discarded BEFORE the new customer is used (spec: the
  /// lines and the collection are cleared) — and the in-flight propose of the
  /// old draft dies with the epoch bump.
  void setCustomer(String? id) {
    final next = id?.trim();
    if (next == null || next.isEmpty || next == state.customerId) return;
    final epoch = _bump();
    state = SalesUi(
      epoch: epoch,
      draftGen: state.draftGen + 1, // reset: lines + money (spec scenario)
      customerId: next,
      customerName: next,
      customerResolved: true,
    );
  }

  /// The USER names a different warehouse. Same reset law as the customer:
  /// lines priced against one warehouse must not leak into another draft.
  void setWarehouse(String? warehouse) {
    final next = warehouse?.trim();
    if ((next ?? '') == (state.warehouse ?? '')) return;
    final epoch = _bump();
    state = state.copyWith(
      epoch: epoch,
      draftGen: state.draftGen + 1, // reset: lines + money
      warehouse: (next == null || next.isEmpty) ? null : next,
      items: [const SalesLineValue()],
      clearOrderDiscount: true,
      clearMethod: true,
      clearAmount: true,
      clearResult: true,
    );
  }

  // ── Lines ─────────────────────────────────────────────────────────────────

  /// Replaces one line (the editor's per-field onChanged). A mutation of any
  /// line invalidates the numbers on screen: the summary comes from the server
  /// and was computed for the OLD lines, so it is dropped here.
  void setLine(int index, SalesLineValue line) {
    if (index < 0 || index >= state.items.length) return;
    final items = List<SalesLineValue>.of(state.items)..[index] = line;
    state = state.copyWith(epoch: _bump(), items: items, clearResult: true);
  }

  void addLine() {
    final items = List<SalesLineValue>.of(state.items)..add(const SalesLineValue());
    state = state.copyWith(epoch: _bump(), items: items, clearResult: true);
  }

  void removeLine(int index) {
    if (index < 0 || index >= state.items.length) return;
    final items = List<SalesLineValue>.of(state.items)..removeAt(index);
    if (items.isEmpty) items.add(const SalesLineValue());
    state = state.copyWith(epoch: _bump(), items: items, clearResult: true);
  }

  // ── Discount (tầng 2 — order level) + method + amount ────────────────────

  void setOrderDiscount(int? value) => state = state.copyWith(
        epoch: _bump(),
        orderDiscount: value ?? 0,
        clearResult: true,
      );

  /// §6.1 — exactly one of the two channels, or none (a pure credit sale).
  /// There is no API for "both" because the type holds one value.
  void setMethod(String? method) =>
      state = state.copyWith(epoch: _bump(), method: method, clearMethod: method == null, clearResult: true);

  /// The amount the user typed for the method. Held as-is; the server
  /// re-validates it against ERPNext's own numbers at propose time.
  void setAmount(int? amount) =>
      state = state.copyWith(epoch: _bump(), amount: amount, clearResult: true);

  /// The lines the form may submit: every TOUCHED line must be complete
  /// (named item, named uom, positive qty). An untouched line is skipped.
  List<SalesLineValue> submittableLines(SalesUi ui) =>
      ui.items.where((l) => _touched(l)).toList(growable: false);

  bool _touched(SalesLineValue l) =>
      l.itemCode.trim().isNotEmpty || l.uom.trim().isNotEmpty || l.qty != null || l.lineDiscount > 0;

  /// Whether the propose button may fire. Mirrors the SERVER's rules so the
  /// user never sends a draft that must fail; the server re-decides everything.
  bool canPropose(SalesUi ui) {
    if ((ui.customerId ?? '').trim().isEmpty) return false;
    final lines = submittableLines(ui);
    if (lines.isEmpty) return false;
    if (!lines.every((l) => l.complete)) return false;
    // §6.1: a chosen method must carry a positive amount; no method = credit.
    if (ui.method != null && (ui.amount ?? 0) <= 0) return false;
    return true;
  }

  /// The ONE propose action: the filled form goes to `/sales/propose`, which
  /// answers with the ordinary proposal object (rendered by the existing
  /// [ProposalCard]) plus the SERVER's summary — or a refusal body shown
  /// verbatim. Guarded by [canPropose] AND an in-flight flag: one tap is one
  /// request. The final confirm stays the card's `/execute` flow (no second
  /// write path here).
  Future<SalesProposeResult?> propose() async {
    final ui = state;
    if (!canPropose(ui) || ui.proposing) return null;
    final epoch = _bump();
    _proposeEpoch = epoch;
    state = ui.copyWith(epoch: epoch, proposing: true, clearLastError: true, clearResult: true);
    try {
      final result = await _repo.propose(
        SalesProposalRequest(
          handoffId: handoff.handoffId,
          customerId: ui.customerId!.trim(),
          items: submittableLines(ui),
          warehouse: ui.warehouse,
          orderDiscountVnd: ui.orderDiscount,
          // §6.1: at most ONE method object; empty list = a credit sale.
          methods: ui.method == null
              ? const <CollectMethodValue>[]
              : <CollectMethodValue>[
                  CollectMethodValue(mode: ui.method!, amount: ui.amount ?? 0),
                ],
        ),
      );
      // The screen can be popped while the request is in flight (autoDispose)
      // and any input typed meanwhile makes THIS answer stale — both drop it.
      if (!ref.mounted || epoch != _epoch) {
        // Stale (or gone) — the RESULT is never rendered. The in-flight flag is
        // reset only when no NEWER propose has started (a newer one owns the
        // spinner now); otherwise the button would stay stuck on the spinner
        // forever after one dropped answer.
        if (ref.mounted && _proposeEpoch == epoch) {
          state = state.copyWith(proposing: false);
        }
        return result;
      }
      state = state.copyWith(proposing: false, result: result);
      return result;
    } catch (err) {
      if (!ref.mounted || epoch != _epoch) {
        if (ref.mounted && _proposeEpoch == epoch) {
          state = state.copyWith(proposing: false);
        }
        return null;
      }
      state = state.copyWith(proposing: false, lastError: '$err');
      return null;
    }
  }
}

/// The sales screen's view state. Money here is the USER's typing or the
/// SERVER's summary — none of it is computed client-side.
@immutable
class SalesUi {
  const SalesUi({
    this.epoch = 0,
    this.draftGen = 0,
    this.customerId,
    this.customerName,
    this.customerResolved,
    this.warehouse,
    this.items = const [SalesLineValue()],
    this.orderDiscount = 0,
    this.method,
    this.amount,
    this.proposing = false,
    this.result,
    this.lastError,
  });

  final int epoch;

  /// Bumped ONLY on a draft reset (customer/warehouse change): the screen puts
  /// it into every line editor's key, so a reset re-creates the fields empty
  /// (no stale text on screen) while ordinary typing keeps the same keys and
  /// the keyboard focus.
  final int draftGen;
  final String? customerId;
  final String? customerName;
  final bool? customerResolved;

  /// Omitted ⇒ the server uses its configured default warehouse and SAYS so.
  final String? warehouse;

  /// The goods lines (≥1 editable row is always kept on the form).
  final List<SalesLineValue> items;

  /// The ORDER-level discount (tầng 2) — kept apart from the lines' own
  /// `line_discount` (tầng 1) in the request and in every display.
  final int orderDiscount;

  /// §6.1: ONE method — 'cash' or 'bank_transfer'. Null = not chosen yet = a
  /// pure credit sale (the remainder is the SERVER's balance number).
  final String? method;

  /// The user-typed total for the method (the amount field's value).
  final int? amount;
  final bool proposing;
  final SalesProposeResult? result;
  final String? lastError;

  SalesUi copyWith({
    int? epoch,
    int? draftGen,
    String? customerId,
    String? customerName,
    bool? customerResolved,
    String? warehouse,
    bool clearWarehouse = false,
    List<SalesLineValue>? items,
    int? orderDiscount,
    bool clearOrderDiscount = false,
    String? method,
    bool clearMethod = false,
    int? amount,
    bool clearAmount = false,
    bool? proposing,
    SalesProposeResult? result,
    bool clearResult = false,
    String? lastError,
    bool clearLastError = false,
  }) {
    return SalesUi(
      epoch: epoch ?? this.epoch,
      draftGen: draftGen ?? this.draftGen,
      customerId: customerId ?? this.customerId,
      customerName: customerName ?? this.customerName,
      customerResolved: customerResolved ?? this.customerResolved,
      warehouse: clearWarehouse ? null : (warehouse ?? this.warehouse),
      items: items ?? this.items,
      orderDiscount: clearOrderDiscount ? 0 : (orderDiscount ?? this.orderDiscount),
      method: clearMethod ? null : (method ?? this.method),
      amount: clearAmount ? null : (amount ?? this.amount),
      proposing: proposing ?? this.proposing,
      result: clearResult ? null : (result ?? this.result),
      lastError: clearLastError ? null : (lastError ?? this.lastError),
    );
  }
}
