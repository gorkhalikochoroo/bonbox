/**
 * Booking R16 — light gradient and texture sites get a card that fits
 * (Manoj, 29 Oct 2026, after R15: a cream site whose background is a colour
 * gradient or a tiled paper texture got the heavy #171717 card, a black slab
 * on a cream page — R15 harness shot gradient-step1-picked-390).
 *
 *   host   /static/embed1.js, surface():
 *          - a gradient only (no url()): every stop, laid on the element's own
 *            background-color, is light or dark against the frame's own line
 *            (luminance 0.18, bookingLook.js `L(pl) < 0.18`). When that colour
 *            is clear or translucent it is itself laid on what lies under it
 *            (the ancestors' surface; white when none; a photo there → "photo")
 *            — fix 1. All one side → their average as a hex, and the frame
 *            paints it as a plain colour site (R13's tinted card).
 *            Mixed, or a value it cannot read → "photo", as before.
 *          - an image not drawn at "cover" (texture, logo, stretched) with no
 *            gradient layer: the element's opaque background-color, else
 *            "photo" (fix 2).
 *          - a cover photo: "photo" + glass (R15), unchanged.
 *   frame  unchanged: it already handles a colour surface.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMBED_SCRIPT_PATH, LOOK_GLASS_BLUR, iframeSnippet } from "../utils/bookingEmbed";
import { LOOK_FONTS, LOOK_GLASS, LOOK_RADII, lookFrom } from "../lib/bookingLook";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOSTED = fs.readFileSync(path.join(FRONTEND, "public", EMBED_SCRIPT_PATH), "utf8");
const ORIGIN = "https://www.bonbox.dk";
const base = { publicUrl: "https://www.bonbox.dk/cafe", label: "Book bord", venueName: "Café", fallbackLabel: "Åbn booking →" };
const AUTO = { mode: "auto", accent: "site" };
const look = (q) => lookFrom(q, LOOK_RADII, LOOK_FONTS);
const SAFE_Q =
  /^look=1(&theme=(light|dark))?(&scheme=(light|dark|ld))?(&surface=([0-9a-f]{6}|photo))?(&ink=[0-9a-f]{6})?(&accent=[0-9a-f]{6}(&accent_ink=[0-9a-f]{6})?)?(&radius=(sharp|soft|round))?(&font=(system|helvetica|georgia|times))?(&glass=1)?$/;

// ── The host half in jsdom (as r15.glassCard), with the browser's computed style stubbed ──
const pasted = [];
function host({ css = "", body }) {
  const s = iframeSnippet({ ...base, compact: true, look: AUTO, hosted: true });
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  document.body.innerHTML = body.replace("{SNIPPET}", s.replace(/<script[\s\S]*<\/script>/, ""));
  window.CSS = { supports: () => true }; // a browser that can blur: glass is possible, so its absence means something
  const observers = [];
  const RealMO = window.MutationObserver;
  window.MutationObserver = class extends RealMO {
    constructor(cb) {
      super(cb);
      observers.push(this);
    }
  };
  const listeners = [];
  const realAdd = window.addEventListener;
  window.addEventListener = function (type, fn, opts) {
    if (type === "message") listeners.push(fn);
    return realAdd.call(this, type, fn, opts);
  };
  const frame = document.querySelector("iframe[data-bonbox-booking]");
  const posted = [];
  frame.contentWindow.postMessage = (msg, origin) => posted.push({ msg, origin });
  const blurs = [];
  const real = frame.style.setProperty.bind(frame.style);
  frame.style.setProperty = (p, v, pr) => {
    if (/backdrop-filter$/.test(p)) blurs.push(v);
    return real(p, v, pr);
  };
  try {
    const tag = document.createElement("script");
    tag.src = /<script src="([^"]+)">/.exec(s)[1];
    Object.defineProperty(document, "currentScript", { value: tag, configurable: true });
    try {
      new Function("location", HOSTED)({ protocol: "https:" });
    } finally {
      delete document.currentScript;
    }
  } finally {
    window.addEventListener = realAdd;
    window.MutationObserver = RealMO;
  }
  pasted.push({ style, observers, listeners });
  window.dispatchEvent(new MessageEvent("message", { data: { type: "bonbox:ready" }, origin: ORIGIN, source: frame.contentWindow }));
  const looks = posted.filter((p) => p.msg.type === "bonbox:look");
  return { q: looks.length ? looks[looks.length - 1].msg.q : null, origin: looks[0]?.origin, blurs };
}
// The computed style the browser gives the .hero (a Proxy over jsdom's real one)
function stubHero(values) {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const st = real(el, pseudo);
    return el.classList?.contains("hero") ? new Proxy(st, { get: (t, k) => (k in values ? values[k] : Reflect.get(t, k)) }) : st;
  });
}
const surfaceOf = (q) => (/&surface=([0-9a-f]{6}|photo)/.exec(q) || [])[1] ?? null;
// R16 fix 1: the .hero and the <body> under it, both stubbed (stubHero leaves the body clear, as jsdom does)
function stubHeroOnBody(hero, body) {
  const real = window.getComputedStyle.bind(window);
  vi.spyOn(window, "getComputedStyle").mockImplementation((el, pseudo) => {
    const st = real(el, pseudo);
    const values = el.classList?.contains("hero") ? hero : el === document.body ? body : null;
    return values ? new Proxy(st, { get: (t, k) => (k in values ? values[k] : Reflect.get(t, k)) }) : st;
  });
}

// A cream site: dark ink, a dark pill button; the .hero's background comes from the stub.
const SITE = `
  body { color: #2a2118; font-family: Georgia, serif; margin: 0; }
  .btn { background-color: #3b2a1a; color: #ffffff; border-radius: 999px; }`;
const BODY = '<div class="hero"><a class="btn" href="#menu">Se menu</a><div class="col">{SNIPPET}</div></div>';
const CLEAR = "rgba(0, 0, 0, 0)";
function run(backgroundImage, { backgroundColor = CLEAR, backgroundSize = "auto" } = {}) {
  stubHero({ backgroundImage, backgroundColor, backgroundSize });
  return host({ css: SITE, body: BODY });
}

// independent arithmetic for the expectations (sRGB relative luminance, as bookingLook.js L)
const lum = (hex) =>
  [0, 1, 2].reduce((o, i) => {
    const s = parseInt(hex.slice(2 * i, 2 * i + 2), 16) / 255;
    return o + [0.2126, 0.7152, 0.0722][i] * (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
  }, 0);

const box = () =>
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(() => ({ width: 120, height: 40, top: 0, left: 0, right: 120, bottom: 40, x: 0, y: 0 }));
// a second site in the same test: a fresh copy of the script, a fresh stub
function fresh() {
  vi.restoreAllMocks();
  box();
  delete window.__bonboxEmbed1;
}
beforeEach(() => {
  box();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const p of pasted) {
    p.style.remove();
    for (const o of p.observers) o.disconnect();
    for (const fn of p.listeners) window.removeEventListener("message", fn);
  }
  pasted.length = 0;
  delete window.__bonboxEmbed1;
  delete window.CSS;
  document.body.innerHTML = "";
});

describe("a gradient only: all light or all dark → its average colour, painted as a plain colour site", () => {
  it("cream linear-gradient → a light hex: the posted look has a light ground, no glass, no blur", () => {
    const { q, origin, blurs } = run("linear-gradient(rgb(250, 247, 242), rgb(255, 251, 245))");
    expect(q).toMatch(SAFE_Q);
    expect(origin).toBe(ORIGIN);
    expect(surfaceOf(q)).toBe("fdf9f4"); // (252.5, 249, 243.5) rounded
    expect(lum("fdf9f4")).toBeGreaterThanOrEqual(0.18);
    expect(q).not.toContain("glass");
    expect(blurs.every((v) => v === "")).toBe(true);
    const l = look("?" + q);
    expect(l).toMatchObject({ dark: false, glass: null, well: null, ph: null });
    expect(l.card).not.toBe("#171717");
    expect(lum(l.card.slice(1))).toBeGreaterThanOrEqual(0.93); // R13's light card
  });

  it("a dark gradient → a dark hex: R13's tinted dark card, not the photo's #171717", () => {
    const { q } = run("linear-gradient(135deg, rgb(20, 20, 30) 0%, rgb(40, 30, 30) 100%)");
    expect(surfaceOf(q)).toBe("1e191e");
    expect(lum("1e191e")).toBeLessThan(0.18);
    expect(q).not.toContain("glass");
    const l = look("?" + q);
    expect(l).toMatchObject({ dark: true, glass: null });
    expect(l.card).not.toBe("#171717");
  });

  it("black to white → mixed → \"photo\" (unchanged: today's opaque dark card, no glass)", () => {
    const { q, blurs } = run("linear-gradient(rgb(0, 0, 0), rgb(255, 255, 255))");
    expect(surfaceOf(q)).toBe("photo");
    expect(q).not.toContain("glass");
    expect(blurs.every((v) => v === "")).toBe(true);
    expect(look("?" + q)).toMatchObject({ dark: true, card: "#171717", glass: null });
  });

  it("rgba stops are laid over white when the element's own colour is clear", () => {
    // (200,100,0)@0.1 over white = (249.5, 239.5, 229.5); black@0.05 over white = 242.25 → average (245.9, 240.9, 235.9)
    const { q } = run("linear-gradient(rgba(200, 100, 0, 0.1), rgba(0, 0, 0, 0.05))");
    expect(surfaceOf(q)).toBe("f6f1ec");
    expect(look("?" + q).dark).toBe(false);
  });

  it("…and over the element's own background-color when it has one (a dark wash on a cream base)", () => {
    // black@0.5 over (240, 230, 210) = (120, 115, 105): every stop dark → dark average (120, 115, 105)
    const { q } = run("linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5))", { backgroundColor: "rgb(240, 230, 210)" });
    expect(surfaceOf(q)).toBe("787369");
    expect(look("?" + q).dark).toBe(true);
  });

  it("a translucent base colour is itself laid over white first", () => {
    // base black@0.1 over white = 229.5; the clear stop shows it, the opaque one is itself
    const { q } = run("linear-gradient(rgba(0, 0, 0, 0), rgb(255, 255, 255))", { backgroundColor: "rgba(0, 0, 0, 0.1)" });
    expect(surfaceOf(q)).toBe("f2f2f2"); // (229.5 + 255) / 2 = 242.25
  });

  it("`transparent` stops (either spelling) show the base colour", () => {
    // (250, 246, 238) and black@0.04 on it = (240, 236.16, 228.48) → (245, 241.08, 233.24)
    const a = run("linear-gradient(transparent, rgba(0, 0, 0, 0.04))", { backgroundColor: "rgb(250, 246, 238)" });
    expect(surfaceOf(a.q)).toBe("f5f1e9");
    fresh();
    const b = run("linear-gradient(rgba(0, 0, 0, 0), rgba(0, 0, 0, 0.04))", { backgroundColor: "rgb(250, 246, 238)" });
    expect(surfaceOf(b.q)).toBe("f5f1e9");
  });

  it("two gradient layers: every stop of both counts", () => {
    // (255,250,240) (250,240,225) (245,235,220) and transparent→white: average (251.25, 245, 235)
    const { q } = run(
      "linear-gradient(rgb(255, 250, 240), rgb(250, 240, 225)), radial-gradient(circle at 50% 50%, rgb(245, 235, 220) 0%, rgba(0, 0, 0, 0) 70%)",
      { backgroundSize: "auto, auto" },
    );
    expect(surfaceOf(q)).toBe("fbf5eb");
    expect(look("?" + q).dark).toBe(false);
  });

  it("two layers, one light and one dark → mixed → \"photo\"", () => {
    const { q } = run("linear-gradient(rgb(250, 247, 242), rgb(255, 255, 255)), linear-gradient(rgb(20, 20, 20), rgb(30, 30, 30))");
    expect(surfaceOf(q)).toBe("photo");
  });

  it("light stops whose average falls dark → \"photo\" (the average keeps its stops' side, or nothing is said)", () => {
    // each stop is light on its own (luminance ≥ 0.18), their sRGB average is not
    const s1 = "ff3c00", s2 = "008cff";
    expect(lum(s1)).toBeGreaterThanOrEqual(0.18);
    expect(lum(s2)).toBeGreaterThanOrEqual(0.18);
    expect(lum("806480")).toBeLessThan(0.18);
    const { q } = run("linear-gradient(rgb(255, 60, 0), rgb(0, 140, 255))");
    expect(surfaceOf(q)).toBe("photo");
  });

  it("what it cannot read is \"photo\": a #hex stop (never the browser's own serialization), an unknown colour function", () => {
    expect(surfaceOf(run("linear-gradient(#faf7f2, #ffffff)").q)).toBe("photo");
    fresh();
    expect(surfaceOf(run("linear-gradient(oklch(0.97 0.01 80), rgb(255, 255, 255))").q)).toBe("photo");
  });
});

describe("an image that is not a cover photo: the opaque colour under it", () => {
  it("a texture (url + auto) on an opaque cream base → that colour, a light card, no glass", () => {
    const { q, blurs } = run('url("https://trattoria.example/paper.png")', { backgroundColor: "rgb(244, 236, 220)" });
    expect(q).toMatch(SAFE_Q);
    expect(surfaceOf(q)).toBe("f4ecdc");
    expect(q).not.toContain("glass");
    expect(blurs.every((v) => v === "")).toBe(true);
    expect(look("?" + q)).toMatchObject({ dark: false, glass: null });
  });

  it("a logo (contain) or a stretched image (100% 100%) on an opaque base → that colour too", () => {
    expect(surfaceOf(run('url("logo.svg")', { backgroundColor: "rgb(244, 236, 220)", backgroundSize: "contain" }).q)).toBe("f4ecdc");
    fresh();
    expect(surfaceOf(run('url("photo.jpg")', { backgroundColor: "rgb(43, 37, 32)", backgroundSize: "100% 100%" }).q)).toBe("2b2520");
  });

  it("a texture with no base colour (or a translucent one) → \"photo\", unchanged", () => {
    const { q, blurs } = run('url("https://trattoria.example/paper.png")');
    expect(surfaceOf(q)).toBe("photo");
    expect(q).not.toContain("glass");
    expect(blurs.every((v) => v === "")).toBe(true);
    expect(look("?" + q)).toMatchObject({ dark: true, card: "#171717", glass: null });
    fresh();
    expect(surfaceOf(run('url("paper.png")', { backgroundColor: "rgba(244, 236, 220, 0.9)" }).q)).toBe("photo");
  });
});

// R16 fix 1 (review, 29 Oct): a clear or translucent gradient element was laid on white, so a soft sheen
// on a dark page read light and got a near-white card on a black page. Its ground is what lies under it.
describe("fix 1: a gradient on a clear (or translucent) element lies on what is under it, not on white", () => {
  const DARK_BODY = { backgroundImage: "none", backgroundColor: "rgb(17, 17, 17)" };
  const onDark = (backgroundImage, backgroundColor = CLEAR) => {
    stubHeroOnBody({ backgroundImage, backgroundColor, backgroundSize: "auto" }, DARK_BODY);
    return host({ css: SITE, body: BODY });
  };

  it.each([
    // each stop over #111 (17): white@0.04 → 26.52, transparent → 17: mean 21.76 → 0x16
    ["a 4 % white sheen", "linear-gradient(rgba(255, 255, 255, 0.04), transparent)", "161616"],
    // gold@0.15 over 17 → (44.6, 39.05, 28.25), clear → 17: mean (30.8, 28.03, 22.63)
    ["a 15 % gold glow", "radial-gradient(rgba(201, 164, 92, 0.15), rgba(0, 0, 0, 0) 60%)", "1f1c17"],
    // black@0.1 → 15.3, black@0.3 → 11.9: mean 13.6 → 0x0e
    ["a 10 → 30 % black wash", "linear-gradient(rgba(0, 0, 0, 0.1), rgba(0, 0, 0, 0.3))", "0e0e0e"],
  ])("a dark body (#111) with %s on a clear .hero → a dark hex, never a light surface", (_, g, hex) => {
    const { q, blurs } = onDark(g);
    expect(q).toMatch(SAFE_Q);
    expect(surfaceOf(q)).toBe(hex);
    expect(lum(hex)).toBeLessThan(0.18);
    expect(q).not.toContain("glass");
    expect(blurs.every((v) => v === "")).toBe(true);
    const l = look("?" + q);
    expect(l).toMatchObject({ dark: true, glass: null });
    expect(lum(l.card.slice(1))).toBeLessThan(0.18);
  });

  it("a translucent own colour is laid on the dark body first, then the stops on that", () => {
    // white@0.1 over 17 → 40.8; white@0.04 over 40.8 → 49.37, transparent → 40.8: mean 45.08 → 0x2d
    const { q } = onDark("linear-gradient(rgba(255, 255, 255, 0.04), transparent)", "rgba(255, 255, 255, 0.1)");
    expect(surfaceOf(q)).toBe("2d2d2d");
    expect(look("?" + q).dark).toBe(true);
  });

  it("a light body lends its colour too: black@4 % on cream is a cream tint, not a grey", () => {
    // (250, 246, 238) and black@0.04 on it (240, 236.16, 228.48): mean (245, 241.08, 233.24)
    stubHeroOnBody(
      { backgroundImage: "linear-gradient(rgba(0, 0, 0, 0.04), transparent)", backgroundColor: CLEAR, backgroundSize: "auto" },
      { backgroundImage: "none", backgroundColor: "rgb(250, 246, 238)" },
    );
    const { q } = host({ css: SITE, body: BODY });
    expect(surfaceOf(q)).toBe("f5f1e9");
    expect(look("?" + q).dark).toBe(false);
  });

  it("a cover-photo parent under a 45 % black overlay gradient → \"photo\" (as before R16: no glass, the opaque dark card)", () => {
    stubHeroOnBody(
      { backgroundImage: "linear-gradient(rgba(0, 0, 0, 0.45), rgba(0, 0, 0, 0.45))", backgroundColor: CLEAR, backgroundSize: "auto" },
      { backgroundImage: 'url("https://trattoria.example/photo.jpg")', backgroundColor: CLEAR, backgroundSize: "cover" },
    );
    const { q, blurs } = host({ css: SITE, body: BODY });
    expect(q).toMatch(SAFE_Q);
    expect(surfaceOf(q)).toBe("photo");
    expect(q).not.toContain("glass");
    expect(blurs.every((v) => v === "")).toBe(true);
    expect(look("?" + q)).toMatchObject({ dark: true, card: "#171717", glass: null });
  });

  it("an opaque own colour hides what is under it: the photo below does not matter", () => {
    // black@0.5 over (240, 230, 210) = (120, 115, 105), as on a page with nothing under it
    stubHeroOnBody(
      { backgroundImage: "linear-gradient(rgba(0, 0, 0, 0.5), rgba(0, 0, 0, 0.5))", backgroundColor: "rgb(240, 230, 210)", backgroundSize: "auto" },
      { backgroundImage: 'url("photo.jpg")', backgroundColor: CLEAR, backgroundSize: "cover" },
    );
    expect(surfaceOf(host({ css: SITE, body: BODY }).q)).toBe("787369");
  });
});

// R16 fix 2 (review, 29 Oct): a gradient painted with an image not at cover changes what shows; the base
// colour alone is not the surface. `rgba(0,0,0,.6)` over a texture on #f4ecdc really reads about #625f58.
describe("fix 2: an image not at cover with a gradient layer → \"photo\", not the base colour", () => {
  it.each([
    ["a dark wash over a texture", 'linear-gradient(rgba(0, 0, 0, 0.6), rgba(0, 0, 0, 0.6)), url("https://trattoria.example/tex.png")'],
    ["a texture over a gradient", 'url("https://trattoria.example/tex.png"), linear-gradient(rgb(20, 20, 20), rgb(30, 30, 30))'],
  ])("%s at `auto, auto` on an opaque cream base → \"photo\", no glass (as before R16)", (_, g) => {
    const { q, blurs } = run(g, { backgroundColor: "rgb(244, 236, 220)", backgroundSize: "auto, auto" });
    expect(q).toMatch(SAFE_Q);
    expect(surfaceOf(q)).toBe("photo");
    expect(q).not.toContain("glass");
    expect(blurs.every((v) => v === "")).toBe(true);
    expect(look("?" + q)).toMatchObject({ dark: true, card: "#171717", glass: null });
  });
});

describe("unchanged", () => {
  it("a cover photo still gets glass (R15), whatever colour sits under it", () => {
    const { q, blurs } = run('url("https://trattoria.example/photo.jpg")', { backgroundColor: "rgb(244, 236, 220)", backgroundSize: "cover" });
    expect(surfaceOf(q)).toBe("photo");
    expect(q).toMatch(/&glass=1$/);
    expect(blurs[blurs.length - 1]).toBe(LOOK_GLASS_BLUR);
    expect(look("?" + q).glass).toBe(LOOK_GLASS.card);
  });

  it("a gradient over a cover photo (auto, cover) is still the photo, with glass", () => {
    const { q } = run('linear-gradient(rgba(0, 0, 0, 0.35), rgba(0, 0, 0, 0.35)), url("photo.jpg")', { backgroundSize: "auto, cover" });
    expect(surfaceOf(q)).toBe("photo");
    expect(q).toMatch(/&glass=1$/);
  });

  it("a plain colour site is read exactly as before", () => {
    const { q } = run("none", { backgroundColor: "rgb(250, 247, 242)" });
    expect(surfaceOf(q)).toBe("faf7f2");
  });

  it("the R13 snippet is byte for byte the same, and the R4 snippet too", () => {
    const NEW = [
      '<div data-bonbox-booking-wrap style="width:100%;max-width:460px;margin:0 auto">',
      '  <iframe data-bonbox-booking data-bonbox-look="auto" src="https://www.bonbox.dk/r/cafe?embed=1&amp;compact=1&amp;look=1"',
      '    title="Book bord — Café" width="100%" height="720" loading="lazy"',
      '    style="display:block;border:0;width:100%;border-radius:16px;color-scheme:light"></iframe>',
      '  <p data-bonbox-booking-link style="margin:8px 0 0;text-align:center;font:400 14px/1.4 system-ui,sans-serif">',
      '    <a href="https://www.bonbox.dk/cafe" target="_blank" rel="noopener">Åbn booking →</a>',
      "  </p>",
      '  <script src="https://www.bonbox.dk/static/embed1.js"></' + "script>",
      "</div>",
    ].join("\n");
    expect(iframeSnippet({ ...base, compact: true, look: AUTO, hosted: true })).toBe(NEW);
    // the R4 snippet (inline script, no look) as a34d267a gives it: 1,362 characters, this sha-256
    const r4 = iframeSnippet({ ...base, compact: true });
    expect(r4.length).toBe(1362);
    expect(crypto.createHash("sha256").update(r4).digest("hex")).toBe("174ac6056ca1959f4ff61e06fa99b204d4c94ad7e000f68389c1e716f3399aff");
    expect(r4).not.toMatch(/embed1\.js|look=1|glass|backdrop/);
  });

  it("the hosted file is still plain ES5", () => {
    expect(() => new Function(HOSTED)).not.toThrow();
    expect(HOSTED).not.toMatch(/=>|\blet\b|\bconst\b|`/);
  });
});
