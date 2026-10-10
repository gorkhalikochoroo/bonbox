/**
 * R-c round 2 fix-up — the round-2 review's sequence-lane findings as
 * fixed-step repros (harness variant "rc2": two accounts on one phone, full
 * reloads and kills, hung and void requests). Each failed on e4febb30:
 *   X1  a move whose answer never came, timed out after logout A → login B,
 *       was sent again on B's session (A's figures in B's books, B's draft on
 *       the old day deleted);
 *   X2  the same with the move that never arrived: done in B's books;
 *   X3  the way-out save waiting behind a slow save went on B's session;
 *   X4  a refusal arriving after the switch kept A's figures as B's copy;
 *   L1  the waiting save met the signed-out session (401): dropped as refused;
 *   L2  a save that timed out after the page was left was kept nowhere;
 *   L3  figures sent on a dead line were kept nowhere after a full reload;
 *   MB1 a move off a day another device locked left the figures on both days.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock("../services/api", () => {
  const gen = (globalThis.__seqGen = (globalThis.__seqGen || 0) + 1);
  const w = (fn) => (...a) => { const prev = globalThis.__seqSender; globalThis.__seqSender = gen; try { return fn(...a); } finally { globalThis.__seqSender = prev; } };
  return { default: { get: w((...a) => get(...a)), post: w((...a) => post(...a)), patch: vi.fn(), delete: w((...a) => del(...a)) } };
});
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: globalThis.__seqUser || { id: "acctA", currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
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

const { runSequence, createServer } = await import("../test/closeSequenceHarness");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;
const { businessTodayIso } = await import("../utils/dateFormat");
const { DEFAULT_CLOSE_CUTOFF_HOUR } = await import("../utils/dailyCloseDay");
const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const twoDaysAgo = (() => { const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() - 2); return d.toISOString().slice(0, 10); })();

const base = async (A) => {
  await A.skip();
  await A.typeBox("rev", "food", "3.000");
  await A.typeBox("pay", "card", "3.000");
};
const PLANS = [
  // RC2-X1: a move whose answer never comes (a hung request, timed out later)
  // — the page left, B signed in on the same phone: the page sends A's move
  // again on B's session.
  ["X1 a move timed out after logout A → login B is sent again on B's session", async (A) => {
    await base(A);
    const r = A.rc2;
    await r.inFlight("move", "hang", { to: A.twoDaysAgo });
    await r.logout("A");
    await r.login("B");
    await r.release();
    r.checkAccounts("B's visit");
  }],
  // RC2-X2: the same with the move's request never arriving (timeout): A's
  // move done in B's books.
  ["X2 a move that never arrived, timed out after login B, is done in B's books", async (A) => {
    await base(A);
    const r = A.rc2;
    await r.inFlight("move", "void", { to: A.twoDaysAgo });
    await r.logout("A");
    await r.login("B");
    await r.release();
    r.checkAccounts("B's visit");
  }],
  // RC2-X3: a slow save, an edit waiting behind it, logout, B signs in: the
  // waiting edit (the way-out flush waits for the slow save, up to 12 s) goes
  // on B's session — A's figures written over B's draft.
  ["X3 the way-out save waiting behind a slow save goes on B's session", async (A) => {
    await base(A);
    const r = A.rc2;
    await r.inFlight("type", "post", { box: ["pay", "cash"], value: "750" });
    await r.inFlight("type", "debounce", { box: ["rev", "drinks"], value: "5.000" });
    await r.logout("A");
    await r.login("B");
    await r.release();
    r.checkAccounts("B's visit");
  }],
  // RC2-X4 (review, attacker lens): a late refusal after the account
  // changed — A's save on its way, another device saves A's day meanwhile,
  // A signs out and B signs in, then A's save is refused (412): A's gone
  // form keeps the refused figures as a copy — A's, never stamped as B's
  // (B's page showed A's revenue as B's own failed copy, one tap from B's
  // books).
  ["X4 a refusal arriving after logout A → login B keeps A's figures as A's copy, never B's", async (A) => {
    await base(A);
    const r = A.rc2;
    await r.inFlight("type", "post", { box: ["rev", "drinks"], value: "6.000" });
    A.S.otherSave(`${A.today}|`, (row) => { row.notes = "other device"; }, { saveId: "other-device" });
    await r.logout("A");
    await r.login("B");
    await r.release();
    r.checkAccounts("B's visit");
    const mine = r.queueItems().filter((it) => it.payload?.revenue_breakdown?.drinks === 6000);
    A.expect(mine.length).toBeGreaterThan(0);
    A.expect(mine.every((it) => it.account === "acctA")).toBe(true);
  }],
  // RC2-L1: the same, signed out (no B): the waiting edit gets 401 and is gone.
  ["L1 the way-out save waiting behind a slow save is lost when it meets the signed-out session", async (A) => {
    await base(A);
    const r = A.rc2;
    const s0 = r.sent();
    await r.inFlight("type", "post", { box: ["pay", "cash"], value: "750" });
    await r.inFlight("type", "debounce", { box: ["rev", "drinks"], value: "5.000" });
    await r.logout("A");
    await r.release();
    const upto = r.sent();
    await r.login("A");
    await r.goOnline();
    await r.release();
    r.checkKept(s0, upto, "logout with a slow save + a waiting edit, then A back");
  }],
  // RC2-L2 (pre-existing class): a save that hangs and times out after the
  // page was left (in the app) is kept nowhere.
  ["L2 a save that times out after the page was left is kept nowhere", async (A) => {
    await base(A);
    const r = A.rc2;
    const s0 = r.sent();
    await r.inFlight("type", "void", { box: ["rev", "drinks"], value: "5.000" });
    await r.logout("A");
    await r.login("A");
    await r.release();
    const upto = r.sent();
    await r.goOnline();
    await r.release();
    r.checkKept(s0, upto, "a hung save timed out after the page was left");
  }],
  // RC2-L3 (pre-existing class): a dead line (no answer, the browser online),
  // then a full reload: the figures sent are kept nowhere.
  ["L3 figures sent on a dead line are kept nowhere after a reload", async (A) => {
    await base(A);
    const r = A.rc2;
    const s0 = r.sent();
    await r.inFlight("type", "dead", { box: ["rev", "drinks"], value: "5.000" });
    const upto = r.sent();
    await r.reload(false);
    await r.release();
    r.checkKept(s0, upto, "a dead line, then a full reload");
  }],
  // RC2-MB1: a move off a day another device locked: the new day gets the
  // figures and the locked day keeps them — on both days (the page says
  // "Kopieret til … — … er låst og står uændret").
  ["MB1 a move off a day locked on another device leaves the figures on both days", async (A) => {
    await base(A);
    await A.otherDeviceLocks();
    await A.moveDate(A.yesterday, "yes");
    await A.arriveAll();
    await A.settleAll();
    const t = A.S.rows.get(`${A.today}|`);
    const y = A.S.rows.get(`${A.yesterday}|`);
    A.expect({ today: (t && { status: t.status, revenue_total: t.revenue_total }) ?? null, yesterday: (y && { status: y.status, revenue_total: y.revenue_total }) ?? null },
      `figures on both days after a confirmed move: ${JSON.stringify({ today: t?.status, y: y?.status })} — line: ${A.q('[data-testid="dc-date-moved"]')?.textContent}`)
      .toEqual({ today: { status: "confirmed", revenue_total: 3000 }, yesterday: null });
  }],
];

describe("daily close — R-c round 2 sequence lane: fixed-step repros", () => {
  beforeAll(() => {
    window.scrollTo = () => {};
    window.scrollBy = () => {};
    Element.prototype.scrollIntoView = () => {};
    window.confirm = () => true;
    window.URL.createObjectURL = () => "blob:http://localhost/preview";
    window.URL.revokeObjectURL = () => {};
  });
  afterAll(async () => { for (const r of globalThis.__seqSoft || []) console.log(`SOFT ${r.cls} ${r.msg}`); await new Promise((r) => setTimeout(r, 3200)); }, 10000);
  for (const [what, plan] of PLANS) {
    it(what, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      const S = createServer({ rows: [], syncedDates: [twoDaysAgo] });
      await runSequence(1, { DailyClosePage }, { S, get, post, del }, { variant: "rc2", plan });
    }, 60000);
  }
});
