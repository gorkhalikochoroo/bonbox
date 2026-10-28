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
import { afterEach, describe, expect, it, vi } from "vitest";
import { LOOK_FONTS, LOOK_RADII, LOOK_RADII_PX, applyLook, lookFrom } from "../lib/bookingLook";
import { ACCENT_PRESETS, accentTokens, contrast, luminance } from "../utils/accentColor";
import { LOOK_WAIT_MS, bookingBootSource, lookSource } from "../../scripts/bookingBoot.mjs";

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
    expect(look("?embed=1&look=1")).toEqual({ dark: false, card: "#FFFFFF", tint: "#F5F5F5", tint2: "#E6E6E6", ink: null, soft: null, accent: null, radius: null, font: null, scheme: null });
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

describe("the frame's color-scheme mirrors the <iframe>'s on the host (an opaque box otherwise)", () => {
  it("light / dark / ld only; declared on <html>, and cleared with the next look", () => {
    for (const v of ["dark", "light", "ld"]) expect(look("?look=1&scheme=" + v).scheme).toBe(v);
    for (const v of ["Dark", "light%20dark", "normal", "only", "dark;x", "__proto__"]) expect(look("?look=1&scheme=" + v).scheme).toBeNull();
    applyLook(document, look("?look=1&scheme=ld&surface=0b0b0b"), LOOK_RADII, LOOK_FONTS);
    expect(html().style.colorScheme).toBe("light dark");
    applyLook(document, look("?look=1&scheme=dark"), LOOK_RADII, LOOK_FONTS);
    expect(html().style.colorScheme).toBe("dark");
    applyLook(document, look("?look=1"), LOOK_RADII, LOOK_FONTS);
    expect(html().style.colorScheme || "").toBe("");
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

describe("the trust line and every soft line read at AA on the surfaces they sit on (R13 fix round)", () => {
  // The fix round's sweep (r13/test/scripts/sweep_soft.mjs): 1,197 site surfaces × inks. The softer ink
  // (text-gray-500…700 under .bb-ink) was only checked against the card; on the trust strip — white 5 % over
  // a dark card, gray-50 on a light one — it read 4.29–4.48:1 on many dark sites.
  const over = (fg, a, bg) => {
    const x = parseInt(fg.slice(1), 16), y = parseInt(bg.slice(1), 16);
    return "#" + [16, 8, 0].map((i) => Math.round(((x >> i) & 255) * a + ((y >> i) & 255) * (1 - a)).toString(16).padStart(2, "0")).join("");
  };
  it("0 of the sweep's pairs fall under 4.5:1 — on the card, the strip, the tracks and the look's tint", () => {
    const fails = [];
    let total = 0;
    for (let g = 0; g <= 0x70; g += 2) {
      for (const ink of ["ffffff", "ededed", "e9e4da", "d4d4d4", "cccccc", "000000", "222222", "3b2f22", "555555"]) {
        const grey = g.toString(16).padStart(2, "0").repeat(3);
        for (const surf of [grey, "f4ede1", "ffffff", "fafafa", "eeeeee"]) {
          const l = look(`?look=1&surface=${surf}&ink=${ink}`);
          if (!l.ink) continue;
          total += 1;
          const quiet = l.dark ? [l.card, over("#ffffff", 0.05, l.card), over("#ffffff", 0.04, l.card), l.tint] : [l.card, "#f9fafb", "#f3f4f6", l.tint];
          for (const bg of quiet) {
            if (contrast(l.soft, bg) < 4.5 || contrast(l.ink, bg) < 4.5) fails.push({ surf, ink, bg, soft: l.soft });
          }
        }
      }
    }
    expect(total).toBeGreaterThan(1000);
    expect(fails).toEqual([]);
  });

  it("the tint: one step off the card (dark: 6 % white, light: 4 % black), on <html> as --bb-tint", () => {
    expect(look("?look=1&surface=0b0b0b").tint).toBe(over("#ffffff", 0.06, look("?look=1&surface=0b0b0b").card).toUpperCase());
    applyLook(document, look("?look=1&surface=0b0b0b"), LOOK_RADII, LOOK_FONTS);
    expect(html().style.getPropertyValue("--bb-tint")).toMatch(/^#[0-9A-F]{6}$/);
  });

  it("CSS: no navy left in a looked dark frame — grounds take the card, fields / ticket / tracks the tint; the receipt's ground the card", () => {
    const css = read("index.css");
    expect(css).toContain(":root.bb-look .bb-solid { background-color: var(--bb-card); }");
    expect(css).toContain(":root.bb-look.dark .dark\\:bg-gray-950:not(.bb-ground) { background-color: var(--bb-card); }");
    expect(css).toMatch(/:root\.bb-look\.dark \.dark\\:bg-gray-900,\s*:root\.bb-look\.dark \.dark\\:bg-gray-800 \{ background-color: var\(--bb-tint\); \}/);
    expect(css).toContain(":root.bb-look.dark .dark\\:bg-gray-600 { background-color: var(--bb-card); }");
    // fix round 2: step 2's date summary, allergy panel and info cards; the switch track and step marks
    expect(css).toMatch(/:root\.bb-look\.dark \.dark\\:bg-gray-900\\\/60,\s*:root\.bb-look\.dark \.dark\\:bg-gray-800\\\/60 \{ background-color: var\(--bb-tint\); \}/);
    expect(css).toContain(":root.bb-look.dark .dark\\:bg-gray-700 { background-color: var(--bb-tint-2); }");
    expect(look("?look=1&surface=0b0b0b").tint2).toMatch(/^#[0-9A-F]{6}$/);
    expect(read("pages/ReservationPublicPage.jsx")).toContain("bb-solid bg-gray-50 dark:bg-gray-950 px-4 py-10");
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

  // The host script's mapping (public/static/embed1.js corners()), run on its own.
  const body = (() => {
    const src = fs.readFileSync(path.join(SRC, "..", "public", "static", "embed1.js"), "utf8");
    return src.slice(src.indexOf("  function corners(b) {"), src.indexOf("  /* The look query for one frame"));
  })();
  const rd = new Function(body + "; return corners;")();
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
    for (const c of colours) expect(c).toMatch(/^(var\(--bb-[a-z0-9-]+\)|transparent)( !important)?$/);
  });
});

// ── The parse-time script ─────────────────────────────────────────────
function boot(search, { framed = true } = {}) {
  const listeners = [];
  const toParent = [];
  const parent = { name: "parent", postMessage: (msg, origin) => toParent.push({ msg, origin }) };
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
  return { b: w.__bbBooking, listeners, send, toParent };
}

describe("the parse-time script paints the look before the first paint", () => {
  it("a dark site: <html> is dark with the look's card before React (and the page's skeleton) arrives", () => {
    const { b, listeners } = boot("?embed=1&compact=1&look=1&surface=0b0b0b&ink=eeeeee&accent=c9a45c&accent_ink=111111&radius=sharp&font=helvetica");
    expect(b.look.dark).toBe(true);
    expect(html().classList.contains("dark")).toBe(true);
    expect(html().classList.contains("bb-look")).toBe(true);
    expect(html().classList.contains("bb-embed-card")).toBe(true);
    expect(html().style.getPropertyValue("--bb-card")).toBe(b.look.card);
    // the look's listener, and the one that answers {type:"bonbox:hello"}
    expect(listeners.filter((l) => l.type === "message")).toHaveLength(2);
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

  it("a bare look=1 (every new snippet): the default look, nothing painted, 'ready' to the parent — shown with the look in the same step", () => {
    const { b, send, toParent } = boot("?embed=1&compact=1&look=1");
    expect(b.look).toMatchObject({ dark: false, card: "#FFFFFF" }); // the default, so the page mounts in look mode
    expect(html().classList.contains("bb-look")).toBe(true);
    expect(html().classList.contains("bb-look-wait")).toBe(true);
    expect(toParent).toEqual([{ msg: { type: "bonbox:ready" }, origin: "*" }]);
    send({ type: "bonbox:look", q: "look=1&surface=0b0b0b&ink=eeeeee" });
    // the look and the reveal together: nothing light was ever shown on this dark site
    expect(html().classList.contains("dark")).toBe(true);
    expect(html().classList.contains("bb-look-wait")).toBe(false);
  });

  it("no look by LOOK_WAIT_MS (a blocked or stripped host script): the default look shows, and a late look still applies", () => {
    vi.useFakeTimers();
    try {
      const { send } = boot("?embed=1&look=1");
      expect(html().classList.contains("bb-look-wait")).toBe(true);
      vi.advanceTimersByTime(LOOK_WAIT_MS - 1);
      expect(html().classList.contains("bb-look-wait")).toBe(true);
      vi.advanceTimersByTime(1);
      expect(html().classList.contains("bb-look-wait")).toBe(false);
      expect(html().classList.contains("dark")).toBe(false); // the default light card
      send({ type: "bonbox:look", q: "look=1&surface=0b0b0b" });
      expect(html().classList.contains("dark")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
    expect(LOOK_WAIT_MS).toBeLessThanOrEqual(1500);
  });

  it("an address that carries its look (the owner's kit preview) is painted at once: no wait, no ready", () => {
    const { toParent } = boot("?embed=1&look=1&surface=f4efe6&ink=2b2118");
    expect(html().classList.contains("bb-look-wait")).toBe(false);
    expect(html().classList.contains("bb-look")).toBe(true);
    expect(toParent).toEqual([]);
  });

  it("CSS: waiting paints nothing — html and body transparent, the page hidden", () => {
    const css = read("index.css");
    expect(css).toMatch(/:root\.bb-look-wait,\s*:root\.bb-look-wait body \{ background-color: transparent !important; \}/);
    expect(css).toContain(":root.bb-look-wait body { visibility: hidden; }");
  });

  it("an old embed address (no look=1): no look, nothing a look message can change, the page as before", () => {
    const { b, listeners, send } = boot("?embed=1&compact=1&theme=dark&surface=000000");
    expect(b.look).toBeUndefined();
    // only the passive height answer to {type:"bonbox:hello"}, which an old snippet never sends
    expect(listeners).toHaveLength(1);
    send({ type: "bonbox:look", q: "look=1&theme=dark&surface=000000" });
    expect(html().classList.contains("bb-look")).toBe(false);
    expect(html().classList.contains("dark")).toBe(false);
  });

  it("only in an embed: the booking page on its own never takes a look from its address", () => {
    const { b } = boot("?look=1&theme=dark&surface=000000", { framed: false });
    expect(b.look).toBeUndefined();
    expect(html().classList.contains("bb-look")).toBe(false);
  });

  it("a frame asked {type:'bonbox:hello'} by its own parent says its height again (the host's script came late)", () => {
    const posted = [];
    const parent = { name: "parent", postMessage: (msg, origin) => posted.push({ msg, origin }) };
    const listeners = [];
    const w = { matchMedia: () => ({ matches: false }), AbortController, addEventListener: (t, fn) => listeners.push({ t, fn }) };
    w.self = w;
    w.top = parent;
    w.parent = parent;
    const doc = { createElement: (tag) => ({ tag }), head: { appendChild() {} }, documentElement: html() };
    new Function("window", "location", "document", "fetch", bookingBootSource({ apiUrl: "" }))(
      w, { pathname: "/r/cafe", search: "?embed=1&compact=1", protocol: "https:", hostname: "localhost" }, doc, undefined,
    );
    const say = (data, source = parent) => listeners.filter((l) => l.t === "message").forEach((l) => l.fn({ data, source }));
    const rect = vi.spyOn(html(), "getBoundingClientRect").mockReturnValue({ height: 640.2, width: 460, top: 0, left: 0, right: 460, bottom: 640 });
    say({ type: "bonbox:hello" }, { name: "someone else" });
    expect(posted).toEqual([]);
    say({ type: "bonbox:hello" });
    expect(posted).toHaveLength(1);
    expect(posted[0].msg).toEqual({ type: "bonbox:height", height: 641 });
    expect(posted[0].origin).toBe("*");
    rect.mockRestore();
  });

  it("…and a frame that takes looks answers a hello with 'ready' too (the host script came after the frame was up)", () => {
    const { send, toParent } = boot("?embed=1&look=1");
    toParent.length = 0;
    const rect = vi.spyOn(html(), "getBoundingClientRect").mockReturnValue({ height: 500, width: 460, top: 0, left: 0, right: 460, bottom: 500 });
    send({ type: "bonbox:hello" });
    expect(toParent.map((p) => p.msg)).toEqual([{ type: "bonbox:ready" }, { type: "bonbox:height", height: 500 }]);
    rect.mockRestore();
  });

  it("the booking page on its own decides dark in <head> (no paper frame first): a dark phone or a stored 'dark'", () => {
    const run = ({ osDark = false, stored = null, search = "" } = {}) => {
      html().className = "";
      const w = {
        matchMedia: (q) => ({ matches: osDark && q === "(prefers-color-scheme: dark)" }), AbortController,
        localStorage: { getItem: (k) => (k === "theme" ? stored : null) },
      };
      w.self = w;
      w.top = w;
      w.parent = w;
      const doc = { createElement: (tag) => ({ tag }), head: { appendChild() {} }, documentElement: html() };
      new Function("window", "location", "document", "fetch", bookingBootSource({ apiUrl: "" }))(
        w, { pathname: "/cafe-nordlys", search, protocol: "https:", hostname: "localhost" }, doc, undefined,
      );
      return html().classList.contains("dark");
    };
    expect(run({ osDark: true })).toBe(true);
    expect(run({ stored: "dark" })).toBe(true);
    expect(run({})).toBe(false);
    expect(run({ stored: "light" })).toBe(false);
    // an embed never: its theme is the look's, or light (as before)
    expect(run({ osDark: true, search: "?embed=1" })).toBe(false);
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
