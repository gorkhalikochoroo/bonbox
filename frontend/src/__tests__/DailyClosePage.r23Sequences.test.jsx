/**
 * Round 23 — the sequence harness in its "r23" variant
 * (src/test/closeSequenceHarness.jsx) over the SIMPLIFIED model the owner
 * chose (9 Oct): Start forfra is a confirmed, version-checked server delete
 * of the day's draft and the form starts over empty; no scan while offline;
 * a date move with figures is asked first ("Flyt tallene til {to}? Kladden
 * for {from} slettes." — yes / no / "Hent {dag}s salg"). The same failure
 * model as round 22 — slow and reordered saves, answers late or LOST, the
 * page left and opened again, another device saving or locking the day,
 * offline (now and then for several steps) — plus a scan whose connection
 * drops while it is read, and the page's questions answered at random. Held
 * after every step to every invariant (I1–I7, M4, M4b, F1, F4, F6, R, LK)
 * and to the round's own:
 *   M6  stored rows == what the owner last saw or chose: a Start forfra
 *       answered yes leaves no draft of the page's (the question named
 *       exactly the amount deleted), or the newer version from elsewhere is
 *       kept and shown, or "not deleted" is said and nothing changed;
 *   MV  a day reported moved is not on the old date ("Kopieret til … står
 *       der stadig" when it is); answered no, nothing moves;
 *   B   offline, nothing is scanned and nothing changes, and the page says why.
 *
 * Named regressions — the round-22 reviewers' repros (sequences lane, T1,
 * T13, T2), rewritten for the new UI where the path itself is gone (said per
 * plan): 23001–23004; and the narrowings' own paths: 23005–23008. The
 * reviewers' biased seeds (80263, 80294, 80309, 80787, 80961, 80221) were
 * built on their private plan API, not this harness, so they cannot be
 * replayed by number: their scripts are 23001–23004. The round-23 review's
 * repros: 23009 / 23010 (Start forfra after a lost save never deletes a draft
 * written with no save id, or whose writer could not be checked) and 23011 /
 * 23013 (a move's "Slet den" only once the new day holds the figures);
 * 23006 rewritten (an offline move says "Ikke gemt for {to} endnu").
 * The round-23 fix-up: 23014 / 23015 (two devices + a lost answer — the
 * re-send, once online and on leaving, is on the form's own version and is
 * refused over the other phone's newer draft: asked, or kept as a failed copy).
 * The re-send review: 23016 / 23018 / 23019 (a re-send refused while the form
 * is on another day is kept as a failed copy — or, on the form's own version,
 * sent again — never the figures a move took elsewhere) and 23017 ("Behold
 * mine tal" on the scan card sends the refused figures).
 * Round 23 R-c (the re-rate's sequences finding): 23020 / 23021 — after
 * "Hent {dag}s salg" the day left behind is not the form's: back on it, its
 * stored draft is said before any typing and nothing is saved over it; a
 * move of other figures onto it is asked "{dag} har allerede en kladde" —
 * and 23022, the same with the old day's answer lost.
 * The R-c review's probes: 23023 (a save of the day let go of, still on its
 * way, then "Flyt tallene": the day goes in the move — named, and its draft
 * deleted once the new day holds the figures; never on both days — MV now
 * also looks when the step's saves were still on their way, and at a day the
 * question said holds nothing) and 23024 (figures of the day let go of that
 * are on no server are kept on this phone as a copy, said as such, never
 * dropped by the next save of the boxes).
 * Replay one: SEQ_FROM=<seed> SEQ_COUNT=1 npx vitest run src/__tests__/DailyClosePage.r23Sequences.test.jsx
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
// The page's questions (useConfirm) are answered by the harness like the
// owner (closeSequenceHarness: __dcSeqConfirm).
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

const { runSequence, createServer, STATS, NO_ROW_BASE } = await import("../test/closeSequenceHarness");
const { getOfflineQueue, QUEUE_FAILED, QUEUE_ERR_DRAFT_CHANGED } = await import("../utils/dailyCloseQueue");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const env = globalThis.process?.env || {};
const FROM = Number(env.SEQ_FROM || 10001);
const COUNT = Number(env.SEQ_COUNT || 150);
const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const key = `${today}|`;
const twoDaysAgo = (() => { const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() - 2); return d.toISOString().slice(0, 10); })();

const stored = (S, k = key) => S.rows.get(k);
const draft = (extra = {}) => ({
  id: "seed1", date: today, branch_id: null, status: "draft",
  revenue_total: 14000, revenue_breakdown: { food: 9000, drinks: 5000 }, payment_breakdown: { card: 14000 },
  moms_mode: "auto", moms_total: 2800, source_meta: { kind: "typed" }, closed_by: null, notes: null,
  ...extra,
});
// Round 23 fix-up — this phone's first save of today (3.000) is stored with
// its answer lost; another phone saves the day over it; the line dies (the
// form's re-sends die with it) and another visit's queued copy of yesterday
// syncs — History is read again and lists the other phone's version.
const lostThenOtherListed = async (A) => {
  await A.skip();
  A.S.holding.drop = true;
  await A.typeBox("rev", "food", "3.000");
  A.S.holding.drop = false;
  A.expect(A.S.lostKeys.has(key)).toBe(true);
  A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 3000 });
  A.S.holding.dead = true;
  await A.otherDeviceFigures(null, { saveId: "other-device" });
  await A.queueCopy({ date: A.yesterday, revenue_breakdown: { food: 1000 }, payment_breakdown: { card: 1000 } });
  A.expect(stored(A.S, `${A.yesterday}|`)).toMatchObject({ revenue_total: 1000 });
  A.expect(A.hasText("dcDayHasDraft")).toBe(true);
  otherPhoneKept(A);
};
const otherPhoneKept = (A) => {
  A.expect(stored(A.S)).toMatchObject({ status: "draft", notes: "B" });
  A.expect(stored(A.S).payment_breakdown.mobilepay).toBe(99);
};
// Round 23 re-send review — 3.000 stored with its answer lost, then
// Drikkevarer 500 typed on a dead line (never stored: the form's re-sends die
// with it), and another phone saves the day over the 3.000: the owner's
// 3.000 + 500 is on no server — only in the form's re-send.
const lostDeadThenOther = async (A) => {
  await A.skip();
  A.S.holding.drop = true;
  await A.typeBox("rev", "food", "3.000");
  A.S.holding.drop = false;
  A.expect(A.S.lostKeys.has(key)).toBe(true);
  A.slow("dead", 8);
  await A.typeBox("rev", "drinks", "500");
  A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 3000 });
  await A.otherDeviceFigures(null, { saveId: "other-device" });
  otherPhoneKept(A);
};
const payOnlyDraft = () => draft({
  revenue_total: 0, revenue_breakdown: {}, payment_breakdown: { mobilepay: 1234.5 }, moms_total: 0, payment_total: 1234.5,
});

// [name, seed, plan, server rows]
const PLANS = [
  ["T1 (round-22 sequences finding 1; rewritten — \"← Scan Z-bon\" is gray offline now): a Z-bon of 5.000 applied, offline, Takeaway 5.000 typed — the scan card cannot be reached offline and says why; online again the typed 5.000 is sent (10.000 stored)", 23001, async (A) => {
    await A.shoot("b5000");
    await A.apply("steps");
    A.expect(stored(A.S).revenue_total).toBe(5000);
    await A.slow("offline", 3);
    await A.typeBox("rev", "takeaway", "5.000");
    // Offline: "← Scan Z-bon" is gray with its reason (toCard checks B).
    A.expect(await A.toCard()).toBe(false);
    A.expect(A.hasText("dcScanNeedsInternet")).toBe(true);
    await A.online();
    await A.settleAll();
    A.expect(stored(A.S).revenue_total).toBe(10000);
    A.expect(stored(A.S).revenue_breakdown.takeaway).toBe(5000);
  }],
  ["T13a (round-22 sequences finding 2): a payments-only draft continued, emptied, a total-only Z-bon applied, Start forfra — asked, naming the bon's 2.500; the draft is deleted and the page starts empty (the thrown-away bon is never the stored draft)", 23002, async (A) => {
    await A.continueDraft();
    await A.typeBox("pay", "mobilepay", "");
    await A.toCard();
    await A.shoot("t2500");
    await A.apply("steps");
    A.expect(stored(A.S).revenue_total).toBe(2500);
    await A.toCard();
    await A.startOver();
    A.expect(String(A.dialogs.at(-1)?.message)).toMatch(/dcStartOverDeleteBody:.*2\.500/);
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(A.hasText("dcDayHasDraft")).toBe(false);
    A.expect(A.where()).toBe("idle");
  }, [payOnlyDraft()]],
  ["T13c (round-22 sequences finding 2): a typed 14.000 draft continued, Mad, Drikkevarer and Kort emptied, a 5.000 bon, Start forfra — the bon's draft is deleted, nothing stored", 23012, async (A) => {
    await A.continueDraft();
    await A.typeBox("rev", "food", "");
    await A.typeBox("rev", "drinks", "");
    await A.typeBox("pay", "card", "");
    await A.toCard();
    await A.shoot("b5000");
    await A.apply("steps");
    A.expect(stored(A.S).revenue_total).toBe(5000);
    await A.toCard();
    await A.startOver();
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(A.where()).toBe("idle");
  }, [draft({ notes: "Test", closed_by: "Test" })]],
  ["T2c (round-22 sequences finding 3, part 1; the move is asked now): a Z-bon day moved, the new day's save stored with its answer lost — \"Flyttet fra\", and never \"Der er allerede en kladde\" over the owner's own moved figures", 23003, async (A) => {
    await A.shoot("b12000");
    await A.apply("steps");
    A.slow("drop", 1);
    await A.moveDate(A.yesterday);
    await A.settleAll();
    A.expect(String(A.dialogs.at(-1)?.message)).toMatch(/dcMoveConfirmBody:/);
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(stored(A.S, `${A.yesterday}|`).revenue_total).toBe(12000);
    A.expect(A.hasText("dcDayHasDraft")).toBe(false);
    A.expect(A.hasText("dcDateMovedFrom")).toBe(true);
    // The form stays the owner's: the next figure is saved on that day.
    await A.typeBox("pay", "mobilepay", "500");
    A.expect(stored(A.S, `${A.yesterday}|`).payment_breakdown.mobilepay).toBe(500);
  }],
  ["T2g (round-22 sequences finding 3, part 2): after the move, another device saves the new day, and Start forfra — the delete is refused: that version is kept, the banner shows it, and nothing is saved over it", 23004, async (A) => {
    await A.shoot("b12000");
    await A.apply("steps");
    await A.moveDate(A.yesterday);
    await A.settleAll();
    await A.otherDeviceFigures();
    await A.toCard();
    await A.startOver();
    const y = stored(A.S, `${A.yesterday}|`);
    A.expect(y).toMatchObject({ status: "draft", revenue_total: 12000 });
    A.expect(y.payment_breakdown.mobilepay).toBe(99);
    A.expect(A.hasText("dcDayHasDraftBody:12.000")).toBe(true);
    const n = A.S.posts.length;
    await A.settleAll();
    A.expect(A.S.posts.length).toBe(n);
  }],
  ["C: a move answered no stays on the day with its figures; answered \"Hent salg\" fetches that day's POS sales and leaves the old draft as it is", 23005, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    await A.moveDate(A.yesterday, "no");
    A.expect(A.q("#close-date").value).toBe(A.today);
    A.expect(stored(A.S, `${A.yesterday}|`)).toBeUndefined();
    await A.moveDate(A.twoDaysAgo, "extra");
    await A.settleAll();
    A.expect(A.q("#close-date").value).toBe(A.twoDaysAgo);
    A.expect(String(A.dialogs.at(-1)?.extraLabel)).toMatch(/dcDateMoveFetch/);
    // The old day keeps its draft — nothing moved.
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 3000 });
    A.expect(A.hasText("dcDateMovedFrom")).toBe(false);
  }],
  ["C offline: a move made offline says \"Ikke gemt for {to} endnu — intet er slettet for {from}\" (round 23 review: never \"Kopieret til\" — nothing is on the new day yet — and no \"Slet den\"), never \"Flyttet\"; online again the figures land on the new day and the old draft goes", 23006, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    await A.slow("offline", 3);
    await A.moveDate(A.yesterday);
    A.expect(A.hasText("dcDateMovedNotSavedYet")).toBe(true);
    A.expect(A.hasText("dcDateMovedCopied")).toBe(false);
    A.expect(Boolean(A.findBtn(/^dcDateMovedDeleteOld$/))).toBe(false);
    A.expect(A.hasText("dcDateMovedFrom")).toBe(false);
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 3000 });
    await A.online();
    await A.settleAll();
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(stored(A.S, `${A.yesterday}|`).revenue_breakdown).toEqual({ food: 3000 });
    A.expect(A.hasText("dcDateMovedFrom")).toBe(true);
  }],
  ["B: a scan whose connection drops while it is read is not used — nothing changes, and the page says scanning needs internet", 23007, async (A) => {
    await A.shoot("b3000", { dropMid: true });
    A.expect(A.where()).toBe("idle");
    A.expect(A.S.posts.length).toBe(0);
    await A.shoot("b3000", { dropMid: false });
    A.expect(A.where()).toBe("card");
  }],
  ["A offline: the banner's Start forfra cannot reach the server — \"not deleted\" is said and nothing changes; online, Start forfra deletes it", 23008, async (A) => {
    await A.slow("offline", 1);
    await A.bannerStartOver();
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 14000 });
    A.expect(A.hasText("dcDayHasDraft")).toBe(true);
    A.expect(A.hasText("dcStartOverNotDeletedOffline")).toBe(true);
    await A.bannerStartOver();
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(A.hasText("dcDayHasDraft")).toBe(false);
    A.expect(A.where()).toBe("idle");
  }, [draft()]],
  // Round 23 review — the reviewers' repros, step by step.
  ["review 1 (must-fix): 3.000 typed on a dead line (never lands), \"← Scan Z-bon\", a bon summed; another visit's queued copy files the day at 8.000 (no save id) and History lists it; the card's Start forfra — refused: the 8.000 is kept, the banner shows it and says why (D: never deleted on History's version)", 23009, async (A) => {
    await A.skip();
    A.slow("dead", 8);
    await A.typeBox("rev", "food", "3.000");
    A.expect(stored(A.S)).toBeUndefined();
    await A.toCard();
    await A.shoot("b5000");
    await A.answer("sum");
    await A.queueCopy({ date: A.today, revenue_breakdown: { food: 8000 }, payment_breakdown: { card: 8000 } });
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 8000 });
    A.expect(A.S.lastSaveId.get(key)).toBe(null);
    await A.startOver();
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 8000 });
    A.expect(A.S.deletes).toEqual([]);
    A.expect(A.hasText("dcDayHasDraftBody:8.000")).toBe(true);
    A.expect(A.hasText("dcStartOverNotDeletedChanged:8.000")).toBe(true);
    await A.online();
  }],
  ["review 1 (P1c): the same with the other phone's own save (an id) and a day read that cannot say who wrote it (no last_save_id) — \"couldn't check\" is never \"delete\"", 23010, async (A) => {
    await A.skip();
    A.slow("dead", 8);
    await A.typeBox("rev", "food", "3.000");
    await A.toCard();
    await A.shoot("b5000");
    await A.answer("sum");
    await A.queueCopy({ date: A.today, revenue_breakdown: { food: 8000 }, payment_breakdown: { card: 8000 } });
    A.S.lastSaveId.set(key, "other-device");
    A.S.saveIdUnknown = true;
    await A.startOver();
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 8000 });
    A.expect(A.S.deletes).toEqual([]);
    A.expect(A.hasText("dcStartOverNotDeletedChanged")).toBe(true);
    await A.online();
  }],
  ["review 2/3 (must-fix): 14.000 filed for today, the line dies (the browser online), moved to yesterday — its save gets no answer: \"Ikke gemt for {to} endnu\", no \"Slet den\", nothing deleted; the line back, \"Prøv igen\": yesterday holds 14.000, today's draft goes, \"Flyttet fra\" (MT: a day said moved TO holds the figures)", 23011, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "14.000");
    A.expect(stored(A.S).revenue_total).toBe(14000);
    A.slow("dead", 2);
    await A.moveDate(A.yesterday);
    A.expect(A.hasText("dcDateMovedNotSavedYet")).toBe(true);
    A.expect(A.hasText("dcDateMovedCopied")).toBe(false);
    A.expect(await A.deleteOld()).toBe(false);
    A.expect(A.S.deletes).toEqual([]);
    A.expect(stored(A.S).revenue_total).toBe(14000);
    A.expect(stored(A.S, `${A.yesterday}|`)).toBeUndefined();
    // The line comes back by itself (no "online" event): one tap.
    A.S.holding.dead = false;
    A.expect(await A.retryMove()).toBe(true);
    await A.settleAll();
    A.expect(stored(A.S, `${A.yesterday}|`).revenue_total).toBe(14000);
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(A.hasText("dcDateMovedFrom")).toBe(true);
  }],
  // R-c round 2 — review 2/3's state (the new day filed, the old day's
  // delete lost on its own) cannot happen any more: the old day's delete is
  // part of the move, one request, done whole or not at all. The plan keeps
  // its repro (a DELETE request would fail) and holds the move to what the
  // review asked for: the new day holds the figures, the old day's draft is
  // gone, the line says so — and no separate delete is ever sent.
  ["review 2/3 (R-c round 2: the old day's delete is part of the move — it cannot fail on its own): a DELETE request would get no answer; none is sent — the server moves the figures in one request: \"Flyttet fra\", today's draft gone, yesterday holds the figures, nothing left to \"Slet den\"", 23013, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "14.000");
    const del = A.S.remove;
    let deleteRequests = 0;
    A.S.remove = () => { deleteRequests += 1; return Promise.reject(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" })); };
    await A.moveDate(A.yesterday);
    A.S.remove = del;
    A.expect(deleteRequests).toBe(0);
    A.expect(A.hasText("dcDateMovedCopied")).toBe(false);
    A.expect(stored(A.S, `${A.yesterday}|`).revenue_total).toBe(14000);
    A.expect(stored(A.S)).toBeUndefined();
    A.expect(A.hasText("dcDateMovedFrom")).toBe(true);
    A.expect(Boolean(A.findBtn(/^dcDateMovedDeleteOld$/))).toBe(false);
  }],
  // Round 23 fix-up — two devices and a lost answer: the re-sent save is on
  // the version the FORM holds (never the one History lists by then).
  ["fix-up (two devices + a lost answer, re-sent once ONLINE): 3.000 stored with its answer lost; another phone saves the day; the line dies and History is read again (it lists the other phone's version); online again the re-send is refused — \"Kladden er gemt et andet sted\" asks, the other phone's draft is kept; \"Behold mine tal\" then saves the owner's figures by choice", 23014, async (A) => {
    await lostThenOtherListed(A);
    A.S.holding.dead = false;
    await A.online();
    await A.settleAll();
    otherPhoneKept(A);
    A.expect(A.conflictShown()).toBe(true);
    A.expect(A.S.refused.some((r) => r.date === A.today && r.base_updated_at === NO_ROW_BASE && r.base_save_id)).toBe(true);
    await A.resolveConflict("keep");
    await A.settleAll();
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 3000 });
  }],
  ["fix-up (the same, re-sent on LEAVING): the re-send as the form goes is refused — the owner's 3.000 is kept on this phone as a failed copy the queue never sends again, and the other phone's draft is kept", 23015, async (A) => {
    await lostThenOtherListed(A);
    A.S.holding.dead = false;
    await A.reopen();
    otherPhoneKept(A);
    const kept = getOfflineQueue().filter((it) => it.payload?.date === A.today);
    A.expect(kept).toHaveLength(1);
    A.expect(kept[0]).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED });
    A.expect(kept[0].payload.revenue_breakdown).toEqual({ food: 3000 });
    await A.online();
    await A.settleAll();
    otherPhoneKept(A);
    A.expect(getOfflineQueue().filter((it) => it.payload?.date === A.today)).toHaveLength(1);
  }],
  // Round 23 re-send review — a re-send refused while the form is not on
  // that day's boxes: never dropped in silence.
  ["re-send review 1 (must-fix): the owner's 3.000 + 500 waiting to be re-sent, a move answered \"Hent {dag}s salg\" (the form on the other day); online, the re-send is refused — the 3.000 + 500 is kept on this phone as a failed copy (\"Ikke gemt\", DRAFT_CHANGED), the other phone's draft is kept", 23016, async (A) => {
    await lostDeadThenOther(A);
    await A.moveDate(A.twoDaysAgo, "extra");
    A.expect(A.q("#close-date").value).toBe(A.twoDaysAgo);
    A.expect(String(A.dialogs.at(-1)?.extraLabel)).toMatch(/dcDateMoveFetch/);
    await A.online();
    await A.settleAll();
    otherPhoneKept(A);
    A.expect(A.S.refused.some((r) => r.date === A.today && r.revenue_breakdown?.drinks === 500)).toBe(true);
    const kept = getOfflineQueue().filter((it) => it.payload?.date === A.today);
    A.expect(kept).toHaveLength(1);
    A.expect(kept[0]).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED });
    A.expect(kept[0].payload.revenue_breakdown).toEqual({ food: 3000, drinks: 500 });
    A.expect(A.hasText("dcQueueErrDraftChanged")).toBe(true);
    // Kept for the owner — never sent again by itself.
    const n = A.S.posts.length + A.S.refused.length;
    await A.online();
    await A.settleAll();
    A.expect(A.S.posts.filter((b) => b.date === A.today).length + A.S.refused.filter((r) => r.date === A.today).length)
      .toBeLessThanOrEqual(n);
    otherPhoneKept(A);
  }],
  ["re-send review 1b: a save of the day refused on the form's OWN version (its earlier save landed with the answer lost, the one after it died) while the form is on another day (\"Hent {dag}s salg\") — it goes again itself on that version: the owner's newest figure (Kort 3.500) is stored, never the older re-send without it", 23018, async (A) => {
    await A.skip();
    A.S.holding.drop = true;
    await A.typeBox("rev", "food", "3.000");
    A.S.holding.drop = false;
    A.slow("dead", 8);
    await A.typeBox("rev", "drinks", "500");
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 3000 });
    A.S.holding.dead = false;
    A.slow("post", 3);
    await A.typeBox("pay", "card", "3.500");
    await A.moveDate(A.twoDaysAgo, "extra");
    A.expect(A.q("#close-date").value).toBe(A.twoDaysAgo);
    await A.online();
    await A.settleAll();
    A.expect(A.S.refused.some((r) => r.date === A.today && r.payment_breakdown?.card === 3500)).toBe(true);
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_breakdown: { food: 3000, drinks: 500 } });
    A.expect(stored(A.S).payment_breakdown.card).toBe(3500);
    A.expect(getOfflineQueue().filter((it) => it.payload?.date === A.today)).toHaveLength(0);
  }],
  ["re-send review 1 (the other side): \"Flyt tallene\" while the old day's save (Drikkevarer 500) is on its way, and another phone saves the old day — that save is refused after the move: its figures are on the new day now, so no copy of them is kept for the old day; the other phone's draft stays (said)", 23019, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 3000 });
    A.slow("post", 3);
    await A.typeBox("rev", "drinks", "500");
    A.S.otherSave(key, (r) => { r.payment_breakdown = { mobilepay: 99 }; r.notes = "B"; }, { saveId: "other-device" });
    await A.moveDate(A.yesterday, "yes");
    await A.online();
    await A.settleAll();
    A.expect(A.S.refused.some((r) => r.date === A.today && r.revenue_breakdown?.drinks === 500)).toBe(true);
    A.expect(stored(A.S, `${A.yesterday}|`).revenue_breakdown).toEqual({ food: 3000, drinks: 500 });
    otherPhoneKept(A);
    A.expect(getOfflineQueue().filter((it) => it.payload?.date === A.today)).toHaveLength(0);
    A.expect(A.hasText("dcDateMovedFrom")).toBe(false);
  }],
  ["re-send review 2: the same on the scan card (a 4.000 bon in, its question open) — the re-send is refused there and asked; \"Behold mine tal\" sends the owner's 3.000 + 500 on the version it met (the autosave files nothing on the card)", 23017, async (A) => {
    await lostDeadThenOther(A);
    A.expect(await A.toCard()).toBe(true);
    await A.shoot("b4000");
    await A.online();
    await A.settleAll();
    A.expect(A.conflictShown()).toBe(true);
    otherPhoneKept(A);
    const stamp = stored(A.S).updated_at;
    const n = A.S.posts.length;
    await A.resolveConflict("keep");
    await A.settleAll();
    A.expect(A.conflictShown()).toBe(false);
    const sent = A.S.posts.slice(n).filter((b) => b.date === A.today);
    A.expect(sent.some((b) => b.base_updated_at === stamp && b.revenue_breakdown?.food === 3000 && b.revenue_breakdown?.drinks === 500)).toBe(true);
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 3000, drinks: 500 });
  }],
  // Round 23 R-c — the sequences lane's blocking finding: after "Hent
  // {dag}s salg" the day left behind is not the form's any more (its figures
  // are off the boxes). Coming back, its stored draft is said before any
  // typing, nothing is saved over it, and nothing is moved onto it.
  ["R-c 1, R1 (sequences finding): 12.000 saved for today, moved to the day before yesterday (POS sales) answered \"Hent {dag}s salg\", back to today with nothing typed — the banner names today's stored 12.000 before any typing; a figure typed under it saves nothing; continued, the next figure is added to the 12.000", 23020, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "12.000");
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 12000 });
    await A.moveDate(A.twoDaysAgo, "extra");
    A.expect(A.q("#close-date").value).toBe(A.twoDaysAgo);
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 12000 });
    // Back with only the POS figures on the form: no question (nothing of
    // the owner's goes with the date) — the step itself, so the banner is
    // looked at before anything answers it.
    const asked = A.dialogs.length;
    const el = A.q("#close-date");
    await A.step(`date → ${A.today} (nothing typed)`, async () => {
      fireEvent.change(el, { target: { value: A.today } });
      for (let i = 0; i < 4; i++) await A.settle();
    });
    A.expect(A.dialogs.length).toBe(asked);
    A.expect(A.q("#close-date").value).toBe(A.today);
    A.expect(A.hasText("dcDayHasDraftBody:12.000")).toBe(true);
    // A figure typed under the banner is never saved over the stored draft.
    const n = A.S.posts.filter((b) => b.date === A.today).length;
    A.expect(await A.toStep("s1")).toBe(true);
    const drinks = A.q("#dc-rev-drinks");
    A.expect(Boolean(drinks)).toBe(true);
    fireEvent.change(drinks, { target: { value: "750" } });
    // (Leaving sends a save that is waiting: whatever the page would file goes now.)
    await A.settleAll();
    A.expect(A.S.posts.filter((b) => b.date === A.today).length).toBe(n);
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 12000 });
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 12000 });
    // Continued: the stored draft is on the form, and the next figure joins it.
    await A.continueDraft();
    await A.typeBox("rev", "drinks", "750");
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 12000, drinks: 750 });
  }],
  ["R-c 1, R2 (sequences finding): the same, then Takeaway 300 typed on the day before yesterday and the figures moved back to today — asked \"{today} har allerede en kladde\", never \"Flyt tallene\" over it: nothing moves, today keeps its 12.000, the day before yesterday keeps its 300", 23021, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "12.000");
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 12000 });
    await A.moveDate(A.twoDaysAgo, "extra");
    A.expect(A.q("#close-date").value).toBe(A.twoDaysAgo);
    await A.typeBox("rev", "takeaway", "300");
    A.expect(stored(A.S, `${A.twoDaysAgo}|`).revenue_breakdown.takeaway).toBe(300);
    await A.moveDate(A.today, "yes");
    A.expect(String(A.dialogs.at(-1)?.title)).toMatch(/dcMoveTargetDraftTitle/);
    A.expect(A.q("#close-date").value).toBe(A.twoDaysAgo);
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 12000 });
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 12000 });
    A.expect(stored(A.S, `${A.twoDaysAgo}|`).revenue_breakdown.takeaway).toBe(300);
  }],
  ["R-c 1, the same with the 12.000's answer LOST (stored, never heard): back on today, a figure typed is never saved over it — the banner says the draft, or the save is refused and \"Kladden er gemt et andet sted\" asks", 23022, async (A) => {
    await A.skip();
    A.slow("drop", 1);
    await A.typeBox("rev", "food", "12.000");
    A.expect(A.S.lostKeys.has(key)).toBe(true);
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 12000 });
    await A.moveDate(A.twoDaysAgo, "extra");
    A.expect(A.q("#close-date").value).toBe(A.twoDaysAgo);
    const el = A.q("#close-date");
    await A.step(`date → ${A.today} (nothing typed)`, async () => {
      fireEvent.change(el, { target: { value: A.today } });
      for (let i = 0; i < 4; i++) await A.settle();
    });
    A.expect(A.q("#close-date").value).toBe(A.today);
    A.expect(await A.toStep("s1")).toBe(true);
    const drinks = A.q("#dc-rev-drinks");
    A.expect(Boolean(drinks)).toBe(true);
    await A.step("rev.drinks=750 (raw)", async () => { fireEvent.change(drinks, { target: { value: "750" } }); });
    await A.settleAll();
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 12000 });
    A.expect(A.hasText("dcDayHasDraftBody:12.000") || A.conflictShown()).toBe(true);
  }],
  // Round 23 R-c review — the reviewer's probes, step by step.
  ["R-c review 1 (must-fix): Mad 12.000 on a dead line (stored nowhere), \"Hent {dag}s salg\" to the day before yesterday, back to today, the line back, Drikkevarer 750 with its save still on its way, moved to yesterday answered \"Flyt tallene\" — the question names today's draft, the 750 is never stored on both days, and the 12.000 is kept on this phone as a copy", 23023, async (A) => {
    await deadTwelveBack(A);
    // The line back by itself (no "online" event), and the 750's save on
    // its way while the date is moved.
    A.S.holding.dead = false;
    A.S.holding.post = true;
    await A.typeBox("rev", "drinks", "750");
    await A.moveDate(A.yesterday, "yes");
    const asked = A.dialogs.at(-1);
    A.expect(String(asked?.title)).toMatch(/dcMoveConfirmTitle/);
    A.expect(String(asked?.message)).toMatch(/dcMoveConfirmBody:/);
    A.expect(String(asked?.message)).not.toMatch(/dcMoveConfirmBodyNothing/);
    await A.online();
    await A.settleAll();
    // (A step: every invariant looks — MV with the saves arrived.)
    await A.step("look again", () => {});
    A.expect(stored(A.S, `${A.yesterday}|`)?.revenue_breakdown).toEqual({ drinks: 750 });
    const t = stored(A.S);
    A.expect(Boolean(t && t.status === "draft" && t.revenue_breakdown?.drinks === 750)).toBe(false);
    // Today's own save of the 750 is gone with the move — said "Flyttet fra".
    A.expect(t).toBeUndefined();
    A.expect(A.hasText("dcDateMovedFrom")).toBe(true);
    // The 12.000 (never stored) is kept on this phone, and says so.
    A.expect(twelveKept(A)).toBe(true);
    A.expect(A.hasText("dcQueueCopyHolds:12.000")).toBe(true);
    // Said as what it is — never "saved somewhere else" (today holds nothing).
    A.expect(A.hasText("dcQueueErrLetGo")).toBe(true);
  }],
  ["R-c review 2 (must-fix): Mad 12.000 on a dead line (stored nowhere), \"Hent {dag}s salg\" to the day before yesterday, back to today, the line back, Drikkevarer 750 — the 12.000 is never dropped unasked: stored, kept on this phone as a copy (\"Din kopi: 12.000\"), or asked about", 23024, async (A) => {
    await deadTwelveBack(A);
    // The line back by itself (no "online" event): the next save goes.
    A.S.holding.dead = false;
    await A.typeBox("rev", "drinks", "750");
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(twelveKept(A)).toBe(true);
    // The 750 typed since is today's draft; the 12.000 is kept on this phone
    // as a copy the owner decides on — never sent by itself over the 750.
    A.expect(stored(A.S).revenue_breakdown).toEqual({ drinks: 750 });
    const copy = getOfflineQueue().find((it) => it.payload?.date === A.today && it.payload?.revenue_breakdown?.food === 12000);
    A.expect(copy).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED });
    A.expect(A.hasText("dcQueueCopyHolds:12.000")).toBe(true);
    A.expect(A.hasText("dcQueueErrLetGo")).toBe(true);
    await A.settleAll();
    A.expect(stored(A.S).revenue_breakdown).toEqual({ drinks: 750 });
    // Its own button names what it stores, and one tap stores it (by choice).
    const b = A.findBtn(/^dcQueueKeepCopyInstead:12\.000/);
    A.expect(Boolean(b)).toBe(true);
    await A.step("Gem kopien i stedet", async () => { fireEvent.click(b); for (let i = 0; i < 6; i++) await A.settle(); });
    A.expect(stored(A.S).revenue_breakdown).toEqual({ food: 12000 });
    A.expect(getOfflineQueue().some((it) => it.payload?.date === A.today)).toBe(false);
  }],
  // R-c round 2 fix-up (MB) — a move off a LOCKED day is refused whole now
  // (no "Kopieret til" beside a locked day). The copy line stays for an old
  // day another device SAVED since: its own version is kept, never deleted
  // with the moved figures — held here by name, so MV's copy branch is
  // always looked at (MVcopy).
  ["(R-c round 2 fix-up) 3.000 saved for today, another device saves today since (its own version), the figures moved to yesterday: today's other version is kept and said (\"Kopieret til … står der stadig\") — never deleted, never \"Flyttet fra\"", 23040, async (A) => {
    await A.skip();
    await A.typeBox("rev", "food", "3.000");
    A.expect(stored(A.S)).toMatchObject({ status: "draft", revenue_total: 3000 });
    await A.otherDeviceFigures(null, { saveId: "other-device" });
    const other = { ...stored(A.S) };
    await A.moveDate(A.yesterday, "yes");
    await A.settleAll();
    await A.step("look again", () => {});
    A.expect(stored(A.S, `${A.yesterday}|`)).toMatchObject({ status: "draft", revenue_total: 3000 });
    A.expect(stored(A.S)).toMatchObject({ status: "draft", payment_breakdown: other.payment_breakdown, notes: other.notes });
    A.expect(A.hasText("dcDateMovedCopied:")).toBe(true);
    A.expect(A.hasText("dcDateMovedFrom")).toBe(false);
  }],
];

// The reviewer's start: Mad 12.000 typed for today on a dead line (its saves
// die — stored nowhere), "Hent {dag}s salg" to the day before yesterday, and
// back on today with nothing typed — no banner (nothing is listed), the boxes
// empty. The line is still dead.
async function deadTwelveBack(A) {
  await A.skip();
  A.slow("dead", 12);
  await A.typeBox("rev", "food", "12.000");
  A.expect(stored(A.S)).toBeUndefined();
  await A.moveDate(A.twoDaysAgo, "extra");
  A.expect(A.q("#close-date").value).toBe(A.twoDaysAgo);
  await backToToday(A);
  A.expect(stored(A.S)).toBeUndefined();
  A.expect(A.q("#dc-rev-food")?.value || "").toBe("");
}
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
// The 12.000 typed for today is somewhere the owner can reach: stored, kept on
// this phone as a copy, or asked about on the page.
function twelveKept(A) {
  const t = stored(A.S);
  return Boolean(t && t.revenue_breakdown?.food === 12000)
    || getOfflineQueue().some((it) => it.payload?.date === A.today && it.payload?.revenue_breakdown?.food === 12000)
    || A.hasText("dcDayHasDraftBody:12.000") || (A.conflictShown() && A.hasText("12.000"));
}

// Found by this variant while round 23 was built.
const FOUND = [
  ["a move made offline from a day whose save never landed: never \"står der stadig\" for a draft that may not exist (MV)", 10525],
  // The round-22 review's confusing item, reached by several offline steps:
  // a queued copy refused once online never re-read History (fail on b4c2ceb3).
  ["left offline after another device locked the day, back online: the refused copy re-reads History — the lock is said (LK)", 10414],
  ["the same over a reopened draft (a full reload, the save's answer lost) (LK)", 10595],
  ["the same with a note typed offline before the lock (LK)", 10678],
];

describe("daily close — round 23 sequences (Start forfra deletes, no scan offline, moves asked)", () => {
  beforeAll(() => {
    window.scrollTo = () => {};
    window.scrollBy = () => {};
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
      // (The day before yesterday has POS sales, as in a random sequence.)
      const S = createServer({ rows: rows.map((r) => ({ ...r })), syncedDates: [twoDaysAgo] });
      await runSequence(seed, { DailyClosePage }, { S, get, post, del }, { variant: "r23", plan });
    }, 30000);
  }
  for (const [what, seed] of FOUND) {
    it(`${what}: seed ${seed}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      await runSequence(seed, { DailyClosePage }, { get, post, del }, { variant: "r23" });
    }, 30000);
  }
  for (let seed = FROM; seed < FROM + COUNT; seed++) {
    it(`seed ${seed}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      await runSequence(seed, { DailyClosePage }, { get, post, del }, { variant: "r23" });
    }, 30000);
  }
  it("checked what it claims", () => {
    if (env.SEQ_FROM) return;
    // The failure classes and the narrowings' paths actually ran (a zero
    // would be a vacuous green).
    expect(STATS.lostAnswers).toBeGreaterThan(0);
    expect(STATS.offlineSteps).toBeGreaterThan(0);
    expect(STATS.M6).toBeGreaterThan(0);
    expect(STATS.M6said).toBeGreaterThan(0);
    expect(STATS.M6failed).toBeGreaterThan(0);
    expect(STATS.MV).toBeGreaterThan(0);
    expect(STATS.MVsaid).toBeGreaterThan(0);
    expect(STATS.MVno).toBeGreaterThan(0);
    expect(STATS.MVfetch).toBeGreaterThan(0);
    expect(STATS.MVcopy).toBeGreaterThan(0);
    expect(STATS.B).toBeGreaterThan(0);
    expect(STATS.Bdrop).toBeGreaterThan(0);
    expect(STATS.LK).toBeGreaterThan(0);
    // Round 23 review: every delete held to D; the line under the date held
    // to MT (and "Ikke gemt endnu" with no "Slet den"); "Slet den" tapped;
    // Start forfra tapped with a save on its way; saves dying on a dead
    // line; writers with no save id; day reads that could not check.
    expect(STATS.D).toBeGreaterThan(0);
    expect(STATS.MT).toBeGreaterThan(0);
    expect(STATS.MVpending).toBeGreaterThan(0);
    // (R-c round 2: "Slet den" after a move is retired with the separate
    // delete — the old day's draft goes in the move itself, or is kept and
    // said; MVdeleteOld counts nothing any more. The move instead: sent as
    // one request, and sent again after a lost answer with its own save_id.)
    expect(STATS.moves).toBeGreaterThan(0);
    expect(STATS.moveReplays).toBeGreaterThan(0);
    expect(STATS.M6race).toBeGreaterThan(0);
    expect(STATS.deadSaves).toBeGreaterThan(0);
    expect(STATS.noIdWriters).toBeGreaterThan(0);
    expect(STATS.unknownReads).toBeGreaterThan(0);
  });
});
