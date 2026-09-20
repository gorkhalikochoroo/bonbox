/**
 * The close surface, walked the way a Danish owner walks it — on an
 * ENGLISH-LOCALE BROWSER.
 *
 * Three defects live here, and all three are invisible to a green build:
 *
 *   1. MONEY IN THE BROWSER'S LOCALE. Every money render on this page was a
 *      bare `toLocaleString()`. On a MacBook bought abroad or a Chrome profile
 *      set to English — ordinary in Copenhagen — 17030 renders "17,030", and in
 *      Danish the comma is the DECIMAL separator: the owner reads seventeen
 *      kroner and three øre on the screen that produces the revisor's number,
 *      while the PDF the same page generates says "17.030,00 kr.". These tests
 *      force `navigator.language` to en-US so a regression to toLocaleString
 *      fails here instead of in production.
 *
 *   2. "0 DKK" ON AN UNTOUCHED FORM. The revenue step's hero total printed a
 *      confident zero before the owner had typed anything — a claim that the
 *      venue took nothing today. A missing value is "—", never a fabricated 0.
 *
 *   3. A MISSING day_cutoff_hour COERCED TO MIDNIGHT. `|| 0` cannot tell a
 *      configured midnight cutoff from an absent field, so a venue whose
 *      prefill omits it silently switched business-day rollover from the page's
 *      own 06:00 default to 00:00 — mid-load, after the header had already
 *      decided what "today" was.
 *
 * Strings are asserted by key (the t() mock echoes the key), so these pin
 * behaviour and the money, never the wording.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_CLOSE_CUTOFF_HOUR, resolveCutoffHour } from "../utils/dailyCloseDay";

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
// Two branches so the Branches tab exists and the smoke test below can mount
// BranchSummaryView — the one view on this page with no other test coverage.
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({
    branchId: null,
    branchType: "restaurant",
    branches: [{ id: 1, name: "Nørrebro" }, { id: 2, name: "Vesterbro" }],
  }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const renderPage = () =>
  render(
    <MemoryRouter>
      <DailyClosePage />
    </MemoryRouter>,
  );

/** Route the page's GETs by URL so one test can shape one endpoint. */
const routeGet = ({
  prefill = { has_data: false },
  history = [],
  insights = { has_data: false },
  branchSummary = { branches: [], grand_total: {} },
} = {}) => {
  get.mockImplementation((url) => {
    if (url === "/daily-close/prefill") return Promise.resolve({ data: prefill });
    if (url === "/daily-close") return Promise.resolve({ data: history });
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    if (url === "/daily-close/insights") return Promise.resolve({ data: insights });
    if (url === "/daily-close/branch-summary") return Promise.resolve({ data: branchSummary });
    return Promise.resolve({ data: {} });
  });
};

/** The wizard opens on the scan card; the entry steps are one tap past it. */
const enterManually = async () => {
  fireEvent.click(screen.getByText("skipEnterManually"));
  await waitFor(() => expect(screen.getByText(/^stepNRevenue:/)).toBeInTheDocument());
};

/** Tap "Next" — the label is `next →`, so match on the button, not the text. */
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};

/** `vi.setSystemTime` needs fake timers, but waitFor needs the clock to move —
 *  shouldAdvanceTime gives us both. */
const freezeAt = (d) => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  vi.setSystemTime(d);
};

/** An ISO date `n` days before today, so the heat-map fixtures always land
 *  inside the rendered 90-day window without pinning the clock. */
const daysAgoIso = (n) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

beforeEach(() => {
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  routeGet();
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  // The whole point: pretend the owner's browser is English. Every assertion
  // below would still pass under a Danish browser by accident, which is exactly
  // how this class of bug survived to production.
  vi.spyOn(navigator, "language", "get").mockReturnValue("en-US");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("resolveCutoffHour — a missing cutoff is not midnight", () => {
  it("falls back to the DK 06:00 default when the field is absent", () => {
    expect(resolveCutoffHour(undefined)).toBe(DEFAULT_CLOSE_CUTOFF_HOUR);
    expect(resolveCutoffHour(null)).toBe(DEFAULT_CLOSE_CUTOFF_HOUR);
  });

  it("keeps a real 0 — an owner may genuinely close on the calendar day", () => {
    // This is the half `?? ` protects that a plain `|| 6` would destroy: the
    // fix must not swing the bug the other way.
    expect(resolveCutoffHour(0)).toBe(0);
  });

  it("passes a configured hour through untouched", () => {
    expect(resolveCutoffHour(4)).toBe(4);
    expect(resolveCutoffHour(23)).toBe(23);
  });

  it("refuses junk rather than building a NaN date from it", () => {
    for (const junk of ["6", 6.5, -1, 24, NaN, {}, true]) {
      expect(resolveCutoffHour(junk)).toBe(DEFAULT_CLOSE_CUTOFF_HOUR);
    }
  });
});

describe("daily close — the business day a prefill without a cutoff lands on", () => {
  it("files 02:30 against YESTERDAY when the prefill omits day_cutoff_hour", async () => {
    // 02:30 on 10 March. With the page's own 06:00 rule the shift that is
    // finishing belongs to the 9th. With the old `|| 0` coercion an absent
    // field meant midnight, and the wizard silently jumped to the 10th — a
    // close reconciled against the wrong day's sales.
    freezeAt(new Date(2026, 2, 10, 2, 30, 0));
    routeGet({ prefill: { has_data: false } }); // NOTE: no day_cutoff_hour key

    const { container } = renderPage();
    await enterManually();

    await waitFor(() => {
      expect(container.querySelector('input[type="date"]').value).toBe("2026-03-09");
    });
  });

  it("still honours a server that really does say midnight", async () => {
    freezeAt(new Date(2026, 2, 10, 2, 30, 0));
    routeGet({ prefill: { has_data: false, day_cutoff_hour: 0 } });

    const { container } = renderPage();
    await enterManually();

    await waitFor(() => {
      expect(container.querySelector('input[type="date"]').value).toBe("2026-03-10");
    });
  });
});

describe("daily close — money on an English-locale browser", () => {
  it("shows an honest em-dash, not '0 DKK', before anything is typed", async () => {
    const { container } = renderPage();
    await enterManually();

    // The step's hero total. A 0 here would be the app telling the owner their
    // venue took nothing today, on a form they have not touched.
    expect(container.textContent).not.toContain("0 DKK");
    expect(container.textContent).not.toContain("0 kr.");
    expect(container.textContent).toContain("—");
  });

  it("groups the revenue total da-DK once the owner types", async () => {
    const { container } = renderPage();
    await enterManually();

    // inputmode="decimal", not type="number": the money boxes are TEXT now.
    // A number input on an English-locale browser rewrote "1.500,50" to
    // "1.50050" with badInput FALSE, so it could not stay. Selecting on
    // inputmode keeps this test pointed at the money fields and away from the
    // staff-count box, which is inputmode="numeric" and is not money.
    const inputs = container.querySelectorAll('input[inputmode="decimal"]');
    fireEvent.change(inputs[0], { target: { value: "17030" } });

    // "17.030 kr." — never the browser-locale "17,030", which a Dane reads as
    // seventeen kroner and three øre.
    await waitFor(() => expect(container.textContent).toContain("17.030"));
    expect(container.textContent).not.toContain("17,030");
    expect(container.textContent).not.toContain("DKK");
  });

  it("carries øre into the review step, where the card must tie out to the PDF", async () => {
    const { container } = renderPage();
    await enterManually();

    const inputs = container.querySelectorAll('input[inputmode="decimal"]');
    fireEvent.change(inputs[0], { target: { value: "17030" } });

    // Walk to the last step — Review & Submit.
    for (let i = 0; i < 6; i++) {
      if (!tapNext()) break;
    }
    await waitFor(() => expect(screen.getByText(/^stepNReview:/)).toBeInTheDocument());

    // The kasserapport preview renders two decimals, like the server PDF.
    expect(container.textContent).toContain("17.030,00");
  });
});

describe("daily close — the 90-day heat map", () => {
  const history = [
    { id: 1, date: daysAgoIso(1), status: "confirmed", revenue_total: 4000, cash_difference: 0, revenue_breakdown: {}, payment_breakdown: {} },
    { id: 2, date: daysAgoIso(2), status: "confirmed", revenue_total: 9000, cash_difference: -50, revenue_breakdown: {}, payment_breakdown: {} },
    { id: 3, date: daysAgoIso(3), status: "confirmed", revenue_total: 15000, cash_difference: 20, revenue_breakdown: {}, payment_breakdown: {} },
    { id: 4, date: daysAgoIso(4), status: "confirmed", revenue_total: 21000, cash_difference: -400, revenue_breakdown: {}, payment_breakdown: {} },
  ];

  const openHistory = async () => {
    routeGet({ history });
    const view = renderPage();
    await waitFor(() => expect(screen.getByText("historyTab")).toBeInTheDocument());
    fireEvent.click(screen.getByText("historyTab"));
    await waitFor(() => expect(screen.getByText("dcHeatmap90DayOverview")).toBeInTheDocument());
    return view;
  };

  it("gives every day a real, focusable button instead of an inert div", async () => {
    const { container } = await openHistory();

    // 90 days of the owner's own money history used to be mouse-only: plain
    // <div>s with onMouseEnter, unreachable by keyboard and silent to a screen
    // reader. Each cell is now a button that names its date and its figure.
    const cells = container.querySelectorAll('button[aria-label*="—"]');
    expect(cells.length).toBeGreaterThan(80);
    expect([...cells].some((c) => /dcHeatmapNoClose/.test(c.getAttribute("aria-label")))).toBe(true);
  });

  it("never paints a bucket in the page's own dark ground", async () => {
    const { container } = await openHistory();

    // dark:bg-gray-900 IS `.dark body` (#111827, index.css). The p75 bucket
    // used to paint it, so in dark mode a GOOD day rendered as a hole in the
    // grid — and the legend swatch explaining it was a hole too.
    const cells = container.querySelectorAll('button[aria-label*="—"]');
    for (const c of cells) {
      expect(c.className).not.toContain("dark:bg-gray-900");
    }
  });

  it("names the real kroner thresholds in the legend, not adjectives", async () => {
    const { container } = await openHistory();

    // Percentiles of [4000, 9000, 15000, 21000] → p25 9.000, p50 15.000,
    // p75 21.000. The legend has to quote the venue's OWN cuts, da-DK grouped.
    expect(container.textContent).toContain("9.000");
    expect(container.textContent).toContain("15.000");
    expect(container.textContent).toContain("21.000");
    // The old qualitative labels are gone — they described the swatch the owner
    // can already see and hid the only thing they could not.
    expect(container.textContent).not.toContain("dcLegendLow");
    expect(container.textContent).not.toContain("dcLegendMid");
    expect(container.textContent).not.toContain("dcLegendHigh");
  });
});

describe("daily close — a failure the owner can see", () => {
  it("says the sales register could not be read instead of looking like a quiet day", async () => {
    // The old catch was silent, so a failed prefill was indistinguishable from
    // "this date had no sales" — and the owner closed the day with no POS
    // cross-check, no register-derived expected cash and no variance warning,
    // none of which announce their own absence.
    get.mockImplementation((url) => {
      if (url === "/daily-close/prefill") return Promise.reject(new Error("offline"));
      if (url === "/daily-close") return Promise.resolve({ data: [] });
      return Promise.resolve({ data: {} });
    });

    renderPage();
    await enterManually();

    await waitFor(() => expect(screen.getByText("somethingWentWrong")).toBeInTheDocument());
  });
});

describe("daily close — every tab mounts", () => {
  // The repo's own scar: a green build, a clean eslint and a passing i18n check
  // shipped a TDZ that took production down, because nothing had LOADED the
  // page. A surface pass touches all four views, so all four get mounted here
  // — including the branch comparison, which has no other test.
  const branchSummary = {
    grand_total: { revenue_total: 42000, cash_diff_total: -250, tips_total: 1800 },
    branches: [
      { branch_id: 1, branch_name: "Nørrebro", revenue_total: 25000, avg_daily_revenue: 3570, days_count: 7, cash_diff_total: -150, tips_total: 1100 },
      { branch_id: 2, branch_name: "Vesterbro", revenue_total: 17000, avg_daily_revenue: 2428, days_count: 7, cash_diff_total: -100, tips_total: 700 },
    ],
  };
  const insights = {
    has_data: true,
    summary: { avg_daily_revenue: 12400, total_tips: 9100, total_cash_difference: -320 },
    insights: [
      { type: "cash_streak", severity: "info", title: "Kassen mangler", detail: "tre dage", icon: "!", streak_length: 3, streak_total: -450, is_active: true, total_streaks: 2 },
      { type: "weekday", title: "Fredag er din bedste dag", detail: "…", icon: "*" },
    ],
  };

  it("renders history, insights and the branch comparison without throwing", async () => {
    routeGet({ insights, branchSummary, history: [] });
    const { container } = renderPage();

    for (const tab of ["historyTab", "insightsTab", "branches"]) {
      await waitFor(() => expect(screen.getByText(tab)).toBeInTheDocument());
      fireEvent.click(screen.getByText(tab));
    }

    // The branch view's money, da-DK grouped on an English browser.
    await waitFor(() => expect(container.textContent).toContain("42.000"));
    expect(container.textContent).toContain("25.000");
    expect(container.textContent).not.toContain("42,000");
  });

  it("says a failed branch-summary failed, instead of showing the empty state", async () => {
    // The silent catch left `data` null and fell through to an empty state
    // whose copy reads "submit daily closes for multiple branches to see
    // comparisons" — telling an owner with weeks of closes that they have none.
    get.mockImplementation((url) => {
      if (url === "/daily-close/branch-summary") return Promise.reject(new Error("boom"));
      if (url === "/daily-close") return Promise.resolve({ data: [] });
      if (url === "/daily-close/prefill") return Promise.resolve({ data: { has_data: false } });
      return Promise.resolve({ data: {} });
    });
    renderPage();

    await waitFor(() => expect(screen.getByText("branches")).toBeInTheDocument());
    fireEvent.click(screen.getByText("branches"));

    await waitFor(() => expect(screen.getByText("somethingWentWrong")).toBeInTheDocument());
    expect(screen.queryByText("noBranchDataHint")).not.toBeInTheDocument();
  });
});

describe("daily close — the business date belongs to the owner", () => {
  /**
   * The prefill effect used to END with an unconditional
   * `setBusinessDate(businessTodayIso(serverCutoff))`, and `businessDate` is
   * one of that same effect's dependencies. So choosing any past date re-fired
   * the effect and the resolving prefill snapped the date back to today, which
   * made the picker, the `pastDate` badge and "Reset to today" dead UI — and,
   * on the Edit path, re-filed a corrected past close against TODAY
   * (`date: businessDate` in the save payload).
   *
   * These pin the date SURVIVING the async prefill, which is the part a
   * synchronous render assertion would miss: the old code only clobbered once
   * the promise resolved.
   */
  const pickDate = async (iso) => {
    const { container } = renderPage();
    await enterManually();
    const input = container.querySelector('input[type="date"]');
    fireEvent.change(input, { target: { value: iso } });
    return { container, input };
  };

  it("keeps a chosen past date after the prefill for it resolves", async () => {
    freezeAt(new Date(2026, 2, 10, 12, 0, 0));
    const { input } = await pickDate("2026-03-02");

    // Wait for the effect to have actually re-run for the chosen date — then
    // the clobber, if it came back, has already had its chance to fire.
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith("/daily-close/prefill", {
        params: expect.objectContaining({ date: "2026-03-02" }),
      }),
    );
    await waitFor(() => expect(input.value).toBe("2026-03-02"));
    expect(input.value).not.toBe("2026-03-10");
  });

  it("makes the pastDate badge and Reset-to-today reachable at all", async () => {
    // Both render on `businessDate !== businessTodayIso(cutoffHour)`, which the
    // clobber made unsatisfiable — so neither had ever been seen in production.
    freezeAt(new Date(2026, 2, 10, 12, 0, 0));
    await pickDate("2026-03-02");

    await waitFor(() => expect(screen.getAllByText("pastDate").length).toBeGreaterThan(0));
    expect(screen.getByText("resetToToday")).toBeInTheDocument();
  });

  it("still applies the venue's real cutoff to the DEFAULT date on first load", async () => {
    // The one case that legitimately moves the date: nothing chosen yet, and
    // the server's cutoff disagrees with the page's 06:00 assumption. Gating
    // the clobber must not gate this.
    freezeAt(new Date(2026, 2, 10, 2, 30, 0));
    routeGet({ prefill: { has_data: false, day_cutoff_hour: 0 } });

    const { container } = renderPage();
    await enterManually();

    await waitFor(() =>
      expect(container.querySelector('input[type="date"]').value).toBe("2026-03-10"),
    );
  });
});

describe("daily close — the cash step does not invent a baseline", () => {
  it("shows '—', not a confident 0, when nothing is synced and nothing typed", async () => {
    // Same rule the revenue/payments heroes already follow, one step later.
    // With no POS register and an empty cash line, `parseFloat(cash || 0)` is a
    // fallback 0 — and the card printed it under the label "Expected (from your
    // entry)", for an entry that does not exist.
    renderPage();
    await enterManually();
    tapNext(); // revenue → payments
    tapNext(); // payments → cash
    await waitFor(() => expect(screen.getByText(/^stepNCash:/)).toBeInTheDocument());

    const label = screen.getByText("expectedFromEntry");
    const figure = label.parentElement.querySelector("div");
    expect(figure.textContent).toContain("—");
    expect(figure.textContent).not.toMatch(/\b0\b/);
  });

  it("still renders a real typed 0 as 0", async () => {
    // A till that genuinely took no cash is a MEASUREMENT, not a blank.
    const { container } = renderPage();
    await enterManually();
    tapNext();
    await waitFor(() => expect(screen.getByText(/^stepNPayments:/)).toBeInTheDocument());
    const cashInput = container.querySelectorAll('input[inputmode="decimal"]')[0];
    fireEvent.change(cashInput, { target: { value: "0" } });
    tapNext();
    await waitFor(() => expect(screen.getByText(/^stepNCash:/)).toBeInTheDocument());

    const label = screen.getByText("expectedFromEntry");
    expect(label.parentElement.querySelector("div").textContent).not.toContain("—");
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * The close's own keyed money boxes, after the app-wide sweep.
 *
 * Every figure on this wizard was <input type="number" inputMode="decimal">
 * with a `parseFloat(v) || 0` reader. On an English-locale browser — the one
 * these tests already force via navigator.language — a Dane's "1.500,50"
 * arrives as "1.50050" with validity.badInput FALSE, parseFloat returns
 * 1.5005, and that number goes into a LOCKED ledger row and a signed
 * kasserapport. The wizard is now MoneyField + parseMoneyInput throughout.
 *
 * These pin the wiring, not the parser: the exact production string, one real
 * Danish amount, and the junk a salvaging parser would have rescued.
 * ──────────────────────────────────────────────────────────────────────── */
describe("daily close — the money boxes refuse what they cannot read", () => {
  const PRODUCTION_STRING = "1.50050";
  const moneyBoxes = (c) => Array.from(c.querySelectorAll('input[inputmode="decimal"]'));
  const refusalsShown = () =>
    screen.queryAllByRole("alert").filter((n) => n.textContent === "invalidAmount").length;

  it("every money box is TEXT — a number input cannot come back here", async () => {
    const { container } = renderPage();
    await enterManually();
    const boxes = moneyBoxes(container);
    expect(boxes.length).toBeGreaterThan(0);
    for (const b of boxes) {
      expect(b.getAttribute("type")).toBe("text");
      // A close is typed standing at the till, on a phone.
      expect(b.getAttribute("inputmode")).toBe("decimal");
    }
  });

  it("the staff-count box is NOT one of them — a head count is not money", async () => {
    // Converting this would be its own bug: parseMoneyInput has no business
    // reading a head count, and a number input fails visibly for one.
    const { container } = renderPage();
    await enterManually();
    const numeric = container.querySelectorAll('input[inputmode="numeric"]');
    for (const n of numeric) expect(n.getAttribute("type")).toBe("number");
  });

  it("refuses the production string 1.50050 in a revenue box, out loud", async () => {
    const { container } = renderPage();
    await enterManually();
    const box = moneyBoxes(container)[0];
    fireEvent.change(box, { target: { value: PRODUCTION_STRING } });

    expect(refusalsShown()).toBe(1);
    expect(box.getAttribute("aria-invalid")).toBe("true");
    // And the hero total must not quietly count it as 1,50 kr.
    expect(container.textContent).not.toContain("1,50 kr.");
  });

  it.each(["347-50", "1.234.56", "12,34,56", "1,234"])(
    "refuses %s rather than salvaging a positive number out of it",
    async (junk) => {
      const { container } = renderPage();
      await enterManually();
      fireEvent.change(moneyBoxes(container)[0], { target: { value: junk } });
      expect(refusalsShown()).toBe(1);
    },
  );

  it("accepts a real Danish amount and totals it as 1.500,50", async () => {
    const { container } = renderPage();
    await enterManually();
    fireEvent.change(moneyBoxes(container)[0], { target: { value: "1.500,50" } });

    expect(refusalsShown()).toBe(0);
    // The step header prints the running total at glance precision, so what we
    // pin is that the DANISH grouping dot survived — never the browser-locale
    // "1,500", which a Dane reads as one and a half kroner.
    await waitFor(() => expect(container.textContent).toMatch(/1\.50[01]/));
    expect(container.textContent).not.toContain("1,500");
  });

  it("refuses the production string in the MOMS box", async () => {
    // The one figure on this page that goes to SKAT. momsMode must be manual
    // for the box to exist, which is what the toggle below does.
    const { container } = renderPage();
    await enterManually();
    // The MOMS block only appears on the review step, and only once there is
    // revenue for it to be a percentage OF.
    fireEvent.change(moneyBoxes(container)[0], { target: { value: "17.030" } });
    for (let i = 0; i < 8; i++) {
      if (screen.queryByText("fromReceipt")) break;
      if (!tapNext()) break;
    }
    // No early-return escape hatch: if the MOMS step stops being reachable,
    // this test must FAIL rather than pass having asserted nothing.
    const manual = screen.getByText("fromReceipt");
    fireEvent.click(manual.closest("button") || manual);
    const momsBox = await screen.findByPlaceholderText("momsAmountPlaceholder");

    fireEvent.change(momsBox, { target: { value: PRODUCTION_STRING } });
    expect(refusalsShown()).toBe(1);
    expect(momsBox.getAttribute("type")).toBe("text");

    // And a real Danish MOMS figure gets through.
    fireEvent.change(momsBox, { target: { value: "1.500,50" } });
    expect(refusalsShown()).toBe(0);
  });
});
