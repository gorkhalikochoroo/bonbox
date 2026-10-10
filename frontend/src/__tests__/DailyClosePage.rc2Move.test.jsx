/**
 * R-c round 2 — MONEY BREAK 2 (the sequence lane, 10 Oct): a date move left
 * unfinished by a reload left the figures on BOTH days (counted twice once
 * both were locked). The move was two requests tied together only in page
 * memory — the new day's save, then, from its answer, the old day's delete —
 * and a page gone before the answer never sent the delete.
 *
 * Now a move is ONE request (POST /daily-close/move): the server saves the
 * new day and deletes the old day's draft (on the version the form holds) in
 * one transaction, or does neither; the page keeps each attempt on this phone
 * as ONE queued move, and a page that is gone leaves it to the queue, which
 * sends it again with the same save_id (the server answers a move it already
 * did with what it did — never a second delete).
 *
 * Named plans in the r23 harness variant (every invariant after every step —
 * MV, MT, D, R, I1 …), the harness's stub server doing the move as the
 * backend does (src/test/closeSequenceHarness.jsx, S.moves), and a FULL
 * reload modelled as the backend sees one: the requests already sent still
 * arrive, the page that sent them hears nothing, the next visit starts with
 * only what this phone stored:
 *   24001  M1 — the move's answer late, the page reloads.
 *   24002  M3 — the move itself held on the line, the page reloads.
 *   24003  the move's answer lost (and lost again when sent again): the page
 *          asks the server — the move was done, "Flyttet fra" — and sent it
 *          again as it was (its save_id).
 *   24004  the move dies on a dead line, the page reloads with the line back:
 *          the next visit sends the one queued move.
 *   24005  the move made offline, the page reloaded offline: ONE queued move
 *          (never a save of the new day plus a promised delete); online, done.
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
const { moveRequests } = await import("../test/closeMoveCalls");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const twoDaysAgo = (() => { const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() - 2); return d.toISOString().slice(0, 10); })();
const stored = (S, k = `${today}|`) => S.rows.get(k);
const queuedMoves = () => getOfflineQueue().filter((it) => it.move);

/** Today: Mad 12.000, Kort 12.000 — saved (answered). */
async function twelveSaved(A) {
  await A.skip();
  await A.typeBox("rev", "food", "12.000");
  await A.typeBox("pay", "card", "12.000");
  A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 12000 });
}
/** Once everything has arrived: the figures on ONE day — yesterday — and today's draft gone by one delete. */
function onYesterdayOnly(A) {
  A.expect(stored(A.S, `${A.yesterday}|`)).toMatchObject({ status: "draft", revenue_breakdown: { food: 12000 }, payment_breakdown: { card: 12000 } });
  A.expect(stored(A.S)).toBeUndefined();
  A.expect(A.S.deletes).toHaveLength(1);
  A.expect(getOfflineQueue()).toHaveLength(0);
  // (The day it left says nothing is there.)
  A.expect(A.hasText("dcDayHasDraft")).toBe(false);
}

const PLANS = [
  ["M1 — the move's answer late, the page reloads: the next visit sends the ONE queued move again (its save_id) and the server answers what it did — yesterday holds 12.000, today's draft is gone, never on both days", 24001, async (A) => {
    await twelveSaved(A);
    A.slow("answer", 4);
    await A.moveDate(A.yesterday, "yes");
    A.expect(String(A.dialogs.at(-1)?.message)).toMatch(/dcMoveConfirmBody:/);
    // One request: on the server already (it is the answer that is late) …
    A.expect(stored(A.S, `${A.yesterday}|`)?.revenue_total).toBe(12000);
    A.expect(stored(A.S)).toBeUndefined();
    // … and kept on this phone as ONE queued move until it is answered.
    A.expect(queuedMoves()).toHaveLength(1);
    A.expect(getOfflineQueue()).toHaveLength(1);
    await A.reload();
    await A.arriveAll();
    await A.online();
    await A.settleAll();
    await A.step("look again", () => {});
    onYesterdayOnly(A);
    // Sent again with the same save_id: answered, nothing deleted twice.
    const ids = moveRequests(post.mock.calls).map((r) => r.save_id);
    A.expect(ids.length).toBeGreaterThanOrEqual(2);
    A.expect(new Set(ids).size).toBe(1);
  }],
  ["M3 — the move held on the line, the page reloads: the next visit sends the ONE queued move; the held one lands, the second is answered with what it did — yesterday holds 12.000, today's draft is gone", 24002, async (A) => {
    await twelveSaved(A);
    A.slow("post", 4);
    await A.moveDate(A.yesterday, "yes");
    // Nothing has arrived yet: both days as they were.
    A.expect(stored(A.S, `${A.yesterday}|`)).toBeUndefined();
    A.expect(stored(A.S)).toMatchObject({ revenue_total: 12000 });
    A.expect(queuedMoves()).toHaveLength(1);
    await A.reload();
    // The next visit: the queued move is the queue's now (shown, and sent).
    A.expect(queuedMoves()).toHaveLength(1);
    await A.arriveAll();
    await A.online();
    await A.settleAll();
    await A.step("look again", () => {});
    onYesterdayOnly(A);
    const ids = moveRequests(post.mock.calls).map((r) => r.save_id);
    A.expect(ids.length).toBeGreaterThanOrEqual(2);
    A.expect(new Set(ids).size).toBe(1);
    A.expect(STATS.moveReplays).toBeGreaterThan(0);
  }],
  ["the move's answer lost (and lost again when it is sent again): the page asks the server — the move was done — \"Flyttet fra\", today's draft gone by ONE delete, and the move was sent again as it was (its save_id)", 24003, async (A) => {
    await twelveSaved(A);
    A.slow("drop", 1);
    await A.moveDate(A.yesterday, "yes");
    await A.online();
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(stored(A.S, `${A.yesterday}|`)?.revenue_breakdown).toEqual({ food: 12000 });
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(A.S.deletes).toHaveLength(1);
    A.expect(A.hasText("dcDateMovedFrom")).toBe(true);
    A.expect(getOfflineQueue()).toHaveLength(0);
    const ids = moveRequests(post.mock.calls).map((r) => r.save_id);
    A.expect(ids.length).toBeGreaterThanOrEqual(2);
    A.expect(new Set(ids).size).toBe(1);
    A.expect(del).not.toHaveBeenCalled();
  }],
  ["the move dies on a dead line (\"Ikke gemt for i går endnu — intet er slettet\"), then the page reloads with the line back: the next visit sends the ONE queued move — yesterday holds 12.000, today's draft is gone", 24004, async (A) => {
    await twelveSaved(A);
    A.slow("dead", 4);
    await A.moveDate(A.yesterday, "yes");
    A.expect(stored(A.S, `${A.yesterday}|`)).toBeUndefined();
    A.expect(stored(A.S)).toMatchObject({ revenue_total: 12000 });
    A.expect(A.hasText("dcDateMovedNotSavedYet")).toBe(true);
    A.expect(queuedMoves()).toHaveLength(1);
    // The line is back (no "online" event), and the page reloads.
    A.S.holding.dead = false;
    await A.reload();
    await A.settleAll();
    await A.online();
    await A.settleAll();
    await A.step("look again", () => {});
    onYesterdayOnly(A);
  }],
  ["the move made OFFLINE, the page reloaded offline: this phone holds ONE queued move (never a save of yesterday plus a promised delete); online again it is done whole — yesterday holds 12.000, today's draft is gone", 24005, async (A) => {
    await twelveSaved(A);
    await A.slow("offline", 6);
    await A.moveDate(A.yesterday, "yes");
    A.expect(A.hasText("dcDateMovedNotSavedYet")).toBe(true);
    A.expect(A.hasText("dcDateMovedFrom")).toBe(false);
    await A.reload();
    A.expect(getOfflineQueue()).toHaveLength(1);
    A.expect(queuedMoves()[0]).toMatchObject({ payload: { date: A.yesterday }, move: { from_date: A.today } });
    A.expect(stored(A.S)).toMatchObject({ revenue_total: 12000 });
    await A.online();
    await A.settleAll();
    await A.step("look again", () => {});
    onYesterdayOnly(A);
  }],
];

describe("daily close — R-c round 2: a date move is one request, kept as one queued move", () => {
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
    expect(STATS.moves).toBeGreaterThan(0);
    expect(STATS.moveReplays).toBeGreaterThan(0);
    expect(STATS.reloads).toBeGreaterThan(0);
    // (The line under the date held to MT: "Flyttet fra" only where no draft is left.)
    expect(STATS.MT).toBeGreaterThan(0);
  });
});
