import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:shared_preferences/shared_preferences.dart';

import '../../../core/constants/app_constants.dart';

/// The last day summary this phone managed to read, with the instant it was
/// taken.
///
/// The drawer is opened in a shop, on a phone, often on a bad connection, and
/// the plan asks for TWO different things (plan4_final §2 + §6):
///   * a 30–60s freshness window — re-opening the drawer inside it must NOT
///     spend another ERP aggregate (pull-to-refresh is the explicit override);
///   * an offline state that still shows the last known numbers, clearly
///     labelled as old, instead of an empty screen.
@immutable
class CachedSummary {
  const CachedSummary({required this.rawJson, required this.fetchedAt});

  /// The response body EXACTLY as it arrived — replayed through the same parser
  /// as a live response, so a cached day cannot be rendered by different rules.
  final String rawJson;

  /// When the server assembled it, in UTC (see [DailySummaryMeta.generatedAt] is
  /// the SERVER's stamp; this is when this device received it).
  final DateTime fetchedAt;

  bool isFresh(Duration window) =>
      DateTime.now().toUtc().difference(fetchedAt) < window;
}

/// Persisted cache for the day summary, under a versioned key, in the SAME
/// SharedPreferences instance as the chat history.
///
/// Fail-safe contract, mirroring [ChatHistoryService]/[AppSettingsService]: a
/// null prefs (bootstrap failure) or a platform error NEVER crashes the app —
/// reads return null, writes are swallowed. A cache is a convenience; the
/// numbers are still read from ERPNext.
class DailySummaryCache {
  // ignore: prefer_initializing_formals — named param `prefs` stays public API
  DailySummaryCache({required SharedPreferences? prefs}) : _prefs = prefs;

  final SharedPreferences? _prefs;

  Future<CachedSummary?> read() async {
    final prefs = _prefs;
    if (prefs == null) return null;
    try {
      final raw = prefs.getString(AppConstants.dailySummaryCacheStorageKey);
      if (raw == null || raw.isEmpty) return null;
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return null;
      final body = decoded['body'];
      final at = DateTime.tryParse('${decoded['fetched_at']}');
      // Either half missing ⇒ unusable: a body with no timestamp cannot be
      // labelled "dữ liệu cũ", and a timestamp with no body is nothing to show.
      if (body is! String || body.isEmpty || at == null) return null;
      return CachedSummary(rawJson: body, fetchedAt: at.toUtc());
    } catch (_) {
      return null; // corrupt/legacy data — behave like "no cache"
    }
  }

  Future<void> write(String rawJson, {DateTime? at}) async {
    final prefs = _prefs;
    if (prefs == null || rawJson.isEmpty) return;
    try {
      await prefs.setString(
        AppConstants.dailySummaryCacheStorageKey,
        jsonEncode({
          'fetched_at': (at ?? DateTime.now()).toUtc().toIso8601String(),
          'body': rawJson,
        }),
      );
    } catch (_) {
      // storage full / platform error — the screen keeps its in-memory copy
    }
  }

  Future<void> clear() async {
    final prefs = _prefs;
    if (prefs == null) return;
    try {
      await prefs.remove(AppConstants.dailySummaryCacheStorageKey);
    } catch (_) {
      // ignore — the next write rewrites the key anyway
    }
  }
}
