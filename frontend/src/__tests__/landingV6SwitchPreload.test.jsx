/**
 * LANDING V6 — a language switch waits for the new language's pictures on screen (switch-preload round, 23 Oct 2026; the
 * independent check's should-fix: after a DK / EN tap the re-keyed page's cards stood empty until the new files came in).
 *
 * components/landing/v6/switchPictures.js + LandingV6Page's pick(). Rendered with the real components and dictionaries,
 * useLanguage and the engine stubbed (as in landingV6Page.test.jsx). jsdom has no layout, so each test lays the stage out
 * itself: the engine's classes (.story, .fx.on), the boxes of the pictures on screen (getBoundingClientRect) and the tall-phone
 * media query. Image is a stand-in whose decode() the test settles; the timers are fake.
 *   (a) a tap does not change the language until the pictures have decoded, or 600 ms have passed, whichever comes first
 *       (a failed picture does not hold it either); the focus rule is the same after a wait;
 *   (b) a scene without a picture (the 19.45 room, the 10.00 roster, the morning sheet, a cramped stage) switches at once;
 *   (c) only the pictures on screen, on this layout, start loading, in the target language: never the whole other set;
 *   (d) a second tap during the wait (the same switch or the other one) is the same switch: one preload, one language change.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { IMG } from "../components/landing/v6/images";

const lang = { current: "da", setLang: vi.fn() };
const makeT = (code) => (key) => (code === "da" ? da : en)[key] || en[key] || key;
vi.mock("../hooks/useLanguage", () => ({ useLanguage: () => ({ lang: lang.current, t: makeT(lang.current), setLang: lang.setLang }) }));
vi.mock("../components/landing/v6/engine", () => ({ mountLanding: () => () => {} }));
vi.mock("../components/landing/v2/platform", () => ({ isAndroidBrowser: () => false }));
vi.mock("../utils/reportClientError", () => ({ reportClientError: () => {} }));

const { default: LandingV6Page } = await import("../pages/LandingV6Page");
const { WAIT_MS, onScreen } = await import("../components/landing/v6/switchPictures");

/* the stand-in Image: records each src it is given; decode() waits until the test settles it */
let made = [];
class FakeImage {
  constructor() {
    this.src = "";
    made.push(this);
    this.decode = vi.fn(() => new Promise((ok, fail) => { this.ok = ok; this.fail = () => fail(new Error("EncodingError")); }));
  }
}
const srcs = () => made.map((i) => i.src);
const TALL = "(max-width:767px) and (min-height:780px)";

const page = () => <MemoryRouter><LandingV6Page /></MemoryRouter>;
const lp6 = () => document.querySelector(".lp6");
const flush = async () => { await act(async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); }); };
const wait = (ms) => act(() => { vi.advanceTimersByTime(ms); });

/* the stage as the engine and the browser would have it: `on` = the figures the engine shows (story), `view` = figure id →
   the top of its pictures' box (in view when 0 ≤ top < innerHeight); every other picture has no box (display:none) */
function lay({ story = true, on = [], view = null, tall = false, cramp = false } = {}) {
  const root = lp6();
  root.classList.toggle("story", story);
  root.classList.toggle("cramp", cramp);
  for (const f of root.querySelectorAll("#frame .fx")) f.classList.toggle("on", on.includes(f.id));
  const tops = view || Object.fromEntries(on.map((id) => [id, 120]));
  const real = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
    const f = this.tagName === "IMG" && this.closest("#frame .fx");
    if (f && f.id in tops) { const t = tops[f.id]; return { top: t, bottom: t + 300, left: 40, right: 340, width: 300, height: 300, x: 40, y: t, toJSON() {} }; }
    return real.call(this);
  });
  vi.stubGlobal("matchMedia", (q) => ({ matches: tall && q === TALL, media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
}
function show(code = "da") {
  lang.current = code;
  return render(page());
}
const tap = (where = ".top", to = "en") => fireEvent.click(lp6().querySelector(`${where} .lang button[lang='${to}']`));

beforeEach(() => {
  made = [];
  lang.setLang = vi.fn();
  vi.stubGlobal("Image", FakeImage);
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("(a) the language changes when the pictures on screen have decoded, or after 600 ms, whichever comes first", () => {
  it("WAIT_MS is 600", () => expect(WAIT_MS).toBe(600));

  it("decoded first (phone, 12.30): no change on the tap, none at 599 ms while decoding, the change as soon as it has decoded; once", async () => {
    show("da");
    lay({ on: ["booking"] });
    tap();
    await flush();
    expect(srcs()).toEqual([IMG.bookingGuest.en.src]);
    expect(lang.setLang).not.toHaveBeenCalled();
    wait(300);
    await flush();
    expect(lang.setLang).not.toHaveBeenCalled();
    made[0].ok();
    await flush();
    expect(lang.setLang.mock.calls).toEqual([["en"]]);
    wait(1000);
    await flush();
    expect(lang.setLang.mock.calls).toEqual([["en"]]);
  });

  it("600 ms first (a slow line): no change at 599 ms, the change at 600 ms; the late decode changes nothing", async () => {
    show("da");
    lay({ on: ["bookw"] });
    tap();
    wait(599);
    await flush();
    expect(lang.setLang).not.toHaveBeenCalled();
    wait(1);
    expect(lang.setLang.mock.calls).toEqual([["en"]]);
    made[0].ok();
    await flush();
    wait(1000);
    expect(lang.setLang.mock.calls).toEqual([["en"]]);
  });

  it("every picture on screen, not just the first: the change waits for the last one to decode", async () => {
    show("da");
    lay({ on: ["tal", "stand"] });
    tap();
    expect(made).toHaveLength(2);
    made[0].ok();
    await flush();
    expect(lang.setLang).not.toHaveBeenCalled();
    made[1].ok();
    await flush();
    expect(lang.setLang.mock.calls).toEqual([["en"]]);
  });

  it("a picture that fails to load does not hold the switch (it goes on as soon as the file fails)", async () => {
    show("en");
    lay({ on: ["kasse"] });
    tap(".top", "da");
    expect(srcs()).toEqual([IMG.closeMoms.da.src]);
    made[0].fail();
    await flush();
    expect(lang.setLang.mock.calls).toEqual([["da"]]);
  });

  it("the page goes during the wait (a link tapped right after the flag): the language still changes, once, with no place to carry", async () => {
    const r = show("da");
    lay({ on: ["booking"] });
    tap();
    r.unmount();
    wait(600);
    made[0].ok();
    await flush();
    expect(lang.setLang.mock.calls).toEqual([["en"]]);
  });

  it("the place and focus rule are as before: the place is taken at the switch; the pressed flag gets the focus back on the new page", async () => {
    lang.setLang = vi.fn((c) => { lang.current = c; });
    const r = show("da");
    lay({ on: ["foto"] });
    const b = lp6().querySelector(".foot .lang button[lang='en']");
    b.focus();
    fireEvent.click(b); // the keyboard's Enter / Space on a button is its click
    expect(lang.setLang).not.toHaveBeenCalled();
    expect(lp6().getAttribute("lang")).toBe("da");
    made[0].ok();
    await flush();
    expect(lang.setLang.mock.calls).toEqual([["en"]]);
    r.rerender(page());
    expect(lp6().getAttribute("lang")).toBe("en");
    expect(document.activeElement).toBe(lp6().querySelector(".foot .lang button[lang='en']"));
  });
});

describe("(b) a scene without a picture switches at once", () => {
  const cases = [
    ["19.45, the room drawing (story)", { on: ["room"] }],
    ["10.00 on a phone, the drawn roster (story)", { on: ["roster"] }],
    ["the morning sheet: the day's last screen is off screen above", { on: ["kasse"], view: { kasse: -900 } }],
    ["the stacked page, no figure in view", { story: false, view: { booking: 1200 } }],
    ["a cramped stage (its screens are hidden)", { on: ["booking"], cramp: true }],
  ];
  for (const [name, layout] of cases) {
    it(`${name}: the language changes on the tap, nothing is preloaded`, () => {
      show("da");
      lay(layout);
      tap();
      expect(lang.setLang.mock.calls).toEqual([["en"]]);
      expect(made).toEqual([]);
    });
  }
});

describe("(c) only the pictures on screen start loading, this layout's variant, in the target language", () => {
  const cases = [
    ["phone 12.30", { on: ["booking"] }, ["bookingGuest"]],
    ["wide 12.30", { on: ["bookw"] }, ["bookingGuestWide"]],
    ["the engine showing both 12.30 cards while the layout renders one (the other is display:none, no box)", { on: ["booking", "bookw"], view: { booking: 120 } }, ["bookingGuest"]],
    ["the pinned frame: every phone card has its box in view, faded out; only the one the engine shows (.on) counts", { on: ["booking"], view: { booking: 120, vagt: 120, stand: 120, tal: 60, foto: 120, kasse: 120 } }, ["bookingGuest"]],
    ["desktop 10.00, the week plan", { on: ["uge"] }, ["vagtUge"]],
    ["phone 16.40, a phone under 780 px tall: the card crop", { on: ["vagt"] }, ["staffNextShift"]],
    ["phone 16.40, a tall phone: the <picture>'s source, the whole app screen", { on: ["vagt"], tall: true }, ["staffApp"]],
    ["phone 22.50: the tile and the floor plan", { on: ["tal", "stand"] }, ["standSeated", "standFloor"]],
    ["wide 22.50: the two tiles and the floor plan, one figure", { on: ["standw"] }, ["standTiles", "standFloor"]],
    ["wide 00.10 (3a): the photo step; the Z-bon is drawn", { on: ["fotow", "zb"] }, ["closePhotoWhole"]],
    ["00.10 (3b): MOMS", { on: ["kasse"] }, ["closeMoms"]],
    ["the stacked page: the figures in view, not the one below the fold", { story: false, view: { foto: 80, kasse: 500, room: 200, vagt: 2400 } }, ["closePhoto", "closeMoms"]],
  ];
  for (const [name, layout, keys] of cases) {
    for (const [from, to] of [["da", "en"], ["en", "da"]]) {
      it(`${name}, ${from} → ${to}: ${keys.join(" + ")} in ${to}, nothing else`, () => {
        show(from);
        lay(layout);
        expect(onScreen(lp6(), from)).toEqual(keys);
        tap(".top", to);
        expect(srcs()).toEqual(keys.map((k) => IMG[k][to].src));
        // never a file of the language on screen, never the whole other set
        expect(srcs().filter((s) => Object.values(IMG).some((v) => v[from].src === s))).toEqual([]);
        expect(made.length).toBeLessThan(Object.keys(IMG).length);
        expect(lang.setLang).not.toHaveBeenCalled();
      });
    }
  }

  it("a Turkish reader on the English page: the English pictures are on screen, their Danish twins load on a tap on Dansk", () => {
    show("tr");
    lay({ on: ["booking"] });
    tap(".top", "da");
    expect(srcs()).toEqual([IMG.bookingGuest.da.src]);
  });
});

describe("(d) a second tap during the wait is the same switch", () => {
  it("the same flag again, then the footer's: one preload, one language change, at the first decode", async () => {
    show("da");
    lay({ on: ["booking"] });
    tap();
    tap();
    tap(".foot");
    expect(made).toHaveLength(1);
    expect(lang.setLang).not.toHaveBeenCalled();
    made[0].ok();
    await flush();
    wait(2000);
    await flush();
    expect(lang.setLang.mock.calls).toEqual([["en"]]);
  });

  it("taps up to the 600 ms mark: one change at 600 ms, not one per tap", async () => {
    show("da");
    lay({ on: ["stand", "tal"] });
    for (let i = 0; i < 6; i++) { tap(i % 2 ? ".foot" : ".top"); wait(100); }
    await flush();
    expect(made).toHaveLength(2);
    expect(lang.setLang.mock.calls).toEqual([["en"]]);
  });

  it("after a switch is done, a new tap is a new switch; a late decode from the first never ends the second's wait early", async () => {
    show("da");
    lay({ on: ["booking"] });
    tap();
    wait(600); // the first switch, on the timer (its picture still on the way)
    expect(lang.setLang).toHaveBeenCalledTimes(1);
    tap(); // the page did not re-key here (setLang is a stub): the switch is still offered, and a tap is a new wait
    expect(made).toHaveLength(2);
    made[0].ok(); // the first switch's picture arrives late
    await flush();
    expect(lang.setLang).toHaveBeenCalledTimes(1);
    made[1].ok();
    await flush();
    expect(lang.setLang).toHaveBeenCalledTimes(2);
  });
});
