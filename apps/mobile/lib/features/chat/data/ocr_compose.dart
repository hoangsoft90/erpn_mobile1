import 'ocr_models.dart';

/// C2 (`plan3` Trụ C) — the sentence a photo's slots become.
///
/// WHY THE CLIENT COMPOSES AT ALL: a photo has no imperative verb (measured on
/// the real path: "HÓA ĐƠN …" routes to `invoice.lookup`, never to a write), so
/// the user picks the document kind on the sheet. From there C2 must NOT grow a
/// second write path — the composed sentence travels the ONE existing pipeline
/// (`POST /ask` → classifier → capability ∈ contract → proposal → confirm →
/// Safety Gateway), exactly as if the shop owner had typed it. That is also why
/// the composed sentence is shown in the chat as the user's own turn: what was
/// interpreted is visible and correctable.
///
/// THE TEMPLATES ARE GUARDED SERVER-SIDE. `mcp-erpnext/test/c2-ocr-proposal.test.mjs`
/// parses the two literals below, fills them with fixture slots and asserts each
/// kind routes to the capability `ocr_policy.document_kinds` declares. So the
/// wording here cannot drift away from the router without a test going red —
/// and that test is the only place either side learns the other exists.
///
/// Nothing in this file can execute anything: it returns a STRING.
class OcrCompose {
  const OcrCompose._();

  /// Do not reformat these two lines: the tripwire reads them verbatim.
  static const String salesTemplate = 'đặt hàng cho {party} {goods}';
  static const String purchaseTemplate = 'đặt mua {goods} từ {party}';

  /// The document kinds the app may offer. Must stay in step with the keys of
  /// `ocr_policy.document_kinds` — a kind the server does not declare is refused
  /// with `OCR_KIND_UNKNOWN` before anything is read.
  static const List<String> kinds = ['sales', 'purchase'];

  static const Map<String, String> _templates = {
    'sales': salesTemplate,
    'purchase': purchaseTemplate,
  };

  /// Build the question to send through `/ask`.
  ///
  /// Quantity, unit and item name are the user's own words (they just confirmed
  /// them on the form); the price is deliberately ABSENT — a rate only ever
  /// comes from ERPNext (B2/B4 `rate_source: erpnext`).
  static String compose({
    required String kind,
    String? party,
    required List<OcrSlotLine> lines,
  }) {
    final goods = lines
        .where((line) => line.qty != null)
        .map((line) =>
            '${_plainNumber(line.qty!)} ${line.uom ?? ''} ${line.itemName ?? ''}'.trim())
        .where((part) => part.isNotEmpty)
        .join(' + ');
    final template = _templates[kind] ?? salesTemplate;
    var sentence = template
        .replaceAll('{party}', (party ?? '').trim())
        .replaceAll('{goods}', goods)
        .replaceAll(RegExp(r'\s+'), ' ')
        .trim();
    // No party named on the photo: drop the dangling preposition rather than
    // sending "… từ" / "cho  …" into the pipeline.
    sentence = sentence.replaceAll(RegExp(r'\s+(từ|cho)$'), '').trim();
    return sentence;
  }

  /// 10.0 → "10", 2.5 → "2,5"? NO — the pipeline parses plain digits, and a
  /// Vietnamese decimal comma would be read as a separator, so the number is
  /// written the way the user typed it: digits, dot only when fractional.
  static String _plainNumber(num value) {
    if (value == value.roundToDouble()) return value.round().toString();
    return value.toString();
  }
}
