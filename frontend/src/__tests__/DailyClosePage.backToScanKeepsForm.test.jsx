/**
 * "← Scan Z-bon" shows the form's CURRENT figures, so "Brug disse tal" again
 * never throws typed data away.
 *
 * - A reopened draft from a partly read Z-bon (Mad 10.000, total 17.030,
 *   Kort 12.000, Kontant 5.030 typed, MOMS 3.406): the card came back empty
 *   ("0/8 felter fundet"), and applying it saved revenue_breakdown {},
 *   payment_breakdown {} and MOMS on Auto.
 * - In the same session, Mad typed on Trin 1 showed as "mangler" on the card,
 *   and applying the card again wiped it (and a Kontant typed on Trin 2).
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
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const PARTIAL_SCAN = { revenue: {}, revenue_total: 17030, moms_total: 3406, payments: { card: 12000 }, raw_text: "KASSE", ocr_available: true };
let closes = [];

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  closes = [];
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url) => Promise.resolve({ data: url === "/daily-close" ? closes : [] }));
  post.mockImplementation((url) => Promise.resolve({ data: String(url).includes("scan") ? PARTIAL_SCAN : {} }));
});

const closePosts = () => post.mock.calls.filter(([url]) => url === "/daily-close");
const boxValues = (container) => [...container.querySelectorAll("input")].map((i) => i.value);
const tap = (re) => {
  const btn = screen.getAllByRole("button").find((b) => re.test(b.textContent.trim()));
  if (btn) fireEvent.click(btn);
  return btn;
};
const tick = () => new Promise((r) => setTimeout(r, 0));

describe("daily close — back to the scan card after a reopened draft", () => {
  it("shows the draft's figures and applying them again loses nothing", async () => {
    closes = [{
      id: "d1", date: today, status: "draft",
      revenue_total: 17030,
      revenue_breakdown: { food: 10000 },
      payment_breakdown: { card: 12000, cash: 5030 },
      moms_mode: "manual", moms_total: 3406,
      closed_by: "Test", notes: "Test",
    }];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("10.000"));

    fireEvent.click(screen.getByText("← scanZReportBack"));
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    // The card holds what the form holds — not an empty "0/8" read.
    expect(boxValues(container)).toEqual(expect.arrayContaining(["10.000", "12.000", "5.030", "17.030"]));
    expect(screen.queryByText(/^scanConfidenceLevel/)).toBeNull();
    expect(screen.queryByText(/scanGapNoBreakdown|scanGapDetectedSome/)).toBeNull();
    // Nothing on it was read off a photo in this session.
    expect(screen.queryByText("scanBadgeRead")).toBeNull();
    // One MOMS: the draft's own, the same figure the review shows.
    expect(container.textContent).toContain("3.406 kr.");

    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    // Re-applying the same figures is not a change — no save went out at all,
    // least of all one with the breakdowns emptied.
    await new Promise((r) => setTimeout(r, 2300));
    expect(closePosts()).toHaveLength(0);

    fireEvent.change(container.querySelector("#dc-notes"), { target: { value: "Test 2" } });
    await waitFor(() => expect(closePosts()).toHaveLength(1), { timeout: 3500 });
    expect(closePosts()[0][1]).toMatchObject({
      status: "draft",
      revenue_breakdown: { food: 10000 },
      payment_breakdown: { card: 12000, cash: 5030 },
      moms_mode: "manual",
      moms_total: 3406,
      revenue_total_override: 17030,
    });
  });
});

describe("daily close — back to the scan card in the same session", () => {
  it("keeps Mad typed on Trin 1 and Kontant typed on Trin 2 through a corrected total", async () => {
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    fireEvent.change(container.querySelector('input[type="file"]'), {
      target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] },
    });
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "10000" } });
    tap(/^next\s/);
    await waitFor(() => expect(container.querySelector("#dc-pay-cash")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-pay-cash"), { target: { value: "5030" } });
    tap(/^← back$/);
    await tick();
    fireEvent.click(await screen.findByText("← scanZReportBack"));
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());

    // Mad is on the card as typed — no longer "mangler".
    expect(boxValues(container)).toEqual(expect.arrayContaining(["10000", "5030"]));
    // The Kort the scanner read is still the scanner's read.
    expect(screen.getAllByText("scanBadgeRead").length).toBeGreaterThan(0);

    fireEvent.change(container.querySelector("#scan-total"), { target: { value: "17.130" } });
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    fireEvent.click(await screen.findByText("confirmAndLock"));
    await waitFor(() => expect(closePosts().some(([, b]) => b.status === "confirmed")).toBe(true));
    const payload = closePosts().find(([, b]) => b.status === "confirmed")[1];
    expect(payload.revenue_breakdown).toEqual({ food: 10000 });
    expect(payload.payment_breakdown).toEqual({ card: 12000, cash: 5030 });
    expect(payload.revenue_total_override).toBe(17130);
  });
});
