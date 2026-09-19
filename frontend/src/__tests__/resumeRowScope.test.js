/**
 * ResumeRow — the SCOPE axis.
 *
 * Fortsæt renders at the very TOP of the sidebar, above every group, and it
 * resolves against the FULL manifest through filterDestinations. That function
 * answers "may this owner have this destination at all" — it deliberately never
 * consults `surfaces`. So without this axis, a page the product has just taken
 * OFF the rail can reappear ABOVE the rows that replaced it, one recent visit
 * later.
 *
 * That is not hypothetical twice over:
 *   • /events — the founder's own account passes the usage gate (he HAS Event
 *     rows), so taking "sidebar" off the entry hides it from the groups and
 *     Fortsæt would have put it straight back at the top of his rail. That is
 *     how "events is still not hidden" survives its own fix.
 *   • /khata — `surfaces: []` has meant "gone from every surface" since June,
 *     and Resume has been quietly ignoring that.
 *
 * The axis must NOT be "sidebar only", though: several rows are off the rail
 * because they are RARE, not because they are out of scope, and ResumeRow's
 * own doc comment deliberately calls a More/⌘K page a legitimate resume
 * target. Narrowing to the sidebar slice would silently stop Resume working
 * for Budgets, Kørsel, Forbindelser, Terminaler and (for a restaurant)
 * Faktura + Kunder. This file pins both halves.
 */
import { describe, it, expect } from "vitest";
import { NAV_MANIFEST, USAGE_GATED_PILLARS, isScopedOffTheRail } from "../config/navManifest";

const dest = (to) => NAV_MANIFEST.find((d) => d.to === to);

describe("isScopedOffTheRail — what Resume must refuse", () => {
  it("refuses a destination with no nav surface at all (/khata)", () => {
    expect(dest("/khata").surfaces).toEqual([]); // the premise, pinned
    for (const arch of [null, "food_service", "retail", "services"]) {
      expect(isScopedOffTheRail(dest("/khata"), arch)).toBe(true);
    }
  });

  it("refuses Events for every archetype, including the owner who has rows", () => {
    // No ctx here on purpose: this axis is about product scope, not usage.
    // The founder passes the usage gate; this is what stops Fortsæt anyway.
    for (const arch of [null, "food_service", "bar", "retail", "salon", "services"]) {
      expect(isScopedOffTheRail(dest("/events"), arch)).toBe(true);
    }
  });

  it("is driven by the manifest, not by a path list", () => {
    // Events qualifies because it is off the sidebar AND its pillar is one we
    // are not selling. If either fact changed, the refusal would lift on its
    // own — which is what makes re-adding "sidebar" a true one-word revert.
    expect(USAGE_GATED_PILLARS).toContain(dest("/events").pillar);
    expect(dest("/events").surfaces).not.toContain("sidebar");
  });
});

describe("isScopedOffTheRail — what Resume must still allow", () => {
  it("allows rows that left the rail for DECLUTTER, not scope", () => {
    // Rare, but still part of the product: More + ⌘K reach them, and resuming
    // into one is exactly what ResumeRow's doc comment promises.
    for (const to of ["/budgets", "/mileage", "/connections", "/terminals", "/team"]) {
      expect(isScopedOffTheRail(dest(to), "food_service"), to).toBe(false);
    }
  });

  it("allows a row a SINGLE archetype moved to More (C12b)", () => {
    for (const to of ["/faktura", "/customers", "/branches", "/modules"]) {
      expect(isScopedOffTheRail(dest(to), "food_service"), to).toBe(false);
      expect(isScopedOffTheRail(dest(to), "retail"), to).toBe(false);
    }
  });

  it("allows every row that is still on the rail", () => {
    for (const d of NAV_MANIFEST) {
      if (!d.surfaces.includes("sidebar")) continue;
      expect(isScopedOffTheRail(d, "food_service"), d.to).toBe(false);
    }
  });

  it("never throws on a missing or malformed entry", () => {
    expect(isScopedOffTheRail(undefined, "food_service")).toBe(false);
    expect(isScopedOffTheRail({}, "food_service")).toBe(true); // no surfaces ⇒ no scope
  });
});
