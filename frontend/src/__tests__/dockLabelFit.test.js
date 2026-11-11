/**
 * The dock's tab names at large text (Android walk, 11 Nov 2026): at 150 %
 * "Beskeder" ellipsized to "Besked…". All five now shrink together to the
 * size the longest needs; at normal size nothing is set. jsdom has no
 * layout, so each label's widths are stubbed the way a phone measures them.
 */
import { describe, expect, it } from "vitest";
import { fitDockLabels, DOCK_LABEL_MIN_PX } from "../components/staff/dockLabelFit";

function dock(widths) {
  const nav = document.createElement("nav");
  for (const [client, scroll] of widths) {
    const el = document.createElement("span");
    el.className = "vp-dock-label";
    Object.defineProperty(el, "clientWidth", { configurable: true, get: () => client });
    Object.defineProperty(el, "scrollWidth", { configurable: true, get: () => scroll });
    nav.appendChild(el);
  }
  return nav;
}
const fs = (nav) => nav.style.getPropertyValue("--vp-dock-fs");

describe("fitDockLabels", () => {
  it("every name fits: nothing is set (the dock is exactly as before)", () => {
    const nav = dock([[40, 40], [50, 50], [30, 30]]);
    expect(fitDockLabels(nav)).toBeNull();
    expect(fs(nav)).toBe("");
  });

  it("one name overflows: ALL get the one size it needs, a hair under", () => {
    const nav = dock([[50, 60], [40, 40], [52, 52]]);
    const want = Math.floor(11 * (46 / 56) * 0.97 * 10) / 10;
    expect(fitDockLabels(nav)).toBe(want);
    expect(fs(nav)).toBe(`${want}px`);
    expect(want).toBeLessThan(11);
  });

  it("the tightest name decides", () => {
    const nav = dock([[50, 55], [50, 60], [50, 52]]);
    expect(fitDockLabels(nav)).toBe(Math.floor(11 * (46 / 56) * 0.97 * 10) / 10);
  });

  it("never below 8 px (ellipsis is the last resort)", () => {
    const nav = dock([[30, 200]]);
    expect(fitDockLabels(nav)).toBe(DOCK_LABEL_MIN_PX);
    expect(fs(nav)).toBe("8px");
  });

  it("measures at the normal size again: once the overflow is gone, the size goes", () => {
    let scroll = 70;
    const nav = document.createElement("nav");
    const el = document.createElement("span");
    el.className = "vp-dock-label";
    Object.defineProperty(el, "clientWidth", { get: () => 50 });
    Object.defineProperty(el, "scrollWidth", { get: () => scroll });
    nav.appendChild(el);
    expect(fitDockLabels(nav)).not.toBeNull();
    scroll = 50;
    expect(fitDockLabels(nav)).toBeNull();
    expect(fs(nav)).toBe("");
  });

  it("a hidden dock (Android keyboard up: 0 wide) sets nothing; no dock is a no-op", () => {
    const nav = dock([[0, 60]]);
    expect(fitDockLabels(nav)).toBeNull();
    expect(fs(nav)).toBe("");
    expect(fitDockLabels(null)).toBeNull();
  });
});
