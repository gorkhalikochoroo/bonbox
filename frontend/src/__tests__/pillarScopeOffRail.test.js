/**
 * PILLAR-level scope axis — the two surfaces that PROMISE the rail.
 *
 * Taking "sidebar" off /events subtracted the row, but two surfaces resolve
 * PILLARS rather than destinations and both make a promise about the nav in
 * the owner's own words:
 *
 *   • PillarDiscovery ("Slå til · Arrangementer") — one tap re-enables the
 *     pillar and its copy promises the nav entry comes back. After the
 *     subtraction it comes back nowhere: /events is on ["more","search"], and
 *     on desktop /more has no link outside the md:hidden bottom bar.
 *   • the activation graduation toast ("{feature} er nu i din menu") — fires
 *     for any gateable pillar that gets its first usage row, and `events` is
 *     gateable.
 *
 * The USAGE GATE cannot catch either one, and that is the whole point: the
 * single production account with Event rows is exactly the account the usage
 * gate lets through (`used.events === true` ⇒ events leaves
 * usageDormantPillars). So the one owner who asked twice for Events to be
 * hidden is the one owner who could toggle it off in Funktioner and be handed
 * "Slå til · Arrangementer" back in his sidebar footer.
 *
 * pillarIsScopedOffTheRail is the shared answer, and it must keep the
 * ONE-WORD REVERT property: re-adding "sidebar" to the /events entry lifts the
 * rail subtraction AND both exclusions, with no second edit anywhere.
 */
import { describe, it, expect } from "vitest";
import {
  NAV_MANIFEST,
  PILLAR_IDS,
  USAGE_GATED_PILLARS,
  isOnSurface,
  pillarIsScopedOffTheRail,
} from "../config/navManifest";

const ARCHETYPES = [null, "food_service", "retail", "services"];

describe("pillarIsScopedOffTheRail — what the pillar surfaces must refuse", () => {
  it("refuses events for every archetype (no destination of its own on any rail)", () => {
    // The premise, pinned: events owns exactly one destination and that
    // destination is off the sidebar.
    const owned = NAV_MANIFEST.filter((d) => d.pillar === "events");
    expect(owned.length).toBeGreaterThan(0);
    expect(USAGE_GATED_PILLARS).toContain("events");
    for (const arch of ARCHETYPES) {
      expect(owned.some((d) => isOnSurface(d, "sidebar", arch)), String(arch)).toBe(false);
      expect(pillarIsScopedOffTheRail("events", arch), String(arch)).toBe(true);
    }
  });

  it("allows every other pillar — this axis is scope, never decluttering", () => {
    for (const pid of PILLAR_IDS.filter((p) => p !== "events")) {
      for (const arch of ARCHETYPES) {
        expect(pillarIsScopedOffTheRail(pid, arch), `${pid}/${arch}`).toBe(false);
      }
    }
  });

  it("is vacuous-truth safe: a pillar with no destination is NOT scoped off", () => {
    expect(NAV_MANIFEST.some((d) => d.pillar === "not_a_pillar")).toBe(false);
    expect(pillarIsScopedOffTheRail("not_a_pillar", "food_service")).toBe(false);
    expect(pillarIsScopedOffTheRail(null, "food_service")).toBe(false);
    expect(pillarIsScopedOffTheRail(undefined)).toBe(false);
  });

  it("keeps the one-word revert: re-adding 'sidebar' to /events lifts it", () => {
    const entry = NAV_MANIFEST.find((d) => d.to === "/events");
    const original = entry.surfaces;
    try {
      entry.surfaces = [...original, "sidebar"];
      for (const arch of ARCHETYPES) {
        expect(pillarIsScopedOffTheRail("events", arch), String(arch)).toBe(false);
      }
    } finally {
      entry.surfaces = original;
    }
    // and the module is left exactly as it was found
    expect(NAV_MANIFEST.find((d) => d.to === "/events").surfaces).toBe(original);
    expect(pillarIsScopedOffTheRail("events", "food_service")).toBe(true);
  });
});
