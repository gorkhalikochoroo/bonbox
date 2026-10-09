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
// Round 23 — Start forfra deletes the draft (the server, version-checked).
const del = vi.fn(() => Promise.resolve({ data: null }));
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
  window.confirm = () => true;
  del.mockClear();
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

    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("12.000"));
    expect(screen.queryByText("dcDayHasDraft")).not.toBeInTheDocument();
  });

  // Round 23 (expectation added): the explicit choice is asked in words that
  // name the draft and its amount, and the server deletes it first.
  it("starting over is an explicit choice, and then it saves", async () => {
    const asked = [];
    window.confirm = (m) => { asked.push(m); return true; };
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("dcStartOverDraft"));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(asked[0]).toMatch(/dcStartOverDeleteBody:.*12\.000 kr\./);
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());

    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "900" } });
    await waitFor(() => expect(closePosts()).toHaveLength(1), { timeout: 3500 });
    expect(closePosts()[0][1].status).toBe("draft");
  });
});

describe("daily close — picking a day that has a draft, mid-form", () => {
  it("locks the form until the owner chooses, instead of discarding what is typed", async () => {
    // The banner offered Fortsæt / Start forfra while Mad still took "999" —
    // which was never saved, and nothing said so.
    const d = new Date(`${today}T12:00:00`);
    d.setDate(d.getDate() - 2);
    const pad = (n) => String(n).padStart(2, "0");
    const past = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    get.mockImplementation((url) => Promise.resolve({ data: url === "/daily-close" ? [{ ...DRAFT, date: past }] : [] }));
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    expect(container.querySelector("#dc-rev-food").matches(":disabled")).toBe(false);

    fireEvent.change(container.querySelector("#close-date"), { target: { value: past } });
    await waitFor(() => expect(screen.getByText("dcDayHasDraft")).toBeInTheDocument());
    expect(container.querySelector("#dc-rev-food").matches(":disabled")).toBe(true);

    // Round 23 (expectation changed): Start forfra deletes that draft and the
    // page starts over — the scan's start, nothing locked any more.
    fireEvent.click(screen.getByText("dcStartOverDraft"));
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").matches(":disabled")).toBe(false));
    expect(del).toHaveBeenCalledTimes(1);
  });
});
