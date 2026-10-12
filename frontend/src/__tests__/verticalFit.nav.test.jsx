/**
 * Vertical fit (12 Oct 2026) — the nav adapts to the OWNER's business type.
 *
 * The audit's root cause: nav decided what fits a business from the BRANCH's
 * type, and a single-location owner has no branch rows (the web does not even
 * read the list without a native token). So every fresh account resolved to
 * "general": the bottom bar's 4th tab was Kasserapport for a café, a salon, a
 * shop and a workshop alike, and Mere offered Madspild + Udløbsprognose to a
 * salon, a bike workshop and a tøjbutik.
 *
 * Pinned here:
 *   • useBranch falls back to user.business_type when there are no branches;
 *   • a branchless salon's tab 4 is "Tidsbestilling" (→ /reservations) and its
 *     Mere has no Madspild / Udløbsprognose;
 *   • the slot never points at a pillar the owner switched off;
 *   • perishable-only Expiry/Waste, Insights for every type, the Workshop job
 *     board in Mere for a repair trade with the module on.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../services/api", () => ({ default: { get: (...a) => get(...a), post: vi.fn(), put: vi.fn(), patch: vi.fn() } }));
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
const auth = vi.hoisted(() => ({ user: null }));
vi.mock("../hooks/useAuth", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ user: auth.user, logout: vi.fn(), loading: false }) };
});
const pillarState = vi.hoisted(() => ({ hidden: new Set() }));
vi.mock("../hooks/usePillars", () => ({
  usePillars: () => ({ hiddenPillars: pillarState.hidden, isReady: true, setPillarHidden: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("../hooks/useActivation", () => ({
  useActivation: () => ({
    usageDormantPillars: new Set(), usageKnownDormant: new Set(), activatedPillars: undefined,
    isActivated: () => true, isInScope: false, activationEnabled: false, isReady: true, refresh: vi.fn(),
  }),
}));
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => ({ enabled: false, locked: false }) }));

const { BranchProvider, useBranch } = await import("../components/BranchSelector");
const MobileBottomNav = (await import("../components/MobileBottomNav")).default;
const MorePage = (await import("../pages/MorePage")).default;
const { getTabsForType } = await import("../config/bottomNavTabs");
const { NAV_MANIFEST, filterDestinations } = await import("../config/navManifest");
const { archetypeIdFor } = await import("../config/archetypes");
const { da } = await import("../i18n/da");

const settle = async () => { for (let i = 0; i < 6; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const modulesPayload = (enabled = []) => ({
  data: {
    plan: "trial", modules_cap: -1, enabled_count: enabled.length,
    modules: ["bar_pour", "wine_sommelier", "workshop"].map((id) => ({ id, name: id, description: "", enabled: enabled.includes(id) })),
  },
});

beforeEach(() => {
  localStorage.clear();
  pillarState.hidden = new Set();
  get.mockReset();
  get.mockImplementation((url) => (url === "/modules" ? Promise.resolve(modulesPayload()) : Promise.resolve({ data: {} })));
});
afterEach(() => { cleanup(); });

describe("useBranch resolves the owner's own type when there are no branches", () => {
  let seen = null;
  const Probe = () => { seen = useBranch(); return null; };

  it("a branchless salon reads as a salon (it read null → 'general' before)", async () => {
    auth.user = { id: "u1", business_type: "salon", role: "owner" };
    render(<BranchProvider><Probe /></BranchProvider>);
    await settle();
    expect(seen.hasBranches).toBe(false);
    expect(seen.branchType).toBe("salon");
  });

  it("with branches and none picked, the branch set still decides (unchanged)", async () => {
    localStorage.setItem("token", "native-token");
    auth.user = { id: "u2", business_type: "salon", role: "owner" };
    get.mockResolvedValue({ data: { branches: [{ id: "b1", name: "A", business_type: "restaurant" }] } });
    render(<BranchProvider><Probe /></BranchProvider>);
    await settle();
    expect(seen.hasBranches).toBe(true);
    expect(seen.branchType).toBeNull();
    expect(seen.businessTypes).toEqual(["restaurant"]);
  });
});

describe("the phone tab bar's 4th slot", () => {
  it("a branchless salon gets Tidsbestilling as tab 4", async () => {
    auth.user = { id: "u3", business_type: "salon", role: "owner" };
    render(<MemoryRouter><BranchProvider><MobileBottomNav /></BranchProvider></MemoryRouter>);
    await settle();
    const tab = screen.getByRole("link", { name: da.navAppointments });
    expect(da.navAppointments).toBe("Tidsbestilling");
    expect(tab.getAttribute("href")).toBe("/reservations");
    expect(screen.queryByRole("link", { name: da.navToday })).toBeNull();
  });

  it.each([
    ["cafe", "/reservations", "reservations"],
    ["bar", "/reservations", "reservations"],
    ["clothing", "/inventory", null],
    ["workshop", "/workshop", "workshop"],
    ["general", "/daily-close", null],
  ])("%s → %s", (type, to) => {
    expect(getTabsForType(type)[3].to).toBe(to);
  });

  it("never points at a pillar the owner switched off — a café without Reservationer keeps Kasserapport", () => {
    const tab = getTabsForType("cafe", new Set(["reservations"]))[3];
    expect(tab.to).toBe("/daily-close");
    expect(getTabsForType("clothing", new Set(["inventory"]))[3].to).toBe("/daily-close");
  });
});

describe("Mere follows the owner's type", () => {
  const tiles = () => screen.getAllByRole("link").map((a) => a.getAttribute("href"));

  it("a branchless salon: no Madspild, no Udløbsprognose — and 'Tidsbestilling' by name", async () => {
    auth.user = { id: "u4", business_type: "salon", role: "owner" };
    render(<MemoryRouter><BranchProvider><MorePage /></BranchProvider></MemoryRouter>);
    await settle();
    const hrefs = tiles();
    expect(hrefs).not.toContain("/waste");
    expect(hrefs).not.toContain("/expiry");
    expect(hrefs).toContain("/reservations");
    const resTile = screen.getAllByRole("link").find((a) => a.getAttribute("href") === "/reservations");
    expect(within(resTile).getByText("Tidsbestilling")).toBeInTheDocument();
  });

  it("a branchless café keeps Madspild and Udløbsprognose", async () => {
    auth.user = { id: "u5", business_type: "cafe", role: "owner" };
    render(<MemoryRouter><BranchProvider><MorePage /></BranchProvider></MemoryRouter>);
    await settle();
    const hrefs = tiles();
    expect(hrefs).toContain("/waste");
    expect(hrefs).toContain("/expiry");
  });

  it("a cykelværksted with the Workshop module sees its job board in Mere", async () => {
    auth.user = { id: "u6", business_type: "workshop", role: "owner" };
    get.mockImplementation((url) => (url === "/modules" ? Promise.resolve(modulesPayload(["workshop"])) : Promise.resolve({ data: {} })));
    render(<MemoryRouter><BranchProvider><MorePage /></BranchProvider></MemoryRouter>);
    await settle();
    expect(tiles()).toContain("/workshop");
    expect(tiles()).not.toContain("/waste");
  });
});

describe("type gates now that a type is resolved", () => {
  const visible = (type, enabled = []) => filterDestinations(
    NAV_MANIFEST.filter((d) => d.surfaces.includes("more") || d.surfaces.includes("sidebar")),
    { businessTypes: [type], archetypeId: archetypeIdFor(type), enabledModules: new Set(enabled), hasFeature: () => true },
  ).map((d) => d.to);

  it("Expiry + Waste are for perishable stock only", () => {
    for (const t of ["restaurant", "cafe", "bakery", "bar", "grocery", "kiosk", "flower_shop", "general", "other"]) {
      expect(visible(t)).toEqual(expect.arrayContaining(["/expiry", "/waste"]));
    }
    for (const t of ["salon", "clothing", "electronics", "jewelry", "workshop"]) {
      expect(visible(t)).not.toContain("/waste");
      expect(visible(t)).not.toContain("/expiry");
    }
  });

  it("Insights is never taken away by the type (its pillar decides)", () => {
    for (const t of ["cafe", "bar", "salon", "clothing", "workshop", "general"]) {
      expect(visible(t)).toContain("/insights");
    }
  });

  it("the Workshop job board follows the module for every repair trade", () => {
    expect(visible("mobile_repair", ["workshop"])).toContain("/workshop");
    expect(visible("salon", ["workshop"])).not.toContain("/workshop");
    expect(visible("workshop", [])).not.toContain("/workshop");
  });

  it("Bar Pour and Vinkort show for a bar with the canonical module ids", () => {
    expect(visible("bar", ["bar_pour", "wine_sommelier"])).toEqual(expect.arrayContaining(["/bar", "/wine-list"]));
  });
});
