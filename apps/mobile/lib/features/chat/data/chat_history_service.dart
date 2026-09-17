import 'dart:convert';

import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/constants/app_constants.dart';
import 'chat_models.dart';

/// Local chat history in SharedPreferences under a versioned key.
///
/// Fail-safe contract (tasks.md 2.4): storage problems NEVER crash the app —
/// load returns [] and save is swallowed (history is a convenience, not data
/// of record). SharedPreferences may be null (bootstrap failure) — same
/// behaviour.
class ChatHistoryService {
  // ignore: prefer_initializing_formals — named param `prefs` stays public API
  ChatHistoryService({required SharedPreferences? prefs}) : _prefs = prefs;

  final SharedPreferences? _prefs;

  Future<List<ChatTurn>> load() async {
    final prefs = _prefs;
    if (prefs == null) return const [];
    try {
      final raw = prefs.getString(AppConstants.chatHistoryStorageKey);
      if (raw == null || raw.isEmpty) return const [];
      final list = jsonDecode(raw) as List<dynamic>;
      return list
          .whereType<Map<String, dynamic>>()
          .map(ChatTurn.fromJson)
          .toList();
    } catch (_) {
      return const []; // corrupt/legacy data — start clean, never crash
    }
  }

  /// Persists [turns]. When [maxItems] is given, the OLDEST turns beyond that
  /// cap are dropped first — except pending proposals, which are never dropped
  /// (see [trimTurns]).
  Future<void> save(List<ChatTurn> turns, {int? maxItems}) async {
    final prefs = _prefs;
    if (prefs == null) return;
    try {
      final toStore =
          maxItems == null ? turns : trimTurns(turns, maxItems);
      final encoded = jsonEncode(
        toStore.map((t) => t.toJson()).toList(),
      );
      await prefs.setString(AppConstants.chatHistoryStorageKey, encoded);
    } catch (_) {
      // storage full / platform error — silently keep in-memory history
    }
  }

  /// Cap the history at [maxItems] turns, dropping the OLDEST first.
  ///
  /// SAFETY EXCEPTION (2026-09-16, B.2 — must have a test): a turn whose
  /// [ChatTurn.hasPendingProposal] is true is NEVER dropped, however old it is.
  /// A pending write intent must not disappear because the chat scrolled past
  /// the cap; only finished turns (plain reads, refused cards) are eligible.
  ///
  /// Pure function so both the in-memory state and storage apply the SAME
  /// rule, and so it is trivially testable without SharedPreferences.
  static List<ChatTurn> trimTurns(List<ChatTurn> turns, int maxItems) {
    if (maxItems <= 0 || turns.length <= maxItems) return turns;
    // Walk newest -> oldest, keeping the newest [maxItems] plus every pending
    // proposal anywhere in the list. Reversing restores chronological order.
    final kept = <ChatTurn>[];
    for (var i = turns.length - 1; i >= 0; i--) {
      final turn = turns[i];
      if (kept.length < maxItems || turn.hasPendingProposal) kept.add(turn);
    }
    return kept.reversed.toList(growable: false);
  }

  Future<void> clear() async {
    final prefs = _prefs;
    if (prefs == null) return;
    try {
      await prefs.remove(AppConstants.chatHistoryStorageKey);
    } catch (_) {
      // ignore — next save will rewrite the key anyway
    }
  }
}
