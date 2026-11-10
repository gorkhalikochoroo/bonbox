/**
 * LANDING V6 — fix round 2, builder B (10 Nov 2026): landing review fixes 4 and 5.
 *
 * Fix 4 (the phone story): the sentence is the headline (22 px semi-bold) and the clock steps back (56–72 px), in the pinned
 * phone story only; the Z-bon takes the photo step's place there (the engine half is in landingV6Engine.test.jsx), so its
 * picture is the stacked page's alone and takes no box in the story.
 *
 * Fix 5 (the pictures): every scene picture is the current app. Eight were made again, two kept (the app renders them the
 * same today); the phone's "Sidder nu" tile is text. Danish and English are the same pixels; each picture is sharp at the
 * size the page shows it; the frame around the 16.40 card has the card's own corners.
 *
 * What a test cannot see (the pictures' content, the look in a real browser) is in the lab: bonbox-lab-state/
 * landing-review-2026-11-10/fix2/NOTES-B.md and shots-b/.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import postcss from "postcss";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { IMG } from "../components/landing/v6/images";

const HERE = dirname(fileURLToPath(import.meta.url));
const V6 = join(HERE, "..", "components", "landing", "v6");
const css = readFileSync(join(V6, "landingV6.css"), "utf8");
const engine = readFileSync(join(V6, "engine.js"), "utf8");

const lang = { current: "da" };
const makeT = (code) => (key) => (code === "da" ? da : en)[key] || en[key] || key;
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

describe("fix 4: on the phone the sentence is the headline, the clock steps back — the pinned story only", () => {
  const PHONE = "(max-width:767px)";

  it("the statement is 22 px semi-bold in the phone story (it was 19 px medium)", () => {
    expect(decl(PHONE, ".lp6.story .copy.sc .line")).toMatchObject({ "font-size": "22px", "font-weight": "600" });
    // a line is 26 px, as before (19 × 1.34 = 25.5), so a four-line statement keeps its height and the pictures theirs
    const lh = 22 * parseFloat(decl(PHONE, ".lp6.story .copy.sc .line")["line-height"]);
    expect(lh).toBeGreaterThanOrEqual(25.5);
    expect(lh).toBeLessThanOrEqual(26.5);
  });

  it("the statement block is as tall as before, so the pictures keep their size: the note sits 8 px under it; 20 px on the same line on phones up to 380 px wide", () => {
    expect(decl(PHONE, ".lp6.story .copy.sc .aside")).toEqual({ "margin-top": "8px" }); // 4 × (26 − 25.5) = 2 px given back
    const narrow = decl("(max-width:380px)", ".lp6.story .copy.sc .line");
    expect(narrow["font-size"]).toBe("20px");
    expect(20 * parseFloat(narrow["line-height"])).toBeCloseTo(22 * 1.18, 1); // the same 26 px line
    expect(narrow["font-weight"]).toBeUndefined(); // still the phone story's 600
  });

  it("the clock is 56–72 px in the phone story (it was up to 96, and 108 on the tallest phones)", () => {
    const v = decl(PHONE, ".lp6.story")["--fs-clock"];
    const m = v.match(/^clamp\((\d+)px,([\d.]+)svh,(\d+)px\)$/);
    expect(m, v).not.toBeNull();
    expect([+m[1], +m[3]]).toEqual([56, 72]);
    // 844 px tall: inside the range, well under the 87 px it was; 667 and 720: 56, as they already were
    const at = (h) => Math.min(72, Math.max(56, (+m[2] * h) / 100));
    expect(at(844)).toBeGreaterThanOrEqual(60);
    expect(at(844)).toBeLessThanOrEqual(72);
    expect([at(667), at(720)]).toEqual([56, 56]);
  });

  it("the stacked page and wide screens keep their sizes: the two rules name the pinned story, inside the phone query, nowhere else", () => {
    const hits = RULES.filter(([, s, d]) => (s === ".lp6.story .copy.sc .line" && d["font-size"] === "22px") || (s === ".lp6.story" && d["--fs-clock"]));
    expect(hits.map(([m, s]) => [m, s])).toEqual([[PHONE, ".lp6.story"], [PHONE, ".lp6.story .copy.sc .line"]]);
    // the page's own tokens are untouched (the stacked page reads them)
    expect(css).toContain("--fs-clock:clamp(64px,10.3svh,96px);--fs-clock0:56px;--fs-h1:44px;--fs-lead:clamp(19px,2.25svh,21px)");
    // no whole-page zoom or scale
    for (const [, s, d] of RULES) if (s === ".lp6" || s === ".lp6.story" || s === ".lp6 .frame" || s === ".lp6.story .frame") expect([s, d.zoom, d.scale, d.transform]).toEqual([s, undefined, undefined, undefined]);
  });

  it("the photo-step picture takes no box in the pinned story (so a phone in the story never fetches it); the stacked page shows it", () => {
    expect(decl("", ".lp6.story .foto")).toEqual({ display: "none" });
    const root = show("da");
    const foto = root.querySelector("#foto");
    expect(foto.className).toContain("ph-only");
    expect(foto.querySelector("img").getAttribute("src")).toBe(IMG.closePhoto.da.src);
    expect(foto.querySelector("img").getAttribute("loading")).toBe("lazy");
  });

  it("the engine: the phone's 00.10 figure is the Z-bon (shown at 3a, laid out and guarded in the phone branch), the MOMS card's window is its first block", () => {
    expect(engine).toContain('const zbOn = wide ? close : id === "3a";');
    expect(engine).toContain("vis(zb, zbOn);");
    expect(engine).not.toMatch(/vis\(foto,/);
    expect(engine).toContain('[tal, 1], [stand, 1], [zb, 2, 0, "3a"], [kasse, 2]]');
    expect(engine).toContain("stop = KS[0]");
    expect(engine).toContain("KS = [676, 978, 1511]");
  });

  it("the Z-bon's figure is in every layout's markup (no phone / wide class), with the paper's four rows and the total the MOMS card repeats", () => {
    for (const code of ["da", "en"]) {
      const root = show(code);
      const zb = root.querySelector("#zb");
      expect(zb.className).toBe("fig fx zb");
      expect([...zb.querySelectorAll("dd")].map((d) => d.textContent)).toEqual(["640,00", "6.610,00", "990,00", "8.240,00"]);
      expect(zb.querySelector("figcaption").textContent).toBe((code === "da" ? da : en)["landingV6.demo"]);
      expect((code === "da" ? da : en)["landingV6.alt.closeMoms"]).toContain("8.240,00 kr.");
      cleanup();
    }
  });
});

describe("fix 5: the pictures are the current app, sharp, the same pixels in Danish and English", () => {
  // the widest each picture is shown, css px (lab fix2/measure-b.json: 390 × 844 for the phone pictures, 1440 × 900 for the wide ones)
  const SHOWN = { vagtUge: 661, bookingGuest: 350, bookingGuestWide: 640, staffNextShift: 350, staffCard: 560, standFloor: 720, standTiles: 482, closePhoto: 350, closePhotoWhole: 422, closeMoms: 463 };

  it("ten pictures; the retakes carry new names, the two kept ones their old names", () => {
    expect(Object.fromEntries(Object.entries(IMG).map(([k, v]) => [k, `${v.da.file} ${v.width}×${v.height}`]))).toEqual({
      vagtUge: "vagt-uge-v9.webp 1440×1572",
      bookingGuest: "booking-gaest-v2.webp 800×578",
      bookingGuestWide: "bord-gaest-v2.webp 1179×1212",
      staffNextShift: "vagt-naeste-v9.webp 1074×766",
      staffCard: "vagt-kort-v9.webp 1074×1024",
      standFloor: "2250_stand_bordplan.webp 1101×690",
      standTiles: "stand-tal3.webp 1010×214",
      closePhoto: "kasse-foto-v2.webp 1083×1024",
      closePhotoWhole: "kasse-foto-hel-v8.webp 1179×1880",
      closeMoms: "kasse-moms.webp 1095×1511",
    });
    expect(readdirSync(join(V6, "img"))).toHaveLength(20);
  });

  it("every picture has at least 1.5 picture pixels per css px where it is shown widest; every retake at least 1.8 (the old tiles had 1.0)", () => {
    expect(Object.keys(SHOWN).sort()).toEqual(Object.keys(IMG).sort());
    for (const [k, w] of Object.entries(SHOWN)) {
      const density = IMG[k].width / w;
      expect([k, density >= 1.5]).toEqual([k, true]);
      if (k !== "standFloor") expect([k, density >= 1.8]).toEqual([k, true]);
    }
  });

  it("the English file of a picture is within 8 % of the Danish file's weight (same screen, crop and quality), and no file is over 80 KB", () => {
    for (const [k, v] of Object.entries(IMG)) {
      const a = statSync(join(V6, "img", v.da.file)).size, b = statSync(join(V6, "img", v.en.file)).size;
      expect([k, Math.abs(a - b) / a < 0.08]).toEqual([k, true]);
      expect([k, Math.max(a, b) <= 80 * 1024]).toEqual([k, true]);
    }
  });

  it("the page reserves each picture's own box, and the stage's maths uses the same proportions", () => {
    const root = show("da");
    const box = (sel) => { const e = root.querySelector(sel); return `${e.getAttribute("width")}×${e.getAttribute("height")}`; };
    expect([box("#uge img"), box("#vapp img"), box("#vagt img"), box("#vagt source"), box("#standw .tw img"), box("#foto img"), box("#fotow img")])
      .toEqual(["1440×1572", "1074×1024", "1074×766", "1074×1024", "1010×214", "1083×1024", "1179×1880"]);
    expect(decl("", ".lp6 .uge .win")).toEqual({ "aspect-ratio": "1440 / 1572" });
    expect(engine).toContain("fit(1440 / 1572, W, P, CLR)");
    expect(engine).toContain("fit(1074 / 1024, W, P, CLR, 560)");
    expect(engine).toContain("GEO.tallV ? 1074 / 1024 : 1074 / 766");
    expect(engine).not.toMatch(/962 \/ 1572|1170 \/ 1100|786 \/ 570/);
    // the tiles are the old picture at twice the pixels, so the 22.50 frame's proportions (66.71 % wide, SG) stand
    expect(IMG.standTiles.width / IMG.standTiles.height).toBeCloseTo(505 / 107, 3);
    expect(engine).toContain("SG = 107 / 757 + 682 / 1101");
    // wide photo step: the whole phone screen, the same proportions as before (FW)
    expect(engine).toContain("FW = 1179 / 1880");
  });

  it("16.40: the frame has the card's own corners (24 px of its 358 px: 6.7 %, a hair over) and no white ground, on the phone and wide", () => {
    for (const sel of [".lp6 .vagt .scr", ".lp6 .vapp .scr"]) {
      const d = decl("", sel);
      expect([sel, d.background]).toEqual([sel, "none"]);
      const [h, v] = d["border-radius"].split("/").map((x) => parseFloat(x));
      expect(h).toBeGreaterThanOrEqual(6.7);
      expect(h).toBeLessThanOrEqual(7);
      expect(v).toBeGreaterThanOrEqual(sel.includes("vapp") ? 7 : 9.4); // 24 / 341 (whole card), 24 / 255 (upper section)
    }
    expect(decl("(max-width:767px) and (min-height:780px)", ".lp6 .vagt .scr")["border-radius"]).toBe(decl("", ".lp6 .vapp .scr")["border-radius"]);
    // the phone's <picture> is clipped to the same corners (its <img> is not the frame's direct child)
    expect(decl("", ".lp6 .vagt picture")).toEqual({ "border-radius": "inherit" });
    expect(decl("", ".lp6 .vagt img")).toEqual({ "border-radius": "inherit" });
    // no leftover of the old capture's own corners or the tall phones' white frame
    expect(css).not.toContain("4% 7% 4% 4%");
  });

  it("10.00: the week picture's description says what the picture shows (kitchen and bar, everyone has seen their shifts)", () => {
    expect(da["landingV6.alt.week"]).toBe("Vagtplanen for ugen, køkken og bar: i dag har Mads K. og Freja N. vagt, og alle har set deres vagter.");
    expect(en["landingV6.alt.week"]).toBe("The week's schedule, kitchen and bar: today Mads K. and Freja N. are on shift, and everyone has seen their shifts.");
    for (const code of ["da", "en"]) { const root = show(code); expect(root.querySelector("#uge img").getAttribute("alt")).toBe((code === "da" ? da : en)["landingV6.alt.week"]); cleanup(); }
  });
});

describe("fix 5: the phone's 'Sidder nu' tile is text, not a picture", () => {
  for (const [code, d, words] of [["da", da, ["Sidder nu", "16", "ved 5 borde"]], ["en", en, ["Seated now", "16", "at 5 tables"]]]) {
    it(`${code}: the tile says "${words.join(" · ")}" in real text, with one description for screen readers and no <img>`, () => {
      const root = show(code);
      const tal = root.querySelector("#tal"), tile = tal.querySelector(".tile");
      expect(tal.querySelector("img")).toBeNull();
      expect([tile.querySelector(".tile-l").textContent, tile.querySelector(".tile-n").textContent, tile.querySelector(".tile-s").textContent]).toEqual(words);
      expect(tile.getAttribute("role")).toBe("img");
      expect(tile.getAttribute("aria-label")).toBe(d["landingV6.alt.standSeated"]);
      for (const part of tile.children) expect(part.getAttribute("aria-hidden")).toBe("true"); // read once, as the picture was
      expect(tile.querySelectorAll("svg")).toHaveLength(2); // the stand's armchair and chevron, drawn
      expect(tile.classList.contains("win")).toBe(true); // the engine sizes .tal .win (--tk)
    });
  }

  it("the numbers are the scene's: 16 seated at 5 tables, as the description, the wide tiles and the floor plan say", () => {
    expect(da["landingV6.alt.standSeated"]).toBe("Værtsskærmen: 16 sidder nu ved 5 borde.");
    expect(da["landingV6.alt.standTiles"]).toContain("16 sidder nu");
    expect(da["landingV6.tile.tables"]).toBe("ved 5 borde");
    expect(en["landingV6.tile.tables"]).toBe("at 5 tables");
  });

  it("it is the stand's own tile at the size the picture showed it: 252 × 107 px box, 12 / 21 / 12 px type × 1.356, the app's emerald and greys", () => {
    expect(decl("", ".lp6 .tal .win")).toEqual({ width: "calc(252px * var(--tk,1))", height: "calc(107px * var(--tk,1))" });
    const tile = decl("", ".lp6 .tal .tile");
    expect(tile["--u"]).toBe("calc(1.356px * var(--tk,1))");
    expect([tile.display, tile["justify-content"]]).toEqual(["flex", "center"]); // its three lines sit in the middle of the box, as in the app (the frame's .win is display:block)
    expect([tile.background, tile.color]).toEqual(["#fff", "#6B7280"]);
    expect(decl("", ".lp6 .tal .tile .tile-h")["font-size"]).toBe("calc(12 * var(--u))");
    expect(decl("", ".lp6 .tal .tile .tile-n")).toMatchObject({ "font-size": "calc(21 * var(--u))", color: "#059669" });
    expect(decl("", ".lp6 .tal .tile .tile-s")["font-size"]).toBe("calc(12 * var(--u))");
    expect(decl("", ".lp6 .tal .tile .tile-i").color).toBe("#059669");
    // 12 × 1.356 = 16.3 px and 21 × 1.356 = 28.5 px on a phone; on short screens (--tk .9) the label is still 14.6 px
    expect(12 * 1.356 * 0.9).toBeGreaterThan(14);
    // no font file the page does not already fetch (the app's tile is 700; the page has 300 / 400 / 500 / 600)
    for (const [, s, d] of RULES) if (/\.tile/.test(s) && d["font-weight"]) expect([s, ["500", "600"].includes(d["font-weight"])]).toEqual([s, true]);
  });
});
