/**
 * closeTills — the till ledger, under thousands of random days.
 *
 * Rounds 13–16 each fixed one two-till sequence and opened another, because
 * every fix was tested on the one sequence that broke. Here random sequences
 * of {type, scan-sum, scan-replace, page, undo, Start forfra, retake the same
 * bon, load a draft, move the date} run against the ledger, and after EVERY
 * step the invariants are checked:
 *   I1 the saved total is the sum of the tills' totals;
 *   I2 no scan (by id or identical photo) is counted twice;
 *   I3 Start forfra never changes a typed or draft till;
 *   I4 undo restores the exact previous state (one step);
 *   I5 the payments the boxes show add up to the tills' payments;
 *   I6 typed figures never appear in the source as a Z-bon read;
 *   I7 the boxes show the per-line sum of the tills.
 * Then the regression cases from rounds 13–16, by name.
 *
 * No new dependency: a small seeded generator (mulberry32), so a failure
 * prints its seed and replays exactly.
 */
import { describe, expect, it } from "vitest";
import { MERGE_REPLACE, MERGE_SUM, closeSaveTotal } from "../utils/dailyCloseScanMerge";
import {
  TILL_SCAN, activeEntries, addScan, cardView, chooseTerminal, createTills, dateMoved, discardScans,
  formTill, formValues, isDuplicateScan, lastStep, loadDraft, momsOf, needsTerminalQuestion,
  oneSidedLines, savedTotal, sourceMetaOf, tillFromForm, tillGroups, tillTotals, tillsReducer,
  typeIntoForm, undo,
} from "../utils/closeTills";
import { moneyInputText, parseMoneyInput } from "../utils/currency";

const L = "da-DK";
const num = (v) => {
  if (v === null || v === undefined || v === "") return 0;
  const n = typeof v === "string" ? parseMoneyInput(v, L) : v;
  return Number.isFinite(n) ? n : NaN;
};
const near = (a, b) => Math.abs(a - b) < 0.011;

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const REV = ["food", "drinks", "takeaway"];
const PAY = ["card", "cash", "mobilepay"];

function makeRandom(rnd) {
  const int = (lo, hi) => lo + Math.floor(rnd() * (hi - lo + 1));
  const pick = (arr) => arr[int(0, arr.length - 1)];
  const amount = () => (rnd() < 0.2 ? int(1, 900) + 0.5 : int(1, 120) * 100);
  let photoSeq = 0;
  /** A Z-bon read: full split, total-only, split past/under its total, a page. */
  const scan = ({ page = false } = {}) => {
    const s = { revenue: {}, payments: {}, raw_text: `R${photoSeq}`, ocr_available: true };
    const shape = page ? "page" : pick(["full", "full", "totalOnly", "over", "under"]);
    const keys = REV.filter(() => rnd() < 0.6);
    if (shape !== "totalOnly") keys.forEach((k) => { s.revenue[k] = amount(); });
    const lines = Object.values(s.revenue).reduce((a, v) => a + v, 0);
    if (shape === "full") s.revenue_total = lines || amount();
    if (shape === "totalOnly") s.revenue_total = amount();
    if (shape === "over") s.revenue_total = Math.max(1, lines - int(1, 5) * 100) || amount();
    if (shape === "under") s.revenue_total = lines + int(1, 30) * 100;
    if (shape === "page" && rnd() < 0.5) s.moms_total = amount();
    PAY.filter(() => rnd() < 0.5).forEach((k) => { s.payments[k] = amount(); });
    if (shape !== "page" && rnd() < 0.7) s.moms_total = Math.round((s.revenue_total || lines) * 0.2 * 100) / 100;
    if (rnd() < 0.15) s.tips = amount();
    photoSeq += 1;
    return { scan: s, photo: `IMG_${photoSeq}.jpg|${1000 + photoSeq}|${photoSeq}` };
  };
  const text = (f) => (f !== "revenue_total" && rnd() < 0.1 ? "" : moneyInputText(amount(), L));
  const field = () => pick([
    ...REV.map((k) => `revenue.${k}`), ...REV.map((k) => `revenue.${k}`),
    ...PAY.map((k) => `payments.${k}`), "tips", "revenue_total",
  ]);
  const draft = () => {
    const revenue = {};
    REV.filter(() => rnd() < 0.7).forEach((k) => { revenue[k] = moneyInputText(amount(), L); });
    const payments = {};
    PAY.filter(() => rnd() < 0.6).forEach((k) => { payments[k] = moneyInputText(amount(), L); });
    const lines = Object.values(revenue).reduce((a, v) => a + num(v), 0);
    const total = pick([lines, lines, lines + int(1, 40) * 100, Math.max(1, lines - 300)]);
    return { revenue, payments, total, moms: rnd() < 0.4 ? moneyInputText(amount(), L) : null };
  };
  return { int, pick, scan, text, field, draft, rnd };
}

/** The page's own move: the form as a till, from what the boxes show. */
const formOf = (state, field, value) => {
  const fv = formValues(state);
  const rev = { ...fv.revenue };
  const pay = { ...fv.payments };
  if (field?.startsWith("revenue.")) rev[field.slice(8)] = value;
  if (field?.startsWith("payments.")) pay[field.slice(9)] = value;
  return tillFromForm({ revenue: rev, payments: pay, locale: L });
};

/* ─── the invariants ─────────────────────────────────────────────────── */

const groupScansOf = (state) => {
  // Each till alone: a ledger with only that till's entries.
  return tillGroups(state).map((g) => {
    const solo = { ...state, entries: g.map((e) => ({ ...e, replacedBy: null, join: e === g[0] ? "base" : e.join })), pending: [], overlay: {} };
    return formValues(solo);
  });
};

function checkInvariants(state, ctx) {
  const where = () => `seed ${ctx.seed}, step ${ctx.step} (${ctx.action})`;
  // I1 — a typed total that does not read (or reads as nothing) is a red box
  // that blocks the lock, not a figure; the check is for figures.
  const card = cardView(state);
  const unreadable = (v) => v != null && !(num(v) > 0);
  const blocked = unreadable(card?.revenue_total_text)
    || activeEntries(state).some((e) => unreadable(e.edits?.revenue_total))
    || Object.values(state.overlay).some((v) => Number.isNaN(num(v)));
  const tills = tillTotals(state);
  // …and each till's figure is that till's alone: the same till in a day of
  // its own saves the same. (No till's lines fill another till's total.)
  if (!blocked) {
    tillGroups(state).forEach((g, gi) => {
      const solo = { ...state, entries: g.map((e, j) => ({ ...e, replacedBy: null, join: j === 0 ? "base" : e.join })), pending: [], overlay: {} };
      expect(near(savedTotal(solo), tills[gi]), `I1 till ${gi} saves ${tills[gi]} in the day, ${savedTotal(solo)} alone — ${where()}`).toBe(true);
    });
  }
  // The card's own rule agrees whenever every till printed a total and none was typed.
  const plain = tillGroups(state).length > 1 && activeEntries(state).every((e) => !e.edits?.revenue_total)
    && Object.keys(state.overlay).length === 0
    && tillGroups(state).every((g) => g.some((e) => e.origin === TILL_SCAN && e.scan.revenue_total > 0) && g.every((e) => e.origin === TILL_SCAN));
  if (plain) {
    expect(near(closeSaveTotal(card, Object.values(card.revenue).reduce((a, v) => a + (num(v) || 0), 0), L), savedTotal(state)),
      `I1 the card's rule ${closeSaveTotal(card, 0, L)} vs ${savedTotal(state)} — ${where()}`).toBe(true);
  }
  if (!blocked) expect(near(savedTotal(state), tills.reduce((a, v) => a + v, 0)), `I1 saved ${savedTotal(state)} vs tills ${tills} — ${where()}`).toBe(true);
  // I2
  const scans = [...activeEntries(state).filter((e) => e.origin === TILL_SCAN), ...state.pending];
  const photos = scans.map((e) => e.photo).filter(Boolean);
  expect(new Set(photos).size, `I2 photo counted twice — ${where()}`).toBe(photos.length);
  const ids = scans.map((e) => e.scanId).filter(Boolean);
  expect(new Set(ids).size, `I2 scan id counted twice — ${where()}`).toBe(ids.length);
  // I5 + I7 — readable boxes only (an unreadable keystroke blocks the lock instead)
  const fv = formValues(state);
  const perTill = groupScansOf(state);
  for (const bucket of ["revenue", "payments"]) {
    const keys = new Set([...Object.keys(fv[bucket]), ...perTill.flatMap((t) => Object.keys(t[bucket]))]);
    for (const k of keys) {
      const shown = num(fv[bucket][k]);
      if (Number.isNaN(shown)) continue;
      const sum = perTill.reduce((a, t) => a + (num(t[bucket][k]) || 0), 0);
      expect(near(shown, sum), `I7 ${bucket}.${k} shows ${shown}, tills add to ${sum} — ${where()}`).toBe(true);
    }
  }
  const paySum = Object.values(fv.payments).reduce((a, v) => a + (num(v) || 0), 0);
  const tillPays = perTill.reduce((a, t) => a + Object.values(t.payments).reduce((b, v) => b + (num(v) || 0), 0), 0);
  if (!Object.values(fv.payments).some((v) => Number.isNaN(num(v)))) {
    expect(near(paySum, tillPays), `I5 payments ${paySum} vs tills ${tillPays} — ${where()}`).toBe(true);
  }
  // I6
  const meta = sourceMetaOf(state, { revenue_breakdown: {}, payment_breakdown: {} });
  const hasScan = activeEntries(state).some((e) => e.origin === TILL_SCAN);
  if (!hasScan) expect(meta?.kind, `I6 no photo, yet "zbon" — ${where()}`).not.toBe("zbon");
  const ft = formTill(state);
  if (meta?.kind === "zbon" && ft && tillGroups(state).length > 1 && !ft.meta) {
    expect(meta.typed_tills, `I6 a typed till filed as a Z-bon read — ${where()}`).toEqual([0]);
  }
  if (meta?.kind === "zbon" && tillGroups(state).length > 1) {
    expect(meta.terminal_totals.length).toBe(tillGroups(state).length);
    expect(near(meta.terminal_totals.reduce((a, v) => a + v, 0), savedTotal(state)), `I6 tills ≠ saved — ${where()}`).toBe(true);
  }
}

function runSequence(seed, steps) {
  const rnd = mulberry32(seed);
  const R = makeRandom(rnd);
  let state = createTills(L);
  const seen = []; // photos already shot, for "retake the same bon"
  const model = []; // snapshots the ledger's undo must return to
  const ctx = { seed, step: 0, action: "" };
  const push = (before, after) => {
    if (after.undo !== before.undo) {
      model.push({ entries: before.entries, pending: before.pending, overlay: before.overlay });
      if (model.length > 30) model.shift();
    }
  };
  const shoot = (s, mode) => {
    const before = state;
    state = addScan(state, s.scan, { photo: s.photo, form: R.rnd() < 0.8 ? formOf(state) : undefined });
    push(before, state);
    if (state.pending.length && mode) {
      const b2 = state;
      state = chooseTerminal(state, mode);
      push(b2, state);
    }
  };
  for (let i = 0; i < steps; i++) {
    ctx.step = i;
    const action = R.pick(["type", "type", "type", "sum", "sum", "replace", "page", "undo", "forfra", "retake", "draft", "date", "answer"]);
    ctx.action = action;
    if (action === "type") {
      const f = R.field();
      const v = R.text(f);
      state = typeIntoForm(state, f, v, { form: activeEntries(state).length ? undefined : formOf(state, f, v), fromForm: R.rnd() < 0.5 });
    } else if (action === "sum" || action === "replace" || action === "page") {
      const s = R.scan({ page: action === "page" });
      seen.push(s);
      shoot(s, action === "sum" ? MERGE_SUM : action === "replace" ? MERGE_REPLACE : null);
    } else if (action === "answer") {
      if (state.pending.length) {
        const before = state;
        state = chooseTerminal(state, R.rnd() < 0.7 ? MERGE_SUM : MERGE_REPLACE);
        push(before, state);
      }
    } else if (action === "retake") {
      if (seen.length) {
        const s = R.pick(seen);
        const dup = isDuplicateScan(state, { photo: s.photo, scan: s.scan });
        const before = state;
        const after = addScan(state, s.scan, { photo: s.photo, form: formOf(state) });
        if (dup) expect(after, `retake of a photo already in the day changed it — seed ${seed} step ${i}`).toBe(before);
        state = after;
        push(before, state);
        if (state.pending.length) {
          const b2 = state;
          state = chooseTerminal(state, R.rnd() < 0.5 ? MERGE_SUM : MERGE_REPLACE);
          push(b2, state);
        }
      }
    } else if (action === "undo") {
      const expected = model.pop();
      const before = state;
      state = undo(state);
      if (expected) {
        // I4: exactly the state before the last step — the very same objects.
        expect(state.entries, `I4 entries — seed ${seed} step ${i}`).toBe(expected.entries);
        expect(state.pending, `I4 pending — seed ${seed} step ${i}`).toBe(expected.pending);
        expect(state.overlay, `I4 overlay — seed ${seed} step ${i}`).toBe(expected.overlay);
      } else {
        expect(state).toBe(before);
      }
    } else if (action === "forfra") {
      const own = state.entries.filter((e) => e.origin !== TILL_SCAN);
      const before = state;
      state = discardScans(state);
      push(before, state);
      // I3: the typed / draft tills are exactly as they were.
      const after = state.entries;
      expect(after.length, `I3 — seed ${seed} step ${i}`).toBe(own.length);
      own.forEach((e, j) => {
        const { replacedBy: _a, ...was } = e;
        const { replacedBy: _b, ...now } = after[j];
        expect(now, `I3 typed till changed — seed ${seed} step ${i}`).toEqual(was);
      });
      expect(state.pending).toEqual([]);
      expect(after.every((e) => !e.replacedBy)).toBe(true);
    } else if (action === "draft") {
      state = loadDraft(state, R.draft());
      model.length = 0;
    } else if (action === "date") {
      const before = state;
      state = dateMoved(state, `2026-06-${String(R.int(1, 28)).padStart(2, "0")}`);
      expect(state.entries).toBe(before.entries);
      expect(state.pending).toBe(before.pending);
    }
    if (REPLAY) {
      console.log(i, action, JSON.stringify({
        tills: tillGroups(state).map((g) => g.map((e) => `${e.id}:${e.origin}/${e.join}${Object.keys(e.edits).length ? JSON.stringify(e.edits) : ""}`)),
        totals: tillTotals(state), saved: savedTotal(state), pending: state.pending.length, overlay: state.overlay,
        card: cardView(state) && { rev: cardView(state).revenue, total: cardView(state).revenue_total, text: cardView(state).revenue_total_text, bon: cardView(state).bon_total, mi: cardView(state).merge_info },
      }));
    }
    checkInvariants(state, ctx);
  }
  return state;
}

// Replay one failing seed with a step log: TILLS_SEED=34 npx vitest run closeTills
const REPLAY = Number(globalThis.process?.env?.TILLS_SEED || 0);

describe("closeTills — random days (property)", () => {
  const SEQUENCES = 4000;
  const STEPS = 35;
  it(`${SEQUENCES} random sequences of ${STEPS} steps keep every invariant after every step`, () => {
    let scansSeen = 0;
    for (let seed = REPLAY || 1; seed <= (REPLAY || SEQUENCES); seed++) {
      const end = runSequence(seed, STEPS);
      scansSeen += end.entries.filter((e) => e.origin === TILL_SCAN).length;
    }
    // The generator really builds multi-till days, not just empty ones.
    expect(scansSeen).toBeGreaterThan(SEQUENCES);
  }, 120000);
});

/* ─── regression cases, rounds 13–16 ─────────────────────────────────── */

const DRAFT_17130 = { revenue: { food: "9.600", drinks: "5.500", takeaway: "2.030" }, payments: { card: "12.000", cash: "5.130" }, total: 17130 };
const TILL2 = { revenue: {}, revenue_total: 4000, moms_total: 800, payments: { card: 4000 } };
const BON_3000 = { revenue: { food: 2000, drinks: 1000 }, revenue_total: 3000, moms_total: 600, payments: { card: 3000 } };
const typedForm = (rev, pay, moms = null) => tillFromForm({ revenue: rev, payments: pay, moms, locale: L });

describe("closeTills — the sequences that broke before (r13–r16)", () => {
  it("17.130 + 4.000 = 21.130, and Fortryd brings 17.130 back with the question", () => {
    let s = loadDraft(createTills(L), DRAFT_17130);
    expect(needsTerminalQuestion(s, TILL2)).toBe(true);
    s = addScan(s, TILL2, { photo: "till2", form: typedForm(DRAFT_17130.revenue, DRAFT_17130.payments) });
    expect(s.pending).toHaveLength(1);
    expect(savedTotal(s)).toBe(17130);
    s = chooseTerminal(s, MERGE_SUM);
    expect(savedTotal(s)).toBe(21130);
    expect(cardView(s).merge_info.terminalTotals).toEqual([17130, 4000]);
    expect(lastStep(s)).toBe("sum");
    s = undo(s);
    expect(savedTotal(s)).toBe(17130);
    expect(s.pending).toHaveLength(1);
  });

  it("typed 14.000 + bon 3.000, applied, Start forfra, the same bon again: 17.000 — never 20.000", () => {
    const rev = { food: "9.000", drinks: "5.000" };
    const pay = { cash: "4.000", card: "10.000" };
    let s = createTills(L);
    s = typeIntoForm(s, "revenue.food", "9.000", { form: typedForm(rev, pay), fromForm: true });
    s = addScan(s, BON_3000, { photo: "bon", form: typedForm(rev, pay) });
    s = chooseTerminal(s, MERGE_SUM);
    expect(savedTotal(s)).toBe(17000);
    expect(formValues(s).payments.card).toBe(13000);
    // Start forfra: the bon goes, the typed till is the day again.
    s = discardScans(s);
    expect(savedTotal(s)).toBe(14000);
    expect(formValues(s)).toMatchObject({ revenue: { food: "9.000", drinks: "5.000" }, payments: { card: "10.000", cash: "4.000" } });
    // The boxes now show the typed till; the retake is asked about against 14.000.
    const fv = formValues(s);
    s = addScan(s, BON_3000, { photo: "bon", form: typedForm(fv.revenue, fv.payments) });
    expect(s.pending).toHaveLength(1);
    expect(tillTotals(s)).toEqual([14000]);
    s = chooseTerminal(s, MERGE_SUM);
    expect(savedTotal(s)).toBe(17000);
    expect(formValues(s).payments).toMatchObject({ card: 13000, cash: 4000 });
    // The typed till had no MOMS: worked out for the whole 17.000 (3.400 at 25 %).
    expect(momsOf(s).source).toBe("auto");
  });

  it("a reopened draft + a bon asks the question", () => {
    const s = loadDraft(createTills(L), DRAFT_17130);
    const next = addScan(s, BON_3000, { photo: "x", form: typedForm(DRAFT_17130.revenue, DRAFT_17130.payments) });
    expect(next.pending).toHaveLength(1);
    expect(activeEntries(next)).toHaveLength(1);
  });

  it("a total-only bon over a split form: splitting it fills Ikke fordelt, never adds to the day", () => {
    let s = typeIntoForm(createTills(L), "revenue.food", "9.000", { form: typedForm({ food: "9.000", drinks: "5.000" }, {}) });
    s = addScan(s, TILL2, { photo: "t2", form: typedForm({ food: "9.000", drinks: "5.000" }, {}) });
    s = chooseTerminal(s, MERGE_SUM);
    expect(savedTotal(s)).toBe(18000);
    const typedBefore = formTill(s);
    s = typeIntoForm(s, "revenue.takeaway", "4.000");
    expect(savedTotal(s)).toBe(18000);
    expect(formValues(s).revenue.takeaway).toBe("4.000");
    // It went to the bon's till (its unsplit room), not the owner's.
    expect(formTill(s)).toBe(typedBefore);
    // …and raising past the room goes to the owner's till.
    s = typeIntoForm(s, "revenue.food", "9.500");
    expect(savedTotal(s)).toBe(18500);
  });

  it("MOMS 3.000 typed + the bon's 800 = 3.800, the owner's figure", () => {
    const form = typedForm({ food: "17.130" }, {}, 3000);
    let s = typeIntoForm(createTills(L), "revenue.food", "17.130", { form });
    s = addScan(s, TILL2, { photo: "t2", form });
    s = chooseTerminal(s, MERGE_SUM);
    expect(momsOf(s)).toMatchObject({ source: "typed", value: 3800 });
    // Without the typed MOMS: one till had none → worked out, and MOMS is not
    // named as "stood on one bon only" — it is not that figure.
    let a = typeIntoForm(createTills(L), "revenue.food", "17.130", { form: typedForm({ food: "17.130" }, {}) });
    a = chooseTerminal(addScan(a, TILL2, { photo: "t2", form: typedForm({ food: "17.130" }, {}) }), MERGE_SUM);
    expect(momsOf(a)).toMatchObject({ source: "auto", oneTill: true });
    expect([...oneSidedLines(a).read, ...oneSidedLines(a).own]).not.toContain("moms_total");
    expect(oneSidedLines(a, { listMoms: true }).read).toContain("moms_total");
  });

  it("a typed till summed with a bon is filed as typed, never as a Z-bon read", () => {
    let s = typeIntoForm(createTills(L), "revenue.food", "17.130", { form: typedForm({ food: "17.130" }, {}) });
    s = chooseTerminal(addScan(s, TILL2, { photo: "t2", form: typedForm({ food: "17.130" }, {}) }), MERGE_SUM);
    expect(sourceMetaOf(s, { revenue_breakdown: { food: 17130 }, payment_breakdown: { card: 4000 } })).toEqual({
      kind: "zbon", scans: 1, terminal_totals: [17130, 4000], typed_tills: [0], corrected: [], typed: ["rev:food"],
    });
    // No photo at all: typed.
    expect(sourceMetaOf(typeIntoForm(createTills(L), "revenue.food", "5"))).toEqual({ kind: "typed" });
  });

  it("a correction made after a sum and taken back saves the bons' figure again (r12)", () => {
    const t1 = { revenue: { food: 9000, drinks: 6000, takeaway: 2030 }, revenue_total: 17030, moms_total: 3406, payments: { card: 17030 } };
    const t2 = { revenue: {}, revenue_total: 5000, moms_total: 1000, payments: { card: 5000 } };
    let s = addScan(createTills(L), t1, { photo: "a" });
    s = typeIntoForm(s, "revenue.food", "9.500");
    s = chooseTerminal(addScan(s, t2, { photo: "b" }), MERGE_SUM);
    expect(savedTotal(s)).toBe(22530);
    s = typeIntoForm(s, "revenue.food", "9.000");
    expect(savedTotal(s)).toBe(22030);
    // The merge line keeps what the tills brought when they were added.
    expect(cardView(s).merge_info.terminalTotals).toEqual([17530, 5000]);
    expect(momsOf(s)).toMatchObject({ source: "zbon", value: 4406 });
    expect(sourceMetaOf(s).terminal_totals).toEqual([17030, 5000]);
  });

  it("\"same terminal\" over a typed close, then Start forfra: the typed figures come back", () => {
    let s = typeIntoForm(createTills(L), "revenue.food", "17.130", { form: typedForm({ food: "17.130" }, {}) });
    s = chooseTerminal(addScan(s, TILL2, { photo: "t2", form: typedForm({ food: "17.130" }, {}) }), MERGE_REPLACE);
    expect(savedTotal(s)).toBe(4000);
    s = discardScans(s);
    expect(savedTotal(s)).toBe(17130);
    expect(formValues(s).revenue.food).toBe("17.130");
  });

  it("the same photo read the same way again is not a second till", () => {
    let s = addScan(createTills(L), BON_3000, { photo: "IMG_1|5|7" });
    const again = addScan(s, BON_3000, { photo: "IMG_1|5|7" });
    expect(again).toBe(s);
    s = discardScans(s);
    expect(addScan(s, BON_3000, { photo: "IMG_1|5|7" }).entries).toHaveLength(1);
  });

  it("a card correction on a summed day is on the record as corrected", () => {
    const t1 = { revenue: { food: 9000 }, revenue_total: 9000, payments: { card: 9000 } };
    let s = chooseTerminal(addScan(addScan(createTills(L), t1, { photo: "a" }), TILL2, { photo: "b" }), MERGE_SUM);
    s = typeIntoForm(s, "payments.cash", "500");
    s = typeIntoForm(s, "revenue.food", "8.500");
    const meta = sourceMetaOf(s, { revenue_breakdown: { food: 8500 }, payment_breakdown: { card: 13000, cash: 500 } });
    expect(meta.corrected).toEqual(expect.arrayContaining(["rev:food", "pay:cash"]));
  });

  it("a reopened draft that was a sum keeps its tills on the record", () => {
    let s = loadDraft(createTills(L), {
      revenue: { food: "11.000", drinks: "6.000" }, payments: { card: "13.000", cash: "4.000" }, total: 17000,
      meta: { kind: "zbon", scans: 1, terminal_totals: [14000, 3000], typed_tills: [0] },
    });
    s = chooseTerminal(addScan(s, TILL2, { photo: "t2", form: typedForm({ food: "11.000", drinks: "6.000" }, { card: "13.000", cash: "4.000" }) }), MERGE_SUM);
    expect(sourceMetaOf(s)).toMatchObject({ kind: "zbon", terminal_totals: [14000, 3000, 4000], typed_tills: [0], scans: 2 });
  });

  it("the reducer routes every action", () => {
    let s = createTills(L);
    s = tillsReducer(s, { type: "type", field: "revenue.food", value: "100", fromForm: true });
    s = tillsReducer(s, { type: "scan", scan: TILL2, photo: "p" });
    expect(s.pending).toHaveLength(1);
    s = tillsReducer(s, { type: "choose", mode: MERGE_SUM });
    expect(savedTotal(s)).toBe(4100);
    s = tillsReducer(s, { type: "undo" });
    s = tillsReducer(s, { type: "discard" });
    expect(savedTotal(s)).toBe(100);
    expect(tillsReducer(s, { type: "nope" })).toBe(s);
  });
});
