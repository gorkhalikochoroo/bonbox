/**
 * R-c round 2, CMS-1 (audit, P1 — money integrity, cross-tenant), on the
 * page: owner A types a close OFFLINE on a shared phone and the page keeps it
 * on this phone (the offline queue); A signs out; owner B signs in on the
 * same phone and the network comes back. B's Daily close shows nothing of
 * A's, and B's server gets nothing of A's — no save, no lock, no move. A's
 * copy waits on the phone, and is sent once A signs in again.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn(), delete: vi.fn() },
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
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));

const { OQ_KEY, setQueueAccount } = await import("../utils/dailyCloseQueue");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const A = { id: "user-a", currency: "DKK", business_type: "restaurant" };
const B = { id: "user-b", currency: "DKK", business_type: "restaurant" };
const raw = () => JSON.parse(localStorage.getItem(OQ_KEY) || "[]");
const setOnline = (on) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });
const fire = async (name, target = window) => {
  await act(async () => { target.dispatchEvent(new Event(name)); await new Promise((r) => setTimeout(r, 0)); });
};
const settle = async (n = 6) => { for (let i = 0; i < n; i++) await act(() => new Promise((r) => setTimeout(r, 0))); };
const closePosts = () => post.mock.calls.filter(([url]) => String(url).startsWith("/daily-close") && !String(url).includes("scan"));

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: [] });
  post.mockResolvedValue({ data: { id: "r1", status: "draft", updated_at: "2026-10-10T08:00:00" } });
  Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
});
afterEach(() => {
  setOnline(true);
  setQueueAccount(undefined);
  authUser = null;
});

describe("CMS-1 — one phone, two accounts: nothing queued by A is ever sent under B", () => {
  it("A queues a close offline and signs out; B signs in and goes online: B's server gets nothing of A's, B sees nothing of A's; A's copy is sent once A is back", async () => {
    // Owner A, offline: 5.000 typed; leaving the page offline keeps it on this phone.
    authUser = A;
    setOnline(false);
    const a = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await fire("offline");
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(a.container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(a.container.querySelector("#dc-rev-food"), { target: { value: "5.000" } });
    await settle();
    await fire("pagehide");
    await settle();
    // A signs out (the page goes).
    a.unmount();
    await settle();
    const kept = raw().filter((it) => it.payload?.revenue_breakdown?.food === 5000);
    expect(kept).toHaveLength(1);
    expect(kept[0].account).toBe("user-a");
    const sentWhileA = closePosts().length;

    // Owner B signs in on the same phone; the network comes back.
    authUser = B;
    setOnline(true);
    const b = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await settle();
    await fire("online");
    await settle(10);
    // Nothing of A's went to the server on B's session …
    expect(closePosts().slice(sentWhileA)).toEqual([]);
    // … nor is shown on B's page as waiting to be sent.
    expect(screen.queryByText(/dcSyncPending/)).not.toBeInTheDocument();
    expect(screen.queryByText(/dcQueued/)).not.toBeInTheDocument();
    // A's copy is still on the phone, still A's.
    expect(raw().filter((it) => it.account === "user-a")).toHaveLength(1);
    b.unmount();
    await settle();

    // A signs in again: A's copy goes — on A's session.
    authUser = A;
    render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await settle();
    await fire("online");
    await settle(10);
    const sentForA = closePosts().slice(sentWhileA).map(([, body]) => body);
    expect(sentForA.some((body) => body?.revenue_breakdown?.food === 5000)).toBe(true);
    expect(raw().filter((it) => it.account === "user-a")).toHaveLength(0);
  });
});
