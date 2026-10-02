import 'package:flutter/foundation.dart';

/// P4-4 (plan4_final §4.4) — what a metric on "Tóm tắt ngày" opens.
///
/// The intent carries an ID from a CLOSED SET the server declared
/// (`drill_screens`), plus the title the server gave it. It never carries a
/// phrase: the drill screen must not be a second way to ask a question (the
/// summary screen's own numbers stay the only place those are computed).
@immutable
class DrillIntent {
  const DrillIntent({required this.drillId, required this.title, this.date});

  final String drillId;
  final String title;

  /// P4-6: the DAY the drill should read, when the user is viewing Hôm qua.
  /// Null = the server's "today at the shop" default (§3.7 — the client never
  /// picks today by its own clock). Only ever a date the SERVER itself named
  /// in a summary response — never one this phone computed for itself.
  final String? date;
}

/// One line of the summary block above the list.
///
/// [amountVnd] is null when the line is a COUNT ("Khách có nợ quá hạn", "Nháp
/// app hôm nay"): the server sends null rather than 0 so the screen cannot
/// print "0đ" for something that is not money.
@immutable
class DrillSummaryLine {
  const DrillSummaryLine({required this.label, this.amountVnd, this.count});

  final String label;
  final int? amountVnd;
  final int? count;
}

/// One row: a document or a customer the day's aggregate was computed from.
///
/// [note] comes from the SERVER, so a draft can never be labelled as a real
/// order by whoever renders it ("Đã ghi" vs "Nháp — chưa ghi sổ").
@immutable
class DrillRow {
  const DrillRow({
    required this.name,
    required this.amountVnd,
    this.date,
    this.note = '',
    this.kind = '',
  });

  final String name;
  final String? date;
  final int amountVnd;
  final String note;
  final String kind;
}

/// The payload of `/read/drill`.
///
/// [totalDocuments] vs `rows.length` is deliberate and mirrors A1: the page size
/// is contract policy (5–10), so the screen can say "hiện 5/12" instead of
/// implying the list is the whole day.
@immutable
class DrillScreenData {
  const DrillScreenData({
    required this.drillId,
    required this.title,
    required this.date,
    this.limit = 10,
    this.summaryLines = const <DrillSummaryLine>[],
    this.totalDocuments = 0,
    this.truncated = false,
    this.rows = const <DrillRow>[],
    this.erpTarget,
    this.footnote,
    this.draftHintCount,
    this.draftHintAmountVnd,
    this.partial = false,
    this.sectionsFailed = const <String>[],
    this.duplicatesDropped = 0,
    this.generatedAt,
  });

  factory DrillScreenData.fromJson(Map<String, dynamic> json) {
    final rawLines = json['summary_lines'];
    final rawRows = json['rows'];
    return DrillScreenData(
      drillId: json['drill'] as String? ?? '',
      title: json['title'] as String? ?? '',
      date: json['date'] as String? ?? '',
      limit: (json['limit'] as num?)?.toInt() ?? 10,
      // Tolerant parse (the result40 lesson): one bad element must not wipe the
      // whole screen, and a line without a label is dropped rather than shown
      // as an empty row.
      summaryLines: rawLines is List
          ? rawLines
              .whereType<Map<String, dynamic>>()
              .map(
                (l) => DrillSummaryLine(
                  label: l['label'] as String? ?? '',
                  amountVnd: (l['amount_vnd'] as num?)?.toInt(),
                  count: (l['count'] as num?)?.toInt(),
                ),
              )
              .where((l) => l.label.isNotEmpty)
              .toList(growable: false)
          : const <DrillSummaryLine>[],
      totalDocuments: (json['total_documents'] as num?)?.toInt() ?? 0,
      truncated: json['truncated'] == true,
      // `REAL` / `MOCK` from the server, or null when it did not say. The screen
      // forbids rendering figures for anything but `REAL` (§2.1) — an absent
      // value is therefore *unknown*, never "probably real".
      erpTarget: json['erp_target'] as String?,
      // D1 (§3.1) — the drawer's verbatim footnote and the OPTIONAL draft-PE
      // hint. The hint is decoration on top of GL-raw figures; the server sends
      // it only when it could read it, so absence means "nothing to say", never
      // "0 drafts".
      footnote: json['footnote'] as String?,
      draftHintCount: (json['draft_hint']?['count'] as num?)?.toInt(),
      draftHintAmountVnd: (json['draft_hint']?['amount_vnd'] as num?)?.toInt(),
      // D3 (§3.4) — the app-drafts aggregate tells this screen which of its
      // sections could NOT be read, so a half-read day is shown as
      // `loadedPartial` (what answered + a banner naming the rest) instead of
      // either a 500 or a silent "0". Only sections the server marked ok:false
      // are named; an absent `sections` (any other drill) is simply no banner.
      partial: json['partial'] == true,
      sectionsFailed: json['sections'] is Map
          ? (json['sections'] as Map)
              .entries
              .where((e) => e.value is Map && (e.value as Map)['ok'] != true)
              .map((e) => e.key.toString())
              .toList(growable: false)
          : const <String>[],
      duplicatesDropped: (json['duplicates_dropped'] as num?)?.toInt() ?? 0,
      rows: rawRows is List
          ? rawRows
              .whereType<Map<String, dynamic>>()
              .map(
                (r) => DrillRow(
                  name: r['name'] as String? ?? '',
                  date: r['date'] as String?,
                  amountVnd: (r['amount_vnd'] as num?)?.toInt() ?? 0,
                  note: r['note'] as String? ?? '',
                  kind: r['kind'] as String? ?? '',
                ),
              )
              .where((r) => r.name.isNotEmpty)
              .toList(growable: false)
          : const <DrillRow>[],
      generatedAt: json['generated_at'] as String?,
    );
  }

  final String drillId;
  final String title;
  final String date;
  final int limit;
  final List<DrillSummaryLine> summaryLines;
  final int totalDocuments;
  final bool truncated;
  final List<DrillRow> rows;

  /// `REAL` / `MOCK` / null — must be [realProvenance] for the rows above to be
  /// rendered as the shop's figures.
  final String? erpTarget;

  /// D1 — the server's own wording about WHAT the figures are (GL raw, drafts
  /// not subtracted). Comes verbatim from the server; null on day drills.
  final String? footnote;

  /// D1 — the OPTIONAL draft-payment hint (§3.1): how many open draft PEs exist
  /// and what they promise. Never folded into the figures; both null when the
  /// server sent none.
  final int? draftHintCount;
  final int? draftHintAmountVnd;

  /// D3 — true when at least one section of the aggregate could not be read:
  /// the rows below are the sections that DID answer (§2.2 `loadedPartial`).
  final bool partial;

  /// D3 — the section names the server reported as NOT read, for the banner.
  /// Empty for every single-section drill (and when everything answered).
  final List<String> sectionsFailed;

  /// D3 — how many rows the SERVER collapsed as duplicates of one action id.
  /// The client never picks between them; this is only so the fact is visible.
  final int duplicatesDropped;
  final String? generatedAt;
}
