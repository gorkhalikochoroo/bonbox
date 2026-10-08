/**
 * Round 21 — the sequence harness in its "r21" variant (src/test/closeSequenceHarness.jsx):
 * the r20 variant over the network an owner actually has — a save held on
 * its way or its answer late, the history list (and a draft read by id)
 * answering before a save on its way has landed, the page left and opened
 * again during a save (in the app, or a full reload) — plus another device
 * saving the day's figures, and a day whose own till is payments only.
 * Every invariant after every step (I1–I7, M4, M4b, M6, MV, F1–F6) and
 * round 21's:
 *   R    no save ever lands over a version of the day its page was never
 *        given (the server's draft_changed check, mirrored by the stub);
 *   I1z  the review of a day of payments only is what is stored;
 *   I7   the stored row is the page's last save (cash, source, photo).
 *
 * The reviewers' repros (round 20 sequences lane) are named regressions,
 * scripted step by step under the seed numbers the reviewers reported —
 * each FAILS on the round-20 page (ca9432d6):
 *   31252           Start forfra on a payments-only own till (finding 1);
 *   30015 / 30672 / 50756
 *                   left during a save, opened again (list first, a full
 *                   reload, a ?date= link), the next edit (finding 2);
 *   31176 / 40947   another device saves between the page's open and its
 *                   edit — the newest draft, or "keep mine" (finding 2);
 *   40001 / 40465   Start forfra while the photo's save is on its way
 *                   (finding 4);
 *   payments only   never saved (finding 3).
 * Replay one: SEQ_FROM=<seed> SEQ_COUNT=1 npx vitest run src/__tests__/DailyClosePage.r21Sequences.test.jsx
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn(), delete: (...a) => del(...a) },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fallbackOrVars, maybeVars) => {
      const vars = typeof fallbackOrVars === "object" ? fallbackOrVars : maybeVars;
      return vars ? `${k}:${Object.values(vars).join("|")}` : k;
    },
    lang: "da",
    setLang: () => {},
    LANGUAGES: [],
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const { runSequence, createServer, photoUrl, STATS } = await import("../test/closeSequenceHarness");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const env = globalThis.process?.env || {};
const FROM = Number(env.SEQ_FROM || 8001);
const COUNT = Number(env.SEQ_COUNT || 150);
const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const key = `${today}|`;

/** A draft typed by hand for today, as another visit (or phone) saved it. */
const seededDraft = (extra = {}) => ({
  id: "seed1", date: today, branch_id: null, status: "draft",
  revenue_total: 3000, revenue_breakdown: { food: 3000 }, payment_breakdown: {},
  moms_mode: "auto", moms_total: 600, source_meta: { kind: "typed" }, closed_by: null, notes: null,
  ...extra,
});

const stored = (S) => S.rows.get(key);

// [name, seed, plan, server rows]
const PLANS = [
  ["finding 1 — Start forfra on a payments-only own till left the thrown-away Z-bon (17.030) in the stored draft (sequences lane, seed 31252)", 31252, async (A) => {
    await A.skip();
    await A.typeBox("pay", "mobilepay", "1.234,50");
    await A.toCard();
    await A.shoot("till1");
    await A.answer("sum");
    await A.apply("steps");
    await A.toCard();
    await A.startOver();
    await A.settleAll();
    // What is stored is the day on screen: MobilePay 1.234,50, typed, no
    // photo — never 18.264,50, the bon's lines, its photo or "Z-bon".
    const row = stored(A.S);
    A.expect(row, "a draft of the payments").toBeTruthy();
    A.expect(Number(row.revenue_total) || 0).toBe(0);
    A.expect(row.revenue_breakdown).toEqual({});
    A.expect(row.payment_breakdown).toEqual({ mobilepay: 1234.5 });
    A.expect(row.receipt_photo || null).toBe(null);
    A.expect(row.source_meta?.kind).toBe("typed");
    // Back to the form: the review holds that too (I1z).
    await A.skip();
    await A.toStep("review");
  }],
  ["finding 3 — payments only were never saved: leaving lost MobilePay 1.234,50 (sequences lane)", 31253, async (A) => {
    await A.skip();
    await A.typeBox("pay", "mobilepay", "1.234,50");
    const row = stored(A.S);
    A.expect(row, "the payments are saved").toBeTruthy();
    A.expect(row.payment_breakdown).toEqual({ mobilepay: 1234.5 });
    await A.reopen();
  }],
  ["finding 2 — left while Kort 2.000 was saving, a full reload, the list first: the next note erased Kort 2.000 (sequences lane, seed 30015)", 30015, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    await A.leaveDuringSave({ box: ["pay", "card"], value: "2.000", lands: "afterOpen", reload: true });
    await A.notes();
    // Never erased: refused, and the page asks — the newest draft wins here.
    A.expect(stored(A.S).payment_breakdown).toEqual({ card: 2000 });
    A.expect(A.conflictShown()).toBe(true);
    A.expect(A.S.refused.length).toBe(1);
    await A.resolveConflict("reload");
    await A.notes();
    A.expect(stored(A.S).payment_breakdown).toEqual({ card: 2000 });
  }],
  ["finding 2 — the save landed before Fortsæt, but the page opened the list's older row (sequences lane, seed 30672)", 30672, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    await A.leaveDuringSave({ box: ["pay", "card"], value: "2.000", lands: "beforeOpen", reload: true });
    // Opened fresh: Kort 2.000 is on the form (I1 holds the review to it),
    // and the next edit is saved on it — nothing to ask.
    await A.notes();
    A.expect(stored(A.S).payment_breakdown).toEqual({ card: 2000 });
    A.expect(A.S.byIdGets).toBeGreaterThan(0);
    A.expect(A.S.refused.length).toBe(0);
  }],
  ["finding 2 — left during a save, back through a ?date= link that opens the draft by itself (sequences lane, seed 50756)", 50756, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    await A.leaveDuringSave({ box: ["pay", "card"], value: "2.000", lands: "afterOpen", reload: true, entry: `/daily-close?date=${today}` });
    await A.typeBox("rev", "drinks", "1.500");
    A.expect(stored(A.S).payment_breakdown).toEqual({ card: 2000 });
    A.expect(A.conflictShown()).toBe(true);
    await A.resolveConflict("keep");
    // Kept by the owner's choice: theirs is stored, on the newer version.
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 3000, drinks: 1500 });
  }],
  ["finding 2 — left during a save inside the app: the next visit lists the day once that save has landed (sequences lane, seed 30015, in-app)", 30016, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    await A.leaveDuringSave({ box: ["pay", "card"], value: "2.000", lands: "afterOpen", reload: false });
    await A.continueDraft();
    await A.notes();
    A.expect(stored(A.S).payment_breakdown).toEqual({ card: 2000 });
    A.expect(A.S.refused.length).toBe(0);
  }],
  ["finding 2 — two devices: B saved between A's open and A's edit; A's edit was filed over it (sequences lane, seed 31176)", 31176, async (A) => {
    await A.continueDraft();
    await A.otherDeviceFigures((r) => { r.payment_breakdown = { card: 2000 }; r.payment_total = 2000; r.notes = "B"; });
    await A.typeBox("rev", "drinks", "1.500");
    // Refused: B's Kort 2.000 and note are still stored, and A is asked.
    A.expect(stored(A.S).payment_breakdown).toEqual({ card: 2000 });
    A.expect(stored(A.S).notes).toBe("B");
    A.expect(A.conflictShown()).toBe(true);
    await A.resolveConflict("reload");
    await A.typeBox("rev", "drinks", "1.500");
    const row = stored(A.S);
    A.expect(row.payment_breakdown).toEqual({ card: 2000 });
    A.expect(row.revenue_breakdown).toEqual({ food: 3000, drinks: 1500 });
  }, [seededDraft()]],
  ["finding 2 — two devices, the owner keeps theirs: sent again on B's version, nothing lost in silence (sequences lane, seed 40947)", 40947, async (A) => {
    await A.continueDraft();
    await A.otherDeviceFigures((r) => { r.payment_breakdown = { card: 2000 }; r.payment_total = 2000; r.notes = "B"; });
    await A.typeBox("rev", "food", "3.500");
    A.expect(stored(A.S).payment_breakdown).toEqual({ card: 2000 });
    A.expect(A.conflictShown()).toBe(true);
    await A.resolveConflict("keep");
    const row = stored(A.S);
    A.expect(row.revenue_breakdown).toEqual({ food: 3500 });
    A.expect(row.payment_breakdown).toEqual({});
    A.expect(A.S.refused.length).toBe(1);
  }, [seededDraft()]],
  ["finding 4 — Start forfra while the photo's save was answered late kept the thrown-away bon's photo on the typed draft (sequences lane, seed 40001)", 40001, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    await A.toCard();
    await A.shoot("b4000");
    await A.answer("sum");
    // The photo's save reaches the server; its answer is late.
    A.slow("answer", 3);
    await A.apply("steps");
    await A.toCard();
    await A.startOver();
    await A.settleAll();
    const row = stored(A.S);
    A.expect(row.revenue_total).toBe(3000);
    A.expect(row.receipt_photo || null).toBe(null);
    A.expect(row.source_meta?.kind).toBe("typed");
  }],
  ["finding 4 — the same with the save itself late, applied with \"Brug disse tal\" (sequences lane, seed 40465)", 40465, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    await A.toCard();
    await A.shoot("b4000");
    await A.answer("sum");
    A.slow("post", 3);
    await A.apply("review");
    await A.toCard();
    await A.startOver();
    await A.settleAll();
    const row = stored(A.S);
    A.expect(row.revenue_total).toBe(3000);
    A.expect(row.receipt_photo || null).toBe(null);
    A.expect(A.S.posts.some((b) => b.receipt_photo === photoUrl("p1-b4000.jpg"))).toBe(true);
  }],
  // Round 21 review — a save's answer lost on the way back (stored): the
  // form's next save and its lock follow it (base_save_id), never "saved
  // somewhere else" over the owner's own figures.
  ["review — Kort 2.000 stored but its answer lost: the next note is saved on it, nobody asked", 21601, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    A.slow("drop", 1);
    await A.typeBox("pay", "card", "2.000");
    A.expect(stored(A.S).payment_breakdown).toEqual({ card: 2000 });
    await A.notes();
    A.expect(A.S.refused.length).toBe(0);
    A.expect(A.conflictShown()).toBe(false);
    A.expect(stored(A.S).payment_breakdown).toEqual({ card: 2000 });
    A.expect(stored(A.S).notes).toBeTruthy();
  }],
  ["review — the lost answer, then the lock: locked on it, never refused", 21602, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    A.slow("drop", 1);
    await A.typeBox("rev", "drinks", "1.500");
    await A.lock();
    A.expect(A.S.refused.length).toBe(0);
    A.expect(stored(A.S)).toMatchObject({ status: "confirmed", revenue_total: 4500 });
  }],
];

// Found by this variant while round 21 was built (each broke an earlier cut
// of the fixes): another device's version under a kept or reverted draft,
// a refused save's photo, two refused saves waiting on each other, the
// conflict shown on the scan card, "keep mine" over another version's source.
const FOUND = [
  ["the conflict is asked on the scan card too", 8087],
  ["another device's photo on its own version (I7)", 8015],
  ["a revert refused over another device's version: its draft shows (M6/M4b)", 10261],
  ["a slow revert of the replaced draft lands under the next photo's card (M4b)", 12005],
  ["\"Behold mine tal\" says the form's own source again (F6)", 12198],
  ["a save sent while the page goes away never slips past another device's version (R/M4b)", 13522],
  ["\"Behold mine tal\" with nothing left to file shows the stored draft (M4b)", 14094],
  ["two refused saves never wait on each other (Q)", 14429],
  ["a date moved and moved back before the new day's save answered leaves no copy there (MV)", 30774],
  ["another device's version is not held to what this page stored (M4b)", 30595],
];

describe("daily close — round 21 sequences (a slow, reordered network, two devices, payments only)", () => {
  beforeAll(() => {
    window.scrollTo = () => {};
    Element.prototype.scrollIntoView = () => {};
    window.confirm = () => true;
    window.URL.createObjectURL = () => "blob:http://localhost/preview";
    window.URL.revokeObjectURL = () => {};
  });
  afterAll(async () => {
    if (env.SEQ_STATS) console.log("sequence checks", JSON.stringify(STATS));
    await new Promise((r) => setTimeout(r, 3200));
  }, 10000);
  for (const [what, seed, plan, rows = []] of PLANS) {
    it(`${what}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      const S = createServer({ rows: rows.map((r) => ({ ...r })) });
      await runSequence(seed, { DailyClosePage }, { S, get, post, del }, { variant: "r21", plan });
    }, 30000);
  }
  for (const [what, seed] of FOUND) {
    it(`${what}: seed ${seed}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      await runSequence(seed, { DailyClosePage }, { get, post, del }, { variant: "r21" });
    }, 30000);
  }
  for (let seed = FROM; seed < FROM + COUNT; seed++) {
    it(`seed ${seed}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      await runSequence(seed, { DailyClosePage }, { get, post, del }, { variant: "r21" });
    }, 30000);
  }
  it("checked what it claims", () => {
    if (env.SEQ_FROM) return;
    // The new invariants actually ran (a zero would be a vacuous green).
    expect(STATS.R).toBeGreaterThan(0);
    expect(STATS.I1z).toBeGreaterThan(0);
    expect(STATS.I7).toBeGreaterThan(0);
  });
});
