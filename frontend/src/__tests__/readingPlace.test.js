/**
 * readingPlace — rotating an iPad while reading Vagtplan keeps the reader's
 * place (design QA, round 4).
 *
 * The repro: 820 × 1180, scrolled down to the week list. Rotate to 1180 × 820
 * (two columns: the page is shorter, the browser clamps the scroll to 207),
 * then back. The top of the screen was the hero's "Stempl ud" and the week
 * list was below the fold. Here the DOM's geometry is played by hand: the
 * element at the top of the content column is the anchor, the clamp is a
 * scrollTop setter, and time is performance.now().
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearReading, quietReading, readingSnapshot, recordReading, restoreReading } from "../lib/readingPlace";

let clock = 0;
let layout; // "portrait" | "landscape"
let scroller, header, content, hero, week;

/** Where the week row's top is on screen for a scrollTop, per layout. */
const weekDocTop = { portrait: 720, landscape: 330 };
const maxScroll = { portrait: 2000, landscape: 207 };

function build() {
  scroller = document.createElement("div");
  scroller.setAttribute("data-portal-scroller", "");
  header = document.createElement("header");
  content = document.createElement("div");
  content.setAttribute("data-portal-content", "");
  const tabRoot = document.createElement("div");
  hero = document.createElement("div");
  week = document.createElement("div");
  week.setAttribute("data-week-day", "2026-10-12");
  tabRoot.append(hero, week);
  content.append(tabRoot);
  scroller.append(header, content);
  document.body.append(scroller);

  let top = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => top,
    set: (v) => { top = Math.max(0, Math.min(maxScroll[layout], v)); },
  });
  const rect = (t, h) => ({ top: t, bottom: t + h, height: h, left: 0, right: 600, width: 600 });
  header.getBoundingClientRect = () => rect(0, 100);
  scroller.getBoundingClientRect = () => rect(0, 1180);
  content.getBoundingClientRect = () => rect(100, 3000);
  hero.getBoundingClientRect = () => rect(124 - scroller.scrollTop, 300);
  week.getBoundingClientRect = () => rect(weekDocTop[layout] - scroller.scrollTop, 260);
  // What sits just under the header: the week row once it has scrolled up there.
  document.elementFromPoint = () => {
    const w = week.getBoundingClientRect();
    return w.top <= 102 && w.bottom > 102 ? week : hero;
  };
}

beforeEach(() => {
  clock = 10_000;
  vi.spyOn(performance, "now").mockImplementation(() => clock);
  layout = "portrait";
  clearReading();
  build();
});
afterEach(() => {
  vi.restoreAllMocks();
  scroller.remove();
  delete document.elementFromPoint;
});

describe("the reading place survives portrait → landscape → portrait", () => {
  it("back in portrait the week list is at the top again, not the hero's Stempl ud", () => {
    // The staffer scrolls the week row up under the header (6 px of it
    // already passed under).
    scroller.scrollTop = 626; // week top: 720 - 626 = 94
    recordReading(scroller, header);
    expect(readingSnapshot().chain[0]).toBe(week);
    expect(readingSnapshot().offset).toBe(-6);

    // Rotate: the page gets shorter and the browser clamps the scroll.
    layout = "landscape";
    const before = scroller.scrollTop;
    scroller.scrollTop = before; // the browser clamps it → 207
    expect(scroller.scrollTop).toBe(207);
    // The layout change: restore (clamped again — landscape cannot reach it)…
    restoreReading(scroller, header);
    expect(scroller.scrollTop).toBe(207);
    // …and the scroll events those moves fire are not the staffer's.
    clock += 100;
    recordReading(scroller, header);
    expect(readingSnapshot().chain[0]).toBe(week);

    // Rotate back.
    clock += 100;
    layout = "portrait";
    restoreReading(scroller, header);
    expect(scroller.scrollTop).toBe(626);
    expect(week.getBoundingClientRect().top).toBe(94);
  });

  it("a scroll of the staffer's own, after the quiet window, is their new place", () => {
    scroller.scrollTop = 626;
    recordReading(scroller, header);
    quietReading();
    clock += 2000; // well after the window
    scroller.scrollTop = 0;
    recordReading(scroller, header);
    // At the very top there is nothing to keep: a rotation leaves it there.
    expect(readingSnapshot().chain).toEqual([]);
    layout = "landscape";
    expect(restoreReading(scroller, header)).toBe(false);
    expect(scroller.scrollTop).toBe(0);
  });

  it("does nothing without elementFromPoint (old WebViews, and the page's own tests)", () => {
    delete document.elementFromPoint;
    scroller.scrollTop = 626;
    recordReading(scroller, header);
    expect(readingSnapshot().chain).toEqual([]);
  });

  it("the page wires it: noted on the staffer's scroll, restored on a layout change when nothing was tapped", async () => {
    const { readFileSync } = await import("node:fs");
    const { dirname, join } = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "pages", "StaffPortalPage.jsx"), "utf8");
    expect(SRC).toContain("if (placeElement()) keepPlaceInView(scrollerEl, headerEl, isPad);\n    else restoreReading(scrollerEl, headerEl);");
    expect(SRC).toContain("recordReading(scrollerEl, headerEl);");
  });
});
