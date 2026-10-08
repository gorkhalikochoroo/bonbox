/**
 * The reviewers' attack on the Daily close, made permanent (round 18, step 0).
 *
 * Each sequence mounts the real DailyClosePage (API stubbed, the way every
 * page test here does it) and drives it like an owner at the till: figures
 * typed keystroke by keystroke, Z-bons "photographed" (stubbed scans), the
 * terminal question answered (sum / same terminal / not this photo), Fortryd,
 * Start forfra, the card's total emptied and retyped, a draft reopened, the
 * date moved, MOMS-free sales on the day. Seeded: a failure names its seed
 * and its steps, and replays exactly.
 *
 * After EVERY step:
 *   I1  what the review shows (total, MOMS, every line, the note) is what
 *       the stubbed server stores from the autosave / lock payload — the
 *       server's own revenue and MOMS rules are mirrored below (serverSave);
 *   I2  every new till (a photo with its own total, on a day that already
 *       holds a till with figures) is asked "another terminal?";
 *   I3  no till is counted twice: when every till's figure is known, the day
 *       saves exactly their sum;
 *   I4  a till typed by hand is never filed as a Z-bon read;
 *   I5  no dead end: the page always shows the form, the scan card, or the
 *       scan's start with its buttons (or the day's draft / lock banner);
 *   I6  the scan card is what is filed for the day, or says it is not saved
 *       yet: leaving from it never keeps a draft that differs in silence.
 *
 * Round 19 — held to the STORED row, not the payload (the server keeps what
 * it holds on a null, so a null payload passed while the row kept a Z-bon):
 *   M4  a day of figures typed by hand (or a reopened typed draft) with no
 *       photo in it is never STORED as a Z-bon read;
 *   M4b no stored receipt photo of a bon that is no longer in the day (the
 *       stubbed scans carry an image_url, as the real ones do);
 *   M6  Start forfra on a photo-only day takes the draft this page filed
 *       for it back: deleted when this page created it, else the day's
 *       "there is already a draft" banner shows it;
 *   MV  "Brug dem for {to}" moves, not copies: once the new day is filed,
 *       the old day's draft this page created is gone, and the page says so.
 *
 * Round 19 review — the same invariants over drafts the page REPLACED (the
 * banner's "Start forfra", then the page's own figures filed over it): M6
 * and MV hold that row to the draft it was before the page wrote over it
 * (back as it was, the banner / "er stadig gemt" saying so), and M4b runs
 * on it while the banner shows. MV also covers a day on a card (a Z-bon)
 * moved with no question. The "review" variant (runSequence's 4th argument)
 * adds the openings and timings the reviewers attacked with: "Start forfra"
 * on the day's draft banner first, a slow network (a save — or delete —
 * still on its way during the owner's next step), and two date changes
 * inside the autosave's 2 s.
 *
 * The stub server is the backend's save rule in miniature — keep it in step
 * with backend/app/routers/daily_close.py (revenue_total, the MOMS rules).
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect } from "vitest";
import { businessTodayIso, dateLocale } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";

/** How many times each invariant was actually checked (SEQ_STATS=1 prints them). */
export const STATS = { sequences: 0, steps: 0, I1: 0, I1lock: 0, I2: 0, I3: 0, I4: 0, I5: 0, I6: 0, M4: 0, M4b: 0, M6: 0, MV: 0, F1: 0, F3: 0, F4: 0, F6: 0, F6m: 0 };

/* ─── seeded randomness ─────────────────────────────────────────────── */

function mulberry32(a) {
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r2 = (n) => Math.round(n * 100) / 100;
const shiftIso = (iso, days) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

/* ─── the stubbed scans ─────────────────────────────────────────────── */

const bon = (o) => ({ raw_text: "BON", ocr_available: true, payments: {}, revenue: {}, ...o });
export const BONS = {
  b3000: bon({ revenue: { food: 2000, drinks: 1000 }, revenue_total: 3000, moms_total: 600, payments: { card: 3000 } }),
  b4000: bon({ revenue_total: 4000, moms_total: 800, payments: { card: 4000 } }),
  b1500: bon({ revenue_total: 1500, payments: { card: 1000, cash: 500 } }),
  b12000: bon({ revenue: { food: 7200, drinks: 4800 }, revenue_total: 12000, moms_total: 2400, payments: { card: 12000 } }),
  till1: bon({
    revenue: { food: 9000, drinks: 6000, takeaway: 2030 }, revenue_total: 17030, moms_total: 3406,
    payments: { card: 12000, cash: 4030, mobilepay: 1000 },
  }),
  b5000: bon({ revenue: { food: 3500, drinks: 1500 }, revenue_total: 5000, moms_total: 1000, payments: { card: 5000 } }),
  // Read as a total and a MOMS only: applied, it leaves every box empty.
  t2500: bon({ revenue_total: 2500, moms_total: 500 }),
  // A detail page: lines, no total of its own — fills the till before it.
  page: bon({ revenue: { takeaway: 450 }, payments: { mobilepay: 450 } }),
};
const BON_KEYS = ["b3000", "b4000", "b1500", "b12000", "till1", "b5000", "t2500"];
/** The stored image's path the server answers a photo with (keyed by the photo). */
export const photoUrl = (name) => `u1/kasserapport/${name}`;
const bonTotal = (b) => (b.revenue_total != null ? b.revenue_total : null);

/* ─── the stubbed server: the backend's save rule ───────────────────── */

const EMPTY_DAY = { has_data: false, day_cutoff_hour: 6, sales: { total: 0, count: 0 }, expenses: { total: 0, count: 0 } };
// A day the POS synced: its sales fill boxes nobody has typed in.
const SYNCED_DAY = {
  has_data: true,
  day_cutoff_hour: 6,
  sales: { total: 5000, count: 7, by_payment_method: { card: 5000 }, by_item: {} },
  expenses: { total: 0, count: 0, by_category: {} },
  gavekort: { redeemed: 0, tender: 0 },
  suggested_prefill: { revenue_total: 5000, payment_breakdown: { card: 5000 }, cash_expected: 0 },
  category_split: { source: "history", confidence: "high", sample_size: 12, categories: { food: 3000, drinks: 2000 } },
};

export function createServer({ exemptByDate = {}, rows = [], syncedDates = [] } = {}) {
  const S = { rows: new Map(), exemptByDate, syncedDates: new Set(syncedDates), posts: [], nextScan: null, seq: 0, lockConflicts: 0 };
  rows.forEach((r) => S.rows.set(`${r.date}|${r.branch_id || ""}`, r));
  S.serverExempt = (date) => S.exemptByDate[date] || 0;
  S.save = (body) => {
    const key = `${body.date}|${body.branch_id || ""}`;
    const prev = S.rows.get(key);
    const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
    const rb = body.revenue_breakdown || {};
    const bd = r2(Object.values(rb).reduce((a, v) => a + num(v), 0));
    const ov = body.revenue_total_override;
    let rev;
    if (ov != null && ov > 0 && body.revenue_total_owner_set) rev = r2(ov);
    else if (ov != null && ov > 0) rev = Math.max(bd, ov);
    else if (Object.keys(rb).length) rev = bd;
    else rev = 0;
    let mode = body.moms_mode || "auto";
    if (mode === "manual" && body.moms_total == null) mode = "auto";
    const rate = 0.25;
    const incl = body.prices_include_moms_override != null ? Boolean(body.prices_include_moms_override) : true;
    const momsOf = (a) => (incl ? r2((a * rate) / (1 + rate)) : r2(a * rate));
    let sent = body.moms_total;
    const clampExempt = () => {
      let ex = Number(body.exempt_sales_total || 0);
      if (!Number.isFinite(ex)) ex = 0;
      return Math.min(Math.max(ex, 0), Math.max(0, rev));
    };
    const staleAuto = sent != null && mode === "auto" && bd > 0 && Math.abs(rev - bd) > 0.5
      && Math.abs(sent - momsOf(bd)) < 0.02;
    let exemptFits = false;
    if (staleAuto) {
      const ex = clampExempt();
      if (ex > 0 && Math.abs(sent - momsOf(Math.max(0, rev - ex))) < 0.02) {
        exemptFits = Math.abs(S.serverExempt(body.date) - ex) <= 1.0;
      }
    }
    if (staleAuto && !exemptFits) sent = null;
    // The day's MOMS-free sales cover the close: an auto MOMS of 0 is kept
    // only when the server's own MOMS-free sales for the date say so.
    if (mode === "auto" && rev > 0 && Math.abs(momsOf(rev)) >= 0.005
      && sent != null && Math.abs(sent) < 0.005) {
      let claim = Number(body.exempt_sales_total || 0);
      if (!Number.isFinite(claim) || claim < 0) claim = 0;
      const covers = (ex) => ex > 0 && Math.abs(momsOf(Math.max(0, rev - ex))) < 0.005;
      const server = S.serverExempt(body.date);
      if (!(covers(claim) && Math.abs(server - claim) <= 1.0 && covers(server))) sent = null;
    }
    const moms = sent != null ? r2(sent) : (rev !== 0 ? momsOf(rev) : 0);
    // A day deleted earlier is filed again under the same row where the
    // unique day key still holds it — under a branch (the backend takes the
    // soft-deleted DRAFT back; a NULL branch never collides, so it is a new
    // row there, round 20). Only drafts are ever deleted here.
    const reused = !prev && body.branch_id && S.dead.get(key);
    if (reused) S.dead.delete(key);
    const row = {
      id: prev?.id || reused || `row${++S.seq}`,
      date: body.date,
      branch_id: body.branch_id || null,
      status: body.status === "draft" ? "draft" : "confirmed",
      revenue_total: rev,
      revenue_breakdown: { ...rb },
      payment_breakdown: { ...(body.payment_breakdown || {}) },
      moms_total: moms,
      moms_mode: mode,
      cash_counted: body.cash_counted ?? null,
      // The float is informational: one out of range (or none) keeps what
      // is stored (backend _clean_cash_float + the update's "only if sent").
      cash_float: typeof body.cash_float === "number" && body.cash_float >= 0 && body.cash_float <= 1_000_000
        ? r2(body.cash_float) : (prev?.cash_float ?? null),
      tips_total: body.tips_total ?? null,
      tips_staff_count: body.tips_staff_count ?? null,
      closed_by: body.closed_by ?? null,
      notes: body.notes ?? null,
      // null: the server keeps what it knows.
      source_meta: body.source_meta != null ? body.source_meta : (prev?.source_meta ?? null),
      // "" clears it (the page's "no photo any more").
      receipt_photo: body.receipt_photo === "" ? null : (body.receipt_photo || prev?.receipt_photo || null),
      is_deleted: false,
    };
    S.rows.set(key, row);
    return row;
  };
  // DELETE /daily-close/{id}: a draft goes (soft-deleted: off the list); a
  // locked close is refused.
  S.deletes = [];
  S.dead = new Map();
  const removeNow = (id) => {
    const entry = [...S.rows.entries()].find(([, r]) => r.id === id);
    if (!entry) return Promise.reject(Object.assign(new Error("gone"), { response: { status: 404, data: {} } }));
    if (entry[1].status === "confirmed") return Promise.reject(Object.assign(new Error("locked"), { response: { status: 409, data: {} } }));
    S.rows.delete(entry[0]);
    S.dead.set(entry[0], id);
    S.deletes.push(id);
    return Promise.resolve({ data: null });
  };
  // A slow network: while `holding` is set, each save (or delete) waits in
  // `held` and reaches the server — in the order sent — on releaseHeld().
  S.holding = { post: false, del: false };
  S.held = [];
  S.releaseHeld = () => { const h = S.held.splice(0); h.forEach((go) => go()); return h.length; };
  S.remove = (id) => (S.holding.del || S.held.length
    ? new Promise((res, rej) => { S.held.push(() => removeNow(id).then(res, rej)); })
    : removeNow(id));
  return S;
}

export function installApi(S, get, post, del = null) {
  if (del) del.mockImplementation((url) => S.remove(String(url).split("/").pop()));
  get.mockImplementation((url, cfg) => {
    if (url === "/daily-close") return Promise.resolve({ data: [...S.rows.values()].map((r) => ({ ...r })) });
    if (url === "/daily-close/prefill") return Promise.resolve({ data: S.syncedDates.has(cfg?.params?.date) ? SYNCED_DAY : EMPTY_DAY });
    if (url === "/property-report") {
      const ex = S.serverExempt(cfg?.params?.date);
      return Promise.resolve({ data: { totals: { total_revenue: ex, taxable_sales: 0 } } });
    }
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url, body) => {
    if (String(url).includes("scan")) {
      const s = S.nextScan;
      S.nextScan = null;
      return s ? Promise.resolve({ data: JSON.parse(JSON.stringify(s)) }) : Promise.reject(new Error("no scan stubbed"));
    }
    if (url === "/daily-close") {
      const copy = JSON.parse(JSON.stringify(body));
      // What the day held when the page SENT it (a held save arrives later).
      const tags = S.tagAtSend ? S.tagAtSend(copy) : {};
      const arrive = () => {
        const key = `${copy.date}|${copy.branch_id || ""}`;
        if (S.rows.get(key)?.status === "confirmed") {
          S.lockConflicts += 1;
          return Promise.reject(Object.assign(new Error("locked"), { response: { status: 409, data: {} } }));
        }
        S.posts.push({ ...copy, ...tags });
        return Promise.resolve({ data: S.save(copy) });
      };
      // Behind anything still on its way: requests arrive in the order sent.
      if (S.holding.post || S.held.length) {
        return new Promise((res, rej) => { S.held.push(() => arrive().then(res, rej)); });
      }
      return arrive();
    }
    return Promise.resolve({ data: {} });
  });
}

/* ─── the page, read and driven ─────────────────────────────────────── */

const q = (sel) => document.querySelector(sel);
const buttons = () => [...document.querySelectorAll("button")];
const findBtn = (re) => buttons().find((b) => re.test(b.textContent.trim()));
const hasText = (s) => document.body.textContent.includes(s);
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));

/** Danish money as the review prints it ("17.030,00", "−150,00") → number. */
function money(el) {
  if (!el) return null;
  const s = el.textContent.replace(/\s/g, "");
  if (!/\d/.test(s)) return null;
  const neg = /^[−-]/.test(s);
  const n = Number(s.replace(/[^\d,]/g, "").replace(",", "."));
  return neg ? -n : n;
}

const REV = ["food", "drinks", "takeaway"];
const PAY = ["card", "cash", "mobilepay"];

function where() {
  if (q("#close-date")) {
    if (q("#dc-rev-food")) return "s1";
    if (q("#dc-pay-card")) return "s2";
    if (q("#cash-counted")) return "s3";
    if (q("#dc-tips-total")) return "s4";
    if (q("#dc-notes")) return "review";
    return "form";
  }
  if (q('[data-testid="dc-scan-result-date"]')) return "card";
  if (hasText("readingZReport")) return "scanning";
  return "idle";
}
const onForm = () => Boolean(q("#close-date"));
const STEPS = ["s1", "s2", "s3", "s4", "review"];

async function toStepAt(target, visit = null) {
  for (let i = 0; i < 10; i++) {
    const at = where();
    // Every step walked past is looked at (F1: the cash step's boxes).
    visit?.(at);
    if (at === target) return true;
    const a = STEPS.indexOf(at);
    const b = STEPS.indexOf(target);
    if (a < 0 || b < 0) return false;
    const btn = a < b ? findBtn(/^next\s*→$/) : findBtn(/^←\s*back$/);
    if (!btn) return false;
    fireEvent.click(btn);
  }
  return where() === target;
}

/**
 * Keystroke by keystroke, the way a browser types: select all + Backspace,
 * then each key goes onto what the box shows at that moment. (Typing the
 * prefixes instead hid a box that rewrote itself under the caret: "17030,00"
 * ended as a red "17.0300" on the card.)
 */
function keyIn(el, value) {
  if (el.value !== "") fireEvent.change(el, { target: { value: "" } });
  for (const ch of value) fireEvent.change(el, { target: { value: el.value + ch } });
}

function readReview() {
  const rev = {};
  const pay = {};
  REV.forEach((k) => { const v = money(q(`[data-testid="dc-review-rev-${k}"]`)); if (v != null) rev[k] = v; });
  PAY.forEach((k) => { const v = money(q(`[data-testid="dc-review-pay-${k}"]`)); if (v != null) pay[k] = v; });
  return {
    total: money(q('[data-testid="dc-review-total"]')),
    moms: money(q('[data-testid="dc-review-moms"]')),
    rev, pay,
    notes: q("#dc-notes")?.value ?? "",
  };
}

/* ─── one sequence ──────────────────────────────────────────────────── */

const DRAFTS = [
  // typed by hand
  { revenue_total: 14000, revenue_breakdown: { food: 9000, drinks: 5000 }, payment_breakdown: { card: 14000 },
    moms_mode: "auto", moms_total: 2800, source_meta: { kind: "typed" }, kind: "draft" },
  // read off a Z-bon
  { revenue_total: 17030, revenue_breakdown: { food: 9000, drinks: 6000, takeaway: 2030 }, payment_breakdown: { card: 12000, cash: 5030 },
    moms_mode: "manual", moms_total: 3406, source_meta: { kind: "zbon", scans: 1, corrected: [] }, kind: "draftZbon" },
  // a saved total above its lines (the card's floor)
  { revenue_total: 17030, revenue_breakdown: { food: 10000 }, payment_breakdown: { card: 12000, cash: 5030 },
    moms_mode: "auto", moms_total: 3406, source_meta: { kind: "zbon", scans: 1, corrected: [] }, kind: "draftZbon" },
  // a typed MOMS for its total, under lines that do not reach it
  { revenue_total: 13264.5, revenue_breakdown: { food: 4000, drinks: 1234.5 }, payment_breakdown: { card: 13264.5 },
    moms_mode: "manual", moms_total: 2652.9, source_meta: { kind: "typed" }, kind: "draft" },
  // card + cash + MobilePay: the payments the reviewers emptied and retyped
  { revenue_total: 24412.5, revenue_breakdown: { food: 14000, drinks: 10412.5 }, payment_breakdown: { card: 21000, cash: 3000, mobilepay: 412.5 },
    moms_mode: "auto", moms_total: 4882.5, source_meta: { kind: "typed" }, kind: "draft" },
];

// Round 20 (the "r20" variant): drafts counted with a float other than this
// device's (and one saved before floats were kept), a Z-bon read with its
// own photo, and a reopened SUM of a typed till and a bon — the reviewers'
// repros for items 1, 4 and 6. This device remembers DEVICE_FLOAT.
const DRAFTS_R20 = [
  { ...DRAFTS[0], cash_counted: 1504.75, cash_float: 1000 },
  { ...DRAFTS[1], receipt_photo: "u1/kasserapport/seed-own.jpg", cash_counted: 980, cash_float: 500 },
  { ...DRAFTS[4], cash_counted: 3000, cash_float: null },
  { revenue_total: 14000, revenue_breakdown: { food: 10000, drinks: 4000 }, payment_breakdown: { card: 14000 },
    moms_mode: "auto", moms_total: 2800, kind: "draftZbon",
    source_meta: { kind: "zbon", scans: 1, terminal_totals: [10000, 4000], typed_tills: [0], corrected: [] } },
];
const DEVICE_FLOAT = 1500;
const FLOAT_KEY = "bonbox.dc.cashFloat.v1";
/** Another device's scan of the day, landing on the server behind the page's back (F4). */
const OTHER_PHOTO = "u1/kasserapport/other-device.jpg";

const VALUES = ["750", "2.000", "9.000", "5.000", "14.000", "1.234,50", "3.000", "12.000"];

export async function runSequence(seed, page, { S: givenS, get, post, del = null } = {}, { variant = null } = {}) {
  const { DailyClosePage } = page;
  // "r20": the review variant's openings and timings, over the round-20
  // drafts (floats, own photos, a reopened sum) and another device's scan.
  const r20 = variant === "r20";
  const review = variant === "review" || r20;
  const rnd = mulberry32(seed * 7919 + 13);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const chance = (p) => rnd() < p;
  const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
  const yesterday = shiftIso(today, -1);
  const twoDaysAgo = shiftIso(today, -2);
  const exemptByDate = { [yesterday]: 2000 };
  if (chance(0.3)) exemptByDate[today] = pick([2000, 750, 1500]);

  const opening = r20
    ? pick(["draft", "draft", "draft", "bannerScan", "scan", "typed"])
    : review
    ? pick(["bannerTyped", "bannerScan", "bannerScan", "typed", "scan", "draft"])
    : pick(["typed", "typed", "scan", "draft", "draft", "momsfri"]);
  const seededRows = [];
  let draftRow = null;
  if (opening === "draft" || opening === "bannerTyped" || opening === "bannerScan") {
    const d = pick(r20 ? DRAFTS_R20 : DRAFTS);
    draftRow = { id: "seed1", date: today, branch_id: null, status: "draft", closed_by: "Test", notes: "Test", ...d };
    delete draftRow.kind;
    // Saved by the page on this very day: an auto MOMS already has the day's
    // MOMS-free sales taken off (the server keeps that figure when its own
    // MOMS-free sales agree).
    if (draftRow.moms_mode === "auto") {
      const ex = Math.min(exemptByDate[today] || 0, draftRow.revenue_total);
      draftRow.moms_total = r2((Math.max(0, draftRow.revenue_total - ex) * 0.25) / 1.25);
    }
    seededRows.push(draftRow);
  }
  if (opening === "momsfri") exemptByDate[today] = 2000;
  const S = givenS || createServer({ exemptByDate, rows: seededRows, syncedDates: [twoDaysAgo] });
  installApi(S, get, post, del);
  // This device's remembered float (r20: not the one the seeded drafts were
  // counted with).
  if (r20) { try { localStorage.setItem(FLOAT_KEY, String(DEVICE_FLOAT)); } catch { /* private mode */ } }
  const deviceFloat = () => {
    let v = null;
    try { v = localStorage.getItem(FLOAT_KEY); } catch { /* private mode */ }
    const n = Number(v ?? 1000);
    return Number.isFinite(n) ? n : 1000;
  };

  const log = [];
  const fail = (inv, msg) => `[seed ${seed}] ${inv}: ${msg}\n  steps: ${log.join(" → ")}`;

  /* The test's own picture of the day — what it typed, which tills it made. */
  const M = {
    form: { rev: {}, pay: {} },       // the boxes as typed (no photo in the day)
    ownKind: null,                    // "typed" | "draft" | "draftZbon"
    ownTotal: 0,                      // the owner's till's figure
    ownActive: true,                  // not superseded by "same terminal"
    atFirst: null,                    // the owner's till when the day's first photo came in
    scans: [],                        // tills read off photos: { name, total }
    pending: [],                      // photos waiting on the question
    pageIn: false,                    // a page without a total filled a till
    exact: true,                      // every till's figure is known
    photos: new Set(),                // photo names in the day (for "the same photo")
    undo: [],                         // the ledger's steps, for Fortryd
    typedByHandOnly: {},              // per date: nothing but typed figures ever filed
    synced: false,                    // the sales sync filled boxes on a day in play
    draftPhoto: null,                 // the reopened draft's own stored photo
    loadedCash: null,                 // F1: the reopened draft's count { drawer, float }
    zbonLoaded: null,                 // F6: the reopened Z-bon read's lines as opened
    otherPhotos: {},                  // F4: per date, another device's photo on the server
  };
  const val = (v) => (typeof v === "number" ? v : Number(String(v ?? "").replace(/\./g, "").replace(",", ".")) || 0);
  const sumOf = (o) => Object.values(o).reduce((a, v) => a + val(v), 0);
  const typedTotal = () => { const rv = sumOf(M.form.rev); return rv > 0 ? r2(rv) : r2(sumOf(M.form.pay)); };
  const ownFig = () => M.ownActive && M.ownTotal > 0;
  const photosIn = () => M.scans.length > 0 || M.pending.length > 0 || M.pageIn;
  const snap = () => ({
    scans: [...M.scans], pending: [...M.pending], ownActive: M.ownActive, exact: M.exact, pageIn: M.pageIn,
    photos: new Set(M.photos), ownTotal: M.ownTotal,
  });
  const restore = (s) => Object.assign(M, { ...s, photos: new Set(s.photos) });
  const resetDay = () => {
    Object.assign(M, {
      form: { rev: {}, pay: {} }, ownKind: null, ownTotal: 0, ownActive: true, atFirst: null,
      scans: [], pending: [], pageIn: false, exact: true, photos: new Set(), undo: [],
      draftFloor: null, draftPinned: null, synced: false, draftPhoto: null,
      loadedCash: null, zbonLoaded: null,
    });
  };

  let mounted = null;
  // The days this mount of the page filed a draft for (I6).
  const postedHere = new Set();
  // The rows this mount CREATED (no row for the day when it first posted):
  // the only drafts it may delete (M6, MV).
  const createdHere = new Set();
  // Days whose draft banner was answered "Start forfra" in this mount, and
  // the row as it was when the page first wrote over it (M6, MV, M4b).
  const startedOverHere = new Set();
  const originals = new Map();
  // A slow step: its saves are still on their way during the next step.
  let slowStep = false;
  // A Start forfra that left the day empty (M6), and a move answered "Brug
  // dem" (MV): checked once the page has filed what follows.
  let emptiedDay = null;
  // …and the row as it stood when Start forfra was tapped, and the page's
  // last draft for the day as SENT (a slow save may still be on its way) (F3).
  let emptiedRow = null;
  let emptiedSent = null;
  // The page's last draft sent per day, and a running count of sends.
  const lastSent = {};
  let sendSeq = 0;
  // The owner's own fields on a draft — what Start forfra must never delete.
  const ownFields = (r) => Boolean(r) && Boolean(r.notes || r.closed_by || r.cash_counted != null
    || r.tips_total != null || r.tips_staff_count != null);
  // Drafts Start forfra kept because they hold the owner's own fields
  // (F3): until the next save for the day, the stored row is the one filed
  // before — its photo included.
  const keptDrafts = new Map();
  let pendingMove = null;
  let moveOrigin = null;
  // The day the card is for, as its date line says it: the test keeps it.
  let shownDay = null;
  const businessDayShown = () => q("#close-date")?.value || shownDay;
  // The photos this mount of the page filed (F4: "" only ever clears one of
  // these, or the photo of the draft the banner's Start forfra replaced).
  const filedPhotosHere = new Set();
  const mount = () => {
    postedHere.clear(); createdHere.clear(); emptiedDay = null; pendingMove = null;
    startedOverHere.clear(); originals.clear(); filedPhotosHere.clear();
    shownDay = today; mounted = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
  };
  // The page's history (the day's draft or lock) answers after the first render.
  const loaded = async () => {
    const row = S.rows.get(`${today}|`);
    const want = row ? (row.status === "confirmed" ? "dcDayAlreadyLocked" : "dcDayHasDraft") : "scanZReportTitle";
    for (let i = 0; i < 10 && !hasText(want); i++) await settle();
  };
  const unmount = async () => { if (mounted) { mounted.unmount(); mounted = null; } await settle(); };

  // F1 — walking past the cash step of a reopened draft: the drawer and the
  // float are the ones it was counted with (cash_counted + cash_float), never
  // this device's float.
  const visitStep = (at) => {
    if (at !== "s3" || !M.loadedCash) return;
    const drawer = q("#cash-counted");
    const float = q("#cash-float");
    if (!drawer || !float) return;
    STATS.F1 += 1;
    expect(Math.abs(val(drawer.value) - M.loadedCash.drawer) < 0.005 && Math.abs(val(float.value) - M.loadedCash.float) < 0.005,
      fail("F1 a reopened draft keeps its float", `step 3 shows drawer ${drawer.value} / float ${float.value}, counted ${M.loadedCash.drawer} / ${M.loadedCash.float}`)).toBe(true);
  };
  const toStep = (target) => toStepAt(target, visitStep);

  /* ─── the checks after every step ─── */
  let lastPostCount = 0;
  const checkPosts = () => {
    // I4 — every payload sent since the last check: a till typed by hand is
    // never filed as a Z-bon read.
    for (const body of S.posts.slice(lastPostCount)) {
      // F4 — "" clears only a photo this page filed, or the photo of the
      // draft the banner's Start forfra replaced: never another device's.
      if (body.receipt_photo === "" && body.__storedPhoto) {
        STATS.F4 += 1;
        const replaced = body.__replacedPhoto || null;
        expect(body.__filedHere.includes(body.__storedPhoto) || body.__storedPhoto === replaced,
          fail("F4 \"\" never clears another device's photo", `${body.date}: "" sent over ${body.__storedPhoto} (this page filed ${body.__filedHere.join(", ") || "none"}; replaced draft's ${replaced})`)).toBe(true);
      }
      // F1 — a reopened draft's count goes with the float it was counted
      // with, never this device's.
      if (body.cash_counted != null && body.__loadedFloat != null && !(body.__other && originals.has(body.date))) {
        STATS.F1 += 1;
        expect(Math.abs(Number(body.cash_float) - body.__loadedFloat) < 0.005, fail("F1 a reopened draft keeps its float",
          `${body.date}: cash_counted ${body.cash_counted} sent with float ${body.cash_float}, counted with ${body.__loadedFloat}`)).toBe(true);
      }
      // U2 restored (round 19's I4 skipped every other day's payload): only
      // a draft filed back as it was (a revert) carries nothing of the day
      // on screen.
      if (body.__other && originals.has(body.date)) continue;
      const meta = body.source_meta;
      if (body.__noPhotos && body.__ownKind === "typed") {
        STATS.I4 += 1;
        expect(meta?.kind, fail("I4 typed never Z-bon", `payload for ${body.date} labelled ${JSON.stringify(meta)}`)).not.toBe("zbon");
      }
      if (body.__summedOwnTyped && meta?.kind === "zbon") {
        STATS.I4 += 1;
        expect(meta.typed_tills || [], fail("I4 typed never Z-bon", `summed day files the typed till as a Z-bon: ${JSON.stringify(meta)}`)).toContain(0);
      }
    }
    lastPostCount = S.posts.length;
  };
  // Tag each payload with what the day held when it was sent.
  S.tagAtSend = (body) => {
    lastSent[body.date] = body;
    return {
      __seq: ++sendSeq,
      // A save for another day than the one on screen (a moved day's draft
      // filed back as it was) carries nothing of the day on screen.
      __other: body.date !== businessDayShown(),
      __noPhotos: !photosIn(),
      __ownKind: M.ownKind,
      __summedOwnTyped: M.scans.length > 0 && M.ownActive && M.ownKind === "typed" && M.ownTotal > 0 && !M.pageIn,
      // What the server held for the day when the page sent it (F4).
      __storedPhoto: S.rows.get(`${body.date}|${body.branch_id || ""}`)?.receipt_photo || null,
      __filedHere: [...filedPhotosHere],
      __replacedPhoto: startedOverHere.has(body.date)
        ? (originals.get(body.date) || S.rows.get(`${body.date}|${body.branch_id || ""}`))?.receipt_photo || null : null,
      __loadedFloat: M.loadedCash ? M.loadedCash.float : null,
    };
  };
  const origPush = S.posts.push.bind(S.posts);
  S.posts.push = (body) => {
    const key = `${body.date}|${body.branch_id || ""}`;
    postedHere.add(body.date);
    if (body.receipt_photo && body.receipt_photo !== M.draftPhoto) filedPhotosHere.add(body.receipt_photo);
    if (!S.rows.has(key)) createdHere.add(body.date);
    // A draft this page wrote over (the banner's "Start forfra"): the row as
    // it was, which taking the page's figures off the day must give back.
    else if (startedOverHere.has(body.date) && !originals.has(body.date) && !createdHere.has(body.date)) {
      originals.set(body.date, JSON.parse(JSON.stringify(S.rows.get(key))));
    }
    return origPush(body);
  };

  // M4 / M4b on a stored row: what the revisor gets with the day.
  const checkStoredRow = (date, row) => {
    if (!row) return;
    if (!photosIn() && ownFig() && (M.ownKind === "typed" || M.ownKind === "draft")) {
      STATS.M4 += 1;
      expect(row.source_meta?.kind, fail("M4 typed never STORED as a Z-bon read",
        `${date} (${M.ownKind}, no photo in the day) stored as ${JSON.stringify(row.source_meta)}`)).not.toBe("zbon");
    }
    STATS.M4b += 1;
    if (row.receipt_photo) {
      const allowed = new Set([...M.photos].map(photoUrl));
      if (M.draftPhoto) allowed.add(M.draftPhoto);
      // A draft Start forfra kept (F3): the stored row is the one filed
      // before, until the next save for the day replaces it.
      const kept = keptDrafts.get(date);
      if (kept && !S.posts.some((b) => b.date === date && b.__seq > kept.seq)) kept.photos.forEach((ph) => allowed.add(ph));
      // Another device scanned the day (F4): its photo is the day's too.
      if (M.otherPhotos[date]) allowed.add(M.otherPhotos[date]);
      expect(allowed.has(row.receipt_photo), fail("M4b no stored photo of a bon no longer in the day",
        `${date} stores ${row.receipt_photo}; photos in the day: ${[...allowed].join(", ") || "none"}`)).toBe(true);
    }
  };
  // The row is the draft it was before this page wrote over it.
  const sameDraft = (row, orig) => Boolean(row) && row.status === "draft"
    && Math.abs(Number(row.revenue_total) - Number(orig.revenue_total)) < 0.005
    && JSON.stringify(row.revenue_breakdown || {}) === JSON.stringify(orig.revenue_breakdown || {})
    && JSON.stringify(row.payment_breakdown || {}) === JSON.stringify(orig.payment_breakdown || {})
    && (row.receipt_photo || null) === (orig.receipt_photo || null)
    && (orig.source_meta == null || JSON.stringify(row.source_meta) === JSON.stringify(orig.source_meta));
  const brief = (r) => r && JSON.stringify({ revenue_total: r.revenue_total, revenue_breakdown: r.revenue_breakdown, payment_breakdown: r.payment_breakdown, receipt_photo: r.receipt_photo, source_meta: r.source_meta });
  const storedChecks = async () => {
    // The page's own follow-ups (a draft deleted once the saves have
    // answered) run on the saves' answers.
    await settle();
    await settle();
    // M6 — Start forfra left the day empty: the photo's draft this page
    // filed is taken back.
    if (emptiedDay) {
      const day = emptiedDay;
      const was = emptiedRow;
      const sent = emptiedSent;
      emptiedDay = null;
      emptiedRow = null;
      emptiedSent = null;
      const row = S.rows.get(`${day}|`);
      STATS.M6 += 1;
      const orig = originals.get(day);
      // F3 (round 20) — the draft held what the owner typed beside the
      // photo (a note, Lukket af, a count, tips, staff): it is the only
      // stored copy, so it is never deleted or put back — it stays as it
      // was filed until the next save updates it. (Expectation changed from
      // round 19's "always taken back": that deleted the owner's note.)
      if (was && ownFields(sent) && (orig || createdHere.has(day))) {
        STATS.F3 += 1;
        expect(Boolean(row) && row.status === "draft" && row.id === was.id && (row.notes || null) === (was.notes || null)
          && (row.closed_by || null) === (was.closed_by || null) && Math.abs(Number(row.revenue_total) - Number(was.revenue_total)) < 0.005,
        fail("F3 Start forfra never deletes the owner's own fields",
          `${day}: the draft holding ${JSON.stringify({ notes: was.notes, closed_by: was.closed_by, cash_counted: was.cash_counted })} should stay as filed, stored ${brief(row)}`)).toBe(true);
        expect(hasText("dcDayHasDraft"), fail("F3 Start forfra never deletes the owner's own fields",
          `${day}: the kept draft is this page's own, yet the banner covers it`)).toBe(false);
      } else if (orig) {
        // A draft the page replaced through the banner: back as it was, and
        // the banner shows it — never the thrown-away photo's figures.
        expect(sameDraft(row, orig), fail("M6 Start forfra takes the photo's draft back",
          `${day}: the draft the page replaced should be back as it was ${brief(orig)}, stored ${brief(row)}`)).toBe(true);
        expect(hasText("dcDayHasDraft"), fail("M6 Start forfra takes the photo's draft back",
          `${day}: the replaced draft is back, and nothing says so`)).toBe(true);
      } else if (row && row.status === "draft") {
        if (createdHere.has(day)) {
          expect(false, fail("M6 Start forfra takes the photo's draft back",
            `the draft this page created for ${day} still holds ${row.revenue_total} (${JSON.stringify(row.source_meta)})`)).toBe(true);
        } else {
          expect(hasText("dcDayHasDraft"), fail("M6 Start forfra takes the photo's draft back",
            `${day}: a draft this page did not create (${row.revenue_total}) stays, and nothing says so`)).toBe(true);
        }
      }
    }
    // MV — "Brug dem for {to}": once the new day is filed, the old day's
    // draft this page created is gone, and the page says what happened.
    if (pendingMove && S.posts.slice(pendingMove.posts).some((b) => b.date !== pendingMove.from)) {
      const mv = pendingMove;
      pendingMove = null;
      const row = S.rows.get(`${mv.from}|`);
      const onTo = onForm() && q("#close-date")?.value === mv.to;
      STATS.MV += 1;
      const orig = originals.get(mv.from);
      if (orig) {
        // A draft the page replaced through the banner: the moved figures
        // leave it, and it is the draft it was — "er stadig gemt" is true.
        expect(sameDraft(row, orig), fail("MV a date move moves, not copies",
          `${mv.from}: the draft the page replaced should be back as it was ${brief(orig)}, stored ${brief(row)} after the figures went to ${mv.to}`)).toBe(true);
        if (onTo) expect(hasText("dcDateMovedKeptOld"), fail("MV a date move moves, not copies", "nothing says the old day's draft is still there")).toBe(true);
      } else if (mv.created) {
        expect(!row || row.status !== "draft", fail("MV a date move moves, not copies",
          `${mv.from} still holds the draft this page made (${row?.revenue_total}) after the figures went to ${mv.to}`)).toBe(true);
        if (onTo) expect(hasText("dcDateMovedFrom"), fail("MV a date move moves, not copies", "nothing says the figures moved")).toBe(true);
      } else if (row && row.status === "draft" && mv.filed && onTo) {
        // Neither made nor replaced here, but written to: it still has the
        // page's figures, and the page says so (never "er stadig gemt").
        expect(hasText("dcDateMovedOldHolds"), fail("MV a date move moves, not copies",
          `${mv.from}'s draft (not this page's to delete) still has the moved figures, and nothing says so`)).toBe(true);
      }
    }
    // M4b on a replaced draft while its banner shows: never a photo of a
    // bon the owner threw away.
    const shown = businessDayShown();
    const replaced = shown && originals.get(shown);
    if (replaced && hasText("dcDayHasDraft")) {
      const row = S.rows.get(`${shown}|`);
      STATS.M4b += 1;
      expect(!row?.receipt_photo || row.receipt_photo === (replaced.receipt_photo || null), fail("M4b no stored photo of a bon no longer in the day",
        `${shown} (banner) stores ${row?.receipt_photo}`)).toBe(true);
    }
    // M4 / M4b — the stored row for the day in view (filed by this page).
    const date = businessDayShown();
    if (date && postedHere.has(date) && !hasText("dcDayHasDraft") && !hasText("dcDayAlreadyLocked")
      && !q('[data-testid="dc-date-move"]')) {
      checkStoredRow(date, S.rows.get(`${date}|`));
    }
    // F6 — a reopened Z-bon read changed by hand, no photo in the day: every
    // line that differs from the read as it was opened is on the record as
    // corrected (never "read off the bon"), nothing else is said corrected,
    // and a reopened sum's tills still add up to what is stored.
    const z = M.zbonLoaded;
    const zrow = z && z.date === date && S.rows.get(`${date}|`);
    if (zrow && postedHere.has(date) && !photosIn() && M.ownKind === "draftZbon" && zrow.status === "draft"
      && !hasText("dcDayHasDraft") && !S.held.length) {
      const changed = [];
      [["revenue_breakdown", "rev"], ["payment_breakdown", "pay"]].forEach(([b, k]) => {
        const keys = new Set([...Object.keys(z[b] || {}), ...Object.keys(zrow[b] || {})]);
        keys.forEach((x) => {
          if (Math.abs((Number(zrow[b]?.[x]) || 0) - (Number(z[b]?.[x]) || 0)) >= 0.005) changed.push(`${k}:${x}`);
        });
      });
      const meta = zrow.source_meta || {};
      STATS.F6 += 1;
      const where6 = `${date}: lines changed ${JSON.stringify(changed)}, stored ${JSON.stringify(meta)}`;
      expect(meta.kind, fail("F6 a hand-edited Z-bon read is filed as corrected", where6)).toBe("zbon");
      changed.forEach((k) => expect(meta.corrected || [], fail("F6 a hand-edited Z-bon read is filed as corrected", where6)).toContain(k));
      const may = new Set([...z.corrected, ...changed, "revenue_total"]);
      (meta.corrected || []).forEach((k) => expect(may.has(k), fail("F6 a hand-edited Z-bon read is filed as corrected", `${k} said corrected — ${where6}`)).toBe(true));
      const tt = meta.terminal_totals || [];
      if (tt.length > 1) {
        expect(Math.abs(tt.reduce((a, v) => a + v, 0) - zrow.revenue_total) < 0.5,
          fail("F6 a hand-edited Z-bon read is filed as corrected", `the tills no longer add up to the stored total — ${where6}`)).toBe(true);
      }
      // A MOMS typed that is not the one the read was opened with is the
      // owner's: the backend's moms_source must say "typed" — never print it
      // as "Salgsmoms aflæst fra Z-bon" (round 20 review).
      if (zrow.moms_mode === "manual" && (z.moms == null || Math.abs(Number(zrow.moms_total) - z.moms) >= 0.005)) {
        STATS.F6m += 1;
        const src = (meta.typed_tills || []).length || (meta.typed || []).includes("moms") ? "typed" : "zbon";
        expect(src, fail("F6 a hand-edited Z-bon read is filed as corrected",
          `MOMS ${zrow.moms_total} (opened with ${z.moms}) filed as read off the bon — ${where6}`)).toBe("typed");
      }
    }
  };

  // I5 — never a page with nothing to tap.
  const noDeadEnd = () => {
    STATS.I5 += 1;
    const somewhere = onForm() || Boolean(q('[data-testid="dc-scan-result-date"]')) || where() === "scanning"
      || Boolean(findBtn(/^skipEnterManually$/)) || hasText("dcDayHasDraft") || hasText("dcDayAlreadyLocked");
    expect(somewhere, fail("I5 no dead end", "no form, no card, no scan buttons")).toBe(true);
  };
  const checkpoint = async () => {
    // Whatever save is waiting goes now (the page sends it on pagehide).
    await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
    if (slowStep) {
      // Still on their way: the next step happens before they arrive, and
      // what is stored is checked once they have. What the page shows does
      // not wait: I5 is checked here too (U3 restored — it was counted with
      // nothing checked).
      slowStep = false;
      S.holding.post = false; S.holding.del = false;
      noDeadEnd();
      return;
    }
    // A slow step's saves (and deletes) arrive, in the order sent, and the
    // page's follow-ups run on their answers.
    for (let i = 0; i < 6 && S.held.length; i++) {
      await act(async () => { S.releaseHeld(); await new Promise((r) => setTimeout(r, 0)); });
      await settle();
    }
    checkPosts();
    await storedChecks();
    noDeadEnd();
    if (!onForm()) {
      // I6 — leaving from the card: what is stored for the day is what the
      // card shows, or the card said it is not saved yet. Held to days this
      // page filed itself, and not over boxes the sales sync filled (those
      // are the boxes', not a card's).
      const total = q("#scan-total");
      const date = businessDayShown();
      const row = date && S.rows.get(`${date}|`);
      // An emptied (or unreadable) total box is no figure: it is red and
      // holds the lock until one is typed.
      const readable = total && total.value.trim() !== "" && total.getAttribute("aria-invalid") !== "true";
      // Under the day's draft banner the card files nothing, and the banner
      // says which draft is stored (a revert landing after a new photo).
      // Nor over the day's own old draft, put back as it was (nothing of the
      // page's is stored for the day then).
      const putBack = originals.has(date) && sameDraft(row, originals.get(date));
      if (hasText("dcDayHasDraft")) {
        // U3 restored (round 19 skipped it): under the banner the card files
        // nothing — and the banner's amount is the draft that IS stored.
        const m = document.body.textContent.match(/dcDayHasDraftBody:([−\-\d.,]+)/);
        if (m && row && row.status === "draft") {
          STATS.I6 += 1;
          const banner = Number(m[1].replace(/\./g, "").replace(",", ".").replace("−", "-"));
          expect(Math.abs(banner - row.revenue_total) < 0.005, fail("I6 the banner is the stored draft",
            `banner ${m[1]}, stored ${row.revenue_total}`)).toBe(true);
        }
      } else if (readable && row && row.status === "draft" && postedHere.has(date) && !M.synced && !putBack) {
        const shown = val(total.value);
        if (Math.abs(shown - row.revenue_total) >= 0.005) {
          STATS.I6 += 1;
          expect(Boolean(q('[data-testid="dc-scan-unsaved"]')),
            fail("I6 card filed or said", `card ${total.value}, stored ${row.revenue_total}, no "ikke gemt endnu"`)).toBe(true);
        }
      }
      return;
    }
    if (q('[data-testid="dc-date-move"]')) return;
    if (hasText("dcDayHasDraft") || hasText("dcDayAlreadyLocked")) return;
    const date = q("#close-date").value;
    const row = S.rows.get(`${date}|`);
    if (!(await toStep("review"))) return;
    const R = readReview();
    if (!(R.total > 0)) return;
    const where_ = `${date}: review ${JSON.stringify(R)} vs stored ${JSON.stringify(row && {
      revenue_total: row.revenue_total, moms_total: row.moms_total, revenue_breakdown: row.revenue_breakdown,
      payment_breakdown: row.payment_breakdown, notes: row.notes, moms_mode: row.moms_mode,
    })}`;
    // I1 — the review is what the server holds.
    STATS.I1 += 1;
    expect(row, fail("I1 review = stored", `nothing stored. ${where_}`)).toBeTruthy();
    expect(Math.abs(row.revenue_total - R.total) < 0.005, fail("I1 review = stored", `total. ${where_}`)).toBe(true);
    expect(Math.abs(row.moms_total - R.moms) < 0.005, fail("I1 review = stored", `MOMS. ${where_}`)).toBe(true);
    expect(row.revenue_breakdown, fail("I1 review = stored", `revenue lines. ${where_}`)).toEqual(R.rev);
    expect(row.payment_breakdown, fail("I1 review = stored", `payments. ${where_}`)).toEqual(R.pay);
    expect(row.notes || "", fail("I1 review = stored", `note. ${where_}`)).toBe(R.notes);
    // I3 — no till counted twice: with every till's figure known, the day
    // saves exactly their sum.
    if (M.exact && M.scans.length && !M.pending.length && !M.pageIn) {
      const want = r2((ownFig() ? M.ownTotal : 0) + M.scans.reduce((a, s) => a + s.total, 0));
      STATS.I3 += 1;
      expect(Math.abs(R.total - want) < 0.005, fail("I3 no till twice", `review ${R.total}, tills ${want} (own ${ownFig() ? M.ownTotal : 0} + ${M.scans.map((s) => s.total).join(" + ")})`)).toBe(true);
    }
  };

  // One owner step: do it, let the page settle, update the test's own
  // picture of the day (`then`), and check everything.
  const step = async (label, fn, then) => {
    // The review variant: now and then the network is slow for a step — its
    // saves and deletes are still on their way during the next one.
    if (review && !slowStep && !S.held.length && chance(0.3)) {
      slowStep = true;
      S.holding.post = true; S.holding.del = true;
      label += " (slow)";
    }
    log.push(label);
    STATS.steps += 1;
    await fn();
    await settle();
    if (then) then();
    await checkpoint();
  };
  const tap = (re) => {
    const b = findBtn(re);
    if (!b) throw new Error(fail("harness", `no button ${re} on the page (at ${where()})`));
    fireEvent.click(b);
  };

  /* ─── actions ─── */

  const ensureForm = async () => {
    for (let i = 0; i < 4 && !onForm(); i++) {
      const at = where();
      if (at === "idle") {
        if (hasText("dcDayHasDraft")) { await step("continue draft", () => tap(/^dcContinueDraft$/), onReopenLoaded); continue; }
        if (hasText("dcDayAlreadyLocked")) return false;
        const skip = findBtn(/^skipEnterManually$/);
        if (!skip) return false;
        await step("skip", () => { fireEvent.click(skip); });
      } else if (at === "card") {
        if (q('[data-testid="dc-terminal-question"]')) await answer(pick(["sum", "sum", "replace", "drop"]));
        else await apply(pick(["review", "steps"]));
      } else return false;
    }
    if (hasText("dcDayHasDraft") && onForm()) {
      // Moved onto a day that has a draft: continue it, or start over over it.
      // Continued: the figures carried onto this day are not filed for it
      // (the draft is) — a move onto it is not made, nothing is taken off
      // the day they came from.
      if (chance(0.5)) await step("continue that draft", () => tap(/^dcContinueDraft$/), () => { if (pendingMove && pendingMove.to === q("#close-date")?.value) pendingMove = null; onReopenLoaded(); });
      else {
        const d = q("#close-date")?.value;
        await step("start over that draft", () => tap(/^dcStartOverDraft$/), () => { if (d) startedOverHere.add(d); });
      }
    }
    if (hasText("dcDayAlreadyLocked")) return false;
    if (q('[data-testid="dc-date-move"]')) {
      await step("use them for the new day", () => tap(/^dcDateMoveKeep/), () => {
        const from = moveOrigin;
        if (from && !slowStep) {
          pendingMove = {
            from, to: q("#close-date")?.value, created: createdHere.has(from), filed: postedHere.has(from), posts: S.posts.length,
          };
        }
      });
    }
    return onForm();
  };

  const onReopenLoaded = () => {
    const date = q("#close-date")?.value || today;
    const row = S.rows.get(`${date}|`);
    resetDay();
    if (row) {
      M.draftPhoto = row.receipt_photo || null;
      M.ownKind = row.source_meta?.kind === "zbon" ? "draftZbon" : "draft";
      // F1: the count as it was saved, with the float it was counted with
      // (this device's only when the row has none).
      if (row.cash_counted != null) {
        const float = row.cash_float != null ? Number(row.cash_float) : deviceFloat();
        M.loadedCash = { drawer: r2(Number(row.cash_counted) + float), float };
      }
      // F6: the Z-bon read's lines as it was opened.
      if (row.source_meta?.kind === "zbon") {
        M.zbonLoaded = {
          date, revenue_breakdown: { ...(row.revenue_breakdown || {}) }, payment_breakdown: { ...(row.payment_breakdown || {}) },
          corrected: [...(row.source_meta.corrected || [])],
          // The MOMS it was opened with (null: opened on Auto).
          moms: row.moms_mode === "manual" && row.moms_total != null ? Number(row.moms_total) : null,
        };
      }
      M.form = { rev: { ...(row.revenue_breakdown || {}) }, pay: { ...(row.payment_breakdown || {}) } };
      const lines = r2(sumOf(M.form.rev));
      const t = r2(Number(row.revenue_total) || 0);
      M.draftFloor = t > 0 && t > lines + 0.005 ? t : null;
      M.draftPinned = t > 0 && t < lines - 0.005 ? t : null;
      M.ownTotal = t > 0 ? t : r2(sumOf(M.form.pay));
    }
  };

  const typeBox = async (kind, key, value) => {
    if (!(await ensureForm())) return;
    await toStep(kind === "rev" ? "s1" : "s2");
    const el = q(kind === "rev" ? `#dc-rev-${key}` : `#dc-pay-${key}`);
    if (!el) return;
    await step(`${kind}.${key}=${value === "" ? "∅" : value}`, () => {
      if (value === "") { if (el.value !== "") fireEvent.change(el, { target: { value: "" } }); } else keyIn(el, value);
    }, () => typedInto(kind, key, value));
  };
  const typedInto = (kind, key, value) => {
    if (photosIn()) M.exact = false;
    else {
      M.form[kind][key] = value;
      if (!M.ownKind || M.ownKind === "typed") {
        M.ownKind = "typed";
        M.ownTotal = typedTotal();
      } else {
        // A reopened draft's till: its saved total stays a floor under lines
        // raised past it (closeTills.formSideScan); a total typed under its
        // lines stays typed.
        const lines = r2(sumOf(M.form.rev));
        M.ownTotal = M.draftPinned != null ? M.draftPinned
          : M.draftFloor != null ? Math.max(M.draftFloor, lines)
            : (lines > 0 ? lines : r2(sumOf(M.form.pay)));
      }
    }
  };

  const toCard = async () => {
    if (!onForm()) return where() === "card" || where() === "idle";
    if (hasText("dcDayHasDraft") || hasText("dcDayAlreadyLocked")) return false;
    if (q('[data-testid="dc-date-move"]')) return false;
    await toStep("s1");
    const back = findBtn(/^←\s*scanZReportBack$/);
    if (!back) return false;
    shownDay = q("#close-date")?.value || shownDay;
    await step("← scan Z-bon", () => { fireEvent.click(back); });
    return true;
  };

  let photoN = 0;
  const shoot = async (key, { same = false } = {}) => {
    const at = where();
    if (at !== "card" && at !== "idle") return;
    if (q('[data-testid="dc-terminal-question"]')) return;
    if (hasText("dcDayHasDraft") || hasText("dcDayAlreadyLocked")) return;
    const name = same && M.photos.size ? [...M.photos][M.photos.size - 1] : `p${++photoN}-${key}.jpg`;
    const stub = BONS[key];
    const dup = M.photos.has(name);
    // Expected: a photo with its own total, on a day that already holds a
    // till with figures (or a question already open), is asked about.
    const total = bonTotal(stub);
    const tillWithFigures = M.pending.length > 0 || M.scans.some((s) => s.total != null) || ownFig();
    const mustAsk = !dup && total != null && tillWithFigures;
    if (!photosIn() && !dup) {
      // Whether the owner's till's figure was known then (a card total
      // emptied before the photo is not a known figure): Start forfra gives
      // that till back as it was, unknown included.
      M.atFirst = { form: JSON.parse(JSON.stringify(M.form)), ownTotal: M.ownTotal, ownKind: M.ownKind, draftFloor: M.draftFloor, draftPinned: M.draftPinned, exact: M.exact };
    }
    const file = new File([name], name, { type: "image/jpeg", lastModified: 1 });
    // The server stores the photo and answers with its path, as the real
    // scan does: the page files it as the close's receipt_photo (M4b).
    S.nextScan = { ...stub, image_url: photoUrl(name) };
    const input = [...document.querySelectorAll('input[type="file"]')].at(-1);
    await step(`photo ${name}${dup ? " (same)" : ""}`, async () => {
      fireEvent.change(input, { target: { files: [file] } });
      for (let i = 0; i < 20 && where() === "scanning"; i++) await settle();
    }, () => {
      const asked = Boolean(q('[data-testid="dc-terminal-question"]'));
      if (dup) {
        expect(asked, fail("I2 same photo once", `${name} again raised the question`)).toBe(false);
        return;
      }
      // I2 — every new till is asked.
      if (mustAsk) STATS.I2 += 1;
      if (mustAsk) expect(asked, fail("I2 every till asked", `${name} (${total}) folded in without "another terminal?"`)).toBe(true);
      M.photos.add(name);
      if (asked) {
        M.undo.push({ kind: "queue", snap: snap() });
        M.pending.push({ name, total });
      } else if (total == null) {
        M.undo.push({ kind: "page", snap: snap() });
        M.pageIn = true;
        M.exact = false;
      } else {
        M.undo.push({ kind: "scan", snap: snap() });
        // The day's first till: the owner's empty till goes.
        M.scans.push({ name, total });
        if (!ownFig()) M.ownActive = false;
      }
    });
  };

  const answer = async (how) => {
    const qEl = q('[data-testid="dc-terminal-question"]');
    if (!qEl) return;
    const re = how === "sum" ? /^scanSecondTotalSum/ : how === "replace" ? /^scanSecondTotalReplace/ : /^dcScanSamePhotoDiscard/;
    const btn = findBtn(re);
    if (!btn) { if (how === "drop") return answer(pick(["sum", "replace"])); return; }
    const head = M.pending[0];
    await step(`answer ${how}`, () => { fireEvent.click(btn); }, () => {
      if (!head) { M.exact = false; return; }
      M.undo.push({ kind: how, snap: snap() });
      M.pending = M.pending.slice(1);
      if (how === "sum") M.scans.push(head);
      else if (how === "replace") { M.scans = [head]; M.ownActive = false; M.pageIn = false; }
      else M.photos.delete(head.name);
    });
  };

  const apply = async (how) => {
    if (where() !== "card" || q('[data-testid="dc-terminal-question"]')) return;
    const btn = findBtn(how === "review" ? /^useTheseValuesJumpReview$/ : /^continueStepByStep$/);
    if (!btn || btn.disabled) return;
    await step(how === "review" ? "Brug disse tal" : "trin for trin", () => { fireEvent.click(btn); });
  };

  const fortryd = async () => {
    if (where() !== "card") return;
    const btn = findBtn(/^scanMergedUndo$/);
    if (!btn) return;
    await step("Fortryd", () => { fireEvent.click(btn); }, () => {
      const top = M.undo.pop();
      if (top && ["sum", "replace", "page", "drop"].includes(top.kind)) restore(top.snap);
      else M.exact = false;
    });
  };

  const startOver = async () => {
    if (where() !== "card") return;
    const btn = findBtn(/^startOver$/);
    if (!btn) return;
    const day = businessDayShown();
    const rowAtTap = day && S.rows.get(`${day}|`);
    const wasRow = rowAtTap ? JSON.parse(JSON.stringify(rowAtTap)) : null;
    const sentBefore = day ? lastSent[day] || null : null;
    await step("Start forfra", async () => { fireEvent.click(btn); for (let i = 0; i < 5 && where() === "card"; i++) await settle(); }, () => {
      const a = M.atFirst;
      M.undo.push({ kind: "discard", snap: snap() });
      M.scans = []; M.pending = []; M.pageIn = false; M.photos = new Set(); M.ownActive = true;
      if (a) { M.form = a.form; M.ownTotal = a.ownTotal; M.ownKind = a.ownKind; M.draftFloor = a.draftFloor; M.draftPinned = a.draftPinned; }
      M.exact = a ? a.exact !== false : true;
      M.atFirst = null;
      // A photo-only day emptied (M6) — checked once this step's requests
      // have arrived (a slow step's are checked by I1/M4 after the next).
      if (!ownFig() && day && postedHere.has(day) && !slowStep) { emptiedDay = day; emptiedRow = wasRow; emptiedSent = sentBefore; }
      // A draft holding the owner's own fields is kept (F3): until the page
      // sends the day again, the stored row is the one filed before — its
      // photo included (the card says "Ikke gemt endnu").
      if (!ownFig() && day && postedHere.has(day) && ownFields(sentBefore)) {
        keptDrafts.set(day, { photos: [sentBefore.receipt_photo, wasRow?.receipt_photo].filter(Boolean), seq: sendSeq });
      }
    });
  };

  const cardTotal = async (mode) => {
    if (where() !== "card" || q('[data-testid="dc-terminal-question"]')) return;
    const el = q("#scan-total");
    if (!el) return;
    const was = el.value;
    const unknown = () => { if (mode !== "same") M.exact = false; };
    if (mode === "empty") await step("card total ∅", () => { fireEvent.change(el, { target: { value: "" } }); }, unknown);
    else if (mode === "same") await step(`card total retyped ${was}`, () => { keyIn(el, was); }, unknown);
    else {
      const v = pick(["21.530", "16.500", "4.000", "17.030"]);
      await step(`card total ${v}`, () => { keyIn(el, v); }, unknown);
    }
  };

  const notes = async () => {
    if (!(await ensureForm())) return;
    await toStep("review");
    const el = q("#dc-notes");
    if (!el) return;
    const v = el.value;
    if (v.endsWith("x") && chance(0.7)) await step("note ⌫", () => { fireEvent.change(el, { target: { value: v.slice(0, -1) } }); });
    else await step("note +x", () => { fireEvent.change(el, { target: { value: `${v}x` } }); });
  };

  const moms = async () => {
    if (!(await ensureForm())) return;
    await toStep("review");
    if (chance(0.5)) {
      const chip = findBtn(/^fromReceipt$/);
      if (!chip) return;
      await step("MOMS fra kvittering", () => { fireEvent.click(chip); });
      const box = document.querySelector('input[placeholder="momsAmountPlaceholder"]');
      if (box && chance(0.7)) await step("MOMS typed", () => { keyIn(box, pick(["600", "2.400", "3.000"])); });
    } else {
      const chip = findBtn(/^autoLabel$/);
      if (chip) await step("MOMS auto", () => { fireEvent.click(chip); });
    }
  };

  // A day on a card (a photo's till in it) moves with no question: once the
  // new day is filed, the old day's draft goes the same way (MV).
  const cardMove = (from, to) => {
    if (slowStep || q('[data-testid="dc-date-move"]') || !photosIn() || !postedHere.has(from)) return;
    pendingMove = { from, to, created: createdHere.has(from), filed: true, posts: S.posts.length, card: true };
  };
  const moveDate = async () => {
    if (!(await ensureForm())) return;
    const el = q("#close-date");
    if (!el || el.disabled) return;
    const to = pick([today, yesterday, twoDaysAgo].filter((d) => d !== el.value));
    // The day the figures were typed for (moved again before answering: still the first).
    if (!q('[data-testid="dc-date-move"]')) moveOrigin = el.value;
    const from = el.value;
    await step(`date → ${to}`, () => { fireEvent.change(el, { target: { value: to } }); }, () => {
      if (to === twoDaysAgo) { M.exact = false; M.synced = true; }
      cardMove(from, to);
    });
    await ensureForm();
  };
  // Review variant: "Brug dem", then another date before the new day is
  // filed (inside the autosave's 2 s), then "Brug dem" or "Hent … salg".
  // The figures are still the first day's: the second answer moves them
  // from THAT day — and "Hent" leaves that day's draft where it is.
  const doubleMove = async () => {
    if (!(await ensureForm())) return;
    const el = q("#close-date");
    if (!el || el.disabled || q('[data-testid="dc-date-move"]')) return;
    const origin = el.value;
    const [mid, last] = [today, yesterday, twoDaysAgo].filter((d) => d !== origin);
    await arriveAll();
    const originRow = S.rows.get(`${origin}|`);
    const originBefore = originRow && JSON.parse(JSON.stringify(originRow));
    let asked = false;
    await step(`date → ${mid}, Brug dem, date → ${last} (inside 2 s)`, async () => {
      fireEvent.change(el, { target: { value: mid } });
      await settle();
      const keep = findBtn(/^dcDateMoveKeep/);
      if (!keep) return;
      fireEvent.click(keep);
      await settle();
      fireEvent.change(q("#close-date"), { target: { value: last } });
      await settle();
      asked = Boolean(q('[data-testid="dc-date-move"]'));
    }, () => { M.exact = false; if (last === twoDaysAgo || mid === twoDaysAgo) M.synced = true; });
    if (!asked) return;
    const fetch = findBtn(/^dcDateMoveFetch/);
    if (fetch && chance(0.5)) {
      await step("Hent … salg", () => { fireEvent.click(fetch); }, () => { M.form = { rev: {}, pay: {} }; M.ownKind = null; M.ownTotal = 0; M.loadedCash = null; });
      // Nothing moved: the first day's draft is still its own.
      if (originBefore && !slowStep && !S.held.length) {
        const row = S.rows.get(`${origin}|`);
        STATS.MV += 1;
        expect(Boolean(row) && row.status === originBefore.status && Math.abs(row.revenue_total - originBefore.revenue_total) < 0.005, fail("MV a date move moves, not copies",
          `"Hent" after a second date change took ${origin}'s draft (${originBefore.revenue_total}) off it: stored ${brief(row)}`)).toBe(true);
      }
      return;
    }
    await step("use them for the new day", () => tap(/^dcDateMoveKeep/), () => {
      if (!slowStep) pendingMove = { from: origin, to: last, created: createdHere.has(origin), filed: postedHere.has(origin), posts: S.posts.length };
    });
    // The note names the first day, never the one in between.
    const note = q('[data-testid="dc-date-moved"]');
    if (note) {
      const short = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(dateLocale(), { day: "numeric", month: "short" });
      expect(note.textContent.includes(short(origin)) && !note.textContent.includes(short(mid)), fail("MV a date move moves, not copies",
        `the note should name ${origin}, not ${mid}: ${note.textContent}`)).toBe(true);
    }
  };

  // Whatever is still on its way arrives (a slow step overlaps the owner's
  // next step on the same page; a reload racing a save is another matter).
  const arriveAll = async () => {
    while (S.held.length) { await act(async () => { S.releaseHeld(); await new Promise((r) => setTimeout(r, 0)); }); await settle(); }
  };
  const reopen = async () => {
    await arriveAll();
    await step("leave + reopen", async () => {
      await unmount();
      mount();
      await loaded();
    }, resetDay);
    if (hasText("dcDayHasDraft")) await step("Fortsæt kladden", () => tap(/^dcContinueDraft$/), onReopenLoaded);
  };

  const lock = async () => {
    // Whatever is still on its way arrives first.
    await arriveAll();
    if (!(await ensureForm())) return false;
    if (!(await toStep("review"))) return false;
    const btn = findBtn(/confirmAndLock/);
    if (!btn || btn.disabled) return false;
    const R = readReview();
    const date = q("#close-date").value;
    log.push("Bekræft & lås");
    await act(async () => { fireEvent.click(btn); await new Promise((r) => setTimeout(r, 0)); });
    await settle();
    checkPosts();
    const row = S.rows.get(`${date}|`);
    if (!row || row.status !== "confirmed") return true;
    const where_ = `${date}: review ${JSON.stringify(R)} vs locked ${JSON.stringify({ revenue_total: row.revenue_total, moms_total: row.moms_total })}`;
    STATS.I1lock += 1;
    expect(Math.abs(row.revenue_total - R.total) < 0.005, fail("I1 review = locked", `total. ${where_}`)).toBe(true);
    expect(Math.abs(row.moms_total - R.moms) < 0.005, fail("I1 review = locked", `MOMS. ${where_}`)).toBe(true);
    // M4 / M4b on the locked kasserapport itself.
    checkStoredRow(date, row);
    return true;
  };

  // r20 — another device scans the day (its photo lands on the server
  // behind the page's back), on a draft that holds no photo: the page must
  // never clear it with "" (F4).
  const otherDevice = async () => {
    await arriveAll();
    const date = businessDayShown();
    const row = date && S.rows.get(`${date}|`);
    if (!row || row.status !== "draft" || row.receipt_photo) return;
    await step(`another device scans ${date}`, () => { row.receipt_photo = OTHER_PHOTO; }, () => { M.otherPhotos[date] = OTHER_PHOTO; });
  };
  // r20 — the sequences lane's repro (item 3): a photo-only day, the owner's
  // own note typed on the review, back to the card, Start forfra (F3).
  const photoNoteStartOver = async () => {
    if (!(await toCard())) return;
    if (where() === "idle" && !photosIn()) {
      await shoot(pick(BON_KEYS));
      if (q('[data-testid="dc-terminal-question"]')) await answer("sum");
    }
    // The photo's figures filed (step by step), then the note on the review.
    if (where() === "card" && !q('[data-testid="dc-terminal-question"]')) await apply("steps");
    if (!onForm()) return;
    await notes();
    if (!(await toCard()) || where() !== "card") return;
    await startOver();
  };

  /* ─── motifs: short chains an owner actually walks ─── */

  const field = () => (chance(0.65) ? ["rev", pick(REV)] : ["pay", pick(PAY)]);
  const MOTIFS = [
    [4, async () => { const [k, f] = field(); await typeBox(k, f, pick(VALUES)); }],
    // Change a figure, let it save, put it back (the reopened-draft trap).
    [5, async () => {
      if (!(await ensureForm())) return;
      const [k, f] = field();
      await toStep(k === "rev" ? "s1" : "s2");
      const was = q(k === "rev" ? `#dc-rev-${f}` : `#dc-pay-${f}`)?.value ?? "";
      if (chance(0.5)) await typeBox(k, f, "");
      else await typeBox(k, f, was ? `${was}0` : pick(VALUES));
      await typeBox(k, f, was || pick(VALUES));
    }],
    // Another bon: photo, answer, apply.
    [6, async () => {
      if (!(await toCard())) return;
      await shoot(pick(chance(0.15) ? ["page"] : BON_KEYS));
      if (q('[data-testid="dc-terminal-question"]')) await answer(pick(["sum", "sum", "replace", "drop"]));
      await apply(pick(["review", "steps"]));
    }],
    // Back to the card after a saved photo: Fortryd or Start forfra, then on.
    [5, async () => {
      if (!(await toCard())) return;
      if (where() !== "card") return;
      if (chance(0.45)) await fortryd();
      if (where() === "card" && (q('[data-testid="dc-terminal-question"]') ? chance(0.5) : chance(0.6))) await startOver();
      if (where() === "card") {
        if (q('[data-testid="dc-terminal-question"]')) await answer(pick(["sum", "replace", "drop"]));
        await apply(pick(["review", "steps"]));
      } else if (where() === "idle") {
        if (chance(0.3)) { await shoot(pick(BON_KEYS)); if (q('[data-testid="dc-terminal-question"]')) await answer("sum"); await apply("steps"); } else await ensureForm();
      }
    }],
    // The card's total emptied, then the next till's bon.
    [4, async () => {
      if (!(await toCard())) return;
      if (where() === "idle") { await shoot(pick(BON_KEYS)); if (q('[data-testid="dc-terminal-question"]')) await answer("sum"); }
      if (where() !== "card") return;
      await cardTotal("empty");
      await shoot(pick(BON_KEYS));
      if (q('[data-testid="dc-terminal-question"]')) await answer(pick(["sum", "replace", "drop"]));
      if (q("#scan-total")?.value === "" && chance(0.7)) await cardTotal("set");
      await apply(pick(["review", "steps"]));
    }],
    // The card's total retyped (unchanged, or to another figure).
    [2, async () => {
      if (!(await toCard()) || where() !== "card") return;
      await cardTotal(chance(0.6) ? "same" : "set");
      await apply(pick(["review", "steps"]));
    }],
    // The same photo picked again.
    [1, async () => {
      if (!M.photos.size || !(await toCard()) || where() !== "card") return;
      await shoot("b3000", { same: true });
      await apply("steps");
    }],
    // A bon read as a total only, applied, then the date moved onto a day
    // the POS synced: its sales fill the empty boxes under the card.
    [1, async () => {
      if (!(await toCard()) || where() !== "idle") return;
      await shoot("t2500");
      if (q('[data-testid="dc-terminal-question"]')) { await answer("drop"); await apply("steps"); return; }
      await apply("steps");
      const el = q("#close-date");
      if (!el || el.disabled || el.value === twoDaysAgo) return;
      // The sync's figures join the day (the server takes the larger): no
      // till-by-till sum to hold the review to.
      if (!q('[data-testid="dc-date-move"]')) moveOrigin = el.value;
      const from = el.value;
      await step(`date → ${twoDaysAgo} (synced)`, () => { fireEvent.change(el, { target: { value: twoDaysAgo } }); }, () => { M.exact = false; M.synced = true; cardMove(from, twoDaysAgo); });
      await ensureForm();
    }],
    [2, moveDate],
    ...(review ? [[2, doubleMove]] : []),
    ...(r20 ? [[2, otherDevice], [3, photoNoteStartOver]] : []),
    [2, reopen],
    [2, notes],
    [2, moms],
  ];
  const weightSum = MOTIFS.reduce((a, [w]) => a + w, 0);
  const pickMotif = () => {
    let r = rnd() * weightSum;
    for (const [w, fn] of MOTIFS) { if ((r -= w) < 0) return fn; }
    return MOTIFS[0][1];
  };

  /* ─── run ─── */
  STATS.sequences += 1;
  try {
    mount();
    await loaded();
    if (opening === "draft") {
      await step("Fortsæt kladden", () => tap(/^dcContinueDraft$/), onReopenLoaded);
    } else if (opening === "bannerTyped" || opening === "bannerScan") {
      // The day's draft, replaced: "Start forfra" on its banner.
      await step("Start forfra (banner)", () => tap(/^dcStartOverDraft$/), () => startedOverHere.add(today));
      if (opening === "bannerScan") {
        await shoot(pick(BON_KEYS));
        await apply(pick(["review", "steps"]));
      } else {
        await step("skip", () => tap(/^skipEnterManually$/));
        await typeBox("rev", "food", pick(VALUES));
        await typeBox("pay", "card", pick(VALUES));
      }
    } else if (opening === "scan") {
      await shoot(pick(BON_KEYS));
      await apply(pick(["review", "steps"]));
    } else {
      await step("skip", () => tap(/^skipEnterManually$/));
      if (opening === "momsfri") await typeBox("rev", "food", pick(["750", "2.000", "1.500"]));
      else {
        await typeBox("rev", "food", pick(VALUES));
        if (chance(0.6)) await typeBox("rev", "drinks", pick(VALUES));
        await typeBox("pay", "card", pick(VALUES));
      }
    }
    const motifs = 2 + Math.floor(rnd() * 3);
    for (let m = 0; m < motifs; m++) await pickMotif()();
    if (chance(0.25)) await lock();
  } finally {
    await arriveAll();
    await unmount();
    cleanup();
  }
  return { steps: log.length, log };
}
