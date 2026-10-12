/**
 * Vertical fit (12 Oct 2026) — words and catalogues that follow the business.
 *
 *   • Vagtplan's role presets: a tøjbutik and a cykelværksted were offered
 *     Kok / Bartender / Tjener / Runner / Opvasker.
 *   • /modules listed Bar Pour, Wine & Sommelier and Workshop to every type, in
 *     English inside the Danish UI.
 *   • The daily close's "I dag indtil nu" said GÆSTER to a salon, a shop and a
 *     workshop.
 *   • The bar's suggested modules matched no gate.
 *   • The restaurant sample data was offered to every type.
 */
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), user: null }));
vi.mock("../services/api", () => ({ default: { get: (...a) => h.get(...a), put: vi.fn(), post: vi.fn() } }));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  return {
    useLanguage: () => ({
      lang: "da",
      t: (k, fb, vars) => {
        const v = typeof fb === "object" && fb ? fb : vars;
        let s = DA[k] ?? (typeof fb === "string" ? fb : k);
        if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
        return s;
      },
    }),
  };
});
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../hooks/usePillars", () => ({ usePillars: () => ({ hiddenPillars: new Set(), isReady: true, setPillarHidden: vi.fn() }) }));
vi.mock("../hooks/useActivation", () => ({ useActivation: () => ({ usageKnownDormant: new Set() }) }));

const { rolesFor, ROLES_RESTAURANT, ROLES_SALON } = await import("../config/staffRoles");
const ModulesPage = (await import("../pages/ModulesPage")).default;
const { ARCHETYPES, restaurantSampleFits } = await import("../config/archetypes");
const { MODULE_COPY } = await import("../config/verticalModules");
const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");

const settle = async () => { for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const modules = (enabled = []) => ({
  data: {
    plan: "pro", modules_cap: -1, enabled_count: enabled.length,
    modules: [
      { id: "bar_pour", name: "Bar Pour", description: "Pour-cost tracking…", enabled: enabled.includes("bar_pour") },
      { id: "wine_sommelier", name: "Wine & Sommelier", description: "Wine list…", enabled: enabled.includes("wine_sommelier") },
      { id: "workshop", name: "Workshop", description: "Job tickets…", enabled: enabled.includes("workshop") },
    ],
  },
});

beforeEach(() => { h.get.mockReset(); });
afterEach(() => cleanup());

describe("Vagtplan role presets", () => {
  it("a shop gets shop roles — every retail sibling", () => {
    for (const t of ["clothing", "kiosk", "flower_shop", "retail"]) {
      expect(rolesFor(t)).toEqual(["Butiksassistent", "Kasse", "Lager", "Butikschef"]);
    }
  });
  it("a workshop gets workshop roles", () => {
    expect(rolesFor("workshop")).toEqual(["Mekaniker", "Lærling", "Værkfører", "Kundeservice"]);
  });
  it("a salon and a restaurant keep theirs", () => {
    expect(rolesFor("salon")).toBe(ROLES_SALON);
    expect(rolesFor("cafe")).toBe(ROLES_RESTAURANT);
    expect(rolesFor(null)).toBe(ROLES_RESTAURANT);
  });
});

describe("/modules — in the owner's language, what fits first", () => {
  it("a salon: no module is pushed at it; all three fold under 'Andre brancher', in Danish", async () => {
    h.user = { id: "u1", business_type: "salon" };
    h.get.mockResolvedValue(modules());
    render(<MemoryRouter><ModulesPage /></MemoryRouter>);
    await settle();
    const mine = screen.getByTestId("modules-mine");
    expect(within(mine).queryAllByRole("button")).toHaveLength(0);
    const other = screen.getByTestId("modules-other-trades");
    expect(within(other).getByText("Andre brancher (3)")).toBeInTheDocument();
    expect(within(other).getByText("Bar & skænk")).toBeInTheDocument();
    expect(within(other).getByText("Vinkort")).toBeInTheDocument();
    expect(screen.queryByText("Pour-cost tracking…")).toBeNull();
  });

  it("a bar: Bar & skænk + Vinkort first, Værksted folded", async () => {
    h.user = { id: "u1", business_type: "bar" };
    h.get.mockResolvedValue(modules());
    render(<MemoryRouter><ModulesPage /></MemoryRouter>);
    await settle();
    const mine = screen.getByTestId("modules-mine");
    expect(within(mine).getByText("Bar & skænk")).toBeInTheDocument();
    expect(within(mine).getByText("Vinkort")).toBeInTheDocument();
    expect(within(screen.getByTestId("modules-other-trades")).getByText("Værksted")).toBeInTheDocument();
  });

  it("a module that is switched on is never folded away", async () => {
    h.user = { id: "u1", business_type: "salon" };
    h.get.mockResolvedValue(modules(["workshop"]));
    render(<MemoryRouter><ModulesPage /></MemoryRouter>);
    await settle();
    expect(within(screen.getByTestId("modules-mine")).getByText("Værksted")).toBeInTheDocument();
  });

  it("a salon's Funktioner list names the booking pillar Tidsbestilling", async () => {
    h.user = { id: "u1", business_type: "salon" };
    h.get.mockResolvedValue(modules());
    render(<MemoryRouter><ModulesPage /></MemoryRouter>);
    await settle();
    expect(screen.getByRole("switch", { name: /^Tidsbestilling/ })).toBeInTheDocument();
  });

  it("every module has real en + da copy", () => {
    for (const m of Object.values(MODULE_COPY)) {
      for (const k of [m.nameKey, m.descKey]) {
        expect(typeof en[k]).toBe("string");
        expect(typeof da[k]).toBe("string");
      }
    }
  });
});

describe("archetype twins", () => {
  it("the bar suggests the canonical module ids the nav gates on (twin of archetype.py)", () => {
    expect(ARCHETYPES.bar.suggestedModules).toEqual(expect.arrayContaining(["bar_pour", "wine_sommelier"]));
    expect(ARCHETYPES.bar.suggestedModules).not.toContain("pour");
    expect(ARCHETYPES.bar.suggestedModules).not.toContain("wine");
  });

  it("the restaurant sample data is offered only where it fits", () => {
    for (const t of ["restaurant", "cafe", "bakery", "bar", "general", null]) expect(restaurantSampleFits(t)).toBe(true);
    for (const t of ["salon", "clothing", "workshop", "personal"]) expect(restaurantSampleFits(t)).toBe(false);
  });
});

describe("Kasserapport — 'I dag indtil nu'", () => {
  const renderKpis = async (type) => {
    const LiveKpisToday = (await import("../components/LiveKpisToday")).default;
    h.user = { id: "u1", business_type: type };
    h.get.mockImplementation((url) => (
      url === "/business"
        ? Promise.resolve({ data: { day_cutoff_hour: 0 } })
        : Promise.resolve({ data: { totals: { total_revenue: 0 }, orders: 0, guests: 0 } })
    ));
    render(<LiveKpisToday />);
    await settle();
  };

  it("a salon, a shop and a workshop count customers", async () => {
    for (const type of ["salon", "clothing", "workshop"]) {
      await renderKpis(type);
      expect(screen.getByText("Kunder")).toBeInTheDocument();
      expect(screen.queryByText(da.liveGuestsToday)).toBeNull();
      cleanup();
    }
  });

  it("a café and a bar count guests", async () => {
    for (const type of ["cafe", "bar"]) {
      await renderKpis(type);
      expect(screen.getByText(da.liveGuestsToday)).toBeInTheDocument();
      cleanup();
    }
  });
});

describe("one business-type catalogue", () => {
  it("every pickable type resolves to an archetype, and every mapped type can be picked", async () => {
    const { BUSINESS_TYPE_VALUES, BUSINESS_TYPE_GROUPS } = await import("../config/businessTypes");
    const { BUSINESS_TYPE_TO_ARCHETYPE } = await import("../config/archetypes");
    expect(new Set(BUSINESS_TYPE_VALUES)).toEqual(new Set(Object.keys(BUSINESS_TYPE_TO_ARCHETYPE)));
    for (const g of BUSINESS_TYPE_GROUPS) {
      expect(typeof da[g.labelKey]).toBe("string");
      expect(typeof en[g.labelKey]).toBe("string");
      for (const x of g.types) {
        expect(typeof da[x.labelKey]).toBe("string");
        expect(typeof en[x.labelKey]).toBe("string");
      }
    }
  });
});
