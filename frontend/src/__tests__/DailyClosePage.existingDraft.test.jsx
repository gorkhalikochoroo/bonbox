/**
 * A day that already has a draft. Typing a fresh close over it used to replace
 * it two seconds later without a word — a Catering line, a cash count and a
 * staff count gone. The form now asks first, and saves nothing until it has
 * an answer.
 *
 * Strings are asserted by key (t echoes the key plus its values).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  cash_counted: 3500.25,
};

const renderPage = () =>
  render(
    <MemoryRouter>
      <DailyClosePage />
    </MemoryRouter>,
  );

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockImplementation((url) => Promise.resolve({ data: url === "/daily-close" ? [DRAFT] : [] }));
  post.mockResolvedValue({ data: {} });
});

const closePosts = () => post.mock.calls.filter(([url]) => url === "/daily-close");

describe("daily close — the chosen day already has a draft", () => {
  it("asks before anything else, and saves nothing meanwhile", async () => {
    renderPage();

    // On the wizard's first screen, before a photo or a figure: the camera
    // and the manual entry wait until the owner has answered.
    await waitFor(() => expect(screen.getByText("dcDayHasDraft")).toBeInTheDocument());
    expect(screen.getByText(/dcDayHasDraftBody:12\.000 kr\./)).toBeInTheDocument();
    expect(screen.queryByText("skipEnterManually")).not.toBeInTheDocument();
    expect(screen.queryByText("takePhoto")).not.toBeInTheDocument();

    await new Promise((r) => setTimeout(r, 2300));
    expect(closePosts()).toHaveLength(0);
  });

  it("continuing loads the draft's own numbers", async () => {
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("dcContinueDraft"));

    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("12000"));
    expect(screen.queryByText("dcDayHasDraft")).not.toBeInTheDocument();
  });

  it("starting over is an explicit choice, and then it saves", async () => {
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("dcStartOverDraft"));
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());

    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "900" } });
    await waitFor(() => expect(closePosts()).toHaveLength(1), { timeout: 3500 });
    expect(closePosts()[0][1].status).toBe("draft");
  });
});
