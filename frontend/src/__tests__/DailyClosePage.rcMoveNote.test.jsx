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
 *   23026  a move off a day another device LOCKED. R-c round 2 fix-up (MB —
 *          CONTRACT CHANGE, listed as a narrowing): the server refuses the
 *          whole move (409 old_day_locked) — it used to file the figures on
 *          the new day beside the locked day ("Kopieret til … — … er låst og
 *          står uændret"), the same figures on both days. The page is back
 *          on the locked day and says so ("… er låst på en anden enhed —
 *          intet er flyttet"); the harness's MV holds every sequence to it
 *          (MVlocked).
 * R-c review (10 Oct):
 *   23028  figures typed on a dead line for a day the form then let go of
 *          ("Hent {dag}s salg"), the day's stored draft continued from its
 *          banner: they are never dropped unasked — kept on this phone as a
 *          copy ("Din kopi: 12.000 kr.", "Gem kopien … i stedet").
 *   23029  the same with the banner's Start forfra.
 *   23030  a move answered "Flyt tallene" whose new day's save died on a dead
 *          line, then "Hent {dag}s salg" from the new day: once the line is
 *          back and the new day's figures land, the old day's draft goes —
 *          the figures are never counted on both days.
 *   23031  a save refused (saved on another device), then that device LOCKS
 *          the day, History read again: "Hent den nyeste kladde" says the
 *          day is locked — never opens it as a draft with "Bekræft og lås".
 */
import { fireEvent } from "@testing-library/react";
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
const { getOfflineQueue, QUEUE_FAILED, QUEUE_ERR_DRAFT_CHANGED } = await import("../utils/dailyCloseQueue");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const key = `${today}|`;
const twoDaysAgo = (() => { const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() - 2); return d.toISOString().slice(0, 10); })();
const stored = (S, k = key) => S.rows.get(k);

const otherVisitCopyOfToday = () => getOfflineQueue().filter((it) => it.payload?.date === today);
// Back on today from another day with nothing of the owner's on the form (no
// question): the step itself, so what the page shows is looked at first.
async function backToToday(A) {
  const el = A.q("#close-date");
  const asked = A.dialogs.length;
  await A.step(`date → ${A.today} (nothing typed)`, async () => {
    fireEvent.change(el, { target: { value: A.today } });
    for (let i = 0; i < 4; i++) await A.settle();
  });
  A.expect(A.dialogs.length).toBe(asked);
  A.expect(A.q("#close-date").value).toBe(A.today);
}
// Today's 10.000 stored; 12.000 typed over it on a dead line (stored nowhere);
// "Hent {dag}s salg" to the day before yesterday; back on today — the banner
// names the stored 10.000. The line is still dead.
async function twelveUnsentLetGo(A) {
  await A.skip();
  await A.typeBox("rev", "food", "10.000");
  A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 10000 });
  A.slow("dead", 12);
  await A.typeBox("rev", "food", "12.000");
  A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 10000 });
  await A.moveDate(A.twoDaysAgo, "extra");
  A.expect(A.q("#close-date").value).toBe(A.twoDaysAgo);
  await backToToday(A);
  A.expect(A.hasText("dcDayHasDraftBody:10.000")).toBe(true);
}
const twelveCopy = () => getOfflineQueue().find((it) => it.payload?.date === today && it.payload?.revenue_breakdown?.food === 12000);

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
  ["(b) a move off a day another device LOCKED: 3.000 saved for today, another device locks today, the figures moved to yesterday — R-c round 2 fix-up (MB): the whole move is refused, nothing is filed on yesterday (the figures were on both days), the page is back on today and says today is locked and nothing was moved — never \"kladden … står der stadig\", no delete", 23026, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 3000 });
    await A.otherDeviceLocks();
    A.expect(stored(A.S).status).toBe("confirmed");
    await A.moveDate(A.yesterday, "yes");
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(stored(A.S, `${A.yesterday}|`)).toBeUndefined();
    A.expect(stored(A.S)).toMatchObject({ status: "confirmed", revenue_total: 3000 });
    A.expect(A.q("#close-date").value).toBe(A.today);
    A.expect(A.hasText("dcDateMoveRefusedLocked:")).toBe(true);
    A.expect(A.hasText("dcDateMovedCopiedLocked")).toBe(false);
    A.expect(A.hasText("dcDateMovedCopied:")).toBe(false);
    A.expect(A.hasText("dcDateMovedMaybeCopied")).toBe(false);
    A.expect(A.hasText("dcDateMovedFrom")).toBe(false);
    A.expect(Boolean(A.findBtn(/^dcDateMovedDeleteOld$/))).toBe(false);
    // Today is the locked day it is: said so, never offered as a draft.
    A.expect(A.hasText("dcDayAlreadyLocked")).toBe(true);
  }],
  // R-c review (10 Oct).
  ["(review 1) today's 10.000 saved, 12.000 typed over it on a dead line, \"Hent {dag}s salg\", back on today and the banner's \"Fortsæt kladden\" on the 10.000: the unsent 12.000 is never dropped unasked — kept on this phone as a copy that says what it holds, stored over the 10.000 only by its own tap", 23028, async (A) => {
    await twelveUnsentLetGo(A);
    await A.continueDraft();
    await A.online();
    await A.settleAll();
    await A.step("look again", () => {});
    // Continued: the stored draft stays as it was (never sent over by itself)…
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 10000 });
    // …and the 12.000 is on this phone, said as what it is.
    A.expect(twelveCopy()).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED });
    A.expect(A.hasText("dcQueueCopyHolds:12.000")).toBe(true);
    A.expect(A.hasText("dcQueueErrLetGo")).toBe(true);
    const b = A.findBtn(/^dcQueueKeepCopyInstead:12\.000/);
    A.expect(Boolean(b)).toBe(true);
    // Its tap stores it (by choice). (The wizard does not follow a copy
    // stored from the strip — R-c's two-questions design: the form keeps
    // what it opened, and its next save is asked about, never stored over
    // the copy.)
    fireEvent.click(b);
    for (let i = 0; i < 6; i++) await A.settle();
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 12000 });
    A.expect(getOfflineQueue().some((it) => it.payload?.date === A.today)).toBe(false);
    await A.typeBox("pay", "card", "500");
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 12000 });
    A.expect(A.conflictShown()).toBe(true);
    await A.resolveConflict("reload");
    A.expect(await A.toStep("s1")).toBe(true);
    A.expect(A.q("#dc-rev-food")?.value || "").toMatch(/^12[.]?000/);
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 12000 });
  }],
  ["(review 1, Start forfra) the same, then the banner's \"Start forfra\" (the 10.000 deleted, as asked): the unsent 12.000 the question never named is kept on this phone as a copy, never dropped unseen", 23029, async (A) => {
    await twelveUnsentLetGo(A);
    await A.bannerStartOver();
    // The question named the stored 10.000 — the draft it deletes.
    A.expect(String(A.dialogs.at(-1)?.message)).toMatch(/dcStartOverDeleteBody:.*10\.000/);
    await A.online();
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(twelveCopy()).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED });
    A.expect(A.hasText("dcQueueCopyHolds:12.000")).toBe(true);
    // (Never sent by itself.)
    await A.settleAll();
    A.expect(stored(A.S)).toBeUndefined();
  }],
  ["(review 2) 3.000 saved for today, moved to yesterday answered \"Flyt tallene\", yesterday's save dies on a dead line, \"Hent {dag}s salg\" from yesterday to the day before yesterday, the line back: once yesterday holds the 3.000 today's draft is gone — never on both days", 23030, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 3000 });
    A.slow("dead", 12);
    await A.moveDate(A.yesterday, "yes");
    A.expect(String(A.dialogs.at(-1)?.message)).toMatch(/dcMoveConfirmBody:/);
    A.expect(A.q("#close-date").value).toBe(A.yesterday);
    A.expect(stored(A.S, `${A.yesterday}|`)).toBeUndefined();
    await A.moveDate(A.twoDaysAgo, "extra");
    A.expect(A.q("#close-date").value).toBe(A.twoDaysAgo);
    await A.online();
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(stored(A.S, `${A.yesterday}|`)?.revenue_breakdown).toEqual({ food: 3000 });
    A.expect(stored(A.S)).toBeUndefined();
    // Deleted on the version this form held (its own 3.000).
    A.expect(A.S.deletes.length).toBe(1);
  }],
  ["(review 3) a save refused (another device saved today), then that device LOCKS today and History is read again: \"Hent den nyeste kladde\" says today is locked — never opens it as a draft to \"Bekræft og lås\"", 23031, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 3000 });
    await A.otherDeviceFigures(null, { saveId: "other-device" });
    await A.typeBox("rev", "drinks", "500");
    A.expect(A.conflictShown()).toBe(true);
    await A.otherDeviceLocks();
    A.expect(stored(A.S).status).toBe("confirmed");
    await A.online();
    await A.settleAll();
    A.expect(A.conflictShown()).toBe(true);
    await A.resolveConflict("reload");
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(A.hasText("dcDayAlreadyLocked")).toBe(true);
    A.expect(A.hasText("confirmAndLock")).toBe(false);
    A.expect(stored(A.S)).toMatchObject({ status: "confirmed", revenue_breakdown: { food: 3000 } });
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
