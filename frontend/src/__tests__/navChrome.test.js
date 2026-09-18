/**
 * The sidebar's structural contract: the AA-passing muted tier, and the
 * group-collapse resolver.
 *
 * Both of these are the kind of defect that ships green: a contrast ratio is
 * invisible to a build, and "the rail is always open" reads as a preference
 * rather than a bug. So both get pinned with numbers here.
 *
 * The contrast helper below is the WCAG 2.1 relative-luminance formula
 * (https://www.w3.org/TR/WCAG21/#dfn-relative-luminance) written out rather
 * than pulled from a package — it is eight lines, and a colour test that
 * depends on a transitive dependency's rounding is not a guard.
 */
import { describe, it, expect } from "vitest";
import {
  NAV_MUTED,
  NAV_MUTED_HEX,
  NAV_MUTED_HOVER,
  NAV_MUTED_HOVER_HEX,
  NAV_SURFACE_HEX,
  NAV_GROUPS_STORAGE_KEY,
  readNavGroups,
  isNavGroupOpen,
  setNavGroupOpen,
  toggleNavGroup,
} from "../config/navChrome";

// ── WCAG 2.1 contrast ───────────────────────────────────────────────────
const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
};
const contrast = (fg, bg) => {
  const a = luminance(fg);
  const b = luminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
};

// WCAG 2.1 AA for normal-size text.
const AA = 4.5;

describe("nav muted tier — WCAG AA in BOTH themes", () => {
  it("passes AA on the light sidebar surface", () => {
    expect(contrast(NAV_MUTED_HEX.light, NAV_SURFACE_HEX.light)).toBeGreaterThanOrEqual(AA);
  });

  it("passes AA on the dark sidebar surface", () => {
    // This is the half that a light-mode-only eyeball check misses: the old
    // dark value (gray-500 on gray-800) measured 3.04:1, WORSE than the light
    // side's 2.54:1 was relative to its own ground.
    expect(contrast(NAV_MUTED_HEX.dark, NAV_SURFACE_HEX.dark)).toBeGreaterThanOrEqual(AA);
  });

  it("keeps hover more present than rest, in both themes", () => {
    expect(contrast(NAV_MUTED_HOVER_HEX.light, NAV_SURFACE_HEX.light))
      .toBeGreaterThan(contrast(NAV_MUTED_HEX.light, NAV_SURFACE_HEX.light));
    expect(contrast(NAV_MUTED_HOVER_HEX.dark, NAV_SURFACE_HEX.dark))
      .toBeGreaterThan(contrast(NAV_MUTED_HEX.dark, NAV_SURFACE_HEX.dark));
  });

  it("rejects the failing gray-400/gray-500 pair the tier used to be", () => {
    // The regression this tier exists to prevent, stated as a fact rather
    // than a comment: both old values are below the floor on their own ground.
    expect(contrast("#9ca3af", NAV_SURFACE_HEX.light)).toBeLessThan(AA); // 2.54:1
    expect(contrast("#6b7280", NAV_SURFACE_HEX.dark)).toBeLessThan(AA);  // 3.04:1
  });

  it("names the classes the hexes claim to describe", () => {
    // Cheap tie-breaker: the hexes are only a valid guard while they match the
    // Tailwind steps actually shipped in the class strings.
    expect(NAV_MUTED).toBe("text-gray-500 dark:text-gray-400");
    expect(NAV_MUTED_HOVER).toBe("hover:text-gray-700 dark:hover:text-gray-200");
  });
});

describe("nav group collapse — a deliberate collapse sticks", () => {
  it("defaults an untouched group to open", () => {
    expect(isNavGroupOpen({}, "money")).toBe(true);
    expect(isNavGroupOpen(null, "money")).toBe(true);
    expect(isNavGroupOpen(undefined, "staff")).toBe(true);
  });

  it("honours an explicit collapse", () => {
    expect(isNavGroupOpen({ money: false }, "money")).toBe(false);
  });

  it("honours an explicit collapse of the group the owner is standing in", () => {
    // THE defect. The old auto-expand effect wrote `true` for whichever group
    // contained the current route, so being inside a group made collapsing it
    // impossible — and the write was persisted, so it outlived the visit.
    // There is no active-route input here at all: nothing can overwrite the
    // owner's choice, because nothing else writes.
    const stored = { money: false };
    expect(isNavGroupOpen(stored, "money")).toBe(false);
    expect(stored).toEqual({ money: false }); // resolving is a pure read
  });

  it("leaves every OTHER group's stored choice untouched when one is toggled", () => {
    const stored = { money: false, stock: true, reports: false };
    const next = toggleNavGroup(stored, "money");
    expect(next.money).toBe(true);
    expect(next.stock).toBe(true);
    expect(next.reports).toBe(false);
    expect(stored.money).toBe(false); // no mutation of the previous state
  });

  it("toggles an untouched group closed on first click (it renders open)", () => {
    expect(toggleNavGroup({}, "stock")).toEqual({ stock: false });
  });

  it("writes explicit booleans, never truthy junk", () => {
    expect(setNavGroupOpen({}, "stock", "yes")).toEqual({ stock: false });
    expect(setNavGroupOpen({}, "stock", 1)).toEqual({ stock: false });
    expect(setNavGroupOpen({}, "stock", true)).toEqual({ stock: true });
  });
});

describe("nav group storage — backward compatible with what owners already have", () => {
  it("keeps the pre-fix storage key", () => {
    // Owners have values under this key TODAY. A rename would silently reset
    // every rail to default and read as "my sidebar forgot me".
    expect(NAV_GROUPS_STORAGE_KEY).toBe("bonbox_nav_groups");
  });

  it("reads the legacy shape the old code wrote", () => {
    // Including the `true`s the old auto-expand effect wrote on the owner's
    // behalf — they read back as "open", which is how they render today.
    const legacy = JSON.stringify({ core: true, money: true, stock: false });
    expect(readNavGroups(legacy)).toEqual({ core: true, money: true, stock: false });
    expect(isNavGroupOpen(readNavGroups(legacy), "stock")).toBe(false);
  });

  it("survives absent / corrupt / hostile storage without throwing", () => {
    expect(readNavGroups(null)).toEqual({});
    expect(readNavGroups("")).toEqual({});
    expect(readNavGroups("not json {{")).toEqual({});
    expect(readNavGroups("[1,2,3]")).toEqual({});
    expect(readNavGroups('"a string"')).toEqual({});
  });

  it("drops non-boolean values rather than trusting them", () => {
    // This value lives in a browser across releases — it is untrusted input.
    expect(readNavGroups('{"money":"open","stock":false,"staff":null}'))
      .toEqual({ stock: false });
  });
});
