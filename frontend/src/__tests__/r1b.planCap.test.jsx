/**
 * R1b (27 Oct 2026) — the plan's monthly cap, told to the owner, and the
 * held reasons R1b adds.
 *
 *   • PlanCapBanner: once the month's bookings reach the plan's cap, the book
 *     says so — "the page stays open, new online bookings come in as requests
 *     you confirm" (the cap takes requests, Manoj's "Free cap = requests") or
 *     "the page takes no more online bookings until the month turns" (live) —
 *     with the upgrade nudge. Nothing below the cap or with no cap.
 *   • The nudge is UpgradeNudge: in the iOS app it renders nothing (Apple
 *     3.1.1) and the banner still states the fact, never "upgrade".
 *   • A salon, a shop or a workshop reads "aftaler" (apptWords).
 *   • heldWhy: plan_cap names the plan's cap (the server's `held.limit`, else
 *     20); venue_day says "the last 24 hours", not "a short time".
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const plat = vi.hoisted(() => ({ native: false }));
vi.mock("../utils/platform", () => ({
  isNativeApp: () => plat.native,
  canPurchaseInApp: () => !plat.native,
  isIPad: () => false,
  platform: { isNative: false, isIOS: false, isAndroid: false, isWeb: true },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const t = (k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    let s = DA[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return { useLanguage: () => ({ lang: "da", setLang: () => {}, t }), LanguageProvider: ({ children }) => children };
});

const PlanCapModule = await import("../components/reservations/PlanCapBanner");
const PlanCapBanner = PlanCapModule.default;
const { PlanCapHeldNudge, monthCapFromSettings, monthCapReached } = PlanCapModule;
const { heldWhy, heldForPlanCap } = await import("../utils/bookingHeld");
const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");

const tr = (dict) => (k, fb, vars) => {
  const v = typeof fb === "object" && fb ? fb : vars;
  let s = dict[k] ?? (typeof fb === "string" ? fb : k);
  if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
  return s;
};
const tDa = tr(da);
const tEn = tr(en);

const renderIt = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => { plat.native = false; });
afterEach(() => cleanup());

describe("the month's cap from the owner's settings", () => {
  it("reads used, cap and mode — and nothing from an older server", () => {
    expect(monthCapFromSettings({ reservations_used_this_month: 20, reservations_cap: 20, month_cap_mode: "requests" }))
      .toEqual({ used: 20, cap: 20, mode: "requests" });
    expect(monthCapFromSettings({ reservations_used_this_month: 3, reservations_cap: 20 }))
      .toEqual({ used: 3, cap: 20, mode: "closed" });
    expect(monthCapFromSettings({ reservations_enabled: true })).toBeNull();
    expect(monthCapFromSettings(null)).toBeNull();
  });

  it("is reached only at a real cap", () => {
    expect(monthCapReached({ used: 20, cap: 20 })).toBe(true);
    expect(monthCapReached({ used: 25, cap: 20 })).toBe(true);
    expect(monthCapReached({ used: 19, cap: 20 })).toBe(false);
    expect(monthCapReached({ used: 900, cap: -1 })).toBe(false);   // unlimited
    expect(monthCapReached(null)).toBe(false);
  });
});

describe("the book's banner", () => {
  it("says nothing below the cap or with no cap", () => {
    const { container } = renderIt(<PlanCapBanner monthCap={{ used: 19, cap: 20, mode: "requests" }} t={tDa} />);
    expect(container.textContent).toBe("");
    renderIt(<PlanCapBanner monthCap={{ used: 40, cap: -1, mode: "closed" }} t={tDa} />);
    expect(screen.queryByTestId("plan-cap-banner")).toBeNull();
  });

  it("at the cap that takes requests: the page stays open, and the nudge", () => {
    renderIt(<PlanCapBanner monthCap={{ used: 20, cap: 20, mode: "requests" }} t={tDa} />);
    const b = screen.getByTestId("plan-cap-banner");
    expect(b.getAttribute("data-mode")).toBe("requests");
    expect(b.getAttribute("role")).toBe("status");
    expect(b.textContent).toContain(tDa("rsvpPlanCapTitle", "", { n: 20 }));
    expect(b.textContent).toContain(da.rsvpPlanCapRequestsBody);
    const nudge = b.querySelector('a[href="/subscription"]');
    expect(nudge).toBeTruthy();
    expect(nudge.textContent).toContain(da.rsvpPlanCapNudge);
    // Amber = "needs you" (the colour doctrine); never green-*.
    expect(b.className).toMatch(/amber/);
    expect(b.className).not.toMatch(/green-/);
  });

  it("at the cap that closes the page: says so, and the nudge", () => {
    renderIt(<PlanCapBanner monthCap={{ used: 20, cap: 20, mode: "closed" }} t={tDa} />);
    const b = screen.getByTestId("plan-cap-banner");
    expect(b.getAttribute("data-mode")).toBe("closed");
    expect(b.textContent).toContain(da.rsvpPlanCapClosedBody);
    expect(b.querySelector('a[href="/subscription"]')).toBeTruthy();
  });

  it("a salon, a shop or a workshop reads 'aftaler'", () => {
    renderIt(<PlanCapBanner monthCap={{ used: 20, cap: 20, mode: "requests" }} t={tDa} apptWords />);
    const b = screen.getByTestId("plan-cap-banner");
    expect(b.textContent).toContain(tDa("rsvpPlanCapTitleAppt", "", { n: 20 }));
    expect(b.textContent).toContain(da.rsvpPlanCapRequestsBodyAppt);
    expect(b.textContent).toContain(da.rsvpPlanCapNudgeAppt);
    expect(b.textContent).not.toMatch(/gæst|bord|reservation/i);
  });

  it("in the iOS app: the fact, no upgrade surface", () => {
    plat.native = true;
    renderIt(<PlanCapBanner monthCap={{ used: 20, cap: 20, mode: "requests" }} t={tDa} />);
    const b = screen.getByTestId("plan-cap-banner");
    expect(b.textContent).toContain(da.rsvpPlanCapRequestsBody);
    expect(b.querySelector("a")).toBeNull();
    expect(b.textContent).not.toMatch(/opgrad|upgrade|kr\./i);
  });

  it("the drawer's nudge for a booking held at the cap", () => {
    renderIt(<PlanCapHeldNudge t={tDa} apptWords />);
    const n = screen.getByTestId("plan-cap-held-nudge");
    expect(n.querySelector('a[href="/subscription"]').textContent).toContain(da.rsvpPlanCapNudgeAppt);
  });
});

describe("the held reasons R1b adds", () => {
  const row = (held) => ({ status: "requested", source: "public", party_size: 2, held });

  it("plan_cap names the plan's cap, the server's or the Free plan's 20", () => {
    expect(heldWhy(row({ reason: "plan_cap", limit: 20 }), tDa)).toBe(tDa("rsvpHeldWhyPlanCap", "", { n: 20 }));
    expect(heldWhy(row({ reason: "plan_cap", limit: 40 }), tEn)).toBe(tEn("rsvpHeldWhyPlanCap", "", { n: 40 }));
    expect(heldWhy(row({ reason: "plan_cap" }), tDa)).toBe(tDa("rsvpHeldWhyPlanCap", "", { n: 20 }));
    expect(heldWhy(row({ reason: "plan_cap", limit: 20 }), tDa, { apptWords: true }))
      .toBe(tDa("rsvpHeldWhyPlanCapAppt", "", { n: 20 }));
    // contact_active keeps its older default (3).
    expect(heldWhy(row({ reason: "contact_active" }), tDa)).toBe(tDa("rsvpHeldWhyContact", "", { n: 3 }));
  });

  it("venue_day speaks of the last 24 hours", () => {
    expect(heldWhy(row({ reason: "venue_day" }), tDa)).toBe(da.rsvpHeldWhyDay);
    expect(heldWhy(row({ reason: "venue_day" }), tEn)).toBe(en.rsvpHeldWhyDay);
    expect(heldWhy(row({ reason: "venue_hour" }), tDa)).toBe(da.rsvpHeldWhyBusy);
  });

  it("heldForPlanCap: only a request held at the cap", () => {
    expect(heldForPlanCap(row({ reason: "plan_cap" }))).toBe(true);
    expect(heldForPlanCap({ ...row({ reason: "plan_cap" }), status: "confirmed" })).toBe(false);
    expect(heldForPlanCap(row({ reason: "venue_day" }))).toBe(false);
    expect(heldForPlanCap({ status: "requested" })).toBe(false);
    expect(heldForPlanCap(null)).toBe(false);
  });

  it("every new sentence is real Danish and English, the appointment ones with no restaurant word", () => {
    const keys = ["rsvpHeldWhyDay", "rsvpHeldWhyPlanCap", "rsvpHeldWhyPlanCapAppt", "rsvpPlanCapTitle",
      "rsvpPlanCapTitleAppt", "rsvpPlanCapRequestsBody", "rsvpPlanCapRequestsBodyAppt", "rsvpPlanCapClosedBody",
      "rsvpPlanCapClosedBodyAppt", "rsvpPlanCapNudge", "rsvpPlanCapNudgeAppt"];
    for (const k of keys) {
      expect(en[k], k).toBeTruthy();
      expect(da[k], k).toBeTruthy();
      expect(da[k], k).not.toBe(en[k]);
    }
    for (const k of keys.filter((x) => x.endsWith("Appt"))) {
      expect(da[k].replace(/\{\w+\}/g, ""), k).not.toMatch(/gæst|bord|selskab|køkken|reservation/i);
      expect(en[k].replace(/\{\w+\}/g, ""), k).not.toMatch(/guest|table|party|kitchen|reservation/i);
    }
    // The facts never say "upgrade" themselves (the nudge does, web only).
    for (const k of keys.filter((x) => !x.startsWith("rsvpPlanCapNudge"))) {
      expect(`${da[k]} ${en[k]}`, k).not.toMatch(/opgrad|upgrade/i);
    }
    for (const k of ["rsvpHeldWhyPlanCap", "rsvpHeldWhyPlanCapAppt", "rsvpPlanCapTitle", "rsvpPlanCapTitleAppt"]) {
      expect(da[k], k).toContain("{n}");
      expect(en[k], k).toContain("{n}");
    }
  });
});
