import 'package:flutter/foundation.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../collect/data/collect_models.dart';
import '../data/purchase_models.dart';
import '../data/purchase_repository.dart';

part 'purchase_controller.g.dart';

/// next8 Phase 7 — the purchase (nhập hàng) screen's state and rules.
///
/// What this controller exists to enforce:
///  - The screen owns NO money authority: the totals shown are the SERVER's own
///    arithmetic from `/purchase/propose` ([PurchaseUi.result].summary) —
///    nothing here computes a total (spec `purchase-screen`: "owns no money
///    authority").
///  - §6.1 ONE payment method: [PurchaseUi.method] is a single nullable value —
///    the type cannot express a second simultaneous method; a pure credit
///    purchase is method == null (the remainder is the SERVER's balance number,
///    never a "credit method").
///  - Changing the supplier or the warehouse RESETS the lines and the money
///    already typed (spec scenario: two suppliers' data never mix).
///  - Stale-response guard: EVERY input mutation bumps [_epoch], and every
///    response carries the epoch it was issued under — a slow answer for an
///    earlier input is dropped and can never overwrite the current draft.
@riverpod
class PurchaseController extends _$PurchaseController {
  /// Monotonic token — bumped on every input mutation and on every propose.
  int _epoch = 0;
  int _proposeEpoch = -1;

  @override
  PurchaseUi build(BusinessHandoff handoff) {
    // Sync on purpose: the supplier comes from the TICKET (server-resolved),
    // so the screen has a well-defined initial state on frame one.
    final slot = handoff.slot('supplier');
    final resolved = slot.isResolved && (slot.id ?? '').isNotEmpty;
    return PurchaseUi(
      supplierId: resolved ? slot.id : null,
      supplierName: slot.label,
      supplierResolved: resolved,
    );
  }

  PurchaseRepository get _repo => ref.read(purchaseRepositoryProvider);

  int _bump() => ++_epoch;

  /// The USER names a different supplier. Everything the previous supplier's
  /// draft carried is discarded BEFORE the new supplier is used (spec scenario:
  /// the lines and the payment are cleared).
  void setSupplier(String? id, {String? name}) {
    final next = id?.trim();
    if (next == null || next.isEmpty || next == state.supplierId) return;
    final epoch = _bump();
    state = PurchaseUi(
      epoch: epoch,
      draftGen: state.draftGen + 1, // reset: lines + money (spec scenario)
      supplierId: next,
      supplierName: name ?? next,
      supplierResolved: true,
    );
  }

  /// The USER names a different warehouse. Same reset law as the supplier.
  void setWarehouse(String? warehouse) {
    final next = warehouse?.trim();
    if ((next ?? '') == (state.warehouse ?? '')) return;
    final epoch = _bump();
    state = state.copyWith(
      epoch: epoch,
      draftGen: state.draftGen + 1, // reset: lines + money
      warehouse: (next == null || next.isEmpty) ? null : next,
      items: [const PurchaseLineValue()],
      clearMethod: true,
      clearAmount: true,
      clearResult: true,
    );
  }

  // ── Lines ─────────────────────────────────────────────────────────────────

  void setLine(int index, PurchaseLineValue line) {
    if (index < 0 || index >= state.items.length) return;
    final items = List<PurchaseLineValue>.of(state.items)..[index] = line;
    state = state.copyWith(epoch: _bump(), items: items, clearResult: true);
  }

  void addLine() {
    final items = List<PurchaseLineValue>.of(state.items)..add(const PurchaseLineValue());
    state = state.copyWith(epoch: _bump(), items: items, clearResult: true);
  }

  void removeLine(int index) {
    if (index < 0 || index >= state.items.length) return;
    final items = List<PurchaseLineValue>.of(state.items)..removeAt(index);
    if (items.isEmpty) items.add(const PurchaseLineValue());
    state = state.copyWith(epoch: _bump(), items: items, clearResult: true);
  }

  // ── Method + amount ──────────────────────────────────────────────────────

  /// §6.1 — exactly one of the two channels, or none (a pure credit purchase).
  /// There is no API for "both" because the type holds one value.
  void setMethod(String? method) =>
      state = state.copyWith(epoch: _bump(), method: method, clearMethod: method == null, clearResult: true);

  void setAmount(int? amount) => state = state.copyWith(epoch: _bump(), amount: amount, clearResult: true);

  /// The lines the form may submit: every TOUCHED line must be complete.
  List<PurchaseLineValue> submittableLines(PurchaseUi ui) =>
      ui.items.where(_touched).toList(growable: false);

  bool _touched(PurchaseLineValue l) =>
      l.itemCode.trim().isNotEmpty || l.uom.trim().isNotEmpty || l.qty != null;

  /// Whether the propose button may fire. Mirrors the SERVER's rules so the
  /// user never sends a draft that must fail; the server re-decides everything.
  bool canPropose(PurchaseUi ui) {
    if ((ui.supplierId ?? '').trim().isEmpty) return false;
    final lines = submittableLines(ui);
    if (lines.isEmpty) return false;
    if (!lines.every((l) => l.complete)) return false;
    if (ui.method != null && (ui.amount ?? 0) <= 0) return false;
    return true;
  }

  /// The ONE propose action: the filled form goes to `/purchase/propose`, which
  /// answers with the ordinary proposal object (rendered by the existing
  /// [ProposalCard]) plus the SERVER's summary — or a refusal body shown
  /// verbatim. Guarded by [canPropose] AND an in-flight flag: one tap is one
  /// request. The final confirm stays the card's `/execute` flow.
  Future<PurchaseProposeResult?> propose() async {
    final ui = state;
    if (!canPropose(ui) || ui.proposing) return null;
    final epoch = _bump();
    _proposeEpoch = epoch;
    state = ui.copyWith(epoch: epoch, proposing: true, clearLastError: true, clearResult: true);
    try {
      final result = await _repo.propose(
        PurchaseProposalRequest(
          handoffId: handoff.handoffId,
          supplierId: ui.supplierId!.trim(),
          items: submittableLines(ui),
          warehouse: ui.warehouse,
          methods: ui.method == null
              ? const <CollectMethodValue>[]
              : <CollectMethodValue>[CollectMethodValue(mode: ui.method!, amount: ui.amount ?? 0)],
        ),
      );
      if (!ref.mounted || epoch != _epoch) {
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

/// The purchase screen's view state. Money here is the USER's typing or the
/// SERVER's summary — none of it is computed client-side.
@immutable
class PurchaseUi {
  const PurchaseUi({
    this.epoch = 0,
    this.draftGen = 0,
    this.supplierId,
    this.supplierName,
    this.supplierResolved,
    this.warehouse,
    this.items = const [PurchaseLineValue()],
    this.method,
    this.amount,
    this.proposing = false,
    this.result,
    this.lastError,
  });

  final int epoch;

  /// Bumped ONLY on a draft reset (supplier/warehouse change): the screen puts
  /// it into every line editor's key, so a reset re-creates the fields empty.
  final int draftGen;
  final String? supplierId;
  final String? supplierName;
  final bool? supplierResolved;
  final String? warehouse;
  final List<PurchaseLineValue> items;

  /// §6.1: ONE method — 'cash' or 'bank_transfer'. Null = not chosen = a pure
  /// credit purchase (the remainder is the SERVER's balance number).
  final String? method;
  final int? amount;
  final bool proposing;
  final PurchaseProposeResult? result;
  final String? lastError;

  PurchaseUi copyWith({
    int? epoch,
    int? draftGen,
    String? supplierId,
    String? supplierName,
    bool? supplierResolved,
    String? warehouse,
    bool clearWarehouse = false,
    List<PurchaseLineValue>? items,
    String? method,
    bool clearMethod = false,
    int? amount,
    bool clearAmount = false,
    bool? proposing,
    PurchaseProposeResult? result,
    bool clearResult = false,
    String? lastError,
    bool clearLastError = false,
  }) {
    return PurchaseUi(
      epoch: epoch ?? this.epoch,
      draftGen: draftGen ?? this.draftGen,
      supplierId: supplierId ?? this.supplierId,
      supplierName: supplierName ?? this.supplierName,
      supplierResolved: supplierResolved ?? this.supplierResolved,
      warehouse: clearWarehouse ? null : (warehouse ?? this.warehouse),
      items: items ?? this.items,
      method: clearMethod ? null : (method ?? this.method),
      amount: clearAmount ? null : (amount ?? this.amount),
      proposing: proposing ?? this.proposing,
      result: clearResult ? null : (result ?? this.result),
      lastError: clearLastError ? null : (lastError ?? this.lastError),
    );
  }
}
