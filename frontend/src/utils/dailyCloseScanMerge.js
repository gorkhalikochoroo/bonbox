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

/** Numeric coercion that refuses "", null, undefined and NaN — never 0-fills. */
function toNum(v) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? parseFloat(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}

/**
 * The headline total a scan claims, or null. This is the number that decides
 * whether the "same till or another till?" question is even meaningful.
 */
export function headlineTotal(scan) {
  if (!scan || typeof scan !== "object") return null;
  const direct = toNum(scan.revenue_total);
  if (direct != null && direct > 0) return direct;
  for (const bucket of [scan.revenue, scan.payments]) {
    if (!bucket || typeof bucket !== "object") continue;
    for (const k of TOTAL_KEYS) {
      const v = toNum(bucket[k]);
      if (v != null && v > 0) return v;
    }
  }
  return null;
}

/**
 * True when the owner — not us — has to say what the second scan is.
 * Both scans carrying a headline total is the ONLY ambiguous case.
 */
export function needsTerminalChoice(existing, incoming) {
  return headlineTotal(existing) != null && headlineTotal(incoming) != null;
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
  if (incoming.revenue_total != null) merged.revenue_total = incoming.revenue_total;

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
function sumMerge(existing, incoming) {
  const merged = { ...existing };
  const incomplete = [];

  const sumBucket = (name) => {
    const a = existing[name] || {};
    const b = incoming[name] || {};
    const out = {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
      const av = toNum(a[k]);
      const bv = toNum(b[k]);
      if (av != null && bv != null) out[k] = av + bv;
      else if (av != null) { out[k] = a[k]; incomplete.push(`${name}.${k}`); }
      else if (bv != null) { out[k] = b[k]; incomplete.push(`${name}.${k}`); }
      // Neither side had a usable number → the key simply stays absent.
    }
    return out;
  };
  merged.revenue = sumBucket("revenue");
  merged.payments = sumBucket("payments");

  for (const field of ["revenue_total", "moms_total", "tips", "cash_counted_total"]) {
    const av = toNum(existing[field]);
    const bv = toNum(incoming[field]);
    if (av != null && bv != null) merged[field] = av + bv;
    else if (av != null) { merged[field] = av; incomplete.push(field); }
    else if (bv != null) { merged[field] = bv; incomplete.push(field); }
    else delete merged[field];
  }

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
  const prevTotals = Array.isArray(prevInfo.terminalTotals) && prevInfo.terminalTotals.length
    ? prevInfo.terminalTotals
    : [headlineTotal(existing)].filter((v) => v != null);
  merged.merge_info = {
    mode: MERGE_SUM,
    scans: (prevInfo.scans || 1) + 1,
    terminalTotals: [...prevTotals, headlineTotal(incoming)].filter((v) => v != null),
    incompleteFields: Array.from(new Set([...(prevInfo.incompleteFields || []), ...incomplete])),
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
export function mergeScans(existing, incoming, mode = MERGE_FILL) {
  if (!existing) return incoming;
  if (!incoming) return existing;
  if (mode === MERGE_SUM) return sumMerge(existing, incoming);

  const merged = fillMerge(existing, incoming);
  if (mode === MERGE_REPLACE) {
    // The owner told us this scan supersedes the last one, so the numbers on
    // screen now describe a single till again. Leaving a stale "2 terminals
    // added together" chip over them would be the same lie in reverse.
    merged.merge_info = {
      mode: MERGE_REPLACE,
      scans: 1,
      terminalTotals: [headlineTotal(merged)].filter((v) => v != null),
      incompleteFields: [],
    };
  }
  return merged;
}
