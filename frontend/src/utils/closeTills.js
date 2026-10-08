/**
 * closeTills — what the day is made of, in ONE place.
 *
 * THE BUG CLASS THIS MODULE EXISTS TO KILL:
 * rounds 13–16 each fixed one two-till case and opened another, because the
 * same figures lived in two places — the scan card (one merged scan) and the
 * form's boxes — and were folded back and forth between them. A typed close
 * summed with a 3.000 bon, applied, then "Start forfra": the boxes still held
 * the sum, the next photo took them as the owner's own first side, and the
 * same bon was counted twice (20.000 saved for a 17.000 day, MOMS 4.000 for
 * 3.400) behind a review that said "Omsætning og betalinger stemmer".
 *
 * Here the day is an ordered list of tills, each with its own figures, and
 * everything else — the card, the boxes, the question, Fortryd, Start forfra,
 * the payload's source and MOMS — is read off it.
 *
 * State (immutable: an action returns a new object, or the same one when
 * nothing changed):
 *   entries  every till and page, in arrival order. origin "typed" (the form,
 *            typed by hand), "draft" (a reopened close) or "scan" (a photo).
 *            join "base" | "sum" (another terminal) | "fill" (a page of the
 *            till before it) | "replace" ("same terminal — use the new
 *            photo": everything before it is superseded, not deleted, so
 *            Start forfra can bring a typed till back). A till's own figures
 *            are `scan`; the owner's changes to it are `edits`, applied on
 *            top — so throwing a photo away takes its corrections with it,
 *            and nothing else.
 *   pending  photos waiting on "another terminal or the same?".
 *   undo     one snapshot per step — undo is exactly one step back.
 *   overlay  the owner's keystrokes on a line several tills carry: the
 *            difference goes to one till, the box keeps what was typed.
 *   overlayBase  per overlaid line, the tills' own figures for it before
 *            the first keystroke — every keystroke is worked out from
 *            these, so the split depends on the figure typed, never on
 *            how it was typed ("9" on the way to "9.000" moved nothing).
 *   ownBase  the owner's own till as it was when the day's first photo came
 *            in — Start forfra gives it back exactly that way.
 *   mirror   the form's boxes show this ledger (applied, typed, a draft) —
 *            so Start forfra and Fortryd may write them back.
 *
 * Pure: no React, no I/O. The page keeps it in a ref + state and calls these.
 */

import {
  MERGE_FILL, MERGE_REPLACE, MERGE_SUM, TOTAL_KEYS,
  headlineTotal, mergeScans, scanBonTotal, scanSaveTotal,
} from "./dailyCloseScanMerge";
import { moneyInputText, parseMoneyInput } from "./currency";

export const TILL_TYPED = "typed";
export const TILL_DRAFT = "draft";
export const TILL_SCAN = "scan";

const JOIN_BASE = "base";
const JOIN_SUM = "sum";
const JOIN_FILL = "fill";
const JOIN_REPLACE = "replace";

const EMPTY = Object.freeze({});
const UNDO_DEPTH = 30;

/* ─── small pure helpers ─────────────────────────────────────────────── */

/** A money figure, or null — never a 0 for "nothing there". */
function num(v, locale) {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "string" ? parseMoneyInput(v, locale) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : null;
}
const r2 = (n) => Math.round(n * 100) / 100;
const filled = (v) => v !== null && v !== undefined && String(v).trim() !== "";
const hasOwn = (o, k) => Boolean(o) && Object.prototype.hasOwnProperty.call(o, k);

function lineSum(bucket, locale) {
  return r2(Object.entries(bucket || {})
    .filter(([k]) => !TOTAL_KEYS.includes(k))
    .reduce((a, [, v]) => a + (num(v, locale) || 0), 0));
}

/** "revenue.food" → scan.revenue.food; "tips" → scan.tips. */
export function fieldOf(scan, field) {
  if (!scan) return undefined;
  const i = field.indexOf(".");
  return i < 0 ? scan[field] : scan[field.slice(0, i)]?.[field.slice(i + 1)];
}

/**
 * One field set the way the owner typed it. The total box keeps the bon's
 * printed figure beside the typed one (bon_total), exactly as the card did.
 */
function withField(scan, field, value, locale) {
  const i = field.indexOf(".");
  if (i < 0) {
    if (field === "revenue_total") {
      const n = num(value, locale);
      const bon = scanBonTotal(scan, locale);
      return {
        ...scan,
        ...(bon != null ? { bon_total: bon } : {}),
        revenue_total_text: value,
        revenue_total: n != null && n > 0 ? n : null,
      };
    }
    return { ...scan, [field]: value };
  }
  const bucket = field.slice(0, i);
  return { ...scan, [bucket]: { ...(scan[bucket] || {}), [field.slice(i + 1)]: value } };
}

function applyEdits(scan, edits, locale) {
  if (!edits || edits === EMPTY) return scan;
  let out = scan;
  // The total last: its bon figure is read before the text replaces it.
  Object.entries(edits).filter(([f]) => f !== "revenue_total").forEach(([f, v]) => { out = withField(out, f, v, locale); });
  if (Object.prototype.hasOwnProperty.call(edits, "revenue_total")) out = withField(out, "revenue_total", edits.revenue_total, locale);
  return out;
}

/** The money lines a scan carries, as field names. */
function linesCarried(scan, locale) {
  const out = new Set();
  ["revenue", "payments"].forEach((b) => Object.entries(scan?.[b] || {}).forEach(([k, v]) => {
    if (!TOTAL_KEYS.includes(k) && filled(v)) out.add(`${b}.${k}`);
  }));
  if (filled(scan?.tips)) out.add("tips");
  if (num(scan?.moms_total, locale) != null) out.add("moms_total");
  return out;
}

/** The form's side written down as the form's: nothing of it reads as a Z-bon read. */
function markFormSide(s, locale) {
  const fields = [...linesCarried(s, locale)];
  if (!fields.length) return s;
  const prev = s.merge_info || {};
  const union = (a) => Array.from(new Set([...(a || []), ...fields]));
  return { ...s, merge_info: { ...prev, formFields: union(prev.formFields), typedFields: union(prev.typedFields) } };
}

/* ─── the state ──────────────────────────────────────────────────────── */

export function createTills(locale = "da-DK") {
  return { locale, seq: 0, entries: [], pending: [], undo: [], overlay: EMPTY, overlayBase: EMPTY, ownBase: null, mirror: false, day: null };
}

const nextId = (state) => `t${state.seq + 1}`;
const snapshot = (state, kind) => ({
  kind, entries: state.entries, pending: state.pending, overlay: state.overlay,
  overlayBase: state.overlayBase || EMPTY, ownBase: state.ownBase || null,
});
const pushUndo = (state, kind) => [...state.undo, snapshot(state, kind)].slice(-UNDO_DEPTH);

/* Selectors are memoised per state object: a keystroke makes one new state
   and the card is folded once for it, however many readers ask. */
const memo = new WeakMap();
function cached(state, key, fn) {
  let box = memo.get(state);
  if (!box) { box = {}; memo.set(state, box); }
  if (!(key in box)) box[key] = fn();
  return box[key];
}

export function activeEntries(state) {
  return cached(state, "active", () => state.entries.filter((e) => !e.replacedBy));
}

/** The non-scan till still in the day (the typed form or the reopened draft), or null. */
export function formTill(state) {
  return activeEntries(state).find((e) => e.origin !== TILL_SCAN) || null;
}

export function hasScanTills(state) {
  return activeEntries(state).some((e) => e.origin === TILL_SCAN);
}

/** Tills: an entry that is not a page of the one before starts a new till. */
export function tillGroups(state) {
  return cached(state, "groups", () => {
    const groups = [];
    activeEntries(state).forEach((e) => {
      if (!groups.length || e.join !== JOIN_FILL) groups.push([e]);
      else groups[groups.length - 1].push(e);
    });
    return groups;
  });
}

/**
 * A non-scan till as a scan-shaped card side. Its total is what its lines add
 * up to (payments when there is no line yet — "the figure on screen"), or a
 * reopened draft's saved total when that is not its lines (the floor). As the
 * first side of more than itself it is marked as the form's.
 */
function formSideScan(entry, locale, first) {
  let s = applyEdits(entry.scan, entry.edits, locale);
  if (s.revenue_total_text == null) {
    const lines = lineSum(s.revenue, locale);
    const own = entry.floor != null ? entry.floor : (lines > 0 ? lines : lineSum(s.payments, locale));
    s = { ...s, revenue_total: r2(own) };
  }
  s = { ...s, from_draft: true };
  if (!first) {
    // Alone, a reopened draft's card is its total and lines — its MOMS is the
    // form's box, not a figure on a card.
    const { moms_total: _m, ...rest } = s;
    return rest;
  }
  return markFormSide(s, locale);
}

/** One till: its entry, then each page filling it, each followed by the owner's changes. */
function foldGroup(group, state) {
  const { locale } = state;
  let acc = null;
  group.forEach((e) => {
    let own = e.origin === TILL_SCAN ? e.scan : formSideScan(e, locale, true);
    if (acc == null && e.join === JOIN_REPLACE) {
      own = { ...own, merge_info: {
        mode: MERGE_REPLACE, scans: 1,
        terminalTotals: [scanSaveTotal(own, locale)].filter((v) => v != null),
        incompleteFields: [],
      } };
    }
    acc = acc ? mergeScans(acc, own, MERGE_FILL, locale) : own;
    if (e.origin === TILL_SCAN) acc = applyEdits(acc, e.edits, locale);
  });
  return acc;
}

/** Each till as a card side, folded once per state. */
function groupScans(state) {
  return cached(state, "groupScans", () => {
    return tillGroups(state).map((g) => foldGroup(g, state));
  });
}

/** What one till saves: its typed total, else the larger of its total and its lines. */
function scanTotalOf(s, locale) {
  return scanSaveTotal(s, locale) ?? lineSum(s?.revenue, locale);
}

/** Each till's figure, as it stands now. */
export function tillTotals(state) {
  return cached(state, "tillTotals", () => groupScans(state).map((s) => r2(scanTotalOf(s, state.locale) || 0)));
}

/**
 * The scan card: the tills folded with the merge rules. Null when nothing is
 * on a card (no scan, and no reopened draft whose saved total is not its lines).
 */
export function cardView(state) {
  return cached(state, "card", () => {
    const groups = tillGroups(state);
    if (!groups.length) return null;
    const { locale } = state;
    const multi = activeEntries(state).length > 1;
    if (!multi && groups[0][0].origin !== TILL_SCAN) {
      const e = groups[0][0];
      // A photo waits on "another terminal or the same?": the owner's own
      // till is "the one on screen", as the form's side of the question.
      if (state.pending.length) return formSideScan(e, locale, true);
      // A total typed for the owner's till is on a card — never held out of
      // sight while the boxes and the review show its lines.
      const card = e.floor != null || e.scan.revenue_total_text != null
        || Object.prototype.hasOwnProperty.call(e.edits, "revenue_total");
      return card ? formSideScan(e, locale, false) : null;
    }
    const scans = groupScans(state);
    let acc = scans[0];
    for (let i = 1; i < scans.length; i++) acc = mergeScans(acc, scans[i], MERGE_SUM, locale);
    if (scans.length > 1) {
      // The merge line reads what each till brought when it was added — and
      // says so when the day has moved since ("med dine rettelser …").
      const lastSum = [...activeEntries(state)].reverse().find((e) => e.join === JOIN_SUM);
      if (lastSum?.atJoin && lastSum.atJoin.length === scans.length) {
        acc = { ...acc, merge_info: { ...acc.merge_info, terminalTotals: lastSum.atJoin } };
      }
      // A total typed on any till keeps the day's total a typed one.
      if (acc.revenue_total_text == null && acc.revenue_total != null
        && scans.some((s) => s.revenue_total_text != null)) {
        acc = { ...acc, revenue_total_text: moneyInputText(acc.revenue_total, locale) };
      }
    }
    if (state.overlay !== EMPTY) acc = applyEdits(acc, state.overlay, locale);
    return acc;
  });
}

/** What the boxes show: the tills' lines added up (the card's, or the lone form till's). */
export function formValues(state) {
  return cached(state, "form", () => {
    const card = cardView(state);
    const lone = !card && tillGroups(state).length ? groupScans(state)[0] : null;
    const src = card || lone;
    if (!src) return { revenue: {}, payments: {}, tips: null };
    return { revenue: { ...(src.revenue || {}) }, payments: { ...(src.payments || {}) }, tips: src.tips ?? null };
  });
}

/**
 * The total the day saves: what each till saves, added up. One till saves its
 * typed total, else the larger of its own total and its own lines — so a
 * till's lines never fill another till's unsplit total, and a correction on
 * one till moves that till only. (For a single till this is the card's own
 * rule, closeSaveTotal.)
 */
export function savedTotal(state) {
  return cached(state, "saved", () => r2(tillTotals(state).reduce((a, v) => a + v, 0)));
}

/**
 * Ask "another terminal or the same?" whenever the day already holds a till
 * with figures and the new photo has its own total. A page with no total of
 * its own is the genuine multi-page receipt: it fills, no question.
 */
export function needsTerminalQuestion(state, incoming) {
  if (headlineTotal(incoming, state.locale) == null) return false;
  // A till "with figures" has a total of its own: a typed or reopened close,
  // or a photo that printed one. A first page of lines with no total is the
  // top of a receipt whose total is still to come.
  // Whatever its total box holds now: a Z-bon whose total the owner emptied
  // (or retyped) is still a till with a total — it folded the next till's
  // bon in as a page of it, and one till's money was gone.
  return groupScans(state).some((s) => (scanSaveTotal(s, state.locale) || 0) > 0
    || s.revenue_total_text != null || (num(s.bon_total, state.locale) || 0) > 0);
}

/**
 * The same photo (its ref) or the same scan id is the same scan — however it
 * was read this time. Every pick runs the OCR again and an LLM read can
 * differ a little between runs (a "MobilePay 0" more): that is still the one
 * photo, never a second till.
 */
export function isDuplicateScan(state, { id = null, photo = null } = {}) {
  const all = [...activeEntries(state).filter((e) => e.origin === TILL_SCAN), ...state.pending];
  return all.some((e) => (id != null && e.scanId === id) || (photo != null && e.photo === photo));
}

/* ─── the form as a till ─────────────────────────────────────────────── */

/**
 * The form's boxes as a till — what the owner typed, or a reopened draft
 * holds. Not the sales sync's own figures (an untouched POS sync is not a
 * till: a Z-bon replaces it as it always has). Once any box is the owner's,
 * the whole form is. Null when the form holds nothing of the owner's.
 */
export function tillFromForm({ revenue = {}, payments = {}, tips = null, moms = null, synced = null, locale = "da-DK" } = {}) {
  const owners = (boxes, fill) => Object.entries(boxes || {}).some(([k, v]) => filled(v) && !(fill && fill[k] === v));
  if (!owners(revenue, synced?.rev) && !owners(payments, synced?.pay)) return null;
  const keep = (b) => Object.fromEntries(Object.entries(b || {}).filter(([, v]) => filled(v)));
  const rev = keep(revenue);
  const pay = keep(payments);
  const total = lineSum(rev, locale) > 0 ? lineSum(rev, locale) : lineSum(pay, locale);
  if (!(total > 0)) return null;
  const m = num(moms, locale);
  return { revenue: rev, payments: pay, ...(filled(tips) ? { tips } : {}), ...(m != null ? { moms_total: r2(m) } : {}) };
}

/**
 * Before the first photo of a day the form is the truth; at the photo it
 * becomes the first till. A reopened draft keeps its saved total (and a
 * total typed over it); a typed till with nothing left in it goes.
 */
function seedFromForm(state, form) {
  // A photo already in the day (one waiting on the question counts): the
  // boxes may still show an answer taken back with Fortryd — never re-read
  // them as the owner's own till.
  if (form === undefined || hasScanTills(state) || state.pending.length) return state;
  const ft = formTill(state);
  if (form == null) {
    if (!ft || ft.floor != null || ft.scan.revenue_total_text != null) return state;
    return { ...state, entries: state.entries.filter((e) => e !== ft) };
  }
  if (!ft) {
    const entry = { id: nextId(state), origin: TILL_TYPED, join: JOIN_BASE, scan: form, edits: EMPTY, photo: null, scanId: null, replacedBy: null, floor: null, meta: null };
    return { ...state, seq: state.seq + 1, entries: [...state.entries, entry] };
  }
  const { revenue: _r, payments: _p, tips: _t, moms_total: _m, ...kept } = ft.scan;
  const totalEdit = Object.prototype.hasOwnProperty.call(ft.edits, "revenue_total") ? { revenue_total: ft.edits.revenue_total } : EMPTY;
  const next = { ...ft, scan: { ...kept, ...form }, edits: totalEdit };
  return { ...state, entries: state.entries.map((e) => (e === ft ? next : e)) };
}

/* ─── actions ────────────────────────────────────────────────────────── */

/**
 * A photo was read. `form` (optional) is the form as a till right now
 * (tillFromForm) — used only while no photo is in the day yet.
 */
export function addScan(state, scan, { id = null, photo = null, form } = {}) {
  if (!scan || typeof scan !== "object") return state;
  if (isDuplicateScan(state, { id, photo })) return state;
  let seeded = { ...seedFromForm(state, form), overlay: EMPTY, overlayBase: EMPTY };
  // The day's first photo: the owner's till as it is now is what Start
  // forfra gives back — whatever is distributed into it while photos are in.
  if (!hasScanTills(state) && !state.pending.length) seeded = { ...seeded, ownBase: formTill(seeded) };
  const entryId = nextId(seeded);
  const base = { id: entryId, origin: TILL_SCAN, scan, edits: EMPTY, photo, scanId: id, replacedBy: null };
  // Once any photo waits on the owner, every later one waits behind it.
  if (seeded.pending.length || needsTerminalQuestion(seeded, scan)) {
    return { ...seeded, seq: seeded.seq + 1, pending: [...seeded.pending, base], undo: pushUndo(state, "queue") };
  }
  const active = activeEntries(seeded);
  // An empty typed till carried nothing to fill: the photo is the day.
  const hollow = active.length && !tillTotals(seeded).some((v) => v > 0) && active.every((e) => e.origin !== TILL_SCAN)
    && active.every((e) => e.floor == null);
  const entries = hollow ? seeded.entries.filter((e) => e.origin === TILL_SCAN || e.replacedBy) : seeded.entries;
  const join = active.length && !hollow ? JOIN_FILL : JOIN_BASE;
  return { ...seeded, seq: seeded.seq + 1, entries: [...entries, { ...base, join }], undo: pushUndo(state, join === JOIN_FILL ? "page" : "scan") };
}

/** The owner answered: "another terminal" (sum) or "same terminal" (replace). */
export function chooseTerminal(state, mode) {
  const [head, ...rest] = state.pending;
  if (!head || (mode !== MERGE_SUM && mode !== MERGE_REPLACE)) return state;
  let entries = state.entries;
  if (mode === MERGE_REPLACE) entries = entries.map((e) => (e.replacedBy ? e : { ...e, replacedBy: head.id }));
  const entry = { ...head, join: mode === MERGE_SUM ? JOIN_SUM : JOIN_REPLACE };
  let next = { ...state, entries: [...entries, entry], pending: rest, overlay: EMPTY, overlayBase: EMPTY, undo: pushUndo(state, mode) };
  if (mode === MERGE_SUM) {
    const atJoin = tillTotals(next);
    next = { ...next, entries: next.entries.map((e) => (e.id === entry.id ? { ...e, atJoin } : e)) };
  }
  // What is still queued and NOT ambiguous against the new day folds in now:
  // one till photo plus two detail pages costs exactly one tap.
  while (next.pending.length && !needsTerminalQuestion(next, next.pending[0].scan)) {
    const [p, ...more] = next.pending;
    next = { ...next, entries: [...next.entries, { ...p, join: JOIN_FILL }], pending: more };
  }
  return next;
}

/* Where a change to a line lands inside one till: the entry whose figure the
   till shows for it (the last one carrying it), else the form's own entry
   (a new line the owner adds is theirs), else the till's last photo. */
function winnerIn(group, field) {
  const carries = (e) => filled(fieldOf(e.scan, field)) || Object.prototype.hasOwnProperty.call(e.edits, field)
    || (field === "revenue_total" && e.scan.revenue_total != null);
  for (let i = group.length - 1; i >= 0; i--) if (carries(group[i])) return group[i];
  return group.find((e) => e.origin !== TILL_SCAN) || group[group.length - 1];
}

function setEdit(state, entry, field, value) {
  const read = fieldOf(entry.scan, field);
  const n = num(value, state.locale);
  // Typed back to what the photo read: it is the read again (and keeps
  // "aflæst"), not a correction.
  if (field !== "revenue_total" && typeof read === "number" && n != null && Math.abs(n - read) < 0.005) {
    if (!Object.prototype.hasOwnProperty.call(entry.edits, field)) return state;
    const { [field]: _gone, ...rest } = entry.edits;
    const next = { ...entry, edits: Object.keys(rest).length ? rest : EMPTY };
    return { ...state, entries: state.entries.map((e) => (e === entry ? next : e)) };
  }
  const next = { ...entry, edits: { ...entry.edits, [field]: value } };
  return { ...state, entries: state.entries.map((e) => (e === entry ? next : e)) };
}

/**
 * The share of a change each till takes, when several carry the line.
 * Revenue: raising first fills what a till's categories had not split yet
 * ("Ikke fordelt"), then goes to the owner's own till (or the last one);
 * lowering first takes back what a till carried past its bon, then the
 * owner's own figure, then the others — never below 0 per till.
 * Payments and tips: the owner's till first, then the last carrying it.
 */
function distribute(state, field, delta) {
  const { locale } = state;
  const scans = groupScans(state);
  const groups = tillGroups(state);
  const isRev = field.startsWith("revenue.");
  const own = groups.findIndex((g) => g.some((e) => e.origin !== TILL_SCAN));
  const cur = scans.map((s) => num(fieldOf(s, field), locale) || 0);
  const carries = scans.map((s) => num(fieldOf(s, field), locale) != null);
  const shares = scans.map(() => 0);
  const last = scans.length - 1;
  const lastCarrying = carries.lastIndexOf(true);
  let rem = r2(delta);
  // While the day's total is typed, the categories are only its split: the
  // till holding a typed total takes the whole change, and no till's total
  // moves under the figure the owner typed.
  const typedTotal = isRev ? scans.map((s) => s.revenue_total_text != null).lastIndexOf(true) : -1;
  if (typedTotal >= 0) {
    const t = own >= 0 && scans[own].revenue_total_text != null ? own : typedTotal;
    shares[t] = rem;
    return { cur, shares };
  }
  if (rem > 0) {
    if (isRev) {
      for (let i = last; i >= 0 && rem > 0.004; i--) {
        if (scans[i].revenue_total_text != null) continue;
        const room = Math.max(0, r2((scanTotalOf(scans[i], locale) || 0) - lineSum(scans[i].revenue, locale)));
        const take = Math.min(room, rem);
        if (take > 0) { shares[i] += take; rem = r2(rem - take); }
      }
    }
    if (rem > 0.004) shares[own >= 0 ? own : (lastCarrying >= 0 ? lastCarrying : last)] += rem;
  } else if (rem < 0) {
    let need = -rem;
    const avail = (i) => Math.max(0, r2(cur[i] + shares[i]));
    const take = (i, cap = Infinity) => {
      const t = Math.min(avail(i), cap, need);
      if (t > 0) { shares[i] = r2(shares[i] - t); need = r2(need - t); }
    };
    if (isRev) {
      for (let i = last; i >= 0 && need > 0.004; i--) {
        if (!carries[i] || scans[i].revenue_total_text != null) continue;
        const printed = headlineTotal(scans[i], locale);
        if (printed == null) continue;
        take(i, Math.max(0, r2(lineSum(scans[i].revenue, locale) - printed)));
      }
    }
    if (own >= 0 && carries[own] && need > 0.004) take(own);
    for (let i = last; i >= 0 && need > 0.004; i--) if (carries[i]) take(i);
    if (need > 0.004) shares[own >= 0 ? own : last] = r2(shares[own >= 0 ? own : last] - need);
  }
  return { cur, shares };
}

/**
 * The owner typed into a box (the form's or the card's). With one till the
 * figure goes in as typed. With several, each till's share is worked out
 * (distribute) and the box keeps the keystrokes (overlay). With none, the
 * form becomes the first till — from `form`, the whole form, when given.
 */
export function typeIntoForm(state, field, value, { form, fromForm = false } = {}) {
  const { locale } = state;
  const mirror = fromForm ? true : state.mirror;
  const active = activeEntries(state);
  if (!active.length) {
    const scan = form || withField({ revenue: {}, payments: {} }, field, value, locale);
    const entry = { id: nextId(state), origin: TILL_TYPED, join: JOIN_BASE, scan, edits: EMPTY, photo: null, scanId: null, replacedBy: null, floor: null, meta: null };
    return { ...state, seq: state.seq + 1, entries: [...state.entries, entry], overlay: EMPTY, overlayBase: EMPTY, mirror };
  }
  const groups = tillGroups(state);
  if (groups.length === 1) {
    const next = setEdit(state, winnerIn(groups[0], field), field, value);
    return { ...next, mirror };
  }
  const n = num(value, locale);
  const overlay = { ...state.overlay, [field]: value };
  // The box hands over every keystroke ("9", "9.", "9.0" … "9.000"). Each one
  // is worked out from the tills as they stood before the FIRST keystroke on
  // this line, with the whole difference — never from what the keystroke
  // before left behind. Otherwise a low "9" on the way took money out of the
  // owner's till, and the final raise filled a bon's unsplit room instead:
  // the same 9.000 retyped moved 4.000 kr. out of the signed close.
  const prevBase = state.overlayBase || EMPTY;
  const known = hasOwn(prevBase, field);
  const base = known ? prevBase[field] : fieldEdits(state, field);
  const overlayBase = known ? prevBase : { ...prevBase, [field]: base };
  const from = withFieldEdits(state, field, base);
  // Not an amount yet (or the total emptied): the box says so and blocks the
  // lock; the tills keep their figures from before the typing began.
  if ((filled(value) && n == null) || (field === "revenue_total" && n == null)) return { ...from, overlay, overlayBase, mirror };
  const fromGroups = tillGroups(from);
  const scans = groupScans(from);
  if (field === "revenue_total") {
    // The day's total typed: the owner's till (or the last) takes the
    // difference. Typed below what the other tills save, each till takes its
    // share instead — no till is left with a total of nothing.
    const totals = tillTotals(from);
    const own = fromGroups.findIndex((g) => g.some((e) => e.origin !== TILL_SCAN));
    const t = own >= 0 ? own : fromGroups.length - 1;
    const residual = r2(n - totals.reduce((a, v, i) => (i === t ? a : a + v), 0));
    const sum = totals.reduce((a, v) => a + v, 0);
    let shares;
    if (residual > 0.004 || !(sum > 0)) shares = totals.map((v, i) => (i === t ? residual : null));
    else {
      shares = totals.map((v) => r2((n * v) / sum));
      shares[shares.length - 1] = r2(n - shares.slice(0, -1).reduce((a, v) => a + v, 0));
    }
    let next = from;
    shares.forEach((v, i) => {
      if (v == null) return;
      const entry = winnerIn(fromGroups[i], field);
      next = setEdit(next, next.entries.find((e) => e.id === entry.id), field, moneyInputText(v, locale));
    });
    return { ...next, overlay, overlayBase, mirror };
  }
  const target = n ?? 0;
  const { cur, shares } = distribute(from, field, r2(target - cur0(scans, field, locale)));
  let next = from;
  shares.forEach((d, i) => {
    if (Math.abs(d) < 0.005) return;
    const entry = winnerIn(fromGroups[i], field);
    const live = next.entries.find((e) => e.id === entry.id);
    next = setEdit(next, live, field, moneyInputText(r2(cur[i] + d), locale));
  });
  return { ...next, overlay, overlayBase, mirror };
}

/** Each entry's own change to one line, as it stands: { [entryId]: value }. */
function fieldEdits(state, field) {
  const out = {};
  state.entries.forEach((e) => { if (hasOwn(e.edits, field)) out[e.id] = e.edits[field]; });
  return out;
}

/** The entries with one line's changes put back to `base` (fieldEdits). */
function withFieldEdits(state, field, base) {
  let changed = false;
  const entries = state.entries.map((e) => {
    const had = hasOwn(e.edits, field);
    const want = hasOwn(base, e.id);
    if (!had && !want) return e;
    if (had && want && e.edits[field] === base[e.id]) return e;
    changed = true;
    if (want) return { ...e, edits: { ...e.edits, [field]: base[e.id] } };
    const { [field]: _gone, ...rest } = e.edits;
    return { ...e, edits: Object.keys(rest).length ? rest : EMPTY };
  });
  return changed ? { ...state, entries } : state;
}

function cur0(scans, field, locale) {
  return r2(scans.reduce((a, s) => a + (num(fieldOf(s, field), locale) || 0), 0));
}

/**
 * Start forfra: every photo and its corrections go; the owner's own till (a
 * typed close, a reopened draft) comes back exactly as it was when the first
 * photo came in — back in the day if a "same terminal" photo had superseded
 * it. What was distributed into it while photos were in the day (a total
 * typed on the card, a category raised on a summed day) goes with the
 * photos: it was a share of a day that no longer exists.
 */
export function discardScans(state) {
  if (!state.entries.some((e) => e.origin === TILL_SCAN) && !state.pending.length && state.overlay === EMPTY) return state;
  const was = state.ownBase;
  const entries = state.entries
    .filter((e) => e.origin !== TILL_SCAN)
    .map((e) => {
      const own = was && e.id === was.id ? was : e;
      return own.replacedBy ? { ...own, replacedBy: null } : own;
    });
  return { ...state, entries, pending: [], overlay: EMPTY, overlayBase: EMPTY, ownBase: null, undo: pushUndo(state, "discard") };
}

/** Fortryd: exactly one step back. */
export function undo(state) {
  const top = state.undo[state.undo.length - 1];
  if (!top) return state;
  return {
    ...state, entries: top.entries, pending: top.pending, overlay: top.overlay,
    overlayBase: top.overlayBase || EMPTY, ownBase: top.ownBase || null, undo: state.undo.slice(0, -1),
  };
}

/** The step Fortryd would take back ("sum", "replace", "page", "scan", "queue", "discard"), or null. */
export function lastStep(state) {
  return state.undo.length ? state.undo[state.undo.length - 1].kind : null;
}

/**
 * A reopened close: one "draft" till with the saved lines (as the boxes show
 * them), its saved total when that is not its lines (the card's floor, or a
 * total typed under them), its typed MOMS, and the source it was saved with.
 */
export function loadDraft(state, { revenue = {}, payments = {}, tips = null, total = null, totalText = null, moms = null, meta = null } = {}) {
  const { locale } = state;
  const keep = (b) => Object.fromEntries(Object.entries(b || {}).filter(([, v]) => filled(v)));
  const rev = keep(revenue);
  const lines = lineSum(rev, locale);
  const t = num(total, locale);
  const differs = t != null && t > 0 && Math.abs(t - lines) > 0.005;
  // Only a total BELOW its lines was typed (a read total is never under the
  // lines it carries); one above them is the card's floor.
  const typedTotal = differs && t < lines;
  const m = num(moms, locale);
  const scan = {
    revenue: rev,
    payments: keep(payments),
    ...(filled(tips) ? { tips } : {}),
    ...(m != null ? { moms_total: r2(m) } : {}),
    ...(typedTotal ? { revenue_total: t, revenue_total_text: totalText ?? moneyInputText(t, locale) } : {}),
  };
  const entry = {
    id: nextId(state), origin: TILL_DRAFT, join: JOIN_BASE, scan, edits: EMPTY,
    photo: null, scanId: null, replacedBy: null, floor: differs && !typedTotal ? t : null,
    meta: meta && typeof meta === "object" ? meta : null,
    // The figures as saved: what the owner changes on a reopened Z-bon read
    // is a correction of that read, on the record as one.
    loaded: scan,
  };
  return { ...createTills(locale), seq: state.seq + 1, entries: [entry], mirror: true, day: state.day };
}

/** A scan handed over from elsewhere (Smart Scan): the day is that one photo. */
export function hydrateScan(state, scan) {
  if (!scan) return createTills(state.locale);
  const entry = { id: nextId(state), origin: TILL_SCAN, join: JOIN_BASE, scan, edits: EMPTY, photo: null, scanId: null, replacedBy: null };
  return { ...createTills(state.locale), seq: state.seq + 1, entries: [entry], day: state.day };
}

/** The date moved: the tills move with it (the page asks which day they are for). */
export function dateMoved(state, day = null) {
  return state.day === day ? state : { ...state, day };
}

/** "Brug disse tal": the boxes show the ledger now. */
export function markApplied(state) {
  return state.mirror ? state : { ...state, mirror: true };
}

/** The boxes were filled from something that is not a till (the sales sync). */
export function detachForm(state) {
  return state.mirror ? { ...state, mirror: false } : state;
}

export function resetTills(state) {
  return { ...createTills(state.locale), seq: state.seq, day: state.day };
}

/* ─── what the rest of the page reads ────────────────────────────────── */

/**
 * The day's MOMS, by one rule: a figure the owner typed for the day; else
 * the tills' own MOMS added up when EVERY till's MOMS is known (the owner's
 * typed MOMS on their till, or a bon's MOMS that still belongs to what that
 * till saves); else worked out ("auto", value null — the page applies the
 * rate and the MOMS-free sales). `recomputed`: a bon's MOMS no longer fits
 * its till; `oneTill`: some tills had a MOMS and some did not.
 */
export function momsOf(state, { dayTyped = null } = {}) {
  const { locale } = state;
  const typedDay = num(dayTyped, locale);
  if (typedDay != null) return { source: "typed", value: r2(typedDay), recomputed: false, oneTill: false };
  const scans = groupScans(state);
  if (!scans.length) return { source: "auto", value: null, recomputed: false, oneTill: false };
  const parts = scans.map((s) => {
    const m = num(s.moms_total, locale);
    if (m == null) return { known: false, value: null };
    if ((s.merge_info?.formFields || []).includes("moms_total")) {
      return { known: true, value: m, typed: true };
    }
    if (!(m > 0) || s.revenue_total_text != null) return { known: false, value: m, stale: m > 0 };
    if (Object.prototype.hasOwnProperty.call(s, "bon_total") && s.bon_total == null) return { known: false, value: m, stale: true };
    const bon = num(s.bon_total ?? s.revenue_total, locale);
    const fits = !(bon > 0) || Math.abs((scanTotalOf(s, locale) || 0) - bon) < 0.5;
    return fits ? { known: true, value: m, typed: false } : { known: false, value: m, stale: true };
  });
  if (parts.every((p) => p.known)) {
    return {
      source: parts.some((p) => p.typed) ? "typed" : "zbon",
      value: r2(parts.reduce((a, p) => a + p.value, 0)),
      recomputed: false, oneTill: false,
    };
  }
  return {
    source: "auto", value: null,
    recomputed: parts.some((p) => p.stale),
    oneTill: scans.length > 1 && parts.some((p) => p.value != null) && parts.some((p) => p.value == null),
  };
}

/**
 * Lines only some tills carried (they are not added up), split into the ones
 * read off a bon and the owner's own. MOMS is listed only when the day's
 * MOMS is a figure the owner typed: otherwise the MOMS shown is worked out
 * for the whole day, and "MOMS stood on one bon only" would contradict it.
 */
export function oneSidedLines(state, { listMoms = false } = {}) {
  const card = cardView(state);
  if (!card || tillGroups(state).length < 2) return { read: [], own: [] };
  const typed = new Set(card.merge_info?.typedFields || []);
  const fields = (card.merge_info?.incompleteFields || []).filter((f) => f !== "moms_total" || listMoms);
  return { read: fields.filter((f) => !typed.has(f)), own: fields.filter((f) => typed.has(f)) };
}

const lineKey = (f) => (f.startsWith("revenue.") ? `rev:${f.slice(8)}`
  : f.startsWith("payments.") ? `pay:${f.slice(9)}` : f === "moms_total" ? "moms" : f);

/**
 * Where the figures came from, for the revisor's kasserapport. A typed till
 * is never a Z-bon read: it is listed in typed_tills, its own lines in
 * `typed`; lines the owner changed on a photo's till are `corrected`. A
 * reopened draft with no new photo sends nothing (the server keeps what it
 * knows); a close typed by hand with no photo is "typed".
 */
export function sourceMetaOf(state, { revenue_breakdown = {}, payment_breakdown = {}, momsTyped = false, tipsSaved = false, photo = null } = {}) {
  const { locale } = state;
  const active = activeEntries(state);
  const scansIn = active.filter((e) => e.origin === TILL_SCAN);
  if (!scansIn.length) {
    // A reopened draft with no photo in the day sends nothing when the
    // server knows its source: it keeps the one it was saved with. Start
    // forfra drops the page's photo, and a reopened Z-bon read was
    // relabelled "typed".
    const ft0 = formTill(state);
    if (ft0?.origin === TILL_DRAFT && ft0.meta) return null;
    return !cardView(state) && !photo ? { kind: "typed" } : null;
  }
  const groups = tillGroups(state);
  const summed = groups.length > 1;
  const ft = formTill(state);
  const draftRead = ft?.origin === TILL_DRAFT && ft.meta?.kind === "zbon";
  const formLines = ft ? linesCarried(applyEdits(ft.scan, ft.edits, locale), locale) : new Set();
  const scanLines = new Set();
  scansIn.forEach((e) => {
    linesCarried(e.scan, locale).forEach((f) => scanLines.add(f));
    Object.keys(e.edits).forEach((f) => { if (f !== "revenue_total") scanLines.add(f); });
  });
  const stillSaved = (key) => (key.startsWith("rev:") ? revenue_breakdown[key.slice(4)] != null
    : key.startsWith("pay:") ? payment_breakdown[key.slice(4)] != null
      : key === "moms" ? momsTyped : key === "tips" ? tipsSaved : false);
  const draftTyped = new Set(draftRead ? (ft.meta.typed || []) : []);
  const typed = [...formLines].filter((f) => !scanLines.has(f)).map(lineKey)
    .filter((k) => !draftRead || draftTyped.has(k))
    .filter(stillSaved);
  const corrected = [];
  scansIn.forEach((e) => Object.entries(e.edits).forEach(([f, v]) => {
    if (f === "revenue_total") { corrected.push("revenue_total"); return; }
    if (!f.startsWith("revenue.") && !f.startsWith("payments.")) return;
    const read = num(fieldOf(e.scan, f), locale) || 0;
    if (Math.abs((num(v, locale) || 0) - read) >= 0.005) corrected.push(lineKey(f));
  }));
  if (draftRead) {
    // The reopened draft was itself read off a Z-bon: what was corrected on
    // it then stays on the record, and what the owner changed on it since is
    // a correction of that read — never part of it.
    (Array.isArray(ft.meta.corrected) ? ft.meta.corrected : []).forEach((k) => {
      if (typeof k === "string" && (k === "revenue_total" || stillSaved(k))) corrected.push(k);
    });
    draftChanges(ft, locale).forEach((k) => corrected.push(k));
  }
  const own = ft ? groups.findIndex((g) => g.includes(ft)) : -1;
  let terminal = summed ? tillTotals(state) : [];
  let typedTills = summed && own >= 0 && !draftRead ? [own] : [];
  // A reopened draft that was itself a sum keeps its tills on the record.
  const mt = Array.isArray(ft?.meta?.terminal_totals) ? ft.meta.terminal_totals.map(Number).filter(Number.isFinite) : [];
  if (summed && own === 0 && mt.length > 1 && Math.abs(mt.reduce((a, v) => a + v, 0) - terminal[0]) < 0.005) {
    terminal = [...mt, ...terminal.slice(1)];
    typedTills = (ft.meta.typed_tills || []).filter((i) => Number.isInteger(i) && i >= 0 && i < mt.length);
  }
  const scans = summed ? Math.max(1, terminal.length - typedTills.length) : 1;
  return {
    kind: "zbon",
    scans,
    terminal_totals: terminal,
    ...(typedTills.length ? { typed_tills: typedTills } : {}),
    corrected: Array.from(new Set(corrected)),
    ...(typed.length ? { typed } : {}),
  };
}

/** What the owner changed on a reopened draft since it was loaded, as record keys. */
export function draftChanges(ft, locale = "da-DK") {
  if (!ft?.loaded) return [];
  const now = applyEdits(ft.scan, ft.edits, locale);
  const out = [];
  ["revenue", "payments"].forEach((b) => {
    const keys = new Set([...Object.keys(ft.loaded[b] || {}), ...Object.keys(now[b] || {})]);
    keys.forEach((k) => {
      if (TOTAL_KEYS.includes(k)) return;
      const a = num(now[b]?.[k], locale) || 0;
      const was = num(ft.loaded[b]?.[k], locale) || 0;
      if (Math.abs(a - was) >= 0.005) out.push(lineKey(`${b}.${k}`));
    });
  });
  if (hasOwn(ft.edits, "revenue_total")) {
    const was = ft.floor != null ? ft.floor
      : (ft.loaded.revenue_total != null ? num(ft.loaded.revenue_total, locale) : lineSum(ft.loaded.revenue, locale));
    const typed = num(ft.edits.revenue_total, locale);
    if (typed == null || Math.abs(typed - (was || 0)) >= 0.005) out.push("revenue_total");
  }
  return out;
}

/* ─── one reducer over all of it ─────────────────────────────────────── */

export function tillsReducer(state, action) {
  switch (action?.type) {
    case "scan": return addScan(state, action.scan, action);
    case "choose": return chooseTerminal(state, action.mode);
    case "type": return typeIntoForm(state, action.field, action.value, action);
    case "discard": return discardScans(state);
    case "undo": return undo(state);
    case "draft": return loadDraft(state, action.draft);
    case "hydrate": return hydrateScan(state, action.scan);
    case "dateMoved": return dateMoved(state, action.day);
    case "applied": return markApplied(state);
    case "detach": return detachForm(state);
    case "reset": return resetTills(state);
    default: return state;
  }
}
