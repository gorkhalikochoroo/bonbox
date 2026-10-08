/**
 * Round 19 polish on the daily close.
 *
 * - No "kr.." anywhere a money figure ends a sentence: the one-till MOMS note
 *   (card and review), the reopened draft's MOMS note and the Z-bon line
 *   (rendered with the real Danish dictionary — the key-echo t() cannot show
 *   a template's punctuation), and a dictionary guard for the page's money
 *   placeholders.
 * - The payments shortfall line shows øre like the boxes ("16.030,50 kr.",
 *   never "16.031 kr.").
 * - History: one precision for every card shown ("20.315,00 kr." beside
 *   "28.469,00 kr.", never "20.315 kr.").
 * - The lock card says who got the mail once.
 * - The removal audit's B2, restored: a draft this page filed that is gone
 *   from History is filed again by the next step.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

let realDanish = false;
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
      if (realDanish) {
        const hit = da[k] ?? (typeof fallbackOrVars === "string" ? fallbackOrVars : k);
        return vars ? hit.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m)) : hit;
      }
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

const HERE = dirname(fileURLToPath(import.meta.url));
const EMPTY_DAY = { has_data: false, day_cutoff_hour: 6, sales: { total: 0, count: 0 }, expenses: { total: 0, count: 0 } };
const TOTAL_ONLY_17030 = { revenue: {}, revenue_total: 17030, payments: { card: 17030 }, raw_text: "T1", ocr_available: true };
const BON_5000 = { revenue: { food: 3500, drinks: 1500 }, revenue_total: 5000, moms_total: 1000, payments: { card: 5000 }, raw_text: "T2", ocr_available: true };
const SHORT_PAY = {
  revenue: { food: 9000, drinks: 6000, takeaway: 2030 }, revenue_total: 17030, moms_total: 3406,
  payments: { card: 12000, cash: 4030.5 }, raw_text: "B", ocr_available: true,
};

let closes = [];
let scans = [];
let profile = {};
let lockAnswer = null;
beforeEach(() => {
  realDanish = false;
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.confirm = vi.fn(() => true);
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  closes = [];
  scans = [];
  profile = {};
  lockAnswer = null;
  get.mockImplementation((url) => {
    // A fresh list per answer, as the API gives one.
    if (url === "/daily-close") return Promise.resolve({ data: [...closes] });
    if (url === "/daily-close/prefill") return Promise.resolve({ data: EMPTY_DAY });
    if (url === "/property-report") return Promise.resolve({ data: { totals: {} } });
    if (url === "/business") return Promise.resolve({ data: profile });
    return Promise.resolve({ data: [] });
  });
  post.mockImplementation((url, body) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() });
    if (url === "/daily-close" && body?.status === "confirmed" && lockAnswer) return Promise.resolve({ data: lockAnswer(body) });
    return Promise.resolve({ data: { id: "d1", status: "draft", date: body?.date } });
  });
});

const renderPage = (path = "/daily-close") => render(<MemoryRouter initialEntries={[path]}><DailyClosePage /></MemoryRouter>);
const cardInput = (container) => [...container.querySelectorAll('input[type="file"]')].at(-1);
const shoot = (container, name) => fireEvent.change(cardInput(container), { target: { files: [new File([name], name, { type: "image/jpeg" })] } });
const tap = (re) => {
  const b = [...document.querySelectorAll("button")].find((x) => re.test(x.textContent.trim()));
  if (!b) throw new Error(`no button ${re}`);
  fireEvent.click(b);
};
const closePosts = () => post.mock.calls.filter(([url]) => url === "/daily-close").map(([, b]) => b);

describe("no \"kr..\" where a money figure ends a sentence", () => {
  it("the one-till MOMS note, on the card and in the review, in real Danish", async () => {
    realDanish = true;
    scans = [TOTAL_ONLY_17030, BON_5000];
    const { container } = renderPage();
    shoot(container, "a.jpg");
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    shoot(container, "b.jpg");
    await waitFor(() => expect(screen.queryByTestId("dc-terminal-question")).not.toBeNull());
    tap(/^En terminal mere/);
    const note = await screen.findByTestId("dc-moms-one-till");
    expect(note.textContent).toContain("den samlede omsætning (22.030 kr.). Har en bon");
    expect(container.textContent).not.toContain("kr..");
    tap(/^Brug disse tal/);
    const review = await screen.findByTestId("dc-review-moms-one-till");
    expect(review.textContent).toContain("(22.030 kr.)");
    expect(container.textContent).not.toContain("kr..");
  });

  it("the page's money placeholders never end a sentence in Danish or English", () => {
    const MONEY = ["saved", "old", "bon", "moms", "diff", "sum", "amount", "total"];
    const page = readFileSync(join(HERE, "..", "pages", "DailyClosePage.jsx"), "utf8");
    const keys = new Set([...page.matchAll(/t\(\s*"([A-Za-z0-9_]+)"/g)].map((m) => m[1]));
    ["da", "en"].forEach((lang) => {
      const text = readFileSync(join(HERE, "..", "i18n", `${lang}.js`), "utf8");
      const offenders = [];
      for (const m of text.matchAll(/^\s+([A-Za-z0-9_]+):\s*"((?:[^"\\]|\\.)*)"/gm)) {
        if (!keys.has(m[1])) continue;
        MONEY.forEach((v) => { if (new RegExp(`\\{${v}\\}\\.(?!\\.)`).test(m[2])) offenders.push(`${lang}.${m[1]}`); });
      }
      // "{total}" in a count ("af {total}.") is not money: the page's keys only.
      expect(offenders, `money placeholder before a full stop: ${offenders.join(", ")}`).toEqual([]);
    });
  });
});

describe("the payments shortfall line shows øre like the boxes", () => {
  it("12.000 + 4.030,50 against 17.030: \"16.030,50 kr. — 999,50 kr.\"", async () => {
    scans = [SHORT_PAY];
    const { container } = renderPage();
    shoot(container, "a.jpg");
    const line = await screen.findByTestId("dc-scan-pay-short");
    expect(line.textContent).toContain("dcScanPayShort:16.030,50 kr.|999,50 kr.");
    expect(container.textContent).not.toContain("16.031");
  });
});

describe("History: one precision for every card shown", () => {
  it("a whole-krone card beside one with øre reads \",00\" too", async () => {
    closes = [
      {
        id: "A", date: "2026-09-26", status: "confirmed", revenue_total: 20315,
        revenue_breakdown: { food: 12315, drinks: 8000 }, payment_breakdown: { card: 20315 },
        moms_total: 4063, revenue_ex_moms: 16252, payment_total: 20315,
      },
      {
        id: "B", date: "2026-09-25", status: "confirmed", revenue_total: 28469,
        revenue_breakdown: { food: 17393, drinks: 11076 }, payment_breakdown: { card: 28469 },
        moms_total: 5693.8, revenue_ex_moms: 22775.2, payment_total: 28469,
      },
    ];
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
    await waitFor(() => expect(container.querySelector('[data-close-id="A"]')).not.toBeNull());
    const a = container.querySelector('[data-close-id="A"]');
    const b = container.querySelector('[data-close-id="B"]');
    expect(a.textContent).toContain("20.315,00");
    expect(a.textContent).toContain("12.315,00");
    expect(b.textContent).toContain("28.469,00");
  });

  it("a list of whole-krone cards stays whole kroner", async () => {
    closes = [{
      id: "A", date: "2026-09-26", status: "confirmed", revenue_total: 20315,
      revenue_breakdown: { food: 12315, drinks: 8000 }, payment_breakdown: { card: 20315 },
      moms_total: 4063, revenue_ex_moms: 16252, payment_total: 20315,
    }];
    const { container } = renderPage();
    fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
    await waitFor(() => expect(container.querySelector('[data-close-id="A"]')).not.toBeNull());
    const a = container.querySelector('[data-close-id="A"]');
    expect(a.textContent).toContain("20.315");
    expect(a.textContent).not.toContain(",00");
  });
});

describe("the lock card says who got the mail once", () => {
  it("sent to the owner, the revisor is sample data: one line, not \"Sendt til …\" and the status line", async () => {
    profile = { accountant_email: "revisor@eksempel.dk", accountant_is_demo: true };
    lockAnswer = (body) => ({
      id: "c1", status: "confirmed", date: body.date, revenue_total: 1234.5, closed_by: "Test",
      closed_at: "2026-10-07T05:20:00", email_status: "sent", email_sent_to: ["owner@example.com"],
      close_ritual: { email_status: "sent", sent_to: ["owner@example.com"], accountant_skip_reason: "demo_recipient" },
    });
    const { container } = renderPage();
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "1234,50" } });
    for (let i = 0; i < 6 && !screen.queryByText("confirmAndLock"); i++) {
      const next = screen.getAllByRole("button").find((x) => /^next\s/.test(x.textContent));
      if (next) fireEvent.click(next);
      await new Promise((r) => setTimeout(r, 0));
    }
    fireEvent.click(await screen.findByText("confirmAndLock"));
    await waitFor(() => expect(container.textContent).toMatch(/dcMailOwnerOnlyDemoRevisor/));
    expect(container.textContent).not.toMatch(/closeLockedEmailSent/);
    expect(container.textContent.match(/dcMailOwnerOnlyDemoRevisor/g)).toHaveLength(1);
  });
});

describe("B2 restored: a filed draft gone from History is filed again by the next step", () => {
  const typeAndSave = async () => {
    const view = renderPage();
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(view.container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(view.container.querySelector("#dc-rev-food"), { target: { value: "1000" } });
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(closePosts()).toHaveLength(1));
    return view;
  };

  it("deleted elsewhere (History no longer lists it): Næste files the same figures again", async () => {
    await typeAndSave();
    // History answers without the draft (deleted on another phone).
    await waitFor(() => expect(get.mock.calls.filter(([u]) => u === "/daily-close").length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 0));
    const next = screen.getAllByRole("button").find((x) => /^next\s/.test(x.textContent));
    fireEvent.click(next);
    window.dispatchEvent(new Event("pagehide"));
    await waitFor(() => expect(closePosts()).toHaveLength(2));
    expect(closePosts()[1].revenue_breakdown).toEqual({ food: 1000 });
  });

  it("still listed: Næste with nothing changed sends nothing (one draft per change)", async () => {
    get.mockImplementation((url) => {
      if (url === "/daily-close") {
        const sent = closePosts().at(-1);
        return Promise.resolve({ data: sent ? [{ id: "d1", status: "draft", date: sent.date, branch_id: null, revenue_total: 1000 }] : [] });
      }
      if (url === "/daily-close/prefill") return Promise.resolve({ data: EMPTY_DAY });
      return Promise.resolve({ data: [] });
    });
    await typeAndSave();
    await waitFor(() => expect(get.mock.calls.filter(([u]) => u === "/daily-close").length).toBeGreaterThanOrEqual(2));
    await new Promise((r) => setTimeout(r, 0));
    const next = screen.getAllByRole("button").find((x) => /^next\s/.test(x.textContent));
    fireEvent.click(next);
    window.dispatchEvent(new Event("pagehide"));
    await new Promise((r) => setTimeout(r, 20));
    expect(closePosts()).toHaveLength(1);
  });
});
