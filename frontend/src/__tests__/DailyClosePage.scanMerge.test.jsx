/**
 * The two-terminal question, walked the way an owner walks it.
 *
 * dailyCloseScanMerge.test.js pins the arithmetic. This pins the moment that
 * actually lost the money: a café with a bar till and a counter till scans
 * both, and the second scan used to SILENTLY REPLACE the first — one till's
 * revenue locked into a signed kasserapport, with the copy on the same screen
 * promising the opposite ("tilføj flere sider, så samler vi tallene").
 *
 * Strings are asserted by key (t echoes the key plus its values), so this
 * pins behaviour and the money on the buttons, not the wording.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
  useEntitlements: () => ({ hasFeature: () => true, isReady: true }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
// The real resizer needs a canvas; the bytes are irrelevant to this test.
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

/** An OCR response shaped like /daily-close/scan-report. */
const scanReply = (total, revenue) => ({
  data: {
    revenue_total: total,
    revenue,
    payments: { card: total },
    raw_text: `KASSE ${total}`,
    ocr_available: true,
  },
});

const BAR_TILL = scanReply(17030, { food: 4200, drinks: 12830 });
const COUNTER_TILL = scanReply(4210, { food: 4210 });
/** A second PAGE of the same receipt: details, no competing total. */
const SECOND_PAGE = { data: { payments: { mobilepay: 2100 }, raw_text: "side 2" } };

const shootZReport = (container, name) => {
  const input = container.querySelector('input[type="file"]');
  fireEvent.change(input, {
    target: { files: [new File(["x"], name, { type: "image/jpeg" })] },
  });
};

/** What the camera roll actually does: several photos handed over in ONE pick. */
const shootZReports = (container, names) => {
  const input = container.querySelector('input[type="file"]');
  fireEvent.change(input, {
    target: { files: names.map((n) => new File(["x"], n, { type: "image/jpeg" })) },
  });
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
  get.mockResolvedValue({ data: [] });
  // jsdom has no object-URL implementation; the thumbnail preview needs one.
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
});

describe("daily close — a second Z-bon with its own total", () => {
  it("asks which it is, and puts both totals on the buttons", async () => {
    post.mockResolvedValueOnce(BAR_TILL).mockResolvedValueOnce(COUNTER_TILL);
    const { container } = renderPage();

    shootZReport(container, "kasse1.jpg");
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    shootZReport(container, "kasse2.jpg");

    await waitFor(() => expect(screen.getByText("scanSecondTotalTitle")).toBeInTheDocument());
    // The sum is on the button so the owner answers by looking at the money.
    // DK grouping — "21.240", never the browser-locale "21,240".
    expect(screen.getByText(/scanSecondTotalSum:21\.240 kr\./)).toBeInTheDocument();
    expect(screen.getByText(/scanSecondTotalReplace:4\.210 kr\./)).toBeInTheDocument();
  });

  it("will not let the owner walk past the question with the pre-scan numbers", async () => {
    post.mockResolvedValueOnce(BAR_TILL).mockResolvedValueOnce(COUNTER_TILL);
    const { container } = renderPage();

    shootZReport(container, "kasse1.jpg");
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    expect(screen.getByText("useTheseValuesJumpReview").closest("button")).not.toBeDisabled();

    shootZReport(container, "kasse2.jpg");
    await waitFor(() => expect(screen.getByText("scanSecondTotalTitle")).toBeInTheDocument());
    expect(screen.getByText("useTheseValuesJumpReview").closest("button")).toBeDisabled();
    expect(screen.getByText("continueStepByStep").closest("button")).toBeDisabled();
    // A third photo would replace the unanswered second one — so it is gone.
    expect(screen.queryByText(/addAnotherPhoto/)).not.toBeInTheDocument();
  });

  it("sums on 'another terminal' and says so, with an undo", async () => {
    post.mockResolvedValueOnce(BAR_TILL).mockResolvedValueOnce(COUNTER_TILL);
    const { container } = renderPage();

    shootZReport(container, "kasse1.jpg");
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    shootZReport(container, "kasse2.jpg");
    await waitFor(() => expect(screen.getByText("scanSecondTotalTitle")).toBeInTheDocument());
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));

    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
    // The per-till totals stay on screen so a wrong tap is catchable.
    expect(container.textContent).toContain("17.030 kr.");
    expect(container.textContent).toContain("21.240 kr.");
    expect(screen.getByText("scanMergedUndo")).toBeInTheDocument();
    // Drinks were only on the bar till's receipt — say so BY NAME, do not
    // invent a sum. An unnamed "some lines" note is a line the owner cannot
    // check, and the worst of them (MOMS) is pinned in its own test below.
    expect(screen.getByText(/^scanMergedIncompleteNamed:.+/)).toBeInTheDocument();
  });

  it("keeps every till when three photos are picked in one go", async () => {
    // The file input is `multiple` and the handler awaits one scan per file in
    // a loop. Before this, scan 3 overwrote the still-unanswered scan 2 while
    // the comparison was still against scan 1 — the middle till's numbers
    // never reached state, were never asked about, and were never merged. The
    // owner was asked ONE question (till 1 vs till 3), tapped "add them up",
    // and locked a kasserapport missing a whole terminal, with all three
    // thumbnails on screen as evidence they had scanned it.
    const THIRD_TILL = scanReply(3000, { food: 3000 });
    post.mockResolvedValueOnce(BAR_TILL)
      .mockResolvedValueOnce(COUNTER_TILL)
      .mockResolvedValueOnce(THIRD_TILL);
    const { container } = renderPage();

    shootZReports(container, ["bar.jpg", "disk.jpg", "terrasse.jpg"]);

    // First question: bar (17.030) vs counter (4.210), and it says one more
    // photo is still in line rather than implying this answer covers it.
    await waitFor(() => expect(screen.getByText("scanSecondTotalTitle")).toBeInTheDocument());
    expect(screen.getByText(/scanSecondTotalSum:21\.240 kr\./)).toBeInTheDocument();
    expect(screen.getByText("scanPendingMore:1")).toBeInTheDocument();
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));

    // Second question: the running sum (21.240) vs the terrace till (3.000).
    await waitFor(() => expect(screen.getByText(/scanSecondTotalSum:24\.240 kr\./)).toBeInTheDocument());
    expect(screen.queryByText(/^scanPendingMore:/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));

    // All three tills are in the total, and the card says so.
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:3")).toBeInTheDocument());
    expect(container.textContent).toContain("24.240 kr.");
    expect(post).toHaveBeenCalledTimes(3);
  });

  it("still says the headline is a SUM on the step where it locks", async () => {
    // The disclosure used to live only inside the scan result card, which
    // unmounts on the very tap that jumps to review — so the per-till totals
    // and the "check these before you lock" note vanished on the way to the
    // screen they were warning about.
    post.mockResolvedValueOnce(BAR_TILL).mockResolvedValueOnce(COUNTER_TILL);
    const { container } = renderPage();

    shootZReport(container, "bar.jpg");
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    shootZReport(container, "disk.jpg");
    await waitFor(() => expect(screen.getByText("scanSecondTotalTitle")).toBeInTheDocument());
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());

    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));

    // Off the scan card and onto the wizard...
    await waitFor(() => expect(screen.queryByText("scanResults")).not.toBeInTheDocument());
    // ...and the sum is still declared, with the per-till totals behind it.
    expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument();
    expect(container.textContent).toContain("17.030 kr.");
    expect(screen.getByText(/^scanMergedIncompleteNamed:.+/)).toBeInTheDocument();
    // Undo belongs to the card — by here the owner may have typed over it.
    expect(screen.queryByText("scanMergedUndo")).not.toBeInTheDocument();
  });

  it("asks nothing extra when the batch is one till plus detail pages", async () => {
    // The common case must not get a new tap: a two-page receipt has exactly
    // one headline total, so there is no question to ask.
    post.mockResolvedValueOnce(BAR_TILL).mockResolvedValueOnce(SECOND_PAGE);
    const { container } = renderPage();

    shootZReports(container, ["side1.jpg", "side2.jpg"]);

    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    expect(screen.queryByText("scanSecondTotalTitle")).not.toBeInTheDocument();
    expect(screen.getByText("useTheseValuesJumpReview").closest("button")).not.toBeDisabled();
  });

  it("will not file one till's MOMS against a two-till total", async () => {
    // The defect this pins: sumMerge keeps terminal 1's moms_total when
    // terminal 2's line was unreadable, applyScanValues then wrote it into the
    // MOMS field as "from the receipt", and the backend takes a supplied
    // moms_total verbatim. 3.406 kr of VAT on 21.240 kr of revenue — roughly
    // 842 kr under-declared for the day, inside a signed kasserapport.
    const barWithMoms = { data: { ...BAR_TILL.data, moms_total: 3406 } };
    const counterNoMoms = { data: { ...COUNTER_TILL.data } };
    post.mockResolvedValueOnce(barWithMoms).mockResolvedValueOnce(counterNoMoms);
    const { container } = renderPage();

    shootZReport(container, "bar.jpg");
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    // One till: the scanned MOMS is genuinely the receipt's, badged OCR.
    const momsHeading = () => screen.getByText(/MOMS \(25%\)/).closest("h3");
    expect(within(momsHeading()).getByText("OCR")).toBeInTheDocument();

    shootZReport(container, "disk.jpg");
    await waitFor(() => expect(screen.getByText("scanSecondTotalTitle")).toBeInTheDocument());
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());

    // MOMS is named as un-summable...
    expect(screen.getByText(/scanMergedIncompleteNamed:.*MOMS/)).toBeInTheDocument();
    // ...the OCR badge is withdrawn (the number no longer covers the total)...
    expect(within(momsHeading()).queryByText("OCR")).not.toBeInTheDocument();
    // ...and the figure shown is 25% of the SUMMED revenue (21.240 → 4.248),
    // never the bar till's 3.406.
    expect(container.textContent).toContain("4.248 kr.");
    expect(container.textContent).not.toContain("3.406 kr.");
  });

  it("undo puts the first till's numbers back and re-asks instead of discarding", async () => {
    post.mockResolvedValueOnce(BAR_TILL).mockResolvedValueOnce(COUNTER_TILL);
    const { container } = renderPage();

    shootZReport(container, "kasse1.jpg");
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    shootZReport(container, "kasse2.jpg");
    await waitFor(() => expect(screen.getByText("scanSecondTotalTitle")).toBeInTheDocument());
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());

    fireEvent.click(screen.getByText("scanMergedUndo"));
    await waitFor(() => expect(screen.queryByText("scanMergedTerminals:2")).not.toBeInTheDocument());
    // The headline is the bar till again — 21.240 is no longer a total.
    expect(screen.getByText(/scanGapTotalIs:17\.030 kr\./)).toBeInTheDocument();
    // ...and the counter till is NOT thrown away: the question comes back so
    // the owner can answer it the other way. An undo that silently discarded
    // the second scan would be the same loss in a friendlier wrapper.
    expect(screen.getByText("scanSecondTotalTitle")).toBeInTheDocument();
    expect(screen.getByText("useTheseValuesJumpReview").closest("button")).toBeDisabled();
  });

  it("replaces on 'same terminal' — a retake is still a retake", async () => {
    const sharper = scanReply(17030, { food: 4200, drinks: 12830 });
    post.mockResolvedValueOnce(BAR_TILL).mockResolvedValueOnce(sharper);
    const { container } = renderPage();

    shootZReport(container, "kasse1.jpg");
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    shootZReport(container, "kasse1-igen.jpg");
    await waitFor(() => expect(screen.getByText("scanSecondTotalTitle")).toBeInTheDocument());
    fireEvent.click(screen.getByText(/scanSecondTotalReplace/));

    await waitFor(() => expect(screen.queryByText("scanSecondTotalTitle")).not.toBeInTheDocument());
    expect(screen.queryByText(/scanMergedTerminals/)).not.toBeInTheDocument();
    expect(container.textContent).toContain("17.030");
    expect(container.textContent).not.toContain("34.060"); // never doubled
  });

  it("never asks for a genuine second page — that one still just merges", async () => {
    post.mockResolvedValueOnce(BAR_TILL).mockResolvedValueOnce(SECOND_PAGE);
    const { container } = renderPage();

    shootZReport(container, "side1.jpg");
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    shootZReport(container, "side2.jpg");

    await waitFor(() => expect(screen.getAllByText("receiptPhotosLabel").length).toBeGreaterThan(0));
    expect(screen.queryByText("scanSecondTotalTitle")).not.toBeInTheDocument();
    expect(screen.getByText("useTheseValuesJumpReview").closest("button")).not.toBeDisabled();
  });
});
