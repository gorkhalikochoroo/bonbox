/**
 * Round 16, must-fix 1 (blocking, C4).
 *
 * A second Z-bon after "Fortsæt kladden" — or on a close typed by hand —
 * silently replaced till 1. A draft whose categories add up to its total
 * reopens with no scan behind it, so the till question had nothing to compare
 * against: no "Er det en terminal mere?", no Fortryd, and the autosave wrote
 * 4.000 over the saved 17.130.
 *
 * Now the form's own figures are the first side whenever there is no scan
 * yet — on the scan card and on the hero camera — so the question is asked,
 * sum and replace work, Fortryd brings the form's 17.130 back, and nothing is
 * saved while the question is open. The form's figures never read as a
 * Z-bon read: no "aflæst", no "Z-bon:" total, not named as one bon's line.
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
// Till 1, saved as a draft: categories add up to the total (17.130), so the
// draft reopens with no scan behind it.
const DRAFT = {
  id: "d1", date: today, status: "draft",
  revenue_total: 17130,
  revenue_breakdown: { food: 9600, drinks: 5500, takeaway: 2030 },
  payment_breakdown: { card: 12000, cash: 5130 },
  moms_mode: "auto", moms_total: 3426,
  closed_by: "Test", notes: "Test",
};
// Till 2: a total, its MOMS and one card line — no split.
const TILL2 = { revenue: {}, revenue_total: 4000, moms_total: 800, payments: { card: 4000 }, raw_text: "TILL 2", ocr_available: true };

let closes = [];
let historyFails = false;
let scans = [];

beforeEach(() => {
  window.scrollTo = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  closes = [];
  historyFails = false;
  scans = [];
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url) => {
    if (url === "/daily-close") return historyFails ? Promise.reject(new Error("offline")) : Promise.resolve({ data: closes });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() || TILL2 });
    return Promise.resolve({ data: { id: "d1", status: "draft" } });
  });
});

const closePosts = () => post.mock.calls.filter(([url]) => url === "/daily-close");
const question = () => screen.queryByTestId("dc-terminal-question");
const shoot = (input) =>
  fireEvent.change(input, { target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] } });
// The wizard's own file input is always there; the top card's camera input
// comes before it in the page when that card is shown.
const fileInputs = (container) => [...container.querySelectorAll('input[type="file"]')];
const cardInput = (container) => fileInputs(container).at(-1);
const heroInput = (container) => (fileInputs(container).length > 1 ? fileInputs(container)[0] : null);
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const lockedPayload = async () => {
  fireEvent.click(await screen.findByText("confirmAndLock"));
  await waitFor(() =>
    expect(post.mock.calls.some(([url, body]) => url === "/daily-close" && body?.status === "confirmed")).toBe(true),
  );
  return post.mock.calls.find(([url, body]) => url === "/daily-close" && body?.status === "confirmed")[1];
};

/** Fortsæt kladden → the boxes hold 9.600 / 5.500 / 2.030 → ← Scan Z-bon. */
const reopenDraftAndGoToScan = async () => {
  closes = [DRAFT];
  const view = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByText("dcContinueDraft"));
  await waitFor(() => expect(view.container.querySelector("#dc-rev-food").value).toBe("9.600"));
  fireEvent.click(screen.getByText("← scanZReportBack"));
  await waitFor(() => expect(cardInput(view.container)).not.toBeNull());
  return view;
};

describe("daily close — a second Z-bon over a reopened draft (must-fix 1)", () => {
  it("asks first, saves nothing while asking, sums to 21.130, and Fortryd brings 17.130 back", async () => {
    const { container } = await reopenDraftAndGoToScan();
    shoot(cardInput(container));

    // The question, with the draft as "the one on screen".
    await waitFor(() => expect(question()).not.toBeNull());
    expect(question().textContent).toContain("scanSecondTotalBody:4.000 kr.|17.130 kr.");
    expect(screen.getByText(/scanSecondTotalSum/).textContent).toContain("21.130 kr.");
    // Nothing merged, nothing saved until it is answered.
    expect(screen.getByText("useTheseValuesJumpReview").closest("button")).toBeDisabled();
    await tick(2300);
    expect(closePosts()).toHaveLength(0);
    // The form's figures are not a Z-bon read: no "aflæst", no "Z-bon:" line.
    expect(screen.queryByText("scanBadgeRead")).toBeNull();
    expect(container.textContent).not.toMatch(/scanBonVsSaved|dcScanBonVsSaved/);

    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
    expect(container.textContent).toContain("17.130 kr.  +  4.000 kr. = 21.130 kr.");
    expect(container.querySelector("#scan-total").value).toBe("21.130");
    // Still the owner's lines, not read off a photo — and not named as one
    // bon's line either. Till 2's MOMS is (it was on one bon only).
    expect(screen.queryByText("scanBadgeRead")).toBeNull();
    const incomplete = screen.queryByText(/^scanMergedIncompleteNamed/);
    expect(incomplete?.textContent || "").not.toMatch(/food|drinks|takeaway|card|cash/i);
    // …but they are still not added up (till 2 had none of them), so they are
    // named — as the owner's own figures, not as a bon's lines.
    const own = screen.getByText(/^scanMergedIncompleteOwn:/).textContent;
    for (const k of ["dcCatFood", "dcCatDrinks", "dcCatTakeaway", "dcPayCash"]) expect(own).toContain(k);
    expect(own).not.toContain("dcPayCard");

    // Fortryd: the draft's 17.130 and the question are back.
    fireEvent.click(screen.getByText("scanMergedUndo"));
    await waitFor(() => expect(question()).not.toBeNull());
    expect(container.querySelector("#scan-total").value).toBe("17.130");
    expect(screen.queryByText("scanMergedTerminals:2")).toBeNull();

    // Answer again and use it: both tills are saved.
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const payload = await lockedPayload();
    expect(payload.date).toBe(today);
    expect(payload.revenue_total_override).toBe(21130);
    expect(payload.revenue_breakdown).toEqual({ food: 9600, drinks: 5500, takeaway: 2030 });
    expect(payload.payment_breakdown).toEqual({ card: 16000, cash: 5130 });
  });

  it("\"same terminal\" replaces, and Fortryd restores the draft", async () => {
    const { container } = await reopenDraftAndGoToScan();
    shoot(cardInput(container));
    await waitFor(() => expect(question()).not.toBeNull());
    fireEvent.click(screen.getByText(/scanSecondTotalReplace/));
    await waitFor(() => expect(screen.getByText(/^scanReplacedWithNew/)).toBeInTheDocument());
    expect(container.querySelector("#scan-total").value).toBe("4.000");

    fireEvent.click(screen.getByText("scanMergedUndo"));
    await waitFor(() => expect(question()).not.toBeNull());
    expect(container.querySelector("#scan-total").value).toBe("17.130");
    expect(closePosts()).toHaveLength(0);
  });
});

describe("daily close — a Z-bon over a close typed by hand (must-fix 1)", () => {
  it("the scan card asks before the bon replaces the typed figures", async () => {
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "17.130" } });
    fireEvent.click(screen.getByText("← scanZReportBack"));
    await waitFor(() => expect(screen.getByText("scanZReportTitle")).toBeInTheDocument());

    shoot(cardInput(container));
    await waitFor(() => expect(question()).not.toBeNull());
    expect(question().textContent).toContain("scanSecondTotalBody:4.000 kr.|17.130 kr.");
    // The typed figure is on the card as typed, not as read.
    expect(screen.queryByText("scanBadgeRead")).toBeNull();

    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(container.querySelector("#scan-total").value).toBe("21.130"));
    fireEvent.click(screen.getByText("scanMergedUndo"));
    await waitFor(() => expect(container.querySelector("#scan-total").value).toBe("17.130"));
    expect(question()).not.toBeNull();
  });

  it("the hero camera asks the same question", async () => {
    // The top card's camera button is on the close tab while the lock status
    // is unknown — the path a typed close and a hero photo can meet on.
    historyFails = true;
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "17.130" } });
    await waitFor(() => expect(heroInput(container)).not.toBeNull());
    // The typed close autosaves as itself first (that is the form's own figure).
    await waitFor(() => expect(closePosts()).toHaveLength(1), { timeout: 3500 });
    expect(closePosts()[0][1].revenue_breakdown).toEqual({ food: 17130 });

    shoot(heroInput(container));
    await waitFor(() => expect(question()).not.toBeNull());
    expect(question().textContent).toContain("scanSecondTotalBody:4.000 kr.|17.130 kr.");
    expect(screen.getByText(/scanSecondTotalSum/).textContent).toContain("21.130 kr.");
    // Nothing more is saved while the question is open — the bon least of all.
    await tick(2300);
    expect(closePosts()).toHaveLength(1);
  });

  it("an untouched POS sync is not a till: the Z-bon replaces it with no question", async () => {
    get.mockImplementation((url) => {
      if (url === "/daily-close/prefill") {
        return Promise.resolve({ data: {
          has_data: true, day_cutoff_hour: DEFAULT_CLOSE_CUTOFF_HOUR,
          sales: { total: 3000, count: 4, by_item: {} },
          expenses: { total: 0, count: 0, by_category: {} },
          suggested_prefill: { revenue_total: 3000, payment_breakdown: { card: 3000 }, cash_expected: 0 },
        } });
      }
      return Promise.resolve({ data: [] });
    });
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await waitFor(() => expect(get.mock.calls.some(([u]) => u === "/daily-close/prefill")).toBe(true));
    await tick(20);
    shoot(cardInput(container));
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    expect(question()).toBeNull();
    expect(container.querySelector("#scan-total").value).toBe("4.000");
  });
});
