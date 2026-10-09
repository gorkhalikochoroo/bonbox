/**
 * Round 23 review — the reviewers' findings on the simplified model, each
 * pinned against the stub server (closeSequenceHarness.createServer — the
 * backend's save and version-checked DELETE in miniature).
 *
 *  1. Start forfra after a save that got no answer never deletes ANOTHER
 *     writer's draft on History's version: a row written last by a save with
 *     no id (another visit's or phone's queued copy), or whose writer could
 *     not be checked (no last_save_id), is deleted only on a version this
 *     form holds — else refused and kept, and said. The question names the
 *     draft as stored when it is the form's own.
 *  2. A move whose new day's save is unconfirmed: never "Kopieret til", never
 *     "Slet den" (the old draft may be the only stored copy) — "Ikke gemt for
 *     {to} endnu — intet er slettet for {from}", with "Prøv igen"; its answer
 *     finishes the move.
 *  4. Start forfra refused (saved on another device meanwhile, or locked
 *     there): said under the banner, with what the draft holds now.
 *  6. The page's gray "Snap your Z-report" says why on screen offline.
 *  7. A date typed with the keyboard is asked about once — on Enter, leaving
 *     the field, or a pause — never on every segment; a year typed digit by
 *     digit never moves the day; the question names the year when it differs.
 *  8. What Start forfra said is said only under that day's draft.
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
// The page's questions (useConfirm): recorded, and answered by `answer`.
const asked = [];
let answer = () => true;
vi.mock("../hooks/useConfirm", () => ({
  useConfirm: () => (o) => { asked.push(o); return Promise.resolve(answer(o)); },
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

const { BONS, NO_ROW_BASE, createServer, installApi, photoUrl } = await import("../test/closeSequenceHarness");
const { addToOfflineQueue } = await import("../utils/dailyCloseQueue");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const shiftIso = (iso, days) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const yesterday = shiftIso(today, -1);
const KEY = `${today}|`;
const DRAFT = {
  id: "seed1", date: today, branch_id: null, status: "draft", closed_by: "Test", notes: "Test",
  revenue_total: 14000, revenue_breakdown: { food: 9000, drinks: 5000 }, payment_breakdown: { card: 14000 },
  moms_mode: "auto", moms_total: 2800, source_meta: { kind: "typed" }, receipt_photo: null,
};

let S;
const setOnline = (on) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });
beforeEach(() => {
  window.scrollTo = () => {};
  window.scrollBy = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  localStorage.clear();
  setOnline(true);
  asked.length = 0;
  answer = () => true;
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
const rowFor = (day = today) => S.rows.get(`${day}|`);
/**
 * A dead line while the browser says online: every save the FORM sends (it
 * carries a save_id) dies on its way — never stored, no answer. (`only`:
 * just the saves for that day.) A copy the offline queue sends has no save_id
 * and gets through — another visit's queued copy, synced by this page.
 */
const deadLine = (on, { only = null } = {}) => {
  if (!post.realImpl) post.realImpl = post.getMockImplementation();
  const pass = post.realImpl;
  if (!on) { post.mockImplementation(pass); return; }
  post.mockImplementation((url, body) => (url === "/daily-close" && body?.save_id && (!only || body.date === only)
    ? Promise.reject(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }))
    : pass(url, body)));
};
const typedDeadThenScanned = async () => {
  serve();
  post.realImpl = null;
  await mount();
  tap(/^skipEnterManually$/);
  await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
  deadLine(true);
  keyIn(q("#dc-rev-food"), "3.000");
  await flush();
  expect(rowFor()).toBeUndefined();
  // "← Scan Z-bon" (the browser is online), a bon summed with the typed till.
  tap(/^←\s*scanZReportBack$/);
  for (let i = 0; i < 4; i++) await settle();
  await shoot("b5000", "b5000.jpg");
  tap(/^scanSecondTotalSum/);
  for (let i = 0; i < 4; i++) await settle();
  expect(q('[data-testid="dc-scan-result-date"]')).not.toBeNull();
};

/* ─── 1 ─────────────────────────────────────────────────────────────── */

describe("1. Start forfra after a save that got no answer never deletes another writer's draft", () => {
  it("the reviewers' repro: 3.000 typed on a dead line, a bon scanned, another visit's queued copy files the day at 8.000 (no save id) and History lists it — the card's Start forfra is refused, 8.000 is kept and said", async () => {
    await typedDeadThenScanned();
    // Another visit's copy on this phone's queue (no save_id), synced now.
    addToOfflineQueue({ date: today, branch_id: null, status: "draft", revenue_breakdown: { food: 8000 }, payment_breakdown: { card: 8000 }, base_updated_at: NO_ROW_BASE });
    await fire("online");
    for (let i = 0; i < 8; i++) await settle();
    const b = rowFor();
    expect(b).toMatchObject({ status: "draft", revenue_total: 8000 });
    expect(S.lastSaveId.get(KEY)).toBeNull();
    tap(/^startOver$/);
    for (let i = 0; i < 8; i++) await settle();
    // Asked about the form's own figures — and the server kept the other one.
    expect(asked.at(-1).message).toMatch(/^dcStartOverDeleteBody:/);
    for (const [, cfg] of del.mock.calls) expect(cfg.params.base_updated_at).toBe(NO_ROW_BASE);
    expect(rowFor()).toMatchObject({ status: "draft", revenue_total: 8000 });
    expect(S.deletes).toEqual([]);
    expect(text()).toContain("dcDayHasDraftBody:8.000 kr.");
    expect(q('[data-testid="dc-start-over-failed"]').textContent).toContain("dcStartOverNotDeletedChanged:8.000 kr.");
  });

  it("…the same when who wrote it last could not be checked (the day read has no last_save_id): \"couldn't check\" is never \"delete\"", async () => {
    await typedDeadThenScanned();
    addToOfflineQueue({ date: today, branch_id: null, status: "draft", revenue_breakdown: { food: 8000 }, payment_breakdown: { card: 8000 }, base_updated_at: NO_ROW_BASE });
    await fire("online");
    for (let i = 0; i < 8; i++) await settle();
    // (Written with an id this time — another phone's own save — but the
    // audit read fails: the day comes back with no last_save_id at all.)
    S.lastSaveId.set(KEY, "other-device");
    S.saveIdUnknown = true;
    tap(/^startOver$/);
    for (let i = 0; i < 8; i++) await settle();
    expect(rowFor()).toMatchObject({ status: "draft", revenue_total: 8000 });
    expect(S.deletes).toEqual([]);
    expect(q('[data-testid="dc-start-over-failed"]').textContent).toContain("dcStartOverNotDeletedChanged");
  });

  it("the form's own version is still deleted: an earlier save of its own landed, the last one never did — the question names the draft as STORED, and it goes", async () => {
    serve();
    post.realImpl = null;
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "3.000");
    await flush();
    expect(rowFor()).toMatchObject({ revenue_total: 3000 });
    deadLine(true);
    keyIn(q("#dc-rev-drinks"), "1.000");
    await flush();
    expect(rowFor()).toMatchObject({ revenue_total: 3000 });
    tap(/^←\s*scanZReportBack$/);
    for (let i = 0; i < 4; i++) await settle();
    await shoot("b5000", "b5000.jpg");
    tap(/^scanSecondTotalSum/);
    for (let i = 0; i < 4; i++) await settle();
    // The line is back (nothing re-sent yet): 3.000 is what is stored.
    deadLine(false);
    expect(rowFor()).toMatchObject({ revenue_total: 3000 });
    tap(/^startOver$/);
    for (let i = 0; i < 8; i++) await settle();
    // 3.000 is stored (never the 4.000 the form last sent): that is named.
    expect(asked.at(-1).message).toMatch(/^dcStartOverDeleteBody:.+\|3\.000 kr\.$/);
    expect(rowFor()).toBeUndefined();
    expect(text()).toContain("scanZReportTitle");
  });
});

/* ─── 2 / 3 ─────────────────────────────────────────────────────────── */

describe("2. a move whose new day's save is unconfirmed: never \"Kopieret\", never \"Slet den\"", () => {
  it("14.000 filed for today, the line drops (browser online), moved to yesterday: the new day's save gets no answer and the day read shows nothing — \"Ikke gemt for {to} endnu\", no \"Slet den\", no DELETE; \"Prøv igen\" once the line is back: moved, \"Flyttet fra\"", async () => {
    serve();
    post.realImpl = null;
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "14000");
    await flush();
    const todayRow = rowFor();
    expect(todayRow).toMatchObject({ revenue_total: 14000 });
    deadLine(true, { only: yesterday });
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    for (let i = 0; i < 8; i++) await settle();
    expect(asked.at(-1).title).toMatch(/^dcMoveConfirmTitle:/);
    expect(rowFor(yesterday)).toBeUndefined();
    const note = q('[data-testid="dc-date-moved"]');
    expect(note.getAttribute("data-state")).toBe("pending");
    expect(note.textContent).toMatch(/^dcDateMovedNotSavedYet:/);
    expect(note.textContent).not.toContain("dcDateMovedCopied");
    expect(btn(/^dcDateMovedDeleteOld$/)).toBeFalsy();
    expect(del).not.toHaveBeenCalled();
    expect(rowFor()).toMatchObject({ revenue_total: 14000 });
    // The line is back by itself (no "online" event): one tap sends it.
    deadLine(false);
    tap(/^dcDateMovedRetry$/);
    for (let i = 0; i < 8; i++) await settle();
    expect(rowFor(yesterday)).toMatchObject({ status: "draft", revenue_total: 14000 });
    expect(del).toHaveBeenCalledWith(`/daily-close/${todayRow.id}`, expect.anything());
    expect(rowFor()).toBeUndefined();
    expect(q('[data-testid="dc-date-moved"]').textContent).toMatch(/^dcDateMovedFrom:/);
  });

  it("…offline: the same line (nothing copied, nothing deleted), \"Prøv igen\" gray; online again the move finishes by itself", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "3000");
    await flush();
    S.holding.offline = true;
    setOnline(false);
    await fire("offline");
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    for (let i = 0; i < 8; i++) await settle();
    expect(q('[data-testid="dc-date-moved"]').textContent).toMatch(/^dcDateMovedNotSavedYet:/);
    expect(btn(/^dcDateMovedRetry$/).disabled).toBe(true);
    expect(btn(/^dcDateMovedDeleteOld$/)).toBeFalsy();
    S.holding.offline = false;
    setOnline(true);
    await fire("online");
    for (let i = 0; i < 8; i++) await settle();
    expect(rowFor(yesterday)).toMatchObject({ revenue_total: 3000 });
    expect(rowFor()).toBeUndefined();
    expect(q('[data-testid="dc-date-moved"]').textContent).toMatch(/^dcDateMovedFrom:/);
  });
});

/* ─── 4 / 8 ─────────────────────────────────────────────────────────── */

describe("4. Start forfra the server did not do is said — and only under that day's draft", () => {
  it("412 — saved on another phone meanwhile: \"Ikke slettet — … (nu 15.000 kr.)\" under the banner that shows it", async () => {
    serve([DRAFT]);
    await mount();
    S.otherSave(KEY, (r) => { r.revenue_total = 15000; r.revenue_breakdown = { food: 10000, drinks: 5000 }; });
    tap(/^dcStartOverDraft$/);
    for (let i = 0; i < 8; i++) await settle();
    expect(rowFor()).toMatchObject({ revenue_total: 15000 });
    expect(text()).toContain("dcDayHasDraftBody:15.000 kr.");
    const line = q('[data-testid="dc-start-over-failed"]');
    expect(line.getAttribute("data-outcome")).toBe("changed");
    expect(line.textContent).toContain("dcStartOverNotDeletedChanged:15.000 kr.");
  });

  it("409 — locked on another device: \"Ikke slettet — dagen blev låst på en anden enhed\"", async () => {
    serve([DRAFT]);
    await mount();
    S.otherLock(KEY);
    tap(/^dcStartOverDraft$/);
    for (let i = 0; i < 8; i++) await settle();
    expect(rowFor()).toMatchObject({ status: "confirmed" });
    await waitFor(() => expect(q('[data-testid="dc-start-over-failed"]')?.textContent).toContain("dcStartOverNotDeletedLocked"));
  });

  it("a draft loaded since (\"Fortsæt kladden\"): what Start forfra said before is not said over it", async () => {
    serve([DRAFT]);
    await mount();
    S.holding.offline = true;
    tap(/^dcStartOverDraft$/);
    for (let i = 0; i < 8; i++) await settle();
    S.holding.offline = false;
    expect(q('[data-testid="dc-start-over-failed"]').textContent).toContain("dcStartOverNotDeletedOffline");
    tap(/^dcContinueDraft$/);
    await waitFor(() => expect(q("#dc-rev-food")?.value).toBe("9.000"));
    expect(q('[data-testid="dc-start-over-failed"]')).toBeNull();
  });

  it("said under yesterday's banner; the form moved to today and back: yesterday's banner no longer says it (never under another day's either)", async () => {
    serve([{ ...DRAFT, id: "y1", date: yesterday, revenue_total: 800, revenue_breakdown: { food: 800 }, payment_breakdown: { card: 800 } }]);
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#close-date")).not.toBeNull());
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    for (let i = 0; i < 6; i++) await settle();
    expect(text()).toContain("dcDayHasDraftBody:800 kr.");
    S.holding.offline = true;
    tap(/^dcStartOverDraft$/);
    for (let i = 0; i < 8; i++) await settle();
    S.holding.offline = false;
    expect(q('[data-testid="dc-start-over-failed"]')).not.toBeNull();
    fireEvent.change(q("#close-date"), { target: { value: today } });
    for (let i = 0; i < 6; i++) await settle();
    expect(q('[data-testid="dc-start-over-failed"]')).toBeNull();
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    for (let i = 0; i < 6; i++) await settle();
    expect(text()).toContain("dcDayHasDraftBody:800 kr.");
    expect(q('[data-testid="dc-start-over-failed"]')).toBeNull();
  });
});

/* ─── 6 ─────────────────────────────────────────────────────────────── */

describe("6. offline, the page's gray \"Snap your Z-report\" says why on screen", () => {
  it("History cannot be read offline: the card shows; its scan button is gray and the reason is a visible line it points at", async () => {
    serve();
    setOnline(false);
    S.holding.offline = true;
    render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    for (let i = 0; i < 8; i++) await settle();
    const snap = btn(/^closeScanCta$/);
    expect(snap).toBeTruthy();
    expect(snap.disabled).toBe(true);
    expect(snap.getAttribute("aria-describedby")).toBe("dc-hero-scan-offline");
    const why = q("#dc-hero-scan-offline");
    expect(why.textContent).toContain("dcScanNeedsInternet");
    S.holding.offline = false;
    setOnline(true);
  });
});

/* ─── 7 ─────────────────────────────────────────────────────────────── */

describe("7. a date typed with the keyboard is asked about once it is the date meant", () => {
  const typedForm = async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "3000");
    await flush();
  };
  // A type=date field reports a value as soon as one key makes a valid date.
  const typeKey = (el, key, value) => {
    fireEvent.keyDown(el, { key });
    fireEvent.change(el, { target: { value } });
  };

  it("\"1\" then \"5\" in the day segment: no question on the 1st; Enter asks once, for the 15th", async () => {
    await typedForm();
    const el = q("#close-date");
    const [y, m] = yesterday.split("-");
    typeKey(el, "1", `${y}-${m}-01`);
    for (let i = 0; i < 4; i++) await settle();
    expect(asked).toHaveLength(0);
    expect(el.disabled).toBe(false);
    expect(el.value).toBe(`${y}-${m}-01`);
    typeKey(el, "5", yesterday);
    for (let i = 0; i < 4; i++) await settle();
    expect(asked).toHaveLength(0);
    answer = () => false;
    fireEvent.keyDown(el, { key: "Enter" });
    for (let i = 0; i < 6; i++) await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0].title).toMatch(/^dcMoveConfirmTitle:/);
    expect(q("#close-date").value).toBe(today);
  });

  it("…a pause in the typing is taken as the date, and leaving the field too", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await typedForm();
      const el = q("#close-date");
      answer = () => false;
      typeKey(el, "8", yesterday);
      await act(async () => { vi.advanceTimersByTime(400); });
      expect(asked).toHaveLength(0);
      await act(async () => { vi.advanceTimersByTime(700); });
      for (let i = 0; i < 4; i++) await settle();
      expect(asked).toHaveLength(1);
      typeKey(q("#close-date"), "7", yesterday);
      fireEvent.blur(q("#close-date"));
      for (let i = 0; i < 4; i++) await settle();
      expect(asked).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a year typed digit by digit (0002, 0020, 0202 …) never moves the day; the question names the year when it is another one", async () => {
    await typedForm();
    const el = q("#close-date");
    const md = today.slice(4);
    for (const yr of ["0002", "0020", "0202"]) typeKey(el, yr.at(-1), `${yr}${md}`);
    fireEvent.blur(el);
    for (let i = 0; i < 4; i++) await settle();
    expect(asked).toHaveLength(0);
    expect(q("#close-date").value).toBe(today);
    answer = () => false;
    const lastYear = `${Number(today.slice(0, 4)) - 1}${md}`;
    fireEvent.change(q("#close-date"), { target: { value: lastYear } });
    for (let i = 0; i < 6; i++) await settle();
    expect(asked).toHaveLength(1);
    expect(asked[0].title).toContain(String(Number(today.slice(0, 4)) - 1));
    // (Both days are named with their year then: "Bliv på 9. oktober 2026".)
    expect(asked[0].cancelLabel).toContain(today.slice(0, 4));
  });

  it("a pick from the calendar (no key) is taken at once, as before", async () => {
    await typedForm();
    answer = () => false;
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    for (let i = 0; i < 4; i++) await settle();
    expect(asked).toHaveLength(1);
  });
});
