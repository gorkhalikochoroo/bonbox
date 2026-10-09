/**
 * Release R-c — the sequence lane's two remaining move findings (9 Oct,
 * 5,600 biased sequences), as named plans in the r23 harness variant
 * (src/test/closeSequenceHarness.jsx), held after every step to every
 * invariant (MV, MT, D, LK …):
 *   23025  an OFFLINE date move: the old day's own save failed offline (it
 *          is on no server — not a version the form held), and the old day
 *          holds a draft the form never had: once the new day is filed, the
 *          line under the date never says "Flyttet fra" while that draft is
 *          there — "Kopieret til … står der stadig".
 *   23027  the same race the other way round: moved online ("Flyttet fra"),
 *          then another visit's copy of the old day files it — the line
 *          stops saying "Flyttet fra" (MT, every step).
 *   23026  a move off a day another device LOCKED: the line says the day is
 *          locked — never "kladden … står der stadig" (it is no draft); the
 *          harness's MV holds every sequence to it now (MVlocked).
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
vi.mock("../hooks/useConfirm", () => ({
  useConfirm: () => (opts) => Promise.resolve(globalThis.__dcSeqConfirm ? globalThis.__dcSeqConfirm(opts) : true),
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

const { runSequence, createServer, STATS } = await import("../test/closeSequenceHarness");
const { getOfflineQueue } = await import("../utils/dailyCloseQueue");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const key = `${today}|`;
const twoDaysAgo = (() => { const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() - 2); return d.toISOString().slice(0, 10); })();
const stored = (S, k = key) => S.rows.get(k);

const otherVisitCopyOfToday = () => getOfflineQueue().filter((it) => it.payload?.date === today);

const PLANS = [
  ["(a) an OFFLINE move: today's 3.000 never lands and the page is left offline (kept on this phone — the next visit's copy); back, 5.000 typed offline for today and moved to yesterday (asked, answered yes); online — the earlier copy files today, the 5.000 lands on yesterday: the line never says \"Flyttet fra\" while today holds that draft — \"Kopieret … står der stadig\", and nothing of it is deleted (the form never held it)", 23025, async (A) => {
    await A.skip();
    await A.slow("offline", 20);
    await A.typeBox("rev", "food", "3.000");
    A.expect(stored(A.S)).toBeUndefined();
    await A.reopen();
    // The 3.000 is kept on this phone (the queue), to be sent once online.
    A.expect(otherVisitCopyOfToday()).toHaveLength(1);
    if (A.where() === "idle") await A.skip();
    await A.typeBox("rev", "food", "5.000");
    A.expect(stored(A.S)).toBeUndefined();
    await A.moveDate(A.yesterday, "yes");
    A.expect(String(A.dialogs.at(-1)?.title)).toMatch(/dcMoveConfirmTitle/);
    await A.online();
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(stored(A.S, `${A.yesterday}|`)?.revenue_breakdown).toEqual({ food: 5000 });
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_breakdown: { food: 3000 } });
    A.expect(A.hasText("dcDateMovedFrom")).toBe(false);
    A.expect(A.hasText("dcDateMovedCopied:")).toBe(true);
    // Never deleted for the move, and not offered to: a version the form
    // never held (D).
    A.expect(A.S.deletes).toEqual([]);
    A.expect(Boolean(A.findBtn(/^dcDateMovedDeleteOld$/))).toBe(false);
  }],
  ["(a, later) moved online — \"Flyttet fra\" — then another visit's copy of the old day, kept on this phone, files it: the line under the date stops saying \"Flyttet fra\" (MT) and says the draft is there", 23027, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 3000 });
    await A.moveDate(A.yesterday, "yes");
    await A.settleAll();
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(A.hasText("dcDateMovedFrom")).toBe(true);
    await A.queueCopy({ date: A.today, revenue_breakdown: { food: 8000 }, payment_breakdown: { card: 8000 } });
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 8000 });
    A.expect(A.hasText("dcDateMovedFrom")).toBe(false);
    A.expect(A.hasText("dcDateMovedCopied:")).toBe(true);
    A.expect(Boolean(A.findBtn(/^dcDateMovedDeleteOld$/))).toBe(false);
  }],
  ["(b) a move off a day another device LOCKED: 3.000 saved for today, another device locks today, the figures moved to yesterday — the line says today is locked (\"… er låst og står uændret\"), never \"kladden … står der stadig\", and offers no delete", 23026, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 3000 });
    await A.otherDeviceLocks();
    A.expect(stored(A.S).status).toBe("confirmed");
    await A.moveDate(A.yesterday, "yes");
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(stored(A.S, `${A.yesterday}|`)?.revenue_total).toBe(3000);
    A.expect(stored(A.S).status).toBe("confirmed");
    A.expect(A.hasText("dcDateMovedCopiedLocked:")).toBe(true);
    A.expect(A.hasText("dcDateMovedCopied:")).toBe(false);
    A.expect(A.hasText("dcDateMovedMaybeCopied")).toBe(false);
    A.expect(A.hasText("dcDateMovedFrom")).toBe(false);
    A.expect(Boolean(A.findBtn(/^dcDateMovedDeleteOld$/))).toBe(false);
    // The owner goes on on yesterday: its next save is where MV looks again
    // (the locked day is said locked — MVlocked).
    await A.typeBox("pay", "mobilepay", "500");
    A.expect(stored(A.S, `${A.yesterday}|`)?.payment_breakdown?.mobilepay).toBe(500);
    A.expect(A.hasText("dcDateMovedCopiedLocked:")).toBe(true);
  }],
];

describe("daily close — R-c move note (offline move, a day locked elsewhere)", () => {
  beforeAll(() => {
    window.scrollTo = () => {};
    window.scrollBy = () => {};
    Element.prototype.scrollIntoView = () => {};
    window.confirm = () => true;
    window.URL.createObjectURL = () => "blob:http://localhost/preview";
    window.URL.revokeObjectURL = () => {};
  });
  afterAll(async () => {
    await new Promise((r) => setTimeout(r, 3200));
  }, 10000);
  for (const [what, seed, plan, rows = []] of PLANS) {
    it(`${what}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      const S = createServer({ rows: rows.map((r) => ({ ...r })), syncedDates: [twoDaysAgo] });
      await runSequence(seed, { DailyClosePage }, { S, get, post, del }, { variant: "r23", plan });
    }, 30000);
  }
  it("checked what it claims", () => {
    // (The locked branch of MV actually looked.)
    expect(STATS.MVlocked).toBeGreaterThan(0);
    expect(STATS.MT).toBeGreaterThan(0);
  });
});
