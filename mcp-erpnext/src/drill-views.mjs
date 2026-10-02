/**
 * P4-4 — day drill-down views (plan4_final §4.4), the data behind tapping a
 * metric on the Tóm tắt ngày screen.
 *
 * Relationship to `read-views.mjs` (A1): A1's screen is opened by ENTITY (a
 * customer id echoed from an answer) and re-validates that id against live data.
 * A drill here is opened by a FIXED id tapped on the summary screen, so the id
 * is a closed set declared in the contract and there is no user text to
 * re-validate. What the two share is the envelope shape — title, bounded rows,
 * `total_documents` + `truncated` — so the Flutter side renders both with the
 * same list screen, and the same rule that a capped list can never look like the
 * whole day.
 *
 * Safety rules this file exists to keep:
 *   - No write surface at all: it imports the READ aggregate skill and nothing
 *     else. It cannot reach `/execute` or the Safety Gateway (static test).
 *   - An undeclared drill id is REFUSED, never guessed. The id arrives from a
 *     client, so it is looked up in the contract as a literal key.
 *   - The page size is policy (contract), not a client request.
 *   - Money is never computed here: every number comes from `readDayDrill`,
 *     which reads the same ERPNext rows the summary's own block summed.
 */

import { clampUiLimit, getDrillScreen } from "./capability-contract.mjs";
import { readDayDrill } from "./skills/ops-summary.mjs";

/** Refusal codes this module can raise (mapped to HTTP by http-ask.mjs). */
export const DRILL_VIEW_CODES = Object.freeze({
  UNKNOWN_DRILL: "UNKNOWN_DRILL_SCREEN",
});

function refuse(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * The contract declaration for a drill id.
 * @param {unknown} drillId
 * @returns {{id:string, drill:object}}
 */
export function resolveDrillScreen(drillId) {
  if (typeof drillId !== "string" || drillId.trim() === "") {
    throw refuse(DRILL_VIEW_CODES.UNKNOWN_DRILL, "thiếu mã drill (drill_id)");
  }
  const id = drillId.trim();
  const drill = getDrillScreen(id);
  if (!drill) {
    throw refuse(
      DRILL_VIEW_CODES.UNKNOWN_DRILL,
      `drill "${id}" không có trong hợp đồng capability — không mở được (chỉ những id đã khai báo mới đọc được)`,
    );
  }
  return { id, drill };
}

/**
 * D4 — the day word a DAY-SCOPED drill's title carries.
 *
 * The title is composed from the day the server is ACTUALLY about to read
 * (`date`), not from what the caller asked for, so a title can never describe a
 * different day than the rows beneath it. "hôm qua" is derived with the same
 * UTC calendar arithmetic the shop day uses (`vnToday` is an en-CA YYYY-MM-DD
 * date), so no DST or timezone can shift which day gets which word.
 *
 * When `today` is unknown (an older caller), the title still says the DATE
 * rather than guessing "hôm nay" — a wrong day word is the one thing this
 * function exists to prevent.
 *
 * @param {string} date YYYY-MM-DD (already validated by the route)
 * @param {string|null} today YYYY-MM-DD, the shop's today
 */
export function drillDayWord(date, today) {
  if (typeof date !== "string" || date === "") return "";
  if (typeof today === "string" && today !== "") {
    if (date === today) return "hôm nay";
    const prev = new Date(`${today}T00:00:00Z`);
    prev.setUTCDate(prev.getUTCDate() - 1);
    if (date === prev.toISOString().slice(0, 10)) return "hôm qua";
  }
  return `ngày ${date}`;
}

/**
 * Fresh, BOUNDED rows for one day drill.
 *
 * @param {object} p
 * @param {object} p.mcp
 * @param {string} p.drillId    fixed id tapped on the summary screen
 * @param {string} p.date       YYYY-MM-DD (already validated by the route)
 * @param {string} p.company    resolved SERVER-side (never from the client)
 * @param {unknown} [p.limit]   requested page size (clamped by the contract)
 * @param {string|null} [p.erpTarget] `"REAL"`/`"MOCK"`, from `erpTargetLabel(env)`.
 *   Travels with the numbers for the SAME reason it does on `/read/daily-summary`:
 *   the drawer may only render figures whose source it can name (§2.1 of the
 *   drawer plan — MOCK/unknown ⇒ no figures). Computed by the ROUTE and passed
 *   in, exactly like the day summary does, so this module keeps importing the
 *   read skill and nothing else.
 * @param {string} [p.today] the SHOP's today (`vnToday()`, computed by the
 *   route from the server's own clock). Used ONLY to name the day in a
 *   day-scoped title; the rows are unaffected by it.
 * @param {object} [p.env] the SERVER's config surface, passed through to the
 *   read skill because a drill's scope can be pinned by configuration (D2's
 *   COPILOT_DEFAULT_WAREHOUSE). process.env is NOT read here: the route owns
 *   the env object (tests inject one), and a drill that silently read a
 *   different source than the request's own config would be a second truth.
 * @returns {Promise<object>} payload for the client
 */
export async function readDrill({ mcp, drillId, date, company, limit, erpTarget = null, today = null, env = process.env }) {
  const { id, drill } = resolveDrillScreen(drillId);
  const pageSize = clampUiLimit(drill, limit);
  // D1 — the drawer views may attach a `footnote` (§3.1, verbatim) and an
  // optional `draft_hint`; drills without them simply leave both fields absent.
  // A hint the server could NOT read (null) is dropped here so "unreadable"
  // never travels as a value the client has to interpret — absent means absent.
  const {
    summary_lines: summaryLines,
    rows,
    footnote,
    draft_hint: draftHint,
    // D3 (§3.4) — the app-drafts aggregate reports its own shape: which
    // sections answered, whether the read was partial, and how many duplicate
    // rows the SERVER collapsed. Drills that do not produce them leave the
    // fields absent (a day drill has exactly one section).
    partial,
    sections,
    duplicates_dropped: duplicatesDropped,
  } = await readDayDrill(mcp, {
    drillId: id,
    date,
    company,
    env,
  });
  const shown = rows.slice(0, pageSize);
  // D4 (§7 D4: "title phản ánh filter") — a day-scoped drill states the day it
  // read. `drill_screens.<id>.title` is a day-NEUTRAL name (the contract
  // REFUSES a baked-in day word when `day_scoped`), so this is the ONE place
  // the day enters the title: tapping "Hóa đơn" while the summary shows Hôm qua
  // lands on "Hóa đơn đã xuất hôm qua" — not on a screen claiming "hôm nay"
  // over yesterday's rows.
  const dayWord = drill.day_scoped === true ? drillDayWord(date, today) : "";
  return {
    drill: id,
    title: dayWord === "" ? drill.title : `${drill.title} ${dayWord}`,
    date,
    limit: pageSize,
    // Provenance travels with the numbers so the client never has to guess
    // whether these are the shop's books or a fixture (§2.1).
    erp_target: erpTarget,
    generated_at: new Date().toISOString(),
    // The line above the list and the list itself come from the SAME array, so
    // "hiện 10/23" can never disagree with what is on screen.
    summary_lines: summaryLines,
    total_documents: rows.length,
    truncated: rows.length > pageSize,
    rows: shown,
    ...(footnote === undefined ? {} : { footnote }),
    ...(draftHint ? { draft_hint: draftHint } : {}),
    ...(partial === undefined ? {} : { partial }),
    ...(sections === undefined ? {} : { sections }),
    ...(duplicatesDropped === undefined ? {} : { duplicates_dropped: duplicatesDropped }),
  };
}
