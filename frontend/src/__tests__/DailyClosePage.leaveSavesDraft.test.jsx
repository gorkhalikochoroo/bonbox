/**
 * Leaving the form sends the waiting draft save instead of dropping it.
 *
 * Reviewers typed " X" into Noter on a reopened draft and tapped Historik
 * about a second later: the 2 s autosave debounce was cancelled when the form
 * unmounted, no POST went out, and the edit was gone without a word. The step
 * slot never said "Gemt" — but it never said it was still saving either.
 *
 * Strings are asserted by key (t echoes the key plus its values).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
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
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const DRAFT = {
  id: "draft-1",
  date: today,
  status: "draft",
  revenue_total: 12000,
  revenue_breakdown: { food: 12000 },
  payment_breakdown: { card: 12000 },
  notes: "Test",
  closed_by: "Test",
};

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url) => Promise.resolve({ data: url === "/daily-close" ? [DRAFT] : [] }));
  post.mockResolvedValue({ data: {} });
});
afterEach(() => {
  delete document.visibilityState;
});

const closePosts = () => post.mock.calls.filter(([url]) => url === "/daily-close");
const openDraftAtReview = async (container) => {
  fireEvent.click(await screen.findByText("dcContinueDraft"));
  await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("12.000"));
  for (let i = 0; i < 6 && !container.querySelector("#dc-notes"); i++) {
    const next = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
    if (next) fireEvent.click(next);
    await new Promise((r) => setTimeout(r, 0));
  }
  await waitFor(() => expect(container.querySelector("#dc-notes")).not.toBeNull());
};

describe("daily close — an edit made just before leaving is saved", () => {
  it("switching to Historik within the debounce sends the draft at once", async () => {
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await openDraftAtReview(container);

    fireEvent.change(container.querySelector("#dc-notes"), { target: { value: "Test X" } });
    // Still waiting: the slot says so instead of the step counter.
    expect(screen.getByText("savingEllipsis")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("tab", { name: "historyTab" }));

    // Well inside the 2 s the debounce would have waited.
    await waitFor(() => expect(closePosts()).toHaveLength(1), { timeout: 400 });
    expect(closePosts()[0][1]).toMatchObject({ status: "draft", notes: "Test X", date: today });
  });

  it("the phone going to the background sends it as a keepalive request", async () => {
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await openDraftAtReview(container);

    fireEvent.change(container.querySelector("#dc-notes"), { target: { value: "Test Y" } });
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });

    await waitFor(() => expect(closePosts()).toHaveLength(1), { timeout: 400 });
    const [, body, config] = closePosts()[0];
    expect(body).toMatchObject({ status: "draft", notes: "Test Y" });
    expect(config?.fetchOptions?.keepalive).toBe(true);
  });

  it('"Gemt" appears only once the server has answered, and nothing is sent twice', async () => {
    let answer;
    post.mockImplementation(() => new Promise((r) => { answer = r; }));
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await openDraftAtReview(container);

    fireEvent.change(container.querySelector("#dc-notes"), { target: { value: "Test Z" } });
    await waitFor(() => expect(closePosts()).toHaveLength(1), { timeout: 3500 });
    // Sent, not yet answered: still "Gemmer…".
    expect(screen.getByText("savingEllipsis")).toBeInTheDocument();
    expect(screen.queryByText("dcDraftSavedShort")).toBeNull();
    await act(async () => { answer({ data: {} }); });
    await waitFor(() => expect(screen.getByText("dcDraftSavedShort")).toBeInTheDocument());

    // Leaving after the save went out has nothing left to send.
    fireEvent.click(screen.getByRole("tab", { name: "historyTab" }));
    await new Promise((r) => setTimeout(r, 50));
    expect(closePosts()).toHaveLength(1);
  });
});
