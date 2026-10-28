// The embed matches the restaurant's website (booking R13, Manoj 27–28 Oct
// 2026: "auto match with them with detection").
//
// Two halves:
//   - the HOST half is the snippet's own script, on the restaurant's page
//     (utils/bookingEmbed.js lookScript): it reads the page — the surface
//     behind the booking, its text colour, its main button (colour, text,
//     corners) and its font — and hands the frame hex and enum values in the
//     address (`look=1&surface=f7f3ee&ink=1a1a1a&accent=c9a45c&accent_ink=
//     ffffff&radius=round&font=georgia`, `theme=light|dark` when the owner
//     forced one). On a later theme switch it posts the same query.
//   - the FRAME half is this file: lookFrom() reads that query STRICTLY
//     (hex `^[0-9a-f]{6}$`, enums from fixed lists, everything else ignored)
//     and computes every colour the page paints; applyLook() writes them as
//     custom properties and classes on <html> (index.css "BOOKING LOOK").
//     No value from the address ever reaches CSS or HTML: only colours this
//     file computed and ids from its own two lists.
//
// The frame half runs at the first paint, in the parse-time script
// (scripts/bookingBoot.mjs embeds both functions' source), so a dark site
// never sees a white card flash. Hence plain ES5 bodies with no comments
// inside — Function.prototype.toString copies them into index.html as-is —
// and no reference to anything outside each function: the id lists come in
// as arguments.
//
// The rules (each one tested in r13.bookingLook.test.js):
//   theme   forced by the owner, else from the surface (a photo is dark; a
//           colour is dark under relative luminance 0.18, where white and
//           black text read equally), else from the text (light text = a
//           dark page), else light.
//   card    light: near-white, 30 % of the site's surface mixed into white,
//           never darker than luminance 0.93 (our grey text keeps AA on it).
//           dark: one step lighter than the site (7 % white), never lighter
//           than luminance 0.035 (our dark-mode text keeps AA). A photo, a
//           site the owner forced to the other theme, or no surface: our own
//           card (white / gray-900).
//   tint    the quiet surface a step off the card (dark: 6 % white; light:
//           4 % black) — the trust strip, the tracks, fields and the receipt's
//           ticket in a looked dark frame (index.css).
//   ink     the site's text colour when it reads at AA (4.5:1) on EVERY quiet
//           surface it can sit on — the card, the tint, and in light also the
//           page's own gray-50 / gray-100 (the trust strip, the tiles, the
//           tracks); its softer line (text-gray-500…700) holds the same 4.5:1
//           on all of them (R13 fix: the trust line read 4.29–4.48:1 on the
//           strip of many dark sites when only the card was checked).
//           Otherwise ours.
//   accent  the site's button colour, through the R5 guard's rules
//           (utils/accentColor.js): some text colour — the button's own
//           first, then white, then the ink — must read on it at 4.5:1
//           WITHOUT changing the colour, and it must stand 2:1 apart from
//           the card (every BonBox preset does on white — the lightest, gold,
//           is 2.35:1 — a near-card colour does not). Quiet line, hover and a
//           3:1 edge as the guard makes them. Fails → the owner's colour,
//           then BonBox's own (the page's existing [data-bb-accent] rules).
//   radius  the site's button corners on our ladder: sharp / soft / round.
//   font    a system font from a short list (the booking page's CSP allows
//           fonts from 'self' only — no Google Fonts), else Inter stays.
//   scheme  the <iframe>'s own color-scheme on the host (light / dark / ld =
//           "light dark"), declared on this document too: when the two
//           differ, the browser paints the frame an OPAQUE canvas (CSS Color
//           Adjust), a box round the card on a dark site. None sent, none
//           declared — exactly as before.

/** The corner ladder ids (the site's button corners): sharp / soft / round.
 *  Their px live in index.css (.bb-r-sharp …: card, tile, button), so the
 *  HTML carries only the names. LOOK_RADII_PX is that table, for tests and
 *  the kit's sample sites. 9999 = a full pill. */
export const LOOK_RADII = ["sharp", "soft", "round"];
export const LOOK_RADII_PX = { sharp: [4, 4, 4], soft: [16, 12, 12], round: [24, 22, 9999] };

/** Font ids the frame accepts; each paints a system stack (index.css
 *  .bb-f-*). System fonts only: nothing to download, and the booking page's
 *  CSP (vercel.json, font-src 'self' data:) would refuse a Google font. */
export const LOOK_FONTS = ["system", "helvetica", "georgia", "times"];

/**
 * The look an embed address asks for, computed and safe — or null.
 * `q` is a location.search ("?embed=1&look=1&…"). Nothing happens without
 * `look=1`: an address without it (every snippet pasted before R13) is the
 * page exactly as before. Short names on purpose (this body is copied into
 * every page's HTML): L luminance, C contrast, M mix, hx a hex parameter,
 * en an enum parameter, dk dark, cd card, so the softer ink, A the accent.
 */
export function lookFrom(q, R, F) {
  var p = {}, m, re = /[?&]([a-z_]{1,12})=([^&#]{0,16})/g, has = Object.prototype.hasOwnProperty, W = "#FFFFFF", K = "#000000";
  while ((m = re.exec(String(q || "")))) if (!has.call(p, m[1])) p[m[1]] = m[2];
  if (p.look !== "1") return null;
  var hx = function (k) { return /^[0-9a-f]{6}$/.test(p[k] || "") ? "#" + p[k] : null; };
  var en = function (o, k) { return o.indexOf(p[k]) >= 0 ? p[k] : null; };
  var L = function (h) { var n = parseInt(h.slice(1), 16), o = 0, i, s; for (i = 0; i < 3; i++) { s = ((n >> (16 - 8 * i)) & 255) / 255; o += [0.2126, 0.7152, 0.0722][i] * (s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4)); } return o; };
  var C = function (a, b) { var x = L(a), y = L(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
  var M = function (a, b, t) { var x = parseInt(a.slice(1), 16), y = parseInt(b.slice(1), 16), o = "#", i, u; for (i = 16; i >= 0; i -= 8) { u = (x >> i) & 255; o += ("0" + Math.round(u + (((y >> i) & 255) - u) * t).toString(16)).slice(-2); } return o.toUpperCase(); };
  var th = p.theme == "dark" || p.theme == "light" ? p.theme : null, sf = p.surface == "photo" ? "photo" : hx("surface"), pl = sf == "photo" ? null : sf;
  var ink = hx("ink"), ac = hx("accent"), ai = hx("accent_ink"), A = null, so = null, i = 0, cd, f, c, e;
  var dk = th ? th == "dark" : sf == "photo" || (pl ? L(pl) < 0.18 : !!ink && L(ink) > 0.5);
  if (!dk) { cd = pl && L(pl) >= 0.18 ? M(W, pl, 0.3) : W; while (L(cd) < 0.93 && i++ < 40) cd = M(cd, W, 0.1); }
  else if (pl && L(pl) < 0.18) { cd = M(pl, W, 0.07); while (L(cd) > 0.035 && i++ < 40) cd = M(cd, K, 0.1); }
  else cd = "#111827";
  var tn = dk ? M(cd, W, 0.06) : M(cd, K, 0.04), Q = dk ? [cd, tn] : [cd, tn, "#F9FAFB", "#F3F4F6"];
  var lo = function (x) { var r = 99, j; for (j = 0; j < Q.length; j++) r = Math.min(r, C(x, Q[j])); return r; };
  if (ink && lo(ink) >= 4.5) { so = ink; for (i = 0; i < 4; i++) { c = M(ink, cd, [0.45, 0.35, 0.25, 0.15][i]); if (lo(c) >= 4.5) { so = c; break; } } } else ink = null;
  if (ac) {
    f = ai && C(ai, ac) >= 4.5 ? ai : C(W, ac) >= 4.5 ? W : C("#111827", ac) >= 4.5 ? "#111827" : null;
    if (f && C(ac, cd) >= 2) {
      A = { bg: ac, fg: f, quiet: f, hover: ac, edge: ac };
      for (i = 0; i < 2; i++) { c = M(f, ac, [0.22, 0.12][i]); if (C(c, ac) >= 4.5) { A.quiet = c; break; } }
      c = M(ac, K, 0.08); e = M(ac, W, 0.1); A.hover = C(f, c) >= 4.5 ? c : C(f, e) >= 4.5 ? e : ac;
      for (i = 1; C(A.edge, cd) < 3 && i <= 25; i++) A.edge = M(ac, dk ? W : K, i * 0.04);
    }
  }
  return { dark: dk, card: cd, tint: tn, ink: ink, soft: so, accent: A, radius: en(R, "radius"), font: en(F, "font"), scheme: en(["light", "dark", "ld"], "scheme") };
}

/** Paint a look (lookFrom's result) on the document: classes and custom
 *  properties on <html> only, every value computed above or one of the two
 *  id lists. Called again on a host theme switch: each part is set or
 *  cleared, never left over from the last look. */
export function applyLook(d, L, R, F) {
  var r = d.documentElement, s = r.style, c = r.classList, A = L.accent || {}, k, i;
  var v = {
    "--bb-card": L.card, "--bb-card-bar": L.card + "EB", "--bb-tint": L.tint, "--bb-ink": L.ink, "--bb-ink-soft": L.soft,
    "--bb-h-accent": A.bg, "--bb-h-fg": A.fg, "--bb-h-fg-quiet": A.quiet, "--bb-h-hover": A.hover, "--bb-h-edge": A.edge
  };
  for (k in v) if (v[k]) s.setProperty(k, v[k]); else s.removeProperty(k);
  s.colorScheme = L.scheme == "ld" ? "light dark" : L.scheme || "";
  for (i = 0; i < R.length; i++) c.toggle("bb-r-" + R[i], L.radius == R[i]);
  for (i = 0; i < F.length; i++) c.toggle("bb-f-" + F[i], L.font == F[i]);
  c.add("bb-look");
  c.toggle("dark", !!L.dark);
  c.toggle("bb-ink", !!L.ink);
  c.toggle("bb-hacc", !!L.accent);
}
