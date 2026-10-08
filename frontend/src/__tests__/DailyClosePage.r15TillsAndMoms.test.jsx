/**
 * Round 15, must-fix 2 and 3.
 *
 * 2. Second till: "Er det en terminal mere?" rendered far above the viewport
 *    (the photo comes from "+ Tilføj" at the bottom of the card; the question
 *    mounts at the top) while "Brug disse tal" / "Fortsæt trin for trin" went
 *    gray with no reason. The question is brought into view and focused each
 *    time it appears — a new photo, Fortryd, the next queued photo — and a
 *    one-line reason sits above the gray buttons.
 *
 * 3. "Fra kvittering" with an EMPTY box: the review printed "MOMS (fra bon)
 *    0,00" while the lock sent null + "manual" and the server saved its own
 *    3.426 as manual. An empty box is "not typed yet": the review shows the
 *    figure that is saved, under its true source, and the payload agrees.
 *
 * Strings are asserted by key (t echoes the key plus its values).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
const TILL2 = { revenue: {}, revenue_total: 5000, moms_total: 1000, payments: { card: 5000 }, raw_text: "TILL 2", ocr_available: true };
const TILL3 = { revenue: {}, revenue_total: 3000, moms_total: 600, payments: { card: 3000 }, raw_text: "TILL 3", ocr_available: true };
const PARTIAL = { revenue: { food: 10000 }, revenue_total: 17030, moms_total: 3406, payments: { card: 12000 }, raw_text: "PARTIAL", ocr_available: true };
let scans = [];
let scrolled;
const realScrollIntoView = Element.prototype.scrollIntoView;

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
  scrolled = [];
  Element.prototype.scrollIntoView = function (opts) { scrolled.push({ el: this, opts }); };
});
afterEach(() => {
  Element.prototype.scrollIntoView = realScrollIntoView;
});

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
const shoot = (container, n = 1) =>
  fireEvent.change(container.querySelector('input[type="file"]'), {
    target: { files: Array.from({ length: n }, (_, i) => new File(["x"], `kasse${i}.jpg`, { type: "image/jpeg" })) },
  });
const question = () => screen.queryByTestId("dc-terminal-question");
const questionScrolls = () => scrolled.filter((s) => s.el === question()).length;

describe("daily close — the second-till question comes to the owner (must-fix 2)", () => {
  it("is scrolled into view and focused, and the gray buttons say why", async () => {
    scans = [TILL1, TILL2];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    expect(screen.queryByText("dcScanAnswerQuestionFirst")).not.toBeInTheDocument();

    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    await waitFor(() => expect(questionScrolls()).toBeGreaterThan(0));
    const last = scrolled.filter((s) => s.el === question()).at(-1);
    expect(last.opts).toMatchObject({ block: "center" });
    expect(document.activeElement).toBe(question());
    expect(question().getAttribute("aria-labelledby")).toBe("dc-terminal-q");

    // The reason, right above the two gray buttons, tied to them.
    const reason = screen.getByText("dcScanAnswerQuestionFirst").closest("button");
    const use = screen.getByText("useTheseValuesJumpReview").closest("button");
    const steps = screen.getByText("continueStepByStep").closest("button");
    expect(use).toBeDisabled();
    expect(steps).toBeDisabled();
    expect(use.getAttribute("aria-describedby")).toBe(reason.id);
    expect(steps.getAttribute("aria-describedby")).toBe(reason.id);
    expect(reason.compareDocumentPosition(use) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(reason.className).toMatch(/min-h-10/);

    // A tap on the reason takes the owner to the question again.
    const before = questionScrolls();
    fireEvent.click(reason);
    expect(questionScrolls()).toBe(before + 1);

    // Answered: the reason goes with the question.
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(question()).toBeNull());
    expect(screen.queryByText("dcScanAnswerQuestionFirst")).not.toBeInTheDocument();
    expect(screen.getByText("useTheseValuesJumpReview").closest("button")).not.toBeDisabled();
  });

  it("comes back into view after Fortryd", async () => {
    scans = [TILL1, TILL2];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());

    scrolled = [];
    fireEvent.click(screen.getByText("scanMergedUndo"));
    await waitFor(() => expect(question()).not.toBeNull());
    await waitFor(() => expect(questionScrolls()).toBeGreaterThan(0));
    expect(document.activeElement).toBe(question());
    expect(screen.getByText("dcScanAnswerQuestionFirst")).toBeInTheDocument();
  });

  it("the next queued photo's question is brought into view too", async () => {
    scans = [TILL1, TILL2, TILL3];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    // Two more photos in one pick: two questions, one after the other.
    shoot(container, 2);
    await waitFor(() => expect(screen.getByText(/scanPendingMore:1/)).toBeInTheDocument());
    await waitFor(() => expect(questionScrolls()).toBeGreaterThan(0));

    scrolled = [];
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.queryByText(/scanPendingMore/)).not.toBeInTheDocument());
    expect(question()).not.toBeNull();
    await waitFor(() => expect(questionScrolls()).toBeGreaterThan(0));
    expect(document.activeElement).toBe(question());
  });
});

/* ── must-fix 3 ─────────────────────────────────────────────────────────── */
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};
const toReview = async () => {
  for (let i = 0; i < 8 && !screen.queryByText("confirmAndLock"); i++) tapNext();
  await screen.findByText("confirmAndLock");
};
/** The review's MOMS ledger line: "MOMS 25%[ (fra bon)] … amount". */
const momsLine = (container) => {
  const span = [...container.querySelectorAll("span")].find((s) => /^MOMS 25%/.test(s.textContent));
  return span?.parentElement?.textContent || "";
};
const tapFromReceipt = () => {
  const chip = screen.getByText("fromReceipt");
  fireEvent.click(chip.closest("button") || chip);
};
const lockedPayload = async () => {
  fireEvent.click(screen.getByText("confirmAndLock"));
  await waitFor(() =>
    expect(post.mock.calls.some(([url, body]) => url === "/daily-close" && body?.status === "confirmed")).toBe(true),
  );
  return post.mock.calls.find(([url, body]) => url === "/daily-close" && body?.status === "confirmed")[1];
};
const manualReview = async (container, amount = "17.130") => {
  fireEvent.click(screen.getByText("skipEnterManually"));
  await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
  fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: amount } });
  await toReview();
};

describe("daily close — an empty \"Fra kvittering\" box is not a typed 0 (must-fix 3)", () => {
  it("typed by hand: the review shows the 3.426 that is saved, as auto, and so does the payload", async () => {
    const { container } = renderPage();
    await manualReview(container);
    tapFromReceipt();
    const box = await screen.findByPlaceholderText("momsAmountPlaceholder");
    expect(box.value).toBe("");

    expect(momsLine(container)).toContain("3.426,00");
    expect(momsLine(container)).not.toContain("fromReceiptSuffix");
    expect(momsLine(container)).not.toMatch(/(^|[^\d.])0,00/);
    expect(container.textContent).toContain("13.704,00");
    // Says which figure is saved, and the caption names where it comes from.
    expect(container.textContent).toContain("dcMomsManualEmpty:3.426 kr.");
    expect(container.textContent).toContain("momsAutoCalc:25|125");

    const payload = await lockedPayload();
    expect(payload.moms_mode).toBe("auto");
    expect(payload.moms_total).toBe(3426);
  });

  it("a typed figure is the owner's: labelled from the receipt and sent as typed — a typed 0 included", async () => {
    const { container } = renderPage();
    await manualReview(container);
    tapFromReceipt();
    const box = await screen.findByPlaceholderText("momsAmountPlaceholder");
    fireEvent.change(box, { target: { value: "3.400" } });
    expect(momsLine(container)).toContain("fromReceiptSuffix");
    expect(momsLine(container)).toContain("3.400,00");
    expect(container.textContent).not.toContain("dcMomsManualEmpty");

    fireEvent.change(box, { target: { value: "0" } });
    expect(momsLine(container)).toContain("fromReceiptSuffix");
    expect(momsLine(container)).toContain("0,00");
    const payload = await lockedPayload();
    expect(payload.moms_mode).toBe("manual");
    expect(payload.moms_total).toBe(0);
  });

  it("the scanned MOMS emptied out of the box: the bon's 3.406 is shown and saved, named as read", async () => {
    scans = [TILL1];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    const box = await screen.findByPlaceholderText("momsAmountPlaceholder");
    expect(box.value).toBe("3.406");
    fireEvent.change(box, { target: { value: "" } });

    expect(momsLine(container)).toContain("3.406,00");
    expect(momsLine(container)).not.toContain("fromReceiptSuffix");
    expect(container.textContent).toContain("momsFromZReport");
    expect(container.textContent).toContain("dcMomsManualEmpty:3.406 kr.");
    const payload = await lockedPayload();
    // The bon's figure goes as the bon's ("manual" + source_meta zbon → "fra
    // Z-bon"), never as "beregnet af BonBox" — see r15ReviewFixes.
    expect(payload.moms_mode).toBe("manual");
    expect(payload.moms_total).toBe(3406);
    expect(payload.source_meta.kind).toBe("zbon");
  });

  it("the reviewer's path: partial read, total corrected to 18.000, Fra kvittering left empty", async () => {
    scans = [PARTIAL];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    fireEvent.change(container.querySelector("#scan-total"), { target: { value: "18.000" } });
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    tapFromReceipt();
    const box = await screen.findByPlaceholderText("momsAmountPlaceholder");
    expect(box.value).toBe("");

    expect(momsLine(container)).toContain("3.600,00");
    expect(momsLine(container)).not.toContain("fromReceiptSuffix");
    expect(container.textContent).toContain("14.400,00");
    const payload = await lockedPayload();
    expect(payload.moms_mode).toBe("auto");
    expect(payload.moms_total).toBe(3600);
  });
});
