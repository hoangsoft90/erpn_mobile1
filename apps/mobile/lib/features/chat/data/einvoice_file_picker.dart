import 'dart:convert';
import 'dart:typed_data';

import 'package:file_selector/file_selector.dart';

/// A2 (`.plan/next3/implementation.md` workstream A) + A3 — the FILE half of the
/// e-invoice (HÓA ĐƠN ĐIỆN TỬ) input channel: a `.xml` file's TEXT or a `.pdf`
/// file's BYTES.
///
/// Kept behind an interface for the same two reasons [PhotoPicker] is:
/// (a) CI has no file chooser, so tests inject a fake, and (b) swapping the
/// source (system picker today, a share-intent receiver later) changes one file
/// instead of the chat screen.
///
/// This interface can ONLY hand back a file the user picked, in the one form
/// that file travels in. It has no notion of what the document means, no path to
/// `/ask`, none to `/input/einvoice`, and certainly none to `/execute` — a
/// supplier's file is an input modality, not a command.
abstract class EinvoiceFilePicker {
  /// Returns the picked file, or null when the user backed out (a cancel is not
  /// an error and must not produce a request).
  ///
  /// Throws [EinvoiceFileException] when the picked file cannot be sent at all
  /// (wrong kind of file, empty, over the size cap, not text) — the UI shows its
  /// message verbatim.
  Future<PickedEinvoiceFile?> pick();
}

/// One file the user picked, in the form THIS channel sends it.
///
/// Sealed on purpose: the chat screen branches on which reader the file needs,
/// and a sealed hierarchy makes "a third file type was added and one `switch`
/// forgot it" a compile error instead of a silent fall-through.
sealed class PickedEinvoiceFile {
  const PickedEinvoiceFile({required this.name});

  /// The file's own name — shown so the user can see WHICH file is on the form.
  final String name;
}

/// One picked HĐĐT XML file, already decoded to the text that will be sent.
class PickedXmlFile extends PickedEinvoiceFile {
  const PickedXmlFile({required this.xml, required super.name});

  /// The file's text, exactly as it travels in the request body. The app does
  /// NOT parse it: the gateway owns the XML parser (`src/einvoice/einvoice-xml.mjs`),
  /// and a second parser on the client is how "the user confirmed one thing and
  /// the file said another" is born.
  final String xml;
}

/// One picked HĐĐT PDF file: the file's RAW BYTES, untouched.
///
/// Deliberately NOT read here. The gateway owns the only PDF reader
/// (`src/einvoice/einvoice-pdf.mjs`) — and "what the text layer says" is exactly
/// the reading a second, client-side implementation would get subtly wrong while
/// the user confirms it (the A3 spike measured this on the server side: labels
/// sitting near other labels, a bare `so` inside "mã số thuế", FlateDecode
/// bombs). The app's whole job here is to move the bytes.
class PickedPdfFile extends PickedEinvoiceFile {
  const PickedPdfFile({required this.bytes, required super.name});

  /// The file's bytes, exactly as read from disk.
  final Uint8List bytes;

  /// base64, exactly as it travels in the request body.
  ///
  /// The class owns its own wire form so the screen never encodes anything: one
  /// place decides how a file becomes a request. base64 (not raw bytes) because
  /// the route takes JSON — and [einvoiceMaxPdfBytes] is what keeps the ENCODED
  /// body under the gateway's 1 MB limit (650 000 bytes → ~867 KB of base64).
  String get base64 => base64Encode(bytes);
}

/// The client-side mirror of the server's own byte cap
/// (`einvoice_policy.max_xml_bytes` in `mcp-erpnext/capabilities.json`, 950 KB).
///
/// It exists so a too-large file gets an actionable Vietnamese sentence — and
/// does not spend a 1 MB upload to find out — but the SERVER owns the policy:
/// if the two ever disagree, the refusal still comes from the server's own code
/// with its own reason. Deliberately a top-level constant rather than a field of
/// [SystemEinvoiceFilePicker]: [decodeEinvoiceXml] is pure and must not depend on
/// the plugin-backed class to know its own limits.
const int einvoiceMaxXmlBytes = 950000;

/// The same mirror for the PDF channel: `einvoice_policy.max_pdf_bytes`
/// (`mcp-erpnext/capabilities.json`, 650 000 bytes).
///
/// Note the cap is on the FILE, not on the request: base64 turns 650 000 bytes
/// into ~867 KB of JSON, which is what still has to fit under the gateway's 1 MB
/// body limit. Raising this constant without re-checking that arithmetic would
/// be caught by the server's 413 — not by a silent truncation.
const int einvoiceMaxPdfBytes = 650000;

/// The picked file is not something this channel can send. Carries the message
/// the UI shows verbatim, in Vietnamese.
class EinvoiceFileException implements Exception {
  const EinvoiceFileException(this.message);

  final String message;

  @override
  String toString() => message;
}

/// Decode a picked file's bytes into the XML text, refusing (rather than
/// guessing) anything that would make the server read a different document than
/// the user picked.
///
/// PURE and public so the rules are unit-testable without a file chooser — the
/// plugin call is the only part that needs a device.
///
/// Rules, and why each one is a refusal instead of a repair:
/// * **empty** → nothing to send; the server would answer `XML_EMPTY` anyway,
///   and a request that cannot succeed should not be made.
/// * **over [einvoiceMaxXmlBytes]** → the server's own policy cap, deliberately
///   below the gateway's 1 MB HTTP body cap. Checking here means the user gets
///   an actionable Vietnamese sentence instead of an opaque transport error —
///   and we do not spend a 1 MB upload to learn it.
/// * **not UTF-8** → refused, NOT decoded as Latin-1. A wrong decode produces
///   mojibake that still parses as XML, i.e. a form full of corrupted names the
///   user would then "confirm". A byte-order mark is honoured (and stripped)
///   because a BOM is unambiguous: UTF-8 BOM → UTF-8, UTF-16 BOM → UTF-16.
PickedXmlFile decodeEinvoiceXml(Uint8List bytes, String name) {
  if (bytes.isEmpty) {
    throw const EinvoiceFileException(
      'File XML rỗng — bạn chọn đúng file hoá đơn điện tử (.xml) giúp tôi.',
    );
  }
  if (bytes.length > einvoiceMaxXmlBytes) {
    final kb = (bytes.length / 1024).ceil();
    final cap = einvoiceMaxXmlBytes ~/ 1024;
    throw EinvoiceFileException(
      'File XML $kb KB, vượt mức $cap KB của máy chủ. File hoá đơn điện tử '
      'thường chỉ vài trăm KB — bạn kiểm tra lại có chọn nhầm file kèm phụ lục '
      'hoặc ảnh không.',
    );
  }

  final String xml;
  if (_hasPrefix(bytes, const [0xFF, 0xFE])) {
    xml = _decodeUtf16(bytes.sublist(2), bigEndian: false);
  } else if (_hasPrefix(bytes, const [0xFE, 0xFF])) {
    xml = _decodeUtf16(bytes.sublist(2), bigEndian: true);
  } else {
    // A UTF-8 BOM is legal in a file and must not reach the parser as a stray
    // character before `<?xml`.
    final body = _hasPrefix(bytes, const [0xEF, 0xBB, 0xBF])
        ? bytes.sublist(3)
        : bytes;
    try {
      xml = utf8.decode(body);
    } on FormatException {
      throw const EinvoiceFileException(
        'File này không phải văn bản UTF-8 nên không đọc được. Bạn mở file '
        'bằng ứng dụng xem XML rồi lưu lại dạng UTF-8, hoặc nhập tay giúp tôi.',
      );
    }
  }

  if (xml.trim().isEmpty) {
    throw const EinvoiceFileException(
      'File XML không có nội dung — bạn chọn đúng file hoá đơn điện tử (.xml).',
    );
  }
  return PickedXmlFile(xml: xml, name: name);
}

bool _hasPrefix(Uint8List bytes, List<int> prefix) {
  if (bytes.length < prefix.length) return false;
  for (var i = 0; i < prefix.length; i++) {
    if (bytes[i] != prefix[i]) return false;
  }
  return true;
}

/// UTF-16 → String, for the providers that write their XML that way. Only ever
/// reached when a BOM said so, so it cannot mis-decode a UTF-8 file.
String _decodeUtf16(Uint8List bytes, {required bool bigEndian}) {
  final units = <int>[];
  for (var i = 0; i + 1 < bytes.length; i += 2) {
    units.add(bigEndian ? (bytes[i] << 8) | bytes[i + 1] : bytes[i] | (bytes[i + 1] << 8));
  }
  return String.fromCharCodes(units);
}

/// The system implementation: the platform's own file chooser, filtered to the
/// two formats this channel ingests (`.xml` and `.pdf`).
///
/// The filter is a convenience, not a guarantee — some providers ignore it — so
/// [decodeEinvoiceFile] and the server both still check what actually arrived.
class SystemEinvoiceFilePicker implements EinvoiceFilePicker {
  static const XTypeGroup _invoiceTypeGroup = XTypeGroup(
    label: 'Hoá đơn điện tử (.xml, .pdf)',
    extensions: <String>['xml', 'pdf'],
  );

  @override
  Future<PickedEinvoiceFile?> pick() async {
    final file = await openFile(acceptedTypeGroups: const [_invoiceTypeGroup]);
    if (file == null) return null;
    final bytes = await file.readAsBytes();
    return decodeEinvoiceFile(bytes, file.name);
  }
}

/// Route a picked file to the right READING, by the file's own extension, and
/// refuse anything else by NAME.
///
/// Why by extension and not by content: a provider that ignores the chooser's
/// filter can hand back any file, and "which reader does this need" has to be a
/// decision the user can see and predict. A PDF renamed `.xml` is not silently
/// re-read — it fails the XML decode ("không phải văn bản UTF-8") or the
/// server's own parser, both of which say what is wrong. The one thing NOT done
/// here — and this is the line A3 draws — is sniffing bytes to pick a reader:
/// the client decides SIZE and EMPTINESS (things it can decide without reading
/// the document), the SERVER decides CONTENT.
PickedEinvoiceFile decodeEinvoiceFile(Uint8List bytes, String name) {
  switch (_extensionOf(name)) {
    case 'xml':
      return decodeEinvoiceXml(bytes, name);
    case 'pdf':
      return decodeEinvoicePdf(bytes, name);
    default:
      throw const EinvoiceFileException(
        'Chỉ nhận file hoá đơn điện tử .xml hoặc .pdf. Bạn chọn lại giúp tôi.',
      );
  }
}

String _extensionOf(String name) {
  final dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.substring(dot + 1).toLowerCase();
}

/// Take a picked PDF as-is, refusing only the two things that are certainties
/// BEFORE the upload: nothing to send, and too big to send.
///
/// There is deliberately no content check here (no `%PDF` sniff, no text-layer
/// probe): the gateway answers both, with Vietnamese sentences the UI shows
/// verbatim — `..._NOT_A_PDF` for a file that is not a PDF at all, and
/// `EINVOICE_PDF_NO_TEXT` (422) for a SCAN, which is a real difference the app
/// cannot make from bytes alone. Guessing here would either duplicate the
/// server's rules or, worse, contradict them.
PickedPdfFile decodeEinvoicePdf(Uint8List bytes, String name) {
  if (bytes.isEmpty) {
    throw const EinvoiceFileException(
      'File PDF rỗng — bạn chọn đúng file hoá đơn điện tử (.pdf) giúp tôi.',
    );
  }
  if (bytes.length > einvoiceMaxPdfBytes) {
    final kb = (bytes.length / 1024).ceil();
    final cap = einvoiceMaxPdfBytes ~/ 1024;
    throw EinvoiceFileException(
      'File PDF $kb KB, vượt mức $cap KB của máy chủ. File hoá đơn điện tử '
      'thường chỉ vài trăm KB — bạn kiểm tra lại có chọn nhầm file kèm phụ lục '
      'hoặc bản scan nhiều trang không.',
    );
  }
  return PickedPdfFile(bytes: bytes, name: name);
}
