/**
 * dailyCloseScanMerge — how two Z-bon scans become one kasserapport.
 *
 * THE BUG THIS MODULE EXISTS TO KILL:
 * the old inline mergeScans let every incoming field OVERWRITE
 * (`rev[k] = v`, `merged.revenue_total = incoming.revenue_total`) while the
 * copy around it invited the opposite — "tilføj flere sider, så samler vi
 * tallene", an "add another photo" button on the result card, and an anomaly
 * dialog that tells the owner to check that all terminals were scanned. So a
 * café with a bar till and a counter till scanned both, watched the second
 * one silently REPLACE the first, and locked ONE till's revenue into a signed
 * kasserapport. Under the anomaly threshold nothing warned them.
 *
 * We do not guess which it was. We only ask when the question is real — when
 * BOTH scans carry a headline total, which is exactly the ambiguous case. One
 * total + one page of details is the genuine multi-page receipt, and that
 * keeps today's fill-in-the-blanks behaviour with no question asked.
 *
 * Three modes:
 *   MERGE_FILL    — multi-page. Today's behaviour: incoming fills blanks and
 *                   overwrites what it does carry. No question was asked, so
 *                   no merge bookkeeping is touched.
 *   MERGE_REPLACE — "a better photo of the same till". Same mechanics as FILL,
 *                   but it resets the merge bookkeeping to a single terminal,
 *                   because the owner just told us this scan supersedes.
 *   MERGE_SUM     — "another terminal". Sums the numeric leaves and records
 *                   what it could NOT sum instead of inventing a number.
 */

import { moneyInputText, parseMoneyInput } from "./currency";

export const MERGE_FILL = "fill";
export const MERGE_REPLACE = "replace";
export const MERGE_SUM = "sum";

/* Keys a POS export uses for "the big number at the bottom" when it lands
   inside the revenue/payments bucket rather than in revenue_total. */
const TOTAL_KEYS = ["total", "grand_total", "revenue_total", "total_revenue"];

/* Fields that describe ONE terminal and cannot be added together: a card
   breakdown, a note-by-note drawer count, a per-clerk split, the POS provider
   fingerprint. Summing them would fabricate a document that never printed, so
   a sum keeps the FIRST terminal's copy and reports the field as
   single-terminal rather than pretending it covers both. */
const NON_SUMMABLE_FIELDS = [
  "payments_view",
  "cash_denominations",
  "per_clerk",
  "prefill",
  "doc_type",
  "detected_provider",
];

/** Numeric coercion that refuses "", null, undefined and NaN — never 0-fills.
 *
 * The string branch goes through parseMoneyInput, NOT parseFloat, because the
 * values in here are no longer only the backend's JSON numbers. The scan
 * REVIEW boxes on DailyClosePage keep the owner's raw keystrokes — deliberately,
 * so a correction typed as "1.500,50" is not flattened to 1.5005 on its way in
 * — and those strings land in exactly these buckets. parseFloat("1.500,50") is
 * 1.5, so "another terminal — add them up" summed a corrected 1.500,50 as 1,50
 * into a signed kasserapport.
 *
 * parseMoneyInput reads the unambiguous shapes ("1234.56") the same in either
 * locale, so the backend's own numeric strings are unaffected; only the
 * genuinely ambiguous "1.234" needs the account's notation to settle it.
 */
function toNum(v, locale = "da-DK") {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? parseMoneyInput(v, locale) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * The headline total a scan claims, or null. This is the number that decides
 * whether the "same till or another till?" question is even meaningful.
 */
export function headlineTotal(scan, locale = "da-DK") {
  if (!scan || typeof scan !== "object") return null;
  const direct = toNum(scan.revenue_total, locale);
  if (direct != null && direct > 0) return direct;
  for (const bucket of [scan.revenue, scan.payments]) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const k of TOTAL_KEYS) {
      const v = toNum(bucket[k], locale);
      if (v != null && v > 0) return v;
    }
  }
  return null;
}

/** The category lines of a scan added up (a POS "total" key is not a line). */
function lineSum(bucket, locale) {
  const sum = Object.entries(bucket || {})
    .filter(([k]) => !TOTAL_KEYS.includes(k))
    .reduce((a, [, v]) => a + (toNum(v, locale) || 0), 0);
  return Math.round(sum * 100) / 100;
}

/**
 * The total ONE till's card will save — the same rule as the card, the page
 * and the server: a total the owner typed is saved as typed; otherwise the
 * larger of the printed total and the category lines. Null when the scan
 * claims no total (or the owner's box cannot be read).
 *
 * A sum must add THESE, not the printed totals. Mad corrected by hand to
 * 9.500 on a 17.030 bon is a 17.530 till; adding the printed 17.030 to a
 * second till's 5.000 saved 22.030 and dropped the correction — and its MOMS
 * — from a signed kasserapport.
 */
export function scanSaveTotal(scan, locale = "da-DK") {
  const head = headlineTotal(scan, locale);
  if (head == null) return null;
  if (scan.revenue_total_text != null) return head;
  const lines = lineSum(scan.revenue, locale);
  const over = overBonNow(scan, lines);
  return over > 0 ? Math.max(lines, Math.round((head + over) * 100) / 100) : Math.max(head, lines);
}

/**
 * The part of a summed day that its tills' categories carried past their own
 * Z-bon totals (a Mad raised by hand from 9.000 to 9.500 on a 17.030 bon) —
 * as it stands with the merged lines now adding up to `lines`.
 *
 * Once two tills are one card, nobody can tell which till a line belongs to,
 * so the per-till "larger of bon and lines" cannot be redone. Writing each
 * till's figure into revenue_total at the sum made it a floor: setting Mad
 * back to 9.000 still saved 22.530 and MOMS 4.506. The sum now keeps the
 * bons' printed totals in revenue_total and the excess here, with the lines
 * it was measured against: lowering the categories takes the excess back out
 * (down to the bons' totals), and raising them first fills what no category
 * carried yet ("Ikke fordelt") — the single-till rule, on the summed card.
 * Zero for anything that is not a sum with a raised category.
 */
export function overBonNow(scan, lines) {
  const info = scan?.merge_info;
  const over = Number(info?.overBon) || 0;
  if (!scan || info?.mode !== MERGE_SUM || !(over > 0) || scan.revenue_total_text) return 0;
  const n = Number.isFinite(lines) ? lines : 0;
  const lowered = Math.max(0, (Number(info.linesAtSum) || 0) - n);
  return Math.max(0, Math.round((over - lowered) * 100) / 100);
}

/**
 * The total a close saves when its category lines add up to `lines` — the
 * card, the form, the review and the payload read this one rule (the server
 * saves max(breakdown, override), so the override is this figure). A total
 * the owner typed is saved as typed; otherwise the larger of the scan's total
 * and the lines, with a sum's raised categories (overBonNow) on top of the
 * bons' totals.
 */
export function closeSaveTotal(scan, lines, locale = "da-DK") {
  const n = Number.isFinite(lines) ? lines : 0;
  if (scan?.revenue_total_text && Number(scan.revenue_total) > 0) return Number(scan.revenue_total);
  const head = scan ? (headlineTotal(scan, locale) || 0) : 0;
  const over = overBonNow(scan, n);
  if (over > 0) return Math.max(n, Math.round((head + over) * 100) / 100);
  return head > n ? head : n;
}

/**
 * What the Z-bon (or the summed Z-bons) printed as the total — or null once
 * nobody knows: a total the owner typed replaces the printed one in
 * revenue_total, so the card keeps the printed figure in bon_total. A
 * reopened draft's total was saved, not read off a photo, so it is no
 * "Z-bon" figure either.
 */
export function scanBonTotal(scan, locale = "da-DK") {
  if (!scan || typeof scan !== "object") return null;
  if (scan.bon_total != null) return toNum(scan.bon_total, locale);
  // Known to be unknown: a reopened draft merged with a page or a till keeps
  // a total nobody read off a bon (mergeScans writes the null).
  if (Object.prototype.hasOwnProperty.call(scan, "bon_total")) return null;
  if (scan.revenue_total_text != null || scan.from_draft) return null;
  return headlineTotal(scan, locale);
}

/**
 * True when the owner — not us — has to say what the second scan is.
 * Both scans carrying a headline total is the ONLY ambiguous case.
 */
export function needsTerminalChoice(existing, incoming, locale = "da-DK") {
  return (
    headlineTotal(existing, locale) != null && headlineTotal(incoming, locale) != null
  );
}

/** Existing behaviour: count the fields we actually read off the paper. */
function countKnownFields(scan) {
  const vals = [
    ...Object.values(scan.revenue || {}),
    ...Object.values(scan.payments || {}),
    scan.tips,
    scan.moms_total,
    scan.revenue_total,
  ];
  return vals.filter((v) => v !== null && v !== undefined && v !== "").length;
}

function confidenceFor(scan) {
  const found = countKnownFields(scan);
  return found >= 3 ? "high" : found >= 1 ? "medium" : "low";
}

/* A sum we know is incomplete must not read as a confident number. */
const ONE_NOTCH_DOWN = { high: "medium", medium: "low", low: "low" };

/** Today's merge: incoming wins where it has a value, existing fills the rest. */
function fillMerge(existing, incoming) {
  const merged = { ...existing };

  const rev = { ...(existing.revenue || {}) };
  Object.entries(incoming.revenue || {}).forEach(([k, v]) => { if (v != null) rev[k] = v; });
  merged.revenue = rev;

  const pay = { ...(existing.payments || {}) };
  Object.entries(incoming.payments || {}).forEach(([k, v]) => { if (v != null) pay[k] = v; });
  merged.payments = pay;

  if (incoming.tips != null) merged.tips = incoming.tips;
  if (incoming.moms_total != null) merged.moms_total = incoming.moms_total;
  if (incoming.revenue_total != null) {
    merged.revenue_total = incoming.revenue_total;
    // The new page's total is the printed one now.
    delete merged.bon_total;
  }

  // Rich Z-report fields — last scan wins (typical retake = better photo).
  if (incoming.prefill) merged.prefill = incoming.prefill;
  if (incoming.cash_denominations) merged.cash_denominations = incoming.cash_denominations;
  if (incoming.cash_counted_total != null) merged.cash_counted_total = incoming.cash_counted_total;
  if (incoming.per_clerk) merged.per_clerk = incoming.per_clerk;
  if (incoming.doc_type) merged.doc_type = incoming.doc_type;
  if (incoming.payments_view) merged.payments_view = incoming.payments_view;
  // POS terminal auto-detect — a clearer header may flip null → a real
  // provider chip, so we always overwrite (including with null).
  if ("detected_provider" in incoming) merged.detected_provider = incoming.detected_provider;

  merged.raw_text = ((existing.raw_text || "") + "\n---\n" + (incoming.raw_text || "")).slice(0, 2000);
  merged.terminal_raw_texts = [
    ...(existing.terminal_raw_texts || [existing.raw_text || ""]),
    incoming.raw_text || "",
  ];
  merged.ocr_available = true;
  merged.confidence = confidenceFor(merged);
  return merged;
}

/**
 * Sum two tills. Every numeric leaf we can add, we add. Every field where only
 * ONE of the two scans had a number is carried over unchanged and listed in
 * merge_info.incompleteFields, because "terminal 2's MOMS line was unreadable"
 * and "terminal 2 had no MOMS" are different facts and we cannot tell them
 * apart from a photo. Nothing missing ever becomes 0.
 */
function sumMerge(existing, incoming, locale = "da-DK", bonA = scanBonTotal(existing, locale)) {
  const merged = { ...existing };
  const incomplete = [];

  const sumBucket = (name) => {
    const a = existing[name] || {};
    const b = incoming[name] || {};
    const out = {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const av = toNum(a[k], locale);
      const bv = toNum(b[k], locale);
      if (av != null && bv != null) out[k] = av + bv;
      // Carry the PARSED number over, not the raw cell. A one-sided field used
      // to keep `a[k]` verbatim, so an owner-typed "1.500,50" survived into a
      // bucket every downstream reader treats as numeric.
      else if (av != null) { out[k] = av; incomplete.push(`${name}.${k}`); }
      else if (bv != null) { out[k] = bv; incomplete.push(`${name}.${k}`); }
      // Neither side had a usable number → the key simply stays absent.
    }
    return out;
  };
  merged.revenue = sumBucket("revenue");
  merged.payments = sumBucket("payments");

  // A total the owner typed is the figure, so a sum with one adds what each
  // card saves (scanSaveTotal) and stays a typed total. Otherwise the printed
  // totals are added and each till's categories raised past its bon are kept
  // apart (merge_info.overBon, below) — added in, but taken back out when the
  // owner lowers the categories again. A box nobody can read stays
  // unreadable (null), never a guess.
  const typedTotal = existing.revenue_total_text != null || incoming.revenue_total_text != null;
  const tillTotal = (scan) => {
    const printed = toNum(scan.revenue_total, locale);
    if (printed == null || !typedTotal) return printed;
    return scanSaveTotal(scan, locale) ?? printed;
  };
  const overOf = (scan) => {
    const printed = toNum(scan.revenue_total, locale);
    const save = scanSaveTotal(scan, locale);
    return printed == null || save == null ? 0 : Math.max(0, Math.round((save - printed) * 100) / 100);
  };
  const overBon = typedTotal ? 0 : Math.round((overOf(existing) + overOf(incoming)) * 100) / 100;
  for (const field of ["revenue_total", "moms_total", "tips", "cash_counted_total"]) {
    const av = field === "revenue_total" ? tillTotal(existing) : toNum(existing[field], locale);
    const bv = field === "revenue_total" ? tillTotal(incoming) : toNum(incoming[field], locale);
    if (av != null && bv != null) merged[field] = av + bv;
    else if (av != null) { merged[field] = av; incomplete.push(field); }
    else if (bv != null) { merged[field] = bv; incomplete.push(field); }
    else delete merged[field];
  }
  // A total the owner corrected by hand is kept as their keystrokes, and the
  // "Samlet omsætning" box shows those first. `{ ...existing }` carried till
  // 1's "16.450" over unchanged, so the box read 16.450 under a 21.450 sum —
  // and editing it then dropped till 2. The box now holds the sum. The text
  // stays (rather than being deleted) because it is also what marks the
  // scanned MOMS as stale: it belonged to till 1's misread total.
  // Only when both tills' totals were read: a box holding text nobody could
  // read ("16.45O") must stay red and block the lock, not turn into till 2's
  // figure as if it were the sum.
  if (existing.revenue_total_text != null && merged.revenue_total != null
    && toNum(existing.revenue_total, locale) != null && toNum(incoming.revenue_total, locale) != null) {
    merged.revenue_total_text = moneyInputText(Math.round(merged.revenue_total * 100) / 100, locale);
  }

  // What the Z-bons printed, added up — the figure the summed MOMS belongs
  // to. When a till saves more (or less) than its bon, the saved total moves
  // off it and the MOMS is worked out again instead of summed.
  // Not known for either one (a reopened draft's saved total, a typed one
  // with no bon behind it) is not known for the sum: null, not absent —
  // absent let the summed total pass for a Z-bon figure.
  const bonB = scanBonTotal(incoming, locale);
  if (bonA != null && bonB != null) merged.bon_total = Math.round((bonA + bonB) * 100) / 100;
  else merged.bon_total = null;

  // Per-terminal documents: keep the first terminal's, say so when the second
  // one also had data we are not folding in.
  for (const field of NON_SUMMABLE_FIELDS) {
    const incomingHas = incoming[field] !== null && incoming[field] !== undefined;
    const existingHas = existing[field] !== null && existing[field] !== undefined;
    if (incomingHas && existingHas) incomplete.push(field);
    else if (incomingHas && !existingHas) merged[field] = incoming[field];
  }

  // Per-terminal raw text is the audit trail for a summed number — the owner
  // (and the revisor) must be able to see which paper each half came from.
  merged.terminal_raw_texts = [
    ...(existing.terminal_raw_texts || [existing.raw_text || ""]),
    incoming.raw_text || "",
  ];
  merged.raw_text = ((existing.raw_text || "") + "\n---\n" + (incoming.raw_text || "")).slice(0, 2000);
  merged.ocr_available = true;

  const prevInfo = existing.merge_info || {};
  // Per till, the figure its card said it would save — so the line reads
  // "17.530 + 5.000 = 22.530", the sum that is saved. An earlier sum's
  // per-till figures only while they still add up to what that card saves
  // now: a "same till" photo wrote [17.030], and a Mad raised to 9.500 after
  // it made the line read 17.030 + 5.000 under a saved 22.530.
  const existingSave = scanSaveTotal(existing, locale);
  const prevTotals = prevInfo.mode === MERGE_SUM && Array.isArray(prevInfo.terminalTotals)
    && prevInfo.terminalTotals.length && existingSave != null
    && Math.abs(prevInfo.terminalTotals.reduce((a, v) => a + (Number(v) || 0), 0) - existingSave) < 0.005
    ? prevInfo.terminalTotals
    : [existingSave].filter((v) => v != null);
  merged.merge_info = {
    mode: MERGE_SUM,
    scans: (prevInfo.scans || 1) + 1,
    terminalTotals: [...prevTotals, scanSaveTotal(incoming, locale)].filter((v) => v != null),
    incompleteFields: Array.from(new Set([...(prevInfo.incompleteFields || []), ...incomplete])),
    ...(overBon > 0 ? { overBon, linesAtSum: lineSum(merged.revenue, locale) } : {}),
  };

  const base = confidenceFor(merged);
  merged.confidence = merged.merge_info.incompleteFields.length ? ONE_NOTCH_DOWN[base] : base;
  return merged;
}

/**
 * Merge an incoming scan into the one we already have.
 *
 * @param {object|null} existing
 * @param {object} incoming
 * @param {"fill"|"replace"|"sum"} [mode=MERGE_FILL]
 */
export function mergeScans(existing, incoming, mode = MERGE_FILL, locale = "da-DK") {
  if (!existing) return incoming;
  if (!incoming) return existing;
  // Read before the draft mark goes: a reopened draft's total is no bon's.
  const existingBon = scanBonTotal(existing, locale);
  // A photo went into it, so it is a read again: the reopened draft's
  // "not read" mark hid that photo's confidence and its missing lines.
  const wasDraft = Boolean(existing.from_draft);
  if (wasDraft) {
    existing = { ...existing };
    delete existing.from_draft;
    // …but its total is still the saved one, not a bon's: say so, or the
    // card and the review called it "Z-bon: 17.030" once a page went in.
    existing.bon_total = null;
  }
  if (mode === MERGE_SUM) return sumMerge(existing, incoming, locale, existingBon);

  // "Same till — use the new photo" means the new photo IS the figures.
  // Filling gaps from the old one kept its MobilePay 1.000 on top of the new
  // photo's payments (4.950 paid against a 3.950 total).
  const merged = mode === MERGE_REPLACE ? { ...incoming } : fillMerge(existing, incoming);
  if (mode === MERGE_REPLACE) {
    // The owner told us this scan supersedes the last one, so the numbers on
    // screen now describe a single till again. Leaving a stale "2 terminals
    // added together" chip over them would be the same lie in reverse.
    merged.merge_info = {
      mode: MERGE_REPLACE,
      scans: 1,
      terminalTotals: [scanSaveTotal(merged, locale)].filter((v) => v != null),
      incompleteFields: [],
    };
  }
  return merged;
}
