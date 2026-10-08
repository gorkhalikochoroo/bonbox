/**
 * Round 16 polish on the daily close (tablet 768 and both lanes).
 *
 * - A History card keeps one precision whether it is open or not: "Vis
 *   detaljer" turned "28.469 kr." into "28.469,00 kr.". The precision now
 *   comes from the card's own figures (the ledger's included), never isOpen.
 * - Tablet tap areas on this page: the inline Profil / revisor links (28×13,
 *   194×16) and the heat-map's Omsætning / Kontant toggle (92×32) are ≥ 40 px
 *   below desktop width, not only on a phone.
 * - 768–1023 px: the review ledger and the Næste row keep out of the floating
 *   AI button's column (page-level padding, as the step header already did).
 *
 * Tap areas and padding are source guards — jsdom has no layout, and the
 * Tailwind classes are the contract. Strings are asserted by key.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
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

let closes = [];
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  closes = [];
  get.mockImplementation((url) => Promise.resolve({ data: url === "/daily-close" ? closes : [] }));
  post.mockResolvedValue({ data: {} });
});

const openHistoryCard = async (id) => {
  const view = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
  fireEvent.click(await screen.findByRole("tab", { name: "historyTab" }));
  await waitFor(() => expect(view.container.querySelector(`[data-close-id="${id}"]`)).not.toBeNull());
  return view.container.querySelector(`[data-close-id="${id}"]`);
};
const expand = async (card) => {
  fireEvent.click(card.querySelector("button[aria-expanded]"));
  await waitFor(() => expect(card.querySelector('[aria-expanded="true"]')).not.toBeNull());
};
/** The card's headline total — its first figure. */
const headline = (card) => card.querySelector("span.tabular-nums")?.textContent;

describe("daily close — a History card keeps its precision when it opens", () => {
  it("whole kroner throughout: \"28.470 kr.\" open and shut, the ledger too", async () => {
    closes = [{
      id: "W", date: "2026-09-25", status: "confirmed", revenue_total: 28470,
      revenue_breakdown: { food: 17390, drinks: 11080 }, payment_breakdown: { card: 28470 },
      moms_total: 5694, revenue_ex_moms: 22776, payment_total: 28470,
    }];
    const card = await openHistoryCard("W");
    const shut = headline(card);
    expect(shut).toContain("28.470");
    expect(card.textContent).not.toContain(",00");
    await expand(card);
    expect(headline(card)).toBe(shut);
    expect(card.textContent).not.toContain(",00");
    // The ledger is there, at the card's precision.
    expect(card.textContent).toContain("5.694");
    expect(card.textContent).toContain("22.776");
  });

  it("øre on the card (its MOMS): øre on every figure, open and shut — no reflow", async () => {
    closes = [{
      id: "O", date: "2026-09-25", status: "confirmed", revenue_total: 28469,
      revenue_breakdown: { food: 17393, drinks: 11076 }, payment_breakdown: { card: 28469 },
      moms_total: 5693.8, revenue_ex_moms: 22775.2, payment_total: 28469,
    }];
    const card = await openHistoryCard("O");
    const shut = headline(card);
    expect(shut).toContain("28.469,00");
    expect(card.textContent).toContain("17.393,00");
    await expand(card);
    expect(headline(card)).toBe(shut);
    expect(card.textContent).toContain("17.393,00");
    expect(card.textContent).toContain("5.693,80");
  });
});

describe("daily close — tablet tap areas (source guards)", () => {
  it("the inline Profil / revisor links keep a 40 px tap area below desktop width", () => {
    const def = SOURCE.slice(SOURCE.indexOf("const PROFILE_LINK_TAP ="), SOURCE.indexOf(";", SOURCE.indexOf("const PROFILE_LINK_TAP =")));
    // Phone, as before…
    expect(def).toContain("max-sm:relative max-sm:py-3.5 max-sm:px-1.5 max-sm:-mx-1.5");
    // …and 640–1023 px (the 768 tablet) the same way.
    expect(def).toContain("sm:max-lg:relative sm:max-lg:py-3.5 sm:max-lg:px-1.5 sm:max-lg:-mx-1.5");
    const links = SOURCE.match(/<Link to="\/profile"[^>]*>/g) || [];
    expect(links.length).toBeGreaterThanOrEqual(6);
    links.forEach((l) => expect(l).toContain("PROFILE_LINK_TAP"));
  });

  it("the heat-map's Omsætning / Kontant toggle is 40 px tall below desktop width", () => {
    expect(SOURCE).toMatch(/<Chip key=\{m\.id\} size="sm" selected=\{mode === m\.id\} onClick=\{\(\) => setMode\(m\.id\)\} className="max-lg:min-h-10">/);
  });

  it("768–1023 px: the review ledger and the Næste row keep clear of the floating AI button", () => {
    expect(SOURCE).toMatch(/\{currentStepId === "review" && \(\s*<div className="space-y-4 md:max-lg:pr-8">/);
    expect(SOURCE).toMatch(/<div className="flex justify-between mt-6 pt-4 border-t border-gray-200 dark:border-gray-700 md:max-lg:pr-8">/);
  });
});
