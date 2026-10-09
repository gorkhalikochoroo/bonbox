/**
 * Round 23 fix-up — a save whose answer was lost is RE-SENT (once online, on
 * leaving the page, with the next change) on the version the FORM holds —
 * its own (baseRef), else the version that lost save was built on — and
 * names the lost save (base_save_id). Never on the version History lists:
 * History lists what the server holds now, another phone's newer draft
 * included, and a re-send on that version was stored over it with nobody
 * asked.
 *
 * Two devices, a lost answer: this phone's first save of the day is stored
 * but its answer is lost; another phone saves the day over it; the line
 * dies, and the queue's sync reads History again (it lists the other
 * phone's version). Then the re-send:
 *   - once online: refused (412 draft_changed) — "Kladden er gemt et andet
 *     sted" asks the owner, the other phone's draft is kept;
 *   - on leaving (the form unmounted): refused — the owner's figures are
 *     kept on this phone as a failed copy, never sent again by the queue;
 *   - on pagehide: refused — asked when the page is back.
 * And no false alarm: when the version stored is this form's OWN lost save
 * (two answers lost in a row — base_save_id names only the last), the day is
 * read fresh and the save goes on its own version, nobody asked.
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
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => () => Promise.resolve(true) }));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const { NO_ROW_BASE, createServer, installApi } = await import("../test/closeSequenceHarness");
const { addToOfflineQueue, getOfflineQueue, QUEUE_FAILED, QUEUE_ERR_DRAFT_CHANGED } = await import("../utils/dailyCloseQueue");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const shiftIso = (iso, days) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const yesterday = shiftIso(today, -1);
const KEY = `${today}|`;

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
  get.mockReset();
  post.mockReset();
  del.mockReset();
  post.realImpl = null;
});
const serve = () => {
  S = createServer({ rows: [] });
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
const settleMany = async (n = 8) => { for (let i = 0; i < n; i++) await settle(); };
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
const rowFor = (day = today) => S.rows.get(`${day}|`);
/** Every save the FORM sends (it carries a save_id) dies on its way; the queue's copies get through. */
const deadLine = (on) => {
  if (!post.realImpl) post.realImpl = post.getMockImplementation();
  const pass = post.realImpl;
  if (!on) { post.mockImplementation(pass); return; }
  post.mockImplementation((url, body) => (url === "/daily-close" && body?.save_id
    ? Promise.reject(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }))
    : pass(url, body)));
};
const formPosts = () => post.mock.calls.filter(([url, body]) => url === "/daily-close" && body?.save_id).map(([, body]) => body);

/**
 * This phone's first save of today (3.000) is stored, its answer lost; then
 * (`other`) another phone saves the day over it (MobilePay 99, a note); the
 * line dies — the waiting save goes on "online" and dies too — and the
 * queue's sync of yesterday's copy reads History again: it lists today as
 * the server holds it now.
 */
const lostThenListed = async ({ other = true } = {}) => {
  serve();
  const view = await mount();
  tap(/^skipEnterManually$/);
  await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
  S.holding.drop = true;
  keyIn(q("#dc-rev-food"), "3.000");
  await fire("pagehide");
  await settleMany(6);
  S.holding.drop = false;
  await fire("pageshow");
  expect(rowFor()).toMatchObject({ status: "draft", revenue_total: 3000 });
  expect(S.lostKeys.has(KEY)).toBe(true);
  const own = rowFor().updated_at;
  if (other) {
    S.otherSave(KEY, (r) => { r.payment_breakdown = { ...(r.payment_breakdown || {}), mobilepay: 99 }; r.notes = "B"; });
    expect(rowFor().updated_at > own).toBe(true);
  }
  const stored = rowFor().updated_at;
  deadLine(true);
  addToOfflineQueue({ date: yesterday, branch_id: null, status: "draft", revenue_breakdown: { food: 1000 }, payment_breakdown: { card: 1000 }, base_updated_at: NO_ROW_BASE });
  await fire("online");
  await settleMany(10);
  // Yesterday's copy landed and History was read again: it lists today as
  // stored now — the other phone's version (or this form's own lost save).
  expect(rowFor(yesterday)).toMatchObject({ revenue_total: 1000 });
  expect(S.listGets).toBeGreaterThan(1);
  expect(text()).toContain("dcDayHasDraft");
  // Today is still as it was: the waiting save died on the dead line.
  expect(rowFor().updated_at).toBe(stored);
  deadLine(false);
  return { view, stored, n: formPosts().length };
};
const otherPhoneKept = () => {
  const row = rowFor();
  expect(row).toMatchObject({ status: "draft", notes: "B" });
  expect(row.payment_breakdown.mobilepay).toBe(99);
};
/** The re-send: on the form's own version (NO_ROW_BASE — it was never answered), following the lost save — never on History's. */
const resentOnFormVersion = (n, stored) => {
  const resent = formPosts().slice(n);
  expect(resent.length).toBeGreaterThan(0);
  for (const b of resent) {
    expect(b.base_updated_at).not.toBe(stored);
    expect(b.base_updated_at).toBe(NO_ROW_BASE);
    expect(typeof b.base_save_id).toBe("string");
    expect(b.revenue_breakdown).toEqual({ food: 3000 });
  }
};

describe("round 23 fix-up — a re-sent save carries the form's own version, never History's", () => {
  it("two devices + a lost answer, re-sent ONCE ONLINE: refused — \"Kladden er gemt et andet sted\" asks; the other phone's draft is kept", async () => {
    const { stored, n } = await lostThenListed();
    await fire("online");
    await settleMany(10);
    resentOnFormVersion(n, stored);
    otherPhoneKept();
    expect(S.refused.length).toBeGreaterThan(0);
    expect(q('[data-testid="dc-draft-changed"]')).not.toBeNull();
    // Asked, never overwritten: nothing else is sent over it while it is open.
    const m = formPosts().length;
    await fire("online");
    await settleMany(6);
    expect(formPosts().length).toBe(m);
    otherPhoneKept();
  });

  it("…re-sent ON LEAVING (the form unmounted): refused — the owner's figures are kept on this phone as a failed copy that the queue never sends again", async () => {
    const { view, stored, n } = await lostThenListed();
    view.unmount();
    await settleMany(10);
    resentOnFormVersion(n, stored);
    otherPhoneKept();
    const kept = getOfflineQueue().filter((it) => it.payload?.date === today);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: stored });
    expect(kept[0].payload.revenue_breakdown).toEqual({ food: 3000 });
    // Back, and online again: the copy waits for the owner — never re-posted.
    const posts = post.mock.calls.length;
    await mount();
    await fire("online");
    await settleMany(10);
    expect(post.mock.calls.slice(posts).filter(([url, body]) => url === "/daily-close" && body?.date === today)).toHaveLength(0);
    otherPhoneKept();
    expect(getOfflineQueue().filter((it) => it.payload?.date === today)).toHaveLength(1);
    expect(text()).toContain("dcQueueErrDraftChanged");
  });

  it("…re-sent on PAGEHIDE (the phone locked, the tab switched): refused — asked when the page is back, the other phone's draft kept", async () => {
    const { stored, n } = await lostThenListed();
    await fire("pagehide");
    await settleMany(10);
    await fire("pageshow");
    await settleMany(4);
    resentOnFormVersion(n, stored);
    otherPhoneKept();
    expect(q('[data-testid="dc-draft-changed"]')).not.toBeNull();
  });

  it("no false alarm: no other phone — the version stored is this form's own lost save (the re-send after it died too, so base_save_id names a save that never landed): read fresh, it is the form's own, and the figures are saved on it with nobody asked", async () => {
    const { n } = await lostThenListed({ other: false });
    await fire("online");
    await settleMany(12);
    expect(formPosts().length).toBeGreaterThan(n);
    expect(q('[data-testid="dc-draft-changed"]')).toBeNull();
    expect(text()).not.toContain("dcDayHasDraft");
    expect(rowFor()).toMatchObject({ status: "draft", revenue_total: 3000 });
    // (The re-send was refused once — it named the save that died — and the
    // day read fresh said the stored version is this form's own.)
    expect(S.refused.length).toBe(1);
    expect(S.dayReads).toBeGreaterThan(0);
    // The day's last save is this form's.
    expect(formPosts().map((b) => b.save_id)).toContain(S.lastSaveId.get(KEY));
  });
});
