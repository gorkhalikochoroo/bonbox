/**
 * The I dag rail (Nov 2026) — nothing that worked yesterday may disappear
 * from navigation.
 *
 *   1. Every row the previous sidebar showed (sidebarGroupsFor — kept, and
 *      still the revert path) is on the new rail or in the account menu, for
 *      every archetype.
 *   2. Every manifest destination with any surface is still reachable from at
 *      least one place (rail, account menu, More, ⌘K).
 *   3. The canvas order: I dag · Reservationer · Vagtplan · Kasserapport ·
 *      Timer & løn, then Administration: Salg · Udgifter · Lager ·
 *      (Egenkontrol, a kitchen's daily check — food service + bar, retail
 *      once switched on) · Rapporter · Skat Autopilot.
 *   4. The phone tab bar: five slots, all real destinations, never a tab for a
 *      switched-off pillar, and Salg still reachable on a phone.
 */
import { describe, it, expect } from "vitest";
import {
  NAV_MANIFEST, sidebarGroupsFor, railSectionsFor, accountMenuDestinations, isOnSurface, railOf,
  filterDestinations,
} from "../config/navManifest";
import { archetypeIdFor } from "../config/archetypes";
import { da } from "../i18n/da";
import { getTabsForType } from "../config/bottomNavTabs";

const ARCHETYPES = [null, "food_service", "bar", "salon", "retail", "services", "generic"];
const TYPE_FOR = { food_service: "restaurant", bar: "bar", salon: "salon", retail: "clothing", services: "workshop", generic: "general" };

const railRoutes = (a) => new Set(railSectionsFor(a).flatMap((s) => s.items.map((i) => i.to)));
const accountRoutes = new Set(accountMenuDestinations().map((d) => d.to));

describe("every old sidebar row is still in the new rail or the account menu", () => {
  for (const a of ARCHETYPES) {
    it(`archetype ${a ?? "(none)"}`, () => {
      const before = sidebarGroupsFor(a).flatMap((g) => g.items.map((i) => i.to));
      expect(before.length).toBeGreaterThan(10);
      const rail = railRoutes(a);
      const lost = before.filter((to) => !rail.has(to) && !accountRoutes.has(to));
      expect(lost).toEqual([]);
    });
  }
});

describe("the ~20 rows the owner knows today all have a home", () => {
  // Forsiden, Salg, Udgifter, Kasserapport, Reservationer, Lager, Vagtplan,
  // Gavekort, Kassebog, Pengestrøm, Import, Rapporter, Flere terminaler,
  // Skat Autopilot (+ Timer & løn, Send til revisor, Indsigt, Abonnement).
  const KNOWN = [
    "/dashboard", "/sales", "/expenses", "/daily-close", "/reservations", "/inventory",
    "/staff/schedule", "/staff/hours", "/gavekort", "/cashbook", "/cashflow", "/imports",
    "/reports", "/daily-close/multi", "/tax", "/bookkeeping-export", "/insights", "/subscription",
  ];
  it("each is a manifest destination with the same path, on the rail or in the account menu", () => {
    const rail = railRoutes("food_service");
    for (const to of KNOWN) {
      expect(NAV_MANIFEST.some((d) => d.to === to), to).toBe(true);
      expect(rail.has(to) || accountRoutes.has(to), to).toBe(true);
    }
  });

  it("the previous Home is kept, whole, at /home — on the rail, More and ⌘K", () => {
    const o = NAV_MANIFEST.find((d) => d.to === "/home");
    expect(o).toBeTruthy();
    for (const s of ["sidebar", "more", "search"]) expect(isOnSurface(o, s)).toBe(true);
    expect(railOf(o)).toBe("more");
  });

  it("desktop gets a door to the More sheet's rare rows (/more on the rail)", () => {
    expect(railRoutes("food_service").has("/more")).toBe(true);
  });
});

describe("no destination becomes unreachable", () => {
  it("every manifest row with a surface is on the rail, in the account menu, on More or in ⌘K", () => {
    for (const a of ARCHETYPES) {
      const rail = railRoutes(a);
      for (const d of NAV_MANIFEST) {
        if (!(d.surfaces || []).length) continue; // switched off on purpose (Khata)
        const reach = rail.has(d.to) || accountRoutes.has(d.to)
          || isOnSurface(d, "more", a) || isOnSurface(d, "search", a);
        expect(reach, `${d.to} for ${a}`).toBe(true);
      }
    }
  });
});

describe("the canvas order", () => {
  it("I dag section, then Administration", () => {
    const secs = railSectionsFor("food_service");
    const byId = Object.fromEntries(secs.map((s) => [s.id, s.items.map((i) => i.to)]));
    expect(byId.today).toEqual(["/dashboard", "/reservations", "/staff/schedule", "/daily-close", "/staff/hours"]);
    expect(byId.admin).toEqual(["/sales", "/expenses", "/inventory", "/egenkontrol", "/reports", "/tax"]);
    expect(secs.map((s) => s.id)).toEqual(["today", "admin", "workshop", "more"]);
    const admin = secs.find((s) => s.id === "admin");
    expect(admin.collapsible).toBe(false);
    expect(secs.find((s) => s.id === "more").defaultOpen).toBe(false);
  });

  it("a salon's book keeps its own word", () => {
    const salonToday = railSectionsFor("salon").find((s) => s.id === "today").items;
    expect(salonToday.find((i) => i.to === "/reservations").labelKeyByArchetype.salon).toBe("navAppointments");
  });
});

describe("Egenkontrol on the I dag rail (Nov 2026 merge)", () => {
  // The rail an owner of this business type actually sees, per section: the
  // projection, then the same four visibility axes Layout applies.
  const railFor = (type, used = []) => {
    const archetypeId = archetypeIdFor(type);
    return Object.fromEntries(railSectionsFor(archetypeId).map((s) => [s.id, filterDestinations(s.items, {
      businessTypes: [type], archetypeId, enabledModules: new Set(), hasFeature: () => true,
      usedSurfaces: new Set(used),
    }).map((i) => i.to)]));
  };

  it("has an explicit place — Administration, right after Lager — not the 'more' default", () => {
    expect(RAIL_PLACE()).toBe("admin");
    const admin = railFor("restaurant").admin;
    expect(admin.indexOf("/egenkontrol")).toBe(admin.indexOf("/inventory") + 1);
  });

  it("food service and bar see it; retail only once switched on; a salon never", () => {
    for (const type of ["restaurant", "cafe", "bakery", "bar"]) {
      expect(railFor(type).admin, type).toContain("/egenkontrol");
    }
    expect(railFor("grocery").admin).not.toContain("/egenkontrol");
    expect(railFor("grocery", ["egenkontrol"]).admin).toContain("/egenkontrol");
    expect(railFor("clothing").admin).not.toContain("/egenkontrol");
    expect(railFor("salon", ["egenkontrol"]).admin || []).not.toContain("/egenkontrol");
    // It is never on the daily-jobs spine, whatever the archetype.
    for (const a of ARCHETYPES) {
      expect(railSectionsFor(a).find((s) => s.id === "today").items.map((i) => i.to)).not.toContain("/egenkontrol");
    }
  });

  it("is never called 'I dag' — the owner app has one I dag (the Today page)", () => {
    const ek = NAV_MANIFEST.find((d) => d.to === "/egenkontrol");
    expect(ek.labelKey).toBe("navEgenkontrol");
    expect(da.navEgenkontrol).not.toMatch(/^\s*i dag\s*$/i);
    const iDag = NAV_MANIFEST.filter((d) => /^\s*i dag\s*$/i.test(da[d.labelKey] || ""));
    expect(iDag.map((d) => d.to)).toEqual(["/dashboard"]);
  });

  const RAIL_PLACE = () => railOf(NAV_MANIFEST.find((d) => d.to === "/egenkontrol"));
});

describe("the phone tab bar", () => {
  const routes = (tabs) => tabs.map((t) => t.to);

  for (const [a, type] of Object.entries(TYPE_FOR)) {
    it(`${a}: five real tabs, I dag first, Kasserapport and Mere last`, () => {
      const tabs = getTabsForType(type, new Set(), null);
      expect(tabs).toHaveLength(5);
      expect(tabs[0].to).toBe("/dashboard");
      expect(tabs[3].to).toBe("/daily-close");
      expect(tabs[4].to).toBe("/more");
      for (const t of tabs.slice(0, 4)) expect(NAV_MANIFEST.some((d) => d.to === t.to), t.to).toBe(true);
      expect(tabs.some((t) => t.isCenter)).toBe(false);
    });
  }

  it("a restaurant: Reservationer and Vagtplan", () => {
    expect(routes(getTabsForType("restaurant", new Set(), null))).toEqual(
      ["/dashboard", "/reservations", "/staff/schedule", "/daily-close", "/more"]);
  });

  it("never a tab for a switched-off pillar", () => {
    const off = routes(getTabsForType("restaurant", new Set(["reservations", "staff"]), null));
    expect(off).not.toContain("/reservations");
    expect(off).not.toContain("/staff/schedule");
    expect(new Set(off).size).toBe(5);
  });

  it("slot 3 never offers an irrelevant or switched-off Lager", () => {
    // A services business (repair shop) with staff off: Salg in slot 2, and
    // Lager is not relevant to its type.
    const free = routes(getTabsForType("mobile_repair", new Set(["staff"]), { usedPillars: new Set(), usedSurfaces: new Set() }));
    expect(free).not.toContain("/inventory");
    expect(free[2]).toBe("/expenses");
    // A shop that switched Lager off (and has no staff) never gets it back here.
    const shopOff = routes(getTabsForType("clothing", new Set(["inventory", "staff"]), { usedPillars: new Set(), usedSurfaces: new Set() }));
    expect(shopOff).not.toContain("/inventory");
    expect(shopOff[2]).toBe("/expenses");
    // A shop with Lager on but unused (slot 2 = Salg), staff off → Lager in slot 3.
    const shopOn = routes(getTabsForType("clothing", new Set(["staff"]), { usedPillars: new Set(), usedSurfaces: new Set() }));
    expect(shopOn.slice(1, 3)).toEqual(["/sales", "/inventory"]);
  });

  it("a shop without a book leads with Lager once it is in use, else Salg", () => {
    const inUse = { usedPillars: new Set(["inventory"]), usedSurfaces: new Set(), enabledModules: null };
    expect(getTabsForType("clothing", new Set(), inUse)[1].to).toBe("/inventory");
    expect(getTabsForType("clothing", new Set(), { usedPillars: new Set(), usedSurfaces: new Set() })[1].to).toBe("/sales");
  });

  it("Salg stays one tap away on a phone (More lists it)", () => {
    const sales = NAV_MANIFEST.find((d) => d.to === "/sales");
    expect(isOnSurface(sales, "more")).toBe(true);
  });
});
