/**
 * Round 19 review — what the page takes off a day, and when.
 *
 *  1. A Start forfra or a date move waits for the saves on their way, then
 *     takes the day's draft back only if nothing was filed for the day since
 *     (an older answer never undoes a newer action): a new bon applied, or a
 *     move back, while a slow save was on its way.
 *  2. A second date change before the first new day is filed: the figures
 *     are still the first day's — that day's draft goes, and the note names it.
 *  3. A Z-bon's day moved (no question): moved, not copied — the old day's
 *     draft (with the bon's photo) goes once the new day is filed.
 *  9. Start forfra on a photo-only day, then figures typed while the photo's
 *     save is still on its way: the owner's figures are stored (no delete),
 *     typed, with no photo.
 * 11. "Brug dem", another date inside the 2 s, then "Hent … salg": nothing
 *     moved — the first day's draft stays.
 * 12. Start forfra on a photo-only day: the day's draft banner never shows
 *     the draft being deleted while the DELETE is on its way.
 * 14. With a branch: a day deleted by Start forfra is filed again (the
 *     server takes the deleted row back under the same id) and stays the
 *     page's own.
 * Every check reads the stub server's rows (closeSequenceHarness.createServer,
 * now with held requests: a slow network, in the order sent).
 */
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso, dateLocale } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
const branch = vi.hoisted(() => ({ id: null }));
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
  useBranch: () => ({ branchId: branch.id, branchType: "restaurant", hasMultiBranch: false, branches: [] }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const { BONS, createServer, installApi, photoUrl } = await import("../test/closeSequenceHarness");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const shiftIso = (iso, days) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const yesterday = shiftIso(today, -1);
const twoDaysAgo = shiftIso(today, -2);
const short = (iso) => new Date(`${iso}T12:00:00`).toLocaleDateString(dateLocale(), { day: "numeric", month: "short" });

let S;
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.confirm = vi.fn(() => true);
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  del.mockReset();
  branch.id = null;
});
const serve = (rows = [], synced = []) => {
  S = createServer({ rows: rows.map((r) => ({ ...r })), syncedDates: synced });
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
/** Whatever save is waiting goes now (pagehide), and its follow-ups run. */
const flush = async () => {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
  for (let i = 0; i < 4; i++) await settle();
};
/** The slow network delivers: everything held arrives, in the order sent. */
const arrive = async () => {
  for (let i = 0; i < 6 && S.held.length; i++) {
    await act(async () => { S.releaseHeld(); await new Promise((r) => setTimeout(r, 0)); });
    await settle();
  }
  for (let i = 0; i < 4; i++) await settle();
};
const slow = (on) => { S.holding.post = on; S.holding.del = on; };
const keyIn = (el, value) => {
  if (el.value !== "") fireEvent.change(el, { target: { value: "" } });
  for (const ch of value) fireEvent.change(el, { target: { value: el.value + ch } });
};
const mount = async () => {
  const view = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
  const want = [...S.rows.keys()].some((k) => k.startsWith(`${today}|`)) ? "dcDayHasDraft" : "scanZReportTitle";
  for (let i = 0; i < 10 && !document.body.textContent.includes(want); i++) await settle();
  return view;
};
const shoot = async (key, name) => {
  S.nextScan = { ...BONS[key], image_url: photoUrl(name) };
  const input = [...document.querySelectorAll('input[type="file"]')].at(-1);
  fireEvent.change(input, { target: { files: [new File([name], name, { type: "image/jpeg", lastModified: 1 })] } });
  await waitFor(() => expect(q('[data-testid="dc-scan-result-date"]')).not.toBeNull());
};
const backToCard = async () => {
  for (let i = 0; i < 8 && !q("#dc-rev-food"); i++) tap(/^←\s*back$/);
  tap(/^←\s*scanZReportBack$/);
  await settle();
};
const rowFor = (date, b = "") => S.rows.get(`${date}|${b}`);
const typed14000 = async () => {
  tap(/^skipEnterManually$/);
  await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
  keyIn(q("#dc-rev-food"), "14000");
};
const moveTo = async (iso) => {
  fireEvent.change(q("#close-date"), { target: { value: iso } });
  for (let i = 0; i < 3; i++) await settle();
};

describe("1. a draft is taken back only if nothing was filed for the day since", () => {
  it("(a) photo-only day, a slow save on its way, Start forfra, a new 3.000 bon applied: the 3.000 stays stored", async () => {
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    expect(rowFor(today)).toMatchObject({ revenue_total: 5000 });
    // A box edited, its save slow.
    slow(true);
    keyIn(q("#dc-rev-food"), "3600");
    await flush();
    slow(false);
    await backToCard();
    tap(/^startOver$/);
    await settle();
    await shoot("b3000", "bon3000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    await arrive();
    await flush();
    // The new bon is the day's draft; nothing deleted it.
    expect(S.deletes).toEqual([]);
    expect(rowFor(today)).toMatchObject({ revenue_total: 3000, receipt_photo: photoUrl("bon3000.jpg") });
    expect(document.body.textContent).not.toContain("dcDayHasDraft");
  });

  it("(b) today 14.000 with a slow save; to yesterday (Brug dem), back to today (Brug dem): today keeps 14.000, yesterday's copy goes", async () => {
    serve();
    // Only today's first save is slow (the reviewers' probe): yesterday's
    // answers at once.
    const real = post.getMockImplementation();
    const heldToday = [];
    let holdToday = true;
    post.mockImplementation((url, body) => (url === "/daily-close" && body.date === today && holdToday
      ? (holdToday = false, new Promise((res, rej) => heldToday.push(() => real(url, body).then(res, rej))))
      : real(url, body)));
    await mount();
    await typed14000();
    await flush();
    expect(heldToday).toHaveLength(1);
    await moveTo(yesterday);
    tap(/^dcDateMoveKeep/);
    await flush();
    // Yesterday is filed; today's release waits on today's slow save.
    expect(rowFor(yesterday)).toMatchObject({ revenue_total: 14000 });
    await moveTo(today);
    tap(/^dcDateMoveKeep/);
    await flush();
    await act(async () => { heldToday.splice(0).forEach((go) => go()); await new Promise((r) => setTimeout(r, 0)); });
    await flush();
    await flush();
    expect(rowFor(today)).toMatchObject({ revenue_total: 14000, status: "draft" });
    expect(rowFor(yesterday)).toBeUndefined();
  });
});

describe("2 + 11. a second date change before the first new day is filed", () => {
  it("Brug dem, another date inside the 2 s, Brug dem: the first day's draft goes, the note names it", async () => {
    serve();
    await mount();
    await typed14000();
    await flush();
    const todayId = rowFor(today).id;
    await moveTo(yesterday);
    tap(/^dcDateMoveKeep/);
    await settle();
    // Inside the debounce: nothing is filed for yesterday yet.
    await moveTo(twoDaysAgo);
    expect(q('[data-testid="dc-date-move"]')).not.toBeNull();
    tap(/^dcDateMoveKeep/);
    await flush();
    expect(rowFor(twoDaysAgo)).toMatchObject({ revenue_total: 14000 });
    expect(rowFor(yesterday)).toBeUndefined();
    expect(rowFor(today)).toBeUndefined();
    expect(S.deletes).toEqual([todayId]);
    expect(q('[data-testid="dc-date-moved"]').textContent).toBe(`dcDateMovedFrom:${short(today)}`);
  });

  it("Brug dem, another date inside the 2 s, \"Hent … salg\": nothing moved — the first day's 14.000 stays", async () => {
    serve([], [twoDaysAgo]);
    await mount();
    await typed14000();
    await flush();
    await moveTo(yesterday);
    tap(/^dcDateMoveKeep/);
    await settle();
    await moveTo(twoDaysAgo);
    for (let i = 0; i < 4; i++) await settle();
    tap(/^dcDateMoveFetch/);
    await flush();
    // Change something on the synced day so it is filed.
    keyIn(q("#dc-rev-takeaway"), "100");
    await flush();
    expect(rowFor(twoDaysAgo)).toBeTruthy();
    expect(rowFor(today)).toMatchObject({ revenue_total: 14000, status: "draft" });
    expect(S.deletes).toEqual([]);
    expect(q('[data-testid="dc-date-moved"]')).toBeNull();
  });
});

describe("4. a move whose old-day delete does not go through says so", () => {
  it("14.000 typed for today, DELETE refused, \"Brug dem\" for yesterday: \"kladden for i dag har stadig de samme tal\"", async () => {
    serve();
    await mount();
    await typed14000();
    await flush();
    del.mockImplementation(() => Promise.reject(Object.assign(new Error("offline"), {})));
    await moveTo(yesterday);
    tap(/^dcDateMoveKeep/);
    await flush();
    expect(rowFor(yesterday)).toMatchObject({ revenue_total: 14000 });
    expect(rowFor(today)).toMatchObject({ revenue_total: 14000 });
    // Never "er stadig gemt" for a draft that holds the moved figures.
    expect(q('[data-testid="dc-date-moved"]').textContent).toMatch(/^dcDateMovedOldHolds:/);
  });
});

describe("3. a Z-bon's day moved with no question is moved, not copied", () => {
  it("b5000 applied and filed for today, date → yesterday: yesterday holds it, today's draft (and its photo) goes", async () => {
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    const todayId = rowFor(today).id;
    await moveTo(yesterday);
    // A card: no question.
    expect(q('[data-testid="dc-date-move"]')).toBeNull();
    await flush();
    expect(rowFor(yesterday)).toMatchObject({ revenue_total: 5000, receipt_photo: photoUrl("bon5000.jpg") });
    expect(rowFor(today)).toBeUndefined();
    expect(S.deletes).toEqual([todayId]);
    expect(q('[data-testid="dc-date-moved"]').textContent).toBe(`dcDateMovedFrom:${short(today)}`);
  });

  it("nothing filed for the old day (moved before its save went): nothing to take off, no note", async () => {
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await moveTo(yesterday);
    await flush();
    expect(rowFor(yesterday)).toMatchObject({ revenue_total: 5000 });
    expect(rowFor(today)).toBeUndefined();
    expect(S.deletes).toEqual([]);
  });
});

describe("9. figures typed while the thrown-away photo's save is on its way", () => {
  it("photo-only day, Start forfra, Mad 7.000 typed — both saves slow: 7.000 is stored, typed, no photo, nothing deleted", async () => {
    serve();
    await mount();
    await shoot("b3000", "bon3000.jpg");
    slow(true);
    tap(/^continueStepByStep$/);
    await flush();
    expect(S.held.length).toBe(1);
    await backToCard();
    tap(/^startOver$/);
    await settle();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "7000");
    await flush();
    slow(false);
    await arrive();
    await flush();
    expect(S.deletes).toEqual([]);
    expect(rowFor(today)).toMatchObject({
      revenue_total: 7000, revenue_breakdown: { food: 7000 }, receipt_photo: null, source_meta: { kind: "typed" },
    });
    // Leaving and coming back: the 7.000 is the day's draft.
    expect(document.body.textContent).not.toContain("dcDayHasDraft");
  });
});

describe("12. no draft banner over the draft being deleted", () => {
  it("Start forfra on a photo-only day with the DELETE on its way: \"already a draft\" never shows", async () => {
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    await backToCard();
    S.holding.del = true;
    tap(/^startOver$/);
    for (let i = 0; i < 6; i++) {
      await settle();
      expect(document.body.textContent).not.toContain("dcDayHasDraft");
    }
    expect(S.held.length).toBe(1);
    S.holding.del = false;
    await arrive();
    expect(S.deletes).toHaveLength(1);
    expect(document.body.textContent).not.toContain("dcDayHasDraft");
  });

  it("the DELETE refused: the draft is still the day's, and the banner says so", async () => {
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    await backToCard();
    del.mockImplementation(() => Promise.reject(Object.assign(new Error("offline"), {})));
    tap(/^startOver$/);
    await flush();
    expect(rowFor(today)).toMatchObject({ revenue_total: 5000 });
    expect(document.body.textContent).toContain("dcDayHasDraftBody:5.000 kr.");
  });
});

describe("14. with a branch: a deleted day is filed again, and stays the page's own", () => {
  it("Start forfra deletes the photo's draft, Mad 7.000 is filed under the same row and branch; a second Start forfra deletes it again", async () => {
    branch.id = "b1";
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    const id = rowFor(today, "b1").id;
    expect(rowFor(today, "b1")).toMatchObject({ branch_id: "b1", revenue_total: 5000 });
    await backToCard();
    tap(/^startOver$/);
    await flush();
    expect(S.deletes).toEqual([id]);
    // Filed again: the server takes the deleted row back (same id).
    await shoot("b3000", "bon3000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    expect(rowFor(today, "b1")).toMatchObject({ id, branch_id: "b1", revenue_total: 3000 });
    expect(document.body.textContent).not.toContain("dcDayHasDraft");
    await backToCard();
    tap(/^startOver$/);
    await flush();
    expect(S.deletes).toEqual([id, id]);
    expect(rowFor(today, "b1")).toBeUndefined();
    expect(document.body.textContent).not.toContain("dcDayHasDraft");
  });
});
