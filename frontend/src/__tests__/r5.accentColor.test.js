/**
 * Booking R5 — the owner's colour, made safe to paint (utils/accentColor.js).
 *
 *  • text on the accent is ≥ 4.5:1 (AA) for EVERY preset — a light gold or
 *    emerald gets the ink, never an unreadable white;
 *  • the softer line in a picked tile and the hover fill stay ≥ 4.5:1;
 *  • the accent's edge stands ≥ 3:1 from the light page and from the dark
 *    standalone page (WCAG 1.4.11: a picked chip is told apart);
 *  • garbage is no colour (null) — the page keeps BonBox's own look;
 *  • the presets are the backend's palette, gold included.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  ACCENT_INK,
  ACCENT_PRESETS,
  ACCENT_WHITE,
  BOOKING_LOOK_EVENT,
  GROUND_DARK,
  GROUND_LIGHT,
  accentStyle,
  accentTokens,
  contrast,
  luminance,
  mix,
  normalizeHex,
  parseHex,
  readableInk,
  readableOn,
} from "../utils/accentColor";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PALETTE = (() => {
  const src = fs.readFileSync(path.join(ROOT, "backend/app/services/logo_service.py"), "utf8");
  const body = src.match(/ACCENT_COLOR_PALETTE: dict\[str, str\] = \{([\s\S]*?)\n\}/)[1];
  return Object.fromEntries([...body.matchAll(/"([a-z]+)":\s*"(#[0-9A-Fa-f]{6})"/g)].map((m) => [m[1], m[2]]));
})();

describe("the maths", () => {
  it("parses only #RRGGBB, upper-cases it, and never passes garbage as a colour", () => {
    expect(parseHex("#C9A45C")).toEqual({ r: 0xc9, g: 0xa4, b: 0x5c });
    expect(normalizeHex(" #c9a45c ")).toBe("#C9A45C");
    for (const bad of [null, undefined, "", "gold", "#abc", "#12345", "#GGGGGG", "red;}", 42, "url(x)"]) {
      expect(parseHex(bad), String(bad)).toBeNull();
      expect(normalizeHex(bad), String(bad)).toBeNull();
      expect(accentTokens(bad), String(bad)).toBeNull();
    }
    expect(contrast("nope", "#FFFFFF")).toBe(1);
  });

  it("matches the WCAG reference values", () => {
    expect(contrast("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrast("#FFFFFF", "#FFFFFF")).toBe(1);
    expect(luminance("#FFFFFF")).toBeCloseTo(1, 6);
    expect(contrast("#767676", "#FFFFFF")).toBeCloseTo(4.54, 2);
    expect(mix("#000000", "#FFFFFF", 0.5)).toBe("#808080");
  });
});

describe("the presets", () => {
  it("are the backend's palette (gold included), in the owner's order", () => {
    expect(PALETTE.gold).toBe("#C9A45C");
    expect([...ACCENT_PRESETS].sort()).toEqual(Object.keys(PALETTE).sort());
    expect(ACCENT_PRESETS[0]).toBe("gold");
  });

  it.each(Object.entries(PALETTE))("%s (%s): every piece reads", (name, hex) => {
    const k = accentTokens(hex);
    expect(k.base).toBe(hex.toUpperCase());
    expect(contrast(k.fg, k.bg), "text").toBeGreaterThanOrEqual(4.5);
    expect(contrast(k.fgQuiet, k.bg), "quiet line").toBeGreaterThanOrEqual(4.5);
    expect(contrast(k.fg, k.hover), "hover").toBeGreaterThanOrEqual(4.5);
    expect(contrast(k.edge, GROUND_LIGHT), "edge on white").toBeGreaterThanOrEqual(3);
    expect(contrast(k.edgeDark, GROUND_DARK), "edge on dark").toBeGreaterThanOrEqual(3);
    // The palette never needs nudging: the owner's exact colour is painted.
    expect(k.bg).toBe(hex.toUpperCase());
    expect(k.adjusted).toBe(false);
  });

  it("gold (and emerald) get the ink; the dark presets keep white text", () => {
    expect(accentTokens(PALETTE.gold).fg).toBe(ACCENT_INK);
    expect(accentTokens(PALETTE.emerald).fg).toBe(ACCENT_INK);
    for (const n of ["blue", "slate", "terracotta", "charcoal", "burgundy"]) {
      expect(accentTokens(PALETTE[n]).fg, n).toBe(ACCENT_WHITE);
    }
    // White on gold would be far below AA — the reason for the guard.
    expect(contrast(ACCENT_WHITE, PALETTE.gold)).toBeLessThan(3);
  });

  it("a light colour gets a deeper edge on the white page; a dark one on the dark page", () => {
    const gold = accentTokens(PALETTE.gold);
    expect(gold.edge).not.toBe(gold.bg);
    expect(gold.edgeDark).toBe(gold.bg);
    const charcoal = accentTokens(PALETTE.charcoal);
    expect(charcoal.edge).toBe(charcoal.bg);
    expect(charcoal.edgeDark).not.toBe(charcoal.bg);
  });
});

describe("any colour, not only the presets", () => {
  it("nudges a colour no text can read on until one does, and says so", () => {
    // A mid grey: white 3.9:1, the ink 4.2:1 — neither passes as it is.
    const k = accentTokens("#7A7A7A");
    expect(contrast(k.fg, k.bg)).toBeGreaterThanOrEqual(4.5);
    expect(k.adjusted).toBe(true);
  });

  it.each(["#FFFFFF", "#000000", "#FFFF00", "#00FF00", "#808080", "#D9A868"])("%s: AA text, 3:1 edges", (hex) => {
    const k = accentTokens(hex);
    expect(contrast(k.fg, k.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(k.fgQuiet, k.bg)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(k.edge, GROUND_LIGHT)).toBeGreaterThanOrEqual(3);
    expect(contrast(k.edgeDark, GROUND_DARK)).toBeGreaterThanOrEqual(3);
  });
});

describe("accentStyle", () => {
  it("hands the page exactly the custom properties index.css reads", () => {
    const style = accentStyle(accentTokens("#C9A45C"));
    expect(Object.keys(style).sort()).toEqual([
      "--bb-accent", "--bb-accent-edge", "--bb-accent-edge-dark", "--bb-accent-fg", "--bb-accent-fg-quiet", "--bb-accent-hover",
    ]);
    expect(accentStyle(null)).toBeUndefined();
    const css = fs.readFileSync(path.join(ROOT, "frontend/src/index.css"), "utf8");
    for (const v of Object.keys(style)) expect(css, v).toContain(`var(${v})`);
  });

  it("has one event name for 'the booking page's look changed'", () => {
    expect(BOOKING_LOOK_EVENT).toBe("bonbox-booking-look-changed");
  });
});

describe("readableOn / readableInk (the gavekort card and PDF)", () => {
  const PAPER = "#fbfaf7";
  const INK = "#14120f";
  it("letters on the accent: paper when it reads, else the ink", () => {
    expect(readableOn(PALETTE.gold, PAPER, INK)).toBe(INK);
    expect(readableOn(PALETTE.blue, PAPER, INK)).toBe(PAPER);
    expect(readableOn("#166b4f", PAPER, INK)).toBe(PAPER); // the card's default green: unchanged
  });

  it("the accent as text on paper: deepened only as far as AA needs", () => {
    const deep = readableInk(PALETTE.gold, PAPER);
    expect(contrast(deep, PAPER)).toBeGreaterThanOrEqual(4.5);
    expect(contrast(mix(PALETTE.gold, "#000000", 0), PAPER)).toBeLessThan(4.5);
    expect(readableInk("#166b4f", PAPER)).toBe("#166b4f");
    expect(readableInk(PALETTE.blue, PAPER)).toBe(PALETTE.blue);
    expect(readableInk("nope", PAPER)).toBe("nope");
  });

  it("the Python twin agrees on the gold card (logo_service.readable_on / readable_ink)", () => {
    const py = fs.readFileSync(path.join(ROOT, "backend/app/services/logo_service.py"), "utf8");
    expect(py).toMatch(/def readable_on\(/);
    expect(py).toMatch(/def readable_ink\(/);
    expect(py).toMatch(/step = round\(step \+ 0\.04, 2\)/); // the same 4 % steps as nudge()
  });
});
