/**
 * First-15-minutes fixes on the screens around the schedule (12 Oct 2026):
 *
 *   • "Kom i gang" — Vagtplan and Reservationer (switched on at onboarding,
 *     not used yet) at the TOP of Mere and of the menu, named after the page
 *     they open, drawn like live tiles. They sat at the very bottom under
 *     "Tilføj funktioner" as dashed gray-400 "SÆT OP — Personale" tiles.
 *   • A fresh account's new-booking sheet said "I har lukket den dag." for
 *     every date: undeclared hours came back as seven empty lists.
 *   • The first phone booking was refused with a line about opening hours and
 *     tables the owner never set up.
 *   • A staffer's first visit got the FULL cookie wall over their first shift.
 *   • The language notice stayed over every page title until tapped away.
 */
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { da } from "../i18n/da";
import { bookableHoursFromSettings, openTimesFor } from "../utils/bookingTimes";
import { roomFullText, warningFrom } from "../utils/bookingRefusal";

vi.mock("../services/api", () => ({ default: { get: vi.fn(), put: vi.fn(), post: vi.fn() } }));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  return {
    useLanguage: () => ({
      lang: "da",
      setLang: () => {},
      t: (k, fb, vars) => {
        const v = typeof fb === "object" && fb ? fb : vars;
        let s = DA[k] ?? (typeof fb === "string" ? fb : k);
        if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
        return s;
      },
    }),
  };
});
const pillarState = vi.hoisted(() => ({ hidden: new Set() }));
vi.mock("../hooks/usePillars", () => ({
  usePillars: () => ({ hiddenPillars: pillarState.hidden, isReady: true, setPillarHidden: vi.fn().mockResolvedValue(undefined) }),
}));
vi.mock("../hooks/useActivation", () => ({
  useActivation: () => ({
    usageDormantPillars: new Set(["events"]),
    usageKnownDormant: new Set(["events"]),
    activatedPillars: new Set(["inventory"]),
    isActivated: (p) => p === "inventory",
    isInScope: true,
    activationEnabled: true,
    isReady: true,
    refresh: vi.fn(),
  }),
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, business_type: "cafe", role: "owner" }, loading: false }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchType: null, businessTypes: ["cafe"] }),
}));

const PillarDiscovery = (await import("../components/PillarDiscovery")).default;
const CookieConsent = (await import("../components/CookieConsent")).default;
const SmartLanguageToast = (await import("../components/SmartLanguageToast")).default;
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

afterEach(() => { cleanup(); vi.useRealTimers(); });
beforeEach(() => { localStorage.clear(); pillarState.hidden = new Set(); });

describe("Kom i gang — switched-on features are offered first, under their page's name", () => {
  const renderIt = (props) => render(<MemoryRouter><PillarDiscovery variant="more" {...props} /></MemoryRouter>);

  it("titles setup-only tiles 'Kom i gang' and names the staff tile 'Vagtplan'", () => {
    renderIt({ only: "setup" });
    expect(screen.getByText("Kom i gang")).toBeInTheDocument();
    expect(screen.queryByText(da.pillarDiscoveryTitle)).toBeNull();
    const staff = screen.getByLabelText(`${da.activationSetupEyebrow} — Vagtplan`);
    expect(staff).toBeInTheDocument();
    expect(screen.queryByLabelText(`${da.activationSetupEyebrow} — ${da.pillarLabelStaff}`)).toBeNull();
    expect(screen.getByLabelText(`${da.activationSetupEyebrow} — ${da.pillarLabelReservations}`)).toBeInTheDocument();
    // Drawn like a live tile, not a dashed "disabled" one.
    expect(staff.className).not.toMatch(/border-dashed/);
  });

  it("keeps the re-find list ('Tilføj funktioner') apart, for hidden pillars only", () => {
    pillarState.hidden = new Set(["inventory"]);
    renderIt({ only: "off" });
    expect(screen.getByText(da.pillarDiscoveryTitle)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Vagtplan/)).toBeNull();
  });

  it("puts 'Kom i gang' above the grid on Mere, and above the groups in the menu", () => {
    const more = read("pages/MorePage.jsx");
    expect(more.indexOf('only="setup"')).toBeGreaterThan(-1);
    expect(more.indexOf('only="setup"')).toBeLessThan(more.indexOf("{visible.map((section)"));
    expect(more.indexOf('only="off"')).toBeGreaterThan(more.indexOf("{visible.map((section)"));
    const layout = read("components/Layout.jsx");
    const setupAt = layout.indexOf('<PillarDiscovery variant="sidebar" only="setup"');
    expect(setupAt).toBeGreaterThan(-1);
    // Inside the core spine: before the first collapsible group's header.
    expect(setupAt).toBeLessThan(layout.indexOf("onClick={() => toggleGroup(group.id)}"));
  });
});

describe("reservations — undeclared opening hours are unknown, not 'closed'", () => {
  const fresh = { hours_declared: false, open_hours: { mon: [], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] } };

  it("a fresh account offers every quarter and never says closed", () => {
    const hours = bookableHoursFromSettings(fresh);
    expect(hours).toBeNull();
    const r = openTimesFor("2026-10-16", hours, 90);
    expect(r.closed).toBe(false);
    expect(r.times.length).toBeGreaterThan(40);
  });

  it("declared hours are still honoured (an empty day IS closed then)", () => {
    const declared = { hours_declared: true, open_hours: { ...fresh.open_hours, fri: [["11:00", "22:00"]] } };
    expect(bookableHoursFromSettings(declared)).toBe(declared.open_hours);
    expect(openTimesFor("2026-10-15", bookableHoursFromSettings(declared), 90).closed).toBe(true); // Thursday
    expect(openTimesFor("2026-10-16", bookableHoursFromSettings(declared), 90).closed).toBe(false);
  });

  it("the page reads its hours through that rule", () => {
    expect(read("pages/ReservationsPage.jsx")).toContain("setOpenHours(bookableHoursFromSettings(r.data))");
  });

  it("with no tables, 'Vælg et andet tidspunkt' is not offered (no time would help)", () => {
    expect(read("pages/ReservationsPage.jsx")).toContain("{!warning.tooBig && warning.seats !== 0 && (");
  });

  it("a room with no tables at all says so — not 'hours aren't saved'", () => {
    const t = (k) => da[k] ?? k;
    const w = warningFrom({ error: "room_full", total_seats: 0, largest_table: 0, hours_declared: false, requested: 2 }, "12:00");
    expect(roomFullText(w, t, 90)).toBe(da.rsvpNoTablesYet);
    // A room that HAS tables keeps the old reasons.
    const w2 = warningFrom({ error: "room_full", total_seats: 20, largest_table: 4, hours_declared: false, requested: 2 }, "12:00");
    expect(roomFullText(w2, t, 90)).toBe(da.rsvpNoTableNoHours);
  });
});

describe("a staffer's first visit gets the compact cookie banner", () => {
  async function openAt(pathname) {
    vi.useFakeTimers();
    render(<MemoryRouter initialEntries={[pathname]}><CookieConsent /></MemoryRouter>);
    await act(async () => { vi.advanceTimersByTime(700); });
    vi.useRealTimers();
    return document.querySelector('[data-cookie-consent="banner"]');
  }
  it.each(["/s/cafe-solsikke/sofie/tok123", "/join"])("%s", async (route) => {
    const banner = await openAt(route);
    expect(banner.getAttribute("data-cookie-compact")).toBe("1");
    expect(banner.textContent).toContain(da.cookieBannerTitle);
  });
  it("the owner's pages keep the full banner", async () => {
    const banner = await openAt("/dashboard");
    expect(banner.hasAttribute("data-cookie-compact")).toBe(false);
  });
});

describe("the language notice steps aside by itself", () => {
  it("shows once, then goes after a few seconds and is marked shown", async () => {
    localStorage.setItem("bonbox_lang_auto_picked", "browser");
    vi.useFakeTimers();
    render(<SmartLanguageToast />);
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByRole("status").textContent).not.toContain("🌍");
    await act(async () => { vi.advanceTimersByTime(8100); });
    expect(screen.queryByRole("status")).toBeNull();
    expect(localStorage.getItem("bonbox_lang_toast_shown")).toBe("1");
  });
});
