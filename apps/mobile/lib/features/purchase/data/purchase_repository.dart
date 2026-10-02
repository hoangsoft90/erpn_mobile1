import 'package:riverpod_annotation/riverpod_annotation.dart';

import '../../../app/providers.dart';
import '../../chat/data/copilot_api_client.dart';
import 'purchase_models.dart';

part 'purchase_repository.g.dart';

/// next8 Phase 7 — the PURCHASE feature's PROPOSE surface, the sales
/// repository's twin. Deliberately boring: forwards to the client's
/// `proposePurchase` (the `/purchase/propose` route) and nothing else. The
/// server re-reads ERPNext and re-validates every value, so this layer holds no
/// authority; and there is NO method here that can write — `/execute` stays the
/// existing ProposalCard flow.
@riverpod
PurchaseRepository purchaseRepository(Ref ref) =>
    PurchaseRepository(client: ref.watch(copilotApiClientProvider));

class PurchaseRepository {
  const PurchaseRepository({required this.client});

  final CopilotApiClient client;

  /// The ONE confirm action: the filled form goes to `/purchase/propose`, which
  /// answers with the ordinary proposal object or a refusal body (`ok:false` +
  /// machine `code` + Vietnamese `reason`).
  Future<PurchaseProposeResult> propose(PurchaseProposalRequest request) =>
      client.proposePurchase(request);
}
