/// C1 (`plan3` Trụ C) — one OCR reading of a photo, exactly as the gateway
/// described it (`POST /ocr`).
///
/// The camera is an INPUT CHANNEL: what arrives here is TEXT plus how much the
/// reader trusts it. There is no proposal and no action in this shape, and this
/// class deliberately offers no way to execute anything — the only thing the UI
/// may do with a reading is prefill the chat field for the user to edit.
///
/// Parsing is FAIL-CLOSED in the same spirit as [ActionProposal]: a status the
/// app does not recognise, or a missing `usable` flag, must not be treated as a
/// successful read (that would turn "the server said something new" into "the
/// photo was read correctly").
class OcrRead {
  const OcrRead({
    required this.status,
    required this.text,
    required this.usable,
    required this.confidence,
    required this.minConfidence,
    required this.instructionPatternFound,
    required this.provider,
    required this.model,
    required this.mock,
  });

  /// `OK`, `LOW_CONFIDENCE` or `NO_TEXT` — the server's own vocabulary.
  static const String statusOk = 'OK';
  static const String statusLowConfidence = 'LOW_CONFIDENCE';
  static const String statusNoText = 'NO_TEXT';

  static const Set<String> _knownStatuses = {
    statusOk,
    statusLowConfidence,
    statusNoText,
  };

  final String status;

  /// The recognised text, already sanitised and bounded server-side. Empty when
  /// nothing could be read.
  final String text;

  /// True only when the server says so AND the status is `OK` — two
  /// independent signals that must agree before the text is offered for use.
  final bool usable;

  /// Lowest confidence of the read, or null when the provider cannot say.
  final double? confidence;

  /// The floor the server applied (`ocr_policy.min_confidence`).
  final double? minConfidence;

  /// True when instruction-shaped content was found in the photo and neutralised
  /// (an invoice that prints "ignore previous instructions").
  final bool instructionPatternFound;

  final String? provider;
  final String? model;

  /// True when the reading came from the MOCK provider — a fixture, not the
  /// user's document. The UI must say so, and C2 must never build a proposal
  /// out of it.
  final bool mock;

  factory OcrRead.fromJson(Map<String, dynamic> json) {
    final status = json['status'];
    final known = status is String && _knownStatuses.contains(status);
    final text = json['text'];
    final confidence = _asDouble(json['confidence']);
    final minConfidence = _asDouble(json['min_confidence']);
    return OcrRead(
      status: known ? status : 'UNKNOWN',
      text: text is String ? text : '',
      // Unusable unless BOTH the server's flag and the status agree. An unknown
      // status can never be usable, even if the payload claims `usable: true`.
      usable: known && status == statusOk && json['usable'] == true,
      confidence: confidence,
      minConfidence: minConfidence,
      instructionPatternFound: json['instruction_pattern_found'] == true,
      provider: json['provider'] is String ? json['provider'] as String : null,
      model: json['model'] is String ? json['model'] as String : null,
      mock: json['mock'] == true,
    );
  }

  static double? _asDouble(Object? value) {
    if (value is num) return value.toDouble();
    return null;
  }

  /// Confidence as a whole percent, for the label the user sees.
  int? get confidencePercent =>
      confidence == null ? null : (confidence! * 100).round();

  int? get minConfidencePercent =>
      minConfidence == null ? null : (minConfidence! * 100).round();

  /// C2 (`plan3` Trụ C) — the provenance the slot request carries, taken from
  /// THIS reading. The server refuses a proposal built from a reading that was
  /// low-confidence or came from the mock provider, so the app must be able to
  /// state what it actually got rather than assume the good case.
  Map<String, dynamic> get provenance => {
        'status': status,
        'confidence': confidence,
        'mock': mock,
        'provider': provider,
        'model': model,
      };

  /// Why the reading cannot be used, in the shop owner's words. Null when it can.
  String? get refusalReason {
    switch (status) {
      case statusNoText:
        return 'Ảnh này không đọc được chữ nào. Hãy chụp lại rõ hơn '
            '(đủ sáng, không nghiêng) hoặc nhập tay.';
      case statusLowConfidence:
        final percent = confidencePercent;
        final floor = minConfidencePercent;
        return 'Ảnh đọc không chắc'
            '${percent == null ? '' : ' ($percent% < $floor%)'}'
            '. Hãy chụp lại rõ hơn hoặc nhập tay — không dùng bản đọc này.';
      case statusOk:
        return null;
      default:
        return 'Máy chủ trả về kết quả đọc ảnh không rõ ràng. Hãy nhập tay.';
    }
  }
}

/// C2 (`plan3` Trụ C) — what a photo APPEARS to say, as returned by
/// `POST /ocr/slots`, for the user to correct before anything is proposed.
///
/// This is deliberately not a proposal: there is no price, no command id, no
/// capability to execute. Prices only ever come from ERPNext (a rate in a photo
/// is the price on a piece of paper, not the shop's published price), and the
/// corrected sentence goes back through the ordinary `/ask` pipeline.
class OcrSlots {
  const OcrSlots({
    required this.kind,
    required this.capability,
    required this.label,
    required this.party,
    required this.lines,
    required this.warnings,
    required this.moneyVnd,
    required this.confidence,
    this.sourceDocument,
  });

  /// `sales` or `purchase` — the word the user picked, echoed back.
  final String kind;

  /// The capability the CONTRACT maps that kind to. Shown for transparency; the
  /// app never sends it anywhere (the server would refuse an id used as a kind).
  final String capability;
  final String label;

  final OcrSlotParty party;
  final List<OcrSlotLine> lines;
  final List<OcrSlotWarning> warnings;

  /// The total read off the photo, DISPLAY ONLY — the order's real total comes
  /// from ERPNext prices when the proposal is built.
  final int? moneyVnd;

  final double? confidence;

  /// The IDENTITY of the paper document these slots were read from, when the
  /// reader got enough of it (next3/B). Null is the ordinary case for a photo
  /// that only shows goods; it is ALSO what this becomes when the payload has a
  /// half-identity — see [OcrSourceDocument.fromJson].
  final OcrSourceDocument? sourceDocument;

  int? get confidencePercent =>
      confidence == null ? null : (confidence! * 100).round();

  factory OcrSlots.fromJson(Map<String, dynamic> json) {
    final party = json['party'];
    return OcrSlots(
      kind: json['kind'] as String,
      capability: json['capability'] as String,
      label: (json['label'] as String?) ?? '',
      party: party is Map<String, dynamic>
          ? OcrSlotParty.fromJson(party)
          : const OcrSlotParty(role: '', resolved: null, ambiguous: false, candidates: []),
      lines: ((json['lines'] as List<dynamic>?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(OcrSlotLine.fromJson)
          .toList(),
      warnings: ((json['warnings'] as List<dynamic>?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map(OcrSlotWarning.fromJson)
          .toList(),
      moneyVnd: json['money_vnd'] is num ? (json['money_vnd'] as num).toInt() : null,
      // The kind is injected from THIS payload's top-level `kind` — the document
      // the form is about to create — because `source_document` describes a
      // reading and does not label itself.
      sourceDocument: OcrSourceDocument.fromJson(
        json['source_document'],
        kind: json['kind'] is String ? json['kind'] as String : '',
      ),
      confidence: json['confidence'] is num
          ? (json['confidence'] as num).toDouble()
          : (json['provenance'] is Map<String, dynamic>
              ? ((json['provenance'] as Map<String, dynamic>)['confidence'] as num?)
                  ?.toDouble()
              : null),
    );
  }
}

/// next3/B — the identity of the PAPER document a reading came from: số hóa đơn,
/// ngày, MST/party, loại chứng từ.
///
/// WHY THE APP CARRIES THIS AT ALL: the server dedupes a written draft on this
/// identity, and the identity cannot travel inside the composed sentence — the
/// pipeline reads an invoice number such as "00049" as an AMOUNT (measured in
/// `.plan/next3/A-result.md`). So it travels beside the sentence, as its own
/// field.
///
/// FAIL-CLOSED, and that is the whole point of [fromJson] returning null: a
/// HALF-identity must not be sent. The server refuses one outright (400), so
/// sending "whatever we happen to have" would turn a purchase question into a
/// transport error; sending NOTHING is honest — the user simply gets today's
/// behaviour, with a second send able to create a second draft.
class OcrSourceDocument {
  const OcrSourceDocument({
    required this.kind,
    required this.invoiceNo,
    required this.invoiceDate,
    this.invoiceSeries,
    this.sellerTaxId,
  });

  /// The document kind the form is creating (`sales` / `purchase`).
  final String kind;
  final String invoiceNo;
  final String invoiceDate;
  final String? invoiceSeries;
  final String? sellerTaxId;

  /// @param raw the payload's `source_document`, untyped on purpose
  /// @param kind this payload's top-level `kind`
  /// @return null unless the kind, the invoice number, the date AND the seller's
  ///         MST are all present — the parts the server's key is built from. A
  ///         missing MST is NOT filled in from the resolved party here: the
  ///         server's own key prefers the paper's MST, so "which party this was
  ///         resolved to" is not the same identity.
  static OcrSourceDocument? fromJson(Object? raw, {required String kind}) {
    if (raw is! Map<String, dynamic>) return null;
    final docKind = _nonEmpty(kind);
    final invoiceNo = _nonEmpty(raw['invoice_no']);
    final invoiceDate = _nonEmpty(raw['invoice_date']);
    final sellerTaxId = _nonEmpty(raw['seller_tax_id']);
    if (docKind == null ||
        invoiceNo == null ||
        invoiceDate == null ||
        sellerTaxId == null) {
      return null;
    }
    return OcrSourceDocument(
      kind: docKind,
      invoiceNo: invoiceNo,
      invoiceDate: invoiceDate,
      invoiceSeries: _nonEmpty(raw['invoice_series']),
      sellerTaxId: sellerTaxId,
    );
  }

  /// The body field `/ask` expects. IDENTITY ONLY: totals read off a file or a
  /// photo are display-only everywhere in this project and are not sent.
  Map<String, dynamic> toAskJson() => {
        'kind': kind,
        'invoice_no': invoiceNo,
        'invoice_date': invoiceDate,
        if (invoiceSeries != null) 'invoice_series': invoiceSeries,
        if (sellerTaxId != null) 'seller_tax_id': sellerTaxId,
      };

  static String? _nonEmpty(Object? value) {
    if (value is! String) return null;
    final trimmed = value.trim();
    return trimmed.isEmpty ? null : trimmed;
  }
}

/// The person the document is for/from, as the reading saw them.
class OcrSlotParty {
  const OcrSlotParty({
    required this.role,
    required this.resolved,
    required this.ambiguous,
    required this.candidates,
  });

  /// `customer` or `supplier` — which master list it resolved against.
  final String role;

  /// The one row the name matched, if any. A candidate list is OFFERED, never
  /// auto-picked: the pipeline re-resolves the name in the composed sentence and
  /// still shows its own picker when the name is ambiguous in ERPNext.
  final String? resolved;
  final bool ambiguous;
  final List<String> candidates;

  factory OcrSlotParty.fromJson(Map<String, dynamic> json) {
    final resolved = json['resolved'];
    return OcrSlotParty(
      role: (json['role'] as String?) ?? '',
      resolved: resolved is Map<String, dynamic> && resolved['name'] is String
          ? resolved['name'] as String
          : null,
      ambiguous: json['ambiguous'] == true,
      candidates: ((json['candidates'] as List<dynamic>?) ?? const [])
          .whereType<Map<String, dynamic>>()
          .map((row) => row['name'])
          .whereType<String>()
          .toList(),
    );
  }
}

/// One goods line: quantity, unit and item, all EDITABLE.
class OcrSlotLine {
  const OcrSlotLine({
    required this.itemCode,
    required this.itemName,
    required this.qty,
    required this.uom,
    required this.rawQuantity,
  });

  final String? itemCode;
  final String? itemName;
  final double? qty;
  final String? uom;

  /// The words on the photo that produced this number — the user is correcting a
  /// photograph, so they must be able to see what it said.
  final String? rawQuantity;

  factory OcrSlotLine.fromJson(Map<String, dynamic> json) => OcrSlotLine(
        itemCode: json['item_code'] as String?,
        itemName: json['item_name'] as String?,
        qty: json['qty'] is num ? (json['qty'] as num).toDouble() : null,
        uom: json['uom'] as String?,
        rawQuantity: json['raw_quantity'] as String?,
      );
}

/// What the reader could not work out. Shown verbatim — a silent half-empty form
/// is how a wrong order gets confirmed.
class OcrSlotWarning {
  const OcrSlotWarning({required this.code, required this.reason});

  final String code;
  final String reason;

  factory OcrSlotWarning.fromJson(Map<String, dynamic> json) => OcrSlotWarning(
        code: (json['code'] as String?) ?? '',
        reason: (json['reason'] as String?) ?? '',
      );
}
