/**
 * Round 19 — what is STORED after Start forfra and after a date move.
 *
 * The server reads a null source_meta / receipt_photo as "keep what is
 * stored", so a payload can be right while the row is wrong. Every check
 * here reads the stub server's row (closeSequenceHarness.createServer — the
 * backend's save rule in miniature, now with the "" photo clear and DELETE).
 *
 *  3. A reopened typed draft + a summed bon, filed, then Start forfra: the
 *     row (and the lock) is "typed" again, not "Z-bon (scannet)".
 *  4. The thrown-away bon's photo leaves the row ("" clears it); a reopened
 *     Z-bon draft keeps its own photo.
 *  5. Start forfra on a photo-only day: the draft this page made for it
 *     (the photo's figures) is deleted; one it did not make stays and the
 *     day's draft banner shows it.
 *  6. "Brug dem for {to}" moves: once the new day is filed, the old day's
 *     draft this page made is deleted and the page says "Flyttet fra …"; a
 *     draft it did not make is never touched, and the page says it stays.
 *
 * Round 23 (narrowings A and C, expectations changed per test, each said):
 * Start forfra deletes the day's draft — asked first, naming it — and the
 * form starts over empty; nothing comes back and nothing is put back. A date
 * move with figures is asked before the date changes ("Flyt tallene").
 * Strings are asserted by key (t echoes key + values).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
// Round 23 — the page's questions are useConfirm dialogs: answered by
// window.confirm here, or by `confirmAnswer` ("extra" = "Hent … salg").
const asked = [];
let confirmAnswer = null;
vi.mock("../hooks/useConfirm", () => ({
  useConfirm: () => (o) => {
    asked.push(o);
    return Promise.resolve(confirmAnswer ? confirmAnswer(o) : window.confirm(typeof o === "string" ? o : o?.message));
  },
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
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const shiftIso = (iso, days) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const yesterday = shiftIso(today, -1);
const TYPED_DRAFT = {
  id: "seed1", date: today, branch_id: null, status: "draft", closed_by: "Test", notes: "Test",
  revenue_total: 14000, revenue_breakdown: { food: 9000, drinks: 5000 }, payment_breakdown: { card: 14000 },
  moms_mode: "auto", moms_total: 2800, source_meta: { kind: "typed" }, receipt_photo: null,
};

let S;
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.confirm = vi.fn(() => true);
  asked.length = 0;
  confirmAnswer = null;
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
/** Whatever save is waiting goes now (the page sends it on pagehide), and its follow-ups run. */
const flush = async () => {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
  for (let i = 0; i < 4; i++) await settle();
};
const keyIn = (el, value) => {
  if (el.value !== "") fireEvent.change(el, { target: { value: "" } });
  for (const ch of value) fireEvent.change(el, { target: { value: el.value + ch } });
};
const mount = async () => {
  const view = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
  // The day's draft (if any) is offered once History has answered.
  const want = S.rows.has(`${today}|`) ? "dcDayHasDraft" : "scanZReportTitle";
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
const toReview = async () => {
  for (let i = 0; i < 8 && !q("#dc-notes"); i++) tap(/^next\s*→$/);
  await waitFor(() => expect(q("#dc-notes")).not.toBeNull());
};
const rowFor = (date) => S.rows.get(`${date}|`);
const posted = () => S.posts.filter((b) => b.date);

describe("3. a typed close is never filed — or locked — as a Z-bon read after Start forfra", () => {
  // The reviewers' M4 path (their seeds 1175, 1329, 1539, 1254), step for step.
  it("reopened typed draft + a 3.000 bon summed and filed, then Start forfra: the row is typed again, through the lock", async () => {
    serve([TYPED_DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    await backToCard();
    await shoot("b3000", "bon3000.jpg");
    tap(/^scanSecondTotalSum/);
    tap(/^continueStepByStep$/);
    await flush();
    // The sum is filed: Z-bon, the typed till marked, the bon's photo.
    expect(rowFor(today)).toMatchObject({ revenue_total: 17000, receipt_photo: photoUrl("bon3000.jpg") });
    expect(rowFor(today).source_meta).toMatchObject({ kind: "zbon", terminal_totals: [14000, 3000], typed_tills: [0] });

    // Round 23 (expectation changed): Start forfra deletes the day's draft
    // — the summed 17.000, asked first — and the form starts over empty; the
    // close typed next is typed, through the lock.
    await backToCard();
    tap(/^startOver$/);
    await flush();
    expect(window.confirm.mock.calls.at(-1)[0]).toMatch(/^dcStartOverDeleteBody:.*\|17\.000 kr\.$/);
    expect(S.deletes).toEqual(["seed1"]);
    expect(rowFor(today)).toBeUndefined();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    expect(q("#dc-rev-food").value).toBe("");
    keyIn(q("#dc-rev-food"), "14000");
    await flush();
    expect(rowFor(today)).toMatchObject({ revenue_total: 14000, source_meta: { kind: "typed" }, receipt_photo: null });

    await toReview();
    expect(document.body.textContent).not.toContain("autoEmailPhotoToo");
    tap(/confirmAndLock/);
    await flush();
    expect(rowFor(today)).toMatchObject({ status: "confirmed", revenue_total: 14000, source_meta: { kind: "typed" }, receipt_photo: null });
  });

  it("nothing filed from a photo this session: a reopened draft still sends no source (the server keeps its own)", async () => {
    serve([TYPED_DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "9.500");
    await flush();
    expect(posted().at(-1).source_meta).toBeNull();
    expect(posted().at(-1).receipt_photo).toBeNull();
    expect(rowFor(today).source_meta).toEqual({ kind: "typed" });
  });
});

describe("4. the thrown-away bon's photo leaves the close", () => {
  // The reviewers' M4b repro (51 of their 650 sequences).
  it("typed 14.000 + a 3.000 bon filed, then Start forfra: receipt_photo cleared (\"\"), kind typed", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "14000");
    await flush();
    await backToCard();
    await shoot("b3000", "bon3000.jpg");
    tap(/^scanSecondTotalSum/);
    tap(/^continueStepByStep$/);
    await flush();
    expect(rowFor(today).receipt_photo).toBe(photoUrl("bon3000.jpg"));

    // Round 23 (expectation changed): Start forfra deletes the draft — the
    // bon's photo with it — and the close typed next is a new one: typed, no
    // photo, and "" is never sent for a photo that is not there (U6).
    await backToCard();
    tap(/^startOver$/);
    await flush();
    expect(S.deletes).toHaveLength(1);
    expect(rowFor(today)).toBeUndefined();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "14000");
    await flush();
    expect(posted().at(-1).receipt_photo).toBeNull();
    expect(rowFor(today)).toMatchObject({ revenue_total: 14000, source_meta: { kind: "typed" }, receipt_photo: null });
    // No flip-flop: a step with no change sends nothing.
    const n = S.posts.length;
    tap(/^next\s*→$/);
    await flush();
    expect(S.posts.length).toBe(n);
    tap(/^←\s*back$/);
    keyIn(q("#dc-rev-drinks"), "500");
    await flush();
    expect(posted().at(-1).receipt_photo).toBeNull();
    expect(rowFor(today).receipt_photo).toBeNull();
  });

  // Round 23 (expectation changed): Start forfra deletes the reopened draft
  // — its own photo with it — asked first, naming the summed 20.030; nothing
  // is given back (the form starts over empty).
  it("a reopened Z-bon draft with its own photo: Start forfra after a second bon deletes it, asked first — nothing given back", async () => {
    serve([{
      ...TYPED_DRAFT, revenue_total: 17030, revenue_breakdown: { food: 9000, drinks: 6000, takeaway: 2030 },
      payment_breakdown: { card: 12000, cash: 5030 }, moms_mode: "manual", moms_total: 3406,
      source_meta: { kind: "zbon", scans: 1, corrected: [] }, receipt_photo: "u1/kasserapport/own.jpg",
    }]);
    await mount();
    tap(/^dcContinueDraft$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    await backToCard();
    await shoot("b3000", "bon3000.jpg");
    tap(/^scanSecondTotalSum/);
    tap(/^continueStepByStep$/);
    await flush();
    expect(rowFor(today).revenue_total).toBe(20030);
    await backToCard();
    tap(/^startOver$/);
    await flush();
    expect(window.confirm.mock.calls.at(-1)[0]).toMatch(/^dcStartOverDeleteBody:.*\|20\.030 kr\.$/);
    expect(S.deletes).toEqual(["seed1"]);
    expect(rowFor(today)).toBeUndefined();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    expect(q("#dc-rev-food").value).toBe("");
  });
});

describe("5. Start forfra on a photo-only day takes the photo's draft back", () => {
  // The reviewers' M6 repro (24 of their sequences).
  it("a 5.000 bon filed as this page's new draft, then Start forfra: the draft is deleted, nothing is offered on return", async () => {
    serve();
    const view = await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    const id = rowFor(today).id;
    expect(rowFor(today)).toMatchObject({ revenue_total: 5000, source_meta: { kind: "zbon" }, receipt_photo: photoUrl("bon5000.jpg") });

    await backToCard();
    tap(/^startOver$/);
    await flush();
    expect(S.deletes).toEqual([id]);
    expect(rowFor(today)).toBeUndefined();
    expect(document.body.textContent).not.toContain("dcDayHasDraft");
    // Nothing is filed for the empty day.
    const before = S.posts.length;
    await flush();
    expect(S.posts.length).toBe(before);

    view.unmount();
    await settle();
    await mount();
    expect(document.body.textContent).not.toContain("dcDayHasDraft");
    expect(document.body.textContent).toContain("scanZReportTitle");
  });

  // Round 23 (expectation changed): the banner's Start forfra deletes the
  // draft (asked first) instead of replacing it — so there is nothing to put
  // back; the photo's own new draft is deleted by the card's Start forfra.
  it("the banner's Start forfra deletes the draft; a photo then filed is the day's new draft, and Start forfra deletes that — nothing stays", async () => {
    serve([TYPED_DRAFT]);
    await mount();
    tap(/^dcStartOverDraft$/);
    await flush();
    expect(window.confirm.mock.calls.at(-1)[0]).toMatch(/^dcStartOverDeleteBody:.*\|14\.000 kr\.$/);
    expect(S.deletes).toEqual(["seed1"]);
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    expect(rowFor(today)).toMatchObject({ revenue_total: 5000 });
    await backToCard();
    tap(/^startOver$/);
    await flush();
    expect(S.deletes).toHaveLength(2);
    expect(rowFor(today)).toBeUndefined();
    expect(document.body.textContent).not.toContain("dcDayHasDraft");
  });

  // Round 23 (expectation changed): a filed draft is deleted only when the
  // owner says so — Start forfra is asked whenever something is stored for
  // the day, naming it (an untouched photo NOT filed yet still goes in one
  // tap: "simply clears the form").
  it("a photo's draft filed: Start forfra asks, naming its 5.000 — an unfiled untouched photo still goes in one tap", async () => {
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    await backToCard();
    window.confirm.mockClear();
    tap(/^startOver$/);
    await flush();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.confirm.mock.calls[0][0]).toMatch(/^dcStartOverDeleteBody:.*\|5\.000 kr\.$/);
    expect(S.deletes).toHaveLength(1);
    // Nothing filed: one tap, no question, no request.
    await shoot("b5000", "bon5000b.jpg");
    window.confirm.mockClear();
    tap(/^startOver$/);
    await flush();
    expect(window.confirm).not.toHaveBeenCalled();
    expect(S.deletes).toHaveLength(1);
    expect(document.body.textContent).toContain("scanZReportTitle");
  });
});

describe("6. \"Brug dem for {to}\" moves the figures, never copies them", () => {
  // The reviewers' directed date-move probe.
  it("14.000 typed for today (autosaved), date → yesterday, \"Brug dem\": yesterday holds them, today's draft is deleted, \"Flyttet fra\"", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "14000");
    await flush();
    const todayId = rowFor(today).id;
    // Round 23 (C): asked before the date changes — answered no, nothing is
    // filed for yesterday and the form stays; then "Flyt tallene".
    window.confirm.mockReturnValueOnce(false);
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    await flush();
    expect(asked.at(-1).title).toMatch(/^dcMoveConfirmTitle/);
    expect(asked.at(-1).message).toMatch(/^dcMoveConfirmBody:/);
    expect(rowFor(yesterday)).toBeUndefined();
    expect(q("#close-date").value).toBe(today);
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    await flush();
    expect(rowFor(yesterday)).toMatchObject({ status: "draft", revenue_total: 14000 });
    expect(rowFor(today)).toBeUndefined();
    expect(S.deletes).toEqual([todayId]);
    expect(q('[data-testid="dc-date-moved"]').textContent).toMatch(/^dcDateMovedFrom:/);
    // Back to today in the same session: no draft there, nothing offered.
    expect(document.body.textContent).not.toContain("dcDayHasDraft");
  });

  it("the old day's draft is deleted only once the new day is filed", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "14000");
    await flush();
    // The new day's save fails: the old day's draft stays where it is.
    const realPost = post.getMockImplementation();
    post.mockImplementation((url, body) => (url === "/daily-close" && body.date === yesterday
      ? Promise.reject(Object.assign(new Error("offline"), {})) : realPost(url, body)));
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    await flush();
    expect(rowFor(yesterday)).toBeUndefined();
    expect(rowFor(today)).toMatchObject({ revenue_total: 14000 });
    expect(S.deletes).toEqual([]);
    // (Round 23: said — the old day still has its draft, never "moved".
    // Round 23 review: nothing is stored for yesterday, so never "Kopieret
    // til" either — "Ikke gemt for {to} endnu", and no "Slet den".)
    expect(q('[data-testid="dc-date-moved"]').textContent).toMatch(/^dcDateMovedNotSavedYet:/);
    expect(btn(/^dcDateMovedDeleteOld$/)).toBeFalsy();
    // Back online: the next change files yesterday, then today's goes.
    post.mockImplementation(realPost);
    keyIn(q("#dc-rev-drinks"), "100");
    await flush();
    expect(rowFor(yesterday)).toMatchObject({ revenue_total: 14100 });
    expect(rowFor(today)).toBeUndefined();
  });

  // Round 23 (expectation changed): the banner's Start forfra deletes the
  // draft (asked first) — nothing is replaced, so the move takes the page's
  // own new draft off the old day: "Flyttet fra".
  it("after the banner's Start forfra (the draft deleted), a move of the figures typed next moves them: \"Flyttet fra\"", async () => {
    serve([TYPED_DRAFT]);
    await mount();
    tap(/^dcStartOverDraft$/);
    await flush();
    expect(S.deletes).toEqual(["seed1"]);
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "12000");
    await flush();
    expect(rowFor(today)).toMatchObject({ revenue_total: 12000 });
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    await flush();
    expect(rowFor(yesterday)).toMatchObject({ revenue_total: 12000 });
    expect(rowFor(today)).toBeUndefined();
    expect(q('[data-testid="dc-date-moved"]').textContent).toMatch(/^dcDateMovedFrom:/);
  });

  it("\"Hent … salg\" is not a move: the old day's figures and draft stay that day's", async () => {
    serve();
    S.syncedDates.add(yesterday);
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "14000");
    await flush();
    // (Round 23: "Hent … salg" is the move question's third answer.)
    confirmAnswer = () => "extra";
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    for (let i = 0; i < 4; i++) await settle();
    await flush();
    expect(asked.at(-1).extraLabel).toMatch(/^dcDateMoveFetch/);
    expect(rowFor(today)).toMatchObject({ revenue_total: 14000 });
    expect(S.deletes).toEqual([]);
    expect(q('[data-testid="dc-date-moved"]')).toBeNull();
  });
});
