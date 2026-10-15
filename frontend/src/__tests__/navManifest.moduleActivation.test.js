/**
 * Push 8 — a module switched on in /modules always shows (QA click-through,
 * 12 Oct 2026).
 *
 * A fresh bar (a new, in-scope account with the activation axis on) has the
 * bar modules switched on by its type — "Bar & skænk" (bar_pour) and
 * "Vinkort" (wine_sommelier) — but no stock yet, so its Lager pillar is
 * DORMANT. Both entries sit under that pillar, and the activation axis
 * dropped them with it: switched on, and in no menu anywhere.
 *
 * The vertical-fit rule "a module switched on in /modules always shows" now
 * holds on the activation axis too. Everything else about the axis is
 * unchanged: the dormant pillar's own page still drops to its "Sæt op" tile,
 * an owner-hidden pillar still hides everything under it, and the module
 * gate itself still decides (a module that is off shows nothing).
 */
import { describe, expect, it } from "vitest";
import { NAV_MANIFEST, filterDestinations, sidebarGroupsFor } from "../config/navManifest";

const BAR_MODULES = ["bar_pour", "wine_sommelier"];
const ctxFor = ({ modules = BAR_MODULES, activated = [], inScope = true, enabled = true, hidden = [] } = {}) => ({
  businessTypes: ["bar"],
  archetypeId: "bar",
  enabledModules: new Set(modules),
  hasFeature: () => true,
  hiddenPillars: new Set(hidden),
  activatedPillars: new Set(activated),
  isInScope: inScope,
  activationEnabled: enabled,
});
const tos = (ctx) => filterDestinations(NAV_MANIFEST, ctx).map((d) => d.to);

describe("a fresh bar: Lager dormant, bar modules on", () => {
  it("Bar & skænk and Vinkort stay in the nav", () => {
    const shown = tos(ctxFor());
    expect(shown).toContain("/bar");
    expect(shown).toContain("/wine-list");
  });

  it("…in the sidebar's Lager group, where the menu puts them", () => {
    const groups = sidebarGroupsFor("bar").map((g) => ({
      id: g.id,
      items: filterDestinations(g.items, ctxFor()).map((d) => d.to),
    }));
    const stock = groups.find((g) => g.id === "stock");
    expect(stock.items).toEqual(expect.arrayContaining(["/bar", "/wine-list"]));
  });

  // Push 8 review: on a phone Mere showed Vinkort alone under LAGER — the
  // bar's daily tool was only in the ≡ drawer.
  it("…and on the phone's Mere sheet, both of them", () => {
    const more = NAV_MANIFEST.filter((d) => d.surfaces.includes("more"));
    const shown = filterDestinations(more, ctxFor()).map((d) => d.to);
    expect(shown).toEqual(expect.arrayContaining(["/bar", "/wine-list"]));
    // Still gated by its module.
    expect(filterDestinations(more, ctxFor({ modules: [] })).map((d) => d.to)).not.toContain("/bar");
  });

  it("the dormant pillar's own page still drops to its Sæt op tile (unchanged)", () => {
    const shown = tos(ctxFor());
    expect(shown).not.toContain("/inventory");
    // Its other, module-less stock tools stay dormant with it.
    expect(shown).not.toContain("/expiry");
    expect(shown).not.toContain("/waste");
  });

  it("a module that is off still shows nothing", () => {
    const shown = tos(ctxFor({ modules: [] }));
    expect(shown).not.toContain("/bar");
    expect(shown).not.toContain("/wine-list");
  });

  it("a pillar the owner switched off still hides its modules' entries", () => {
    const shown = tos(ctxFor({ hidden: ["inventory"] }));
    expect(shown).not.toContain("/bar");
    expect(shown).not.toContain("/wine-list");
  });

  it("once Lager is in use, or for an established account, nothing changes", () => {
    for (const ctx of [ctxFor({ activated: ["inventory"] }), ctxFor({ inScope: false }), ctxFor({ enabled: false })]) {
      const shown = tos(ctx);
      expect(shown).toEqual(expect.arrayContaining(["/bar", "/wine-list", "/inventory"]));
    }
  });
});
