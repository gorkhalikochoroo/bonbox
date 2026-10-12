/**
 * A route change and a new onboarding step land at the top AT ONCE: html's
 * scroll-behavior: smooth made it an animation that a page focusing a field
 * on arrival cut short (mobile walk, 12 Oct 2026).
 */
import { describe, expect, it, vi } from "vitest";
import { jumpToTop } from "./jumpToTop";

function fakeWindow(y) {
  const root = { style: { scrollBehavior: "smooth" } };
  const seen = [];
  const win = {
    scrollX: 0, scrollY: y, pageXOffset: 0, pageYOffset: y,
    document: { documentElement: root },
    scrollTo: vi.fn((x, top) => { seen.push(root.style.scrollBehavior); win.scrollY = top; win.pageYOffset = top; }),
  };
  return { win, root, seen };
}

describe("jumpToTop", () => {
  it("scrolls to 0,0 with smooth scrolling lifted for that one call, then puts it back", () => {
    const { win, root, seen } = fakeWindow(279);
    jumpToTop(win);
    expect(win.scrollTo).toHaveBeenCalledWith(0, 0);
    expect(seen).toEqual(["auto"]);
    expect(root.style.scrollBehavior).toBe("smooth");
    expect(win.scrollY).toBe(0);
  });

  it("already at the top: nothing to do", () => {
    const { win } = fakeWindow(0);
    jumpToTop(win);
    expect(win.scrollTo).not.toHaveBeenCalled();
  });

  it("a scrollTo that throws still puts the smooth setting back", () => {
    const { win, root } = fakeWindow(100);
    win.scrollTo = vi.fn(() => { throw new Error("no"); });
    expect(() => jumpToTop(win)).not.toThrow();
    expect(root.style.scrollBehavior).toBe("smooth");
  });
});


describe("jumpToTop forces a style flush before scrolling (Chromium)", () => {
  it("reads the computed scroll-behavior after lifting smooth, before scrollTo", async () => {
    const order = [];
    const root = { style: { scrollBehavior: "smooth" } };
    const win = {
      scrollY: 900, scrollX: 0, pageYOffset: 900, pageXOffset: 0,
      document: { documentElement: root },
      getComputedStyle: (el) => { order.push(["read", el.style.scrollBehavior]); return { scrollBehavior: el.style.scrollBehavior }; },
      scrollTo: () => order.push(["scroll", root.style.scrollBehavior]),
    };
    const { jumpToTop } = await import("./jumpToTop");
    jumpToTop(win);
    expect(order).toEqual([["read", "auto"], ["scroll", "auto"]]);
    expect(root.style.scrollBehavior).toBe("smooth");
  });
});
