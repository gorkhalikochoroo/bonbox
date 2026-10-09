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
 * Round 21 (the "r21" variant) — the network the owner actually has, held to
 * what is STORED:
 *   - a SLOW / REORDERED network: a save can be held on its way (it reaches
 *     the server later, in the order sent) OR reach the server at once and
 *     have its ANSWER held; the history list and a read by id answer at once
 *     — before a save still on its way has landed; the page is left and
 *     opened again while a save is on its way;
 *   - another device saving the day's figures behind the page's back;
 *   - a day whose own till is payments only (no revenue line typed).
 * And, after every step and once every save has settled:
 *   R   no stale overwrite: a save never lands over a version of the day's
 *       row that the page sending it never received (a save from its own
 *       previous visit, another device's) — the server's version check
 *       (base_updated_at → 412 draft_changed) is mirrored by the stub;
 *   I1z what the review shows is stored on a day of payments only too
 *       (revenue 0): never nothing, never the figures of a thrown-away bon;
 *   I7  the stored row is the page's last save for the day: cash, the
 *       source, the photo (the null-keeps rule included);
 *   the page's "the draft was changed elsewhere" choice (dc-draft-changed)
 *   is answered — "the newest" or "mine" — and checked like any step.
 *
 * Round 22 (the "r22" variant) — the r21 variant over the round's FIXED
 * failure model, every class of it at random: slow saves, reordered
 * answers, a save that is STORED but whose ANSWER IS LOST (a dropped socket,
 * a 4G handoff, the timeout — now a random slow mode beside "held" and "late
 * answer", on date moves, the banner's and the card's Start forfra, and on
 * leaving and coming back), the page left and opened again during a save,
 * another device saving — or LOCKING — the day, offline. Held to:
 *   MV / M6 with a lost answer: the stored row(s) are what the owner last saw
 *       or chose — a day "moved" is never also left on the old date, and a
 *       Start forfra takes the photo's draft back (or the replaced draft
 *       comes back) though the save that filed it never answered;
 *   LK  a day another device locked is said: once a save of this visit met
 *       the lock, the wizard shows "Dagen er allerede lukket og låst" (with
 *       the amount the lock holds, when it says one) — never edits refused
 *       in silence.
 * The stub answers a read of one day (GET /daily-close?from=&to=) with each
 * row's last_save_id, as the backend does. OFFLINE is a random slow mode too:
 * the browser says offline, and every request for the day's close (its saves,
 * deletes and reads — not the photo's scan) fails with no answer and stores
 * nothing; at the step's end the browser is online again, and the step is
 * checked once the page's saves have settled — a Start forfra or a move
 * taken OFFLINE is held to the same M6 / MV as any other once online (the
 * page does the take-back then).
 *
 * Round 23 (the "r23" variant, and every variant's expectations) — the
 * SIMPLIFIED model the owner chose (9 Oct): Start forfra (the scan card's or
 * the day's draft banner's) is an explicit action — a question that names the
 * draft and its amount, then ONE version-checked delete of that day's draft
 * by the server, and the form starts over empty (412: the newer draft is
 * kept and shown; offline: nothing changes, and the page says so); a scan is
 * unavailable offline (the buttons are gray and say why; a pick or a scan
 * whose connection drops changes nothing); a date move WITH figures is asked
 * first ("Flyt tallene til {to}? Kladden for {from} slettes." — yes / no /
 * "Hent {dag}s salg"). The page's questions (useConfirm) are answered by this
 * harness (`__dcSeqConfirm`, mocked in each sequence file): yes in the older
 * variants, at random in "r23". Held to:
 *   M6  a Start forfra answered yes: the day's draft is gone (deleted on the
 *       version shown — the question named exactly the amount deleted) and
 *       the page is on an empty scan start; or a newer version from another
 *       device is kept and the banner shows it; or a lock is said; or — the
 *       delete could not be done — the page says so and nothing changed;
 *   MV  a move answered yes: once the new day is filed, "Flyttet fra" only
 *       when the old day's draft is gone; the old day still holding a draft
 *       is said ("Kopieret til … står der stadig") — a day reported moved is
 *       never on the old date; answered no, nothing moves; the question
 *       names the old day's draft when there is one;
 *   B   offline, no scan: "← Scan Z-bon" is gray with its reason, and a photo
 *       picked (or a scan whose connection drops) changes nothing.
 * Round 23 review — and to:
 *   D   no draft is deleted on a guess of whose it is: every delete the page
 *       makes (the card's Start forfra, a move's old day, "Slet den") removes
 *       a version this visit's FORM held (opened, or written by its own
 *       save) — never one another device, another visit, or an offline
 *       queue's copy wrote that the form was never given (the banner's Start
 *       forfra deletes the version it showed: M6). MV's round-22 branch
 *       ("another device's version deleted with the moved figures") is back;
 *   MT  the line under the date: a day said moved or copied TO holds a
 *       stored row, a day said moved FROM holds no draft, and while the new
 *       day's save is unconfirmed ("Ikke gemt for {to} endnu") nothing is
 *       offered to delete.
 * with writers that send no save id (another phone's queued copy; another
 * visit's copy on this phone's queue), day reads that cannot say who wrote a
 * day last (no last_save_id), a dead line (the form's saves die, the browser
 * online), "Slet den" and "Prøv igen" tapped, and Start forfra tapped with
 * the save of "Brug disse tal" still on its way (never released first). The
 * new knobs draw from a stream of their own (`rnd2`): every earlier seed's
 * own choices are unchanged.
 * Retired with round 23 (they held automatic behaviour that is gone): F3
 * (Start forfra kept a draft holding the owner's fields — it now deletes the
 * draft by the owner's confirmed choice), the replaced-draft checks of M6 /
 * MV / M4b / F4 (the banner's Start forfra deletes the draft now — nothing is
 * replaced to put back), MV's "a card day moves with no question" and
 * "Brug dem" (every move with figures is asked), and doubleMove's "the note
 * names the first day" (the new day is filed at once, so a second move is a
 * move from the day in between — the note names the day the figures left).
 *
 * The stub server is the backend's save rule in miniature — keep it in step
 * with backend/app/routers/daily_close.py (revenue_total, the MOMS rules,
 * updated_at and the draft_changed check).
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { expect } from "vitest";
import { businessTodayIso, dateLocale } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";
import { addToOfflineQueue } from "../utils/dailyCloseQueue";

/** How many times each invariant was actually checked (SEQ_STATS=1 prints them). */
export const STATS = {
  sequences: 0, steps: 0, I1: 0, I1lock: 0, I2: 0, I3: 0, I4: 0, I5: 0, I6: 0, M4: 0, M4b: 0, M6: 0, MV: 0, F1: 0, F3: 0, F4: 0, F6: 0, F6m: 0,
  R: 0, I1z: 0, I7: 0, conflicts: 0, newerElsewhere: 0,
  // Round 22: answers lost (stored, never heard), MV / M6 checked on a day
  // with one, and LK.
  lostAnswers: 0, MVlost: 0, M6lost: 0, LK: 0, offlineSteps: 0, M6offline: 0,
  // Round 23: Start forfra that could not be done (said, nothing changed),
  // the questions' wording checked, a move answered no / "Hent salg", the
  // scan refused offline (B), a scan whose connection dropped.
  M6failed: 0, M6said: 0, MVsaid: 0, MVno: 0, MVfetch: 0, MVcopy: 0, B: 0, Bdrop: 0,
  // Round 23 review: D (no draft deleted on a guess of whose it is), a
  // move's new day said moved/copied TO holds a stored row (MT), a move whose
  // new day is unconfirmed (MVpending — no "Slet den"), "Slet den" tapped,
  // Start forfra tapped with a save on its way (M6race), saves that died on
  // a dead line, writers with no save id, day reads that could not check.
  D: 0, Dother: 0, MT: 0, MVpending: 0, MVdeleteOld: 0, M6race: 0, deadSaves: 0, noIdWriters: 0, unknownReads: 0,
};

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

/** The row's day key, as the stub stores it. */
const keyOf = (r) => `${String(r.date).slice(0, 10)}|${r.branch_id || ""}`;
/** The page's "I knew of no row for this day" base (DailyClosePage NO_ROW_BASE). */
export const NO_ROW_BASE = "1970-01-01T00:00:00";

export function createServer({ exemptByDate = {}, rows = [], syncedDates = [] } = {}) {
  const S = { rows: new Map(), exemptByDate, syncedDates: new Set(syncedDates), posts: [], nextScan: null, seq: 0, lockConflicts: 0 };
  // Round 21 — every row has a version: updated_at (what the server answers
  // and the page sends back as base_updated_at) and a counter the harness
  // reads (R). A save that changes nothing keeps both, as an UPDATE that
  // sets the same values does on the real database.
  S.clock = 0;
  S.stamp = () => { S.clock += 1; return `${new Date(Date.UTC(2026, 9, 8, 8) + S.clock * 1000).toISOString().slice(0, 19)}.000000`; };
  S.ver = new Map();
  // Round 23 — counted per DAY, not per row: Start forfra deletes a draft and
  // the day's next save makes a new row; a per-row count started again at 1,
  // under a version the page had already seen of the deleted row (another
  // device's save then looked "seen" — seed 8070).
  S.keyVer = new Map();
  S.bump = (row) => {
    row.updated_at = S.stamp();
    const k = keyOf(row);
    const v = Math.max(S.keyVer.get(k) || 0, S.ver.get(row.id) || 0) + 1;
    S.keyVer.set(k, v);
    S.ver.set(row.id, v);
    return row;
  };
  S.verOf = (row) => (row ? S.ver.get(row.id) || 0 : 0);
  // Which version of each day every mount of the page was given (a list, a
  // read by id, a refusal's stored draft, its own landed save): R and I1.
  S.mountNow = 0;
  S.seen = new Map();
  S.see = (mount, key, v) => {
    if (mount == null) return;
    const m = S.seen.get(mount) || new Map();
    if ((m.get(key) || 0) < v) m.set(key, v);
    S.seen.set(mount, m);
  };
  S.seenBy = (mount, key) => S.seen.get(mount)?.get(key) || 0;
  // r22 — which version of each day every mount's FORM holds: opened (a
  // read by id) or written by its own save (answered, late, or its answer
  // lost). A list (or a read of the day the page asks before a take-back)
  // gives the page a version to build on (R) but never puts its figures in
  // the boxes — so going online (the list read again) does not make a draft
  // that landed after the form opened "the form's" for I1.
  S.formSeen = new Map();
  S.formSee = (mount, key, v) => {
    if (mount == null) return;
    const m = S.formSeen.get(mount) || new Map();
    if ((m.get(key) || 0) < v) m.set(key, v);
    S.formSeen.set(mount, m);
  };
  S.formSeenBy = (mount, key) => S.formSeen.get(mount)?.get(key) || 0;
  // Round 23 review — the versions each mount's form HOLDS for D: opened
  // (read by id) or written by its own save — never a copy the offline queue
  // sent (it carries no save id: another visit's figures, synced by whichever
  // visit is open; the form there never held them). And whether a day was
  // written last by such a copy.
  S.formHeld = new Map();
  S.formHold = (mount, key, v) => {
    if (mount == null) return;
    const m = S.formHeld.get(mount) || new Map();
    if ((m.get(key) || 0) < v) m.set(key, v);
    S.formHeld.set(mount, m);
  };
  S.formHeldBy = (mount, key) => S.formHeld.get(mount)?.get(key) || 0;
  S.byQueue = new Map();
  // Saves that landed over a version their page never received (R), saves
  // refused as draft_changed, and who wrote each row last.
  S.stale = [];
  S.refused = [];
  S.offered = new Map();
  S.writer = new Map();
  rows.forEach((r) => {
    if (!r.updated_at) r.updated_at = S.stamp();
    S.ver.set(r.id, 1);
    S.keyVer.set(keyOf(r), 1);
    S.writer.set(keyOf(r), "seed");
    S.rows.set(keyOf(r), r);
  });
  // Another device saves the day behind the page's back: a new version.
  // Round 23 review — `saveId: null`: written by a save with NO id (another
  // phone's — or another visit's — offline-queue copy, a review's lock):
  // the day read then names last_save_id null, never "other-device".
  S.otherSave = (key, change, { saveId = "other-device" } = {}) => {
    const row = S.rows.get(key);
    if (!row) return null;
    change(row);
    S.bump(row);
    S.writer.set(key, "other");
    S.lastSaveId.set(key, saveId);
    return row;
  };
  // Round 23 review — the server could not read who wrote a day last (its
  // audit read failed): a day read names no last_save_id at all ("couldn't
  // check" — never "written by a save with no id").
  S.saveIdUnknown = false;
  // Round 22 — another device LOCKS the day behind the page's back: the row
  // is confirmed (a new version), and the page's next save of it meets the
  // lock (409). `lockHits`: every save (or lock) that met one, by visit.
  S.lockedByOther = new Set();
  S.lockHits = [];
  S.otherLock = (key) => {
    const row = S.rows.get(key);
    if (!row || row.status !== "draft") return null;
    row.status = "confirmed";
    S.bump(row);
    S.writer.set(key, "other");
    S.lastSaveId.set(key, "other-device");
    S.lockedByOther.add(key);
    return row;
  };
  // The days a save's answer was lost on (stored, never heard).
  S.lostKeys = new Set();
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
      payment_total: r2(Object.values(body.payment_breakdown || {}).reduce((a, v) => a + num(v), 0)),
    };
    // The version: kept when nothing changed, else the next one.
    const { updated_at: _u, ...was } = prev || {};
    if (prev && JSON.stringify(was) === JSON.stringify(row)) {
      row.updated_at = prev.updated_at;
    } else {
      if (reused) S.ver.set(row.id, S.ver.get(row.id) || 0);
      S.bump(row);
    }
    S.rows.set(key, row);
    return row;
  };
  // The server's draft_changed rule (create_daily_close, round 21): a live
  // DRAFT stored later than the version the save was built on is refused.
  // The page's own save still on its way when this one went (base_save_id):
  // the version that save wrote does not refuse it (the save id the server
  // keeps on the audit row of the save that wrote the row last).
  S.lastSaveId = new Map();
  S.changedSince = (body) => {
    const key = `${body.date}|${body.branch_id || ""}`;
    const prev = S.rows.get(key);
    if (!prev || prev.status !== "draft" || body.base_updated_at == null || !prev.updated_at) return null;
    if (!(prev.updated_at > body.base_updated_at)) return null;
    if (body.base_save_id && S.lastSaveId.get(key) === body.base_save_id) return null;
    return prev;
  };
  // DELETE /daily-close/{id}: a draft goes (soft-deleted: off the list); a
  // locked close is refused. Round 21 review — the page's version rides
  // along (base_updated_at / base_save_id): a draft saved since by anyone
  // else is refused as draft_changed, as a save is (delete_daily_close).
  S.deletes = [];
  S.deletedRows = [];
  S.refusedDeletes = [];
  S.dead = new Map();
  const removeNow = (id, params = null) => {
    const entry = [...S.rows.entries()].find(([, r]) => r.id === id);
    if (!entry) return Promise.reject(Object.assign(new Error("gone"), { response: { status: 404, data: {} } }));
    if (entry[1].status === "confirmed") return Promise.reject(Object.assign(new Error("locked"), { response: { status: 409, data: {} } }));
    const newer = params && params.base_updated_at != null
      ? S.changedSince({ date: entry[1].date, branch_id: entry[1].branch_id, base_updated_at: params.base_updated_at, base_save_id: params.base_save_id || null })
      : null;
    if (newer) {
      S.refusedDeletes.push({ id, base: params.base_updated_at, stored: newer.updated_at });
      return Promise.reject(Object.assign(new Error("draft changed"), {
        response: { status: 412, data: { detail: { code: "draft_changed", updated_at: newer.updated_at, current: { ...newer } } } },
      }));
    }
    S.rows.delete(entry[0]);
    S.dead.set(entry[0], id);
    S.deletes.push(id);
    // Round 23 — the row as it was when deleted (M6: the question named it).
    // Round 23 review — and whose version it was: who wrote it last, its
    // version, which version the deleting visit's FORM held (and was shown
    // in a list), and the owner's action that asked for it (D).
    S.deletedRows.push({
      ...entry[1],
      __writer: S.writer.get(entry[0]) ?? null,
      __ver: S.verOf(entry[1]),
      __mount: S.mountNow,
      __formSeen: S.formSeenBy(S.mountNow, entry[0]),
      __formHeld: S.formHeldBy(S.mountNow, entry[0]),
      __byQueue: Boolean(S.byQueue.get(entry[0])) && S.writer.get(entry[0]) !== "other",
      __seen: S.seenBy(S.mountNow, entry[0]),
      __action: S.actionNow || null,
    });
    return Promise.resolve({ data: null });
  };
  // A slow network: while `holding` is set, each save (or delete) waits in
  // `held` and reaches the server — in the order sent — on releaseHeld().
  // `answer` (round 21): a save reaches the server at once, and its ANSWER
  // waits in `held` (the server stored it; the page has not heard yet).
  // `drop` (round 21 review): a save reaches the server and is stored, and
  // its answer is LOST (a dropped socket, a 4G handoff, the timeout): the
  // page gets a network error with no response.
  S.holding = { post: false, del: false, answer: false, drop: false, offline: false, dead: false };
  S.held = [];
  S.releaseHeld = () => { const h = S.held.splice(0); h.forEach((go) => go()); return h.length; };
  const offlineErr = () => Promise.reject(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }));
  S.offlineErr = offlineErr;
  S.remove = (id, params = null) => (S.holding.offline ? offlineErr() : S.holding.del || S.held.length
    ? new Promise((res, rej) => { S.held.push(() => removeNow(id, params).then(res, rej)); })
    : removeNow(id, params));
  return S;
}

export function installApi(S, get, post, del = null) {
  if (del) del.mockImplementation((url, cfg) => S.remove(String(url).split("/").pop(), cfg?.params || null));
  get.mockImplementation((url, cfg) => {
    // Offline (r22): the day's close rows cannot be read (the list, a day, a
    // draft by id).
    if (S.holding.offline && (url === "/daily-close" || /^\/daily-close\/(?:row|seed)/.test(String(url)))) return S.offlineErr();
    if (url === "/daily-close" && cfg?.params && (cfg.params.from || cfg.params.to || cfg.params.branch_id)) {
      // Round 22 — a read of one day (the page asks the server before it
      // acts on a save whose answer was lost): its rows as stored now, each
      // with the id of the save that wrote it last (the backend's
      // last_save_id, from the audit row), when asked for.
      const p = cfg.params;
      S.dayReads = (S.dayReads || 0) + 1;
      const hits = [...S.rows.entries()].filter(([, r]) => {
        const d = String(r.date).slice(0, 10);
        return (!p.from || d >= p.from) && (!p.to || d <= p.to) && (!p.branch_id || (r.branch_id || null) === p.branch_id);
      });
      hits.forEach(([k, r]) => S.see(S.mountNow, k, S.verOf(r)));
      return Promise.resolve({ data: hits.map(([k, r]) => ({ ...r, ...(p.with_save_id && !S.saveIdUnknown ? { last_save_id: S.lastSaveId.get(k) || null } : {}) })) });
    }
    if (url === "/daily-close") {
      // The list answers at once — before a save still on its way lands.
      S.listGets = (S.listGets || 0) + 1;
      S.rows.forEach((r, k) => S.see(S.mountNow, k, S.verOf(r)));
      return Promise.resolve({ data: [...S.rows.values()].map((r) => ({ ...r })) });
    }
    // A close read by id (the page opens every draft fresh): the row as
    // stored now; a deleted one is gone (404).
    const byId = /^\/daily-close\/((?:row|seed)[\w-]*)$/.exec(String(url));
    if (byId) {
      S.byIdGets = (S.byIdGets || 0) + 1;
      const hit = [...S.rows.entries()].find(([, r]) => r.id === byId[1]);
      if (!hit) return Promise.reject(Object.assign(new Error("gone"), { response: { status: 404, data: {} } }));
      S.see(S.mountNow, hit[0], S.verOf(hit[1]));
      S.formSee(S.mountNow, hit[0], S.verOf(hit[1]));
      S.formHold(S.mountNow, hit[0], S.verOf(hit[1]));
      return Promise.resolve({ data: { ...hit[1] } });
    }
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
      // Round 23 — a scan whose connection drops while it is read: held
      // until the harness has gone offline, then it answers (B).
      if (s && S.scanHold) {
        return new Promise((res) => { S.scanHeld = () => res({ data: JSON.parse(JSON.stringify(s)) }); });
      }
      return s ? Promise.resolve({ data: JSON.parse(JSON.stringify(s)) }) : Promise.reject(new Error("no scan stubbed"));
    }
    if (url === "/daily-close") {
      // Offline (r22): never reaches the server — nothing stored, no answer.
      if (S.holding.offline) return S.offlineErr();
      // Round 23 review — a dead line while the browser says online: the
      // form's save (it carries a save_id) dies on its way — never stored,
      // no answer. (A copy the offline queue sends has none, and gets
      // through: another visit's queued copy, synced by this page.)
      if (S.holding.dead && body?.save_id) {
        STATS.deadSaves += 1;
        return S.offlineErr();
      }
      const copy = JSON.parse(JSON.stringify(body));
      // What the day held when the page SENT it (a held save arrives later).
      const tags = S.tagAtSend ? S.tagAtSend(copy) : {};
      const arrive = () => {
        const key = `${copy.date}|${copy.branch_id || ""}`;
        if (S.rows.get(key)?.status === "confirmed") {
          S.lockConflicts += 1;
          S.lockHits.push({ key, mount: tags.__mount ?? null });
          return Promise.reject(Object.assign(new Error("locked"), { response: { status: 409, data: {} } }));
        }
        // The draft changed since the version this save was built on: refused,
        // nothing written (412 draft_changed, with the stored draft).
        const newer = S.changedSince(copy);
        if (newer) {
          S.refused.push({ ...copy, ...tags, __stored: newer.updated_at });
          // Offered to the page (the refusal carries it) — not adopted: only
          // the owner's "Behold mine tal" (or opening it) makes it known.
          S.offered.set(`${tags.__mount}|${key}`, S.verOf(newer));
          return Promise.reject(Object.assign(new Error("draft changed"), {
            response: { status: 412, data: { detail: { code: "draft_changed", updated_at: newer.updated_at, current: { ...newer } } } },
          }));
        }
        // R — a save landing over a version its page was never given. (Not a
        // copy kept on the device — the offline queue's, sent by whichever
        // visit is open when the network comes back: it carries the version
        // the visit that made it held, and the server's check above refused
        // it if anything newer was stored since. Round 23: offline now lasts
        // several steps, and a page left offline sends its copy on the next.)
        const prev = S.rows.get(key);
        if (prev && tags.__mount != null && !tags.__queued && S.verOf(prev) > S.seenBy(tags.__mount, key)) {
          S.stale.push({ date: copy.date, mount: tags.__mount, version: S.verOf(prev), seen: S.seenBy(tags.__mount, key),
            writer: S.writer.get(key), was: { revenue_total: prev.revenue_total, payment_breakdown: prev.payment_breakdown, notes: prev.notes } });
        }
        S.posts.push({ ...copy, ...tags });
        const row = S.save(copy);
        S.lastSaveId.set(key, copy.save_id || null);
        S.writer.set(key, tags.__mount != null ? tags.__mount : "page");
        S.see(tags.__mount, key, S.verOf(row));
        S.formSee(tags.__mount, key, S.verOf(row));
        if (!tags.__queued) S.formHold(tags.__mount, key, S.verOf(row));
        S.byQueue.set(key, Boolean(tags.__queued));
        return Promise.resolve({ data: { ...row } });
      };
      // Behind anything still on its way: requests arrive in the order sent.
      if (S.holding.post || S.held.length) {
        return new Promise((res, rej) => { S.held.push(() => arrive().then(res, rej)); });
      }
      // Stored, the answer lost (a refusal still answers: nothing was stored).
      if (S.holding.drop) {
        return arrive().then(() => {
          S.lostKeys.add(`${copy.date}|${copy.branch_id || ""}`);
          STATS.lostAnswers += 1;
          return Promise.reject(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }));
        });
      }
      // Stored at once, the answer still on its way.
      if (S.holding.answer) {
        const out = arrive();
        out.catch(() => {}); // handled when its answer is released
        return new Promise((res, rej) => { S.held.push(() => out.then(res, rej)); });
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

export async function runSequence(seed, page, { S: givenS, get, post, del = null } = {}, { variant = null, plan = null } = {}) {
  const { DailyClosePage } = page;
  // "r21": the r20 variant over a slow / reordered network (answers late,
  // the list before a save lands, leaving during a save), another device
  // saving figures, and a day whose own till is payments only.
  // "r22": the r21 variant with answers LOST at random (stored, never heard)
  // and another device LOCKING the day; MV / M6 / LK held over them.
  // "r23": the r22 variant with the page's questions answered at random
  // (a move: yes / no / "Hent salg"; Start forfra: yes, now and then no) and
  // a scan whose connection drops while it is read.
  const r23 = variant === "r23";
  const r22 = variant === "r22" || r23;
  const r21 = variant === "r21" || r22;
  // "r20": the review variant's openings and timings, over the round-20
  // drafts (floats, own photos, a reopened sum) and another device's scan.
  const r20 = variant === "r20" || r21;
  const review = variant === "review" || r20;
  const rnd = mulberry32(seed * 7919 + 13);
  const pick = (arr) => arr[Math.floor(rnd() * arr.length)];
  const chance = (p) => rnd() < p;
  // Round 23 review — the new knobs draw from a stream of their own, so every
  // earlier seed's choices (and its named regressions) stay what they were.
  const rnd2 = mulberry32(seed * 104729 + 7);
  const chance2 = (p) => rnd2() < p;
  const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
  const yesterday = shiftIso(today, -1);
  const twoDaysAgo = shiftIso(today, -2);
  const exemptByDate = { [yesterday]: 2000 };
  if (chance(0.3)) exemptByDate[today] = pick([2000, 750, 1500]);

  const opening = r21
    ? pick(["payOnly", "payOnly", "draft", "draft", "bannerScan", "scan", "typed"])
    : r20
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
  // r23 (round 23 review): now and then the server cannot read who wrote a
  // day last — every day read of the sequence names no last_save_id.
  if (r23 && !plan && chance2(0.12)) { S.saveIdUnknown = true; STATS.unknownReads += 1; }
  S.actionNow = null;
  // This device's remembered float (r20: not the one the seeded drafts were
  // counted with).
  if (r20) { try { localStorage.setItem(FLOAT_KEY, String(DEVICE_FLOAT)); } catch { /* private mode */ } }
  const deviceFloat = () => {
    let v = null;
    try { v = localStorage.getItem(FLOAT_KEY); } catch { /* private mode */ }
    const n = Number(v ?? 1000);
    return Number.isFinite(n) ? n : 1000;
  };

  // Round 23 — the page's questions (useConfirm, mocked in each sequence file
  // to call this): answered like the owner — `answerNext` (set by the action
  // about to tap: true, false, or "extra") or yes — and kept (what was asked).
  let answerNext = null;
  const dialogs = [];
  globalThis.__dcSeqConfirm = (opts) => {
    const o = typeof opts === "string" ? { message: opts } : (opts || {});
    dialogs.push(o);
    const a = typeof answerNext === "function" ? answerNext(o) : (answerNext ?? true);
    answerNext = null;
    return a;
  };
  const log = [];
  const fail = (inv, msg) => `[seed ${seed}] ${inv}: ${msg}\n  steps: ${log.join(" → ")}${globalThis.process?.env?.SEQ_DEBUG
    ? `\n  saves: ${JSON.stringify(S.posts.map((b) => ({ seq: b.__seq, m: b.__mount, base: b.base_updated_at, photo: b.receipt_photo, rev: b.revenue_breakdown, total: b.revenue_total_override, meta: b.source_meta?.kind })))}\n  refused: ${JSON.stringify(S.refused.map((b) => ({ seq: b.__seq, base: b.base_updated_at, stored: b.__stored, photo: b.receipt_photo })))}`
    : ""}`;

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
  // The rows this mount CREATED (no row for the day when it first posted).
  const createdHere = new Set();
  // A slow step: its saves are still on their way during the next step
  // (`slowLeft` steps, for a named regression).
  let slowStep = false;
  let slowLeft = 1;
  // r22 — a step whose saves reach the server at once and lose their
  // answers: nothing is held, so what it filed is checked like any step's
  // (MV, M6) — the page must ask the server, not wait for an answer.
  // (Round 23 review: or they die on a dead line — never stored, no answer,
  // the browser online: nothing is held either.)
  const lostStep = () => r22 && slowStep && (S.holding.drop || S.holding.dead);
  // r22 — a step taken OFFLINE (the browser says so; the day's requests fail
  // and store nothing). Online again at its end: checked once settled.
  const offlineStep = () => r22 && slowStep && S.holding.offline;
  const setOnline = (on) => {
    try { Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on }); } catch { /* fixed */ }
  };
  const navigatorOffline = () => window.navigator.onLine === false;
  const goOnline = async () => {
    setOnline(true);
    await act(async () => { window.dispatchEvent(new Event("online")); await new Promise((r) => setTimeout(r, 0)); });
    await settle();
  };
  // The page's last draft sent per day (and its send number), and a running
  // count of sends.
  const lastSent = {};
  const lastSentSeq = {};
  let sendSeq = 0;
  let pendingMove = null;
  // A Start forfra whose delete was still on its way (M6, checked once it is in).
  let startOverCheck = null;
  // The day the card is for, as its date line says it: the test keeps it.
  let shownDay = null;
  const businessDayShown = () => q("#close-date")?.value || shownDay;
  // The photos this mount of the page filed (F4: "" only ever clears one of
  // these).
  const filedPhotosHere = new Set();
  // r21 review — the photos of versions the owner chose "Behold mine tal"
  // over in this mount (shown the other version, its amount and that its
  // photo goes): "" may clear those — by the owner's choice, never in silence.
  const keptOverHere = new Set();
  const mount = (entry = "/daily-close") => {
    postedHere.clear(); createdHere.clear(); pendingMove = null; startOverCheck = null;
    filedPhotosHere.clear(); keptOverHere.clear();
    // A new visit: a new mount of the page, knowing only what it is given.
    S.mountNow += 1;
    shownDay = today; mounted = render(<MemoryRouter initialEntries={[entry]}><DailyClosePage /></MemoryRouter>);
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
      // F4 — "" clears only a photo this page filed: never another device's.
      if (body.receipt_photo === "" && body.__storedPhoto) {
        STATS.F4 += 1;
        expect(body.__filedHere.includes(body.__storedPhoto)
          || (r21 && (body.__keptOver || []).includes(body.__storedPhoto)),
          fail("F4 \"\" never clears another device's photo", `${body.date}: "" sent over ${body.__storedPhoto} (this page filed ${body.__filedHere.join(", ") || "none"})`)).toBe(true);
      }
      // F1 — a reopened draft's count goes with the float it was counted
      // with, never this device's.
      if (body.cash_counted != null && body.__loadedFloat != null) {
        STATS.F1 += 1;
        expect(Math.abs(Number(body.cash_float) - body.__loadedFloat) < 0.005, fail("F1 a reopened draft keeps its float",
          `${body.date}: cash_counted ${body.cash_counted} sent with float ${body.cash_float}, counted with ${body.__loadedFloat}`)).toBe(true);
      }
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
    lastSentSeq[body.date] = sendSeq + 1;
    return {
      __seq: ++sendSeq,
      // The visit of the page that sent it (R).
      __mount: S.mountNow,
      // A draft copy kept on this device (the offline queue sends it with no
      // save_id of its own — every save the form sends carries one).
      __queued: body.status === "draft" && !body.save_id,
      // A save for another day than the one on screen (a moved day's draft
      // filed back as it was) carries nothing of the day on screen.
      __other: body.date !== businessDayShown(),
      __noPhotos: !photosIn(),
      __ownKind: M.ownKind,
      __summedOwnTyped: M.scans.length > 0 && M.ownActive && M.ownKind === "typed" && M.ownTotal > 0 && !M.pageIn,
      // What the server held for the day when the page sent it (F4).
      __storedPhoto: S.rows.get(`${body.date}|${body.branch_id || ""}`)?.receipt_photo || null,
      __filedHere: [...filedPhotosHere],
      __keptOver: [...keptOverHere],
      __loadedFloat: M.loadedCash ? M.loadedCash.float : null,
    };
  };
  const origPush = S.posts.push.bind(S.posts);
  S.posts.push = (body) => {
    const key = `${body.date}|${body.branch_id || ""}`;
    // A save the page's previous visit sent, landing now (left while it was
    // on its way): not this visit's.
    if (body.__mount != null && body.__mount !== S.mountNow) return origPush(body);
    postedHere.add(body.date);
    if (body.receipt_photo && body.receipt_photo !== M.draftPhoto) filedPhotosHere.add(body.receipt_photo);
    if (!S.rows.has(key)) createdHere.add(body.date);
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
      // Another device scanned the day (F4): its photo is the day's too.
      if (M.otherPhotos[date]) allowed.add(M.otherPhotos[date]);
      expect(allowed.has(row.receipt_photo), fail("M4b no stored photo of a bon no longer in the day",
        `${date} stores ${row.receipt_photo}; photos in the day: ${[...allowed].join(", ") || "none"}`)).toBe(true);
    }
  };
  const brief = (r) => r && JSON.stringify({ revenue_total: r.revenue_total, revenue_breakdown: r.revenue_breakdown, payment_breakdown: r.payment_breakdown, receipt_photo: r.receipt_photo, source_meta: r.source_meta });
  // Round 23 — a stored draft's figure as the page names it (its revenue, or
  // its payments when it has none), and the amount a question names.
  const paidOf = (r) => Object.values(r?.payment_breakdown || {}).reduce((a, v) => a + Number(v || 0), 0);
  const figureOf = (r) => (Number(r?.revenue_total) > 0 ? Number(r.revenue_total) : r2(paidOf(r)));
  const amountIn = (msg) => {
    const m = String(msg || "").match(/(-?[\d.]+(?:,\d+)?)\s*kr/g);
    if (!m) return null;
    const last = m[m.length - 1].replace(/\s*kr$/, "");
    return Number(last.replace(/\./g, "").replace(",", "."));
  };
  const shortDay = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(dateLocale(), { day: "numeric", month: "short" });
  // D (round 23 review) — no draft is deleted on a guess of whose it is.
  // Every delete the page made (Start forfra on the card, a move's old day,
  // "Slet den") removed a version this visit's FORM held — never one another
  // device (or another visit of the page) wrote that the form was never
  // given. (The banner's Start forfra deletes the version the banner SHOWED,
  // and the server refuses any other: checked by M6.) The server refuses
  // such a delete only when the page sends the version it holds — a delete
  // on History's version (or none) went through.
  let deletesChecked = 0;
  const checkDeletes = () => {
    for (const d of S.deletedRows.slice(deletesChecked)) {
      STATS.D += 1;
      if (d.__action === "banner") continue;
      const others = d.__writer === "other" || d.__writer === "seed" || d.__byQueue
        || (typeof d.__writer === "number" && d.__writer !== d.__mount);
      if (!others) continue;
      STATS.Dother += 1;
      const who = d.__writer === "other" ? "another device" : d.__writer === "seed" ? "whoever filed it before this visit"
        : d.__byQueue ? "an offline-queue copy (no save id)" : `visit ${d.__writer}`;
      expect(d.__formHeld >= d.__ver, fail("D no draft is deleted on a guess of whose it is",
        `${String(d.date).slice(0, 10)}: ${d.__action || "a delete"} removed version ${d.__ver} written by ${who} — this visit's form held version ${d.__formHeld} (${brief(d)})`)).toBe(true);
    }
    deletesChecked = S.deletedRows.length;
  };
  // MT (round 23 review) — the line under the date: a day said moved FROM
  // holds no draft; the day said moved or copied TO holds a stored row (the
  // figures are on a server); and while the new day's save is unconfirmed
  // ("Ikke gemt for {to} endnu") nothing is offered to delete.
  const checkMoveNote = () => {
    const note = q('[data-testid="dc-date-moved"]');
    if (!note || !onForm()) return;
    const on = q("#close-date")?.value;
    const t = note.textContent;
    if (/dcDateMovedNotSavedYet:/.test(t)) {
      STATS.MVpending += 1;
      expect(Boolean(findBtn(/^dcDateMovedDeleteOld$/)), fail("MT nothing is deleted for a move not saved yet",
        `"${t}" with "Slet den" offered`)).toBe(false);
      return;
    }
    if (!/dcDateMovedFrom:|dcDateMovedCopied:|dcDateMovedMaybeCopied:/.test(t) || !on) return;
    STATS.MT += 1;
    expect(Boolean(S.rows.get(`${on}|`)), fail("MT a day reported moved or copied TO holds the figures",
      `"${t}" on ${on}, which holds nothing on the server`)).toBe(true);
    const from = /dcDateMovedFrom:/.test(t)
      ? [today, yesterday, twoDaysAgo].find((d) => t.includes(`dcDateMovedFrom:${shortDay(d)}`)) : null;
    if (from) {
      const r = S.rows.get(`${from}|`);
      expect(!r || r.status !== "draft", fail("MV a day reported moved is not on the old date",
        `"${t}" — ${from} still holds ${brief(r)}`)).toBe(true);
    }
  };
  const storedChecks = async () => {
    // The page's own follow-ups (a draft deleted once the saves have
    // answered) run on the saves' answers.
    await settle();
    await settle();
    if (startOverCheck && !S.held.length) {
      const e = startOverCheck;
      startOverCheck = null;
      checkStartOver({ ...e, failed: Boolean(q('[data-testid="dc-start-over-failed"]')), at: where() });
    }
    checkDeletes();
    checkMoveNote();
    // MV (round 23) — a move answered "Flyt tallene": once the new day is
    // filed, "Flyttet fra" only when the old day's draft is gone; an old day
    // still holding a draft is said on the new day ("Kopieret til … står der
    // stadig"). A day reported moved is never on the old date.
    if (pendingMove && S.posts.slice(pendingMove.posts).some((b) => b.date === pendingMove.to)) {
      const mv = pendingMove;
      pendingMove = null;
      const key = `${mv.from}|`;
      const row = S.rows.get(key);
      const onTo = onForm() && q("#close-date")?.value === mv.to;
      STATS.MV += 1;
      if (r22 && S.lostKeys.has(key)) STATS.MVlost += 1;
      const MV = "MV a day reported moved is not on the old date";
      // The day the "Flyttet fra" note names (the first day of a chain of
      // moves, or the one the figures left): it holds no draft.
      const note = q('[data-testid="dc-date-moved"]');
      const namedDay = note && /dcDateMovedFrom:/.test(note.textContent)
        ? [today, yesterday, twoDaysAgo].find((d) => note.textContent.includes(`dcDateMovedFrom:${shortDay(d)}`)) || null : null;
      if (onTo && namedDay) {
        const nrow = S.rows.get(`${namedDay}|`);
        expect(!nrow || nrow.status !== "draft", fail(MV, `the page says the figures moved from ${namedDay}, which still holds ${brief(nrow)}`)).toBe(true);
      }
      if (row && row.status === "draft") {
        if (onTo) {
          expect(namedDay === mv.from, fail(MV, `${mv.from} still holds ${brief(row)}, yet the page says "moved from ${shortDay(mv.from)}"`)).toBe(false);
          // ("… står der stadig", or — its save got no answer, so the page
          // cannot know — "… kan stadig stå der".)
          expect(hasText("dcDateMovedCopied") || hasText("dcDateMovedMaybeCopied"), fail(MV, `${mv.from} still holds ${brief(row)} after the figures went to ${mv.to}, and nothing says so`)).toBe(true);
        }
      } else if (row) {
        // Locked on another device since: that lock stands — never "moved".
        STATS.newerElsewhere += 1;
        if (onTo) expect(namedDay === mv.from, fail(MV, `${mv.from} was locked elsewhere, yet the page says the figures moved`)).toBe(false);
      } else if (S.writer.get(key) === "other"
        && S.deletedRows.slice(mv.deletes).some((d) => `${String(d.date).slice(0, 10)}|${d.branch_id || ""}` === key && d.__writer === "other")) {
        // Round 22's branch, restored (round 23 review): another device
        // saved the old day since — its version is never deleted with the
        // moved figures (the delete goes on the version this form holds, and
        // the server refuses any other). Deleted, it was a version this form
        // held (it opened it): D says which.
        STATS.newerElsewhere += 1;
        const gone = S.deletedRows.slice(mv.deletes).filter((d) => `${String(d.date).slice(0, 10)}|${d.branch_id || ""}` === key && d.__writer === "other");
        expect(gone.every((d) => d.__formHeld >= d.__ver), fail(MV,
          `${mv.from}: another device's version of the draft was deleted with the moved figures (${gone.map(brief).join(", ")})`)).toBe(true);
      } else if (onTo && mv.filed) {
        expect(Boolean(namedDay), fail(MV, `${mv.from}'s draft is gone and the figures are on ${mv.to}, and nothing says they moved`)).toBe(true);
      }
    }
    // M4 / M4b — the stored row for the day in view (filed by this page).
    // Not while the stored row is a version the page was never given, or the
    // page asks which draft wins (r21): it is not the page's to answer for.
    const date = businessDayShown();
    if (date && postedHere.has(date) && !hasText("dcDayHasDraft") && !hasText("dcDayAlreadyLocked")
      && !conflictShown() && !newerElsewhere(date)
      // (Another device's version, not written over yet: not this page's.)
      && S.writer.get(`${date}|`) !== "other") {
      checkStoredRow(date, S.rows.get(`${date}|`));
    }
    // F6 — a reopened Z-bon read changed by hand, no photo in the day: every
    // line that differs from the read as it was opened is on the record as
    // corrected (never "read off the bon"), nothing else is said corrected,
    // and a reopened sum's tills still add up to what is stored.
    const z = M.zbonLoaded;
    const zrow = z && z.date === date && S.rows.get(`${date}|`);
    if (zrow && postedHere.has(date) && !photosIn() && M.ownKind === "draftZbon" && zrow.status === "draft"
      && !hasText("dcDayHasDraft") && !S.held.length && !conflictShown() && !newerElsewhere(date)) {
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

  // r21 — the page's "the draft was changed elsewhere" choice is on screen:
  // the server refused a save built on an older version of the day, nothing
  // was overwritten, and the page says so.
  const conflictShown = () => Boolean(q('[data-testid="dc-draft-changed"]'));
  // The stored row is a version this visit of the page was never given
  // (another device's save, or its previous visit's landing late): the page
  // cannot show it — and must never overwrite it (R). I1 waits for it.
  const newerElsewhere = (date) => {
    if (!date) return false;
    const key = `${date}|`;
    const row = S.rows.get(key);
    // (r22: the version the form holds — a list read is not an open.)
    const seen = r22 ? S.formSeenBy(S.mountNow, key) : S.seenBy(S.mountNow, key);
    return Boolean(row) && S.verOf(row) > seen;
  };
  // R — no save ever landed over a version its page was never given.
  const checkStale = () => {
    STATS.R += 1;
    if (!S.stale.length) return;
    const s0 = S.stale[0];
    expect(false, fail("R no stale overwrite",
      `${s0.date}: a save from visit ${s0.mount} landed over version ${s0.version} (written by ${s0.writer}) that visit was never given (it had ${s0.seen}); that version held ${JSON.stringify(s0.was)}`)).toBe(true);
  };
  // The page going away (pagehide: whatever save is waiting goes now) — and,
  // since the owner goes on using it, coming back (pageshow), as a browser
  // says it: a page that is still being tapped was shown again (round 21
  // review — what the page keeps for a page left for good goes on return).
  const hideAndBack = async () => {
    await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
    await act(async () => { window.dispatchEvent(new Event("pageshow")); await new Promise((r) => setTimeout(r, 0)); });
  };
  // r21 — everything on its way arrives (in the order sent), and whatever the
  // page asks to send on an answer (a save filed again) goes too: the stored
  // row is checked once the network is quiet.
  const settleAll = async () => {
    for (let i = 0; i < 12; i++) {
      const n0 = S.posts.length + S.deletes.length + S.refused.length;
      if (S.held.length) await act(async () => { S.releaseHeld(); await new Promise((r) => setTimeout(r, 0)); });
      await settle();
      await hideAndBack();
      await settle();
      if (!S.held.length && n0 === S.posts.length + S.deletes.length + S.refused.length) break;
    }
  };

  // LK (r22) — another device locked the day in view, and a save of this
  // visit met that lock (409): the page says the day is locked — never the
  // owner's edits refused in silence — and an amount it names is the lock's.
  const checkLockedElsewhere = () => {
    const date = businessDayShown();
    const key = date && `${date}|`;
    const row = key && S.rows.get(key);
    if (!row || row.status !== "confirmed" || !S.lockedByOther.has(key)) return;
    if (!S.lockHits.some((h) => h.key === key && h.mount === S.mountNow)) return;
    STATS.LK += 1;
    expect(hasText("dcDayAlreadyLocked"), fail("LK a day locked on another device is said",
      `${date} was locked elsewhere at ${row.revenue_total}; a save of this page met the lock, and nothing on the page says so`)).toBe(true);
    const m = document.body.textContent.match(/dcDayAlreadyLockedBody:([−\-\d.,]+)/);
    if (m) {
      const said = Number(m[1].replace(/\./g, "").replace(",", ".").replace("−", "-"));
      expect(Math.abs(said - row.revenue_total) < 0.005, fail("LK a day locked on another device is said",
        `the page says locked at ${m[1]}, the lock holds ${row.revenue_total}`)).toBe(true);
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
    await hideAndBack();
    // r22: this step's answers were lost — checked without walking the
    // wizard to its review (a step change sends the day again, and an
    // answered re-send would hide what the lost one left behind; the owner
    // may well not move a step either).
    let lostNow = false;
    if (slowStep) {
      // Still on their way: the next step happens before they arrive, and
      // what is stored is checked once they have. What the page shows does
      // not wait: I5 is checked here too (U3 restored — it was counted with
      // nothing checked).
      // (A named regression may keep them on their way over several steps.)
      // r22: answers LOST — nothing is on its way (stored, never heard), so
      // the step is checked now like any other: the page must ask the
      // server, not wait for an answer that never comes.
      const lost = lostStep();
      const offline = offlineStep();
      lostNow = lost;
      slowLeft -= 1;
      if (slowLeft <= 0) {
        slowStep = false;
        S.holding.post = false; S.holding.del = false; S.holding.answer = false; S.holding.drop = false; S.holding.offline = false; S.holding.dead = false;
        // r22: online again — the page's waiting draft goes.
        if (offline) await goOnline();
      }
      if (!lost && !(offline && !slowStep)) {
        noDeadEnd();
        return;
      }
    }
    // A slow step's saves (and deletes) arrive, in the order sent, and the
    // page's follow-ups run on their answers.
    if (r21) await settleAll();
    else {
      for (let i = 0; i < 6 && S.held.length; i++) {
        await act(async () => { S.releaseHeld(); await new Promise((r) => setTimeout(r, 0)); });
        await settle();
      }
    }
    checkPosts();
    await storedChecks();
    noDeadEnd();
    checkStale();
    if (r22) checkLockedElsewhere();
    // The page asks which draft wins: nothing of the day is held to the
    // stored row until the owner answers (the next step does).
    if (conflictShown()) { STATS.conflicts += 1; return; }
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
      // says which draft is stored.
      if (newerElsewhere(date)) {
        STATS.newerElsewhere += 1;
      } else if (hasText("dcDayHasDraft")) {
        // U3 restored (round 19 skipped it): under the banner the card files
        // nothing — and the banner's amount is the draft that IS stored.
        const m = document.body.textContent.match(/dcDayHasDraftBody:([−\-\d.,]+)/);
        if (m && row && row.status === "draft") {
          STATS.I6 += 1;
          const banner = Number(m[1].replace(/\./g, "").replace(",", ".").replace("−", "-"));
          expect(Math.abs(banner - row.revenue_total) < 0.005, fail("I6 the banner is the stored draft",
            `banner ${m[1]}, stored ${row.revenue_total}`)).toBe(true);
        }
        // A draft of payments only (round 21): the banner names its payments.
        const p = document.body.textContent.match(/dcDayHasDraftBodyPaymentsOnly:([−\-\d.,]+)/);
        if (p && row && row.status === "draft") {
          STATS.I6 += 1;
          const banner = Number(p[1].replace(/\./g, "").replace(",", ".").replace("−", "-"));
          const paid = Object.values(row.payment_breakdown || {}).reduce((a, v) => a + Number(v || 0), 0);
          expect(!(Number(row.revenue_total) > 0) && Math.abs(banner - paid) < 0.005, fail("I6 the banner is the stored draft",
            `payments-only banner ${p[1]}, stored ${row.revenue_total} / payments ${paid}`)).toBe(true);
        }
      } else if (readable && row && row.status === "draft" && postedHere.has(date) && !M.synced) {
        const shown = val(total.value);
        if (Math.abs(shown - row.revenue_total) >= 0.005) {
          STATS.I6 += 1;
          expect(Boolean(q('[data-testid="dc-scan-unsaved"]')),
            fail("I6 card filed or said", `card ${total.value}, stored ${row.revenue_total}, no "ikke gemt endnu"`)).toBe(true);
        }
      }
      return;
    }
    if (hasText("dcDayHasDraft") || hasText("dcDayAlreadyLocked")) return;
    if (lostNow) return;
    const date = q("#close-date").value;
    const row = S.rows.get(`${date}|`);
    // Another device's save (or a late one from the page's previous visit) is
    // a version the page was never given: it cannot show it, and R holds it
    // to never overwriting it — the page's next save is refused and it asks.
    if (newerElsewhere(date)) { STATS.newerElsewhere += 1; return; }
    if (!(await toStep("review"))) return;
    const R = readReview();
    const where_ = `${date}: review ${JSON.stringify(R)} vs stored ${JSON.stringify(row && {
      revenue_total: row.revenue_total, moms_total: row.moms_total, revenue_breakdown: row.revenue_breakdown,
      payment_breakdown: row.payment_breakdown, notes: row.notes, moms_mode: row.moms_mode,
    })}`;
    // I7 (r21) — the stored row is the page's last save for the day, landed:
    // its cash, its source, its photo ("" cleared it, null kept it).
    const landed = [...S.posts].reverse().find((b) => b.date === date);
    if (r21 && row && landed && landed.__seq === lastSentSeq[date] && S.writer.get(`${date}|`) === S.mountNow) {
      STATS.I7 += 1;
      const w7 = `${date}: last save ${JSON.stringify({ cash_counted: landed.cash_counted, source_meta: landed.source_meta, receipt_photo: landed.receipt_photo })}, stored ${JSON.stringify({ cash_counted: row.cash_counted, source_meta: row.source_meta, receipt_photo: row.receipt_photo })}`;
      expect(row.cash_counted ?? null, fail("I7 stored = the last save", `cash. ${w7}`)).toEqual(landed.cash_counted ?? null);
      if (landed.source_meta != null) expect(row.source_meta, fail("I7 stored = the last save", `source. ${w7}`)).toEqual(landed.source_meta);
      if (landed.receipt_photo === "") expect(row.receipt_photo ?? null, fail("I7 stored = the last save", `photo. ${w7}`)).toBe(null);
      else if (landed.receipt_photo) expect(row.receipt_photo, fail("I7 stored = the last save", `photo. ${w7}`)).toBe(landed.receipt_photo);
    }
    if (!(R.total > 0)) {
      // I1z (round 21) — a day of payments only (no revenue line, total
      // "—"): the payments on the review are what is stored — never nothing
      // (they were never saved), never a thrown-away bon's figures.
      if (Object.keys(R.pay).length && !Object.keys(R.rev).length) {
        STATS.I1z += 1;
        expect(row, fail("I1z payments only = stored", `nothing stored. ${where_}`)).toBeTruthy();
        expect(!(Number(row.revenue_total) > 0), fail("I1z payments only = stored", `revenue. ${where_}`)).toBe(true);
        expect(row.revenue_breakdown, fail("I1z payments only = stored", `revenue lines. ${where_}`)).toEqual({});
        expect(row.payment_breakdown, fail("I1z payments only = stored", `payments. ${where_}`)).toEqual(R.pay);
        expect(row.notes || "", fail("I1z payments only = stored", `note. ${where_}`)).toBe(R.notes);
      }
      return;
    }
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
  // `noHold` (round 23 — Start forfra): the step's own requests are never
  // held on the wire (the page waits for the delete's answer before it
  // empties the form; a held delete would leave the test's picture of the
  // day ahead of the page). Answers late, lost, or offline still happen.
  const step = async (label, fn, then, { noHold = false, noSlow = false } = {}) => {
    // The review variant: now and then the network is slow for a step — its
    // saves and deletes are still on their way during the next one.
    if (review && !plan && !noSlow && !slowStep && !S.held.length && chance(0.3)) {
      slowStep = true;
      slowLeft = 1;
      // r22: a third of the time the saves are held, a third their answers
      // are late, a third they are stored and their answers LOST.
      if (r22) {
        let how = pick(["post", "answer", "drop", "offline"]);
        if (noHold && how === "post") how = "answer";
        // r23: offline now and then lasts a few steps — the owner keeps
        // working (typing, the card, Start forfra, a move) with no network.
        if (r23 && how === "offline") slowLeft = 1 + Math.floor(rnd() * 3);
        if (how === "answer") { S.holding.answer = true; label += " (slow answers)"; } else if (how === "drop" && r23 && chance2(0.35)) {
          // Round 23 review — a dead line, the browser online: the form's
          // saves never land and get no answer.
          S.holding.dead = true;
          label += " (dead line)";
        } else if (how === "drop") {
          S.holding.drop = true;
          label += " (answers lost)";
        } else if (how === "offline") {
          S.holding.offline = true;
          STATS.offlineSteps += 1;
          setOnline(false);
          await act(async () => { window.dispatchEvent(new Event("offline")); await new Promise((r) => setTimeout(r, 0)); });
          label += " (offline)";
        } else {
          S.holding.post = true; S.holding.del = true;
          label += " (slow)";
        }
      // r21: half the time the saves reach the server at once and only their
      // answers are late (the server stored it; the page has not heard).
      } else if (r21 && (chance(0.5) || noHold)) { S.holding.answer = true; label += " (slow answers)"; } else if (noHold) {
        slowStep = false;
      } else {
        S.holding.post = true; S.holding.del = true;
        label += " (slow)";
      }
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
      // On a day that has a draft (moved onto it with nothing typed):
      // continue it, or Start forfra — which deletes it (round 23).
      if (chance(0.5)) await step("continue that draft", () => tap(/^dcContinueDraft$/), () => { if (pendingMove && pendingMove.to === q("#close-date")?.value) pendingMove = null; onReopenLoaded(); });
      else await bannerStartOver();
    }
    if (hasText("dcDayAlreadyLocked")) return false;
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
    await toStep("s1");
    const back = findBtn(/^←\s*scanZReportBack$/);
    if (!back) return false;
    // B (round 23) — offline the scan card is not reached: "← Scan Z-bon" is
    // gray, and the page says why (the figures are typed instead).
    if (navigatorOffline()) {
      STATS.B += 1;
      expect(back.disabled && Boolean(q('[data-testid="dc-scan-offline"]')), fail("B no scan offline",
        `offline on Trin 1: "← Scan Z-bon" is ${back.disabled ? "gray" : "live"} and ${q('[data-testid="dc-scan-offline"]') ? "says why" : "says nothing"}`)).toBe(true);
      return false;
    }
    shownDay = q("#close-date")?.value || shownDay;
    await step("← scan Z-bon", () => { fireEvent.click(back); });
    return true;
  };

  let photoN = 0;
  const shoot = async (key, { same = false, dropMid: forceDrop = null } = {}) => {
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
    // r23 — now and then the connection drops while the photo is read.
    const dropMid = forceDrop != null ? forceDrop : (r23 && !plan && !slowStep && !navigatorOffline() && chance(0.08));
    const at0 = where();
    let refusedOffline = false;
    await step(`photo ${name}${dup ? " (same)" : ""}${dropMid ? " (the connection drops while it is read)" : ""}`, async () => {
      if (dropMid) S.scanHold = true;
      refusedOffline = navigatorOffline();
      fireEvent.change(input, { target: { files: [file] } });
      if (dropMid) {
        for (let i = 0; i < 4 && !S.scanHeld; i++) await settle();
        setOnline(false);
        await act(async () => { window.dispatchEvent(new Event("offline")); await new Promise((r) => setTimeout(r, 0)); });
        S.scanHold = false;
        const go = S.scanHeld;
        S.scanHeld = null;
        await act(async () => { go?.(); await new Promise((r) => setTimeout(r, 0)); });
        for (let i = 0; i < 6 && where() === "scanning"; i++) await settle();
        refusedOffline = true;
        await goOnline();
      }
      for (let i = 0; i < 20 && where() === "scanning"; i++) await settle();
    }, () => {
      if (refusedOffline) {
        // B — no scan offline: nothing read, nothing changed, and the page
        // says why (a scan whose connection dropped is not used either).
        STATS.B += 1;
        if (dropMid) STATS.Bdrop += 1;
        S.nextScan = null;
        expect(hasText("dcScanNeedsInternet"), fail("B no scan offline",
          `${name} picked ${dropMid ? "and the connection dropped while it was read" : "offline"}, and nothing says scanning needs internet`)).toBe(true);
        expect(where(), fail("B no scan offline", `${name}: the page moved from ${at0} to ${where()}`)).toBe(at0);
        expect(Boolean(q('[data-testid="dc-terminal-question"]')), fail("B no scan offline", `${name}: a question was raised offline`)).toBe(false);
        return;
      }
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
    }, { noSlow: dropMid });
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

  // M6 (round 23) — Start forfra answered yes, checked as soon as the page
  // has answered (its delete is never held on the wire — `noHold`): the day's
  // draft is deleted on the version shown (the question named exactly that
  // amount) and the page is an empty start; or another device's newer
  // version is kept (refused) and the banner shows it; or a lock is said; or
  // the delete could not be done — the page says so and nothing changed.
  const checkStartOver = (e) => {
    const key = `${e.day}|`;
    const row = S.rows.get(key);
    if (r22 && S.lostKeys.has(key)) STATS.M6lost += 1;
    if (e.offline) STATS.M6offline += 1;
    const deletedNow = S.deletedRows.slice(e.deletesBefore).filter((r) => String(r.date).slice(0, 10) === e.day);
    const M6 = "M6 Start forfra deletes the day's draft, or says why not";
    if (e.failed) {
      STATS.M6failed += 1;
      expect(deletedNow.length, fail(M6, `${e.day}: the page says the draft was not deleted, yet it was`)).toBe(0);
      expect(e.at !== "idle" || hasText("dcDayHasDraft") || hasText("dcDayAlreadyLocked"), fail(M6,
        `${e.day}: the page says nothing changed, yet the form was emptied`)).toBe(true);
      return;
    }
    STATS.M6 += 1;
    if (deletedNow.length) {
      STATS.M6said += 1;
      const del = deletedNow[deletedNow.length - 1];
      const said = e.dialog && /dcStartOverDeleteBody/.test(String(e.dialog.message || "")) ? amountIn(e.dialog.message) : null;
      expect(said != null && Math.abs(said - figureOf(del)) < 0.005, fail("M6 the question names the draft it deletes",
        `${e.day}: asked "${e.dialog?.message ?? "nothing"}", deleted ${brief(del)}`)).toBe(true);
    }
    if (!row) {
      expect(hasText("dcDayHasDraft"), fail(M6, `${e.day}: deleted, yet the banner shows a draft`)).toBe(false);
    } else if (row.status === "draft") {
      // Kept only when another device saved it since (the delete is refused,
      // never forced) — or nothing of the page's was filed (a draft that was
      // never the page's: the banner shows it).
      STATS.newerElsewhere += 1;
      // ("Not this visit's": another device's save, or the page's previous
      // visit's landing after this one opened the day — a version it never
      // held, which the server's version check refuses to delete.)
      expect(S.writer.get(key) !== S.mountNow || !e.asked, fail(M6,
        `${e.day}: answered yes, yet the page's own draft ${brief(row)} is still stored`)).toBe(true);
      expect(hasText("dcDayHasDraft") || conflictShown(), fail(M6,
        `${e.day}: another device's draft (${row.revenue_total}) is kept, and nothing says so`)).toBe(true);
    } else {
      expect(hasText("dcDayAlreadyLocked"), fail(M6, `${e.day}: locked elsewhere (${row.revenue_total}), and nothing says so`)).toBe(true);
    }
    // The form starts over empty: the scan's start (under the banner of a
    // kept draft or a lock, if any) — nothing of the old figures.
    expect(e.at, fail(M6, `${e.day}: after Start forfra the page is at ${e.at}, not an empty start`)).toBe("idle");
  };
  // Round 23 — Start forfra (the card's, or the day's draft banner's): asked,
  // answered yes (r23: now and then no — nothing changes).
  const doStartOver = async (source = "card") => {
    if (source === "card" && where() !== "card") return;
    // Round 23 review — tapped with a save still on its way (a slow step
    // before it, or a named regression's held save): the page waits for that
    // save to answer before its delete ("Sletter kladden…"). Nothing is
    // released first — that race is what this taps into.
    const btn = findBtn(source === "banner" ? /^dcStartOverDraft$/ : /^startOver$/);
    if (!btn || btn.disabled) return;
    if (S.held.length) STATS.M6race += 1;
    const day = businessDayShown() || today;
    const yes = !r23 || Boolean(plan) || chance(0.9);
    const deletesBefore = S.deletedRows.length;
    const n0 = dialogs.length;
    answerNext = yes;
    S.actionNow = source;
    await step(`Start forfra${source === "banner" ? " (banner)" : ""}${yes ? "" : " — no"}${S.held.length ? " (a save on its way)" : ""}`, async () => {
      fireEvent.click(btn);
      for (let i = 0; i < 8; i++) await settle();
    }, () => {
      answerNext = null;
      const dialog = dialogs.length > n0 ? dialogs[dialogs.length - 1] : null;
      if (!yes && dialog) {
        // Answered no: nothing changes.
        expect(S.deletedRows.length - deletesBefore, fail("M6 Start forfra answered no changes nothing", `${day}: a draft was deleted`)).toBe(0);
        return;
      }
      const e = {
        day, deletesBefore, dialog, offline: offlineStep(),
        asked: Boolean(dialog) && /dcStartOverDeleteBody/.test(String(dialog.message || "")),
      };
      // A delete still held on the wire (a named regression's slow network):
      // the page answers once it arrives — checked then (storedChecks).
      if (S.held.length) {
        resetDay();
        startOverCheck = e;
        return;
      }
      const failed = Boolean(q('[data-testid="dc-start-over-failed"]'));
      if (!failed) resetDay();
      checkStartOver({ ...e, failed, at: where() });
    }, { noHold: true });
    // The owner waits for "Sletter kladden…" (the card and the banner wait
    // too): what was on its way arrives, the page's delete answers, and M6 is
    // checked on what it did — before anything else is tapped.
    if (startOverCheck) {
      for (let i = 0; i < 12 && (S.held.length || hasText("dcStartOverDeleting")); i++) { await arriveAll(); await settle(); }
      const e = startOverCheck;
      startOverCheck = null;
      checkStartOver({ ...e, failed: Boolean(q('[data-testid="dc-start-over-failed"]')), at: where() });
      checkDeletes();
    }
  };
  const startOver = () => doStartOver("card");
  const bannerStartOver = () => doStartOver("banner");

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

  // Round 23 — a date picked with figures on the form is asked first: "Flyt
  // tallene" (yes), "Bliv på {from}" (no) or "Hent {dag}s salg" when it is
  // offered (r23 answers at random; the older variants say yes). A day that
  // already holds another close is never moved onto (asked: stay).
  const moveDate = async (target = null, answer = null) => {
    if (!(await ensureForm())) return;
    const el = q("#close-date");
    if (!el || el.disabled) return;
    if (target === el.value) return;
    const to = target || pick([today, yesterday, twoDaysAgo].filter((d) => d !== el.value));
    const from = el.value;
    const fromRow = S.rows.get(`${from}|`);
    const filedFrom = postedHere.has(from) && Boolean(fromRow) && fromRow.status === "draft";
    const n0 = dialogs.length;
    const deletes0 = S.deletedRows.length;
    let chosen = null;
    answerNext = (o) => {
      if (/dcMoveTarget/.test(String(o.title || ""))) { chosen = "target"; return false; }
      let a = answer || (r23 && !plan ? (o.extraLabel && chance(0.25) ? "extra" : (chance(0.15) ? "no" : "yes")) : "yes");
      if (a === "extra" && !o.extraLabel) a = "yes";
      chosen = a;
      return a === "yes" ? true : a === "extra" ? "extra" : false;
    };
    S.actionNow = "move";
    await step(`date → ${to}`, async () => {
      fireEvent.change(el, { target: { value: to } });
      for (let i = 0; i < 4; i++) await settle();
    }, () => {
      answerNext = null;
      const asked = dialogs.length > n0 ? dialogs[dialogs.length - 1] : null;
      if (!asked) {
        // Nothing of the owner's on the form: a plain move.
        if (to === twoDaysAgo) { M.exact = false; M.synced = true; }
        return;
      }
      if (chosen === "target") return;
      if (chosen === "no") {
        STATS.MVno += 1;
        expect(q("#close-date")?.value, fail("MV answered no, nothing moves", `asked to move ${from} → ${to}, answered no`)).toBe(from);
        return;
      }
      // The question names the old day's draft when there is one.
      if (filedFrom) {
        STATS.MVsaid += 1;
        expect(/dcMoveConfirmBody/.test(String(asked.message)) && !/dcMoveConfirmBodyNothing/.test(String(asked.message)),
          fail("MV the move's question names the old day's draft", `${from} holds ${brief(fromRow)}; asked "${asked.message}"`)).toBe(true);
      }
      if (to === twoDaysAgo) { M.exact = false; M.synced = true; }
      if (chosen === "extra") {
        // "Hent {dag}s salg": the new day's POS figures instead — nothing moved.
        STATS.MVfetch += 1;
        M.form = { rev: {}, pay: {} }; M.ownKind = null; M.ownTotal = 0; M.loadedCash = null; M.exact = false; M.synced = true;
        return;
      }
      // "Kopieret til … — kladden for {from} står der stadig" is true when it
      // is said (offline: the new day's save is waiting; refused: kept). (A
      // day whose save got no answer is said "kan stadig stå der" instead.)
      if (hasText("dcDateMovedCopied")) {
        STATS.MVcopy += 1;
        expect(Boolean(S.rows.get(`${from}|`)), fail("MV a day said still there is still there",
          `the page says ${from}'s draft is still there; nothing is stored for it`)).toBe(true);
      }
      if (!slowStep || lostStep() || offlineStep()) {
        pendingMove = { from, to, filed: filedFrom || postedHere.has(from), posts: S.posts.length, deletes: deletes0 };
      }
    });
    // (A move's old day is deleted once the new day's save has answered —
    // perhaps in a later step: still the move's.)
    // Round 23 review — "Slet den", tapped now and then when it is offered
    // (the old day's delete could not be done): checked by MT / MV / D.
    if (r23 && !plan && findBtn(/^dcDateMovedDeleteOld$/) && chance2(0.6)) await deleteOld();
    await ensureForm();
  };
  // r23 (round 23 review) — "Brug disse tal" with its save still on its way
  // (held, or its answer late) over the next two steps: straight back to the
  // card and Start forfra. The page waits for that save, then deletes exactly
  // what it stored (M6), never a version anyone else wrote (D).
  const raceReady = () => r23 && !plan && !slowStep && !S.held.length && !navigatorOffline()
    && !Object.values(S.holding).some(Boolean) && where() === "card" && !q('[data-testid="dc-terminal-question"]')
    && !hasText("dcDayHasDraft") && !hasText("dcDayAlreadyLocked") && !conflictShown();
  const applyOnItsWay = async (how) => {
    slowStep = true;
    slowLeft = 2;
    if (chance2(0.5)) S.holding.answer = true;
    else { S.holding.post = true; S.holding.del = true; }
    await apply(how);
    if (!S.held.length) return;
    if (!(await toCard()) || where() !== "card") return;
    await startOver();
  };
  const appliedOnItsWay = async () => {
    if (!raceReady()) return;
    // Another bon onto the card (a change the next "Brug disse tal" files).
    await shoot(BON_KEYS[Math.floor(rnd2() * BON_KEYS.length)]);
    if (q('[data-testid="dc-terminal-question"]')) await answer("sum");
    if (!raceReady()) return;
    await applyOnItsWay(chance2(0.5) ? "review" : "steps");
  };
  const deleteOld = async () => {
    const b = findBtn(/^dcDateMovedDeleteOld$/);
    if (!b || b.disabled) return false;
    STATS.MVdeleteOld += 1;
    S.actionNow = "deleteOld";
    await step("Slet den", async () => { fireEvent.click(b); for (let i = 0; i < 6; i++) await settle(); });
    return true;
  };
  // Round 23 review — "Prøv igen" on "Ikke gemt for {to} endnu".
  const retryMove = async () => {
    const b = findBtn(/^dcDateMovedRetry$/);
    if (!b || b.disabled) return false;
    S.actionNow = "move";
    await step("Prøv igen", async () => { fireEvent.click(b); for (let i = 0; i < 6; i++) await settle(); });
    return true;
  };
  // Review variant: a move, then another before the first can matter
  // (round 23: the new day is filed at once, so the second move moves the
  // figures from the day in between — "Flyttet fra" names that day).
  const doubleMove = async () => {
    if (!(await ensureForm())) return;
    const el = q("#close-date");
    if (!el || el.disabled) return;
    const origin = el.value;
    const [mid, last] = [today, yesterday, twoDaysAgo].filter((d) => d !== origin);
    await arriveAll();
    await moveDate(mid, "yes");
    if (q("#close-date")?.value !== mid) return;
    await moveDate(last, chance(0.5) ? "yes" : "extra");
    // Neither the first day nor the one in between holds the figures once
    // they were moved on (the moves were answered yes, and nothing refused).
    const midRow = S.rows.get(`${mid}|`);
    if (q("#close-date")?.value === last && hasText(`dcDateMovedFrom:${shortDay(mid)}`)) {
      STATS.MV += 1;
      expect(!midRow || midRow.status !== "draft", fail("MV a day reported moved is not on the old date",
        `${mid} said moved, yet it holds ${brief(midRow)}`)).toBe(true);
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
    // r22: locked on another device before this tap — the tap meets that
    // lock, and the page says so (LK); the review is not held to it.
    const lockedBefore = r22 && S.rows.get(`${date}|`)?.status === "confirmed";
    log.push("Bekræft & lås");
    await act(async () => { fireEvent.click(btn); await new Promise((r) => setTimeout(r, 0)); });
    await settle();
    checkPosts();
    if (lockedBefore) {
      await settle();
      checkLockedElsewhere();
      return true;
    }
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
    // r21: a real save of the other device's — a new version of the row.
    await step(`another device scans ${date}`, () => {
      if (r21) S.otherSave(`${date}|`, (r) => { r.receipt_photo = OTHER_PHOTO; });
      else row.receipt_photo = OTHER_PHOTO;
    }, () => { M.otherPhotos[date] = OTHER_PHOTO; });
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

  /* ─── round 21: the network the owner has, two devices, payments only ─── */

  // The page asks which draft wins (a save of it was refused): the owner
  // answers — the newest draft (the form opens it, fresh), or theirs (sent
  // again on the newer version).
  const resolveConflict = async (how = null) => {
    if (!conflictShown()) return false;
    const choice = how || (chance(0.5) ? "reload" : "keep");
    if (choice === "reload") await step("Hent den nyeste kladde", () => tap(/^dcDraftChangedReload$/), onReopenLoaded);
    else {
      // The owner keeps theirs over the version the refusal showed: that
      // version is known to this visit now (R — saved over by choice).
      const key = `${businessDayShown()}|`;
      S.see(S.mountNow, key, S.offered.get(`${S.mountNow}|${key}`) || 0);
      // Its photo goes with it when the page has none (the banner says so).
      if (S.rows.get(key)?.receipt_photo && q('[data-testid="dc-draft-changed-photo"]')) keptOverHere.add(S.rows.get(key).receipt_photo);
      await step("Behold mine tal", () => tap(/^dcDraftChangedKeep/));
    }
    return true;
  };
  // A visit of the page ends while a save is on its way, and the page is
  // opened again: the list (and the draft read by id) answer at once. In the
  // app (`reload` false) the page knows its own saves on their way; a full
  // reload (`reload`) starts with nothing — the browser finishes the save.
  // The save lands before the draft is opened, after, or after the next edit.
  const CLOSE_SAVES = Symbol.for("bonbox.closeSavesOnTheirWay");
  const leaveDuringSave = async ({ lands = null, reload = null, value = null, box = null, entry = undefined } = {}) => {
    if (!(await ensureForm())) return;
    if (hasText("dcDayHasDraft") || hasText("dcDayAlreadyLocked") || conflictShown()) return;
    await arriveAll();
    const [k, f] = box || (chance(0.5) ? ["pay", pick(PAY)] : field());
    if (!(await toStep(k === "rev" ? "s1" : "s2"))) return;
    const el = q(k === "rev" ? `#dc-rev-${f}` : `#dc-pay-${f}`);
    if (!el) return;
    const v = value || pick(VALUES);
    // r22: or it is stored and its answer LOST ("lost") — the page that sent
    // it is gone, and the next visit opens what is stored.
    const when = lands || pick(r22 ? ["beforeOpen", "afterOpen", "afterEdit", "lost"] : ["beforeOpen", "afterOpen", "afterEdit"]);
    const full = reload == null ? chance(0.5) : reload;
    log.push(`${k}.${f}=${v}, left while it saves${full ? " (reload)" : ""}, back (lands ${when})`);
    STATS.steps += 1;
    keyIn(el, v);
    await settle();
    typedInto(k, f, v);
    // Leaving sends the waiting save: on its way when the page is gone.
    if (when === "lost") S.holding.drop = true;
    else S.holding.post = true;
    await unmount();
    S.holding.post = false;
    S.holding.drop = false;
    if (full) { try { globalThis[CLOSE_SAVES]?.clear?.(); } catch { /* none */ } }
    mount(entry);
    await loaded();
    resetDay();
    if (when === "beforeOpen") await arriveAll();
    for (let i = 0; i < 4 && !hasText("dcDayHasDraft") && !onForm(); i++) await settle();
    if (hasText("dcDayHasDraft") && findBtn(/^dcContinueDraft$/)) {
      fireEvent.click(findBtn(/^dcContinueDraft$/));
      for (let i = 0; i < 4 && !onForm(); i++) await settle();
      onReopenLoaded();
    } else if (onForm()) {
      // A link that names the day (?date=) opened its draft by itself.
      onReopenLoaded();
    }
    if (when === "afterOpen") await arriveAll();
    // After the next edit: what lands is checked once that edit is sent.
    if (when === "afterEdit" && S.held.length) { slowStep = true; slowLeft = 1; }
    await checkpoint();
  };
  // Another device saves the day's figures (a new version of the row).
  const otherDeviceFigures = async (change = null, { saveId } = {}) => {
    await arriveAll();
    const date = businessDayShown();
    const key = `${date}|`;
    const row = date && S.rows.get(key);
    if (!row || row.status !== "draft") return;
    // r23 (round 23 review): now and then its offline queue's copy — a save
    // with no id (the day read then says last_save_id null).
    const noId = typeof saveId !== "undefined" ? saveId === null : (r23 && !plan && chance2(0.3));
    if (noId) STATS.noIdWriters += 1;
    await step(`another device saves ${date}${noId ? " (its queued copy, no save id)" : ""}`, () => {
      S.otherSave(key, change || ((r) => {
        r.payment_breakdown = { ...(r.payment_breakdown || {}), mobilepay: r2(Number(r.payment_breakdown?.mobilepay || 0) + 99) };
        r.payment_total = r2(Object.values(r.payment_breakdown).reduce((a, x) => a + Number(x || 0), 0));
        r.notes = `${r.notes || ""}B`;
      }), { saveId: noId ? null : "other-device" });
    });
  };
  // r22 — another device LOCKS the day in view (the draft this page holds).
  const otherDeviceLocks = async () => {
    await arriveAll();
    const date = businessDayShown();
    const key = `${date}|`;
    const row = date && S.rows.get(key);
    if (!row || row.status !== "draft") return;
    await step(`another device locks ${date}`, () => { S.otherLock(key); });
  };
  // The owner types payments only (no revenue line): a till of its own.
  const payOnly = async () => {
    if (!(await ensureForm())) return;
    await typeBox("pay", pick(PAY), pick(VALUES));
    if (chance(0.4)) await typeBox("pay", pick(PAY), pick(VALUES));
  };
  // The sequences lane's finding 1: a day of payments only, a Z-bon summed
  // onto it, then Start forfra — the bon must leave the stored draft.
  const payOnlyBonStartOver = async () => {
    if (!(await ensureForm())) return;
    if (Object.values(M.form.rev).some((x) => val(x) > 0) || photosIn() || M.ownKind !== null && M.ownKind !== "typed") return;
    await typeBox("pay", pick(PAY), pick(["1.234,50", "750", "2.000"]));
    if (!(await toCard()) || (where() !== "idle" && where() !== "card")) return;
    await shoot(pick(BON_KEYS));
    if (q('[data-testid="dc-terminal-question"]')) await answer(chance(0.8) ? "sum" : pick(["replace", "drop"]));
    await apply(pick(["review", "steps"]));
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
      const how = pick(["review", "steps"]);
      // (r23, round 23 review: now and then applied with its save on its
      // way, and Start forfra straight after.)
      if (raceReady() && chance2(0.3)) await applyOnItsWay(how);
      else await apply(how);
    }],
    // Back to the card after a saved photo: Fortryd or Start forfra, then on.
    [5, async () => {
      if (!(await toCard())) return;
      if (where() !== "card") return;
      // r23 (round 23 review): now and then "Brug disse tal", and straight
      // back to the card and Start forfra with that save still on its way
      // (held, or its answer late) — the page waits for it, then deletes
      // exactly what it stored (M6).
      if (r23 && !slowStep && !S.held.length && !q('[data-testid="dc-terminal-question"]') && chance2(0.35)) {
        await appliedOnItsWay();
        return;
      }
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
      // till-by-till sum to hold the review to (moveDate marks it synced).
      // Round 23: a card day is asked too — answered yes.
      await moveDate(twoDaysAgo, "yes");
    }],
    [2, moveDate],
    ...(review ? [[2, doubleMove]] : []),
    ...(r20 ? [[2, otherDevice], [3, photoNoteStartOver]] : []),
    ...(r21 ? [[3, payOnly], [4, payOnlyBonStartOver], [4, () => leaveDuringSave()], [3, () => otherDeviceFigures()]] : []),
    ...(r22 ? [[2, otherDeviceLocks], [2, () => moveDate()]] : []),
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
  // A fresh page load: no saves of an earlier visit on their way.
  try { globalThis[CLOSE_SAVES]?.clear?.(); } catch { /* none */ }
  let thrown = null;
  try {
    mount();
    await loaded();
    if (plan) {
      // A named regression: the reviewers' repro, step by step — every
      // invariant after every step, as in a random sequence.
      await plan({
        S, q, hasText, findBtn, where, onForm, tap, step, settle, expect, fail, log, M,
        today, yesterday, twoDaysAgo, BONS,
        skip: () => step("skip", () => tap(/^skipEnterManually$/)),
        continueDraft: () => step("Fortsæt kladden", () => tap(/^dcContinueDraft$/), onReopenLoaded),
        typeBox, toCard, shoot, answer, apply, startOver, notes, reopen, lock, arriveAll, settleAll,
        leaveDuringSave, otherDeviceFigures, resolveConflict, conflictShown, toStep,
        // Round 22: a date picked (round 23: and its question answered —
        // moveDate(to, "yes" | "no" | "extra")), the day's draft banner's
        // "Start forfra", another device locking the day.
        moveDate, otherDeviceLocks, bannerStartOver,
        // Round 23: what the page asked (useConfirm), and the next answer.
        dialogs, answerNext: (a) => { answerNext = a; },
        // Round 23 review: "Slet den" / "Prøv igen" under the date; another
        // visit's copy on this phone's offline queue, synced now (no save id
        // — the page reads History again once it lands).
        deleteOld, retryMove,
        queueCopy: async (payload) => {
          addToOfflineQueue({ branch_id: null, status: "draft", base_updated_at: NO_ROW_BASE, ...payload });
          STATS.noIdWriters += 1;
          await step(`another visit's queued copy of ${payload.date} synced`, async () => {
            await act(async () => { window.dispatchEvent(new Event("online")); await new Promise((r) => setTimeout(r, 0)); });
            for (let i = 0; i < 6; i++) await settle();
          });
        },
        slow: (mode = "post", steps = 1) => {
          slowStep = true;
          slowLeft = steps;
          if (mode === "answer") S.holding.answer = true;
          else if (mode === "drop") S.holding.drop = true;
          else if (mode === "dead") S.holding.dead = true;
          else if (mode === "offline") {
            S.holding.offline = true;
            setOnline(false);
            // (Round 23: the browser says so — the page's own "offline" state.)
            return act(async () => { window.dispatchEvent(new Event("offline")); await new Promise((r) => setTimeout(r, 0)); });
          } else { S.holding.post = true; S.holding.del = true; }
          return undefined;
        },
        // Round 23: back online now (the slow/offline steps end here).
        online: async () => {
          slowStep = false;
          slowLeft = 0;
          Object.keys(S.holding).forEach((k) => { S.holding[k] = false; });
          await goOnline();
        },
      });
      return { steps: log.length, log };
    }
    if (opening === "draft") {
      await step("Fortsæt kladden", () => tap(/^dcContinueDraft$/), onReopenLoaded);
    } else if (opening === "bannerTyped" || opening === "bannerScan") {
      // The day's draft deleted: "Start forfra" on its banner (round 23).
      await bannerStartOver();
      if (hasText("dcDayHasDraft")) await step("Fortsæt kladden", () => tap(/^dcContinueDraft$/), onReopenLoaded);
      else if (opening === "bannerScan") {
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
    } else if (opening === "payOnly") {
      // Round 21: the day's own till holds payments only.
      await step("skip", () => tap(/^skipEnterManually$/));
      await typeBox("pay", pick(PAY), pick(["1.234,50", "750", "2.000"]));
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
    for (let m = 0; m < motifs; m++) {
      await resolveConflict();
      await pickMotif()();
    }
    await resolveConflict();
    if (chance(0.25)) await lock();
  } catch (e) {
    thrown = e;
    throw e;
  } finally {
    answerNext = null;
    delete globalThis.__dcSeqConfirm;
    // (Never left offline for the next sequence.)
    if (S.holding.offline || navigatorOffline()) { S.holding.offline = false; setOnline(true); }
    await arriveAll();
    await unmount();
    // The page's saves still on their way after it is gone (a leaving save,
    // one waiting its turn) finish HERE, on this sequence's server — never
    // landing in the next sequence's.
    const onTheirWay = globalThis[CLOSE_SAVES];
    for (let i = 0; i < 40 && (S.held.length || onTheirWay?.size); i++) {
      if (S.held.length) await act(async () => { S.releaseHeld(); await new Promise((r) => setTimeout(r, 0)); });
      await settle();
    }
    const stuck = onTheirWay?.size || 0;
    try { onTheirWay?.clear?.(); } catch { /* none */ }
    cleanup();
    // Q (round 21) — every save the page sent finishes: none still waiting
    // (two refused saves once waited on each other for the whole cap, and
    // landed in the next sequence's server).
    if (!thrown) expect(stuck, fail("Q every save finishes", `${stuck} save(s) still on their way after the page was left and the network was quiet`)).toBe(0);
  }
  return { steps: log.length, log };
}
