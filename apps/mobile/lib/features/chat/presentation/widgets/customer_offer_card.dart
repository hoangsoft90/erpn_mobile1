import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../../../app/providers.dart';
import '../../../../app/theme/app_theme.dart';
import '../../data/chat_models.dart';

/// M1 — the create-customer OFFER card (`.plan/next3/M1-customer-create-button.md`
/// §4.3/§4.4).
///
/// Why this card exists separately from [ProposalCard]: on the NO_MATCH path
/// there is NO proposal to confirm. The server refused with MISSING_ENTITY (a
/// WRITE about a customer it could not find) and attached the STRUCTURED offer
/// `offer_create_customer` instead — that refusal is the moment the user needs a
/// way to create the missing customer. This widget is that way: a minimal form
/// (Tên * / SĐT / MST) plus the ONE button that may create a real record.
///
/// Safety shape, in order:
///
///  1. NOTHING happens until the user presses. No ERPNext read, no proposal —
///     the turn merely rendered a form.
///  2. The button ASKS the server for the proposal (`thêm khách <tên>`), so the
///     duplicate pre-check runs server-side (exact name / SĐT / MST / fuzzy) and
///     the name the user typed is the one that gets checked. A duplicate is an
///     ANSWER naming the existing customer — there is no card and no write.
///  3. Only a real proposal reaches `/execute`, through the SAME Safety Gateway
///     as every other write. The contact slots the user typed travel as params;
///     the executor re-reads the master list before writing and verifies the
///     created record afterwards.
///  4. The offer never picks a DocType and never auto-follows up: succeeding
///     prints the id and tells the user to say the next sentence (M1 policy §5 —
///     no auto Sales Order, no auto payment entry).
class CustomerOfferCard extends ConsumerStatefulWidget {
  const CustomerOfferCard({super.key, required this.offer});

  final CustomerCreateOffer offer;

  @override
  ConsumerState<CustomerOfferCard> createState() => _CustomerOfferCardState();
}

class _CustomerOfferCardState extends ConsumerState<CustomerOfferCard>
    with AutomaticKeepAliveClientMixin {
  /// Same rule as [ProposalCard]: keep the widget (and its outcome) alive only
  /// while it owns local state, so scrolling a finished offer away and back does
  /// not resurrect the button over a record that already exists.
  @override
  bool get wantKeepAlive => _submitting || _result != null || _error != null;

  late final TextEditingController _name =
      TextEditingController(text: widget.offer.name);
  late final TextEditingController _mobile =
      TextEditingController(text: widget.offer.mobileNo ?? '');
  late final TextEditingController _tax =
      TextEditingController(text: widget.offer.taxId ?? '');

  /// The idempotency key for THIS offer instance. Created on first use and kept
  /// for every later press, so an error-then-retry cannot create two customers
  /// (the server replays the first result instead). A fresh widget instance gets
  /// a fresh key, which is correct: nothing was written before the first press.
  final String _commandId = newUuidV4();

  bool _submitting = false;
  String? _result;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    _mobile.dispose();
    _tax.dispose();
    super.dispose();
  }

  /// The name as the server will see it: collapsed spaces, trimmed. A name that
  /// is empty after this is not creatable (the skill refuses CC_NAME_MISSING, and
  /// the button is disabled anyway).
  String get _cleanName =>
      _name.text.replaceAll(RegExp(r'\s+'), ' ').trim();

  Future<void> _create() async {
    final name = _cleanName;
    if (_submitting || name.isEmpty) return;
    setState(() {
      _submitting = true;
      _result = null;
      _error = null;
    });
    final client = ref.read(copilotApiClientProvider);
    try {
      // 1. Let the SERVER build the proposal: it owns the business-key
      //    pre-check, so a name that already exists comes back as an answer (not
      //    as a card), and the client never authors a proposal itself.
      final asked = await client.ask('thêm khách $name');
      if (!mounted) return;
      final proposal = asked.proposal;
      if (proposal == null) {
        // A refusal is an ANSWER (`answer`), a failed route a `reason`.
        setState(
          () => _error =
              asked.answer ?? asked.reason ?? 'Không tạo được đề xuất thêm khách.',
        );
        return;
      }

      // 2. Execute through the same door as every other write. The typed contact
      //    slots override the proposal's params (the proposal only knows the
      //    name, which is all a spoken command carries); the name is IDENTICAL to
      //    what the server just checked, so the proposal's entity id — and its
      //    idempotency fingerprint — still describe this intent.
      client.applySettings();
      final payload = Map<String, dynamic>.from(proposal.toJson());
      payload['params'] = <String, dynamic>{
        'customer_name': name,
        if (_mobile.text.trim().isNotEmpty) 'mobile_no': _mobile.text.trim(),
        if (_tax.text.trim().isNotEmpty) 'tax_id': _tax.text.trim(),
      };
      final res = await ref.read(dioProvider).post<Map<String, dynamic>>(
            '/execute',
            data: jsonEncode({'command_id': _commandId, 'proposal': payload}),
          );
      if (!mounted) return;
      final body = res.data ?? const {};
      if (body['ok'] == true) {
        final result = body['result'] as Map<String, dynamic>? ?? const {};
        setState(() => _result = _createdText(result, name));
      } else {
        setState(() => _error = '${body['error'] ?? 'xác nhận thất bại'}');
      }
    } on DioException catch (err) {
      // dio rejects non-2xx by default, so a gateway refusal (409 duplicate,
      // 503 lost response) arrives HERE, not in res.data. Spreading the whole
      // DioException into the message loses the server's own wording — the
      // retry test measured exactly that ("mạng chập chờn" never appeared).
      if (!mounted) return;
      final body = err.response?.data;
      final detail = body is Map<String, dynamic>
          ? (body['error'] ?? body['code'])
          : null;
      setState(
        () => _error =
            'Không gửi được lệnh xác nhận: ${detail ?? err.message ?? err}',
      );
    } catch (e) {
      // CopilotException carries the server's own Vietnamese wording (its
      // toString IS the message); anything else falls back to its text. Either
      // way the write did not happen — the button stays available for a retry
      // with the SAME command id.
      if (!mounted) return;
      setState(() => _error = 'Không gửi được lệnh xác nhận: $e');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }

  /// The outcome line. Master data has NO draft, so the wording must not borrow
  /// the draft language of the transaction documents — and it must say the
  /// follow-up is the user's next sentence, which is the M1 policy the card
  /// embodies (no auto order / payment).
  String _createdText(Map<String, dynamic> result, String fallbackName) {
    final doc = result['erpnext_doc'] ?? '?';
    final name = result['customer_name'] ?? fallbackName;
    return 'Đã tạo khách hàng: $name ($doc) — record THẬT, có thể bán/thu cho '
        'khách này (KHÔNG tự tạo đơn/phiếu thu)';
  }

  @override
  Widget build(BuildContext context) {
    super.build(context);
    final scheme = Theme.of(context).colorScheme;
    final canSubmit = !_submitting && _cleanName.isNotEmpty;

    return Container(
      margin: const EdgeInsets.only(top: AppSpacing.sm),
      padding: const EdgeInsets.all(AppSpacing.sm),
      decoration: BoxDecoration(
        color: scheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(12), // radius.md
        border: Border.all(color: scheme.outlineVariant),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          Text(
            'Khách này chưa có trên ERPNext. Tạo khách mới (record thật):',
            style: TextStyle(
              color: scheme.onSurface,
              fontWeight: FontWeight.w600,
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          // The contact pair is OPTIONAL (the contract requires the name only):
          // a walk-in may have neither at hand, and M1 policy §5 says "name +
          // at least one of {SĐT, MST}" — a warning the card shows rather than a
          // hard block, so the shop is never stuck at the counter.
          Text(
            'Nên có SĐT hoặc MST — thiếu cả hai thì sau này khó phân biệt khách trùng tên.',
            style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12),
          ),
          const SizedBox(height: AppSpacing.sm),
          TextField(
            controller: _name,
            // Rebuild so the button enables/disables with the field.
            onChanged: (_) => setState(() {}),
            textInputAction: TextInputAction.next,
            decoration: const InputDecoration(
              labelText: 'Tên khách *',
              isDense: true,
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          TextField(
            controller: _mobile,
            keyboardType: TextInputType.phone,
            decoration: const InputDecoration(
              labelText: 'Số điện thoại',
              isDense: true,
            ),
          ),
          const SizedBox(height: AppSpacing.xs),
          TextField(
            controller: _tax,
            keyboardType: TextInputType.text,
            decoration: const InputDecoration(
              labelText: 'Mã số thuế',
              isDense: true,
            ),
          ),
          const SizedBox(height: AppSpacing.sm),
          if (_result != null) ...[
            Text(
              '✅ $_result',
              style: TextStyle(
                color: scheme.primary,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: AppSpacing.xs),
            Text(
              'Nói tiếp để bán/thu, ví dụ: “thu tiền <tên> 200 nghìn”.',
              style: TextStyle(color: scheme.onSurfaceVariant, fontSize: 12),
            ),
          ] else ...[
            FilledButton.icon(
              // Disabled while the name is empty — the server would refuse
              // CC_NAME_MISSING, and offering the press would invite a call that
              // cannot succeed.
              onPressed: canSubmit ? _create : null,
              icon: _submitting
                  ? const SizedBox(
                      width: 14,
                      height: 14,
                      child: CircularProgressIndicator(strokeWidth: 2),
                    )
                  : const Icon(Icons.person_add_alt, size: 16),
              label: Text(_submitting ? 'Đang ghi...' : 'Tạo khách mới'),
            ),
            if (_error != null) ...[
              const SizedBox(height: AppSpacing.xs),
              Text(
                '⚠ $_error',
                style: TextStyle(color: scheme.error, fontSize: 12),
              ),
            ],
          ],
        ],
      ),
    );
  }
}
