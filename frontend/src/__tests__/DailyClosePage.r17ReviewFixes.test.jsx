/**
 * Round 17 — review fixes on the page, end to end (closeTills + DailyClosePage).
 *
 *  1. A figure typed keystroke by keystroke on a day of several tills is split
 *     exactly as the same figure typed in one go ("9" on the way to "9.000"
 *     moved 4.000 kr. out of the signed close).
 *  2. The card's total emptied on a summed day is a red box that holds the
 *     lock, and the draft autosave sends the tills' figure the review shows.
 *  3. Fortryd, then Start forfra after an applied sum: the boxes go back to
 *     the owner's figures, the retake sums once (17.000, never 20.000).
 *  4. A reopened Z-bon draft + a bon is not called "indtastet" in the review.
 *  5. A total typed on the card goes with the photos at Start forfra.
 *  6. The same photo read differently (or the same stored image) is one scan.
 *  7. A reopened Z-bon draft edited, then summed: the edit is a correction.
 *  8. Start forfra on a reopened Z-bon draft does not relabel it "typed".
 *  9. A reopened draft's saved MOMS follows a total corrected on the card.
 * 10. Start forfra takes a MOMS typed over a photo-only day with the photo.
 * Strings are asserted by key (t echoes key + values).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";

const get = vi.fn();
const post = vi.fn();
// Round 23 — Start forfra deletes the day's draft (the server).
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

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const BON_3000 = {
  revenue: { food: 2000, drinks: 1000 }, revenue_total: 3000, moms_total: 600,
  payments: { card: 3000 }, raw_text: "BON 3000", ocr_available: true,
};
const BON_4000 = { revenue: {}, revenue_total: 4000, moms_total: 800, payments: { card: 4000 }, raw_text: "BON 4000", ocr_available: true };
const TILL1 = {
  revenue: { food: 9000, drinks: 6000, takeaway: 2030 }, revenue_total: 17030, moms_total: 3406,
  payments: { card: 12000, cash: 4030, mobilepay: 1000 }, raw_text: "TILL 1", ocr_available: true,
};
const EMPTY_DAY = { has_data: false, day_cutoff_hour: 6, sales: { total: 0, count: 0 }, expenses: { total: 0, count: 0 } };

let closes = [];
let scans = [];
const realConfirm = window.confirm;
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.confirm = vi.fn(() => true);
  del.mockClear();
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  closes = [];
  scans = [];
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url) => {
    if (url === "/daily-close") return Promise.resolve({ data: closes });
    if (url === "/daily-close/prefill") return Promise.resolve({ data: EMPTY_DAY });
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() || BON_3000 });
    return Promise.resolve({ data: { id: "d1", status: "draft" } });
  });
});
afterEach(() => { window.confirm = realConfirm; });

const renderPage = () => render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
const closePosts = () => post.mock.calls.filter(([url]) => url === "/daily-close").map(([, body]) => body);
const question = () => screen.queryByTestId("dc-terminal-question");
const cardInput = (container) => [...container.querySelectorAll('input[type="file"]')].at(-1);
const photo = (name = "kasse.jpg") => new File(["x"], name, { type: "image/jpeg" });
const shoot = (container, file = photo()) => fireEvent.change(cardInput(container), { target: { files: [file] } });
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
};
const tapBack = () => {
  const btn = screen.getAllByRole("button").find((b) => /^←\s*back$/.test(b.textContent.trim()));
  if (btn) fireEvent.click(btn);
  return Boolean(btn);
};
const toStep = async (container, selector) => {
  for (let i = 0; i < 8 && !container.querySelector(selector); i++) tapNext();
  await waitFor(() => expect(container.querySelector(selector)).not.toBeNull());
};
const backToStepOne = async () => {
  for (let i = 0; i < 8 && tapBack(); i++) { /* back to Trin 1 */ }
  await waitFor(() => expect(screen.getByText("← scanZReportBack")).toBeInTheDocument());
};
const toScanCard = async () => {
  fireEvent.click(screen.getByText("← scanZReportBack"));
  await waitFor(() => expect(screen.getByText("scanZReportTitle")).toBeInTheDocument());
};
// Back to the card that holds the photos (not the empty scan card).
const backToCard = async () => {
  fireEvent.click(screen.getByText("← scanZReportBack"));
  await waitFor(() => expect(screen.getByText("startOver")).toBeInTheDocument());
};
const sum = async () => {
  await waitFor(() => expect(question()).not.toBeNull());
  fireEvent.click(screen.getByText(/scanSecondTotalSum/));
  await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
};
const lockedPayload = async () => {
  for (let i = 0; i < 8 && !screen.queryByText("confirmAndLock"); i++) tapNext();
  fireEvent.click(await screen.findByText("confirmAndLock"));
  await waitFor(() => expect(closePosts().some((b) => b?.status === "confirmed")).toBe(true));
  return closePosts().find((b) => b?.status === "confirmed");
};
const box = (container, id) => container.querySelector(id).value;

const BON_12000 = { revenue: {}, revenue_total: 12000, moms_total: 2400, payments: { card: 12000 }, raw_text: "BON 12000", ocr_available: true };
const draftPosts = () => closePosts().filter((b) => b?.status === "draft");
const reviewText = (container) => container.textContent;
const reopen = async (row) => {
  closes = [{ id: "d1", date: today, status: "draft", closed_by: "Test", notes: "Test", ...row }];
  const view = renderPage();
  fireEvent.click(await screen.findByText("dcContinueDraft"));
  await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
  return view;
};
/** Type a value the way a box hands it over: every prefix, then the whole. */
const keyIn = (el, value) => {
  for (let i = 1; i <= value.length; i++) fireEvent.change(el, { target: { value: value.slice(0, i) } });
};

/** Mad 9.000 + Drikkevarer 5.000, Kontant 4.000 + Kort 10.000 — typed by hand. */
const typedClose14000 = async () => {
  const view = renderPage();
  fireEvent.click(await screen.findByText("skipEnterManually"));
  await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
  fireEvent.change(view.container.querySelector("#dc-rev-food"), { target: { value: "9.000" } });
  fireEvent.change(view.container.querySelector("#dc-rev-drinks"), { target: { value: "5.000" } });
  await toStep(view.container, "#dc-pay-card");
  fireEvent.change(view.container.querySelector("#dc-pay-cash"), { target: { value: "4.000" } });
  fireEvent.change(view.container.querySelector("#dc-pay-card"), { target: { value: "10.000" } });
  await backToStepOne();
  return view;
};

/** On the review, "Fra kvittering" with a typed MOMS. */
const toReviewAndTypeMoms = async (container, value) => {
  for (let i = 0; i < 8 && !screen.queryByText("confirmAndLock"); i++) tapNext();
  await screen.findByText("confirmAndLock");
  const chip = screen.getByText("fromReceipt");
  fireEvent.click(chip.closest("button") || chip);
  const moms = await screen.findByPlaceholderText("momsAmountPlaceholder");
  fireEvent.change(moms, { target: { value } });
};

describe("1. a figure typed keystroke by keystroke on a summed day", () => {
  it("Mad retyped as the same 9.000 keeps 18.000 — no revenue or MOMS leaves the close", async () => {
    const { container } = await typedClose14000();
    scans = [BON_4000];
    await toScanCard();
    shoot(container);
    await sum();
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(box(container, "#dc-rev-food")).toBe("9.000"));
    keyIn(container.querySelector("#dc-rev-food"), "9.000");
    expect(box(container, "#dc-rev-food")).toBe("9.000");
    const payload = await lockedPayload();
    expect(payload.revenue_total_override).toBe(18000);
    expect(payload.moms_total).toBe(3600);
    expect(payload.revenue_breakdown).toEqual({ food: 9000, drinks: 5000 });
    expect(payload.source_meta).toMatchObject({ terminal_totals: [14000, 4000], corrected: [] });
  }, 20000);

  it("the card's total keyed in as 21.530 over 17.030 + 4.000 records 17.030 + 4.500", async () => {
    scans = [TILL1, BON_4000];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    shoot(container, photo("kasse2.jpg"));
    await sum();
    keyIn(container.querySelector("#scan-total"), "21.530");
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const payload = await lockedPayload();
    expect(payload.revenue_total_override).toBe(21530);
    expect(payload.source_meta.terminal_totals).toEqual([17030, 4500]);
  }, 20000);
});

describe("2. the card's total emptied on a summed day", () => {
  it("is a red box that holds the lock; the draft sends the tills' 21.030 the review shows", async () => {
    scans = [TILL1, BON_4000];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    shoot(container, photo("kasse2.jpg"));
    await sum();
    fireEvent.change(container.querySelector("#scan-total"), { target: { value: "" } });
    expect(container.querySelector("#scan-total").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByText("dcScanTotalEmptySum")).toBeInTheDocument();
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const lock = await screen.findByText("confirmAndLock");
    expect(lock.closest("button").disabled).toBe(true);
    expect(reviewText(container)).toContain("dcLockBlockedAmountIn:revenueLabel");
    expect(reviewText(container)).toContain("21.030,00");
    // Whatever the autosave files is the figure the review shows.
    await waitFor(() => expect(draftPosts().length).toBeGreaterThan(0), { timeout: 3500 });
    const draft = draftPosts().at(-1);
    expect(draft.revenue_total_override).toBe(21030);
    expect(draft.revenue_total_owner_set).toBe(false);
  }, 20000);
});

// Round 23 (narrowing A, rewritten): Start forfra deletes the day's draft —
// the question names what is stored — and starts over EMPTY; the owner's own
// till no longer comes back. What these tests guarded (a bon thrown away is
// never counted again; the retake sums once) holds: the retake is the day's
// only till.
describe("3. Fortryd, then Start forfra, after an applied sum", () => {
  it("deletes the applied sum's draft (named in the question), starts over empty, and the retake counts once", async () => {
    const { container } = await typedClose14000();
    await toScanCard();
    shoot(container);
    await sum();
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(box(container, "#dc-rev-food")).toBe("11.000"));
    await waitFor(() => expect(draftPosts().at(-1)?.revenue_total_override).toBe(17000), { timeout: 3500 });
    await backToCard();
    fireEvent.click(screen.getByText("scanMergedUndo"));
    await waitFor(() => expect(question()).not.toBeNull());
    fireEvent.click(screen.getByText("startOver"));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
    expect(window.confirm.mock.calls[0][0]).toMatch(/^dcStartOverDeleteBody:.*\|17\.000 kr\.$/);
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("scanResults")).not.toBeInTheDocument());
    const before = draftPosts().length;
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    expect(box(container, "#dc-rev-food")).toBe("");
    expect(box(container, "#dc-rev-drinks")).toBe("");
    await new Promise((r) => setTimeout(r, 2300));
    expect(draftPosts().length).toBe(before);

    await toScanCard();
    shoot(container, photo("kasse-igen.jpg"));
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    expect(question()).toBeNull();
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const payload = await lockedPayload();
    expect(payload.revenue_total_override).toBe(3000);
    expect(payload.moms_total).toBe(600);
  }, 25000);

  it("a typed MOMS 3.000 + the bon's 600, applied, Fortryd, Start forfra: nothing of the old day stays — the next close starts on Auto", async () => {
    const { container } = await typedClose14000();
    await toReviewAndTypeMoms(container, "3.000");
    await backToStepOne();
    await toScanCard();
    shoot(container);
    await sum();
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(box(container, "#dc-rev-food")).toBe("11.000"));
    await backToCard();
    fireEvent.click(screen.getByText("scanMergedUndo"));
    await waitFor(() => expect(question()).not.toBeNull());
    fireEvent.click(screen.getByText("startOver"));
    await waitFor(() => expect(screen.queryByText("scanResults")).not.toBeInTheDocument());
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    expect(box(container, "#dc-rev-food")).toBe("");
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "9.000" } });
    const payload = await lockedPayload();
    expect(payload.revenue_breakdown).toEqual({ food: 9000 });
    expect(payload.moms_mode).toBe("auto");
    expect(payload.moms_total).toBe(1800);
  }, 25000);
});

describe("3b. the same Fortryd + Start forfra after \"same terminal\" over a reopened draft", () => {
  it("the reopened draft is deleted (named in the question) and the retake is the day's first till", async () => {
    const BON_1500 = { revenue: { food: 1500 }, revenue_total: 1500, payments: { card: 1500 }, raw_text: "BON 1500", ocr_available: true };
    const { container } = await reopen({
      revenue_total: 14000, revenue_breakdown: { food: 9000, drinks: 5000 }, payment_breakdown: { card: 14000 },
      moms_mode: "auto", moms_total: 2800,
    });
    scans = [BON_1500, BON_1500];
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    fireEvent.click(screen.getByText(/scanSecondTotalReplace/));
    await waitFor(() => expect(question()).toBeNull());
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(box(container, "#dc-rev-food")).toBe("1.500"));
    await waitFor(() => expect(draftPosts().length).toBeGreaterThan(0), { timeout: 3500 });
    await backToCard();
    fireEvent.click(screen.getByText("scanMergedUndo"));
    await waitFor(() => expect(question()).not.toBeNull());
    fireEvent.click(screen.getByText("startOver"));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(del.mock.calls[0][0]).toBe("/daily-close/d1");
    expect(window.confirm.mock.calls.at(-1)[0]).toMatch(/^dcStartOverDeleteBody:.*\|1\.500 kr\.$/);
    await waitFor(() => expect(screen.queryByText("scanResults")).not.toBeInTheDocument());
    shoot(container, photo("kasse-igen.jpg"));
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    expect(question()).toBeNull();
  }, 25000);
});

describe("4. the review names a reopened Z-bon draft + a bon for what the record says", () => {
  it("a draft read off a Z-bon is no \"indtastet\" figure", async () => {
    const { container } = await reopen({
      revenue_total: 14000, revenue_breakdown: { food: 9000, drinks: 5000 }, payment_breakdown: { card: 14000 },
      moms_mode: "auto", moms_total: 2800, source_meta: { kind: "zbon", scans: 1 },
    });
    scans = [BON_4000];
    await toScanCard();
    shoot(container);
    await sum();
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    expect(reviewText(container)).not.toContain("dcSavesTypedPlusBon");
    const payload = await lockedPayload();
    expect(payload.source_meta).toMatchObject({ kind: "zbon", scans: 2, terminal_totals: [14000, 4000] });
    expect(payload.source_meta.typed_tills).toBeUndefined();
  }, 20000);
});

// Round 23 (A, rewritten): the question names the draft that is stored
// (the typed 14.000 — the card's 16.000 was never applied), the draft is
// deleted, and the retake is the day's first till (never asked against the
// thrown-away total).
describe("5. a total typed on the card goes with the photos at Start forfra", () => {
  it("the question names the stored 14.000 (never the card's 16.000), and the retake starts the day", async () => {
    const { container } = await typedClose14000();
    await waitFor(() => expect(draftPosts().length).toBeGreaterThan(0), { timeout: 3500 });
    await toScanCard();
    shoot(container);
    await sum();
    fireEvent.change(container.querySelector("#scan-total"), { target: { value: "16.000" } });
    fireEvent.click(screen.getByText("startOver"));
    await waitFor(() => expect(window.confirm).toHaveBeenCalledTimes(1));
    expect(window.confirm.mock.calls[0][0]).toMatch(/^dcStartOverDeleteBody:.*\|14\.000 kr\.$/);
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByText("scanResults")).not.toBeInTheDocument());
    shoot(container, photo("kasse-igen.jpg"));
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    expect(question()).toBeNull();
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const payload = await lockedPayload();
    expect(payload.revenue_total_override).toBe(3000);
    expect(payload.revenue_breakdown).toEqual({ food: 2000, drinks: 1000 });
  }, 25000);
});

describe("6. the same photo is one scan, however it was read", () => {
  it("picked again and read with a MobilePay 0 more: nothing is asked or added", async () => {
    scans = [TILL1, { ...TILL1, payments: { ...TILL1.payments, mobilepay: 0 } }];
    const { container } = renderPage();
    const same = photo("IMG_0042.jpg");
    shoot(container, same);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    shoot(container, same);
    await waitFor(() => expect(screen.getByText("dcScanSamePhoto")).toBeInTheDocument());
    expect(question()).toBeNull();
    expect(container.querySelector("#scan-total").value).toBe("17.030");
  });

  it("the same stored image under another file name (a new signed URL) is the same scan", async () => {
    const at = (token) => `https://x.supabase.co/storage/v1/object/sign/receipts/u1/kasserapport/abc123.jpg?token=${token}`;
    scans = [{ ...TILL1, image_url: at("one") }, { ...TILL1, image_url: at("two") }];
    const { container } = renderPage();
    shoot(container, photo("IMG_0042.jpg"));
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    shoot(container, photo("IMG_0042 kopi.jpg"));
    await waitFor(() => expect(screen.getByText("dcScanSamePhoto")).toBeInTheDocument());
    expect(question()).toBeNull();
    expect(container.querySelector("#scan-total").value).toBe("17.030");
  });
});

describe("7. a reopened Z-bon draft edited, then a second bon", () => {
  it("files the owner's edit and the draft's earlier correction as corrected", async () => {
    const { container } = await reopen({
      revenue_total: 17030, revenue_breakdown: { food: 9000, drinks: 6000, takeaway: 2030 }, payment_breakdown: { card: 17030 },
      moms_mode: "auto", moms_total: 3406, source_meta: { kind: "zbon", scans: 1, corrected: ["rev:food"] },
    });
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "9.500" } });
    scans = [BON_4000];
    await toScanCard();
    shoot(container);
    await sum();
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const payload = await lockedPayload();
    expect(payload.source_meta).toMatchObject({ kind: "zbon", scans: 2, terminal_totals: [17530, 4000] });
    expect(payload.source_meta.corrected).toEqual(["rev:food"]);
    expect(payload.source_meta.typed_tills).toBeUndefined();
  }, 20000);
});

// Round 23 (A, rewritten): Start forfra on a reopened Z-bon draft deletes
// it (asked, naming its 14.000); nothing of it — its photo, its source — is
// carried into the close typed next, which is a new, typed close.
describe("8. Start forfra on a reopened Z-bon draft", () => {
  it("deletes the reopened read (named in the question); the close typed next carries none of its source or photo", async () => {
    const { container } = await reopen({
      revenue_total: 14000, revenue_breakdown: { food: 9000, drinks: 5000 }, payment_breakdown: { card: 14000 },
      moms_mode: "auto", moms_total: 2800, source_meta: { kind: "zbon", scans: 1 }, receipt_photo: "u1/kasserapport/old.jpg",
    });
    scans = [BON_4000];
    await toScanCard();
    shoot(container);
    await waitFor(() => expect(question()).not.toBeNull());
    fireEvent.click(screen.getByText("startOver"));
    await waitFor(() => expect(del).toHaveBeenCalledTimes(1));
    expect(window.confirm.mock.calls.at(-1)[0]).toMatch(/^dcStartOverDeleteBody:.*\|14\.000 kr\.$/);
    await waitFor(() => expect(screen.queryByText("scanResults")).not.toBeInTheDocument());
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    expect(box(container, "#dc-rev-food")).toBe("");
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "9.000" } });
    const payload = await lockedPayload();
    expect(payload.source_meta).toMatchObject({ kind: "typed" });
    expect(payload.receipt_photo ?? null).toBe(null);
    expect(payload.revenue_breakdown).toEqual({ food: 9000 });
  }, 20000);
});

describe("9. a reopened draft's saved MOMS under a total corrected on the card", () => {
  it("17.030 / MOMS 3.406 typed, corrected to 16.500 on the card: MOMS is worked out (3.300), not kept as typed", async () => {
    const { container } = await reopen({
      revenue_total: 17030, revenue_breakdown: { food: 9000, drinks: 5000 }, payment_breakdown: { card: 17030 },
      moms_mode: "manual", moms_total: 3406,
    });
    await backToCard();
    fireEvent.change(container.querySelector("#scan-total"), { target: { value: "16.500" } });
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const payload = await lockedPayload();
    expect(payload.revenue_total_override).toBe(16500);
    expect(payload.moms_mode).toBe("auto");
    expect(payload.moms_total).toBe(3300);
  }, 20000);

  it("a typed total below the lines (13.000 → 12.500): MOMS 2.500, auto", async () => {
    const { container } = await reopen({
      revenue_total: 13000, revenue_breakdown: { food: 9000, drinks: 5000 }, payment_breakdown: { card: 13000 },
      moms_mode: "manual", moms_total: 2600,
    });
    await backToCard();
    fireEvent.change(container.querySelector("#scan-total"), { target: { value: "12.500" } });
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const payload = await lockedPayload();
    expect(payload.revenue_total_override).toBe(12500);
    expect(payload.moms_mode).toBe("auto");
    expect(payload.moms_total).toBe(2500);
  }, 20000);
});

describe("10. Start forfra on a photo-only day takes a MOMS typed over the photo with it", () => {
  it("TILL1, MOMS 3.300 typed, Start forfra, a 12.000 bon: MOMS 2.400 — not the 3.300", async () => {
    scans = [TILL1, BON_12000];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    const moms = await screen.findByPlaceholderText("momsAmountPlaceholder");
    expect(moms.value).toBe("3.406");
    fireEvent.change(moms, { target: { value: "3.300" } });
    await backToStepOne();
    await backToCard();
    fireEvent.click(screen.getByText("startOver"));
    await waitFor(() => expect(screen.queryByText("scanResults")).not.toBeInTheDocument());
    shoot(container, photo("bon12000.jpg"));
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    const payload = await lockedPayload();
    expect(payload.revenue_total_override).toBe(12000);
    expect(payload.moms_total).toBe(2400);
  }, 20000);
});
