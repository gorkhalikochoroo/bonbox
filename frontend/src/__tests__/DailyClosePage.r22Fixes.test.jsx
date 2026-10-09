/**
 * Round 22 — focused tests beside the sequence harness (r22Sequences).
 *
 * MUST FIX — one rule, applied everywhere: "a save whose answer was lost MAY
 * be ours — ask the server before acting". The lost save is recorded in full
 * (its id, whether it made the row, the draft it replaced); before a date
 * move, a Start forfra or a revert takes the day back, the day is read fresh
 * (GET /daily-close?from=&to=&with_save_id) and is the form's own exactly when
 * the save that wrote it last is one the form sent — then it is deleted or
 * filed back on THAT version. Never "moved" unless the old day is gone or
 * back as it was.
 *
 * CONFUSING
 *  1. Another device locks the day while the page is open: the autosave's
 *     409 shows the day's lock banner at once (its amount once History is
 *     read again), the form is read-only, the slot says "Ikke gemt".
 *  2. "Kladden er gemt et andet sted": raised by a lock TAP it is brought
 *     into view and takes focus, and the lock's area says why nothing was
 *     locked; raised by an autosave it never takes the caret — the slot says
 *     "Ikke gemt" and brings it into view on a tap.
 *  3. After a two-till sum, the day's own split typed afterwards is never
 *     "ikke lagt sammen", and nothing above the box moves while the focus
 *     goes from box to box.
 *
 * OFFLINE (the fixed failure model's last class): a draft save that got no
 * answer waits — sent when the page is left or the browser is online again —
 * and a page left while offline keeps the draft on this device (the offline
 * queue sends it once online). It was dropped: the edit was on no server and
 * on no device.
 * Strings are asserted by key (t echoes key + values).
 */
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const { BONS, createServer, installApi, photoUrl } = await import("../test/closeSequenceHarness");
const { OQ_KEY } = await import("../utils/dailyCloseQueue");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const KEY = `${today}|`;
const yesterday = (() => { const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();

let S;
let scrolled;
beforeEach(() => {
  window.scrollTo = () => {};
  scrolled = [];
  Element.prototype.scrollIntoView = function scrollIntoView() { scrolled.push(this); };
  window.confirm = vi.fn(() => true);
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  del.mockReset();
});
const serve = (rows = []) => {
  S = createServer({ rows: rows.map((r) => ({ ...r })) });
  installApi(S, get, post, del);
};

const q = (sel) => document.querySelector(sel);
const btn = (re) => [...document.querySelectorAll("button")].find((b) => re.test(b.textContent.trim()));
const tap = (re) => {
  const b = btn(re);
  if (!b) throw new Error(`no button ${re}`);
  fireEvent.click(b);
};
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const flush = async () => {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
  for (let i = 0; i < 6; i++) await settle();
};
/** The page's next save reaches the server and is stored — its answer is lost. */
const flushLost = async () => {
  S.holding.drop = true;
  await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
  S.holding.drop = false;
  for (let i = 0; i < 6; i++) await settle();
};
const keyIn = (el, value) => {
  if (el.value !== "") fireEvent.change(el, { target: { value: "" } });
  for (const ch of value) fireEvent.change(el, { target: { value: el.value + ch } });
};
const mount = async (entry = "/daily-close") => {
  const view = render(<MemoryRouter initialEntries={[entry]}><DailyClosePage /></MemoryRouter>);
  const want = S.rows.has(KEY) ? "dcDayHasDraft" : "scanZReportTitle";
  for (let i = 0; i < 10 && !document.body.textContent.includes(want); i++) await settle();
  return view;
};
const shoot = async (key, name) => {
  S.nextScan = { ...BONS[key], image_url: photoUrl(name) };
  const input = [...document.querySelectorAll('input[type="file"]')].at(-1);
  fireEvent.change(input, { target: { files: [new File([name], name, { type: "image/jpeg", lastModified: 1 })] } });
  await waitFor(() => expect(q('[data-testid="dc-scan-result-date"]')).not.toBeNull());
};
const shootStub = async (stub, name) => {
  S.nextScan = { raw_text: "BON", ocr_available: true, payments: {}, revenue: {}, ...stub, image_url: photoUrl(name) };
  const input = [...document.querySelectorAll('input[type="file"]')].at(-1);
  fireEvent.change(input, { target: { files: [new File([name], name, { type: "image/jpeg", lastModified: 1 })] } });
  await waitFor(() => expect(q('[data-testid="dc-scan-result-date"]')).not.toBeNull());
};
const toStepWith = async (sel) => {
  await waitFor(() => expect(q("#close-date")).not.toBeNull());
  for (let i = 0; i < 8 && !q(sel); i++) {
    const next = btn(/^next\s*→$/);
    if (!next) break;
    fireEvent.click(next);
  }
  await waitFor(() => expect(q(sel)).not.toBeNull());
};
const backToCard = async () => {
  for (let i = 0; i < 8 && !q("#dc-rev-food"); i++) tap(/^←\s*back$/);
  tap(/^←\s*scanZReportBack$/);
  await settle();
};
const rowFor = (day = today) => S.rows.get(`${day}|`);
const text = () => document.body.textContent;
/** The page's reads of one day (the "ask the server" reads). */
const dayReads = () => get.mock.calls.filter(([url, cfg]) => url === "/daily-close" && cfg?.params?.with_save_id);
// (Round 23: the move is asked before the date changes — window.confirm
// answers "Flyt tallene".)
const moveTo = async (day) => {
  fireEvent.change(q("#close-date"), { target: { value: day } });
  await settle();
  await flush();
  await flush();
};

const DRAFT = {
  id: "seed1", date: today, branch_id: null, status: "draft", closed_by: null, notes: null,
  revenue_total: 3000, revenue_breakdown: { food: 3000 }, payment_breakdown: {},
  moms_mode: "auto", moms_total: 600, source_meta: { kind: "typed" }, receipt_photo: null,
};
const ZBON = {
  id: "seed1", date: today, branch_id: null, status: "draft",
  revenue_total: 17030, revenue_breakdown: { food: 9000, drinks: 6000, takeaway: 2030 }, payment_breakdown: { card: 12000, cash: 5030 },
  moms_mode: "manual", moms_total: 3406, source_meta: { kind: "zbon", scans: 1, corrected: [] },
  receipt_photo: "u1/kasserapport/seed-own.jpg", cash_counted: 980, cash_float: 500, closed_by: "Test", notes: "Test",
};

/* ─── must fix: a save whose answer was lost MAY be ours ─────────────── */

describe("must fix — a save whose answer was lost is asked about before the day is taken back", () => {
  it("date move: the old day is read fresh, and its draft deleted on exactly the version the form's lost save wrote — then \"moved\"", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3000");
    await flushLost();
    const lost = rowFor();
    expect(lost).toMatchObject({ revenue_breakdown: { food: 3000 } });
    const stamp = lost.updated_at;
    const sid = S.lastSaveId.get(KEY);
    expect(sid).toBeTruthy();
    await moveTo(yesterday);
    // Asked: one read of the old day, by date, with the last save's id.
    expect(dayReads().some(([, cfg]) => cfg.params.from === today && cfg.params.to === today)).toBe(true);
    // Deleted on that version — the server's version check, as after an answer.
    expect(del).toHaveBeenCalledWith(`/daily-close/${lost.id}`, { params: { base_updated_at: stamp, base_save_id: sid } });
    expect(rowFor()).toBeUndefined();
    expect(rowFor(yesterday)).toMatchObject({ revenue_breakdown: { food: 3000 } });
    expect(text()).toContain("dcDateMovedFrom");
  });

  it("…saved on another phone since (the last save is not the form's): nothing is deleted, and the note never says \"moved\"", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3000");
    await flushLost();
    S.otherSave(KEY, (r) => { r.notes = "B"; });
    await moveTo(yesterday);
    expect(del).not.toHaveBeenCalled();
    expect(rowFor()).toMatchObject({ status: "draft", notes: "B" });
    // (Round 23: the note is "Kopieret til … står der stadig".)
    expect(text()).toContain("dcDateMovedCopied");
    expect(text()).not.toContain("dcDateMovedFrom");
  });

  it("…the server cannot be asked (offline): never \"moved\" — the old day may hold the figures, and the note says so", async () => {
    serve();
    const pass = get.getMockImplementation();
    get.mockImplementation((url, cfg) => (cfg?.params?.with_save_id
      ? Promise.reject(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }))
      : pass(url, cfg)));
    await mount();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3000");
    await flushLost();
    await moveTo(yesterday);
    expect(del).not.toHaveBeenCalled();
    // (Round 23: the old day's save got no answer and could not be asked
    // about — "Kopieret til … — kladden … kan stadig stå der", with "Slet
    // den"; never the certain "står der stadig" for what is not known.)
    expect(text()).toContain("dcDateMovedMaybeCopied");
    expect(btn(/^dcDateMovedDeleteOld$/)).toBeTruthy();
    expect(text()).not.toContain("dcDateMovedFrom");
  });

  it("nothing landed (the lost save never reached the server's row): nothing to take back — the move is a move", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3000");
    await flushLost();
    // The row it wrote is gone again (deleted from History on another phone).
    S.rows.delete(KEY);
    await moveTo(yesterday);
    expect(del).not.toHaveBeenCalled();
    expect(text()).toContain("dcDateMovedFrom");
  });

  // Round 23 (A, rewritten): the banner's Start forfra deletes the draft (no
  // replaced draft to put back); the card's Start forfra asks the server
  // about the save whose answer was lost and deletes exactly that version.
  it("the banner's Start forfra deletes the 17.030 draft; a Z-bon stored with its answer lost, Start forfra: deleted on the version the lost save wrote (base_save_id)", async () => {
    serve([ZBON]);
    await mount();
    tap(/^dcStartOverDraft$/);
    await flush();
    expect(window.confirm.mock.calls.at(-1)[0]).toMatch(/^dcStartOverDeleteBody:.*\|17\.030 kr\.$/);
    expect(rowFor()).toBeUndefined();
    await shoot("t2500", "t2500.jpg");
    // Every save of the photo's figures reaches the server, every answer is
    // lost (the step and the way back to the card).
    S.holding.drop = true;
    tap(/^continueStepByStep$/);
    await flush();
    expect(rowFor().revenue_total).toBe(2500);
    await backToCard();
    await flush();
    expect(S.lastSaveId.get(KEY)).toBeTruthy();
    const stored = rowFor();
    // (Still losing answers: the way out re-sends the unanswered draft —
    // round 23 — and that answer is lost too; the delete follows whichever
    // lost save wrote the row last.)
    tap(/^startOver$/);
    await flush();
    S.holding.drop = false;
    const [url, cfg] = del.mock.calls.at(-1);
    expect(url).toBe(`/daily-close/${stored.id}`);
    expect(cfg.params.base_save_id).toBe(S.lastSaveId.get(KEY));
    expect(rowFor()).toBeUndefined();
    expect(text()).not.toContain("dcDayHasDraft");
  });

  it("Start forfra on a photo's day whose save lost its answer: the question counts that draft (5.000) — answered yes, it is deleted on that version", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    tap(/^continueStepByStep$/);
    await toStepWith("#dc-notes");
    keyIn(q("#dc-notes"), "Test");
    await flushLost();
    expect(rowFor()).toMatchObject({ revenue_total: 5000, notes: "Test" });
    await backToCard();
    window.confirm.mockClear();
    tap(/^startOver$/);
    await flush();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.confirm.mock.calls[0][0]).toMatch(/^dcStartOverDeleteBody:.*\|5\.000 kr\.$/);
    expect(del).toHaveBeenCalledTimes(1);
    expect(rowFor()).toBeUndefined();
  });
});

/* ─── confusing 1: locked on another device ─────────────────────────── */

describe("confusing 1 — another device locks the day while the page is open", () => {
  it("the next edit's 409 shows the day's lock banner at once — the amount once History is read again — the form is read-only, the slot says \"Ikke gemt\"", async () => {
    serve([DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-rev-drinks");
    S.otherLock(KEY);
    const listsBefore = get.mock.calls.filter(([url, cfg]) => url === "/daily-close" && !cfg).length;
    keyIn(q("#dc-rev-drinks"), "6000");
    await flush();
    expect(S.lockConflicts).toBe(1);
    expect(text()).toContain("dcDayAlreadyLocked");
    // History was read again: the lock's own amount, never one nobody locked.
    expect(get.mock.calls.filter(([url, cfg]) => url === "/daily-close" && !cfg).length).toBeGreaterThan(listsBefore);
    expect(text()).toContain("dcDayAlreadyLockedBody:3.000");
    expect(btn(/^dcOpenHistory$/)).toBeTruthy();
    // Read-only: nothing typed here is refused in silence.
    expect(q("fieldset").disabled).toBe(true);
    expect(q('[data-testid="dc-save-slot-unsaved"]')).not.toBeNull();
    // No more knocking.
    await flush();
    expect(S.lockConflicts).toBe(1);
  });

  it("before History answers, the banner names no amount (never \"Låst med 0 kr.\")", async () => {
    serve([DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-rev-drinks");
    S.otherLock(KEY);
    // History stalls.
    const pass = get.getMockImplementation();
    get.mockImplementation((url, cfg) => (url === "/daily-close" && !cfg ? new Promise(() => {}) : pass(url, cfg)));
    keyIn(q("#dc-rev-drinks"), "6000");
    await flush();
    expect(text()).toContain("dcDayAlreadyLocked");
    expect(text()).toContain("dcDayLockedNoAmount");
    expect(text()).not.toContain("dcDayAlreadyLockedBody:0");
  });

  it("\"Hent den nyeste kladde\" when that draft was locked elsewhere since: the question goes and the day is said locked (removal audit #11)", async () => {
    serve([DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-rev-drinks");
    S.otherSave(KEY, (r) => { r.notes = "B"; });
    keyIn(q("#dc-rev-drinks"), "1500");
    await flush();
    expect(q('[data-testid="dc-draft-changed"]')).not.toBeNull();
    S.otherLock(KEY);
    tap(/^dcDraftChangedReload$/);
    for (let i = 0; i < 8; i++) await settle();
    expect(q('[data-testid="dc-draft-changed"]')).toBeNull();
    expect(text()).toContain("dcDayAlreadyLocked");
  });
});

/* ─── confusing 2: "Kladden er gemt et andet sted" off-screen ────────── */

describe("confusing 2 — the draft saved somewhere else is said where the owner is", () => {
  it("an autosave refused on Trin 5: the slot says \"Ikke gemt\" (never \"5/5\"), the caret stays in Noter; a tap on it brings the question into view", async () => {
    serve([DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-notes");
    S.otherSave(KEY, (r) => { r.notes = "B"; });
    const notes = q("#dc-notes");
    act(() => { notes.focus(); });
    keyIn(notes, "x");
    await flush();
    const card = q('[data-testid="dc-draft-changed"]');
    expect(card).not.toBeNull();
    const slot = q('[data-testid="dc-save-slot-unsaved"]');
    expect(slot).not.toBeNull();
    expect(slot.textContent).toContain("dcDraftNotSavedShort");
    expect(text()).not.toMatch(/\b5\/5\b/);
    // Nothing took the caret.
    expect(document.activeElement).toBe(notes);
    expect(scrolled).not.toContain(card);
    fireEvent.click(slot);
    expect(scrolled).toContain(card);
    expect(document.activeElement).toBe(card);
  });

  it("a lock refused (412): the question is brought into view and takes focus, and the lock's area says why nothing was locked", async () => {
    serve([DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-notes");
    S.otherSave(KEY, (r) => { r.notes = "B"; });
    tap(/confirmAndLock/);
    for (let i = 0; i < 6; i++) await settle();
    const card = q('[data-testid="dc-draft-changed"]');
    expect(card).not.toBeNull();
    expect(rowFor()).toMatchObject({ status: "draft", notes: "B" });
    await waitFor(() => expect(scrolled).toContain(card));
    expect(document.activeElement).toBe(card);
    const why = q('[data-testid="dc-lock-not-done"]');
    expect(why).not.toBeNull();
    expect(why.textContent).toContain("dcLockNotDoneDraftChanged");
    // Answered: the reason goes with the question.
    tap(/^dcDraftChangedKeepLock$/);
    for (let i = 0; i < 6; i++) await settle();
    expect(q('[data-testid="dc-lock-not-done"]')).toBeNull();
    expect(rowFor()).toMatchObject({ status: "confirmed", revenue_total: 3000 });
  });
});

/* ─── confusing 3: a two-till sum, then the day's own split ──────────── */

describe("confusing 3 — after a sum, the day's split is never \"ikke lagt sammen\", and nothing above the box moves box to box", () => {
  // The desktop lane's repro: 17.030 (Kort 12.000) + 5.000 (Kontant 5.000),
  // "En terminal mere", "Fortsæt trin for trin", the categories typed.
  const summedWizard = async () => {
    serve();
    await mount();
    await shootStub({ revenue_total: 17030, moms_total: 3406, payments: { card: 12000 } }, "a.jpg");
    S.nextScan = { raw_text: "BON", ocr_available: true, revenue: {}, revenue_total: 5000, payments: { cash: 5000 }, image_url: photoUrl("b.jpg") };
    const input = [...document.querySelectorAll('input[type="file"]')].at(-1);
    fireEvent.change(input, { target: { files: [new File(["b"], "b.jpg", { type: "image/jpeg", lastModified: 1 })] } });
    await waitFor(() => expect(q('[data-testid="dc-terminal-question"]')).not.toBeNull());
    tap(/^scanSecondTotalSum/);
    tap(/^continueStepByStep$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
  };
  /** Every block (div/p) above the box, with its text: what could move it. */
  const above = (input) => [...document.querySelectorAll("fieldset div, fieldset p")]
    // eslint-disable-next-line no-bitwise
    .filter((el) => !el.contains(input) && (el.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING))
    .map((el) => `${el.tagName}:${el.children.length ? "" : el.textContent}`)
    .join("¦");
  /** Focus moves from one box straight to the next (Tab): blur with relatedTarget, then focus. */
  const tabTo = (from, to) => {
    act(() => {
      fireEvent.blur(from, { relatedTarget: to });
      fireEvent.focus(to, { relatedTarget: from });
    });
  };

  it("Mad, Drikkevarer and Takeaway typed box to box: nothing above the next box changes, and no line names them", async () => {
    await summedWizard();
    const food = q("#dc-rev-food");
    const drinks = q("#dc-rev-drinks");
    const takeaway = q("#dc-rev-takeaway");
    act(() => { fireEvent.focus(food); });
    keyIn(food, "14000");
    const beforeDrinks = above(drinks);
    tabTo(food, drinks);
    expect(above(drinks)).toBe(beforeDrinks);
    keyIn(drinks, "5000");
    const beforeTakeaway = above(takeaway);
    tabTo(drinks, takeaway);
    expect(above(takeaway)).toBe(beforeTakeaway);
    keyIn(takeaway, "3030");
    // Left: the summary settles once — and names none of the day's split.
    act(() => { fireEvent.blur(takeaway); });
    expect(text()).not.toContain("scanMergedIncompleteOwn");
  });

  it("MobilePay, a payment no bon had, typed after the sum: never \"ikke lagt sammen\" on the review either", async () => {
    await summedWizard();
    keyIn(q("#dc-rev-food"), "14000");
    keyIn(q("#dc-rev-drinks"), "5000");
    keyIn(q("#dc-rev-takeaway"), "3030");
    await toStepWith("#dc-pay-mobilepay");
    keyIn(q("#dc-pay-mobilepay"), "5030");
    await toStepWith("#dc-notes");
    expect(text()).not.toContain("scanMergedIncompleteOwn");
  });
});

/* ─── offline ───────────────────────────────────────────────────────── */

describe("offline — a draft save with no answer is never dropped", () => {
  const setOnline = (on) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });
  const goOffline = async () => {
    S.holding.offline = true;
    setOnline(false);
    await act(async () => { window.dispatchEvent(new Event("offline")); await new Promise((r) => setTimeout(r, 0)); });
  };
  const goOnline = async () => {
    S.holding.offline = false;
    setOnline(true);
    await act(async () => { window.dispatchEvent(new Event("online")); await new Promise((r) => setTimeout(r, 0)); });
    for (let i = 0; i < 6; i++) await settle();
  };
  const queued = () => JSON.parse(localStorage.getItem(OQ_KEY) || "[]");

  it("a blip during the last edit: the draft waits, and goes the moment the browser is online again", async () => {
    serve();
    try {
      await mount();
      tap(/^skipEnterManually$/);
      await toStepWith("#dc-rev-food");
      keyIn(q("#dc-rev-food"), "3000");
      await flush();
      expect(rowFor()).toMatchObject({ revenue_breakdown: { food: 3000 } });
      // The connection drops (the browser does not know yet): the save fails.
      S.holding.offline = true;
      keyIn(q("#dc-rev-food"), "3500");
      await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
      await act(async () => { window.dispatchEvent(new Event("pageshow")); await new Promise((r) => setTimeout(r, 0)); });
      for (let i = 0; i < 4; i++) await settle();
      expect(rowFor().revenue_breakdown).toEqual({ food: 3000 });
      // Back: it goes, though nothing was typed since.
      await goOnline();
      expect(rowFor().revenue_breakdown).toEqual({ food: 3500 });
    } finally {
      S.holding.offline = false;
      setOnline(true);
    }
  });

  it("…and leaving later (the network back, no 'online' event) sends it too", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-rev-food");
    S.holding.offline = true;
    keyIn(q("#dc-rev-food"), "3000");
    await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
    for (let i = 0; i < 4; i++) await settle();
    expect(rowFor()).toBeUndefined();
    S.holding.offline = false;
    await flush();
    expect(rowFor()).toMatchObject({ revenue_breakdown: { food: 3000 } });
  });

  it("left while OFFLINE: the draft is kept on this phone (never a request that can only fail), and sent once online", async () => {
    serve();
    try {
      const view = await mount();
      tap(/^skipEnterManually$/);
      await toStepWith("#dc-rev-food");
      await goOffline();
      keyIn(q("#dc-rev-food"), "3000");
      view.unmount();
      for (let i = 0; i < 4; i++) await settle();
      expect(rowFor()).toBeUndefined();
      const copy = queued();
      expect(copy).toHaveLength(1);
      expect(copy[0].payload).toMatchObject({ status: "draft", date: today, revenue_breakdown: { food: 3000 } });
      // Back online on the page: the queue sends it.
      await mount();
      await goOnline();
      expect(rowFor()).toMatchObject({ status: "draft", revenue_breakdown: { food: 3000 } });
      expect(queued()).toHaveLength(0);
    } finally {
      S.holding.offline = false;
      setOnline(true);
    }
  });

  // Round 23 (A, rewritten): Start forfra offline cannot reach the server —
  // nothing changes, the card says the draft was not deleted, and nothing is
  // done on its own once online (no automatic take-back): the owner taps it
  // again.
  it("Start forfra OFFLINE: not deleted, said, nothing changes; online, nothing happens by itself — Start forfra again deletes it", async () => {
    serve([ZBON]);
    try {
      await mount();
      tap(/^dcStartOverDraft$/);
      await flush();
      expect(rowFor()).toBeUndefined();
      await shoot("b1500", "b1500.jpg");
      tap(/^continueStepByStep$/);
      await toStepWith("#dc-rev-food");
      keyIn(q("#dc-rev-food"), "9000");
      await flush();
      expect(rowFor()).toMatchObject({ revenue_total: 9000, receipt_photo: photoUrl("b1500.jpg") });
      await backToCard();
      await goOffline();
      tap(/^startOver$/);
      for (let i = 0; i < 6; i++) await settle();
      expect(rowFor()).toMatchObject({ revenue_total: 9000 });
      expect(q('[data-testid="dc-start-over-failed"]').textContent).toContain("dcStartOverNotDeletedOffline");
      expect(q('[data-testid="dc-scan-result-date"]')).not.toBeNull();
      await goOnline();
      for (let i = 0; i < 4; i++) await settle();
      expect(rowFor()).toMatchObject({ revenue_total: 9000 });
      tap(/^startOver$/);
      await flush();
      expect(rowFor()).toBeUndefined();
      expect(q('[data-testid="dc-start-over-failed"]')).toBeNull();
    } finally {
      S.holding.offline = false;
      setOnline(true);
    }
  });

  it("hidden while offline and shown again: the copy goes again (the draft still waits here) — sent once, when online", async () => {
    serve();
    try {
      await mount();
      tap(/^skipEnterManually$/);
      await toStepWith("#dc-rev-food");
      await goOffline();
      keyIn(q("#dc-rev-food"), "3000");
      await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
      expect(queued()).toHaveLength(1);
      await act(async () => { window.dispatchEvent(new Event("pageshow")); await new Promise((r) => setTimeout(r, 0)); });
      expect(queued()).toHaveLength(0);
      await goOnline();
      expect(S.posts.filter((b) => b.date === today)).toHaveLength(1);
      expect(rowFor()).toMatchObject({ revenue_breakdown: { food: 3000 } });
    } finally {
      S.holding.offline = false;
      setOnline(true);
    }
  });
});
