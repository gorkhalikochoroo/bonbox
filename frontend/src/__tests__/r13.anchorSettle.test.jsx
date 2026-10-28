/**
 * Booking R13 fix round — "Tilføj logo" / "Skift logo" (Reservationer →
 * Indstillinger) open /profile#brand. App.jsx's ScrollManager scrolled there
 * once, while the cards ABOVE the brand section were still loading; as they
 * grew they pushed it 700–1,500 px down (390 and 1440). Now the anchor is
 * kept at the top while the page settles (utils/settleOn): every height
 * change scrolls it back, and it stops for good when the owner scrolls / taps
 * / types, once the page has been still for SETTLED_MS, or after
 * SETTLE_MAX_MS.
 */
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SETTLED_MS, SETTLE_MAX_MS, settleOn } from "../utils/settleOn";

// jsdom has no ResizeObserver: a stand-in that lets the test say "the page moved".
let observers = [];
class FakeRO {
  constructor(cb) {
    this.cb = cb;
    this.on = false;
    observers.push(this);
  }
  observe() {
    this.on = true;
  }
  disconnect() {
    this.on = false;
  }
}
const pageMoves = () => observers.filter((o) => o.on).forEach((o) => o.cb([]));

let top = 0;
let anchor;
beforeEach(() => {
  observers = [];
  globalThis.ResizeObserver = FakeRO;
  vi.useFakeTimers();
  anchor = document.createElement("section");
  anchor.id = "brand";
  anchor.scrollIntoView = vi.fn(() => {
    top = 0;
  });
  anchor.getBoundingClientRect = () => ({ top, bottom: top + 400, left: 0, right: 800, width: 800, height: 400 });
  document.body.appendChild(anchor);
  top = 0;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  anchor.remove();
  delete globalThis.ResizeObserver;
});

describe("settleOn: the anchor stays at the top while the page settles", () => {
  it("each time the page grows above it, it is scrolled back; a still anchor is left alone", () => {
    const stop = settleOn(anchor);
    pageMoves();
    expect(anchor.scrollIntoView).not.toHaveBeenCalled(); // already at the top
    top = 900; // a card above it loaded
    pageMoves();
    expect(anchor.scrollIntoView).toHaveBeenCalledTimes(1);
    top = 1500;
    pageMoves();
    expect(anchor.scrollIntoView).toHaveBeenCalledTimes(2);
    stop();
  });

  it("the owner scrolls, taps or types: it stops for good", () => {
    for (const type of ["wheel", "touchstart", "keydown", "mousedown"]) {
      anchor.scrollIntoView.mockClear();
      settleOn(anchor);
      window.dispatchEvent(new Event(type));
      top = 700;
      pageMoves();
      expect(anchor.scrollIntoView, type).not.toHaveBeenCalled();
    }
  });

  it("still for SETTLED_MS: done; and never longer than SETTLE_MAX_MS", () => {
    settleOn(anchor);
    act(() => vi.advanceTimersByTime(SETTLED_MS + 10));
    top = 800;
    pageMoves();
    expect(anchor.scrollIntoView).not.toHaveBeenCalled();

    // a page that keeps moving is followed until the hard limit
    settleOn(anchor);
    for (let t = 0; t < SETTLE_MAX_MS + 2000; t += 1000) {
      top = 300;
      pageMoves();
      act(() => vi.advanceTimersByTime(1000));
    }
    const calls = anchor.scrollIntoView.mock.calls.length;
    top = 300;
    pageMoves();
    expect(anchor.scrollIntoView.mock.calls.length).toBe(calls);
    expect(calls).toBeGreaterThan(5);
  });

  it("the section leaves the page: it stops", () => {
    settleOn(anchor);
    anchor.remove();
    top = 900;
    pageMoves();
    expect(anchor.scrollIntoView).not.toHaveBeenCalled();
    expect(observers.every((o) => !o.on)).toBe(true);
  });

  it("no ResizeObserver: nothing to do, nothing breaks", () => {
    delete globalThis.ResizeObserver;
    const stop = settleOn(anchor);
    expect(typeof stop).toBe("function");
    stop();
  });
});

describe("ScrollManager uses it for every /page#anchor link", () => {
  it("/profile#brand: scrolled to once, then kept there while the page above it grows", async () => {
    const { ScrollManager } = await import("../App");
    render(
      <MemoryRouter initialEntries={["/profile#brand"]}>
        <ScrollManager />
      </MemoryRouter>,
    );
    expect(anchor.scrollIntoView).toHaveBeenCalledTimes(1);
    top = 1200; // the owner's other cards arrived above it
    pageMoves();
    expect(anchor.scrollIntoView).toHaveBeenCalledTimes(2);
    expect(anchor.scrollIntoView).toHaveBeenLastCalledWith({ block: "start" });
  });
});
