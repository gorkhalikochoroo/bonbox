/**
 * One MOMS after a re-scan.
 *
 * A reviewer scanned a Z-bon (17.030, MOMS 3.406), used the numbers, went back
 * and scanned again with the total corrected to 16.500. The card said MOMS
 * 3.300; the review and the saved draft still said 3.406 "fra bon" — the first
 * scan's MOMS, pinned in manual mode. Same with a re-scan that had no MOMS
 * line at all (12.000 kr., MOMS 2.400 shown as 3.406).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
// Round 23 — Start forfra deletes the day's draft (the server), asked first.
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
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const ZBON = { revenue: {}, revenue_total: 17030, moms_total: 3406, payments: { card: 12000 }, raw_text: "KASSE 17030", ocr_available: true };
const NO_MOMS = { revenue: {}, revenue_total: 12000, payments: { card: 12000 }, raw_text: "KASSE 12000", ocr_available: true };
let scans = [];

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: [] });
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  post.mockImplementation((url) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() || ZBON });
    return Promise.resolve({ data: { id: 1, status: "confirmed" } });
  });
});

const shoot = (container) =>
  fireEvent.change(container.querySelector('input[type="file"]'), {
    target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] },
  });
const backTo = async (label) => {
  for (let i = 0; i < 6 && !screen.queryByText(label); i++) {
    const back = screen.getAllByRole("button").find((b) => b.textContent.trim() === "← back");
    if (!back) break;
    fireEvent.click(back);
    await new Promise((r) => setTimeout(r, 0));
  }
};
const lockedPayload = async () => {
  fireEvent.click(await screen.findByText("confirmAndLock"));
  await waitFor(() =>
    expect(post.mock.calls.some(([url, body]) => url === "/daily-close" && body?.status === "confirmed")).toBe(true),
  );
  return post.mock.calls.find(([url, body]) => url === "/daily-close" && body?.status === "confirmed")[1];
};

describe("daily close — MOMS after going back to the scan", () => {
  it("a corrected re-scan saves the corrected MOMS, not the first scan's", async () => {
    scans = [ZBON];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");

    await backTo("← scanZReportBack");
    fireEvent.click(screen.getByText("← scanZReportBack"));
    // Back on the scan card WITH the scan — not thrown away.
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    fireEvent.change(container.querySelector("#scan-total"), { target: { value: "16.500" } });
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));

    const payload = await lockedPayload();
    expect(payload.revenue_total_override).toBe(16500);
    expect(payload.moms_mode).toBe("auto");
    expect(payload.moms_total).toBe(3300);
  });

  it("a re-scan without a MOMS line drops the earlier scan's MOMS", async () => {
    scans = [ZBON, NO_MOMS];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");

    await backTo("← scanZReportBack");
    fireEvent.click(screen.getByText("← scanZReportBack"));
    await waitFor(() => expect(screen.getByText("startOver")).toBeInTheDocument());
    // (Round 23: asked first — the draft filed for the bon is deleted by the
    // server — and the form starts over once that has answered.)
    window.confirm = () => true;
    fireEvent.click(screen.getByText("startOver"));
    await waitFor(() => expect(screen.queryByText("scanResults")).not.toBeInTheDocument());
    shoot(container);
    await waitFor(() => expect(container.querySelector("#scan-total")?.value).toBe("12.000"));
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));

    const payload = await lockedPayload();
    expect(payload.moms_mode).toBe("auto");
    expect(payload.moms_total).toBe(2400);
  });
});
