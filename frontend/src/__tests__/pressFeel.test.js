/**
 * The finger-driven press (premium feel P3 / 1.3, components/staff/pressFeel.js).
 *
 * On touch a control presses from `data-pressed`, never from :active, so a
 * scroll that starts on a row never flashes it:
 *   • a small control and a plain button press at pointerdown;
 *   • a stand-alone card (.vp-row) or a grouped row (.vp-tint) presses 70 ms
 *     late; a tap shorter than that still presses, for 90 ms, at the release;
 *   • a move over 10 px, a scroll, pointercancel or a second finger clears it;
 *   • never on disabled, aria-disabled, inert or closing controls, and never
 *     for a mouse (it keeps :active);
 *   • html[data-modality] says mouse / touch / keyboard, written only when it
 *     changes (each write restyles the page);
 *   • switches, tabs and toggles warm the haptic generator at pointerdown.
 *
 * jsdom has no PointerEvent: plain events carry the fields the controller
 * reads (pointerType, isPrimary, clientX/Y).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { installPressFeel, PRESS } from "../components/staff/pressFeel";
import { feel } from "../components/staff/feel";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function pointer(target, type, { pointerType = "touch", isPrimary = true, x = 10, y = 10 } = {}) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  Object.assign(e, { pointerType, isPrimary, clientX: x, clientY: y });
  target.dispatchEvent(e);
  return e;
}
const pressed = (el) => el.hasAttribute("data-pressed");
const modality = () => document.documentElement.dataset.modality;

let uninstall = null;
let warm;
beforeEach(() => {
  vi.useFakeTimers();
  document.body.innerHTML = `
    <button id="small" class="vp-press vp-s">x</button>
    <button id="plain">Plain</button>
    <a id="link" href="/x">Link</a>
    <div id="role" role="button"><span id="inner">Inner</span></div>
    <button id="row" class="vp-press vp-row">Row</button>
    <div class="card"><button id="tint" class="vp-tint">Grouped row</button></div>
    <button id="dis" class="vp-press" disabled>Off</button>
    <button id="adis" class="vp-press" aria-disabled="true">Off</button>
    <div inert><button id="inert" class="vp-press">Inert</button></div>
    <div data-closing=""><button id="closing" class="vp-press">Closing</button></div>
    <button id="switch" role="switch" aria-checked="false">Switch</button>
    <button id="toggle" aria-pressed="false">DA</button>
    <button id="tab" role="tab">Tab</button>
    <p id="text">Not a control</p>`;
  warm = vi.spyOn(feel, "warm").mockImplementation(() => {});
  uninstall = installPressFeel();
});
afterEach(() => {
  uninstall?.();
  uninstall = null;
  warm.mockRestore();
  document.body.innerHTML = "";
  vi.useRealTimers();
});
const $ = (id) => document.getElementById(id);

describe("the numbers", () => {
  it("late press 70 ms, quick-tap press 90 ms, slop 10 px", () => {
    expect(PRESS).toEqual({ WAIT: 70, TAP: 90, SLOP: 10 });
  });
});

describe("immediate press", () => {
  it("a small .vp-press, a plain button, a link and a role=button press at pointerdown", () => {
    for (const id of ["small", "plain", "link"]) {
      pointer($(id), "pointerdown");
      expect(pressed($(id))).toBe(true);
      pointer($(id), "pointerup");
      expect(pressed($(id))).toBe(false);
    }
    pointer($("inner"), "pointerdown");      // the touch lands on a child: the control presses
    expect(pressed($("role"))).toBe(true);
    expect(pressed($("inner"))).toBe(false);
  });

  it("anything that is not a control: nothing", () => {
    pointer($("text"), "pointerdown");
    expect(document.querySelectorAll("[data-pressed]")).toHaveLength(0);
  });
});

describe("late press for cards and grouped rows", () => {
  it(".vp-row gets it only after 70 ms", () => {
    pointer($("row"), "pointerdown");
    vi.advanceTimersByTime(69);
    expect(pressed($("row"))).toBe(false);
    vi.advanceTimersByTime(1);
    expect(pressed($("row"))).toBe(true);
    pointer($("row"), "pointerup");
    expect(pressed($("row"))).toBe(false);
  });

  it(".vp-tint presses late too", () => {
    pointer($("tint"), "pointerdown");
    expect(pressed($("tint"))).toBe(false);
    vi.advanceTimersByTime(70);
    expect(pressed($("tint"))).toBe(true);
  });

  it("a quick tap (released at 30 ms) presses at the release and lets go 90 ms later", () => {
    pointer($("row"), "pointerdown");
    vi.advanceTimersByTime(30);
    pointer($("row"), "pointerup");
    expect(pressed($("row"))).toBe(true);
    vi.advanceTimersByTime(89);
    expect(pressed($("row"))).toBe(true);
    vi.advanceTimersByTime(1);
    expect(pressed($("row"))).toBe(false);
    // The 70 ms timer it replaced never fires a second press.
    vi.advanceTimersByTime(200);
    expect(pressed($("row"))).toBe(false);
  });
});

describe("what clears a press", () => {
  it("a move of 11 px clears it; 9 px does not", () => {
    pointer($("small"), "pointerdown", { x: 100, y: 100 });
    pointer($("small"), "pointermove", { x: 109, y: 91 });
    expect(pressed($("small"))).toBe(true);
    pointer($("small"), "pointermove", { x: 100, y: 111 });
    expect(pressed($("small"))).toBe(false);
  });

  it("a move over the slop before 70 ms means the late card never presses (a scroll starting on it)", () => {
    pointer($("row"), "pointerdown", { x: 100, y: 100 });
    vi.advanceTimersByTime(40);
    pointer($("row"), "pointermove", { x: 100, y: 130 });
    vi.advanceTimersByTime(100);
    expect(pressed($("row"))).toBe(false);
    pointer($("row"), "pointerup");
    expect(pressed($("row"))).toBe(false);
  });

  it("a scroll and pointercancel clear it", () => {
    pointer($("small"), "pointerdown");
    document.body.dispatchEvent(new Event("scroll"));
    expect(pressed($("small"))).toBe(false);
    pointer($("plain"), "pointerdown");
    pointer($("plain"), "pointercancel");
    expect(pressed($("plain"))).toBe(false);
  });

  it("a second finger clears it and presses nothing", () => {
    pointer($("small"), "pointerdown");
    pointer($("plain"), "pointerdown", { isPrimary: false });
    expect(pressed($("small"))).toBe(false);
    expect(pressed($("plain"))).toBe(false);
  });
});

describe("never", () => {
  it("disabled, aria-disabled, inside [inert] or inside [data-closing]", () => {
    for (const id of ["dis", "adis", "inert", "closing"]) {
      pointer($(id), "pointerdown");
      vi.advanceTimersByTime(100);
      expect(pressed($(id))).toBe(false);
    }
  });

  // Fix round (scrim-press): four sheets close from a full-screen <button
  // class="vp-scrim">. Pressed, the plain-button rule shrank it to .97 and the
  // bare page showed at its edges (under reduce it lightened to .72 instead).
  it("a sheet's scrim button: never pressed, and a tap on it still closes (it is only a click)", () => {
    const root = document.createElement("div");
    root.setAttribute("data-vp-overlay", "");
    root.innerHTML = '<button type="button" id="scrim" class="vp-scrim" aria-label="Luk"></button>';
    document.body.appendChild(root);
    const onClick = vi.fn();
    $("scrim").addEventListener("click", onClick);
    pointer($("scrim"), "pointerdown");
    expect(pressed($("scrim"))).toBe(false);
    vi.advanceTimersByTime(100);
    expect(pressed($("scrim"))).toBe(false);
    pointer($("scrim"), "pointerup");
    $("scrim").click();
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(pressed($("scrim"))).toBe(false);
  });

  it("a mouse: no press (it keeps :active), and the modality is mouse", () => {
    pointer($("small"), "pointerdown", { pointerType: "mouse" });
    expect(pressed($("small"))).toBe(false);
    expect(modality()).toBe("mouse");
  });
});

describe("modality", () => {
  it("touch → touch, pen → touch, keydown → keyboard, mouse → mouse", () => {
    pointer($("small"), "pointerdown");
    expect(modality()).toBe("touch");
    pointer($("small"), "pointerup");
    document.dispatchEvent(new Event("keydown"));
    expect(modality()).toBe("keyboard");
    pointer($("small"), "pointerdown", { pointerType: "pen" });
    expect(modality()).toBe("touch");
    pointer($("small"), "pointerdown", { pointerType: "mouse" });
    expect(modality()).toBe("mouse");
  });

  it("the attribute is written only when it changes (each write restyles the page)", async () => {
    const records = [];
    const mo = new MutationObserver((r) => records.push(...r.filter((x) => x.attributeName === "data-modality")));
    mo.observe(document.documentElement, { attributes: true });
    pointer($("small"), "pointerdown");
    pointer($("small"), "pointerup");
    pointer($("plain"), "pointerdown");
    pointer($("plain"), "pointerup");
    document.dispatchEvent(new Event("keydown"));
    document.dispatchEvent(new Event("keydown"));
    document.dispatchEvent(new Event("keydown"));
    await Promise.resolve();
    mo.disconnect();
    // touch once, keyboard once — not five writes.
    expect(records).toHaveLength(2);
  });
});

describe("warming the haptic generator", () => {
  it("[aria-pressed], [role=switch] and [role=tab] call feel.warm at pointerdown; a plain button does not", () => {
    pointer($("plain"), "pointerdown");
    expect(warm).not.toHaveBeenCalled();
    pointer($("toggle"), "pointerdown");
    pointer($("switch"), "pointerdown");
    pointer($("tab"), "pointerdown");
    expect(warm).toHaveBeenCalledTimes(3);
  });
});

describe("uninstall", () => {
  it("removes the listeners, any press and the modality attribute", () => {
    pointer($("small"), "pointerdown");
    expect(pressed($("small"))).toBe(true);
    uninstall();
    uninstall = null;
    expect(pressed($("small"))).toBe(false);
    expect(document.documentElement.hasAttribute("data-modality")).toBe(false);
    pointer($("plain"), "pointerdown");
    expect(pressed($("plain"))).toBe(false);
    expect(document.documentElement.hasAttribute("data-modality")).toBe(false);
  });
});

describe("wired into the portal", () => {
  it("StaffPortalPage installs it while mounted, and forgets the tabs' memory when it unmounts", () => {
    const page = fs.readFileSync(path.join(SRC, "pages/StaffPortalPage.jsx"), "utf8");
    expect(page).toContain('import { installPressFeel } from "../components/staff/pressFeel";');
    expect(page).toContain("useEffect(() => installPressFeel(), []);");
    // Edited in premium feel Step 3 (1.2a, spec P7): the same unmount effect
    // now also clears the clock's memory (lastClock). The intent is unchanged:
    // the tabs' memory is forgotten when the portal unmounts.
    expect(page).toContain("useEffect(() => () => { forgetAll(); lastClock = null; }, []);");
    // Next to the portal-shell layout effect, so it lives exactly as long as the portal.
    const shell = page.indexOf('document.body.classList.add("portal-shell");');
    const install = page.indexOf("useEffect(() => installPressFeel(), []);");
    expect(install).toBeGreaterThan(shell);
    expect(install - shell).toBeLessThan(800);
  });
});
