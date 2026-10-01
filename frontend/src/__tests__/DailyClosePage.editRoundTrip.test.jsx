/**
 * A close opened again (Fortsæt / Rediger) is the SAME close: every field
 * comes back, any change to any field is saved, and it is filed under its own
 * branch and day.
 *
 * - A notes-only (or staff, closed-by, MOMS) change was never saved: the
 *   "has anything changed?" check compared the money fields only.
 * - A typed MOMS came back in Auto, so the next save replaced it.
 * - With "All branches" picked, a branch's draft was invisible to the
 *   "already a draft" check and re-saved with no branch — a second close for
 *   the same day.
 * - A saved total above its category lines (a partly read Z-bon) showed rows
 *   that did not add up to it.
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
const branch = vi.hoisted(() => ({ current: { branchId: null, branchType: "restaurant", hasMultiBranch: false } }));
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
vi.mock("../components/BranchSelector", () => ({ useBranch: () => branch.current }));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const BASE = {
  id: "draft-1",
  date: today,
  status: "draft",
  revenue_total: 12000,
  revenue_breakdown: { food: 12000 },
  payment_breakdown: { card: 12000 },
  cash_counted: 0,
  notes: "Gammel note",
  closed_by: "Test",
  tips_staff_count: 3,
};

let closes = [BASE];
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
  closes = [BASE];
  branch.current = { branchId: null, branchType: "restaurant", hasMultiBranch: false };
  get.mockImplementation((url) => Promise.resolve({ data: url === "/daily-close" ? closes : [] }));
  post.mockResolvedValue({ data: {} });
});

const closePosts = () => post.mock.calls.filter(([url]) => url === "/daily-close");
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};
const continueDraft = async (container) => {
  fireEvent.click(await screen.findByText("closeManualCta"));
  fireEvent.click(await screen.findByText("dcContinueDraft"));
  await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("12000"));
};
const toReview = async (container) => {
  for (let i = 0; i < 6 && !container.querySelector("#dc-notes"); i++) {
    tapNext();
    await new Promise((r) => setTimeout(r, 0));
  }
  await waitFor(() => expect(container.querySelector("#dc-notes")).not.toBeNull());
};

describe("daily close — a close opened again saves every change", () => {
  it("opening is not a save; a notes-only change is", async () => {
    const { container } = renderPage();
    await continueDraft(container);
    await toReview(container);
    expect(container.querySelector("#dc-notes").value).toBe("Gammel note");
    expect(container.querySelector("#dc-closed-by").value).toBe("Test");

    await new Promise((r) => setTimeout(r, 2300));
    expect(closePosts()).toHaveLength(0);

    fireEvent.change(container.querySelector("#dc-notes"), { target: { value: "Ny note" } });
    await waitFor(() => expect(closePosts()).toHaveLength(1), { timeout: 3500 });
    expect(closePosts()[0][1]).toMatchObject({ notes: "Ny note", status: "draft", date: today, tips_staff_count: 3 });
  });

  it("a typed MOMS comes back typed, and is re-saved as typed", async () => {
    closes = [{ ...BASE, moms_mode: "manual", moms_total: 2000 }];
    const { container } = renderPage();
    await continueDraft(container);
    await toReview(container);
    fireEvent.change(container.querySelector("#dc-closed-by"), { target: { value: "Anna" } });
    await waitFor(() => expect(closePosts()).toHaveLength(1), { timeout: 3500 });
    expect(closePosts()[0][1]).toMatchObject({ moms_mode: "manual", moms_total: 2000, closed_by: "Anna" });
  });
});

describe("daily close — a branch's close, with All branches picked", () => {
  beforeEach(() => {
    branch.current = {
      branchId: null,
      branchType: "restaurant",
      hasMultiBranch: true,
      branches: [{ id: "b1", name: "Mirabelle" }, { id: "b2", name: "Nørrebro" }],
    };
    closes = [{ ...BASE, branch_id: "b1" }];
  });

  it("is found for its day, and named", async () => {
    renderPage();
    fireEvent.click(await screen.findByText("closeManualCta"));
    await waitFor(() => expect(screen.getByText("dcDayHasDraft")).toBeInTheDocument());
    expect(screen.getByText(/Mirabelle:/)).toBeInTheDocument();
  });

  it("continuing it saves under its own branch, not beside it", async () => {
    const { container } = renderPage();
    await continueDraft(container);
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "12500" } });
    await waitFor(() => expect(closePosts()).toHaveLength(1), { timeout: 3500 });
    expect(closePosts()[0][1]).toMatchObject({ branch_id: "b1", date: today });
  });

  it("starting over replaces that branch's draft", async () => {
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("closeManualCta"));
    fireEvent.click(await screen.findByText("dcStartOverDraft"));
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "900" } });
    await waitFor(() => expect(closePosts()).toHaveLength(1), { timeout: 3500 });
    expect(closePosts()[0][1].branch_id).toBe("b1");
  });
});

describe("daily close — a saved total above its category lines", () => {
  it("shows the unsplit part, so the rows add up", async () => {
    closes = [{ ...BASE, revenue_total: 17030, revenue_breakdown: { food: 10000 }, payment_breakdown: { card: 17030 } }];
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("closeManualCta"));
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("10000"));
    expect(screen.getByText("dcUnsplitRevenue")).toBeInTheDocument();
  });
});
