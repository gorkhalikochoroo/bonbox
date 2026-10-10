/**
 * R-c round 2 fix-up — the page's half of the round-2 review, on the page.
 *
 *  1. (removal + attacker lenses) A branch picked by the account signed in
 *     before locked the next account out of Daily close: every save was
 *     refused (403 branch_not_owned) with nothing on screen, and the lock
 *     showed the server's Danish sentence. Now the refusal is said in the
 *     owner's language, the pick is let go of, and the next save goes with
 *     no branch.
 *  2. (production safety) A move answered 404 / 405 — a server with no move
 *     endpoint (an older backend in the deploy window, or after a rollback)
 *     — was treated as a refusal: the ONE queued move was dropped and the
 *     autosave failed in silence. Now it is "no answer": the move stays on
 *     this phone and the line says it is not saved yet; once the server can
 *     move, it is done.
 *  3. (attacker + removal lenses) A copy from before this release names no
 *     account: it is shown to whoever is signed in as unclaimed — never sent
 *     by itself — and goes only on the owner's "Send den", for the signed-in
 *     account. One that belongs to another account's branch is hidden from
 *     this account and said so.
 *  4. Every save the form sends names the account it was opened for.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
let authUser = null;
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: authUser, refreshUser: vi.fn() }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fallbackOrVars, maybeVars) => {
      const vars = typeof fallbackOrVars === "object" ? fallbackOrVars : maybeVars;
      return vars ? `${k}:${Object.values(vars).join(",")}` : k;
    },
    lang: "da",
    setLang: () => {},
    LANGUAGES: [],
  }),
}));
vi.mock("../hooks/useConfirm", () => ({
  useConfirm: () => () => Promise.resolve(true),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));
// The branch pick as the page's own state (a pick another account left).
vi.mock("../components/BranchSelector", async () => {
  const React = await import("react");
  return {
    useBranch: () => {
      const [b, setB] = React.useState(globalThis.__branchStart ?? null);
      return { branchId: b, branchType: "restaurant", hasMultiBranch: false, branches: [], setBranchId: (v) => { globalThis.__branchSet = v; setB(v); } };
    },
  };
});
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const { OQ_KEY, OQ_MOVES_KEY, getOfflineQueue, setQueueAccount } = await import("../utils/dailyCloseQueue");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const yesterday = (() => { const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
const B = { id: "user-b", currency: "DKK", business_type: "restaurant" };
const raw = () => [OQ_KEY, OQ_MOVES_KEY].flatMap((k) => JSON.parse(localStorage.getItem(k) || "[]"));
const fire = async (name, target = window) => {
  await act(async () => { target.dispatchEvent(new Event(name)); await new Promise((r) => setTimeout(r, 0)); });
};
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 0))); };
const saves = () => post.mock.calls.filter(([url]) => url === "/daily-close").map(([, body]) => body);
const moves = () => post.mock.calls.filter(([url]) => url === "/daily-close/move").map(([, body]) => body);
const answered = (status, detail) => Object.assign(new Error(`status ${status}`), { response: { status, data: { detail } } });

// A tiny server: rows by day; a branch of another account refused; moves
// answered by `moveAnswer` (405 — no such endpoint — until switched).
let rows = {};
let stamp = 0;
let moveAnswer = "405";
const store = (body) => {
  stamp += 1;
  const row = { id: `row-${body.date}`, date: body.date, branch_id: body.branch_id ?? null, status: body.status || "draft",
    revenue_breakdown: body.revenue_breakdown, payment_breakdown: body.payment_breakdown || {},
    revenue_total: Object.values(body.revenue_breakdown || {}).reduce((a, x) => a + Number(x || 0), 0),
    updated_at: `2026-10-10T08:00:${String(stamp).padStart(2, "0")}` };
  rows[body.date] = row;
  return row;
};

beforeEach(() => {
  localStorage.clear();
  rows = {};
  stamp = 0;
  moveAnswer = "405";
  globalThis.__branchStart = null;
  globalThis.__branchSet = undefined;
  get.mockReset(); post.mockReset(); del.mockReset();
  get.mockImplementation((url) => Promise.resolve({ data: url === "/daily-close" ? Object.values(rows) : [] }));
  post.mockImplementation((url, body) => {
    if (url === "/daily-close") {
      if (body.branch_id === "a-branch") return Promise.reject(answered(403, { code: "branch_not_owned", message: "Afdelingen hører ikke til denne konto. Intet er gemt." }));
      return Promise.resolve({ data: { ...store(body) } });
    }
    if (url === "/daily-close/move") {
      if (moveAnswer === "405") return Promise.reject(answered(405, "Method Not Allowed"));
      const close = store(body.body);
      const fromRow = rows[body.from_date];
      if (fromRow) delete rows[body.from_date];
      return Promise.resolve({ data: { moved: true, old_status: fromRow ? "deleted" : "none", from: [{ date: body.from_date, branch_id: null, status: fromRow ? "deleted" : "none", id: fromRow?.id ?? null, row: null }], close, save_id: body.save_id, replay: false } });
    }
    return Promise.resolve({ data: {} });
  });
  del.mockResolvedValue({ data: null });
  Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
});
afterEach(() => {
  setQueueAccount(undefined);
  authUser = null;
});

const openForm = async () => {
  const view = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByText("skipEnterManually"));
  await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
  return view;
};
const typeFood = async (view, value) => {
  fireEvent.change(view.container.querySelector("#dc-rev-food"), { target: { value } });
  await settle();
  // The waiting save goes now (the page going away), not two seconds later.
  await fire("pagehide");
  await settle(8);
};

describe("1. a branch of another account never locks this account out of Daily close", () => {
  it("refused 403 branch_not_owned: said in the owner's words, the pick let go of, and the day saved with no branch", async () => {
    authUser = B;
    globalThis.__branchStart = "a-branch";
    const view = await openForm();
    await typeFood(view, "5.000");
    expect(saves().some((b) => b.branch_id === "a-branch")).toBe(true);
    await waitFor(() => expect(screen.getByTestId("dc-branch-not-owned")).toBeInTheDocument());
    expect(view.container.textContent).toContain("dcBranchNotOwned");
    expect(view.container.textContent).not.toContain("Afdelingen hører ikke");
    expect(globalThis.__branchSet).toBeNull();
    // The next save goes with no branch, and is stored.
    await typeFood(view, "5.100");
    await waitFor(() => expect(rows[today]?.revenue_total).toBe(5100));
    expect(rows[today].branch_id).toBeNull();
    // (Every save names the account the form was opened for.)
    expect(saves().every((b) => b.account_id === "user-b")).toBe(true);
  });
});

describe("2. a move answered 404 / 405 (a server with no move endpoint) is never dropped as refused", () => {
  it("the move stays on this phone, the line says it is not saved yet, and once the server can move it is done", async () => {
    authUser = B;
    const view = await openForm();
    await typeFood(view, "3.000");
    expect(rows[today]?.revenue_total).toBe(3000);
    fireEvent.change(view.container.querySelector("#close-date"), { target: { value: yesterday } });
    await settle(12);
    expect(moves().length).toBeGreaterThan(0);
    // Kept: ONE queued move (never dropped as refused), held by the form.
    const kept = raw().filter((it) => it.move);
    expect(kept).toHaveLength(1);
    expect(kept[0].payload).toMatchObject({ date: yesterday, revenue_breakdown: { food: 3000 } });
    // Said: not saved for the new day yet (never "Flyttet fra").
    await waitFor(() => expect(view.container.querySelector('[data-testid="dc-date-moved"]')?.dataset.state).toBe("pending"));
    expect(view.container.textContent).not.toContain("dcDateMovedFrom");
    expect(rows[yesterday]).toBeUndefined();
    expect(rows[today]?.revenue_total).toBe(3000);
    // The server can move now: the move is done whole.
    moveAnswer = "ok";
    await fire("online");
    await settle(12);
    await waitFor(() => expect(rows[yesterday]?.revenue_total).toBe(3000));
    expect(rows[today]).toBeUndefined();
    expect(raw().filter((it) => it.move)).toHaveLength(0);
    expect(moves().every((m) => m.account_id === "user-b")).toBe(true);
  });
});

describe("3. a copy from before this release (no account) is the owner's to send", () => {
  const legacy = (payload) => localStorage.setItem(OQ_KEY, JSON.stringify([{ id: "old", ts: 1, payload, state: "waiting_network" }]));

  it("shown as unclaimed, never sent by itself; \"Send den\" sends it for the signed-in account", async () => {
    legacy({ date: yesterday, status: "draft", revenue_breakdown: { food: 900 }, payment_breakdown: {} });
    authUser = B;
    render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await settle(8);
    await fire("online");
    await settle(8);
    expect(saves()).toEqual([]);
    expect(await screen.findByTestId("dc-queue-unclaimed")).toBeInTheDocument();
    expect(screen.getByText(/dcQueueUnclaimed\b/)).toBeInTheDocument();
    // Never counted as waiting for the network.
    expect(screen.queryByText(/dcSyncPending/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTestId("dc-queue-send-unclaimed"));
    await settle(8);
    expect(saves()).toHaveLength(1);
    expect(saves()[0]).toMatchObject({ date: yesterday, revenue_breakdown: { food: 900 }, account_id: "user-b" });
    expect(rows[yesterday]?.revenue_total).toBe(900);
    expect(getOfflineQueue()).toEqual([]);
  });

  it("one under another account's branch: not sent, hidden from this account and said so — kept for the account it belongs to", async () => {
    legacy({ date: yesterday, status: "draft", branch_id: "a-branch", revenue_breakdown: { food: 900 }, payment_breakdown: {} });
    authUser = B;
    render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await settle(8);
    fireEvent.click(await screen.findByTestId("dc-queue-send-unclaimed"));
    await settle(8);
    expect(rows[yesterday]).toBeUndefined();
    expect(screen.queryByTestId("dc-queue-unclaimed")).not.toBeInTheDocument();
    expect(screen.getByTestId("dc-queue-unclaimed-not-yours")).toBeInTheDocument();
    expect(getOfflineQueue()).toEqual([]);
    setQueueAccount("user-a");
    expect(getOfflineQueue().map((it) => it.id)).toEqual(["old"]);
  });
});
