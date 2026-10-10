/**
 * R-c round 2 — MONEY BREAK 1 (the sequence lane, 10 Oct; random seed 606097,
 * fixed-step plans P1 / P3; the move seeds 606039 / 608032 / 602120): after a
 * reload during a save, the earlier visit's draft (12.000) lands AFTER the new
 * visit listed the day, so the new visit opens an empty day. A save of the
 * new visit's figures is then refused (412 — "Kladden er gemt et andet
 * sted — 12.000"), and Start forfra / the move question ignored that stored
 * draft: Start forfra emptied the screen with no question (P3) or after
 * naming only the refused 3.000 (P1) — the 12.000 stayed stored with nothing
 * on screen saying so; the move said "Intet er gemt for {dag} endnu" while the
 * day held the 12.000, and left it there unsaid.
 *
 * Now a refusal's stored draft IS the day's stored draft: named in the Start
 * forfra question ("Kladden … med 12.000 kr. slettes") and deleted on exactly
 * that version on "Ja"; named in the move question ("Kladden for {dag}
 * slettes") and deleted by the move on that version. A draft the form never
 * held and never named is never deleted — after a reset the page reads the
 * day from the server and the day's banner shows it ("Der er allerede en
 * kladde …"), with why it was not deleted.
 *
 * Named plans in the r23 harness variant (every invariant after every step —
 * M6, MV, MT, D, R …), the reload as the backend sees one (the page that sent
 * the save hears nothing; the next visit starts with what this phone stored).
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
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const twoDaysAgo = (() => { const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() - 2); return d.toISOString().slice(0, 10); })();
const stored = (S, k = `${today}|`) => S.rows.get(k);

/**
 * Kontant 12.000 typed; while its save is on its way the page reloads; the
 * new visit lists the day first (empty — the scan start, no banner), then the
 * 12.000 lands: today holds a draft this visit never had.
 */
async function reloadedDuringTwelve(A) {
  await A.skip();
  A.slow("post", 1);
  await A.typeBox("pay", "cash", "12.000");
  A.expect(stored(A.S)).toBeUndefined();
  await A.reload();
  A.expect(A.where()).toBe("idle");
  A.expect(A.hasText("dcDayHasDraft")).toBe(false);
  // (Lands now — the new visit is not told: History stays as it was read.)
  await A.arriveAll();
  A.expect(stored(A.S)).toMatchObject({ status: "draft", payment_breakdown: { cash: 12000 } });
  A.expect(A.hasText("dcDayHasDraft")).toBe(false);
}
/** A Z-bon of 3.000, "Fortsæt trin for trin": its save is refused — the box names the stored 12.000. */
async function threeRefused(A) {
  await A.shoot("b3000");
  await A.apply("steps");
  A.expect(A.conflictShown()).toBe(true);
  A.expect(A.hasText("12.000")).toBe(true);
  A.expect(stored(A.S)).toMatchObject({ payment_breakdown: { cash: 12000 } });
}

const PLANS = [
  ["P1 — after the reload, a Z-bon of 3.000 applied and Start forfra tapped while its save is still on its way: the question names the 3.000 it knows of; the save is then refused over the stored 12.000 — never deleted (never named), and never emptied away unsaid: the day's banner shows the 12.000 with why it is still there", 25001, async (A) => {
    await reloadedDuringTwelve(A);
    await A.shoot("b3000");
    A.slow("post", 2);
    await A.apply("steps");
    A.expect(A.S.held.length).toBeGreaterThan(0);
    A.expect(await A.toCard()).toBe(true);
    await A.startOver();
    A.expect(String(A.dialogs.at(-1)?.message)).toMatch(/^dcStartOverDeleteBody:.*3\.000/);
    await A.online();
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(stored(A.S)).toMatchObject({ status: "draft", payment_breakdown: { cash: 12000 } });
    A.expect(A.S.deletes).toEqual([]);
    A.expect(A.hasText("dcDayHasDraft")).toBe(true);
    // ("Ikke slettet — der er gemt en anden kladde for dagen (kun betalinger på 12.000 kr.) …")
    A.expect(document.body.textContent).toMatch(/dcStartOverNotDeletedOther:[^|]*12\.000/);
  }],
  ["P3 — after the reload, the 3.000 refused first (\"Kladden er gemt et andet sted — 12.000 kr.\" on screen), then \"← Scan Z-bon\" and Start forfra: the question names the stored 12.000, and \"Ja\" deletes exactly that version — the day starts over empty", 25002, async (A) => {
    await reloadedDuringTwelve(A);
    await threeRefused(A);
    A.expect(await A.toCard()).toBe(true);
    await A.startOver();
    A.expect(String(A.dialogs.at(-1)?.message)).toMatch(/^dcStartOverDeleteBody:.*12\.000/);
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(A.S.deletes).toHaveLength(1);
    A.expect(A.where()).toBe("idle");
    A.expect(A.hasText("dcDayHasDraft")).toBe(false);
  }],
  ["P3, answered no: nothing is deleted and the refusal's box still names the 12.000", 25003, async (A) => {
    await reloadedDuringTwelve(A);
    await threeRefused(A);
    A.expect(await A.toCard()).toBe(true);
    A.answerNext(false);
    await A.step("Start forfra — no", async () => {
      const b = A.findBtn(/^startOver$/);
      A.expect(Boolean(b)).toBe(true);
      const { fireEvent } = await import("@testing-library/react");
      fireEvent.click(b);
      for (let i = 0; i < 6; i++) await A.settle();
    });
    A.expect(String(A.dialogs.at(-1)?.message)).toMatch(/^dcStartOverDeleteBody:.*12\.000/);
    A.expect(stored(A.S)).toMatchObject({ payment_breakdown: { cash: 12000 } });
    A.expect(A.S.deletes).toEqual([]);
  }],
  ["move (seeds 606039 / 608032 / 602120) — after the reload, the 3.000 refused over the stored 12.000, the figures moved to yesterday: the question names today's draft (\"Kladden for … slettes\", never \"Intet er gemt\"), and the move deletes exactly that version — the figures on ONE day", 25004, async (A) => {
    await reloadedDuringTwelve(A);
    await threeRefused(A);
    await A.moveDate(A.yesterday, "yes");
    const asked = String(A.dialogs.at(-1)?.message);
    A.expect(asked).toMatch(/^dcMoveConfirmBody:/);
    A.expect(asked).not.toMatch(/dcMoveConfirmBodyNothing/);
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(stored(A.S, `${A.yesterday}|`)).toMatchObject({ status: "draft", revenue_total: 3000 });
    A.expect(A.S.deletes).toHaveLength(1);
    A.expect(A.hasText("dcDateMovedFrom")).toBe(true);
  }],
  ["move — the refusal comes only AFTER the move question (it said \"Intet er gemt\"): the stored 12.000 was never named, so it is never deleted — and the line says it is still there, never \"Flyttet fra\"", 25005, async (A) => {
    await reloadedDuringTwelve(A);
    await A.shoot("b3000");
    A.slow("post", 2);
    await A.apply("steps");
    A.expect(A.S.held.length).toBeGreaterThan(0);
    await A.moveDate(A.yesterday, "yes");
    await A.arriveAll();
    await A.online();
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(stored(A.S)).toMatchObject({ status: "draft", payment_breakdown: { cash: 12000 } });
    A.expect(stored(A.S, `${A.yesterday}|`)).toMatchObject({ revenue_total: 3000 });
    A.expect(A.S.deletes).toEqual([]);
    A.expect(A.hasText("dcDateMovedFrom")).toBe(false);
    A.expect(A.hasText("dcDateMovedCopied:")).toBe(true);
  }],
];

describe("daily close — R-c round 2: a draft a refusal named is the day's stored draft", () => {
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
  for (const [what, seed, plan] of PLANS) {
    it(`${what}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      const S = createServer({ rows: [], syncedDates: [twoDaysAgo] });
      await runSequence(seed, { DailyClosePage }, { S, get, post, del }, { variant: "r23", plan });
    }, 30000);
  }
  it("checked what it claims", () => {
    expect(STATS.reloads).toBeGreaterThan(0);
    expect(STATS.M6).toBeGreaterThan(0);
    expect(STATS.conflicts + STATS.M6failed).toBeGreaterThan(0);
  });
});
