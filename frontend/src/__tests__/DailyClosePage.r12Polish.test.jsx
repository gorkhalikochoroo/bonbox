/**
 * Round-12 polish on the daily close, each pinned on the path a reviewer
 * walked: a past day's double-check and staff question name that day, a
 * ?date= link to a draft says it is the kladde, "Start forfra" asks before
 * dropping hand corrections, "Åbn Historik" lands on the locked day (open),
 * an open History card does not repeat itself and keeps one precision, paired
 * totals share one precision, and tablet/dark sizing hooks are in place.
 *
 * Strings are asserted by key (t echoes the key plus its values).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso, formatDateClearFull } from "../utils/dateFormat";
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
const daysBefore = (n) => {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};
const past = daysBefore(5);

let closes = [];
let scans = [];
let lockAnswer = null;
const realConfirm = window.confirm;

beforeEach(() => {
  window.scrollTo = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  closes = [];
  scans = [];
  lockAnswer = null;
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url) => Promise.resolve({ data: url === "/daily-close" ? closes : [] }));
  post.mockImplementation((url, body) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() });
    if (url === "/daily-close" && body?.status === "confirmed" && lockAnswer) return Promise.resolve({ data: lockAnswer(body) });
    return Promise.resolve({ data: {} });
  });
});
afterEach(() => { window.confirm = realConfirm; });

const tick = () => new Promise((r) => setTimeout(r, 0));
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};
const shoot = (container) =>
  fireEvent.change(container.querySelector('input[type="file"]'), {
    target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] },
  });
const renderAt = (path = "/daily-close") => render(
  <MemoryRouter initialEntries={[path]}><DailyClosePage /></MemoryRouter>,
);

describe("daily close — a past day is named as that day", () => {
  it("the double-check says the date; Trin 4 asks about 'den dag'", async () => {
    lockAnswer = () => ({ requires_confirmation: true, anomaly: { reason: "high", today_total: 1234.5, baseline_avg: 300, delta_pct: 3 } });
    const { container } = renderAt(`/daily-close?date=${past}`);
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "1234,50" } });
    let staffPlaceholder = null;
    for (let i = 0; i < 6 && !screen.queryByText("confirmAndLock"); i++) {
      const staff = container.querySelector("#dc-staff-count");
      if (staff) staffPlaceholder = staff.getAttribute("placeholder");
      tapNext();
      await tick();
    }
    expect(staffPlaceholder).toBe("dcStaffCountPromptPast");
    fireEvent.click(await screen.findByText("confirmAndLock"));
    const label = formatDateClearFull(past);
    expect(await screen.findByText(`dcAnomalyForDate:${label}`)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(`^dcAnomalyHighOnDate:${label}\\|1\\.234,50 kr\\.`))).toBeInTheDocument();
    expect(screen.queryByText(/^closeAnomalyHighMoney:/)).toBeNull();
  });

  it("tonight's double-check keeps 'Dagens total'", async () => {
    lockAnswer = () => ({ requires_confirmation: true, anomaly: { reason: "high", today_total: 1234.5, baseline_avg: 300, delta_pct: 3 } });
    const { container } = renderAt();
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "1234,50" } });
    for (let i = 0; i < 6 && !screen.queryByText("confirmAndLock"); i++) { tapNext(); await tick(); }
    fireEvent.click(await screen.findByText("confirmAndLock"));
    expect(await screen.findByText(/^closeAnomalyHighMoney:/)).toBeInTheDocument();
  });
});

describe("daily close — a ?date= link to a draft says it is the kladde", () => {
  it("shows the Kladde chip over the prefilled form", async () => {
    closes = [{
      id: "d1", date: past, status: "draft", revenue_total: 1234.5,
      revenue_breakdown: { food: 1234.5 }, payment_breakdown: { card: 1234.5 }, closed_by: "Test",
    }];
    const { container } = renderAt(`/daily-close?date=${past}`);
    await waitFor(() => expect(container.querySelector("#dc-rev-food")?.value).toBe("1.234,50"));
    expect(screen.getByText("dcEditingSavedDraft")).toBeInTheDocument();
  });

  it("a fresh day has no chip", async () => {
    const { container } = renderAt(`/daily-close?date=${past}`);
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    expect(screen.queryByText("dcEditingSavedDraft")).toBeNull();
  });
});

describe("daily close — Start forfra on the scan card", () => {
  const READ = {
    revenue: { food: 9000, drinks: 8030 }, revenue_total: 17030, moms_total: 3406,
    payments: { card: 17030 }, raw_text: "KASSE", ocr_available: true,
  };
  it("asks before throwing away a hand correction, and keeps it on No", async () => {
    scans = [READ];
    window.confirm = vi.fn(() => false);
    const { container } = renderAt();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    const mad = [...container.querySelectorAll("input")].find((i) => i.value === "9.000");
    fireEvent.change(mad, { target: { value: "9.500" } });
    fireEvent.click(screen.getByText("startOver"));
    await tick();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(screen.getByText("scanResults")).toBeInTheDocument();
    window.confirm = vi.fn(() => true);
    fireEvent.click(screen.getByText("startOver"));
    await waitFor(() => expect(screen.queryByText("scanResults")).toBeNull());
  });

  it("a read nobody corrected starts over in one tap", async () => {
    scans = [READ];
    window.confirm = vi.fn(() => false);
    const { container } = renderAt();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("startOver"));
    await waitFor(() => expect(screen.queryByText("scanResults")).toBeNull());
    expect(window.confirm).not.toHaveBeenCalled();
  });
});

describe("daily close — Åbn Historik lands on the locked day", () => {
  it("opens History on that close, expanded, without repeating its lines, at one precision", async () => {
    closes = [
      { id: "new", date: today, status: "draft", revenue_total: 100, revenue_breakdown: { food: 100 }, payment_breakdown: {} },
      {
        id: "L1", date: past, status: "confirmed", revenue_total: 28469,
        revenue_breakdown: { food: 12345.5, drinks: 4567, takeaway: 11556.5 }, payment_breakdown: { card: 28469 },
        moms_total: 5693.8, revenue_ex_moms: 22775.2, payment_total: 28469,
        cash_difference: 25, tips_total: 832, tips_staff_count: 3, closed_by: "Test",
      },
    ];
    const { container } = renderAt(`/daily-close?date=${past}`);
    fireEvent.click(await screen.findByText("dcOpenHistory"));
    await waitFor(() => expect(container.querySelector('[data-close-id="L1"]')).not.toBeNull());
    const card = container.querySelector('[data-close-id="L1"]');
    await waitFor(() => expect(card.querySelector('[aria-expanded="true"]')).not.toBeNull());
    // The open ledger lists the cash difference and tips — once each.
    expect(card.textContent.match(/dcCashDiffLabel/g)).toHaveLength(1);
    expect(card.textContent).toContain("dcStaffCountInline:3");
    // One precision on the card: 4.567,00 beside 12.345,50.
    expect(card.textContent).toContain("4.567,00");
    expect(card.textContent).toContain("12.345,50");
    // The other (unrelated) close stays shut.
    const other = container.querySelector('[data-close-id="new"]');
    expect(other.querySelector('[aria-expanded="true"]')).toBeNull();
  });

  it("a two-till card shows the part no category carries", async () => {
    closes = [{
      id: "T2", date: past, status: "draft", revenue_total: 22030,
      revenue_breakdown: { food: 9500, drinks: 6000, takeaway: 2030 }, payment_breakdown: { card: 22030 },
    }];
    renderAt();
    fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
    const chip = await screen.findByText(/dcUnsplitRevenue/);
    expect(chip.textContent).toContain("4.500");
  });
});

describe("daily close — paired totals share one precision", () => {
  it("Trin 1: I ALT and Ikke fordelt both whole kroner", async () => {
    scans = [{ revenue: {}, revenue_total: 17130, payments: {}, raw_text: "KASSE", ocr_available: true }];
    const { container } = renderAt();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    const unsplit = screen.getByText("dcUnsplitRevenue").parentElement;
    expect(unsplit.textContent).toContain("17.130");
    expect(unsplit.textContent).not.toContain("17.130,00");
  });
});

describe("daily close — tablet targets and the dark 'kr.' token", () => {
  it("tabs and the date take 40px; the page lifts the whispered token in dark", async () => {
    const { container } = renderAt();
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#close-date")).not.toBeNull());
    expect(container.querySelector('[role="tablist"]').className).toContain("*:min-h-10");
    expect(container.querySelector("#close-date").className).toContain("min-h-10");
    expect(container.firstChild.className).toContain("dark:[&_[data-amount-token]]:text-gray-400");
  });
});
