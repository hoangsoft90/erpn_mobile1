/// B1 (`.plan/next7/B1-result.md`, `plan_final.md` §4.2): does this dictation
/// text read like a WRITE order?
///
/// It answers ONE question, for ONE case: a dictation that ended WITHOUT a final
/// result (the recognizer swallowed it — B0 proved the user's tap-to-stop ends
/// up here), where the field may therefore hold only PARTIAL text. A partial
/// PAYMENT/SALE sentence must not be auto-sent: nobody has read it, and a
/// mis-heard amount is exactly the kind of sentence a shopkeeper must see first.
///
/// Direction of failure is deliberate and asymmetric:
/// * a FALSE POSITIVE costs the user one manual Gửi (the text stays in the
///   field) — annoying, never harmful;
/// * a FALSE NEGATIVE sends an unreviewed partial — which is why the vocabulary
///   is taken from the contract rather than invented, and why the check stays
///   word-exact instead of fuzzy.
/// The blast radius is bounded anyway: the only request auto-send can make is
/// `POST /ask`, so even a wrong sentence yields a proposal that still needs its
/// own [Xác nhận], never a write.
///
/// Vocabulary: the WRITE `triggers` of `mcp-erpnext/capabilities.json` (pinned
/// `@casys/mcp-erpnext@3.0.4`), in BOTH spellings the contract ships (accented
/// and unaccented). Bare "bán"/"bán hàng" is intentionally ABSENT: the contract
/// does not list it as a write trigger, and "doanh thu bán được" is a READ
/// question — blocking it would be pure noise.
///
/// Matching is token-based, NOT `\b`-based: `\b` is unusable around Vietnamese
/// letters (C3 lesson — `\b(tháng)\b` matched but `\b(quý)\b` did not, because
/// `\b` is ASCII-only). Padding the normalized text with spaces and looking for
/// ` phrase ` gives the same guarantee for every phrase, single word or not.
library;

/// Every phrase is matched as a whole token sequence against the lowercased,
/// punctuation-stripped text. Keep the list flat and readable: it is data, and
/// an auditor must be able to diff it against `capabilities.json`.
const List<String> _writePhrases = <String>[
  // customer.create
  'thêm khách', 'them khach', 'tạo khách', 'tao khach', 'khách mới',
  'khach moi', 'new customer',
  // payment.create
  'thu tiền', 'thu tien', 'nhận tiền', 'nhan tien', 'ghi nhận thanh toán',
  'ghi nhan thanh toan', 'chi tiền', 'chi tien', 'chi ncc', 'chi nhà cung cấp',
  'chi nha cung cap', 'trả tiền', 'tra tien', 'nộp tiền', 'nop tien',
  'thanh toán', 'thanh toan', 'chuyển khoản', 'chuyen khoan', 'payment',
  // sales.create — the free-drafting SALE (Phase 6, next8): the contract now
  // lists "bán hàng"/"bán cho" as WRITE triggers, so a partial dictation of a
  // sale sentence waits for the user's own Gửi. A READ sentence containing the
  // phrase costs one manual send — the cheap direction of failure.
  'bán hàng', 'ban hang', 'bán cho', 'ban cho', 'lập hoá đơn bán',
  'lap hoa don ban',
  // sales_order.create
  'đặt hàng', 'dat hang', 'đặt đơn', 'dat don', 'lên đơn', 'len don',
  'tạo đơn', 'tao don', 'order',
  // purchase_order.create
  'đặt mua', 'dat mua', 'mua hàng', 'mua hang', 'đặt nhà cung cấp',
  'dat nha cung cap', 'purchase order',
  // purchase_receipt.create
  'nhận hàng', 'nhan hang',
  // purchase_invoice.create — the free-drafting PURCHASE (Phase 7, next8): the
  // contract now lists "nhập hàng"/"mua hàng"/"lập phiếu nhập"/"mua vào" as
  // WRITE triggers, so a partial dictation of a purchase sentence waits for the
  // user's own Gửi.
  'nhập hàng', 'nhap hang', 'mua hàng', 'mua hang', 'lập phiếu nhập',
  'lap phieu nhap', 'mua vào', 'mua vao', 'purchase',
  // sales_return.create
  'trả hàng', 'tra hang', 'khách trả', 'khach tra', 'trả lại hàng',
  'tra lai hang', 'bán trả lại', 'ban tra lai',
  // stock.adjustment
  'xuất hủy', 'xuat huy', 'xuất huỷ', 'xuất bỏ', 'xuat bo',
  'hàng hỏng', 'hang hong', 'hàng hư', 'hang hu', 'hàng bị hỏng',
  'hang bi hong', 'báo hỏng', 'bao hong', 'hủy hàng hỏng', 'huy hang hong',
  // delivery.create
  'giao hàng', 'giao hang', 'giao đơn', 'giao don', 'delivery',
  // sales_invoice.create
  'xuất hóa đơn', 'xuat hoa don', 'xuất hoá đơn', 'lập hóa đơn',
  'lap hoa don', 'lập hoá đơn', 'viết hóa đơn', 'viet hoa don', 'xuất hd',
  'xuat hd', 'lập hd', 'lap hd',
  // quotation.create
  'báo giá', 'bao gia', 'quotation', 'quote',
  // document.delete
  'xóa', 'xoá', 'xoa', 'hủy', 'huỷ', 'huy', 'delete', 'remove',
];

/// Lowercases and reduces every run of non-alphanumeric characters (punctuation,
/// commas, line breaks — a recognizer's partials carry them) to a single space,
/// so the padded `contains` below is a word check, not a substring check.
String _normalized(String text) => text
    .toLowerCase()
    .replaceAll(RegExp(r'[^\p{L}\p{M}\p{N}]+', unicode: true), ' ')
    .trim();

/// True when [text] contains a WRITE trigger phrase. Empty/whitespace text is
/// never write-shaped (there is nothing to send, and nothing to protect).
bool looksLikeWriteOrder(String text) {
  final normalized = _normalized(text);
  if (normalized.isEmpty) return false;
  final padded = ' $normalized ';
  for (final phrase in _writePhrases) {
    if (padded.contains(' $phrase ')) return true;
  }
  return false;
}
