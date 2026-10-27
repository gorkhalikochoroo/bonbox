// The owner's accent colour, made safe to paint (booking R5, 27 Oct 2026).
//
// business_profile.accent_color is one of a few presets (backend
// logo_service.ACCENT_COLOR_PALETTE: emerald, blue, slate, terracotta,
// charcoal, burgundy and — R5 — gold). On the public booking page it paints
// the picked chips and the main button. A colour is never trusted to carry
// white text: gold and emerald are LIGHT (white on gold is ~2.3:1), so the
// text is picked by contrast, and anything that still falls short is nudged
// until it reads. WCAG 2.2 numbers throughout:
//   text on the accent          ≥ 4.5:1 (AA, normal text)
//   the accent's edge vs ground ≥ 3:1   (1.4.11, non-text: a picked chip must
//                                        be told apart from the page)
// The guard is pure and deterministic (tests: r5.accentColor.test.js); the
// page passes its result to CSS as custom properties (index.css, "BOOKING
// ACCENT"). No accent → null → the page keeps BonBox's own look exactly.
// The gavekort card uses readableOn / readableInk for the same reason
// (components/GavekortCard.jsx; the PDF mirrors it in logo_service.py).

export const ACCENT_INK = "#111827"; // gray-900, the page's own ink
export const ACCENT_WHITE = "#FFFFFF";
export const GROUND_LIGHT = "#FFFFFF"; // the booking page's ground
export const GROUND_DARK = "#030712"; // gray-950, the standalone page in dark

/** Said on window when the owner changes how the booking page looks, so an
 *  open preview (WebsiteBookingKit) reloads and shows it. */
export const BOOKING_LOOK_EVENT = "bonbox-booking-look-changed";

/** The presets, in the order the owner sees them (Standard first, then these). */
export const ACCENT_PRESETS = ["gold", "terracotta", "burgundy", "emerald", "blue", "slate", "charcoal"];

const HEX = /^#([0-9a-f]{6})$/i;

/** {r,g,b} for a "#RRGGBB" (surrounding spaces allowed), else null. */
export function parseHex(value) {
  const m = HEX.exec(String(value ?? "").trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function toHex({ r, g, b }) {
  const part = (x) => Math.round(Math.max(0, Math.min(255, x))).toString(16).padStart(2, "0");
  return ("#" + part(r) + part(g) + part(b)).toUpperCase();
}

/** "#RRGGBB" upper-case, or null when it is not one. */
export function normalizeHex(value) {
  const rgb = parseHex(value);
  return rgb ? toHex(rgb) : null;
}

/** WCAG relative luminance (0..1); null for a non-colour. */
export function luminance(value) {
  const rgb = parseHex(value);
  if (!rgb) return null;
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(rgb.r) + 0.7152 * lin(rgb.g) + 0.0722 * lin(rgb.b);
}

/** WCAG contrast ratio (1..21). 1 when either is not a colour — never a false pass. */
export function contrast(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  if (la == null || lb == null) return 1;
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** `a` moved toward `b` by t (0..1), in sRGB. */
export function mix(a, b, t) {
  const x = parseHex(a);
  const y = parseHex(b);
  if (!x || !y) return normalizeHex(a);
  return toHex({ r: x.r + (y.r - x.r) * t, g: x.g + (y.g - x.g) * t, b: x.b + (y.b - x.b) * t });
}

// Step `from` toward `toward` (4 % at a time) until `ok`; `toward` itself last.
function nudge(from, toward, ok) {
  for (let i = 0; i <= 25; i += 1) {
    const c = mix(from, toward, i * 0.04);
    if (ok(c)) return c;
  }
  return normalizeHex(toward);
}

/** The text colour to write ON `bg`: `light` when it reads (AA), else whichever reads better. */
export function readableOn(bg, light = ACCENT_WHITE, dark = ACCENT_INK) {
  if (contrast(light, bg) >= 4.5) return light;
  return contrast(light, bg) >= contrast(dark, bg) ? light : dark;
}

/** The accent as TEXT on `ground`: unchanged when it reads, else deepened just enough. */
export function readableInk(accent, ground, minimum = 4.5) {
  if (!parseHex(accent) || !parseHex(ground)) return accent;
  if (contrast(accent, ground) >= minimum) return accent;
  return nudge(accent, "#000000", (c) => contrast(c, ground) >= minimum);
}

/**
 * Everything the page needs to paint an accent, or null (no accent, or not a
 * colour) — the page then keeps BonBox's own look.
 *   bg       the fill actually painted (the owner's colour, nudged only when
 *            neither white nor ink could reach 4.5:1 on it)
 *   fg       the text on it: white when white reads, else the ink
 *   fgQuiet  the softer second line in a picked tile (day name, month,
 *            "2 left"), still ≥ 4.5:1 on bg
 *   hover    the button's hover fill, text still ≥ 4.5:1
 *   edge     a 1 px edge on a light page: the colour itself when it already
 *            stands 3:1 from white, else deepened until it does (gold, emerald)
 *   edgeDark the same on the dark standalone page (charcoal, burgundy, slate)
 */
export function accentTokens(value) {
  const base = normalizeHex(value);
  if (!base) return null;
  let fg = contrast(ACCENT_WHITE, base) >= 4.5 ? ACCENT_WHITE
    : contrast(ACCENT_INK, base) >= 4.5 ? ACCENT_INK
    : contrast(ACCENT_WHITE, base) >= contrast(ACCENT_INK, base) ? ACCENT_WHITE : ACCENT_INK;
  let bg = base;
  if (contrast(fg, bg) < 4.5) {
    bg = nudge(base, fg === ACCENT_WHITE ? "#000000" : "#FFFFFF", (c) => contrast(fg, c) >= 4.5);
  }
  if (contrast(fg, bg) < 4.5) fg = readableOn(bg); // belt and braces: never below AA
  let fgQuiet = fg;
  for (const t of [0.22, 0.12]) {
    const c = mix(fg, bg, t);
    if (contrast(c, bg) >= 4.5) {
      fgQuiet = c;
      break;
    }
  }
  const darker = mix(bg, "#000000", 0.08);
  const lighter = mix(bg, "#FFFFFF", 0.1);
  const hover = contrast(fg, darker) >= 4.5 ? darker : contrast(fg, lighter) >= 4.5 ? lighter : bg;
  const edge = contrast(bg, GROUND_LIGHT) >= 3 ? bg : nudge(bg, "#000000", (c) => contrast(c, GROUND_LIGHT) >= 3);
  const edgeDark = contrast(bg, GROUND_DARK) >= 3 ? bg : nudge(bg, "#FFFFFF", (c) => contrast(c, GROUND_DARK) >= 3);
  return { base, bg, fg, fgQuiet, hover, edge, edgeDark, adjusted: bg !== base };
}

/** CSS custom properties for a booking root (index.css "BOOKING ACCENT"), or undefined. */
export function accentStyle(tokens) {
  if (!tokens) return undefined;
  return {
    "--bb-accent": tokens.bg,
    "--bb-accent-fg": tokens.fg,
    "--bb-accent-fg-quiet": tokens.fgQuiet,
    "--bb-accent-hover": tokens.hover,
    "--bb-accent-edge": tokens.edge,
    "--bb-accent-edge-dark": tokens.edgeDark,
  };
}
