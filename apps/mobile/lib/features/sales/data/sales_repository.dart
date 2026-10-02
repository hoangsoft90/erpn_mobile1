import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../app/providers.dart';
import '../../chat/data/copilot_api_client.dart';
import 'sales_models.dart';

part 'sales_repository.g.dart';

/// next8 Phase 6 — the SALES feature's PROPOSE surface, the collect
/// repository's twin. Deliberately boring: forwards to the client's
/// `proposeSales` (the `/sales/propose` route) and nothing else. The server
/// re-reads ERPNext and re-validates every value, so this layer holds no
/// authority; and there is NO method here that can write — `/execute` stays
/// the existing ProposalCard flow (phase-02 §3).
@riverpod
SalesRepository salesRepository(Ref ref) =>
    SalesRepository(client: ref.watch(copilotApiClientProvider));

class SalesRepository {
  const SalesRepository({required this.client});

  final CopilotApiClient client;

  /// The ONE confirm action: the filled form goes to `/sales/propose`, which
  /// answers with the ordinary proposal object or a refusal body (`ok:false` +
  /// machine `code` + Vietnamese `reason`).
  Future<SalesProposeResult> propose(SalesProposalRequest request) =>
      client.proposeSales(request);
}
