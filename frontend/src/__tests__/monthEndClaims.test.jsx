/**
 * Month-end claims say what exists (12 Oct audit).
 *
 *  • The dashboard month-end banner was gated on a feature key no plan has
 *    ("send_to_revisor") — it never showed. It now shows in its own window
 *    (last days of a month, first five of the next) and leads to
 *    Månedsafslutning, not to a promise of "one click … you're done".
 *  • The pre-filled mail to the revisor said "four files"; the ZIP has more.
 *  • /month-end is reachable (More + ⌘K) and owner-only.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { deriveActivations } from "../config/dashboardCardSets";
import { buildBundleBody } from "../utils/shareDailyCloseRange";
import { NAV_MANIFEST } from "../config/navManifest";

vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da" }),
}));

describe("month-end banner gate", () => {
  const act = (daysToMonthEnd, dayOfMonth) =>
    deriveActivations({ now: { daysToMonthEnd, dayOfMonth } }, { defaultActivations: {} });

  it("is open at the end of a month and in the first five days of the next", () => {
    expect(act(2, 29).isMonthEndWindow).toBe(true);
    expect(act(28, 3).isMonthEndWindow).toBe(true);
    expect(act(15, 16).isMonthEndWindow).toBe(false);
  });

  it("the card no longer asks for a feature key that no plan has", async () => {
    const mod = await import("../config/dashboardCardSets");
    const src = JSON.stringify(Object.values(mod).map(String));
    expect(src).not.toContain("send_to_revisor");
  });

  it("the banner leads to Månedsafslutning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 2, 10, 0));
    const Banner = (await import("../components/MonthEndBundleBanner")).default;
    render(<MemoryRouter><Banner /></MemoryRouter>);
    const cta = screen.getByText("bundleBannerCtaNow");
    // Early November → October, named in the link.
    expect(cta.closest("a")).toHaveAttribute("href", "/month-end?month=2026-10");
    vi.useRealTimers();
  });
});

describe("the bundle mail to the revisor names what is in the ZIP", () => {
  it("no 'four files'", () => {
    const da = buildBundleBody({ fromIso: "2026-09-01", toIso: "2026-09-30", language: "da" });
    const en = buildBundleBody({ fromIso: "2026-09-01", toIso: "2026-09-30", language: "en" });
    expect(da).not.toMatch(/fire filer/);
    expect(en).not.toMatch(/four files/);
    for (const f of ["moms-summary", "gavekort", "manifest.txt"]) {
      expect(da).toContain(f);
      expect(en).toContain(f);
    }
  });
});

describe("Månedsafslutning in the nav", () => {
  it("is owner-only and reachable from More and ⌘K", () => {
    const row = NAV_MANIFEST.find((d) => d.to === "/month-end");
    expect(row).toBeTruthy();
    expect(row.ownerOnly).toBe(true);
    expect(row.surfaces).toEqual(expect.arrayContaining(["more", "search"]));
    expect(row.aliases).toEqual(expect.arrayContaining(["revisorpakke", "månedsafslutning"]));
  });
});
