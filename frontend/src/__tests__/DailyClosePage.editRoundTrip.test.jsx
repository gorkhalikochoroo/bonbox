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
// Round 23 — Start forfra deletes the draft (the server, version-checked).
const del = vi.fn(() => Promise.resolve({ data: null }));
const branch = vi.hoisted(() => ({ current: { branchId: null, branchType: "restaurant", hasMultiBranch: false } }));
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
// The day's draft is offered on the wizard's first screen, before any scan.
const continueDraft = async (container) => {
  fireEvent.click(await screen.findByText("dcContinueDraft"));
  await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("12.000"));
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

  // Round 23 (expectation changed): Start forfra DELETES that branch's draft
  // — asked first, on the version shown — and the new close is still filed
  // under that branch, not beside it (it "replaced" it by a save over it).
  it("starting over deletes that branch's draft (asked first), and the new close is filed under that branch", async () => {
    window.confirm = () => true;
    del.mockClear();
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("dcStartOverDraft"));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(del.mock.calls[0][0]).toBe(`/daily-close/${BASE.id}`);
    // (Round 23 review: never a delete with no version — the server checks
    // nothing without one. A row shown with no updated_at is deleted on "no
    // version known" (NO_ROW_BASE): anything stored since is refused, kept.)
    expect(del.mock.calls[0][1].params.base_updated_at).toBe(BASE.updated_at ?? "1970-01-01T00:00:00");
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "900" } });
    await waitFor(() => expect(closePosts()).toHaveLength(1), { timeout: 3500 });
    expect(closePosts()[0][1].branch_id).toBe("b1");
  });
});

describe("daily close — a saved total above its category lines", () => {
  it("shows the unsplit part, so the rows add up", async () => {
    closes = [{ ...BASE, revenue_total: 17030, revenue_breakdown: { food: 10000 }, payment_breakdown: { card: 17030 } }];
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("10.000"));
    expect(screen.getByText("dcUnsplitRevenue")).toBeInTheDocument();
  });
});

describe("daily close — the cash count", () => {
  it("counts the whole drawer and saves the takings (float taken off)", async () => {
    closes = [];
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "4500" } });
    for (let i = 0; i < 4 && !container.querySelector("#cash-counted"); i++) {
      tapNext();
      await new Promise((r) => setTimeout(r, 0));
    }
    await waitFor(() => expect(container.querySelector("#cash-counted")).not.toBeNull());
    expect(container.querySelector("#cash-float").value).toBe("1.000");
    fireEvent.change(container.querySelector("#cash-counted"), { target: { value: "5500" } });
    await waitFor(() => expect(closePosts().some(([, b]) => b.cash_counted === 4500)).toBe(true), { timeout: 3500 });
  });
});

describe("daily close — opened from a ?date= link", () => {
  it("the draft its own autosave just made never yanks the form back to Trin 1", async () => {
    // The morning brief's "Luk dagen" and the missed-day rows link here. The
    // first autosave's draft came back in the history reload and was
    // "opened" over the owner's typing: Trin 1 again, the new figures gone.
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() - 3);
    const pad = (n) => String(n).padStart(2, "0");
    const past = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    closes = [];
    post.mockImplementation((url, body) => {
      if (url === "/daily-close") {
        const row = { id: "auto-1", status: "draft", ...body, revenue_total: 800, revenue_breakdown: body.revenue_breakdown, payment_breakdown: body.payment_breakdown };
        closes = [row];
        return Promise.resolve({ data: row });
      }
      return Promise.resolve({ data: {} });
    });
    const { container } = render(
      <MemoryRouter initialEntries={[`/daily-close?date=${past}`]}>
        <DailyClosePage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "800" } });
    await waitFor(() => expect(closePosts().length).toBeGreaterThanOrEqual(1), { timeout: 3500 });
    expect(closePosts()[0][1].date).toBe(past);
    tapNext();
    await waitFor(() => expect(container.querySelector("#dc-pay-cash")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-pay-cash"), { target: { value: "800" } });
    // Let the history reload (with the new draft in it) land.
    await new Promise((r) => setTimeout(r, 600));
    expect(screen.getByText(/^stepNPayments:/)).toBeInTheDocument();
    expect(container.querySelector("#dc-pay-cash").value).toBe("800");
  });
});
