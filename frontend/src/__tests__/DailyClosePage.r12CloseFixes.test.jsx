/**
 * Round-12 review fixes for the daily close, each on the path a reviewer
 * walked.
 *
 * - MUST 1 (money): Mad corrected by hand on a full read (17.030 → the card
 *   saves 17.530), then a second till of 5.000 summed in. The sum added the
 *   PRINTED totals and saved 22.030 / MOMS 4.406 — the correction and its
 *   MOMS fell out of a signed kasserapport. It now saves 22.530 / 4.506, and
 *   the question, the card, the review and the payload agree.
 * - MUST 2 (confusing): after a category pushed the sum past the bon's total,
 *   the card still read "Samlet omsætning 17.030" beside MOMS for 17.130. The
 *   box now holds the total that is saved and a line says the Z-bon's figure,
 *   in both directions; the review explains "Gemmer total" both ways too.
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
  expect(container.textContent).toContain("dcScanBonVsSaved:22.030 kr.|22.530 kr.");
  expect(container.textContent).toContain("dcScanTillsOverBon:500 kr.");
  // MOMS follows the saved total — the bons' 4.406 belongs to 22.030.
  expect(container.textContent).toContain("4.506 kr.");
  fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
  await screen.findByText("confirmAndLock");
  expect(container.textContent).toContain("22.530,00");
  expect(container.textContent).toContain("4.506,00");
  // The bons' figure, the +500 and which way, then the split — they add up.
  expect(container.textContent).toContain("dcSavesBonsPlusCorrected:22.030,00 kr.|500,00 kr.|17.530,00 kr.");
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

describe("daily close — the scan card says the total it saves (MUST 2)", () => {
  it("categories above the bon: the box holds the saved total, a line names the Z-bon's", async () => {
    scans = [{ ...TILL1, revenue: { food: 9000, drinks: 6030, takeaway: 2000 } }];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    expect(container.textContent).not.toContain("dcScanBonVsSaved");
    fireEvent.change(cardBox(container, "6.030"), { target: { value: "6.130" } });

    expect(container.querySelector("#scan-total").value).toBe("17.130");
    expect(container.textContent).toContain("dcScanBonVsSaved:17.030 kr.|17.130 kr.");
    expect(container.textContent).toContain("dcScanLinesOverBon:100 kr.");
    expect(container.textContent).toContain("3.426 kr.");

    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    // "Gemmer total" says which way, like the lower-than-bon case does.
    expect(container.textContent).toContain("dcSavesSplitOverBon:100,00 kr.|17.030,00 kr.");
    const payload = await lockedPayload();
    expect(payload.revenue_breakdown).toMatchObject({ drinks: 6130 });
    expect(payload.moms_total).toBe(3426);
  });

  it("a total typed under the bon: the line names both, the other way", async () => {
    scans = [TILL1];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    shoot(container);
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    fireEvent.change(container.querySelector("#scan-total"), { target: { value: "16.950" } });
    expect(container.textContent).toContain("dcScanBonVsSaved:17.030 kr.|16.950 kr.");
    expect(container.textContent).toContain("dcScanBonVsSavedTyped");
    // Typed back to the bon's figure: nothing differs, nothing is said.
    fireEvent.change(container.querySelector("#scan-total"), { target: { value: "17.030" } });
    expect(container.textContent).not.toContain("dcScanBonVsSaved");
  });
});

/* ───────────────────────────────────────────────────────────────────────────
 * Review fixes on the above: the sum wrote each till's max(bon, lines) into
 * revenue_total, so a correction undone after the sum still saved 22.530.
 * ─────────────────────────────────────────────────────────────────────────── */
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};

describe("daily close — a summed day follows its categories after the sum", () => {
  it("correct, sum, then set Mad back on Trin 1: the payload goes back to 22.030 / 4.406", async () => {
    scans = [TILL1, TILL2];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.change(cardBox(container, "9.000"), { target: { value: "9.500" } });
    await addSecondTillAndSum(container);
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")?.value).toBe("9.500"));
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "9.000" } });
    // The merge line says the day moved since the sum — not "you corrected the total".
    expect(container.textContent).toContain("dcMergeNowSaves:22.030 kr.");
    expect(container.textContent).not.toContain("dcMergeCorrectedTo");
    for (let i = 0; i < 8 && !screen.queryByText("confirmAndLock"); i++) tapNext();
    await screen.findByText("confirmAndLock");
    expect(container.textContent).not.toContain("dcSavesBonsPlusCorrected");
    const payload = await lockedPayload();
    expect(payload.revenue_breakdown).toMatchObject({ food: 9000, drinks: 6000, takeaway: 2030 });
    expect(payload.revenue_total_override).toBe(22030);
    expect(payload.moms_total).toBe(4406);
  });

  it("Start forfra after a sum asks, even though the sum turned the correction into a number", async () => {
    scans = [TILL1, TILL2];
    const realConfirm = window.confirm;
    window.confirm = vi.fn(() => false);
    try {
      const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
      shoot(container);
      await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
      fireEvent.change(cardBox(container, "9.000"), { target: { value: "9.500" } });
      await addSecondTillAndSum(container);
      fireEvent.click(screen.getByText("startOver"));
      await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
      expect(screen.getByText("scanResults")).toBeInTheDocument();
      expect(container.querySelector("#scan-total").value).toBe("22.530");
    } finally {
      window.confirm = realConfirm;
    }
  });

  it("the card's payments check uses the total its box shows", async () => {
    scans = [{ ...TILL1, revenue: { food: 9000, drinks: 6030, takeaway: 2000 } }];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    expect(container.textContent).not.toContain("dcScanPayShort");
    fireEvent.change(cardBox(container, "6.030"), { target: { value: "6.130" } });
    expect(container.querySelector("#scan-total").value).toBe("17.130");
    expect(container.textContent).toContain("dcScanPayShort:17.030 kr.|100 kr.");
  });

  it("a till shot from the page's camera while on Trin 1 sums with the Trin-1 correction", async () => {
    scans = [TILL1, TILL2];
    // History could not be read: the page's own camera stays up over the wizard.
    get.mockImplementation((url) => (url === "/daily-close" ? Promise.reject(new Error("offline")) : Promise.resolve({ data: [] })));
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await waitFor(() => expect(container.querySelectorAll('input[type="file"]').length).toBe(2));
    const [hero, card] = container.querySelectorAll('input[type="file"]');
    fireEvent.change(card, { target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")?.value).toBe("9.000"));
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "9.500" } });
    fireEvent.change(hero, { target: { files: [new File(["x"], "kasse2.jpg", { type: "image/jpeg" })] } });
    await waitFor(() => expect(screen.getByText("scanSecondTotalTitle")).toBeInTheDocument());
    expect(screen.getByText("scanSecondTotalBody:5.000 kr.|17.530 kr.")).toBeInTheDocument();
  });
});
