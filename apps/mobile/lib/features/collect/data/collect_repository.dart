import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../app/providers.dart';
import '../../chat/data/copilot_api_client.dart';
import 'collect_models.dart';

part 'collect_repository.g.dart';

/// next8 Phase 2 — the collect feature's READ + PROPOSE surface.
///
/// A thin, deliberately boring layer: every method forwards to the client's
/// own route method and nothing here derives, caches, or "improves" a value.
/// The split of duties:
///  - `fetchOpenInvoices` → `/read/list` (screen `customer_account`) — the
///    LIVE open invoices of ONE customer, company-scoped server-side (§6.4).
///  - `fetchAccounts` → `/collect/accounts` — the money accounts of the
///    company the SERVER resolved, typed Cash/Bank (§6.2's data half).
///  - `propose` → `/collect/propose` — the confirm step; the server re-reads
///    and re-validates everything, so this layer's reads are HINTS, never
///    authority.
///
/// There is no method here that can write: `/execute` is reached only through
/// the existing ProposalCard flow (phase-02 §3).
@riverpod
CollectRepository collectRepository(Ref ref) =>
    CollectRepository(client: ref.watch(copilotApiClientProvider));

class CollectRepository {
  const CollectRepository({required this.client});

  final CopilotApiClient client;

  /// The customer's open (unsettled) invoices, fresh from ERPNext.
  ///
  /// [q] narrows the VIEW (the server filters after a full read, so the total
  /// stays honest); [limit] stays inside the contract's 5–10 clamp.
  ///
  /// The parsed [ReadScreenData] is mapped (not re-parsed from raw JSON) so the
  /// collect layer and the A1 drill-down share ONE parser of `/read/list`.
  Future<CollectOpenInvoicesPage> fetchOpenInvoices({
    required String entityId,
    String? q,
    int? limit,
  }) async {
    final view = await client.readList(
      screen: 'customer_account',
      entityId: entityId,
      limit: limit,
      q: q,
    );
    // The parsed ReadScreenData is mapped (not re-parsed from raw JSON) so the
    // collect layer and the drill-down share ONE parser of `/read/list`.
    return CollectOpenInvoicesPage(
      customerId: view.entityId,
      company: view.company,
      outstandingVnd: view.outstandingVnd,
      rows: view.rows
          .map((r) => CollectOpenInvoice(
                id: r.name,
                outstandingVnd: r.outstandingVnd,
                date: r.date,
                totalVnd: r.totalVnd,
                isReturn: r.isReturn,
              ))
          .toList(growable: false),
      // An older gateway sends no matched_total; its read WAS the whole list
      // (cap 100), so the page length is the honest fallback there.
      matchedTotal: view.matchedTotal ?? view.rows.length,
      truncated: view.truncated,
    );
  }

  /// The resolved company's money accounts (Cash/Bank), with defaults.
  Future<CollectAccountsData> fetchAccounts() => client.collectAccounts();

  /// The ONE confirm action (phase-02 §5.1): the filled form goes to
  /// `/collect/propose`, which answers with the ordinary proposal object or a
  /// refusal body (`ok:false` + code + Vietnamese reason).
  Future<CollectProposeResult> propose(CollectProposalRequest request) =>
      client.proposeCollect(request);
}
