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

  Future<void> save(List<ChatTurn> turns) async {
    final prefs = _prefs;
    if (prefs == null) return;
    try {
      final encoded = jsonEncode(
        turns.map((t) => t.toJson()).toList(),
      );
      await prefs.setString(AppConstants.chatHistoryStorageKey, encoded);
    } catch (_) {
      // storage full / platform error — silently keep in-memory history
    }
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
