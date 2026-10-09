/**
 * Release gate R-b (9 Oct) — Daily close offline, said once and said true.
 *
 *   • Offline, a photo dropped on the desktop "Træk og slip" zone (gray,
 *     aria-disabled) said "Scan kræver internet …" a second time under the
 *     zone, beside the same line under the buttons. Said once.
 *   • Offline typing: the step's save slot flashed "Gemmer…" and then showed
 *     the step counter — never "not saved", and after reconnect (the save
 *     landed) never "Gemt". Now: "Ikke gemt endnu" while offline with figures
 *     not on the server, and "Gemt" once they land.
 * Strings by key (t echoes key + values); the stub server's row is read.
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

const { BONS, createServer, installApi, photoUrl } = await import("../test/closeSequenceHarness");
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
const flush = async () => {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
  for (let i = 0; i < 6; i++) await settle();
};
const fire = (name) => act(async () => { window.dispatchEvent(new Event(name)); await new Promise((r) => setTimeout(r, 0)); });
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
const backToCard = async () => {
  for (let i = 0; i < 8 && !q("#dc-rev-food"); i++) tap(/^←\s*back$/);
  tap(/^←\s*scanZReportBack$/);
  await settle();
};
const rowFor = (day = today) => S.rows.get(`${day}|`);
const typed = async (value = "14000") => {
  tap(/^skipEnterManually$/);
  await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
  keyIn(q("#dc-rev-food"), value);
  await flush();
};


const goOffline = async () => {
  S.holding.offline = true;
  setOnline(false);
  await fire("offline");
};
const goOnline = async () => {
  S.holding.offline = false;
  setOnline(true);
  await fire("online");
  for (let i = 0; i < 6; i++) await settle();
};
const count = (needle) => text().split(needle).length - 1;
const slot = () => q('[data-testid="dc-save-slot"]');

describe("offline: 'Scan kræver internet' once", () => {
  it("a photo dropped on the gray drop zone: nothing is read, and the reason is said once", async () => {
    serve();
    await mount();
    await goOffline();
    expect(count("dcScanNeedsInternet")).toBe(1);
    const zone = [...document.querySelectorAll("p")].find((p) => p.textContent === "dragDropZReport").parentElement;
    const file = new File(["z"], "z.jpg", { type: "image/jpeg" });
    await act(async () => { fireEvent.drop(zone, { dataTransfer: { files: [file] } }); });
    for (let i = 0; i < 4; i++) await settle();
    expect(post.mock.calls.filter(([u]) => String(u).includes("scan"))).toHaveLength(0);
    expect(count("dcScanNeedsInternet")).toBe(1);
    setOnline(true);
  });
});

describe("offline typing: the save slot says 'Ikke gemt endnu', then 'Gemt' once it lands", () => {
  it("typed offline → 'Ikke gemt endnu' (also after the failed try); online → saved → 'Gemt'", async () => {
    serve();
    try {
      await mount();
      tap(/^skipEnterManually$/);
      await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
      await goOffline();
      keyIn(q("#dc-rev-food"), "3000");
      await settle();
      expect(slot().textContent).toContain("dcDraftNotSavedYetShort");
      expect(slot().textContent).not.toContain("savingEllipsis");
      // The 2 s autosave tries, gets no answer: still not saved, still said.
      await act(async () => { await new Promise((r) => setTimeout(r, 2300)); });
      for (let i = 0; i < 4; i++) await settle();
      expect(rowFor()).toBeUndefined();
      expect(slot().textContent).toContain("dcDraftNotSavedYetShort");
      // Back online: it goes, lands — and the slot says so.
      await goOnline();
      await waitFor(() => expect(rowFor()).toMatchObject({ revenue_breakdown: { food: 3000 } }));
      await waitFor(() => expect(slot().textContent).toContain("dcDraftSavedShort"));
      expect(slot().textContent).not.toContain("dcDraftNotSavedYetShort");
    } finally {
      S.holding.offline = false;
      setOnline(true);
    }
  }, 15000);

  it("online typing is unchanged: 'Gemmer…' then 'Gemt', never 'Ikke gemt endnu'", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "4000");
    await settle();
    expect(slot().textContent).toContain("savingEllipsis");
    await flush();
    expect(rowFor()).toMatchObject({ revenue_breakdown: { food: 4000 } });
    expect(slot().textContent).toContain("dcDraftSavedShort");
    expect(text()).not.toContain("dcDraftNotSavedYetShort");
  });
});
