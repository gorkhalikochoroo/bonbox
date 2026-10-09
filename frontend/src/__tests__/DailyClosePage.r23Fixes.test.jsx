/**
 * Round 23 — the round-22 review's breaks and the desktop UI cap, under the
 * simplified model (Start forfra a confirmed server delete, no scan offline,
 * a date move asked first — DailyClosePage.r23Narrowings).
 *
 *  1. A figure whose save got NO answer (a dead line, the browser still
 *     "online") was dropped the moment the form went back to the scan card:
 *     the waiting save lived only while the form was the day, the card said
 *     the figures were saved, and leaving sent nothing. Now the draft sent is
 *     kept until a save of the day answers — sent again on the way out and
 *     once online (kept on the phone when the way out is offline) — and the
 *     card says "Ikke gemt endnu" while what it shows is on no server.
 *  2. "Kladden er gemt et andet sted", raised by an autosave while the owner
 *     types, was put in above the field being typed in and pushed it down
 *     209–361 px (under the phone's bottom bar): the page now scrolls by
 *     the card's height in the same frame, so the field stays put.
 *  3. (The round-22 review's confusing item.) Reopened offline, back online
 *     with a queued copy the server refused (409 locked / 412 saved
 *     elsewhere): History is read again, so the wizard says the day is
 *     locked instead of "Vi kunne ikke tjekke …" beside a queue saying "låst".
 * The other round-22 breaks are closed by the narrowings themselves and
 * pinned as named regressions (DailyClosePage.r23Sequences 23002–23004).
 * Strings are asserted by key (t echoes key + values).
 */
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const { OQ_KEY, addToOfflineQueue } = await import("../utils/dailyCloseQueue");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const KEY = `${today}|`;
const DRAFT = {
  id: "seed1", date: today, branch_id: null, status: "draft", closed_by: null, notes: null,
  revenue_total: 14000, revenue_breakdown: { food: 9000, drinks: 5000 }, payment_breakdown: { card: 14000 },
  moms_mode: "auto", moms_total: 2800, source_meta: { kind: "typed" }, receipt_photo: null,
};

let S;
const setOnline = (on) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });
const realOffsetHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "offsetHeight");
beforeEach(() => {
  window.scrollTo = () => {};
  window.scrollBy = vi.fn();
  Element.prototype.scrollIntoView = () => {};
  window.confirm = vi.fn(() => true);
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  localStorage.clear();
  setOnline(true);
  get.mockReset();
  post.mockReset();
  del.mockReset();
});
afterEach(() => {
  setOnline(true);
  if (realOffsetHeight) Object.defineProperty(HTMLElement.prototype, "offsetHeight", realOffsetHeight);
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
const text = () => document.body.textContent;
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const fire = (name) => act(async () => { window.dispatchEvent(new Event(name)); await new Promise((r) => setTimeout(r, 0)); });
const flush = async () => {
  await fire("pagehide");
  for (let i = 0; i < 6; i++) await settle();
};
const keyIn = (el, value) => {
  if (el.value !== "") fireEvent.change(el, { target: { value: "" } });
  for (const ch of value) fireEvent.change(el, { target: { value: el.value + ch } });
};
const mount = async () => {
  const view = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
  const want = S.rows.has(KEY) ? "dcDayHasDraft" : "scanZReportTitle";
  for (let i = 0; i < 10 && !text().includes(want); i++) await settle();
  return view;
};
const shoot = async (key, name) => {
  S.nextScan = { ...BONS[key], image_url: photoUrl(name) };
  const input = [...document.querySelectorAll('input[type="file"]')].at(-1);
  fireEvent.change(input, { target: { files: [new File([name], name, { type: "image/jpeg", lastModified: 1 })] } });
  for (let i = 0; i < 6; i++) await settle();
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
const rowFor = () => S.rows.get(KEY);
/** Every save of the day dies on its way — not stored, no answer — while the browser says online. */
const deadLine = (on) => {
  if (!on) { post.mockImplementation(post.realImpl); return; }
  post.realImpl = post.realImpl || post.getMockImplementation();
  const pass = post.realImpl;
  post.mockImplementation((url, body) => (url === "/daily-close"
    ? Promise.reject(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }))
    : pass(url, body)));
};

/* ─── 1 ─────────────────────────────────────────────────────────────── */

describe("1. a figure whose save got no answer is never dropped by going back to the scan card", () => {
  it("the reviewers' T1, online: Z-bon 5.000 applied, Takeaway 5.000 typed (no answer), \"← Scan Z-bon\" — the card says \"Ikke gemt endnu\", and leaving sends the 5.000", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    expect(rowFor()).toMatchObject({ revenue_total: 5000 });
    post.realImpl = null;
    deadLine(true);
    keyIn(q("#dc-rev-takeaway"), "5.000");
    await flush();
    expect(rowFor().revenue_total).toBe(5000);
    tap(/^←\s*scanZReportBack$/);
    for (let i = 0; i < 4; i++) await settle();
    // The card shows 10.000 and says it is not saved.
    expect(q('[data-testid="dc-scan-result-date"]')).not.toBeNull();
    expect(q('[data-testid="dc-scan-unsaved"]')).not.toBeNull();
    deadLine(false);
    // Leaving (the network back, no "online" event): the typed figure goes.
    await flush();
    expect(rowFor()).toMatchObject({ revenue_total: 10000 });
    expect(rowFor().revenue_breakdown.takeaway).toBe(5000);
  });

  it("…the browser's \"online\" event sends it too, while the card is open", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    post.realImpl = null;
    deadLine(true);
    keyIn(q("#dc-rev-takeaway"), "5.000");
    await flush();
    tap(/^←\s*scanZReportBack$/);
    for (let i = 0; i < 4; i++) await settle();
    deadLine(false);
    await fire("online");
    for (let i = 0; i < 6; i++) await settle();
    expect(rowFor()).toMatchObject({ revenue_total: 10000 });
  });

  it("…left OFFLINE from the card: the draft is kept on this phone, and sent once online", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    post.realImpl = null;
    deadLine(true);
    keyIn(q("#dc-rev-takeaway"), "5.000");
    await flush();
    tap(/^←\s*scanZReportBack$/);
    for (let i = 0; i < 4; i++) await settle();
    deadLine(false);
    S.holding.offline = true;
    setOnline(false);
    await fire("offline");
    // Away to History (the form goes): the copy is kept on this phone.
    tap(/^historyTab$/);
    for (let i = 0; i < 4; i++) await settle();
    const queued = JSON.parse(localStorage.getItem(OQ_KEY) || "[]");
    expect(queued).toHaveLength(1);
    expect(queued[0].payload).toMatchObject({ date: today, revenue_breakdown: { takeaway: 5000 } });
    S.holding.offline = false;
    setOnline(true);
    await fire("online");
    for (let i = 0; i < 8; i++) await settle();
    expect(rowFor()).toMatchObject({ revenue_total: 10000 });
  });

  it("Start forfra throws it away: a draft that got no answer is never sent after the owner started over", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    post.realImpl = null;
    deadLine(true);
    keyIn(q("#dc-rev-takeaway"), "5.000");
    await flush();
    tap(/^←\s*scanZReportBack$/);
    for (let i = 0; i < 4; i++) await settle();
    deadLine(false);
    tap(/^startOver$/);
    for (let i = 0; i < 6; i++) await settle();
    expect(rowFor()).toBeUndefined();
    const n = S.posts.length;
    await flush();
    await fire("online");
    for (let i = 0; i < 6; i++) await settle();
    expect(S.posts.length).toBe(n);
    expect(rowFor()).toBeUndefined();
  });
});

/* ─── 2 ─────────────────────────────────────────────────────────────── */

describe("2. \"Kladden er gemt et andet sted\" never moves the field being typed in", () => {
  // The page's geometry, as a browser lays it out: Kort sits at `top` while
  // the question is not on the page, and `top + 341` once it is put in above
  // it — unless the browser's own scroll anchoring already kept it in place
  // (`anchored`: Chrome, Firefox, Android; iOS WebKit does not anchor).
  const realRect = Element.prototype.getBoundingClientRect;
  afterEach(() => { Element.prototype.getBoundingClientRect = realRect; });
  const layout = ({ anchored = false } = {}) => {
    Element.prototype.getBoundingClientRect = function rect() {
      if (this.id !== "dc-pay-card") return realRect.call(this);
      const shifted = !anchored && Boolean(document.querySelector('[data-testid="dc-draft-changed"]'));
      const top = 600 + (shifted ? 341 : 0);
      return { top, bottom: top + 40, left: 0, right: 300, width: 300, height: 40, x: 0, y: top, toJSON() {} };
    };
  };
  const typeWhileSavedElsewhere = async () => {
    serve([DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-pay-card");
    S.otherSave(KEY, (r) => { r.notes = "B"; });
    const kort = q("#dc-pay-card");
    act(() => { kort.focus(); });
    window.scrollBy.mockClear();
    keyIn(kort, "12.050");
    await flush();
    expect(q('[data-testid="dc-draft-changed"]')).not.toBeNull();
    return kort;
  };

  it("an autosave refused while typing in Kort (no scroll anchoring — iOS): the page scrolls by exactly how far the field moved, in the same frame — the field stays put, the caret stays", async () => {
    layout();
    const kort = await typeWhileSavedElsewhere();
    expect(window.scrollBy).toHaveBeenCalledWith(0, 341);
    expect(window.scrollBy).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(kort);
  });

  // Round 23 review — scrolling by the question's HEIGHT moved the field up
  // by that much where the browser had already kept it in place (the
  // question put in above the viewport, on the review step).
  it("…the browser already kept the field in place (scroll anchoring — Chrome, Android): no scroll on top of it", async () => {
    layout({ anchored: true });
    const kort = await typeWhileSavedElsewhere();
    expect(window.scrollBy).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(kort);
  });

  it("raised by the lock tap (nothing is being typed): brought into view as before, no compensating scroll", async () => {
    Object.defineProperty(HTMLElement.prototype, "offsetHeight", {
      configurable: true,
      get() { return this.getAttribute?.("data-testid") === "dc-draft-changed" ? 341 : 0; },
    });
    serve([DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-notes");
    S.otherSave(KEY, (r) => { r.notes = "B"; });
    window.scrollBy.mockClear();
    tap(/confirmAndLock/);
    for (let i = 0; i < 6; i++) await settle();
    expect(q('[data-testid="dc-draft-changed"]')).not.toBeNull();
    expect(window.scrollBy).not.toHaveBeenCalled();
  });
});

/* ─── 3 ─────────────────────────────────────────────────────────────── */

describe("3. a queued copy refused once online: History is read again, and the wizard says what the day is", () => {
  const refusedCopy = async (status) => {
    serve([{ ...DRAFT, status: "confirmed" }]);
    // Opened offline: History cannot be read.
    setOnline(false);
    S.holding.offline = true;
    addToOfflineQueue({ ...DRAFT, id: undefined, status: "draft", date: today, revenue_breakdown: { food: 2000 }, payment_breakdown: {}, base_updated_at: "2026-01-01T00:00:00" });
    render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    for (let i = 0; i < 6; i++) await settle();
    const pass = post.getMockImplementation();
    post.mockImplementation((url, body) => (url === "/daily-close"
      ? Promise.reject(Object.assign(new Error("refused"), { response: status === 409
        ? { status: 409, data: {} }
        : { status: 412, data: { detail: { code: "draft_changed", updated_at: "2026-10-09T09:00:00", current: { ...DRAFT } } } } }))
      : pass(url, body)));
    const reads = () => get.mock.calls.filter(([u, cfg]) => u === "/daily-close" && !cfg?.params?.from).length;
    const before = reads();
    S.holding.offline = false;
    setOnline(true);
    await fire("online");
    for (let i = 0; i < 10; i++) await settle();
    return { readAgain: reads() > before };
  };

  it("409 (locked on another device): read again — the lock banner, never \"Vi kunne ikke tjekke\"", async () => {
    const { readAgain } = await refusedCopy(409);
    expect(readAgain).toBe(true);
    await waitFor(() => expect(text()).toContain("dcDayAlreadyLocked"));
    expect(text()).not.toContain("dcLockCheckFailed");
  });

  it("412 (saved elsewhere): read again — never \"Vi kunne ikke tjekke\"", async () => {
    const { readAgain } = await refusedCopy(412);
    expect(readAgain).toBe(true);
    for (let i = 0; i < 4; i++) await settle();
    expect(text()).not.toContain("dcLockCheckFailed");
  });
});
