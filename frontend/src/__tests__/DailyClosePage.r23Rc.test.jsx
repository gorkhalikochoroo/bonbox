/**
 * Round 23 R-c — the re-rate's verified items, on the page:
 *  2. Phone, scan card: "Ikke fordelt på kategori" never shows a stale
 *     amount while focus is in the total box (or the payment boxes below
 *     it) — the lines on screen always add up. It follows the total, and a
 *     line that would vanish while focus is on the card keeps its place (the
 *     box being typed in never moves).
 * (Item 1 — "Hent {dag}s salg" lets go of the old day — is the sequence
 * harness's named plans 23020–23022 in DailyClosePage.r23Sequences.)
 * Strings are asserted by key (t echoes key + values).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
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
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => () => Promise.resolve(true) }));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const { createServer, installApi } = await import("../test/closeSequenceHarness");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

let S;
beforeEach(() => {
  window.scrollTo = () => {};
  window.scrollBy = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  del.mockReset();
});
const serve = (rows = []) => {
  S = createServer({ rows });
  installApi(S, get, post, del);
};

const q = (sel) => document.querySelector(sel);
const text = () => document.body.textContent;
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
/** A browser: each key goes onto what the box shows NOW. */
const typeOn = (el, chars) => { for (const ch of chars) fireEvent.change(el, { target: { value: el.value + ch } }); };
const mount = async (want) => {
  const view = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
  for (let i = 0; i < 12 && !text().includes(want); i++) await settle();
  return view;
};

/* ─── 2. the scan card's "Ikke fordelt" line ─────────────────────────── */

describe("R-c 2 — \"Ikke fordelt på kategori\" is never stale while a box below it has focus", () => {
  const BON = {
    raw_text: "BON", ocr_available: true,
    revenue: { food: 12000, drinks: 1500 }, revenue_total: 22000, moms_total: 4400, payments: { card: 22000 },
  };
  const shoot = async (container) => {
    S.nextScan = BON;
    const input = [...container.querySelectorAll('input[type="file"]')].at(-1);
    fireEvent.change(input, { target: { files: [new File(["b"], "b.jpg", { type: "image/jpeg", lastModified: 1 })] } });
    await waitFor(() => expect(screen.queryByText("readingZReport")).toBeNull());
    await waitFor(() => expect(q("#scan-total")).not.toBeNull());
  };
  const unsplit = () => [...document.querySelectorAll("span")]
    .find((el) => el.textContent === "dcUnsplitRevenue" || el.textContent === "dcCorrectedDown")?.parentElement?.textContent || "";
  /** Focus moving straight on from one box to the next (Tab): blur with the next box as relatedTarget, then its focus. */
  const tabTo = (from, to) => {
    fireEvent.blur(from, { relatedTarget: to });
    fireEvent.focus(to, { relatedTarget: from });
  };

  it("the re-rate's repro: Takeaway 3000 typed, Tab to the total — 5.500 (never the 6.500 from before the typing), also on to a payment box; right after leaving", async () => {
    serve();
    const { container } = await mount("scanZReportTitle");
    await shoot(container);
    expect(unsplit()).toContain("8.500");
    const takeaway = q("#scan-rev-takeaway");
    fireEvent.focus(takeaway);
    typeOn(takeaway, "2000");
    expect(unsplit()).toContain("6.500");
    // Over it: 3000.
    fireEvent.change(takeaway, { target: { value: "" } });
    typeOn(takeaway, "3000");
    expect(unsplit()).toContain("5.500");
    const total = q("#scan-total");
    tabTo(takeaway, total);
    expect(unsplit()).toContain("5.500");
    expect(unsplit()).not.toContain("6.500");
    expect(unsplit()).not.toContain("8.500");
    const cash = q("#scan-pay-cash") || q('[id^="scan-pay-"]');
    if (cash) {
      tabTo(total, cash);
      expect(unsplit()).toContain("5.500");
      fireEvent.blur(cash);
    } else fireEvent.blur(total);
    expect(unsplit()).toContain("5.500");
  });

  it("typing in the total box: the line follows the total (12.000 + 1.500 + 3.000 + line = the total on every key), and a line that would vanish keeps its place", async () => {
    serve();
    const { container } = await mount("scanZReportTitle");
    await shoot(container);
    const takeaway = q("#scan-rev-takeaway");
    fireEvent.focus(takeaway);
    typeOn(takeaway, "3000");
    const total = q("#scan-total");
    tabTo(takeaway, total);
    fireEvent.change(total, { target: { value: "" } });
    typeOn(total, "25000");
    expect(unsplit()).toContain("8.500");
    // The total typed down to exactly the categories: nothing is unsplit —
    // no stale figure, and the line's place is kept (the box does not move).
    fireEvent.change(total, { target: { value: "" } });
    typeOn(total, "16500");
    expect(unsplit()).toBe("");
    expect(q('[data-testid="dc-unsplit-slot"]')).not.toBeNull();
    // Left: the card settles (no empty slot).
    fireEvent.blur(total);
    expect(unsplit()).toBe("");
    expect(q('[data-testid="dc-unsplit-slot"]')).toBeNull();
  });
});
