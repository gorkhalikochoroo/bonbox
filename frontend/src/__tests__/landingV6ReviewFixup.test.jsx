/**
 * LANDING V6 — fix round 2, the fix-up after the three reviews (10 Nov 2026).
 *
 * (Polish pass, 10 Nov: the page's one dash is the short tankestreg "–", so the pins below read "–" where they read "—"; the rule
 *  they hold, a no-break space before the dash, is the same and now holds for every dash on the page: landingV6Polish.test.jsx.)
 * 1. The price headline never starts a line with its dash. With the longer first-100 phrase the headline wrapped as
 *    "… et betalt abonnement / — derefter 199 kr./md." at 390 and 1440 px, in both languages: a dash-led line in the pricing
 *    section's largest type reads as a stray bullet. A no-break space before the dash keeps it at the end of a line. Words and
 *    numbers are unchanged.
 * 2. The stacked phone page's photo step (iPhone SE-size screens, Reduce Motion) ends in blank card, per language. The taller
 *    10 Nov crop put the Danish "med MOMS (brutto)" toggle and the English "Upload Image" button inside the fade. The two files
 *    have the same pixels (1083 × 1024) but the app's wording does not have the same height, so the window is cut per language:
 *    Danish under "Upload billede", English under "Take Photo". Only blank card fades, never a control.
 *
 * The rows below were read from the two files' pixels (lab: bonbox-lab-state/landing-review-2026-11-10/fix2/NOTES-FIXUP.md); a
 * retake of kasse-foto-v2 must re-read them.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import postcss from "postcss";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { IMG } from "../components/landing/v6/images";
import { PLAN_PRICES, FOUNDING_LIMIT } from "../lib/planPrices";

const HERE = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(join(HERE, "..", "components", "landing", "v6", "landingV6.css"), "utf8");
const NB = String.fromCharCode(160); // the no-break space, spelled out so it cannot be mistaken for a space

const lang = { current: "da" };
const fill = (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const makeT = (code) => (key, vars) => fill((code === "da" ? da : en)[key] || en[key] || key, vars && typeof vars === "object" ? vars : {});
vi.mock("../hooks/useLanguage", () => ({ useLanguage: () => ({ lang: lang.current, t: makeT(lang.current), setLang: () => {} }) }));
vi.mock("../components/landing/v6/engine", () => ({ mountLanding: () => () => {} }));
vi.mock("../components/landing/v2/platform", () => ({ isAndroidBrowser: () => false }));
vi.mock("../utils/reportClientError", () => ({ reportClientError: () => {} }));
const { default: LandingV6Page } = await import("../pages/LandingV6Page");
const show = (code) => { lang.current = code; return render(<MemoryRouter><LandingV6Page /></MemoryRouter>).container.querySelector(".lp6"); };
afterEach(cleanup);

/* the stylesheet as rules: [media | "", selector, declarations] */
const RULES = (() => {
  const out = [];
  postcss.parse(css).walkRules((r) => {
    const m = r.parent && r.parent.type === "atrule" && r.parent.name === "media" ? r.parent.params : "";
    const d = {}; r.walkDecls((x) => { d[x.prop] = x.value; });
    for (const sel of r.selector.split(/,(?![^(]*\))/)) out.push([m, sel.trim(), d]);
  });
  return out;
})();
const decl = (media, selector) => Object.assign({}, ...RULES.filter(([m, s]) => m === media && s === selector).map(([, , d]) => d));

describe("fix-up · the price headline never starts a line with its dash", () => {
  const { founding, regular } = PLAN_PRICES.starter;
  const WANT = {
    da: `${founding} kr./md. for de første ${FOUNDING_LIMIT} virksomheder med et betalt abonnement${NB}– derefter ${regular}${NB}kr./md.`,
    en: `${founding} kr./mo for the first ${FOUNDING_LIMIT} businesses with a paid subscription${NB}– then ${regular}${NB}kr./mo.`,
  };

  it.each(["da", "en"])("%s: a no-break space holds the dash to the word before it; the words and the numbers are as they were", (code) => {
    const raw = (code === "da" ? da : en)["landingV6.price.headline"];
    // one dash, a no-break space before it, an ordinary space after it (the line may break after the dash, never before it)
    expect(raw.split("–")).toHaveLength(2);
    expect(raw).toMatch(new RegExp(`\\S${NB}– \\S`));
    expect(raw).not.toMatch(/[ \t]–/);
    // the page prints it as written, the numbers from lib/planPrices
    const h = show(code).querySelector("#pricing-h");
    expect(h.textContent).toBe(WANT[code]);
    // nothing but the text: no tag that could wrap or hide the dash
    expect(h.children).toHaveLength(0);
  });
});

describe("fix-up · the stacked page's photo step ends in blank card, in each language", () => {
  // rows of kasse-foto-v2(.en).webp, 0-based, read from the pixels: the last row of the button the window ends under, and the
  // first row of the control that follows it (da: the "med MOMS (brutto)" toggle; en: the "Upload Image" button)
  const ROWS = { da: { button: 889, next: 938 }, en: { button: 865, next: 890 } };
  const cutOf = (selector) => {
    const v = decl("", selector)["aspect-ratio"];
    const m = String(v).match(/^1083 \/ (\d+)$/);
    expect(m, `${selector}: ${v}`).not.toBeNull();
    return +m[1];
  };

  it("the two files are the same pixels, so the cut is in the window, not in the file", () => {
    expect([IMG.closePhoto.width, IMG.closePhoto.height]).toEqual([1083, 1024]);
    expect([IMG.closePhoto.da.file, IMG.closePhoto.en.file]).toEqual(["kasse-foto-v2.webp", "kasse-foto-v2.en.webp"]);
  });

  it("the window ends between the button and the next control: Danish under 'Upload billede', English under 'Take Photo'", () => {
    const cut = { da: cutOf(".lp6 .foto .win"), en: cutOf(".lp6[lang=en] .foto .win") };
    for (const code of ["da", "en"]) {
      // the last row shown is cut − 1: below the button, above the next control, inside the file
      expect([code, cut[code] - 1 > ROWS[code].button, cut[code] <= ROWS[code].next - 1, cut[code] <= IMG.closePhoto.height]).toEqual([code, true, true, true]);
    }
    // the English rule changes the cut and nothing else
    expect(Object.keys(decl("", ".lp6[lang=en] .foto .win"))).toEqual(["aspect-ratio"]);
  });

  it("only blank card fades: the fade is on the window, starts under the button in both languages, and the picture itself is not masked", () => {
    const d = decl("", ".lp6 .foto .win");
    const m = String(d.mask).match(/^linear-gradient\(#000 ([\d.]+)%,transparent\)$/);
    expect(m, d.mask).not.toBeNull();
    expect(d["-webkit-mask"]).toBe(d.mask);
    for (const [code, sel] of [["da", ".lp6 .foto .win"], ["en", ".lp6[lang=en] .foto .win"]]) {
      const firstFadedRow = (+m[1] / 100) * cutOf(sel);
      // 3 rows clear of the button's own soft edge
      expect([code, firstFadedRow >= ROWS[code].button + 3]).toEqual([code, true]);
    }
    // the 84 % fade over the whole file (it ran through the toggle / the second button) is gone
    expect(decl("", ".lp6 .foto .scr > img")).toEqual({});
    expect(css).not.toMatch(/\.foto[^{}]*\{[^}]*84%/);
    // the pinned phone story still shows the Z-bon in its place
    expect(decl("", ".lp6.story .foto")).toEqual({ display: "none" });
  });

  it.each(["da", "en"])("%s: the picture sits in the window; the page's lang attribute is the one the English rule reads", (code) => {
    const root = show(code);
    expect(root.getAttribute("lang")).toBe(code);
    const win = root.querySelector("#foto > .scr > .win");
    expect(win).not.toBeNull();
    const imgs = [...root.querySelectorAll("#foto img")];
    expect(imgs).toHaveLength(1);
    expect(imgs[0].parentElement).toBe(win);
    expect([imgs[0].getAttribute("src"), imgs[0].getAttribute("width"), imgs[0].getAttribute("height")]).toEqual([IMG.closePhoto[code].src, "1083", "1024"]);
    // the label under the frame stays
    expect(root.querySelector("#foto .demo").textContent).toBe((code === "da" ? da : en)["landingV6.demo"]);
  });
});
