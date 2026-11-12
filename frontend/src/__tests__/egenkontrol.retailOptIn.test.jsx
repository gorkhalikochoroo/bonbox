/**
 * Egenkontrol R1b — the one-tap opt-in for a grocery, a veggie shop or a
 * kiosk (offered, never pushed; never a vertical-module slot):
 *   • the nav: a grocery that has not switched it on → no Egenkontrol; once
 *     the server's used-surfaces signal says "egenkontrol" (opted in, or any
 *     check) → shown; a clothing shop without the signal → no; a salon even
 *     WITH the signal → still no; a restaurant → as before;
 *   • /egenkontrol for such a shop → "Egenkontrol for butikker med
 *     kølevarer" + "Slå egenkontrol til" → PUT /egenkontrol/settings
 *     {opted_in: true} → the start list;
 *   • /modules (Funktioner) → the same one tap, then a link to /egenkontrol;
 *     a café never sees that row.
 *
 * Run: cd frontend && TZ=UTC npx vitest run --maxWorkers=2 egenkontrol.retailOptIn
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

const h = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), refresh: vi.fn(), user: { id: "u1", role: "owner", business_type: "grocery" } }));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: vi.fn(), put: (...a) => h.put(...a), patch: vi.fn(), delete: vi.fn(),
    defaults: { baseURL: "http://test/api" },
  },
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
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.user, loading: false }) }));
vi.mock("../hooks/useToast", () => ({ useToast: () => vi.fn() }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => async () => true }));
vi.mock("../hooks/useDeviceShare", () => ({ useDeviceShare: () => ({ enabled: false, locked: false, reveal: async () => {} }) }));
vi.mock("../hooks/useMediaQuery", () => ({ useMediaQuery: () => false }));
vi.mock("../utils/download", () => ({ saveFile: vi.fn() }));
vi.mock("../hooks/usePillars", () => ({
  usePillars: () => ({ hiddenPillars: new Set(), isReady: true, setPillarHidden: vi.fn() }),
}));
vi.mock("../hooks/useActivation", () => ({
  useActivation: () => ({
    usageDormantPillars: new Set(), usageKnownDormant: new Set(), activatedPillars: undefined,
    isActivated: () => true, isInScope: false, activationEnabled: false, isReady: true, refresh: h.refresh, usedSurfaces: new Set(),
  }),
}));
vi.mock("../components/BranchSelector", () => ({ useBranch: () => ({ branchType: null, businessTypes: [] }) }));

const EgenkontrolPage = (await import("../pages/EgenkontrolPage")).default;
const ModulesPage = (await import("../pages/ModulesPage")).default;
const { NAV_MANIFEST, filterDestinations } = await import("../config/navManifest");
const { archetypeIdFor } = await import("../config/archetypes");
const { __resetEgenkontrolStatus } = await import("../components/egenkontrol/useEgenkontrolStatus");

const navFor = (type, used = []) =>
  filterDestinations(
    NAV_MANIFEST.filter((d) => d.surfaces.includes("sidebar") || d.surfaces.includes("more")),
    { businessTypes: [type], archetypeId: archetypeIdFor(type), enabledModules: new Set(), hasFeature: () => true, usedSurfaces: new Set(used) },
  ).map((d) => d.to);

let routes;
const settle = async (n = 8) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};

beforeEach(() => {
  h.get.mockReset();
  h.put.mockReset();
  h.refresh.mockReset();
  h.user = { id: "u1", role: "owner", business_type: "grocery" };
  routes = {
    "/egenkontrol/today": { business_date: "2026-11-12", cutoff_hour: 6, setup_done: false, checks: [], summary: {} },
    "/egenkontrol/checks": { checks: [], archived: [] },
    "/egenkontrol/templates": {
      cutoff_hour: 6,
      templates: [{ key: "fridge", kind: "temp_max", limit: { limit_c: 5, direction: "max", source: "law" }, schedule_default: { type: "daily", due: "08:00" } }],
    },
    "/egenkontrol/staff": { staff: [] },
    "/egenkontrol/settings": { findsmiley_url: null, opted_in: false, opt_in_offered: true },
    "/modules": { plan: "free", modules_cap: 1, modules: [] },
  };
  h.get.mockImplementation((url) => (url in routes ? Promise.resolve({ data: routes[url] }) : Promise.reject({ response: { status: 404 } })));
  __resetEgenkontrolStatus();
});

describe("the nav follows the server's signal", () => {
  it("grocery: hidden until it is switched on (or has a check)", () => {
    expect(navFor("grocery")).not.toContain("/egenkontrol");
    expect(navFor("grocery", ["egenkontrol"])).toContain("/egenkontrol");
    expect(navFor("veggie_shop", ["egenkontrol"])).toContain("/egenkontrol");
    expect(navFor("kiosk", ["egenkontrol"])).toContain("/egenkontrol");
  });
  it("a clothing shop without the signal: no; a salon even with it: no; a restaurant: as before", () => {
    expect(navFor("clothing")).not.toContain("/egenkontrol");
    expect(navFor("salon", ["egenkontrol"])).not.toContain("/egenkontrol");
    expect(navFor("restaurant")).toContain("/egenkontrol");
    expect(navFor("cafe")).toContain("/egenkontrol");
  });
});

describe("/egenkontrol for a shop that has not switched it on", () => {
  it("the card → one tap → PUT {opted_in: true} → the start list", async () => {
    h.put.mockResolvedValue({ data: { findsmiley_url: null, opted_in: true, opt_in_offered: false } });
    render(<MemoryRouter initialEntries={["/egenkontrol"]}><EgenkontrolPage /></MemoryRouter>);
    await settle();
    const card = screen.getByTestId("ek-optin-card");
    expect(card).toHaveTextContent(da.ekOptInTitle);
    expect(card).toHaveTextContent(da.ekOptInBody);
    expect(screen.queryByTestId("ek-setup")).toBeNull();
    await act(async () => { fireEvent.click(screen.getByTestId("ek-optin")); });
    await settle(2);
    expect(h.put).toHaveBeenCalledWith("/egenkontrol/settings", { opted_in: true });
    expect(h.refresh).toHaveBeenCalled();
    expect(screen.queryByTestId("ek-optin-card")).toBeNull();
    expect(screen.getByTestId("ek-setup")).toBeInTheDocument();
  });

  it("a café never gets the card (the server does not offer it)", async () => {
    h.user = { id: "u1", role: "owner", business_type: "cafe" };
    routes["/egenkontrol/settings"] = { findsmiley_url: null, opted_in: false, opt_in_offered: false };
    render(<MemoryRouter initialEntries={["/egenkontrol"]}><EgenkontrolPage /></MemoryRouter>);
    await settle();
    expect(screen.queryByTestId("ek-optin-card")).toBeNull();
    expect(screen.getByTestId("ek-setup")).toBeInTheDocument();
  });
});

describe("/modules → Funktioner", () => {
  it("a grocery: 'Slå egenkontrol til' → PUT → refresh → a link to /egenkontrol", async () => {
    h.put.mockResolvedValue({ data: { opted_in: true } });
    render(<MemoryRouter><ModulesPage /></MemoryRouter>);
    await settle();
    const row = screen.getByTestId("ek-modules-optin");
    expect(row).toHaveTextContent(da.navEgenkontrol);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.ekOptInButton })); });
    await settle(2);
    expect(h.put).toHaveBeenCalledWith("/egenkontrol/settings", { opted_in: true });
    expect(h.refresh).toHaveBeenCalled();
    expect(screen.getByTestId("ek-modules-optin")).toHaveTextContent(da.ekOptInDone);
    expect(screen.getByRole("link", { name: da.nyqEkAction })).toHaveAttribute("href", "/egenkontrol");
  });

  it("a café: no row, and /egenkontrol/settings is not even asked", async () => {
    h.user = { id: "u1", role: "owner", business_type: "cafe" };
    render(<MemoryRouter><ModulesPage /></MemoryRouter>);
    await settle();
    expect(screen.queryByTestId("ek-modules-optin")).toBeNull();
    expect(h.get.mock.calls.map((c) => c[0])).not.toContain("/egenkontrol/settings");
  });

  it("a grocery already switched on: no row", async () => {
    routes["/egenkontrol/settings"] = { opted_in: true, opt_in_offered: false };
    render(<MemoryRouter><ModulesPage /></MemoryRouter>);
    await settle();
    expect(screen.queryByTestId("ek-modules-optin")).toBeNull();
  });
});
