/**
 * Round 15 polish on the daily close.
 *
 * - "du gemmer 17.130 kr.." — one full stop (rendered with the real Danish
 *   dictionary, since the key-echo t() cannot show a template's punctuation).
 * - Næste / Tilbage / "Spring over" / "Brug disse tal" bring the step's top
 *   into view instead of opening it under the sticky header.
 * - The scan result card keeps "Kasserapport for {dag}".
 * - One clock on the page: "kl. 07.12", the lock card and the send lines alike.
 * - Tap areas: History + export controls ≥ 40 px up to tablet width, and the
 *   inline "Profil" links ≥ 40 px on a phone (source guards — jsdom has no
 *   layout, and Tailwind classes are the contract).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { da } from "../i18n/da";
import { sentWhen } from "../utils/closeEmail";

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
const SOURCE = readFileSync(join(HERE, "..", "pages", "DailyClosePage.jsx"), "utf8");

const TILL1 = {
  revenue: { food: 9000, drinks: 6000, takeaway: 2030 }, revenue_total: 17030, moms_total: 3406,
  payments: { card: 12000, cash: 4030, mobilepay: 1000 }, raw_text: "TILL 1", ocr_available: true,
};
let scans = [];
let scrolled;
const realScrollIntoView = Element.prototype.scrollIntoView;

beforeEach(() => {
  realDanish = false;
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
const shoot = (container) =>
  fireEvent.change(container.querySelector('input[type="file"]'), {
    target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] },
  });
/** The wizard card — the element a step change brings back into view. */
const cardScrolls = () => scrolled.filter((s) => s.el.classList?.contains("scroll-mt-16") && s.opts?.block === "start").length;

describe("daily close — the scan card's Z-bon line has one full stop", () => {
  it("reads \"du gemmer 17.130 kr.\", never \"kr..\"", async () => {
    realDanish = true;
    scans = [{ ...TILL1, revenue: { food: 9000, drinks: 6030, takeaway: 2000 } }];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    const box = [...container.querySelectorAll("input")].find((i) => i.value === "6.030");
    fireEvent.change(box, { target: { value: "6.130" } });
    await waitFor(() => expect(container.textContent).toContain("du gemmer 17.130 kr."));
    expect(container.textContent).not.toContain("kr..");
  });
});

describe("daily close — a step change opens at the step's top", () => {
  it("Spring over, Næste and Tilbage bring the wizard card into view", async () => {
    const { container } = renderPage();
    fireEvent.click(screen.getByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    await waitFor(() => expect(cardScrolls()).toBe(1));

    const next = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
    fireEvent.click(next);
    await waitFor(() => expect(container.querySelector("#dc-pay-card")).not.toBeNull());
    await waitFor(() => expect(cardScrolls()).toBe(2));

    const back = screen.getAllByRole("button").find((b) => /back$/.test(b.textContent.trim()));
    fireEvent.click(back);
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    await waitFor(() => expect(cardScrolls()).toBe(3));
  });

  it("\"Brug disse tal\" from the bottom of a scan card lands on the review's top", async () => {
    scans = [TILL1];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    scrolled = [];
    fireEvent.click(screen.getByText("useTheseValuesJumpReview"));
    await screen.findByText("confirmAndLock");
    await waitFor(() => expect(cardScrolls()).toBe(1));
    expect(container.querySelector(".scroll-mt-16")).not.toBeNull();
  });

  it("Spring over is a 40 px tap target", () => {
    expect(SOURCE).toMatch(/setStep\(1\); revealStepTop\(\); \}\}\s*className="inline-flex items-center min-h-10/);
  });
});

describe("daily close — the scan result card says which day it is for", () => {
  it("keeps \"Kasserapport for {dag}\" above the results", async () => {
    scans = [TILL1];
    const { container } = renderPage();
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    const line = screen.getByTestId("dc-scan-result-date");
    expect(line.textContent).toMatch(/^dcCloseForDate:/);
    // Above the results heading, not somewhere under them.
    expect(line.compareDocumentPosition(screen.getByText("scanResults")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe("daily close — one clock on the page", () => {
  it("send lines use the Danish \"07.12\"", () => {
    const iso = "2026-10-08T05:12:00Z";
    const d = new Date(iso);
    const pad = (n) => String(n).padStart(2, "0");
    expect(sentWhen(iso).time).toBe(`${pad(d.getHours())}.${pad(d.getMinutes())}`);
  });

  it("the lock card's time goes through the same formatter", () => {
    expect(SOURCE).toMatch(/const closedAt = sentWhen\(close\.closed_at\)\?\.time/);
    expect(SOURCE).not.toMatch(/toLocaleTimeString\(/);
  });
});

describe("daily close — tap areas", () => {
  const historyAndExport = SOURCE.slice(SOURCE.indexOf("const btn = (label, onClick = () => send(false))"));

  it("History and export controls are ≥ 40 px up to tablet width, not only on a phone", () => {
    expect(historyAndExport.length).toBeGreaterThan(1000);
    expect(historyAndExport).not.toMatch(/max-sm:(min-)?h-10/);
    expect((historyAndExport.match(/max-lg:(min-)?h-10/g) || []).length).toBeGreaterThanOrEqual(15);
    // Range chips: 40 px until desktop.
    expect(historyAndExport).toMatch(/px-3 min-h-10 lg:min-h-8/);
  });

  it("from 768 to 1023 px the step counter keeps out of the floating AI button's column", () => {
    // The button is fixed 64 px in from the right; the wizard reaches the edge.
    expect(SOURCE).toMatch(/<div className="flex items-center justify-between gap-3 mb-5 md:max-lg:pr-8">/);
  });

  it("every inline Profil link has a 40 px tap area on a phone", () => {
    const links = SOURCE.match(/<Link to="\/profile"[^>]*>/g) || [];
    expect(links.length).toBeGreaterThanOrEqual(6);
    links.forEach((l) => expect(l).toContain("PROFILE_LINK_TAP"));
    expect(SOURCE).toMatch(/const PROFILE_LINK_TAP = "[^"]*max-sm:min-h-10[^"]*max-sm:min-w-10/);
  });
});
