/**
 * Booking R13 — the FRAME half of "the embed matches the website"
 * (src/lib/bookingLook.js, run at the first paint by the parse-time script,
 * index.css "BOOKING LOOK"):
 *   - nothing without `look=1`: every old address is the page as before;
 *   - strict validation: hex `^[0-9a-f]{6}$`, enums from fixed lists, and
 *     injection attempts never reach CSS;
 *   - the card (light near-white tinted / dark one step lighter / photo
 *     dark), the ink (AA or ours), the accent (the R5 guard's rules; fails →
 *     the owner's colour → ours), the corner ladder, the font list;
 *   - applyLook sets and clears classes and custom properties on <html>;
 *   - the parse-time script: the look before the first paint, later looks
 *     only from the frame's own parent;
 *   - index.html's pre-paint: the look keeps its theme; the booking page on
 *     its own follows the phone's dark mode.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { LOOK_FONTS, LOOK_RADII, LOOK_RADII_PX, applyLook, lookFrom } from "../lib/bookingLook";
import { ACCENT_PRESETS, accentTokens, contrast, luminance } from "../utils/accentColor";
import { bookingBootSource, lookSource } from "../../scripts/bookingBoot.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const look = (q) => lookFrom(q, LOOK_RADII, LOOK_FONTS);
const html = () => document.documentElement;

afterEach(() => {
  html().className = "";
  html().removeAttribute("style");
  delete window.__bbBooking;
});

describe("nothing without look=1", () => {
  it.each(["", "?embed=1", "?embed=1&compact=1", "?embed=1&flat=1&compact=1", "?embed=1&look=0&surface=000000",
    "?embed=1&look=true&theme=dark", "?embed=1&LOOK=1&theme=dark", "?embed=1&theme=dark&surface=000000&accent=c9a45c"])(
    "%s → null (the page as before)",
    (q) => expect(look(q)).toBeNull(),
  );
  it("look=1 alone is today's light card, nothing else", () => {
    expect(look("?embed=1&look=1")).toEqual({ dark: false, card: "#FFFFFF", ink: null, soft: null, accent: null, radius: null, font: null });
  });
});

describe("strict validation: only hex and fixed words, everything else ignored", () => {
  it.each([
    "ACCENT", "C9A45C", "c9a", "c9a45c80", "%23c9a45c", "#c9a45c", "c9a45c;color:red", "c9a45g",
    "url(x)", "expression(1)", "c9a45c%3B", "\"><script>", "red", "",
  ])("accent=%s is ignored", (v) => {
    expect(look("?embed=1&look=1&surface=000000&accent=" + v).accent).toBeNull();
  });

  it.each(["constructor", "__proto__", "toString", "hasOwnProperty", "Round", "ROUND", "pill", "round;x"])(
    "radius=%s / font=%s is ignored", (v) => {
      const l = look(`?embed=1&look=1&radius=${v}&font=${v}`);
      expect(l.radius).toBeNull();
      expect(l.font).toBeNull();
    },
  );

  it("fonts are ids from the list, not family names", () => {
    for (const v of ["Georgia", "arial", "Playfair%20Display", "inter", "serif"]) expect(look("?look=1&font=" + v).font).toBeNull();
    for (const id of LOOK_FONTS) expect(look("?look=1&font=" + id).font).toBe(id);
  });

  it("theme is light or dark only; the first value of a key wins; long values are cut and fail", () => {
    expect(look("?look=1&theme=Dark").dark).toBe(false);
    expect(look("?look=1&theme=dark&theme=light").dark).toBe(true);
    expect(look("?look=1&surface=0000000000000000000000").card).toBe("#FFFFFF");
    expect(look("?look=1&surface=photo").dark).toBe(true);
    expect(look("?look=1&surface=PHOTO").dark).toBe(false);
  });

  it("whatever comes in, every colour that goes out is one this file computed: #RRGGBB", () => {
    const hostile = ["?look=1&surface=000000&ink=ffffff&accent=c9a45c&accent_ink=000000&radius=round&font=georgia",
      "?look=1&surface=f4efe6&ink=2b2118&accent=7c4a1e&accent_ink=ffffff", "?look=1&surface=photo&ink=fff&accent=;}&accent_ink=x"];
    for (const q of hostile) {
      const l = look(q);
      const colours = [l.card, l.ink, l.soft, ...(l.accent ? Object.values(l.accent) : [])].filter(Boolean);
      for (const c of colours) expect(c).toMatch(/^#[0-9a-fA-F]{6}$/);
    }
  });
});

describe("the theme", () => {
  it.each([
    ["surface=0b0b0b", true], ["surface=1d2b24", true], ["surface=photo", true], ["surface=f4efe6", false],
    ["surface=ffffff", false], ["surface=767676", false], ["surface=555555", true],
    ["ink=f0f0f0", true], ["ink=1a1a1a", false],
    ["theme=dark&surface=ffffff", true], ["theme=light&surface=000000", false],
  ])("%s → dark %s", (q, dark) => expect(look("?look=1&" + q).dark).toBe(dark));
});

describe("the card: a slightly lifted version of the site's surface", () => {
  it("light: near-white tinted toward the site, never under luminance 0.93 (our grey text keeps AA)", () => {
    const cream = look("?look=1&surface=f4efe6").card;
    expect(cream).not.toBe("#FFFFFF");
    expect(luminance(cream)).toBeGreaterThanOrEqual(0.93);
    expect(look("?look=1&surface=ffffff").card).toBe("#FFFFFF");
    const mid = look("?look=1&surface=9a9a9a").card;
    expect(luminance(mid)).toBeGreaterThanOrEqual(0.93);
    expect(contrast("#6B7280", mid)).toBeGreaterThanOrEqual(4.5); // gray-500, the page's quiet text
  });

  it("dark: one step lighter than the site, never over luminance 0.035 (our dark-mode text keeps AA)", () => {
    const c = look("?look=1&surface=0b0b0b").card;
    expect(luminance(c)).toBeGreaterThan(luminance("#0b0b0b"));
    expect(luminance(c)).toBeLessThanOrEqual(0.035);
    expect(contrast("#9CA3AF", c)).toBeGreaterThanOrEqual(4.5); // dark:text-gray-400
    const brown = look("?look=1&surface=3a2a20").card;
    expect(luminance(brown)).toBeLessThanOrEqual(0.035);
  });

  it("a photo, no surface on a dark page, or a theme the owner forced against the site: our own card", () => {
    expect(look("?look=1&surface=photo").card).toBe("#111827");
    expect(look("?look=1&theme=dark&surface=f4efe6").card).toBe("#111827");
    expect(look("?look=1&theme=light&surface=0b0b0b").card).toBe("#FFFFFF");
    expect(look("?look=1&theme=dark").card).toBe("#111827");
  });
});

describe("the ink: the site's text colour when it reads at AA on the card, else ours", () => {
  it("passes on its own card, with a softer line at 5:1", () => {
    const l = look("?look=1&surface=f4efe6&ink=2b2118");
    expect(l.ink).toBe("#2b2118");
    expect(contrast(l.ink, l.card)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(l.soft, l.card)).toBeGreaterThanOrEqual(5);
    expect(l.soft).not.toBe(l.ink);
  });
  it("fails → null, our greys stay (a dark ink on a forced dark card, a pale ink on white)", () => {
    expect(look("?look=1&theme=dark&surface=f4efe6&ink=2b2118").ink).toBeNull();
    expect(look("?look=1&surface=ffffff&ink=aaaaaa").ink).toBeNull();
    expect(look("?look=1&surface=ffffff&ink=aaaaaa").soft).toBeNull();
  });
});

describe("the accent: the site's button colour through the R5 guard, else the owner's, else ours", () => {
  it("gold on a black site passes, with the button's own dark text", () => {
    const a = look("?look=1&surface=0b0b0b&accent=c9a45c&accent_ink=111111").accent;
    expect(a.bg).toBe("#c9a45c");
    expect(a.fg).toBe("#111111");
    expect(contrast(a.fg, a.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(a.quiet, a.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(a.fg, a.hover)).toBeGreaterThanOrEqual(4.5);
  });

  it("the button's own text colour first, when it reads; else white, else the ink — the colour itself never changes", () => {
    expect(look("?look=1&accent=1d4ed8&accent_ink=ffffff").accent.fg).toBe("#ffffff");
    expect(look("?look=1&accent=1d4ed8&accent_ink=93c5fd").accent.fg).toBe("#FFFFFF"); // light blue on blue: 2.7, not used
    const yellow = look("?look=1&surface=0b0b0b&accent=fde047").accent; // on a dark site
    expect(yellow.fg).toBe("#111827"); // white fails on yellow, the ink reads
    expect(yellow.bg).toBe("#fde047");
  });

  it("fails when no text colour reads on it unchanged (the guard would have to change it): → the owner's colour", () => {
    expect(contrast("#FFFFFF", "#777777")).toBeLessThan(4.5);
    expect(contrast("#111827", "#777777")).toBeLessThan(4.5);
    expect(look("?look=1&accent=777777").accent).toBeNull();
  });

  it("fails when it is the card's own colour (under 2:1): a white button on a white site, dark grey on black", () => {
    expect(look("?look=1&surface=ffffff&accent=f3f4f6").accent).toBeNull();
    expect(look("?look=1&surface=0b0b0b&accent=262626").accent).toBeNull();
    // the palette's two lightest presets still stand 2:1 from white (gold 2.35:1, emerald 2.54:1)
    expect(ACCENT_PRESETS).toEqual(expect.arrayContaining(["gold", "emerald"]));
    for (const hex of ["c9a45c", "10b981"]) expect(look("?look=1&surface=ffffff&accent=" + hex).accent).not.toBeNull();
    // and a light accent ON a light site fails the same rule: yellow on white is 1.3:1
    expect(look("?look=1&surface=ffffff&accent=fde047").accent).toBeNull();
  });

  it("the guard's own rules: quiet line, hover and the 3:1 edge as accentTokens makes them on white", () => {
    for (const hex of ["#c9a45c", "#10b981", "#1d4ed8", "#7c4a1e", "#b91c1c"]) {
      const t = accentTokens(hex);
      const a = look("?look=1&surface=ffffff&accent=" + hex.slice(1)).accent;
      expect(t.adjusted).toBe(false);
      expect(a.fg.toUpperCase()).toBe(t.fg);
      expect(a.quiet.toUpperCase()).toBe(t.fgQuiet);
      expect(a.hover.toUpperCase()).toBe(t.hover);
      expect(a.edge.toUpperCase()).toBe(t.edge);
      expect(contrast(a.edge, "#FFFFFF")).toBeGreaterThanOrEqual(3);
    }
  });

  it("on a dark card the edge is lightened until it stands 3:1", () => {
    const l = look("?look=1&surface=0b0b0b&accent=7c4a1e");
    expect(contrast(l.accent.edge, l.card)).toBeGreaterThanOrEqual(3);
  });

  it("CSS: the site's colour wins over the owner's by specificity, and a colour that failed never gets .bb-hacc", () => {
    const css = read("index.css");
    expect(css).toMatch(/:root\.bb-look\.bb-hacc \.bb-pick \{\s*background-color: var\(--bb-h-accent\);/);
    expect(css).toMatch(/:root\.bb-look\.bb-hacc \.bb-accent-main:not\(:disabled\),\s*:root\.bb-look\.bb-hacc \.bb-accent-main\[aria-busy="true"\] \{/);
    // the R5 owner rules are untouched
    expect(css).toContain("[data-bb-accent] .bb-pick {\n  background-color: var(--bb-accent);");
    applyLook(document, look("?look=1&accent=777777"), LOOK_RADII, LOOK_FONTS);
    expect(html().classList.contains("bb-hacc")).toBe(false);
    expect(html().style.getPropertyValue("--bb-h-accent")).toBe("");
  });
});

describe("corners: the site's button on our ladder", () => {
  it("three steps: sharp / soft / round, for the card, the tiles and the button", () => {
    expect(LOOK_RADII).toEqual(["sharp", "soft", "round"]);
    expect(LOOK_RADII_PX).toEqual({ sharp: [4, 4, 4], soft: [16, 12, 12], round: [24, 22, 9999] });
    const css = read("index.css");
    for (const id of LOOK_RADII) {
      const [card, tile, btn] = LOOK_RADII_PX[id];
      expect(css).toContain(`:root.bb-r-${id} { --bb-r-card: ${card}px; --bb-r-tile: ${tile}px; --bb-r-btn: ${btn}px; }`);
    }
    expect(css).toContain(":root.bb-look .bb-cta { border-radius: var(--bb-r-btn, 12px); }");
    expect(css).toMatch(/:root\.bb-look \.bb-tile,\s*:root\.bb-look \.bb-sk \{ border-radius: var\(--bb-r-tile, 12px\); \}/);
  });

  // The host script's mapping (bookingEmbed.js rd()), run on its own.
  const body = (() => {
    const src = read("utils/bookingEmbed.js");
    return src.slice(src.indexOf("\nfunction rd(b){"), src.indexOf("\nfunction lq(f){"));
  })();
  const rd = new Function(body + "; return rd;")();
  it.each([
    ["0px", 40, "sharp"], ["4px", 40, "sharp"], ["6px", 44, "sharp"], ["8px", 40, "soft"], ["12px", 48, "soft"],
    ["19px", 40, "round"], ["20px", 40, "round"], ["999px", 40, "round"], ["24px", 80, "round"],
    ["50%", 40, "round"], ["10%", 40, "soft"], ["0%", 40, "sharp"], ["", 40, "sharp"],
  ])("radius %s on a %i px button → %s", (r, h, want) => {
    expect(rd({ s: { borderTopLeftRadius: r }, r: { height: h } })).toBe(want);
  });
  it("no button → no corners sent (the frame keeps its soft ladder)", () => expect(rd(null)).toBeNull());
});

describe("fonts: system fonts only", () => {
  it("the list, and its stacks in index.css: nothing to download", () => {
    expect(LOOK_FONTS).toEqual(["system", "helvetica", "georgia", "times"]);
    const css = read("index.css");
    for (const id of LOOK_FONTS) expect(css).toMatch(new RegExp(`:root\\.bb-f-${id} body \\{ font-family: [^;]*(serif|sans-serif); \\}`));
    const block = css.slice(css.indexOf("BOOKING LOOK (R13"), css.indexOf(".bb-room-wall {"));
    expect(block).not.toMatch(/url\(|@import|@font-face|googleapis|gstatic/);
    // Inter stays on the tiles (lining figures)
    expect(block).toContain(':root.bb-look [class~="bb-tile"] { font-family: "Inter"');
  });

  it("why: the booking page's CSP loads fonts from 'self' only (no Google Fonts)", () => {
    const v = JSON.parse(fs.readFileSync(path.join(SRC, "..", "vercel.json"), "utf8"));
    const csp = v.headers.find((h) => h.source === "/r/(.*)").headers.find((x) => x.key === "Content-Security-Policy").value;
    expect(csp).toContain("font-src 'self' data:;");
    expect(csp).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
  });
});

describe("applyLook: classes and custom properties on <html>, set and cleared", () => {
  it("a dark site's look, then a light one: nothing left over", () => {
    applyLook(document, look("?look=1&surface=0b0b0b&ink=eeeeee&accent=c9a45c&accent_ink=111111&radius=sharp&font=helvetica"), LOOK_RADII, LOOK_FONTS);
    const cl = html().classList;
    expect([...cl].sort()).toEqual(["bb-f-helvetica", "bb-hacc", "bb-ink", "bb-look", "bb-r-sharp", "dark"]);
    expect(html().style.getPropertyValue("--bb-h-accent")).toBe("#c9a45c");
    expect(html().style.getPropertyValue("--bb-card")).toMatch(/^#[0-9A-F]{6}$/);
    expect(html().style.getPropertyValue("--bb-card-bar")).toMatch(/^#[0-9A-F]{6}EB$/);
    applyLook(document, look("?look=1&surface=ffffff"), LOOK_RADII, LOOK_FONTS);
    expect([...cl].sort()).toEqual(["bb-look"]);
    for (const k of ["--bb-ink", "--bb-ink-soft", "--bb-h-accent", "--bb-h-fg", "--bb-h-edge"]) expect(html().style.getPropertyValue(k)).toBe("");
    expect(html().style.getPropertyValue("--bb-card")).toBe("#FFFFFF");
  });

  it("CSS: the block paints only through custom properties and lives with the page ground (above the room block)", () => {
    const css = read("index.css");
    const start = css.indexOf("BOOKING LOOK (R13");
    expect(start).toBeGreaterThan(-1);
    expect(start).toBeLessThan(css.indexOf(".bb-room-wall {"));
    const block = css.slice(start, css.indexOf(".bb-room-wall {"));
    const colours = [...block.matchAll(/(?:background-color|color|border-color):\s*([^;]+);/g)].map((m) => m[1].trim());
    for (const c of colours) expect(c).toMatch(/^(var\(--bb-[a-z-]+\)|transparent)$/);
  });
});

// ── The parse-time script ─────────────────────────────────────────────
function boot(search, { framed = true } = {}) {
  const listeners = [];
  const parent = { name: "parent" };
  const w = {
    matchMedia: () => ({ matches: false }), fetch: undefined, AbortController,
    addEventListener: (type, fn) => listeners.push({ type, fn }),
  };
  w.self = w;
  w.top = framed ? parent : w;
  w.parent = framed ? parent : w;
  const doc = { createElement: (tag) => ({ tag }), head: { appendChild() {} }, documentElement: html() };
  new Function("window", "location", "document", "fetch", bookingBootSource({ apiUrl: "" }))(
    w, { pathname: "/r/cafe", search, protocol: "https:", hostname: "localhost" }, doc, undefined,
  );
  const send = (data, source = parent) => listeners.filter((l) => l.type === "message").forEach((l) => l.fn({ data, source }));
  return { b: w.__bbBooking, listeners, send };
}

describe("the parse-time script paints the look before the first paint", () => {
  it("a dark site: <html> is dark with the look's card before React (and the page's skeleton) arrives", () => {
    const { b, listeners } = boot("?embed=1&compact=1&look=1&surface=0b0b0b&ink=eeeeee&accent=c9a45c&accent_ink=111111&radius=sharp&font=helvetica");
    expect(b.look.dark).toBe(true);
    expect(html().classList.contains("dark")).toBe(true);
    expect(html().classList.contains("bb-look")).toBe(true);
    expect(html().classList.contains("bb-embed-card")).toBe(true);
    expect(html().style.getPropertyValue("--bb-card")).toBe(b.look.card);
    expect(listeners.filter((l) => l.type === "message")).toHaveLength(1);
  });

  it("later looks come only from the frame's own parent, read by the same strict function", () => {
    const { send } = boot("?embed=1&look=1&surface=ffffff");
    expect(html().classList.contains("dark")).toBe(false);
    send({ type: "bonbox:look", q: "look=1&surface=101010&ink=f0f0f0" }, { name: "another window" });
    expect(html().classList.contains("dark")).toBe(false);
    send({ type: "bonbox:look", q: "surface=101010" }); // no look=1: ignored
    expect(html().classList.contains("dark")).toBe(false);
    send({ type: "bonbox:look", q: "look=1&surface=101010&ink=f0f0f0&accent=;}body{display:none" });
    expect(html().classList.contains("dark")).toBe(true);
    expect(html().classList.contains("bb-hacc")).toBe(false);
    send({ type: "bonbox:look", q: "look=1&" + "x".repeat(500) }); // too long: ignored
    expect(html().classList.contains("dark")).toBe(true);
    send({ type: "other", q: "look=1&theme=light" });
    send("look=1&theme=light");
    expect(html().classList.contains("dark")).toBe(true);
    send({ type: "bonbox:look", q: "look=1&theme=light" });
    expect(html().classList.contains("dark")).toBe(false);
  });

  it("an old embed address (no look=1): no look, no listener, the page as before", () => {
    const { b, listeners } = boot("?embed=1&compact=1&theme=dark&surface=000000");
    expect(b.look).toBeUndefined();
    expect(listeners).toEqual([]);
    expect(html().classList.contains("bb-look")).toBe(false);
    expect(html().classList.contains("dark")).toBe(false);
  });

  it("only in an embed: the booking page on its own never takes a look from its address", () => {
    const { b } = boot("?look=1&theme=dark&surface=000000", { framed: false });
    expect(b.look).toBeUndefined();
    expect(html().classList.contains("bb-look")).toBe(false);
  });

  it("the look half is a function body index.html can carry: no </script, parses, runs the same code", () => {
    const src = lookSource();
    expect(src).not.toMatch(/<\/script/i);
    expect(src).not.toMatch(/\/\//);
    expect(() => new Function("q", "B", "D", "w", src)).not.toThrow();
  });
});

// ── index.html's pre-paint ─────────────────────────────────────────────
describe("the pre-paint", () => {
  const INDEX = fs.readFileSync(path.join(SRC, "..", "index.html"), "utf8");
  const prePaint = [...INDEX.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]).find((x) => x.includes('localStorage.getItem("theme")'));
  const realMM = window.matchMedia;
  afterEach(() => {
    window.matchMedia = realMM;
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });
  const prefersDark = (on) => {
    window.matchMedia = (q) => ({ matches: on && q === "(prefers-color-scheme: dark)" });
  };

  it("an embed with a look keeps the look's theme (dark stays dark, whatever is stored)", () => {
    window.history.replaceState({}, "", "/r/cafe?embed=1&look=1&surface=000000");
    localStorage.setItem("theme", "light");
    html().classList.add("dark");
    window.__bbBooking = { slug: "cafe", embed: true, look: { dark: true } };
    new Function(prePaint)();
    expect(html().classList.contains("dark")).toBe(true);
  });

  it("an embed without a look stays light, even on a dark phone (as before)", () => {
    window.history.replaceState({}, "", "/r/cafe?embed=1");
    prefersDark(true);
    window.__bbBooking = { slug: "cafe", embed: true };
    new Function(prePaint)();
    expect(html().classList.contains("dark")).toBe(false);
  });

  it("the booking page on its own follows a dark phone, and never writes the stored theme", () => {
    window.history.replaceState({}, "", "/cafe-nordlys");
    prefersDark(true);
    localStorage.setItem("theme", "light");
    window.__bbBooking = { slug: "cafe-nordlys", embed: false };
    new Function(prePaint)();
    expect(html().classList.contains("dark")).toBe(true);
    expect(localStorage.getItem("theme")).toBe("light");
  });

  it("a light phone keeps it light; the owner app never follows the phone", () => {
    window.history.replaceState({}, "", "/cafe-nordlys");
    prefersDark(false);
    window.__bbBooking = { slug: "cafe-nordlys", embed: false };
    new Function(prePaint)();
    expect(html().classList.contains("dark")).toBe(false);
    delete window.__bbBooking;
    window.history.replaceState({}, "", "/dashboard");
    prefersDark(true);
    new Function(prePaint)();
    expect(html().classList.contains("dark")).toBe(false);
  });
});
