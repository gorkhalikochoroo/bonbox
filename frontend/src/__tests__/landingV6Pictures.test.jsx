/**
 * LANDING V6 — the app screens are in the page's language (23 Oct 2026; Manoj: "eng should be eng and danish should
 * be danish").
 *
 * The English page shows the English captures of the app, the Danish page the Danish ones; a reader in a language the
 * page does not have (Turkish today) reads the English page, pictures included. Rendered here as the app renders it
 * (the real components, the real da.js / en.js values; useLanguage and the engine stubbed as in landingV6Page.test.jsx):
 *   - every <img src> and <picture><source srcset> on the page is one of the page language's files, never the other's,
 *     and each of the eleven pictures is there (one <img> per place: no hidden twin, so no second download);
 *   - a language switch (the page re-keys) swaps every picture with the text, and back; the boxes (width / height)
 *     are the same in both languages, so the engine lays out the same page;
 *   - every picture keeps its demo caption in the page's language, and its alt text is the page language's.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { IMG } from "../components/landing/v6/images";

const lang = { current: "da" };
const makeT = (code) => (key, vars) => {
  const dict = code === "da" ? da : code === "en" ? en : {};
  let v = dict[key] || en[key] || key;
  if (vars && typeof v === "string") v = v.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return v;
};
vi.mock("../hooks/useLanguage", () => ({ useLanguage: () => ({ lang: lang.current, t: makeT(lang.current), setLang: () => {} }) }));
vi.mock("../components/landing/v6/engine", () => ({ mountLanding: () => () => {} }));
vi.mock("../components/landing/v2/platform", () => ({ isAndroidBrowser: () => false }));
vi.mock("../utils/reportClientError", () => ({ reportClientError: () => {} }));

const { default: LandingV6Page } = await import("../pages/LandingV6Page");

const SET = {
  da: new Set(Object.values(IMG).map((v) => v.da.src)),
  en: new Set(Object.values(IMG).map((v) => v.en.src)),
};
const FILE = Object.fromEntries(Object.values(IMG).flatMap((v) => [[v.da.src, v.da.file], [v.en.src, v.en.file]]));
const OTHER = { da: "en", en: "da" };

const page = () => <MemoryRouter><LandingV6Page /></MemoryRouter>;
function show(code) {
  lang.current = code;
  const r = render(page());
  return { ...r, root: () => r.container.querySelector(".lp6") };
}
// every picture reference on the page: <img src> and <picture><source srcset>, in document order
const refs = (root) => [
  ...[...root.querySelectorAll("img")].map((e) => ({ tag: "img", src: e.getAttribute("src"), w: e.getAttribute("width"), h: e.getAttribute("height") })),
  ...[...root.querySelectorAll("picture source")].map((e) => ({ tag: "source", src: e.getAttribute("srcset"), w: e.getAttribute("width"), h: e.getAttribute("height") })),
];
// the place of each picture: the figure it sits in, and its order there
const places = (root) => [...root.querySelectorAll("img, picture source")].map((e) => `${e.closest("figure").id}:${e.tagName}`);

afterEach(cleanup);

describe("each page shows the app in its own language", () => {
  for (const [code, pageLang] of [["da", "da"], ["en", "en"], ["tr", "en"]]) {
    it(`${code}: every picture is ${pageLang === "da" ? "a Danish" : "an English"} file, none of the other language's; all eleven are there, once per place`, () => {
      const { root } = show(code);
      const r = refs(root());
      expect(root().getAttribute("lang")).toBe(pageLang);
      expect(r.length).toBe(13); // 12 <img> + the one <source> (16.40 tall phones)
      expect(r.filter((x) => x.tag === "img")).toHaveLength(12);
      expect(r.map((x) => [x.tag, x.src, SET[pageLang].has(x.src)])).toEqual(r.map((x) => [x.tag, x.src, true]));
      expect(r.filter((x) => SET[OTHER[pageLang]].has(x.src))).toEqual([]);
      // by file name too: the English twin is "<name>.en.webp"
      const files = r.map((x) => FILE[x.src]);
      expect(files.map((f) => [f, /\.webp$/.test(f) && /\.en\.webp$/.test(f) === (pageLang === "en")])).toEqual(files.map((f) => [f, true]));
      // each of the eleven pictures is shown (standFloor twice: phone crop and wide pair; the 16.40 app screen as <source> and <img>)
      expect(new Set(r.map((x) => x.src))).toEqual(SET[pageLang]);
    });
  }

  it("Turkish reads exactly the English page's pictures, in the same places", () => {
    const tr = show("tr");
    const trRefs = refs(tr.root()), trPlaces = places(tr.root());
    cleanup();
    const enPage = show("en");
    expect(trRefs).toEqual(refs(enPage.root()));
    expect(trPlaces).toEqual(places(enPage.root()));
  });
});

describe("a language switch swaps the pictures with the page", () => {
  it("da → en → da: every picture follows the text; same places, same boxes (the engine's layout does not move)", () => {
    const r = show("da");
    const daRoot = r.root(), daRefs = refs(daRoot), daPlaces = places(daRoot);
    lang.current = "en";
    r.rerender(page());
    const enRoot = r.root(), enRefs = refs(enRoot);
    expect(enRoot).not.toBe(daRoot); // re-keyed: a fresh tree, the engine lays out against it
    expect(enRefs.every((x) => SET.en.has(x.src))).toBe(true);
    expect(enRefs.filter((x) => SET.da.has(x.src))).toEqual([]);
    expect(places(enRoot)).toEqual(daPlaces);
    expect(enRefs.map((x) => [x.tag, x.w, x.h])).toEqual(daRefs.map((x) => [x.tag, x.w, x.h]));
    // the same picture in the same place: the Danish twin's English file
    const twin = Object.fromEntries(Object.values(IMG).map((v) => [v.da.src, v.en.src]));
    expect(enRefs.map((x) => x.src)).toEqual(daRefs.map((x) => twin[x.src]));
    lang.current = "da";
    r.rerender(page());
    expect(refs(r.root())).toEqual(daRefs);
  });
});

describe("caption and alt text follow the language", () => {
  for (const [code, d] of [["da", da], ["en", en], ["tr", en]]) {
    it(`${code}: every picture's figure says "${d["landingV6.demo"]}" (the 22.50 tile shares #stand's), and its alt text is the page language's`, () => {
      const { root } = show(code);
      const altKeys = Object.keys(d).filter((k) => k.startsWith("landingV6.alt."));
      const alts = new Set(altKeys.map((k) => d[k]));
      for (const img of root().querySelectorAll("img")) {
        const fig = img.closest("figure");
        const own = (f) => [...f.querySelectorAll(".demo")].some((c) => c.textContent === d["landingV6.demo"]);
        expect([fig.id, own(fig) || (fig.id === "tal" && own(root().querySelector("#stand")))]).toEqual([fig.id, true]);
        expect([fig.id, alts.has(img.getAttribute("alt"))]).toEqual([fig.id, true]);
      }
    });
  }
});
