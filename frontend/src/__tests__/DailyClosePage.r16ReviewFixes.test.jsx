/**
 * Round 16 review fixes on the daily close.
 *
 * 1. "Start forfra" on a card whose first side was the FORM (a typed close, a
 *    reopened draft) no longer turns the form seed off: the boxes still hold
 *    the owner's figures, so a retaken photo is asked about again instead of
 *    replacing them (the C4 overwrite). A typed MOMS is not reset either —
 *    only figures a scan put in the form go with the scan.
 * 2. A typed till summed with a Z-bon goes to the revisor as what it is:
 *    the typed till is marked typed (typed_tills), its own lines are listed
 *    as typed, and the photo count is the photos.
 * 3. A page with a MOMS but no total, over a typed close: that MOMS belongs
 *    to no known total, so it is worked out again (Auto), never filed "fra
 *    Z-bon" against the typed total.
 * 4. A drawer count or a MOMS typed for day A holds the autosave on a date
 *    move like typed sales do — and "Hent {B}s salg" takes them away too.
 * 5. A typed MOMS is carried into a sum: the owner's 3.000 + the bon's 800.
 * 6. A scan summed onto figures typed for another day keeps the date question
 *    open; nothing is filed for the new day until it is answered.
 * 7. A line the owner typed and the new bon lacks is still named as "not
 *    added up" — under words that do not call it a bon's line.
 *
 * Strings are asserted by key (t echoes the key plus its values).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const DRAFT = {
  id: "d1", date: today, status: "draft",
  revenue_total: 17130,
  revenue_breakdown: { food: 9600, drinks: 5500, takeaway: 2030 },
  payment_breakdown: { card: 12000, cash: 5130 },
  moms_mode: "auto", moms_total: 3426,
  closed_by: "Test", notes: "Test",
};
const TILL2 = { revenue: {}, revenue_total: 4000, moms_total: 800, payments: { card: 4000 }, raw_text: "TILL 2", ocr_available: true };
const TILL1 = {
  revenue: { food: 9000, drinks: 6000, takeaway: 2030 }, revenue_total: 17030, moms_total: 3406,
  payments: { card: 12000, cash: 4030, mobilepay: 1000 }, raw_text: "TILL 1", ocr_available: true,
};
const EMPTY_DAY = { has_data: false, day_cutoff_hour: 6, sales: { total: 0, count: 0 }, expenses: { total: 0, count: 0 } };
const syncDay = (food, drinks, card, cash) => ({
  has_data: true,
  day_cutoff_hour: 6,
  sales: { total: food + drinks, count: 7, by_payment_method: { card, cash }, by_item: { Burger: food + drinks } },
  expenses: { total: 0, count: 0, by_category: {} },
  gavekort: { redeemed: 0, tender: 0 },
  suggested_prefill: { revenue_total: food + drinks, payment_breakdown: { card, cash }, cash_expected: cash },
  category_split: { source: "history", confidence: "high", sample_size: 12, categories: { food, drinks } },
});

let closes = [];
let scans = [];
let prefillByDate = {};
const realConfirm = window.confirm;
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.confirm = vi.fn(() => true);
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  closes = [];
  scans = [];
  prefillByDate = {};
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url, cfg) => {
    if (url === "/daily-close") return Promise.resolve({ data: closes });
    if (url === "/daily-close/prefill") return Promise.resolve({ data: prefillByDate[cfg?.params?.date] || EMPTY_DAY });
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() || TILL2 });
    return Promise.resolve({ data: { id: "d1", status: "draft" } });
  });
});
afterEach(() => { window.confirm = realConfirm; });

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
const closePosts = () => post.mock.calls.filter(([url]) => url === "/daily-close").map(([, body]) => body);
const drafts = (date) => closePosts().filter((b) => b?.status === "draft" && b?.date === date);
const question = () => screen.queryByTestId("dc-terminal-question");
const choice = () => screen.queryByTestId("dc-date-move");
const cardInput = (container) => [...container.querySelectorAll('input[type="file"]')].at(-1);
const shoot = (container) =>
  fireEvent.change(cardInput(container), { target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] } });
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
};
const tapBack = () => {
  const btn = screen.getAllByRole("button").find((b) => /^←\s*back$/.test(b.textContent.trim()));
  if (btn) fireEvent.click(btn);
  return Boolean(btn);
};
const toReview = async () => {
  for (let i = 0; i < 8 && !screen.queryByText("confirmAndLock"); i++) tapNext();
  await screen.findByText("confirmAndLock");
};
const toStep = async (container, selector) => {
  for (let i = 0; i < 8 && !container.querySelector(selector); i++) tapNext();
  await waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
};
const typeMoms = (amount) => {
  const chip = screen.getByText("fromReceipt");
  fireEvent.click(chip.closest("button") || chip);
  fireEvent.change(screen.getByPlaceholderText("momsAmountPlaceholder"), { target: { value: amount } });
};
const backToStepOne = async () => {
  for (let i = 0; i < 8 && tapBack(); i++) { /* back to Trin 1 */ }
  await waitFor(() => expect(screen.getByText("← scanZReportBack")).toBeInTheDocument());
};
const lockedPayload = async () => {
  fireEvent.click(await screen.findByText("confirmAndLock"));
  await waitFor(() => expect(closePosts().some((b) => b?.status === "confirmed")).toBe(true));
  return closePosts().find((b) => b?.status === "confirmed");
};
const typedClose = async (amount = "17.130") => {
  const view = renderPage();
  fireEvent.click(await screen.findByText("skipEnterManually"));
  await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
  fireEvent.change(view.container.querySelector("#dc-rev-food"), { target: { value: amount } });
  return view;
};
const toScanCard = async () => {
  fireEvent.click(screen.getByText("← scanZReportBack"));
  await waitFor(() => expect(screen.getByText("scanZReportTitle")).toBeInTheDocument());
};
const startOver = async () => {
  fireEvent.click(screen.getByText("startOver"));
  await waitFor(() => expect(screen.queryByText("scanResults")).not.toBeInTheDocument());
};
const posted4000Over = () => closePosts().some((b) => b?.revenue_total_override === 4000
  || (b?.payment_breakdown?.card === 4000 && !b?.revenue_breakdown?.food));

describe("Start forfra on a card seeded from the form (review 1 / 7)", () => {
  it("typed close: after Start forfra a retaken photo is asked about again, never filed over 17.130", async () => {
    const { container } = await typedClose();
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    await startOver();
    // The typed figure is still the form's.
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    expect(question().textContent).toContain("scanSecondTotalBody:4.000 kr.|17.130 kr.");
    await tick(2300);
    expect(posted4000Over()).toBe(false);
  }, 12000);

  it("reopened draft (Fortsæt kladden): the same", async () => {
    closes = [DRAFT];
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("9.600"));
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    await startOver();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    expect(question().textContent).toContain("scanSecondTotalBody:4.000 kr.|17.130 kr.");
    await tick(2300);
    expect(posted4000Over()).toBe(false);
  }, 12000);

  it("keeps a MOMS the owner typed: Start forfra resets only what a scan put in", async () => {
    const { container } = await typedClose();
    await toReview();
    typeMoms("3.000");
    await backToStepOne();
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    await startOver();
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    expect(container.querySelector("#dc-rev-food").value).toBe("17.130");
    await toReview();
    const payload = await lockedPayload();
    expect(payload.moms_mode).toBe("manual");
    expect(payload.moms_total).toBe(3000);
  }, 15000);

  it("an applied Z-bon thrown away with Start forfra is still a fresh start (no question)", async () => {
    scans = [TILL1, TILL2];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")?.value).toBe("9.000"));
    fireEvent.click(screen.getByText("← scanZReportBack"));
    await waitFor(() => expect(screen.getByText("startOver")).toBeInTheDocument());
    await startOver();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    expect(question()).toBeNull();
    expect(container.querySelector("#scan-total").value).toBe("4.000");
  }, 12000);
});

describe("a typed till summed with a Z-bon, on the revisor's record (review 2 + 5)", () => {
  it("the typed till is marked typed, and its own line is listed as typed", async () => {
    const { container } = await typedClose();
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const payload = await lockedPayload();
    expect(payload.revenue_total_override).toBe(21130);
    expect(payload.source_meta).toEqual({
      kind: "zbon", scans: 1, terminal_totals: [17130, 4000], typed_tills: [0], corrected: [], typed: ["rev:food"],
    });
    // Till 1 had no MOMS of its own: worked out on the sum, never "fra Z-bon".
    expect(payload.moms_mode).toBe("auto");
    expect(payload.moms_total).toBe(4226);
  }, 12000);

  it("a typed MOMS is carried into the sum: 3.000 + the bon's 800 = 3.800, the owner's figure", async () => {
    const { container } = await typedClose();
    await toReview();
    typeMoms("3.000");
    await backToStepOne();
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
    // The card shows what applying leaves — and does not call it read.
    expect(container.textContent).toContain("3.800 kr.");
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    await tick(30);
    const payload = await lockedPayload();
    expect(payload.moms_mode).toBe("manual");
    expect(payload.moms_total).toBe(3800);
    expect(payload.source_meta.typed_tills).toEqual([0]);
  }, 15000);

  it("a reopened draft with a manual MOMS: carried the same way", async () => {
    closes = [{ ...DRAFT, moms_mode: "manual", moms_total: 3000 }];
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("9.600"));
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    await tick(30);
    const payload = await lockedPayload();
    expect(payload.moms_mode).toBe("manual");
    expect(payload.moms_total).toBe(3800);
    expect(payload.source_meta).toMatchObject({ kind: "zbon", scans: 1, terminal_totals: [17130, 4000], typed_tills: [0] });
    // Lines only the draft carried are the owner's, listed as typed.
    expect(payload.source_meta.typed).toEqual(expect.arrayContaining(["rev:food", "rev:drinks", "rev:takeaway", "pay:cash"]));
    expect(payload.source_meta.typed).not.toContain("pay:card");
  }, 15000);
});

describe("a MOMS typed on a reopened draft, then a second bon (review 5)", () => {
  it("the typed 3.000 is carried and summed — not kept alone as \"typed since the last apply\"", async () => {
    closes = [DRAFT];
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("9.600"));
    await toReview();
    typeMoms("3.000");
    await backToStepOne();
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
    expect(container.textContent).toContain("3.800 kr.");
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    await tick(30);
    const payload = await lockedPayload();
    expect(payload.moms_mode).toBe("manual");
    expect(payload.moms_total).toBe(3800);
  }, 15000);
});

describe("a MOMS-only page over a typed close (review 3)", () => {
  it("the page's MOMS belongs to no known total: Auto 3.426, never manual 800 on 17.130", async () => {
    scans = [{ revenue: {}, payments: { card: 4000 }, moms_total: 800, raw_text: "PAGE", ocr_available: true }];
    const { container } = await typedClose();
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    expect(question()).toBeNull();
    // Said on the card, with the bon's figure named.
    expect(container.textContent).toMatch(/dcMomsRecomputed:800 kr\./);
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const payload = await lockedPayload();
    expect(payload.moms_mode).toBe("auto");
    expect(payload.moms_total).toBe(3426);
    // The typed line stays the owner's on the record.
    expect(payload.source_meta).toMatchObject({ kind: "zbon", scans: 1, typed: ["rev:food"] });
  }, 12000);
});

describe("a drawer count or a MOMS typed for another day (review 4)", () => {
  const syncedWithCashAndMoms = async () => {
    prefillByDate["2026-09-25"] = syncDay(17130, 0, 12000, 5130);
    prefillByDate["2026-09-26"] = syncDay(1100, 750, 1250, 600);
    const view = renderPage();
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(view.container.querySelector("#close-date"), { target: { value: "2026-09-25" } });
    await waitFor(() => expect(view.container.querySelector("#dc-rev-food").value).toBe("17.130"));
    await toStep(view.container, "#cash-counted");
    fireEvent.change(view.container.querySelector("#cash-counted"), { target: { value: "5.000" } });
    await toReview();
    typeMoms("500");
    await tick(30);
    return view;
  };

  it("synced boxes + a typed drawer count and MOMS: moving the date asks, and files nothing for the new day", async () => {
    const { container } = await syncedWithCashAndMoms();
    fireEvent.change(container.querySelector("#close-date"), { target: { value: "2026-09-26" } });
    await waitFor(() => expect(choice()).not.toBeNull());
    await tick(2300);
    expect(drafts("2026-09-26")).toHaveLength(0);
  }, 15000);

  it("\"Hent\" takes day A's MOMS and drawer count away with its sales", async () => {
    const { container } = await syncedWithCashAndMoms();
    fireEvent.change(container.querySelector("#close-date"), { target: { value: "2026-09-26" } });
    await waitFor(() => expect(choice()).not.toBeNull());
    fireEvent.click(screen.getByText(/^dcDateMoveFetch/));
    await waitFor(() => expect(drafts("2026-09-26")).toHaveLength(1), { timeout: 3500 });
    expect(drafts("2026-09-26")[0]).toMatchObject({
      revenue_breakdown: { food: 1100, drinks: 750 },
      moms_mode: "auto",
      cash_counted: null,
    });
    expect(drafts("2026-09-26")[0].moms_total).toBe(370);
  }, 15000);
});

describe("a scan summed onto figures typed for another day (review 6)", () => {
  it("the date question stays open and nothing is filed for the new day until it is answered", async () => {
    prefillByDate["2026-09-26"] = syncDay(1100, 750, 1250, 600);
    const { container } = renderPage();
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#close-date"), { target: { value: "2026-09-25" } });
    await tick(30);
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "17.130" } });
    await waitFor(() => expect(drafts("2026-09-25")).toHaveLength(1), { timeout: 3500 });
    fireEvent.change(container.querySelector("#close-date"), { target: { value: "2026-09-26" } });
    await waitFor(() => expect(choice()).not.toBeNull());

    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    // Still asked — and "Hent" is not offered over a Z-bon's figures.
    expect(choice()).not.toBeNull();
    expect(choice().textContent).not.toContain("dcDateMoveFetch");
    await tick(2300);
    expect(drafts("2026-09-26")).toHaveLength(0);

    fireEvent.click(screen.getByText(/^dcDateMoveKeep/));
    await waitFor(() => expect(drafts("2026-09-26")).toHaveLength(1), { timeout: 3500 });
    expect(drafts("2026-09-26")[0].revenue_total_override).toBe(21130);
  }, 15000);
});

describe("one-sided lines the owner typed are still named (review 10 / 11)", () => {
  it("a Kontant corrected on a read bon, summed with a bon without Kontant", async () => {
    scans = [TILL1, { revenue: {}, revenue_total: 5000, moms_total: 1000, payments: { card: 5000 }, raw_text: "T2", ocr_available: true }];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    const cash = [...container.querySelectorAll("input")].find((i) => i.value === "4.030");
    fireEvent.change(cash, { target: { value: "5.300" } });
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
    // Till 2's cash was never added: said, by name.
    expect(screen.getByText(/^scanMergedIncompleteOwn:/).textContent).toContain("dcPayCash");
    // Not as a line of one bon.
    expect(screen.getByText(/^scanMergedIncompleteNamed:/).textContent).not.toContain("dcPayCash");
  });
});
