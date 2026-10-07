/**
 * Round-12 review fixes for the daily close, each on the path a reviewer
 * walked.
 *
 * - MUST 1 (money): Mad corrected by hand on a full read (17.030 → the card
 *   saves 17.530), then a second till of 5.000 summed in. The sum added the
 *   PRINTED totals and saved 22.030 / MOMS 4.406 — the correction and its
 *   MOMS fell out of a signed kasserapport. It now saves 22.530 / 4.506, and
 *   the question, the card, the review and the payload agree.
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

const TILL1 = {
  revenue: { food: 9000, drinks: 6000, takeaway: 2030 }, revenue_total: 17030, moms_total: 3406,
  payments: { card: 12000, cash: 4030, mobilepay: 1000 }, raw_text: "TILL 1", ocr_available: true,
};
const TILL2 = {
  revenue: {}, revenue_total: 5000, moms_total: 1000, payments: { card: 5000 }, raw_text: "TILL 2", ocr_available: true,
};
let scans = [];

beforeEach(() => {
  window.scrollTo = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockResolvedValue({ data: [] });
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  post.mockImplementation((url) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() });
    return Promise.resolve({ data: { id: 1, status: "confirmed" } });
  });
});

const shoot = (container) =>
  fireEvent.change(container.querySelector('input[type="file"]'), {
    target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] },
  });
const cardBox = (container, value) => [...container.querySelectorAll("input")].find((i) => i.value === value);
const lockedPayload = async () => {
  fireEvent.click(screen.getByText("confirmAndLock"));
  await waitFor(() =>
    expect(post.mock.calls.some(([url, body]) => url === "/daily-close" && body?.status === "confirmed")).toBe(true),
  );
  return post.mock.calls.find(([url, body]) => url === "/daily-close" && body?.status === "confirmed")[1];
};
const addSecondTillAndSum = async (container) => {
  shoot(container);
  await waitFor(() => expect(screen.getByText("scanSecondTotalTitle")).toBeInTheDocument());
  // The question quotes what the card saves, and the sum it will save.
  expect(screen.getByText("scanSecondTotalBody:5.000 kr.|17.530 kr.")).toBeInTheDocument();
  fireEvent.click(screen.getByText("scanSecondTotalSum:22.530 kr."));
  await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
};
const expectSummedSave = async (container) => {
  expect(container.querySelector("#scan-total").value).toBe("22.530");
  expect(container.textContent).toContain("17.530 kr.  +  5.000 kr. = 22.530 kr.");
  // MOMS follows the saved total — the bons' 4.406 belongs to 22.030.
  expect(container.textContent).toContain("4.506 kr.");
  fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
  await screen.findByText("confirmAndLock");
  expect(container.textContent).toContain("22.530,00");
  expect(container.textContent).toContain("4.506,00");
  const payload = await lockedPayload();
  expect(payload.revenue_breakdown).toMatchObject({ food: 9500, drinks: 6000, takeaway: 2030 });
  expect(payload.revenue_total_override).toBe(22530);
  expect(payload.revenue_total_owner_set).toBe(false);
  expect(payload.moms_mode).toBe("auto");
  expect(payload.moms_total).toBe(4506);
};

describe("daily close — a hand-corrected category survives a second till (MUST 1)", () => {
  it("corrected on the scan card: the sum saves 22.530 with MOMS 4.506", async () => {
    scans = [TILL1, TILL2];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.change(cardBox(container, "9.000"), { target: { value: "9.500" } });
    await addSecondTillAndSum(container);
    await expectSummedSave(container);
  });

  it("corrected on Trin 1, back to the card, then the second till: the same", async () => {
    scans = [TILL1, TILL2];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")?.value).toBe("9.000"));
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "9.500" } });
    fireEvent.click(screen.getByText("← scanZReportBack"));
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    await addSecondTillAndSum(container);
    await expectSummedSave(container);
  });
});
