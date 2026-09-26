/**
 * Falsification for the A3 PDF reader's IDENTITY and DATE reads, and for its
 * decompression cap — the three defects recorded in `.plan/next4/A3-result.md` §9.5.
 *
 * Why this harness exists at all: `test/a3-einvoice-pdf.test.mjs` was 15 green
 * tests before these fixes, and every one of them passed on the buggy reader. A
 * guard nobody can re-run proves nothing, so each fix below has a mutation that
 * must turn its NAMED test red — a fix whose mutation stays green is decoration.
 *
 *   H1  `invoice_no` was answered from "mã số thuế" / "in số bản" (a bare `so`
 *       inside a longer label, taken from the line below when empty);
 *   M1  `inflateSync` had NO output cap (measured: 106.884 bytes → 31.457.284,
 *       +541 MB RSS);
 *   M2  `readDate` took the first date-shaped number ANYWHERE, labelled or not.
 *
 * Run: node scripts/falsify/a3-einvoice-pdf.mjs
 */
import { runCases } from "./lib/harness.mjs";

const SRC = "src/einvoice/einvoice-pdf.mjs";
const SUITE = "test/a3-einvoice-pdf.test.mjs";
const A1_SUITE = "test/a1-einvoice-parser.test.mjs";

const cases = [
  // NOTE: there is deliberately NO case for "put the bare `so` back into the
  // SPECIFIC pattern". That mutation runs GREEN, and the harness reports such a
  // case as a PROBLEM — correctly, because the digit requirement already refuses
  // every value the bare `so` would pick up on that path ("Mã số thuế" yields
  // "thue"). Two guards for one hole is one guard plus decoration: the specific
  // pattern keeps its precise labels, and the digit rule is the load-bearing one
  // (cases C and J). A green case kept "for safety" would make this harness lie.
  {
    name: "B. the `so`-context block is disarmed — `Mẫu số: 01/1P` becomes the invoice number",
    file: SRC,
    old: "const NON_INVOICE_NO_CONTEXT = /\\b(ma so|mau so|so thue|so ban|so luong|so dien thoai|so tai khoan|so tien|so hieu|so ghe|so xe|so du|so dong)\\b/;",
    new: "const NON_INVOICE_NO_CONTEXT = /THIS_PATTERN_MATCHES_NOTHING/;",
    only: "A3 fields H1: `Mẫu số: 01/1P` is the FORM's number",
  },
  {
    name: "C. the digit requirement is dropped — a bare `Số` answers \"seri\" from \"Số seri\"",
    file: SRC,
    // Anchored on the comment above it: the same `if` line also exists in pass 1
    // (the specific-label pass), and `String.replace` with a string pattern hits
    // only the FIRST match — an unanchored anchor would mutate the WRONG pass and
    // the case would be measuring something other than what its name claims.
    old: '      // "thu" — neither is an invoice number, and both used to be returned.\n      if (same && /\\d/.test(same)) return same;',
    new: '      // "thu" — neither is an invoice number, and both used to be returned.\n      if (same) return same;',
    only: "A3 fields H1: a bare `Số` with a LETTER value",
  },
  {
    name: "D. a bare `Số` gets the next-line fallback back — it takes the tax id below",
    file: SRC,
    // Anchored on pass 2's own comment for the same reason as case C.
    old: '      // "thu" — neither is an invoice number, and both used to be returned.\n      if (same && /\\d/.test(same)) return same;',
    new: '      // "thu" — neither is an invoice number, and both used to be returned.\n      if (same && /\\d/.test(same)) return same;\n      const below = valueToken(lines[index + 1]);\n      if (below) return below;',
    only: "A3 fields H1: a bare `Số` does not take the line BELOW it",
  },
  {
    name: "L. the TEXT-line cap is removed — 20.100 lines are built before layer 2 pops them (L1)",
    file: SRC,
    old: "      if (lines.length > limits.maxTextLines) {",
    new: "      if (false) {",
    only: "A3 bytes L1: a text layer with more lines than any invoice refuses DURING construction",
  },
  {
    name: "M. the sync/pure guard goes back to ONE file — an `async` parser of the channel is not caught (L3)",
    // The mutation lives in the PDF module, but the guard that must catch it is in
    // the A1 static test: that test used to name `einvoice-xml.mjs` explicitly while
    // walking the whole directory, so a second parser could grow `await` unnoticed.
    file: SRC,
    old: "export function extractPdfText(input, { policy = null } = {}) {",
    new: "export async function extractPdfText(input, { policy = null } = {}) {",
    nodeFile: "a1",
    only: "A1 (static): src/einvoice has no write surface, no routing and no ERPNext access",
  },
  {
    name: "E. the decompression OUTPUT cap is removed — a 1 KB file inflates to 20 MB",
    file: SRC,
    old: "      return inflateSync(raw, { maxOutputLength: limits.maxInflatedBytes });",
    new: "      return inflateSync(raw);",
    only: "A3 bytes M1: a stream that inflates past the OUTPUT cap refuses BY NAME",
  },
  {
    name: "F. the date-context block is disarmed — \"Ngày đặt hàng\" wins over the invoice date",
    file: SRC,
    old: "    if (!NON_INVOICE_DATE_CONTEXT.test(line)) usable.push(index);",
    new: "    usable.push(index);",
    only: "A3 fields M2: the invoice date comes from the invoice's own line",
  },
  {
    name: "G. two unlabelled dates are accepted again — a coin flip becomes the document key",
    file: SRC,
    old: "  if (unlabelled.length === 1) return pdfDateToIso(unlabelled[0]);",
    new: "  if (unlabelled.length > 0) return pdfDateToIso(unlabelled[0]);",
    only: "A3 fields M2: two unlabelled dates are a refusal",
  },
  {
    name: "H. the label preference is dropped — an unlabelled date printed earlier wins",
    file: SRC,
    old: "  if (labelled.length > 0) return pdfDateToIso(labelled[0]);",
    new: "  if (unlabelled.length > 0) return pdfDateToIso(unlabelled[0]);",
    only: "A3 fields M2: a LABELLED date wins over an unlabelled one printed earlier",
  },
  // I/J guard the SAME defect as A–D, one branch over: the specific-label path.
  // Both were found by probing the first fix rather than trusting it (the
  // specific-label next-line fallback answered `invoice_no = "M"` from a tax id
  // and "S" from a quantity line).
  {
    name: "I. the next line need not BE the value — a tax id below the label becomes `invoice_no = \"M\"`",
    file: SRC,
    old: "        const below = wholeLineToken(next);",
    new: "        const below = valueToken(next);",
    only: "A3 fields H1: even a SPECIFIC label does not take a tax id",
  },
  {
    name: "K. the whole-line rule is dropped — a TABLE ROW answers the invoice number with its first column",
    file: SRC,
    old: "  return token && token === text && /\\d/.test(token) ? token : null;",
    new: "  return token ?? null;",
    only: "A3 fields H1: even a SPECIFIC label does not take a tax id",
  },
  {
    name: "J. the specific label loses the digit rule — \"chưa có\" becomes the invoice number",
    file: SRC,
    old: "      if (same && /\\d/.test(same)) return same;\n      const next = lines[index + 1];",
    new: "      if (same) return same;\n      const next = lines[index + 1];",
    only: "A3 fields H1: a specific label with a NON-numeric value",
  },
];

process.exit(
  runCases(cases, {
    title: "A3 PDF reader — identity (H1), inflation bomb (M1)+line cap (L1), invoice date (M2) and the channel's sync guard (L3)",
    nodeFiles: { default: SUITE, a1: A1_SUITE },
  }),
);
