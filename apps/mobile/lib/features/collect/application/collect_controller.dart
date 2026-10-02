import 'dart:async';

import 'package:flutter/foundation.dart';
import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../data/collect_models.dart';
import '../data/collect_repository.dart';

part 'collect_controller.g.dart';

/// next8 Phase 2 — the collect (thu tiền) screen's state and rules.
///
/// The four owner locks this controller exists to enforce, and where:
///  - §6.1 ONE method per collection: [CollectUi.method] is a single nullable
///    value — the type cannot even express a second simultaneous method.
///  - §6.2 typed accounts only: [methodAccounts] filters by the channel's
///    `account_type`; an unresolved channel surfaces [CollectUi.accountBlocked]
///    instead of ever falling back to the other channel.
///  - §6.3 allocation policy: [canSubmit] blocks when open invoices exist and
///    nothing is allocated, allows the empty allocation ONLY when the server
///    said there are zero open invoices.
///  - §6.4 no silent truncation: the page plus the server's `matchedTotal`
///    travel together; the UI says "còn N kết quả" from the truth.
///
/// NO auto-allocation lives here (falsify F1): the controller never writes an
/// amount into an allocation. The only writer of an allocation is the user's
/// own input, prefill included, which is the outstanding value the SERVER sent.
///
/// Stale-response guard: every customer switch bumps [_epoch]; a response from
/// an older epoch is dropped, so a slow answer for the previous customer can
/// never overwrite the new one's list (tasks.md §2: "chống response cũ").
@riverpod
class CollectController extends _$CollectController {
  /// Monotonic token — bumped on every customer change; responses carry the
  /// epoch they were issued under.
  int _epoch = 0;

  @override
  CollectUi build(BusinessHandoff handoff) {
    // resolveCustomer kicks the only async chain off; build itself stays sync
    // so the screen has a well-defined initial state on frame one.
    return const CollectUi();
  }

  CollectRepository get _repo => ref.read(collectRepositoryProvider);

  /// Resolves the customer from the handoff and loads their open invoices +
  /// the company's money accounts. Called once when the screen opens.
  Future<void> resolveCustomer() async {
    final slot = handoff.slot('customer');
    final epoch = ++_epoch;

    if (!slot.isResolved || (slot.id ?? '').isEmpty) {
      // AMBIGUOUS / MISSING / NO_MATCH: the screen shows the handoff's own
      // state (its candidates when it has them). No read is issued for an id
      // the server did not resolve — a guessed id is exactly what the server
      // refuses at propose time.
      state = state.copyWith(
        epoch: epoch,
        invoicesLoading: false,
        invoices: const CollectOpenInvoicesPage(
          customerId: '',
          rows: [],
          matchedTotal: 0,
          truncated: false,
        ),
        customerName: slot.label,
        customerResolved: false,
        customerCandidates: slot.candidates,
        clearInvoicesError: true,
      );
      return;
    }

    state = state.copyWith(
      epoch: epoch,
      customerId: slot.id,
      customerName: slot.label,
      customerResolved: true,
      invoicesLoading: true,
      allocations: const {},
      clearInvoicesError: true,
    );

    try {
      final results = await Future.wait([
        _repo.fetchOpenInvoices(entityId: slot.id!, limit: 10),
        _repo.fetchAccounts(),
      ]);
      final page = results[0] as CollectOpenInvoicesPage;
      final accounts = results[1] as CollectAccountsData;
      // The screen can be popped while this read is in flight: an autoDispose
      // provider is gone by the time the answer lands, and writing `state`
      // then throws "Cannot use the Ref ... after it has been disposed".
      if (!ref.mounted || epoch != _epoch) return; // a newer customer took over — drop it
      state = state.copyWith(
        invoices: page,
        accounts: accounts,
        invoicesLoading: false,
        clearInvoicesError: true,
      );
    } catch (err) {
      if (!ref.mounted || epoch != _epoch) return;
      state = state.copyWith(
        invoicesLoading: false,
        invoicesError: err is Exception ? err.toString() : '$err',
      );
    }
  }

  /// §6.4 search — re-reads with the free-text query. The server filters after
  /// the full read, so `matchedTotal` stays the honest total.
  Future<void> search(String query) async {
    final id = state.customerId ?? '';
    if (id.isEmpty) return;
    final epoch = ++_epoch;
    state = state.copyWith(invoicesLoading: true, clearInvoicesError: true);
    try {
      final page = await _repo.fetchOpenInvoices(entityId: id, q: query, limit: 10);
      if (!ref.mounted || epoch != _epoch) return;
      state = state.copyWith(invoices: page, invoicesLoading: false);
    } catch (err) {
      if (!ref.mounted || epoch != _epoch) return;
      state = state.copyWith(invoicesLoading: false, invoicesError: '$err');
    }
  }

  /// The USER allocates an amount for one invoice. This is the only writer of
  /// an allocation (no auto-allocation, falsify F1).
  ///
  /// Out-of-range input is HELD, not silently corrected: [canSubmit] refuses
  /// the whole submit while any allocation is outside `0 < x ≤ outstanding`,
  /// and the tile shows the inline error — the user sees their own bad number
  /// instead of the form quietly rewriting it ("không tự sửa số của user").
  /// Ticking the checkbox pre-fills the SERVER's outstanding (the only value
  /// the controller ever writes on the user's behalf).
  void setAllocation(String invoiceId, int? amount, {required int outstandingVnd}) {
    final current = state;
    final next = Map<String, int>.of(current.allocations);
    if (amount == null) {
      next.remove(invoiceId);
    } else {
      next[invoiceId] = amount;
    }
    state = current.copyWith(allocations: next);
  }

  /// Clears ONE allocation (unticking an invoice).
  void clearAllocation(String invoiceId) {
    final current = state;
    final next = Map<String, int>.of(current.allocations)..remove(invoiceId);
    state = current.copyWith(allocations: next);
  }

  /// §6.1 — exactly one of the two channels, or none. There is no API for
  /// "both" because the type holds one value.
  void setMethod(String? method) {
    state = state.copyWith(method: method, account: _defaultAccountFor(method));
  }

  /// §6.2 — the user may pick any account OF THE METHOD'S OWN TYPE. An id that
  /// is not in the channel's list is refused (never silently accepted, never
  /// substituted).
  void setAccount(String? accountId) {
    final mode = state.method;
    if (mode == null) return;
    final ok = state.accounts.resolves(mode) &&
        state.accounts.forMode(mode).any((a) => a.account == accountId);
    if (!ok) return;
    state = state.copyWith(account: accountId);
  }

  String? _defaultAccountFor(String? method) {
    if (method == null) return null;
    final accounts = state.accounts;
    if (!accounts.resolves(method)) return null;
    final def = accounts.defaultFor(method);
    return def ?? accounts.forMode(method).first.account;
  }

  /// INVOICE_ALREADY_PAID (T13): the server says an invoice was settled
  /// elsewhere — drop every allocation and re-read, because the list the user
  /// was looking at is no longer the truth.
  Future<void> reloadAfterPaid() async {
    state = state.copyWith(allocations: const {});
    await search(state.searchQuery);
  }

  /// The ONE confirm action (phase-02 §5.1): build the request and post it.
  /// Guarded by [canSubmit] AND an in-flight flag (falsify F3) — a second tap
  /// while a request is running does nothing, so one tap is one request.
  Future<CollectProposeResult?> confirm() async {
    final ui = state;
    if (!canSubmit(ui) || ui.submitting) return null;
    state = ui.copyWith(submitting: true, clearResult: true, clearLastError: true);
    try {
      final result = await _repo.propose(
        CollectProposalRequest(
          handoffId: handoff.handoffId,
          customerId: ui.customerId ?? '',
          allocations: ui.allocations.entries
              .map((e) => CollectAllocationValue(invoiceId: e.key, allocatedAmount: e.value))
              .toList(growable: false),
          // §6.1: exactly ONE method object — the typed channel plus the total
          // the user typed, and the account only when one is selected.
          methods: [
            CollectMethodValue(
              mode: ui.method!,
              amount: paymentTotal(ui),
              accountId: ui.account,
            ),
          ],
          claimedTotalVnd: null,
        ),
      );
      if (!ref.mounted) return result;
      // T13: a settle race on the server is a DATA problem — reload, don't die.
      if (!result.ok && result.code == 'INVOICE_ALREADY_PAID') {
        await reloadAfterPaid();
        // The reload awaits its own read: the screen can go away during it,
        // exactly like the propose await guarded above.
        if (!ref.mounted) return result;
      }
      state = state.copyWith(submitting: false, result: result);
      return result;
    } catch (err) {
      if (!ref.mounted) return null;
      state = state.copyWith(submitting: false, lastError: '$err');
      return null;
    }
  }

  /// §6.4 search box state (kept here so the screen has no business logic).
  void setSearchQuery(String q) => state = state.copyWith(searchQuery: q);

  /// Σ allocations — the CLIENT's own arithmetic, used ONLY to compare against
  /// what the user typed into the method field and to render the summary. The
  /// number that is SUBMITTED is validated by the server against its own read;
  /// nothing here is authority (phase-02 §3).
  int allocatedTotal(CollectUi ui) =>
      ui.allocations.values.fold(0, (sum, v) => sum + v);

  /// The amount the user typed for the method. The screen passes it in per
  /// keystroke; the controller only holds it (parsing money text is the
  /// server's job at propose time — phase-02 §8: no second money parser).
  void setAmount(int? amount) => state = state.copyWith(amount: amount);

  int paymentTotal(CollectUi ui) => ui.amount ?? 0;

  /// Whether the confirm button may fire. Mirrors the SERVER's rules so the
  /// user never sends a draft that must fail; the server re-decides everything.
  bool canSubmit(CollectUi ui) {
    if (ui.customerResolved != true || (ui.customerId ?? '').isEmpty) return false;
    if (ui.method == null) return false;
    // §6.2: the channel must resolve to at least one correctly-typed account.
    if (!ui.accounts.resolves(ui.method!)) return false;
    if (paymentTotal(ui) <= 0) return false;
    // Every held allocation must be in range against the LIVE outstanding the
    // page carries (the server re-checks against ITS read at propose time).
    final outstandingById = {
      for (final r in ui.invoices.rows) r.id: r.outstandingVnd,
    };
    for (final e in ui.allocations.entries) {
      final out = outstandingById[e.key];
      if (out == null || e.value <= 0 || e.value > out) return false;
    }
    final open = ui.invoices.matchedTotal;
    if (open > 0) {
      // §6.3: with open invoices the allocation IS the payment.
      if (ui.allocations.isEmpty) return false;
      if (allocatedTotal(ui) != paymentTotal(ui)) return false;
      // Every allocated id must still be on the live page (the server re-checks
      // against the LIVE read; this only stops the obvious stale pick).
      final ids = ui.invoices.rows.map((r) => r.id).toSet();
      if (!ui.allocations.keys.every(ids.contains)) return false;
    } else {
      // §6.3: zero open invoices ⇒ the ONLY legal shape is an empty allocation
      // (on-account). A stale allocation against nothing must not submit.
      if (ui.allocations.isNotEmpty) return false;
    }
    return true;
  }
}

/// The collect screen's view state. Amounts here are the SERVER's (prefill,
/// page) or the user's own typing — none of them is submitted as authority.
@immutable
class CollectUi {
  const CollectUi({
    this.epoch = 0,
    this.customerId,
    this.customerName,
    this.customerResolved,
    this.customerCandidates = const <String>[],
    this.invoices = const CollectOpenInvoicesPage(
      customerId: '',
      rows: [],
      matchedTotal: 0,
      truncated: false,
    ),
    this.invoicesLoading = false,
    this.invoicesError,
    this.accounts = const CollectAccountsData(
      company: '',
      cash: [],
      bank: [],
      defaultCash: null,
      defaultBank: null,
    ),
    this.allocations = const {},
    this.method,
    this.account,
    this.accountBlocked = false,
    this.amount,
    this.searchQuery = '',
    this.submitting = false,
    this.result,
    this.lastError,
  });

  final int epoch;
  final String? customerId;
  final String? customerName;
  final bool? customerResolved;

  /// T4 — the ticket's own candidate labels for an AMBIGUOUS customer slot.
  /// Shown as chips; NEVER auto-picked (the server re-validates whoever the
  /// user settles on in chat).
  final List<String> customerCandidates;
  final CollectOpenInvoicesPage invoices;
  final bool invoicesLoading;
  final String? invoicesError;
  final CollectAccountsData accounts;
  final Map<String, int> allocations;

  /// §6.1: ONE method — 'cash' or 'bank_transfer'. Null = not chosen yet.
  final String? method;

  /// §6.2: the account the money lands in — always of the method's own type.
  final String? account;

  /// §6.2: true when the chosen channel has no account at all — the screen
  /// shows the block copy instead of offering the other channel.
  final bool accountBlocked;

  /// The user-typed total for the method (the amount field's value).
  final int? amount;
  final String searchQuery;
  final bool submitting;
  final CollectProposeResult? result;
  final String? lastError;

  CollectUi copyWith({
    int? epoch,
    String? customerId,
    String? customerName,
    bool? customerResolved,
    List<String>? customerCandidates,
    CollectOpenInvoicesPage? invoices,
    bool? invoicesLoading,
    String? invoicesError,
    bool clearInvoicesError = false,
    CollectAccountsData? accounts,
    Map<String, int>? allocations,
    String? method,
    bool clearMethod = false,
    String? account,
    bool? accountBlocked,
    int? amount,
    String? searchQuery,
    bool? submitting,
    CollectProposeResult? result,
    bool clearResult = false,
    String? lastError,
    bool clearLastError = false,
  }) {
    return CollectUi(
      epoch: epoch ?? this.epoch,
      customerId: customerId ?? this.customerId,
      customerName: customerName ?? this.customerName,
      customerResolved: customerResolved ?? this.customerResolved,
      customerCandidates: customerCandidates ?? this.customerCandidates,
      invoices: invoices ?? this.invoices,
      invoicesLoading: invoicesLoading ?? this.invoicesLoading,
      invoicesError: clearInvoicesError ? null : (invoicesError ?? this.invoicesError),
      accounts: accounts ?? this.accounts,
      allocations: allocations ?? this.allocations,
      method: clearMethod ? null : (method ?? this.method),
      account: account ?? this.account,
      accountBlocked: accountBlocked ?? this.accountBlocked,
      amount: amount ?? this.amount,
      searchQuery: searchQuery ?? this.searchQuery,
      submitting: submitting ?? this.submitting,
      result: clearResult ? null : (result ?? this.result),
      lastError: clearLastError ? null : (lastError ?? this.lastError),
    );
  }
}
