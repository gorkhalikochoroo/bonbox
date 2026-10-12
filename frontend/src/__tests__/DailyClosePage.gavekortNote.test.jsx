/**
 * Gavekort on the daily close — review 12 Oct 2026 (d, f, g).
 *
 *  f  The "Gavekort solgt: …" note was added again on every save: the saved
 *     note came back into the notes box, and the save appended the line
 *     again — two, three lines on the revisor's kasserapport. The form now
 *     owns the line: taken out on open, written once on save.
 *  g  On an account with several branches the gavekort facts are the
 *     account's (cards carry no branch). Every branch's close pre-filled the
 *     account's redeemed gavekort as its own payment line and wrote the note.
 *     Now: nothing pre-filled or written; the evidence decides.
 *  d  Payments = revenue on a day a card was sold: the sale was paid another
 *     way or after the close — or it is in revenue. The close ASKS; it does
 *     not write "med i betalingerne" or push revenue up.
 *
 * Strings are asserted by key (t echoes the key plus its values).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";
import { splitGkNote } from "../utils/gavekortNote";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn(() => Promise.resolve({ data: null }));
const branch = vi.hoisted(() => ({ current: { branchId: null, branchType: "restaurant", hasMultiBranch: false } }));
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
vi.mock("../components/BranchSelector", () => ({ useBranch: () => branch.current }));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const GK_LINE = "Gavekort solgt: 300,00 kr. (med i betalingerne, ikke i omsætningen. MOMS: enkeltformål tælles ved salget af gavekortet, flerformål ved indløsning).";
const DRAFT = {
  id: "draft-1", date: today, status: "draft",
  revenue_total: 12000, revenue_breakdown: { food: 12000 },
  payment_breakdown: { card: 12300 }, cash_counted: 0,
  notes: `Gammel note\n${GK_LINE}`, closed_by: "Test",
};
const prefill = (gavekort) => ({
  has_data: false, day_cutoff_hour: 6,
  sales: { total: 0, count: 0 }, expenses: { total: 0, count: 0 }, gavekort,
});

let closes = [];
let gk = null;
beforeEach(() => {
  window.scrollTo = () => {};
  window.confirm = () => true;
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  closes = [];
  gk = { redeemed: 0, tender: 0, redeemed_spv: 0, redeemed_total: 0, sold: 300, sold_by_tender: { card: 300 }, scope: "close" };
  branch.current = { branchId: null, branchType: "restaurant", hasMultiBranch: false };
  get.mockImplementation((url) => {
    if (url === "/daily-close/prefill") return Promise.resolve({ data: prefill(gk) });
    if (url === "/daily-close") return Promise.resolve({ data: closes });
    return Promise.resolve({ data: [] });
  });
  post.mockResolvedValue({ data: {} });
});

const closePosts = () => post.mock.calls.filter(([url]) => url === "/daily-close");
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};
const toReview = async (container) => {
  for (let i = 0; i < 6 && !container.querySelector("#dc-notes"); i++) {
    tapNext();
    await new Promise((r) => setTimeout(r, 0));
  }
  await waitFor(() => expect(container.querySelector("#dc-notes")).not.toBeNull());
};
const toPayments = async (container, revenue = "1.000") => {
  fireEvent.click(await screen.findByText("skipEnterManually"));
  await waitFor(() => expect(screen.getByText(/^stepNRevenue:/)).toBeInTheDocument());
  fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: revenue } });
  tapNext();
  await waitFor(() => expect(container.querySelector("#dc-pay-card")).not.toBeNull());
};
const confirmAndLock = async () => {
  for (let i = 0; i < 8 && !screen.queryByText("confirmAndLock"); i++) tapNext();
  fireEvent.click(await screen.findByText("confirmAndLock"));
  await waitFor(() =>
    expect(post.mock.calls.some(([u, b]) => u === "/daily-close" && b?.status === "confirmed")).toBe(true),
  );
  return post.mock.calls.find(([u, b]) => u === "/daily-close" && b?.status === "confirmed")[1];
};
const gkLines = (notes) => String(notes || "").split("\n").filter((l) => l.startsWith("Gavekort solgt:"));

describe("f — the gavekort note is written once, however often the close is saved", () => {
  it("opening a close takes the form's line out of the notes box; the save writes it once", async () => {
    closes = [DRAFT];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("12.000"));
    await toReview(container);
    expect(container.querySelector("#dc-notes").value).toBe("Gammel note");
    fireEvent.change(container.querySelector("#dc-notes"), { target: { value: "Gammel note!" } });
    await waitFor(() => expect(closePosts()).toHaveLength(1), { timeout: 3500 });
    const notes = closePosts()[0][1].notes;
    expect(gkLines(notes)).toHaveLength(1);
    expect(notes.startsWith("Gammel note!\nGavekort solgt: 300,00 kr.")).toBe(true);
  });

  it("splitGkNote leaves a note without the line untouched", () => {
    expect(splitGkNote("  Bare min note \n")).toEqual({ notes: "  Bare min note \n", amountText: "" });
    expect(splitGkNote(`A\n${GK_LINE}\n${GK_LINE}`)).toEqual({ notes: "A", amountText: "300,00 kr." });
  });
});

describe("g — several branches: the account's gavekort is not this branch's", () => {
  it("does not pre-fill the gavekort line or write the note, and says it is account-wide", async () => {
    gk = { redeemed: 500, tender: 0, redeemed_spv: 0, redeemed_total: 500, sold: 300, sold_by_tender: { card: 300 }, scope: "account" };
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await toPayments(container);
    expect(screen.getByText("dcGkAccountWide")).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 50));
    expect(container.querySelector("#dc-pay-gift_card")?.value || "").toBe("");
    fireEvent.change(container.querySelector("#dc-pay-card"), { target: { value: "1000" } });
    expect(screen.getByText("balanced")).toBeInTheDocument();
    expect(screen.queryByTestId("dc-gk-sold-line")).toBeNull();
    const body = await confirmAndLock();
    expect(gkLines(body.notes)).toHaveLength(0);
  });
});

describe("d — payments = revenue on a day a card was sold: asked, not assumed", () => {
  it("balances, asks whether the sale is in revenue, and writes no 'med i betalingerne' line", async () => {
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await toPayments(container);
    fireEvent.change(container.querySelector("#dc-pay-card"), { target: { value: "1000" } });
    expect(screen.getByText("balanced")).toBeInTheDocument();
    expect(screen.getByTestId("dc-gk-sold-hint").textContent).toBe("dcGkSoldNotInPayments");
    const body = await confirmAndLock();
    expect(gkLines(body.notes)).toHaveLength(0);
  });
});

describe("the copy (real dictionaries)", () => {
  it("is real Danish and English", () => {
    for (const k of ["dcGkSoldNotInPayments", "dcGkAccountWide"]) {
      expect(da[k], k).toBeTruthy();
      expect(en[k], k).toBeTruthy();
    }
    expect(da.dcGkSoldNotInPayments).toMatch(/Står det i omsætningen/);
  });
});
