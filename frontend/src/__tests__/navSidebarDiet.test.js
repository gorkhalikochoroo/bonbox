/**
 * C12b — the archetype-aware SIDEBAR surface.
 *
 * Four rare rows (Faktura, Kunder, Lokationer, Funktioner) leave the sidebar
 * for food_service and bar owners and stay on More + ⌘K. Three things can go
 * wrong with a change like that, and none of them is visible to a build:
 *
 *   • it removes the row from MORE or SEARCH too, and the page becomes
 *     unreachable — a deletion wearing a declutter's clothes;
 *   • it leaks to an archetype it was never meant to touch (a retail owner
 *     losing Faktura would be a real regression — they invoice);
 *   • it takes a compliance row or one of the six jobs with it.
 *
 * So this file asserts the RESOLVED sidebar for a real DK restaurant owner and
 * for a retail owner, by route and in order, rather than asserting that a
 * config field has a particular value.
 */
import { describe, it, expect } from "vitest";
import {
  NAV_MANIFEST,
  NAV_GROUPS,
  filterDestinations,
  surfacesFor,
  isOnSurface,
  sidebarGroupsFor,
} from "../config/navManifest";

// The four rows C12b moves. Nothing else may change.
const MOVED = ["/faktura", "/customers", "/branches", "/modules"];

// Compliance + the six jobs — the rows the founder put out of scope. If a
// future diet touches one of these, this list is what fails.
const UNTOUCHABLE = [
  "/reports",           // Reports & MOMS
  "/tax",               // Skat
  "/bookkeeping-export", // Send til revisor
  "/dashboard", "/sales", "/expenses", "/daily-close",
  "/reservations", "/inventory", "/staff/schedule",
];

/**
 * The sidebar a real owner sees, flattened to routes in render order.
 *
 * Mirrors what Layout does: build the archetype's sidebar surface, then run
 * each group's items through filterDestinations with the ctx Layout threads.
 * Group-level visibleFor gating is applied too (that is Layout's own step, and
 * dropping it would credit a restaurant with the Workshop group).
 */
function sidebarRoutes({ businessType, archetypeId, usageDormant = new Set(["events"]) }) {
  const groups = sidebarGroupsFor(archetypeId);
  const ctx = {
    businessTypes: [businessType],
    enabledModules: new Set(),      // no vertical modules opted in
    hasFeature: () => false,        // Free plan — locked-but-visible stays visible
    featReady: true,
    hiddenPillars: new Set(),       // nothing toggled off
    archetypeId,
    usageDormant,
    isStaffMember: false,           // the OWNER
  };
  const out = [];
  for (const g of groups) {
    const groupVisible =
      !g.visibleFor || g.visibleFor.includes(businessType);
    if (!groupVisible) continue;
    for (const item of filterDestinations(g.items, ctx)) out.push(item.to);
  }
  return out;
}

describe("surfacesFor / isOnSurface — the resolver", () => {
  it("falls back to `surfaces` when the archetype has no override", () => {
    const faktura = NAV_MANIFEST.find((d) => d.to === "/faktura");
    expect(surfacesFor(faktura, "retail")).toEqual(faktura.surfaces);
    expect(isOnSurface(faktura, "sidebar", "retail")).toBe(true);
  });

  it("falls back to `surfaces` for a null / unknown archetype (fails OPEN)", () => {
    const faktura = NAV_MANIFEST.find((d) => d.to === "/faktura");
    expect(isOnSurface(faktura, "sidebar", null)).toBe(true);
    expect(isOnSurface(faktura, "sidebar", "not-an-archetype")).toBe(true);
  });

  it("REPLACES `surfaces` for an archetype that has an override", () => {
    const faktura = NAV_MANIFEST.find((d) => d.to === "/faktura");
    expect(surfacesFor(faktura, "food_service")).toEqual(["more", "search"]);
    expect(isOnSurface(faktura, "sidebar", "food_service")).toBe(false);
  });

  it("never throws on a malformed entry", () => {
    expect(surfacesFor(undefined, "food_service")).toEqual([]);
    expect(surfacesFor({}, "food_service")).toEqual([]);
    expect(surfacesFor({ surfaces: ["more"], surfacesByArchetype: { bar: "nope" } }, "bar"))
      .toEqual(["more"]);
  });
});

describe("C12b — nothing is deleted, only moved", () => {
  it.each(MOVED)("%s keeps More + ⌘K for food_service and bar", (route) => {
    const item = NAV_MANIFEST.find((d) => d.to === route);
    for (const arch of ["food_service", "bar"]) {
      expect(isOnSurface(item, "sidebar", arch)).toBe(false);
      // The whole point: the page is still one tap away, and ⌘K still finds it.
      expect(isOnSurface(item, "more", arch)).toBe(true);
      expect(isOnSurface(item, "search", arch)).toBe(true);
    }
  });

  it("leaves the MORE and SEARCH surfaces byte-identical for every archetype", () => {
    // Those surfaces narrow on `surfaces` alone today. If C12b ever changed
    // what they resolve to, the "nothing is deleted" claim would be false.
    const archetypes = [null, "food_service", "bar", "retail", "salon", "services"];
    for (const surface of ["more", "search", "bottomnav"]) {
      const base = NAV_MANIFEST.filter((d) => d.surfaces.includes(surface)).map((d) => d.to);
      for (const arch of archetypes) {
        const resolved = NAV_MANIFEST.filter((d) => isOnSurface(d, surface, arch)).map((d) => d.to);
        expect(resolved).toEqual(base);
      }
    }
  });

  it("only touches the four named rows", () => {
    const overridden = NAV_MANIFEST.filter((d) => d.surfacesByArchetype).map((d) => d.to);
    expect(overridden.sort()).toEqual([...MOVED].sort());
  });

  it("only touches food_service and bar", () => {
    for (const d of NAV_MANIFEST) {
      if (!d.surfacesByArchetype) continue;
      expect(Object.keys(d.surfacesByArchetype).sort()).toEqual(["bar", "food_service"]);
    }
  });
});

describe("the resolved sidebar — a real DK restaurant owner", () => {
  // business_type "restaurant" → archetype food_service (config/archetypes.js).
  const opts = { businessType: "restaurant", archetypeId: "food_service" };

  it("renders 20 rows, in order, with the four rare rows gone", () => {
    expect(sidebarRoutes(opts)).toEqual([
      // core spine (Events is usage-gated away for an owner with no Event row)
      "/dashboard",
      "/sales",
      "/expenses",
      "/daily-close",
      "/reservations",
      "/gavekort",
      // money — Faktura + Kunder moved to More
      "/cashbook",
      "/cashflow",
      "/imports",
      // staff
      "/staff/schedule",
      "/staff/hours",
      // stock
      "/inventory",
      "/expiry",
      "/waste",
      // reports & MOMS — every compliance row intact
      "/reports",
      "/daily-close/multi",
      "/tax",
      "/bookkeeping-export",
      "/insights",
      // settings — Lokationer + Funktioner moved to More
      "/subscription",
    ]);
  });

  it("is the founder's 24 → 20, and 25 → 21 for an owner who runs Events", () => {
    // 24 → 20 is the TYPICAL owner: the usage gate hides Events until a real
    // Event row exists, which is true of every production account but one.
    const before = sidebarRoutes({ ...opts, archetypeId: "__none__" });
    expect(before).toHaveLength(24);
    expect(sidebarRoutes(opts)).toHaveLength(20);

    // An owner who HAS created an Event carries one row more on both sides.
    // Pinned so the headline number can't quietly become the flattering one.
    const withEvents = sidebarRoutes({ ...opts, usageDormant: new Set() });
    expect(withEvents).toContain("/events");
    expect(withEvents).toHaveLength(21);
    expect(sidebarRoutes({ ...opts, archetypeId: "__none__", usageDormant: new Set() }))
      .toHaveLength(25);
  });

  it("dropped exactly the four rows and nothing else", () => {
    const before = new Set(sidebarRoutes({ ...opts, archetypeId: "__none__" }));
    const after = new Set(sidebarRoutes(opts));
    const removed = [...before].filter((r) => !after.has(r));
    expect(removed.sort()).toEqual([...MOVED].sort());
    expect([...after].filter((r) => !before.has(r))).toEqual([]); // nothing ADDED
  });

  it("keeps every compliance row and every one of the six jobs", () => {
    const rows = sidebarRoutes(opts);
    for (const route of UNTOUCHABLE) expect(rows).toContain(route);
  });
});

describe("the resolved sidebar — a retail owner is UNCHANGED", () => {
  const opts = { businessType: "retail", archetypeId: "retail" };

  it("still has all four rows", () => {
    const rows = sidebarRoutes(opts);
    for (const route of MOVED) expect(rows).toContain(route);
  });

  it("resolves to the same list the un-narrowed manifest would give", () => {
    // The strongest form of "unchanged": retail's sidebar is identical to what
    // an archetype-blind build produces.
    expect(sidebarRoutes(opts)).toEqual(sidebarRoutes({ ...opts, archetypeId: "__none__" }));
  });

  it("is still 24 rows (25 with Events) — the count the restaurant started at", () => {
    expect(sidebarRoutes(opts)).toHaveLength(24);
    expect(sidebarRoutes({ ...opts, usageDormant: new Set() })).toHaveLength(25);
  });
});

describe("the manifest still declares every group it renders", () => {
  it("every sidebar destination belongs to a real NAV_GROUPS group", () => {
    const ids = new Set(NAV_GROUPS.map((g) => g.id));
    for (const d of NAV_MANIFEST) {
      if (!d.surfaces.includes("sidebar")) continue;
      expect(ids.has(d.group)).toBe(true);
    }
  });
});
