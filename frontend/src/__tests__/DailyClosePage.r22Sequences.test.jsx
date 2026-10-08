/**
 * Round 22 — the sequence harness in its "r22" variant
 * (src/test/closeSequenceHarness.jsx): the round's FIXED failure model, every
 * class of it at random — slow saves, reordered answers, a save that is
 * STORED but whose ANSWER IS LOST, the page left and opened again during a
 * save, another device saving or LOCKING the day, offline. Every invariant
 * after every step (I1–I7, M4, M4b, M6, MV, F1–F6, R) and round 22's:
 *   MV / M6 with a lost answer — the stored row(s) are what the owner last
 *        saw or chose: a day "moved" is never also left on the old date, a
 *        Start forfra takes the photo's draft back (or the replaced draft
 *        comes back) though the save that filed it never answered;
 *   LK   a day another device locked is said once a save of this visit met
 *        the lock — never edits refused in silence.
 *
 * The reviewers' repros (round 21 sequences lane) are named regressions,
 * scripted step by step — each FAILS on the round-21 page (dfb46ddb):
 *   22001  a date move after a save whose answer was lost copied the day
 *          and said "moved" (finding 1);
 *   22002  the banner's Start forfra, a new Z-bon, its save's answer lost,
 *          Start forfra: the original draft gone, the thrown-away bon stored
 *          (finding 2);
 *   22003 / 22004
 *          a Z-bon day whose saves' answers were lost: Start forfra kept the
 *          thrown-away bon as the stored draft, with no banner (finding 3);
 *   22005  another device locks the day: the next edit was refused in
 *          silence (finding 4);
 * and the same class on the other paths the rule covers (a replaced draft
 * moved, the new day's save of a move losing its answer, the newest draft
 * locked elsewhere, leaving and coming back — 22009 / 22010 pass on dfb46ddb
 * too and pin it). FOUND: seeds this variant failed while the round was
 * built — 9157, 9204, 9259 and 9293 fail on dfb46ddb; 9474 pins the
 * harness's rule that a day locked elsewhere is never said "moved".
 * Replay one: SEQ_FROM=<seed> SEQ_COUNT=1 npx vitest run src/__tests__/DailyClosePage.r22Sequences.test.jsx
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
const FROM = Number(env.SEQ_FROM || 9001);
const COUNT = Number(env.SEQ_COUNT || 150);
const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const key = `${today}|`;

/** A draft typed by hand for today (Mad 9.000 + Drikkevarer 5.000). */
const typedDraft = (extra = {}) => ({
  id: "seed1", date: today, branch_id: null, status: "draft",
  revenue_total: 14000, revenue_breakdown: { food: 9000, drinks: 5000 }, payment_breakdown: { card: 14000 },
  moms_mode: "auto", moms_total: 2800, source_meta: { kind: "typed" }, closed_by: null, notes: null,
  ...extra,
});
/** A Z-bon read with its own photo, a cash count and a note (the reviewers' 17.030). */
const zbonDraft = () => ({
  id: "seed1", date: today, branch_id: null, status: "draft",
  revenue_total: 17030, revenue_breakdown: { food: 9000, drinks: 6000, takeaway: 2030 }, payment_breakdown: { card: 12000, cash: 5030 },
  moms_mode: "manual", moms_total: 3406, source_meta: { kind: "zbon", scans: 1, corrected: [] },
  receipt_photo: "u1/kasserapport/seed-own.jpg", cash_counted: 980, cash_float: 500, closed_by: "Test", notes: "Test",
});

const stored = (S, k = key) => S.rows.get(k);

// [name, seed, plan, server rows]
const PLANS = [
  ["finding 1 — Mad 3.000 stored, its answer lost, the date moved: the old day kept a copy and the page said \"moved\" (sequences lane)", 22001, async (A) => {
    await A.skip();
    A.slow("drop", 1);
    await A.typeBox("rev", "food", "3.000");
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 3000 });
    await A.moveDate(A.yesterday);
    await A.settleAll();
    // Moved, not copied: the old day holds nothing, the new day the figures,
    // and the note under the date is true.
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(stored(A.S, `${A.yesterday}|`).revenue_breakdown).toEqual({ food: 3000 });
    A.expect(A.hasText("dcDateMovedFrom")).toBe(true);
    A.expect(A.hasText("dcDateMovedOldHolds")).toBe(false);
  }],
  ["finding 2 — the banner's Start forfra, a Z-bon of 2.500 stored over the draft with its answer lost, then Start forfra: the 17.030 draft was gone (sequences lane)", 22002, async (A) => {
    await A.bannerStartOver();
    await A.shoot("t2500");
    A.slow("drop", 2);
    await A.apply("steps");
    A.expect(stored(A.S).revenue_total).toBe(2500);
    await A.toCard();
    await A.startOver();
    await A.settleAll();
    // The draft the owner replaced is back as it was — its figures, photo,
    // note and count — and the banner shows it; never the thrown-away bon.
    A.expect(stored(A.S)).toMatchObject({
      status: "draft", revenue_total: 17030, notes: "Test", closed_by: "Test", cash_counted: 980,
      receipt_photo: "u1/kasserapport/seed-own.jpg",
    });
    A.expect(A.S.posts.some((b) => b.receipt_photo === photoUrl("p1-t2500.jpg"))).toBe(true);
    A.expect(A.hasText("dcDayHasDraftBody:17.030")).toBe(true);
  }, [zbonDraft()]],
  ["finding 3 — a Z-bon of 5.000, \"Brug disse tal\" and \"← Scan Z-bon\" both stored with their answers lost, Start forfra: the thrown-away bon stayed the day's draft (sequences lane)", 22003, async (A) => {
    await A.shoot("b5000");
    A.slow("drop", 2);
    await A.apply("review");
    await A.toCard();
    A.expect(stored(A.S)?.revenue_total).toBe(5000);
    await A.startOver();
    await A.settleAll();
    // The draft this page made for the photo is taken back.
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(A.S.deletes.length).toBe(1);
  }],
  ["finding 3 — one lost answer is enough (\"Fortsæt trin for trin\") (sequences lane)", 22004, async (A) => {
    await A.shoot("b5000");
    A.slow("drop", 1);
    await A.apply("steps");
    await A.toCard();
    await A.startOver();
    await A.settleAll();
    A.expect(stored(A.S)).toBeUndefined();
  }],
  ["finding 4 — another device locks the day while the page is open: the next edit was refused in silence (sequences lane)", 22005, async (A) => {
    await A.continueDraft();
    await A.otherDeviceLocks();
    await A.typeBox("rev", "drinks", "6.000");
    // Said on the wizard, with the amount the lock holds once History has
    // the locked row — never a step counter over edits nobody saves.
    A.expect(A.hasText("dcDayAlreadyLocked")).toBe(true);
    A.expect(A.hasText("dcDayAlreadyLockedBody:14.000")).toBe(true);
    A.expect(stored(A.S)).toMatchObject({ status: "confirmed", revenue_total: 14000 });
  }, [typedDraft()]],
  ["a date move after the banner's Start forfra, the replacing save's answer lost: the replaced draft is back on the old day", 22006, async (A) => {
    await A.bannerStartOver();
    await A.skip();
    A.slow("drop", 1);
    await A.typeBox("rev", "food", "3.000");
    A.expect(stored(A.S).revenue_total).toBe(3000);
    await A.moveDate(A.yesterday);
    await A.settleAll();
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 14000, revenue_breakdown: { food: 9000, drinks: 5000 } });
    A.expect(stored(A.S, `${A.yesterday}|`).revenue_breakdown).toEqual({ food: 3000 });
    A.expect(A.hasText("dcDateMovedKeptOld")).toBe(true);
  }, [typedDraft()]],
  ["a date move whose new day's first save loses its answer: the page asks the server, and the old day's draft still goes", 22007, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    A.slow("drop", 2);
    await A.moveDate(A.yesterday);
    await A.settleAll();
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(stored(A.S, `${A.yesterday}|`).revenue_breakdown).toEqual({ food: 3000 });
    A.expect(A.hasText("dcDateMovedFrom")).toBe(true);
  }],
  ["the draft saved elsewhere, then locked there: \"Hent den nyeste kladde\" says the day is locked (removal audit #11)", 22008, async (A) => {
    await A.continueDraft();
    await A.otherDeviceFigures((r) => { r.notes = "B"; });
    await A.typeBox("rev", "drinks", "1.500");
    A.expect(A.conflictShown()).toBe(true);
    await A.otherDeviceLocks();
    await A.resolveConflict("reload");
    A.expect(A.conflictShown()).toBe(false);
    A.expect(A.hasText("dcDayAlreadyLocked")).toBe(true);
  }, [typedDraft()]],
  ["left with the save stored and its answer lost (a full reload): the next visit opens what is stored and saves on it", 22009, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    await A.leaveDuringSave({ box: ["pay", "card"], value: "2.000", lands: "lost", reload: true });
    A.expect(stored(A.S).payment_breakdown).toEqual({ card: 2000 });
    await A.notes();
    A.expect(A.S.refused.length).toBe(0);
    A.expect(stored(A.S).payment_breakdown).toEqual({ card: 2000 });
    A.expect(stored(A.S).notes).toBeTruthy();
  }],
  ["left inside the app with the save's answer lost: the next visit lists the day as stored", 22010, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    await A.leaveDuringSave({ box: ["pay", "card"], value: "2.000", lands: "lost", reload: false });
    await A.notes();
    A.expect(A.S.refused.length).toBe(0);
    A.expect(stored(A.S).payment_breakdown).toEqual({ card: 2000 });
  }],
];

// Found by this variant while round 22 was built: the lock met while the
// scan card is open, a kept draft another device saved since, a day locked
// elsewhere and then moved from, Start forfra offline.
const FOUND = [
  ["a day locked elsewhere, met by a save while the scan card is open: said on the card (LK)", 9157],
  ["a lost answer's re-send meets another device's lock on the way to the card: said there (LK)", 9204],
  ["Start forfra kept the owner's note over a version another device saved since: the banner shows it (M6)", 9259],
  ["the figures moved off a day another device locked: never \"moved\" (MV)", 9474],
  ["Start forfra OFFLINE over the banner's replaced draft: put back once online — never the thrown-away bon's photo (M4b)", 9293],
];

describe("daily close — round 22 sequences (answers lost, a day locked elsewhere, the fixed failure model)", () => {
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
      await runSequence(seed, { DailyClosePage }, { S, get, post, del }, { variant: "r22", plan });
    }, 30000);
  }
  for (const [what, seed] of FOUND) {
    it(`${what}: seed ${seed}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      await runSequence(seed, { DailyClosePage }, { get, post, del }, { variant: "r22" });
    }, 30000);
  }
  for (let seed = FROM; seed < FROM + COUNT; seed++) {
    it(`seed ${seed}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      await runSequence(seed, { DailyClosePage }, { get, post, del }, { variant: "r22" });
    }, 30000);
  }
  it("checked what it claims", () => {
    if (env.SEQ_FROM) return;
    // The failure classes actually ran (a zero would be a vacuous green).
    expect(STATS.lostAnswers).toBeGreaterThan(0);
    expect(STATS.MVlost).toBeGreaterThan(0);
    expect(STATS.M6lost).toBeGreaterThan(0);
    expect(STATS.LK).toBeGreaterThan(0);
    expect(STATS.offlineSteps).toBeGreaterThan(0);
  });
});
