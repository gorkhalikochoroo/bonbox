/**
 * The SIDEBAR surface: C12b's archetype diet + the SIX-JOBS promotion.
 *
 * C12b moved four rare rows (Faktura, Kunder, Lokationer, Funktioner) off the
 * sidebar for food_service and bar owners, keeping them on More + ⌘K.
 *
 * The six-jobs promotion (Sep 2026) then re-homed four rows so the top of the
 * rail IS the product: Vagtplan, Timer & løn and Lager joined the headerless
 * core spine, Gavekort moved down into MONEY, and /events left the sidebar for
 * every owner. No group was added, renamed or reordered; no group id changed.
 *
 * The failure modes a build cannot see, and that this file exists to catch:
 *
 *   • a re-homed row lands on a `group` id that no NAV_GROUPS entry declares —
 *     it then vanishes from the sidebar AND the More page, silently, green;
 *   • a row removed from one surface is removed from ALL of them, and the page
 *     becomes unreachable — a deletion wearing a declutter's clothes;
 *   • the diet leaks to an archetype it was never meant to touch;
 *   • it takes a compliance row or one of the six jobs with it;
 *   • a vertical that lacks one of the six is left with an empty group header.
 *
 * So this file asserts the RESOLVED sidebar — by route, in order, per
 * archetype — rather than asserting that a config field has a particular value.
 */
import { describe, it, expect } from "vitest";
import {
  NAV_MANIFEST,
  NAV_GROUPS,
  PILLAR_RELEVANCE_BY_ARCHETYPE,
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
  "/reservations",
  "/staff/schedule",    // job 3
  "/staff/hours",       // job 4 — pinned since the promotion re-homed it
  "/inventory",         // job 5
  "/gavekort",          // job 6's customer-facing row — moved, never dropped
];

// The gateable pillars the backend onboarding preset decides per archetype.
// A pillar that is NOT relevant for an archetype is preset-HIDDEN, which is
// what makes a job drop out honestly for a vertical that doesn't run it.
const GATEABLE = ["inventory", "reservations", "events", "staff"];
const presetHiddenFor = (archetypeId) => {
  const relevant = PILLAR_RELEVANCE_BY_ARCHETYPE[archetypeId] || GATEABLE;
  return new Set(GATEABLE.filter((p) => !relevant.includes(p)));
};

/**
 * The sidebar a real owner sees, as Layout resolves it.
 *
 * Mirrors Layout exactly: build the archetype's sidebar surface, apply the
 * group-level visibleFor gate, run each group's items through
 * filterDestinations, then DROP a group whose items all filtered out
 * (Layout.jsx `items.length > 0 ? {...g, items} : null`) — that last step is
 * what makes an empty group header structurally impossible, so it has to be
 * modelled here or the degradation tests would be vacuous.
 */
function sidebarGroups({
  businessType,
  archetypeId,
  hiddenPillars = new Set(),
  usageDormant = new Set(["events"]),
}) {
  const ctx = {
    businessTypes: [businessType],
    enabledModules: new Set(),      // no vertical modules opted in
    hasFeature: () => false,        // Free plan — locked-but-visible stays visible
    featReady: true,
    hiddenPillars,
    archetypeId,
    usageDormant,
    isStaffMember: false,           // the OWNER
  };
  return sidebarGroupsFor(archetypeId)
    .filter((g) => !g.visibleFor || g.visibleFor.includes(businessType))
    .map((g) => ({ id: g.id, labelKey: g.labelKey, items: filterDestinations(g.items, ctx).map((d) => d.to) }))
    .filter((g) => g.items.length > 0);
}

const sidebarRoutes = (opts) => sidebarGroups(opts).flatMap((g) => g.items);

/** The resolved rail for an owner of this archetype, preset pillars applied. */
const railFor = (businessType, archetypeId) =>
  sidebarGroups({ businessType, archetypeId, hiddenPillars: presetHiddenFor(archetypeId) });

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

describe("Events is off the rail — for EVERYONE, not just the unused cohort", () => {
  const events = () => NAV_MANIFEST.find((d) => d.to === "/events");

  it("declares no sidebar surface for any archetype", () => {
    for (const arch of [null, "food_service", "bar", "retail", "salon", "services", "personal"]) {
      expect(isOnSurface(events(), "sidebar", arch)).toBe(false);
    }
  });

  it("keeps More + ⌘K, so it is a subtraction and not a deletion", () => {
    expect(events().surfaces).toEqual(["more", "search"]);
    for (const arch of [null, "food_service", "retail", "salon", "services"]) {
      expect(isOnSurface(events(), "more", arch)).toBe(true);
      expect(isOnSurface(events(), "search", arch)).toBe(true);
    }
  });

  it("keeps the Danish aliases that are the way back in", () => {
    // ⌘K deliberately does not pass the usage gate, so these are the route
    // back for an owner who genuinely runs events. A Dane types "billetter".
    for (const alias of ["arrangement", "arrangementer", "billet", "billetter", "event", "events"]) {
      expect(events().aliases).toContain(alias);
    }
  });

  it("is gone from the rail even for the ONE owner who has Event rows", () => {
    // This is the founder's account: the usage gate correctly reports
    // used.events === true, so usageDormant is empty and the gate keeps the
    // row. `surfaces` is what has to remove it — and it does, for everyone.
    const withEventRows = sidebarRoutes({
      businessType: "restaurant",
      archetypeId: "food_service",
      usageDormant: new Set(),
    });
    expect(withEventRows).not.toContain("/events");
    // …and for an owner with no Event rows, who never saw it anyway.
    expect(sidebarRoutes({ businessType: "restaurant", archetypeId: "food_service" }))
      .not.toContain("/events");
  });

  it("no longer depends on the usage gate for its rail absence", () => {
    // The gate still governs More and the /modules list; it must simply no
    // longer be the thing standing between Events and the sidebar.
    const opts = { businessType: "retail", archetypeId: "retail" };
    expect(sidebarRoutes(opts)).toEqual(sidebarRoutes({ ...opts, usageDormant: new Set() }));
  });
});

describe("the resolved sidebar — a real DK restaurant owner", () => {
  // business_type "restaurant" → archetype food_service (config/archetypes.js).
  const opts = { businessType: "restaurant", archetypeId: "food_service" };

  it("renders 20 rows, in order, with the six jobs on the spine", () => {
    expect(sidebarRoutes(opts)).toEqual([
      // ── the spine: Home + Sales + Expenses, then jobs 1-5 in landing order.
      //    Everything below the hairline is the detail.
      "/dashboard",
      "/sales",         // job 6 starts here — money in
      "/expenses",      // job 6 — money out + kvittering-OCR
      "/daily-close",   // JOB 1
      "/reservations",  // JOB 2
      "/staff/schedule", // JOB 3  (promoted out of PERSONALE)
      "/staff/hours",   // JOB 4  (promoted out of PERSONALE)
      "/inventory",     // JOB 5  (promoted out of LAGER)
      // money — Gavekort demoted here; Faktura + Kunder are on More (C12b)
      "/gavekort",
      "/cashbook",
      "/cashflow",
      "/imports",
      // stock — the DETAIL rows keep the LAGER header
      "/expiry",
      "/waste",
      // reports & MOMS — every compliance row intact, in the same order
      "/reports",
      "/daily-close/multi",
      "/tax",
      "/bookkeeping-export",
      "/insights",
      // settings — Lokationer + Funktioner moved to More
      "/subscription",
    ]);
  });

  it("puts the eight spine rows in ONE headerless block", () => {
    const [first] = sidebarGroups(opts);
    expect(first.id).toBe("core");
    expect(first.labelKey).toBe(null); // headerless — and not collapsible
    expect(first.items).toHaveLength(8);
  });

  it("stops rendering the PERSONALE header once both its rows are promoted", () => {
    expect(sidebarGroups(opts).map((g) => g.id)).toEqual([
      "core", "money", "stock", "reports", "manage",
    ]);
  });

  it("is 20 rows whether or not this owner runs Events", () => {
    // Before the promotion this was 20 / 21 — the founder's own account
    // carried the extra row. It no longer can.
    expect(sidebarRoutes(opts)).toHaveLength(20);
    expect(sidebarRoutes({ ...opts, usageDormant: new Set() })).toHaveLength(20);
  });

  it("dropped exactly the four C12b rows and nothing else", () => {
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

  it("keeps the revisor path together, in RAPPORTER & MOMS, in order", () => {
    // The compliance trio is the sale. It did not move and did not get
    // re-homed into a longer group.
    const reports = sidebarGroups(opts).find((g) => g.id === "reports");
    expect(reports.items).toEqual([
      "/reports", "/daily-close/multi", "/tax", "/bookkeeping-export", "/insights",
    ]);
  });
});

describe("the resolved sidebar — a retail owner keeps their C12b rows", () => {
  const opts = { businessType: "retail", archetypeId: "retail" };

  it("still has all four rows", () => {
    const rows = sidebarRoutes(opts);
    for (const route of MOVED) expect(rows).toContain(route);
  });

  it("resolves to the same list the un-narrowed manifest would give", () => {
    // The strongest form of "C12b did not leak": retail's sidebar is identical
    // to what an archetype-blind build produces.
    expect(sidebarRoutes(opts)).toEqual(sidebarRoutes({ ...opts, archetypeId: "__none__" }));
  });

  it("is 24 rows — one fewer than before, and Events is the one", () => {
    expect(sidebarRoutes(opts)).toHaveLength(24);
    expect(sidebarRoutes({ ...opts, usageDormant: new Set() })).toHaveLength(24);
  });
});

describe("per-archetype degradation — a missing job leaves no empty shelf", () => {
  // Preset-hidden pillars applied, so these are the rails real owners of each
  // vertical resolve to. Asserted, not argued.
  const CASES = {
    food_service: { businessType: "restaurant", jobs: ["/daily-close", "/reservations", "/staff/schedule", "/staff/hours", "/inventory"] },
    retail:       { businessType: "retail",     jobs: ["/daily-close", "/staff/schedule", "/staff/hours", "/inventory"] },
    salon:        { businessType: "salon",      jobs: ["/daily-close", "/reservations", "/staff/schedule", "/staff/hours"] },
    services:     { businessType: "laundry",    jobs: ["/daily-close", "/staff/schedule", "/staff/hours"] },
  };

  it.each(Object.keys(CASES))("%s: no group renders with zero items", (arch) => {
    for (const g of railFor(CASES[arch].businessType, arch)) {
      expect(g.items.length).toBeGreaterThan(0);
    }
  });

  it.each(Object.keys(CASES))("%s: the spine carries exactly the jobs this vertical runs", (arch) => {
    const { businessType, jobs } = CASES[arch];
    const core = railFor(businessType, arch).find((g) => g.id === "core");
    expect(core.items).toEqual(["/dashboard", "/sales", "/expenses", ...jobs]);
  });

  it("salon drops Lager from the spine AND the LAGER header with it", () => {
    const ids = railFor("salon", "salon").map((g) => g.id);
    expect(ids).not.toContain("stock");           // no empty shelf
    expect(railFor("salon", "salon").flatMap((g) => g.items)).not.toContain("/inventory");
  });

  it("retail drops Reservationer from the spine and leaves nothing behind", () => {
    const rail = railFor("retail", "retail");
    expect(rail.flatMap((g) => g.items)).not.toContain("/reservations");
    // core has no header, so a missing job there can't orphan one.
    expect(rail.find((g) => g.id === "core").labelKey).toBe(null);
  });

  it.each(Object.keys(CASES))("%s: the compliance trio survives every degradation", (arch) => {
    const rows = railFor(CASES[arch].businessType, arch).flatMap((g) => g.items);
    for (const route of ["/reports", "/tax", "/bookkeeping-export"]) {
      expect(rows).toContain(route);
    }
  });

  it.each(Object.keys(CASES))("%s: Events is on no rail", (arch) => {
    expect(railFor(CASES[arch].businessType, arch).flatMap((g) => g.items)).not.toContain("/events");
  });
});

describe("the MORE page — the second surface these `group` edits reshuffle", () => {
  // MorePage projects the SAME NAV_GROUPS order over the 'more' slice and
  // drops a section whose items all filter out (MorePage.jsx). Re-homing four
  // rows therefore moves four tiles between sections — a real side effect, so
  // it gets asserted rather than assumed. (The rendered headers and their i18n
  // fallbacks still want a look at the running app; a test cannot see those.)
  const moreSections = ({ businessType, archetypeId, usageDormant = new Set(["events"]) }) => {
    const ctx = {
      businessTypes: [businessType],
      enabledModules: new Set(),
      hasFeature: () => false,
      featReady: true,
      hiddenPillars: new Set(),
      archetypeId,
      usageDormant,
      isStaffMember: false,
    };
    const moreItems = NAV_MANIFEST.filter((d) => isOnSurface(d, "more", archetypeId));
    return NAV_GROUPS
      .filter((g) => !g.visibleFor || g.visibleFor.includes(businessType))
      .map((g) => ({ id: g.id, items: filterDestinations(moreItems.filter((d) => d.group === g.id), ctx).map((d) => d.to) }))
      .filter((s) => s.items.length > 0);
  };
  const opts = { businessType: "restaurant", archetypeId: "food_service" };

  it("moves the three promoted tiles into the top (core) section", () => {
    const core = moreSections(opts).find((s) => s.id === "core");
    for (const to of ["/staff/schedule", "/staff/hours", "/inventory"]) {
      expect(core.items).toContain(to);
    }
    expect(core.items).not.toContain("/gavekort"); // demoted with the rail
  });

  it("drops the PERSONALE section here too — no orphan header", () => {
    // MorePage has no extras for the staff group, so an empty group really
    // does disappear rather than rendering a header over nothing.
    expect(moreSections(opts).map((s) => s.id)).not.toContain("staff");
    for (const s of moreSections(opts)) expect(s.items.length).toBeGreaterThan(0);
  });

  it("still holds Events for an owner who has Event rows — this is its home now", () => {
    const withRows = moreSections({ ...opts, usageDormant: new Set() });
    expect(withRows.flatMap((s) => s.items)).toContain("/events");
    // …and the usage gate still hides it from More for everyone else, which is
    // the one job the gate keeps after this change.
    expect(moreSections(opts).flatMap((s) => s.items)).not.toContain("/events");
  });
});

describe("the manifest still declares every group it renders", () => {
  it("EVERY destination belongs to a real NAV_GROUPS group", () => {
    // Not just the sidebar slice: a `group` id with no matching NAV_GROUPS
    // entry removes the row from the sidebar AND the More page, with no error
    // and a green build. The promotion re-homed four rows, so this is the
    // guard that makes a typo fail loudly instead of silently.
    const ids = new Set(NAV_GROUPS.map((g) => g.id));
    for (const d of NAV_MANIFEST) {
      expect(ids.has(d.group), `${d.to} → group "${d.group}"`).toBe(true);
    }
  });

  it("keeps exactly ONE headerless group", () => {
    // The core branch in Layout emits its own closing hairline; a second
    // headerless block would stack rules and read as the rail-of-borders
    // defect. It is also the only non-collapsible group — a labelKey here
    // would let an owner collapse the whole product away.
    expect(NAV_GROUPS.filter((g) => !g.labelKey).map((g) => g.id)).toEqual(["core"]);
  });
});
