/**
 * filterDestinations — the USAGE GATE (5th filter, Sep 2026).
 *
 * The gate hides a pillar the owner has never used (today: Events) from the
 * nav chrome. Four things must hold, and each is a separate failure mode:
 *
 *   1. It HIDES the gated pillar's destination when ctx.usageDormant carries it.
 *   2. It is INERT without the field (⌘K passes no usageDormant on purpose, so
 *      Events stays findable by search for everyone) and with an empty Set.
 *   3. It touches ONLY the named pillar — a bug here would quietly delete
 *      Reservations or Inventory from every sidebar.
 *   4. It drops a TIER-LOCKED entry too. This is the one place the usage gate
 *      diverges from the activation axis: an activation-dormant item survives
 *      as a locked upgrade funnel, but a feature we are not selling must not
 *      become one.
 */
import { describe, it, expect } from "vitest";
import {
  NAV_MANIFEST,
  USAGE_GATED_PILLARS,
  USAGE_GATE_EXEMPT_TYPES,
  filterDestinations,
} from "../config/navManifest";

const EVENTS_DORMANT = new Set(["events"]);

/** The manifest slice a surface would pass in (sidebar-shaped), plus the
 *  minimum ctx every other axis needs to be a no-op. */
const sidebarItems = () =>
  NAV_MANIFEST.filter((d) => d.surfaces.includes("sidebar"));

const baseCtx = (extra = {}) => ({
  businessTypes: ["restaurant"],
  enabledModules: new Set(),
  hasFeature: () => true,
  featReady: true,
  archetypeId: "food_service",
  ...extra,
});

const paths = (items) => items.map((d) => d.to);

describe("filterDestinations — usage gate", () => {
  it("drops /events when usageDormant contains 'events'", () => {
    const kept = filterDestinations(sidebarItems(), baseCtx({ usageDormant: EVENTS_DORMANT }));
    expect(paths(kept)).not.toContain("/events");
  });

  it("keeps /events when usageDormant is absent (the ⌘K contract)", () => {
    const kept = filterDestinations(sidebarItems(), baseCtx());
    expect(paths(kept)).toContain("/events");
  });

  it("keeps /events when usageDormant is an empty Set", () => {
    const kept = filterDestinations(sidebarItems(), baseCtx({ usageDormant: new Set() }));
    expect(paths(kept)).toContain("/events");
  });

  it("ignores a non-Set usageDormant instead of throwing", () => {
    // Defensive: a consumer threading `undefined`/an array must degrade to
    // "hide nothing", never crash the sidebar.
    const kept = filterDestinations(sidebarItems(), baseCtx({ usageDormant: ["events"] }));
    expect(paths(kept)).toContain("/events");
  });

  it("touches ONLY the gated pillar — every other destination survives", () => {
    const before = paths(filterDestinations(sidebarItems(), baseCtx()));
    const after = paths(filterDestinations(sidebarItems(), baseCtx({ usageDormant: EVENTS_DORMANT })));
    expect(after).toEqual(before.filter((p) => p !== "/events"));
    // Named explicitly so a regression reads as itself in the failure output.
    expect(after).toContain("/reservations");
    expect(after).toContain("/inventory");
    expect(after).toContain("/staff/schedule");
    expect(after).toContain("/dashboard");
  });

  it("drops a TIER-LOCKED item too (no upgrade funnel for a gated pillar)", () => {
    const locked = [
      { to: "/events", pillar: "events", requiresFeature: "premium_events", surfaces: ["sidebar"] },
      { to: "/daily-close/multi", pillar: null, requiresFeature: "multi_terminal_close", surfaces: ["sidebar"] },
    ];
    const kept = filterDestinations(
      locked,
      baseCtx({ hasFeature: () => false, usageDormant: EVENTS_DORMANT }),
    );
    expect(paths(kept)).not.toContain("/events");
    // The control: a locked SPINE entry is still kept-but-locked, so this test
    // can't pass merely because everything was dropped.
    expect(kept).toHaveLength(1);
    expect(kept[0].to).toBe("/daily-close/multi");
    expect(kept[0].locked).toBe(true);
  });

  it("keeps the locked gated item when the gate is inert", () => {
    const locked = [
      { to: "/events", pillar: "events", requiresFeature: "premium_events", surfaces: ["sidebar"] },
    ];
    const kept = filterDestinations(locked, baseCtx({ hasFeature: () => false }));
    expect(kept).toHaveLength(1);
    expect(kept[0].locked).toBe(true);
  });
});

describe("usage-gate constants", () => {
  it("gates exactly the events pillar for now", () => {
    expect(USAGE_GATED_PILLARS).toEqual(["events"]);
  });

  it("exempts the event-organizer business type (the real stored token)", () => {
    // The token is what users.business_type actually stores — see
    // config/archetypes.js BUSINESS_TYPE_TO_ARCHETYPE and the backend
    // routers/onboarding.py free-text mapping.
    expect(USAGE_GATE_EXEMPT_TYPES).toContain("event_organizer");
  });

  it("keeps Events reachable in ⌘K by its Danish names", () => {
    const events = NAV_MANIFEST.find((d) => d.to === "/events");
    expect(events.surfaces).toContain("search");
    // ⌘K is the ONLY way back in for a gated owner, so the DA plural matters.
    for (const alias of ["arrangement", "arrangementer", "billet", "billetter", "event", "events"]) {
      expect(events.aliases).toContain(alias);
    }
  });
});
