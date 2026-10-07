/**
 * One MOMS for the total that is saved — and a summed total the box shows.
 *
 * - After a FULL read (17.030, MOMS 3.406), raising Mad by hand to 17.130
 *   kept the bon's 3.406 "fra bon" on the review (19,9 %), and Auto gave the
 *   same 3.406. MOMS now follows the saved total and says it differs from the
 *   bon; a MOMS the owner typed is theirs and stays.
 * - A corrected till 1 (16.450) plus till 2 (5.000) left the "Samlet
 *   omsætning" box on 16.450 under "= 21.450"; editing it then printed
 *   "16.450 + 5.000 = 16.500".
 *
 * Strings are asserted by key (t echoes the key plus its values).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

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

const FULL = {
  revenue: { food: 10000, drinks: 7030 }, revenue_total: 17030, moms_total: 3406,
  payments: { card: 12000, cash: 5030 }, raw_text: "KASSE", ocr_available: true,
};
let scans = [];

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: [] });
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  post.mockImplementation((url) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() || FULL });
    return Promise.resolve({ data: { id: 1, status: "confirmed" } });
  });
});

const shoot = (container) =>
  fireEvent.change(container.querySelector('input[type="file"]'), {
    target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] },
  });
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};
const toReview = async () => {
  for (let i = 0; i < 6 && !screen.queryByText("confirmAndLock"); i++) {
    tapNext();
    await new Promise((r) => setTimeout(r, 0));
  }
  await screen.findByText("confirmAndLock");
};
const lockedPayload = async () => {
  fireEvent.click(screen.getByText("confirmAndLock"));
  await waitFor(() =>
    expect(post.mock.calls.some(([url, body]) => url === "/daily-close" && body?.status === "confirmed")).toBe(true),
  );
  return post.mock.calls.find(([url, body]) => url === "/daily-close" && body?.status === "confirmed")[1];
};
const scanAndStepThrough = async (container) => {
  shoot(container);
  await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
  fireEvent.click(screen.getByText("continueStepByStep"));
  await waitFor(() => expect(container.querySelector("#dc-rev-food")?.value).toBe("10.000"));
};

describe("daily close — MOMS follows a category corrected by hand", () => {
  it("recomputes MOMS for the saved total, says it differs from the bon, and saves that", async () => {
    scans = [FULL];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await scanAndStepThrough(container);
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "10.100" } });
    await toReview();

    // 25 % of 17.130 — not the bon's 3.406 for 17.030.
    expect(container.textContent).toContain("3.426,00");
    expect(container.textContent).not.toContain("3.406,00");
    expect(screen.getByText(/^dcMomsRecomputed:3\.406 kr\.\|17\.130 kr\./)).toBeInTheDocument();
    const payload = await lockedPayload();
    expect(payload.moms_mode).toBe("auto");
    expect(payload.moms_total).toBe(3426);
  });

  it("the scan card shows the same MOMS after going back", async () => {
    scans = [FULL];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await scanAndStepThrough(container);
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "10.100" } });
    fireEvent.click(screen.getByText("← scanZReportBack"));
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    expect(container.textContent).toContain("3.426 kr.");
    expect(screen.getByText(/^dcMomsRecomputed:/)).toBeInTheDocument();
  });

  it("a MOMS the owner typed stays theirs when the total moves", async () => {
    scans = [FULL];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await scanAndStepThrough(container);
    await toReview();
    // A mixed-rate day: the owner types the real MOMS.
    const momsBox = screen.getByText(/^enterMomsFromReceipt/).parentElement.querySelector("input");
    fireEvent.change(momsBox, { target: { value: "3.000" } });
    for (let i = 0; i < 6 && !container.querySelector("#dc-rev-food"); i++) {
      const back = screen.getAllByRole("button").find((b) => b.textContent.trim() === "← back");
      if (back) fireEvent.click(back);
      await new Promise((r) => setTimeout(r, 0));
    }
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "10.100" } });
    await toReview();
    const payload = await lockedPayload();
    expect(payload.moms_mode).toBe("manual");
    expect(payload.moms_total).toBe(3000);
  });
});

describe("daily close — a corrected till plus a second till", () => {
  it("the total box shows the sum, and a later edit is said, not printed as a false sum", async () => {
    scans = [
      { revenue: {}, revenue_total: 17030, moms_total: 3406, payments: { card: 12000 }, raw_text: "TILL 1" },
      { revenue: {}, revenue_total: 5000, moms_total: 1000, payments: { card: 5000 }, raw_text: "TILL 2" },
    ];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    shoot(container);
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    fireEvent.change(container.querySelector("#scan-total"), { target: { value: "16.450" } });
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanSecondTotalTitle")).toBeInTheDocument());
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());

    expect(container.querySelector("#scan-total").value).toBe("21.450");
    expect(container.textContent).toContain("16.450 kr.  +  5.000 kr. = 21.450 kr.");

    fireEvent.change(container.querySelector("#scan-total"), { target: { value: "21.500" } });
    // The sum of the tills stays the sum; the correction is its own line.
    expect(container.textContent).toContain("= 21.450 kr.");
    expect(screen.getByText("dcMergeCorrectedTo:21.500 kr.")).toBeInTheDocument();
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    const payload = await lockedPayload();
    expect(payload.revenue_total_override).toBe(21500);
    expect(payload.moms_mode).toBe("auto");
    expect(payload.moms_total).toBe(4300);
  });
});
