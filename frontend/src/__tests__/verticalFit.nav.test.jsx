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
 *   • tab 4 (review round, product decision): Kasserapport for food service
 *     and bars — their first job, and what their bar has always shown; a
 *     salon / shop / workshop gets its own tool (Tidsbestilling / Lager /
 *     Værksted) once that tool is on AND used, else Kasserapport;
 *   • a branchless salon's Mere has no Madspild / Udløbsprognose — unless it
 *     uses them (a real waste row / a dated stock item keeps the tool);
 *   • a module the owner switched on always shows, whatever the type
 *     ("Andet" + Værksted);
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
const act8n = vi.hoisted(() => ({ known: null, surfaces: new Set() }));
vi.mock("../hooks/useActivation", () => ({
  useActivation: () => ({
    usageDormantPillars: new Set(), usageKnownDormant: new Set(), activatedPillars: undefined,
    isActivated: () => true, isInScope: false, activationEnabled: false, isReady: true, refresh: vi.fn(),
    knownActivatedPillars: act8n.known, usedSurfaces: act8n.surfaces,
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
  act8n.known = null;
  act8n.surfaces = new Set();
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
  it("a branchless salon that takes bookings gets Tidsbestilling as tab 4", async () => {
    auth.user = { id: "u3", business_type: "salon", role: "owner" };
    act8n.known = new Set(["reservations"]);
    render(<MemoryRouter><BranchProvider><MobileBottomNav /></BranchProvider></MemoryRouter>);
    await settle();
    const tab = screen.getByRole("link", { name: da.navAppointments });
    expect(da.navAppointments).toBe("Tidsbestilling");
    expect(tab.getAttribute("href")).toBe("/reservations");
    expect(screen.queryByRole("link", { name: da.navToday })).toBeNull();
  });

  it("a salon that has not taken a booking yet — or whose answer is not in — keeps Kasserapport", async () => {
    auth.user = { id: "u3b", business_type: "salon", role: "owner" };
    act8n.known = new Set(["staff"]);
    const { unmount } = render(<MemoryRouter><BranchProvider><MobileBottomNav /></BranchProvider></MemoryRouter>);
    await settle();
    expect(screen.getByRole("link", { name: da.navToday }).getAttribute("href")).toBe("/daily-close");
    unmount();
    act8n.known = null; // loading, no stored answer
    render(<MemoryRouter><BranchProvider><MobileBottomNav /></BranchProvider></MemoryRouter>);
    await settle();
    expect(screen.getByRole("link", { name: da.navToday }).getAttribute("href")).toBe("/daily-close");
  });

  it("a café, a restaurant and a bar keep Kasserapport — even with bookings (product decision)", async () => {
    act8n.known = new Set(["reservations", "inventory", "staff"]);
    for (const type of ["cafe", "restaurant", "bar", "bakery"]) {
      auth.user = { id: `u-${type}`, business_type: type, role: "owner" };
      const { unmount } = render(<MemoryRouter><BranchProvider><MobileBottomNav /></BranchProvider></MemoryRouter>);
      await settle();
      expect(screen.getByRole("link", { name: da.navToday }).getAttribute("href")).toBe("/daily-close");
      expect(screen.queryByRole("link", { name: da.reservations })).toBeNull();
      unmount();
    }
  });

  it.each([
    ["cafe", "/daily-close"],
    ["restaurant", "/daily-close"],
    ["bar", "/daily-close"],
    ["salon", "/reservations"],
    ["clothing", "/inventory"],
    ["workshop", "/workshop"],
    ["general", "/daily-close"],
  ])("%s → %s (no usage rule)", (type, to) => {
    expect(getTabsForType(type)[3].to).toBe(to);
  });

  it("never points at a pillar the owner switched off", () => {
    expect(getTabsForType("salon", new Set(["reservations"]))[3].to).toBe("/daily-close");
    expect(getTabsForType("clothing", new Set(["inventory"]))[3].to).toBe("/daily-close");
  });

  it("leads with the type's own tool only once it is used", () => {
    const used = (pillars = [], surfaces = [], modules = null) => ({
      usedPillars: new Set(pillars), usedSurfaces: new Set(surfaces),
      enabledModules: modules === null ? null : new Set(modules),
    });
    expect(getTabsForType("clothing", null, used([]))[3].to).toBe("/daily-close");
    expect(getTabsForType("clothing", null, used(["inventory"]))[3].to).toBe("/inventory");
    expect(getTabsForType("salon", null, used(["inventory"]))[3].to).toBe("/daily-close");
    // Workshop: job cards are the use; the module must be on (once known).
    expect(getTabsForType("workshop", null, used([], [], ["workshop"]))[3].to).toBe("/daily-close");
    expect(getTabsForType("workshop", null, used([], ["workshop"], ["workshop"]))[3].to).toBe("/workshop");
    expect(getTabsForType("workshop", null, used([], ["workshop"], null))[3].to).toBe("/workshop");
    expect(getTabsForType("workshop", null, used([], ["workshop"], []))[3].to).toBe("/daily-close");
    // Unknown (still loading, no hint) reads as not used.
    expect(getTabsForType("salon", null, { usedPillars: null, usedSurfaces: new Set() })[3].to).toBe("/daily-close");
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

  it("a salon that logs waste keeps Madspild — the type never takes a tool in use", async () => {
    auth.user = { id: "u4b", business_type: "salon", role: "owner" };
    act8n.surfaces = new Set(["waste"]);
    render(<MemoryRouter><BranchProvider><MorePage /></BranchProvider></MemoryRouter>);
    await settle();
    expect(tiles()).toContain("/waste");
    expect(tiles()).not.toContain("/expiry");
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

  it("the Workshop job board follows the module — a module the owner switched on always shows", () => {
    expect(visible("mobile_repair", ["workshop"])).toContain("/workshop");
    // "Andet" with Værksted switched on in /modules (review round): it shows.
    expect(visible("general", ["workshop"])).toContain("/workshop");
    expect(visible("other", ["workshop"])).toContain("/workshop");
    expect(visible("salon", ["workshop"])).toContain("/workshop");
    expect(visible("workshop", [])).not.toContain("/workshop");
    expect(visible("general", [])).not.toContain("/workshop");
  });

  it("a module switched on beats the type gate for Vinkort too", () => {
    expect(visible("salon", ["wine_sommelier"])).toContain("/wine-list");
    expect(visible("salon", [])).not.toContain("/wine-list");
  });

  it("a tool in use beats the type gate (Madspild / Udløbsprognose)", () => {
    const keep = (type, used) => filterDestinations(
      NAV_MANIFEST.filter((d) => d.surfaces.includes("more") || d.surfaces.includes("sidebar")),
      { businessTypes: [type], archetypeId: archetypeIdFor(type), enabledModules: new Set(), hasFeature: () => true, usedSurfaces: new Set(used) },
    ).map((d) => d.to);
    expect(keep("salon", ["waste"])).toContain("/waste");
    expect(keep("salon", ["waste"])).not.toContain("/expiry");
    expect(keep("clothing", ["expiry"])).toContain("/expiry");
    expect(keep("jewelry", [])).not.toContain("/expiry");
  });

  it("Bar Pour and Vinkort show for a bar with the canonical module ids", () => {
    expect(visible("bar", ["bar_pour", "wine_sommelier"])).toEqual(expect.arrayContaining(["/bar", "/wine-list"]));
  });
});
