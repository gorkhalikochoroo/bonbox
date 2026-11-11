/**
 * Android BACK, the order (Android walk 11 Nov 2026: BACK did nothing
 * anywhere — not in a sheet, not in a chat thread, not on a tab, not at
 * home). One press = one step out: the top-most layer closes; else back to
 * the home tab; else the app goes to the background.
 *
 * jsdom has no layout, so visibility is passed in (`() => true`) and the
 * overlays' stacking comes from inline position/z-index, as the real ones
 * get from their classes.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { findBackTarget, runAndroidBack } from "../utils/androidBack";

const visible = () => true;
afterEach(() => { document.body.innerHTML = ""; });

function page(html) {
  document.body.innerHTML = html;
  const clicks = [];
  document.querySelectorAll("[id]").forEach((el) => el.addEventListener("click", () => clicks.push(el.id)));
  return clicks;
}

describe("findBackTarget — the top-most open layer's way out", () => {
  it("a confirm over a sheet over an inline form: the confirm's scrim (= Cancel) first", () => {
    page(`
      <div id="app">
        <form><button id="formClose" data-back-close>×</button></form>
        <div data-bb-confirm style="position:fixed;z-index:10000"><div id="confirmScrim" data-bb-confirm-scrim></div><button>Frakobl</button></div>
      </div>
      <div style="position:fixed;z-index:60" role="dialog"><button id="sheetScrim" class="vp-scrim"></button></div>`);
    expect(findBackTarget(document, visible).id).toBe("confirmScrim");
  });

  it("a sheet ranks above an inline form or the chat thread, wherever it sits in the DOM", () => {
    page(`
      <div id="sheet" class="vp-scrim" style="position:fixed;z-index:50"><div role="dialog"></div></div>
      <button id="threadBack" data-back-close>Alle samtaler</button>`);
    expect(findBackTarget(document, visible).id).toBe("sheet");
  });

  it("two sheets at the same z: the one opened later (later in the document) wins", () => {
    page(`
      <div style="position:fixed;z-index:60"><button id="profile" class="vp-scrim"></button></div>
      <div id="docs" class="vp-scrim" style="position:fixed;z-index:60"></div>`);
    expect(findBackTarget(document, visible).id).toBe("docs");
  });

  it("skips layers that are closing, inert, hidden, disabled or off screen", () => {
    page(`
      <button id="inline" data-back-close>Annuller</button>
      <div data-closing style="position:fixed;z-index:60"><button class="vp-scrim"></button></div>
      <div data-bb-confirm data-closing inert style="position:fixed;z-index:10000"><div data-bb-confirm-scrim></div></div>
      <div hidden style="position:fixed;z-index:60"><button class="vp-scrim"></button></div>
      <div style="position:fixed;z-index:70"><button class="vp-scrim" disabled></button></div>
      <div style="position:fixed;z-index:80"><button id="offscreen" class="vp-scrim"></button></div>`);
    const shown = (el) => el.id !== "offscreen";
    expect(findBackTarget(document, shown).id).toBe("inline");
  });

  it("nothing open: null", () => {
    page(`<main><button>Tag den</button></main>`);
    expect(findBackTarget(document, visible)).toBeNull();
  });
});

describe("runAndroidBack — one press, one step", () => {
  it("closes the top layer by clicking it (the handler the staffer's own tap runs)", () => {
    const clicks = page(`<div style="position:fixed;z-index:60"><button id="scrim" class="vp-scrim"></button></div>`);
    const setTab = vi.fn();
    const minimize = vi.fn();
    expect(runAndroidBack({ doc: document, tab: "swaps", homeTab: "schedule", setTab, minimize, isVisible: visible })).toBe("closed");
    expect(clicks).toEqual(["scrim"]);
    expect(setTab).not.toHaveBeenCalled();
    expect(minimize).not.toHaveBeenCalled();
  });

  it("no layer, another tab: back to the home tab", () => {
    page(`<main></main>`);
    const setTab = vi.fn();
    const minimize = vi.fn();
    expect(runAndroidBack({ doc: document, tab: "hours", homeTab: "schedule", setTab, minimize, isVisible: visible })).toBe("home");
    expect(setTab).toHaveBeenCalledWith("schedule");
    expect(minimize).not.toHaveBeenCalled();
  });

  it("no layer, home tab: the app goes to the background", () => {
    page(`<main></main>`);
    const setTab = vi.fn();
    const minimize = vi.fn(() => Promise.resolve());
    expect(runAndroidBack({ doc: document, tab: "schedule", homeTab: "schedule", setTab, minimize, isVisible: visible })).toBe("background");
    expect(minimize).toHaveBeenCalledTimes(1);
    expect(setTab).not.toHaveBeenCalled();
  });

  it("a screen without tabs (the join screen): straight to the background, and a failing plugin is harmless", () => {
    page(`<main></main>`);
    const minimize = vi.fn(() => Promise.reject(new Error("not implemented")));
    expect(runAndroidBack({ doc: document, minimize, isVisible: visible })).toBe("background");
    expect(minimize).toHaveBeenCalledTimes(1);
  });
});
