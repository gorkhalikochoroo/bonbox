/**
 * Booking R15 — a frosted-glass card on PHOTO sites (Manoj, 28 Oct 2026,
 * after the iPhone Simulator: on a bright warm photo — test host c,
 * "Trattoria Foto" — the #171717 card read as a heavy black block that did
 * not belong to the site; of three options he chose frosted glass).
 *
 *   host   /static/embed1.js: on a photo, where CSS.supports says the browser
 *          can, it blurs the photo behind the <iframe> (backdrop-filter on the
 *          frame element itself) and says so in the look it sends: &glass=1.
 *          Never before the frame has its look, never on a colour, never with
 *          the owner's "Lys", and it follows a site that toggles.
 *   frame  src/lib/bookingLook.js reads glass=1 strictly (only "1", only with
 *          surface=photo, only in a dark look): the card is ONE translucent
 *          dark layer on <html>, rgb(17 17 17 / 0.72); tiles, fields, tracks
 *          and the bar are translucent white on it; every text token keeps
 *          4.5:1 over a PURE WHITE patch of photo (the worst case); the picks
 *          and the main button keep the site's colour, opaque, through the R5
 *          guard exactly as on the opaque card.
 *   CSS    (index.css "BOOKING LOOK") no outer shadow and no room round the
 *          card: it fills the frame edge to edge, so the frame's own corners
 *          (the look's) clip the blur to the card.
 *   kit    the photo sample shows the glass where the owner's browser can.
 *   fallbacks: no support → today's opaque card; dark and light sites, the
 *          page on its own, the new snippet and the R4 snippet: unchanged.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const t = (k, fb) => DA[k] ?? (typeof fb === "string" ? fb : k);
  return { useLanguage: () => ({ lang: "da", setLang: () => {}, t }), LanguageProvider: ({ children }) => children };
});
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const { da } = await import("../i18n/da");
const { LOOK_FONTS, LOOK_GLASS, LOOK_RADII, applyLook, lookFrom } = await import("../lib/bookingLook");
const { EMBED_SCRIPT_PATH, LOOK_GLASS_BLUR, LOOK_SAMPLES, glassSupported, iframeSnippet, mailtoHref, sampleLookQuery } =
  await import("../utils/bookingEmbed");
const { bookingBootSource } = await import("../../scripts/bookingBoot.mjs");
const WebsiteBookingKit = (await import("../components/reservations/WebsiteBookingKit")).default;

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOSTED = fs.readFileSync(path.join(FRONTEND, "public", EMBED_SCRIPT_PATH), "utf8");
const CSS_TEXT = fs.readFileSync(path.join(FRONTEND, "src", "index.css"), "utf8");
const ORIGIN = "https://www.bonbox.dk";
const base = { publicUrl: "https://www.bonbox.dk/cafe", label: "Book bord", venueName: "Café", fallbackLabel: "Åbn booking →" };
const AUTO = { mode: "auto", accent: "site" };
const look = (q) => lookFrom(q, LOOK_RADII, LOOK_FONTS);
const html = () => document.documentElement;
// Every query the script may send: hex digits and fixed words, in its order — and now glass=1 last.
const SAFE_Q =
  /^look=1(&theme=(light|dark))?(&scheme=(light|dark|ld))?(&surface=([0-9a-f]{6}|photo))?(&ink=[0-9a-f]{6})?(&accent=[0-9a-f]{6}(&accent_ink=[0-9a-f]{6})?)?(&radius=(sharp|soft|round))?(&font=(system|helvetica|georgia|times))?(&glass=1)?$/;

// ── The host half, run in jsdom on stand-in websites (as r13.embedLook) ──
const pasted = [];
function host({ css = "", body = "<main>{SNIPPET}</main>", lookChoice = AUTO, snippet = null, supports = "both" } = {}) {
  const s = snippet || iframeSnippet({ ...base, compact: true, look: lookChoice, hosted: true });
  const style = document.createElement("style");
  style.textContent = css;
  document.head.appendChild(style);
  document.body.innerHTML = body.replace("{SNIPPET}", s.replace(/<script[\s\S]*<\/script>/, ""));
  // CSS.supports as the browser answers it: both forms, only Safari's -webkit- one, none, or no CSS.supports at all
  if (supports === "absent") delete window.CSS;
  else
    window.CSS = {
      supports: (p) => supports === "both" || (supports === "webkit" && p === "-webkit-backdrop-filter"),
    };
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
  const posted = [];
  // jsdom drops backdrop-filter from a style: record what the script sets instead
  const sets = new Map();
  for (const f of document.querySelectorAll("iframe[data-bonbox-booking]")) {
    f.contentWindow.postMessage = (msg, origin) => posted.push({ frame: f, msg, origin });
    const real = f.style.setProperty.bind(f.style);
    sets.set(f, []);
    f.style.setProperty = (p, v, pr) => {
      if (/backdrop-filter$/.test(p)) sets.get(f).push({ p, v });
      return real(p, v, pr);
    };
  }
  const srcBefore = [...document.querySelectorAll("iframe[data-bonbox-booking]")].map((f) => f.getAttribute("src"));
  try {
    const src = /<script src="([^"]+)">/.exec(s);
    if (src) {
      const tag = document.createElement("script");
      tag.src = src[1];
      Object.defineProperty(document, "currentScript", { value: tag, configurable: true });
      try {
        new Function("location", HOSTED)({ protocol: "https:" });
      } finally {
        delete document.currentScript;
      }
    } else {
      new Function("location", s.slice(s.indexOf("<script>") + 8, s.indexOf("</" + "script>")))({ protocol: "https:" });
    }
  } finally {
    window.addEventListener = realAdd;
    window.MutationObserver = RealMO;
  }
  pasted.push({ style, observers, listeners });
  const frame = document.querySelector("iframe[data-bonbox-booking]");
  const ready = (f = frame) =>
    window.dispatchEvent(new MessageEvent("message", { data: { type: "bonbox:ready" }, origin: ORIGIN, source: f.contentWindow }));
  const looks = (f = frame) => posted.filter((p) => p.frame === f && p.msg.type === "bonbox:look");
  const lastQ = (f = frame) => {
    const l = looks(f);
    return l.length ? l[l.length - 1].msg.q : null;
  };
  // the blur the script left on the frame ("" = none), for each spelling
  const blurOf = (f = frame, p = "backdrop-filter") => {
    const mine = (sets.get(f) || []).filter((x) => x.p === p);
    return mine.length ? mine[mine.length - 1].v : "";
  };
  const everBlurred = (f = frame) => (sets.get(f) || []).some((x) => x.v);
  return { frame, ready, looks, lastQ, blurOf, everBlurred, srcBefore };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const PHOTO = `
  body { color: #ffffff; font-family: system-ui, sans-serif; margin: 0; }
  .hero { background-color: #2b2520; background-image: url(photo.jpg); }
  .btn { background-color: #ffffff; color: #1a1a1a; border-radius: 8px; }
  html.plain .hero { background-image: none; background-color: #101010; }`;
const PHOTO_BODY = '<div class="hero"><a class="btn" href="#menu">Se menu</a><div class="col">{SNIPPET}</div></div>';

beforeEach(() => {
  h.get.mockReset();
  h.post.mockReset();
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
    return { width: 120, height: 40, top: 0, left: 0, right: 120, bottom: 40, x: 0, y: 0 };
  });
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  for (const p of pasted) {
    p.style.remove();
    for (const o of p.observers) o.disconnect();
    for (const fn of p.listeners) window.removeEventListener("message", fn);
  }
  pasted.length = 0;
  delete window.__bonboxEmbed1;
  delete window.CSS;
  delete window.__bbBooking;
  document.body.innerHTML = "";
  html().className = "";
  html().removeAttribute("style");
});

describe("host: on a photo, where the browser can blur, the frame gets glass", () => {
  it("the look says glass=1 and the photo behind the <iframe> is blurred — from the moment the frame has its look, not before", () => {
    const { frame, ready, looks, lastQ, blurOf, everBlurred } = host({ css: PHOTO, body: PHOTO_BODY });
    expect(looks()).toEqual([]);
    expect(everBlurred()).toBe(false); // waiting (painting nothing): no blurred box on the site
    ready();
    expect(lastQ()).toBe("look=1&surface=photo&ink=ffffff&accent=ffffff&accent_ink=1a1a1a&radius=soft&font=system&glass=1");
    expect(lastQ()).toMatch(SAFE_Q);
    expect(looks()[0].origin).toBe(ORIGIN);
    // the kit's photo sample IS this site, glass included
    expect(lastQ()).toBe(sampleLookQuery("photo", AUTO, { glass: true }));
    expect(blurOf()).toBe(LOOK_GLASS_BLUR);
    expect(blurOf(frame, "-webkit-backdrop-filter")).toBe(LOOK_GLASS_BLUR);
    expect(LOOK_GLASS_BLUR).toMatch(/^blur\((2[0-4])px\) saturate\(1\.[1-5]\)$/);
    // …and the frame makes the glass card of exactly that look
    expect(look("?" + lastQ()).glass).toBe(LOOK_GLASS.card);
  });

  it("Safari before 18 (only -webkit-backdrop-filter): glass too", () => {
    const { ready, lastQ, blurOf } = host({ css: PHOTO, body: PHOTO_BODY, supports: "webkit" });
    ready();
    expect(lastQ()).toMatch(/&glass=1$/);
    expect(blurOf(undefined, "-webkit-backdrop-filter")).toBe(LOOK_GLASS_BLUR);
  });

  it("the owner's 'Mørk' on a photo: glass; 'Lys': the light card, no glass, no blur", () => {
    const dark = host({ css: PHOTO, body: PHOTO_BODY, lookChoice: { mode: "dark", accent: "site" } });
    dark.ready();
    expect(dark.lastQ()).toMatch(/^look=1&theme=dark&surface=photo&.*&glass=1$/);
    expect(dark.blurOf()).toBe(LOOK_GLASS_BLUR);
    afterEachHost();
    const light = host({ css: PHOTO, body: PHOTO_BODY, lookChoice: { mode: "light", accent: "site" } });
    light.ready();
    expect(light.lastQ()).toMatch(/^look=1&theme=light&surface=photo&/);
    expect(light.lastQ()).not.toContain("glass");
    expect(light.everBlurred()).toBe(false);
    expect(look("?" + light.lastQ())).toMatchObject({ dark: false, glass: null });
  });
});

// one host per test is the rule above; this clears the first one mid-test
function afterEachHost() {
  for (const p of pasted) {
    p.style.remove();
    for (const o of p.observers) o.disconnect();
    for (const fn of p.listeners) window.removeEventListener("message", fn);
  }
  pasted.length = 0;
  delete window.__bonboxEmbed1;
  document.body.innerHTML = "";
}

describe("host: never otherwise — today's opaque card", () => {
  it.each(["none", "absent"])("no backdrop-filter support (CSS.supports: %s): nothing new is sent, nothing blurred", (supports) => {
    const { ready, lastQ, everBlurred } = host({ css: PHOTO, body: PHOTO_BODY, supports });
    ready();
    expect(lastQ()).toBe("look=1&surface=photo&ink=ffffff&accent=ffffff&accent_ink=1a1a1a&radius=soft&font=system");
    expect(everBlurred()).toBe(false);
    expect(look("?" + lastQ())).toMatchObject({ dark: true, card: "#171717", glass: null });
  });

  it.each([
    ["a dark colour site", "body { background-color: #0b0b0b; color: #eeeeee; }"],
    ["a light site", "body { background-color: #f4efe6; color: #2b2118; }"],
    ["a site with no surface at all", "body { color: #333333; }"],
  ])("%s, even where the browser can: no glass, no blur", (_name, css) => {
    const { ready, lastQ, everBlurred } = host({ css, body: "<div>{SNIPPET}</div>" });
    ready();
    expect(lastQ()).not.toContain("glass");
    expect(everBlurred()).toBe(false);
  });

  it("an R4 frame (no opt-in) on a photo page: never blurred, its address never changes — the new frame beside it is", () => {
    const R4 = iframeSnippet({ ...base, compact: true });
    const { ready, blurOf, everBlurred, srcBefore } = host({
      css: PHOTO,
      body: PHOTO_BODY.replace("{SNIPPET}", R4.replace(/<script>[\s\S]*<\/script>/, "") + "{SNIPPET}"),
    });
    const [old, mine] = document.querySelectorAll("iframe[data-bonbox-booking]");
    ready(old);
    ready(mine);
    expect(everBlurred(old)).toBe(false);
    expect(old.getAttribute("src")).toBe(srcBefore[0]);
    expect(blurOf(mine)).toBe(LOOK_GLASS_BLUR);
  });
});

describe("host: a site that toggles between its photo and a colour", () => {
  it("the look follows (glass on, off, on) and so does the blur; past the five changes the blur stays what the frame was last sent", async () => {
    const { frame, ready, looks, lastQ, blurOf, srcBefore } = host({ css: PHOTO, body: PHOTO_BODY });
    ready();
    expect(lastQ()).toMatch(/&glass=1$/);
    html().classList.add("plain");
    await wait(300);
    expect(lastQ()).toBe("look=1&surface=101010&ink=ffffff&accent=ffffff&accent_ink=1a1a1a&radius=soft&font=system");
    expect(blurOf()).toBe("");
    expect(blurOf(frame, "-webkit-backdrop-filter")).toBe("");
    html().classList.remove("plain");
    await wait(300);
    expect(lastQ()).toMatch(/&glass=1$/);
    expect(blurOf()).toBe(LOOK_GLASS_BLUR);
    for (let i = 0; i < 6; i += 1) {
      html().classList.toggle("plain");
      await wait(300);
    }
    expect(looks()).toHaveLength(6); // the first look and five changes
    expect(blurOf()).toBe(/&glass=1$/.test(lastQ()) ? LOOK_GLASS_BLUR : "");
    expect(frame.getAttribute("src")).toBe(srcBefore[0]); // never reloaded
  });

  it("only hex digits, fixed words and glass=1 leave the page — even from a hostile stylesheet on a photo", () => {
    const { ready, lastQ } = host({
      css: `
        body { font-family: "x;}</style><script>alert(1)</script>", serif; color: rgb(250 250 250 / 0.9); }
        .hero { background-image: url(photo.jpg), linear-gradient(red, blue); }
        .b { background-color: rgba(200, 30, 30, 0.95); color: currentColor; border-radius: 50%; }`,
      body: '<div class="hero"><button class="b">x</button>{SNIPPET}</div>',
    });
    ready();
    expect(lastQ()).toMatch(SAFE_Q);
    expect(lastQ()).toMatch(/&surface=photo&.*&glass=1$/);
  });

  it("the hosted file says the same blur as the owner's kit, and is still plain ES5", () => {
    expect(HOSTED).toContain(`"${LOOK_GLASS_BLUR}"`);
    expect(() => new Function(HOSTED)).not.toThrow();
    expect(HOSTED).not.toMatch(/=>|\blet\b|\bconst\b|`/);
  });
});

// ── The frame half ─────────────────────────────────────────────────────
const GLASS_Q = "?embed=1&compact=1&look=1&surface=photo&ink=ffffff&accent=ffffff&accent_ink=1a1a1a&radius=soft&font=system&glass=1";

describe("frame: glass=1 on a photo is the glass card", () => {
  it("one translucent dark layer, translucent white surfaces on it, white text, the site's white on the picks", () => {
    const l = look(GLASS_Q);
    expect(LOOK_GLASS).toEqual({ card: "#111111B8", tint: "#FFFFFF0F", tint2: "#FFFFFF2E", raise: "#FFFFFF1F", line: "#FFFFFF1F" });
    expect(l).toMatchObject({
      dark: true, glass: LOOK_GLASS.card, tint: LOOK_GLASS.tint, tint2: LOOK_GLASS.tint2, raise: LOOK_GLASS.raise,
      line: LOOK_GLASS.line, ink: "#ffffff", radius: "soft", font: "system",
    });
    // the picks and the main button: the site's colour, opaque, through the R5 guard exactly as on the opaque card
    expect(l.accent).toEqual(look(GLASS_Q.replace("&glass=1", "")).accent);
    expect(l.accent.bg).toBe("#ffffff");
  });

  it.each([
    "?embed=1&look=1&surface=0b0b0b&ink=eeeeee&glass=1", // a dark colour site
    "?embed=1&look=1&surface=f4efe6&ink=2b2118&glass=1", // a light site
    "?embed=1&look=1&glass=1", // no surface
    "?embed=1&look=1&theme=light&surface=photo&glass=1", // the owner's "Lys"
    "?embed=1&look=1&surface=photo&glass=2",
    "?embed=1&look=1&surface=photo&glass=true",
    "?embed=1&look=1&surface=photo&glass=yes",
    "?embed=1&look=1&surface=photo&glass=1;x",
    "?embed=1&look=1&surface=photo&glass=%31",
    "?embed=1&look=1&surface=photo&GLASS=1",
    "?embed=1&look=1&surface=photo&glass=",
  ])("%s → no glass, and the look is exactly the one without it", (q) => {
    const l = look(q);
    expect(l.glass).toBeNull();
    expect(l.alert).toBeNull();
    expect(l.warn).toBeNull();
    expect(l).toEqual(look(q.replace(/&(glass|GLASS)=[^&]*/, "")));
  });

  it("the R13/R14 looks are unchanged: dark site, light site, photo without glass", () => {
    const pins = {
      light: { dark: false, card: "#FCFAF8", tint: "#F2F0EE", tint2: "#E3E1DF", fill: "#F6F3F1", fill2: "#EFEDEB", line: "#EBE9E6", raise: "#FCFBF9", ink: "#2b2118", soft: "#5F5750", accent: { bg: "#7c4a1e", fg: "#ffffff", quiet: "#E2D7CE", hover: "#72441C", edge: "#7c4a1e" }, radius: "round", font: "georgia", scheme: null },
      dark: { dark: true, card: "#232323", tint: "#303030", tint2: "#4B4B4B", fill: "#222323", fill2: "#222223", line: "#222223", raise: "#3D3D3D", ink: "#ededed", soft: "#BBBBBB", accent: { bg: "#c9a45c", fg: "#111111", quiet: "#393122", hover: "#B99755", edge: "#c9a45c" }, radius: "sharp", font: "helvetica", scheme: null },
      photo: { dark: true, card: "#171717", tint: "#252525", tint2: "#414141", fill: "#171717", fill2: "#171718", line: "#171718", raise: "#333333", ink: "#ffffff", soft: "#AEAEAE", accent: { bg: "#ffffff", fg: "#1a1a1a", quiet: "#4C4C4C", hover: "#EBEBEB", edge: "#ffffff" }, radius: "soft", font: "system", scheme: null },
    };
    for (const id of Object.keys(pins)) {
      expect(look("?" + sampleLookQuery(id, AUTO))).toEqual({ ...pins[id], glass: null, alert: null, warn: null });
    }
  });
});

// ── The worst case, in exact arithmetic ────────────────────────────────
// sRGB relative luminance and WCAG contrast; "a over b" composites with exact floats (no rounding).
const lin = (v) => {
  const s = v / 255;
  return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const rgbOf = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const alphaOf = (hex) => (hex.length === 9 ? parseInt(hex.slice(7, 9), 16) / 255 : 1);
const lum = (c) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a, b) => {
  const x = lum(a), y = lum(b);
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
};
const over = (hex, under) => {
  const c = rgbOf(hex), a = alphaOf(hex);
  return under.map((u, i) => c[i] * a + u * (1 - a));
};
const white = (a, under) => under.map((u) => 255 * a + u * (1 - a)); // Tailwind's bg-white/[a]
const WHITE = [255, 255, 255], BLACK = [0, 0, 0];
// What the text sits on, over a backdrop: the glass, then the page's white overlays as the CSS stacks them.
function surfacesOver(backdrop, glass = LOOK_GLASS.card) {
  const card = over(glass, backdrop);
  const tint = over(LOOK_GLASS.tint, card);
  return {
    card,
    tile: white(0.04, card), // dark:bg-white/[0.04]
    tileHover: white(0.08, card), // dark:pointer-fine:hover:bg-white/[0.08]
    strip: white(0.05, card), // dark:bg-white/5 (the trust strip, the paused panel)
    tint, // fields, tracks, the step-2 summary (dark:bg-gray-900 / -800 / -900/60)
    tintInTint: over(LOOK_GLASS.tint, tint), // a field inside a panel
    raise: over(LOOK_GLASS.raise, card), // a quiet button's hover, the disabled main button
    segment: over(LOOK_GLASS.raise, tint), // a selected segment on its track
    backButton: white(0.1, card), // dark:bg-white/10 (an icon only)
  };
}
// Which text sits on which surfaces (the soft line, the placeholders and the alerts never on a raised one).
const INK_ON = ["card", "tile", "tileHover", "strip", "tint", "tintInTint", "raise", "segment", "backButton"];
const SOFT_ON = ["card", "tile", "tileHover", "strip", "tint", "tintInTint", "backButton"];

describe("frame: every text token keeps 4.5:1 over a pure-white patch of photo (and over black)", () => {
  it.each([
    ["no site ink", ""],
    ["white ink", "&ink=ffffff"],
    ["cream ink", "&ink=f3ebdd"],
    ["grey ink", "&ink=cccccc"],
    ["a dark ink", "&ink=1a1a1a"],
  ])("%s", (_name, ink) => {
    const l = look("?embed=1&look=1&surface=photo" + ink + "&accent=ffffff&accent_ink=1a1a1a&glass=1");
    expect(l.glass).toBe(LOOK_GLASS.card);
    const tokens = { ink: [l.ink, INK_ON], soft: [l.soft, SOFT_ON], placeholder: [l.soft, SOFT_ON], alert: [l.alert, SOFT_ON], warn: [l.warn, SOFT_ON] };
    const worst = {};
    for (const backdrop of [WHITE, BLACK, [255, 214, 160], [200, 120, 40]]) {
      const S = surfacesOver(backdrop);
      for (const [name, [hex, on]] of Object.entries(tokens)) {
        expect(hex, name).toMatch(/^#[0-9A-Fa-f]{6}$/);
        for (const s of on) {
          const r = ratio(rgbOf(hex), S[s]);
          worst[name] = Math.min(worst[name] ?? 99, r);
          expect(r, `${name} ${hex} on ${s} over rgb(${backdrop})`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
    // the main button and the picks: opaque, their own text at 4.5:1 (the R5 guard, unchanged)
    expect(ratio(rgbOf(l.accent.fg), rgbOf(l.accent.bg))).toBeGreaterThanOrEqual(4.5);
    // the softer line is softer than the ink (a step toward the glass), the alert reads as red, the warning as amber
    expect(lum(rgbOf(l.soft))).toBeLessThan(lum(rgbOf(l.ink)));
    const [r, g] = rgbOf(l.alert);
    expect(r).toBeGreaterThan(g);
    const [ar, ag, ab] = rgbOf(l.warn);
    expect(ar >= ag && ag > ab).toBe(true);
  });

  it("why 0.72 and not 0.66: the lightest glass (in 1/255 steps) where every text token holds 4.5:1 over white with a 2 % margin", () => {
    // white text on everything it sits on; a softer line one 10 % step toward the glass on everything it sits on
    const pass = (n, margin = 1) => {
      const g = "#111111" + n.toString(16).toUpperCase().padStart(2, "0");
      const S = surfacesOver(WHITE, g);
      const soft = [0, 1, 2].map(() => 255 + (17 - 255) * 0.1);
      return INK_ON.every((s) => ratio(WHITE, S[s]) >= 4.5 * margin) && SOFT_ON.every((s) => ratio(soft, S[s]) >= 4.5 * margin);
    };
    const first = (margin) => {
      for (let n = Math.round(0.66 * 255); n < 255; n += 1) if (pass(n, margin)) return n;
      return -1;
    };
    expect(pass(Math.round(0.66 * 255))).toBe(false); // white on a selected segment ≈ 4.2:1
    expect(first(1)).toBe(0xb7); // the bare floor
    expect(first(1.02)).toBe(0xb8); // 0.72: 2 % over AA
    expect(LOOK_GLASS.card).toBe("#111111" + first(1.02).toString(16).toUpperCase());
  });
});

describe("frame: applyLook sets the glass and takes it all back", () => {
  it("glass → a plain dark site → a light site: nothing left over", () => {
    applyLook(document, look(GLASS_Q), LOOK_RADII, LOOK_FONTS);
    const cl = html().classList;
    expect(cl.contains("bb-glass")).toBe(true);
    expect(cl.contains("dark")).toBe(true);
    expect(cl.contains("bb-ink")).toBe(true); // always an ink on glass: the page's own greys are not AA on it
    expect(html().style.getPropertyValue("--bb-glass")).toBe(LOOK_GLASS.card);
    expect(html().style.getPropertyValue("--bb-tint")).toBe("#FFFFFF0F");
    expect(html().style.getPropertyValue("--bb-alert")).toMatch(/^#[0-9A-F]{6}$/);
    expect(html().style.getPropertyValue("--bb-warn")).toMatch(/^#[0-9A-F]{6}$/);
    applyLook(document, look("?look=1&surface=101010&ink=eeeeee"), LOOK_RADII, LOOK_FONTS);
    expect(cl.contains("bb-glass")).toBe(false);
    expect(cl.contains("dark")).toBe(true);
    for (const k of ["--bb-glass", "--bb-alert", "--bb-warn"]) expect(html().style.getPropertyValue(k)).toBe("");
    expect(html().style.getPropertyValue("--bb-tint")).toMatch(/^#[0-9A-F]{6}$/); // opaque again
    applyLook(document, look("?look=1&surface=ffffff"), LOOK_RADII, LOOK_FONTS);
    expect([...cl].sort()).toEqual(["bb-look"]);
  });
});

// ── The parse-time script (index.html's own copy of the frame half) ────
function boot(search, { framed = true, pathname = "/r/cafe" } = {}) {
  const listeners = [];
  const toParent = [];
  const parent = { name: "parent", postMessage: (msg, origin) => toParent.push({ msg, origin }) };
  const w = {
    matchMedia: () => ({ matches: false }), fetch: undefined, AbortController,
    addEventListener: (type, fn) => listeners.push({ type, fn }),
    localStorage: { getItem: () => null },
  };
  w.self = w;
  w.top = framed ? parent : w;
  w.parent = framed ? parent : w;
  const doc = { createElement: (tag) => ({ tag }), head: { appendChild() {} }, documentElement: html() };
  new Function("window", "location", "document", "fetch", bookingBootSource({ apiUrl: "" }))(
    w, { pathname, search, protocol: "https:", hostname: "localhost" }, doc, undefined,
  );
  const send = (data, source = parent) => listeners.filter((l) => l.type === "message").forEach((l) => l.fn({ data, source }));
  return { b: w.__bbBooking, send, toParent };
}

describe("the parse-time script: glass by message, and back", () => {
  it("a new snippet's frame waits, gets the glass look and shows it in the same step; a later plain look takes the glass away", () => {
    const { send } = boot("?embed=1&compact=1&look=1");
    expect(html().classList.contains("bb-look-wait")).toBe(true);
    send({ type: "bonbox:look", q: GLASS_Q.slice("?embed=1&compact=1&".length) });
    expect(html().classList.contains("bb-glass")).toBe(true);
    expect(html().classList.contains("bb-look-wait")).toBe(false);
    expect(html().style.getPropertyValue("--bb-glass")).toBe(LOOK_GLASS.card);
    send({ type: "bonbox:look", q: "look=1&surface=101010&ink=ffffff" });
    expect(html().classList.contains("bb-glass")).toBe(false);
    expect(html().style.getPropertyValue("--bb-glass")).toBe("");
  });

  it("the booking page on its own: no look, no glass — whatever its address says", () => {
    boot("?look=1&surface=photo&glass=1", { framed: false });
    expect(html().classList.contains("bb-look")).toBe(false);
    expect(html().classList.contains("bb-glass")).toBe(false);
  });
});

// ── index.css ─────────────────────────────────────────────────────────
const start = CSS_TEXT.lastIndexOf("/*", CSS_TEXT.indexOf("FROSTED GLASS (R15"));
const GLASS_CSS = CSS_TEXT.slice(start, CSS_TEXT.indexOf("/* ── Reservations room shell"));
const GLASS_RULES = GLASS_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
const rulesOf = (css) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2].trim() }));

describe("CSS: the glass is one layer that fills the frame", () => {
  it("lives in the look block (above the room block) and every rule needs html.bb-glass", () => {
    expect(start).toBeGreaterThan(CSS_TEXT.indexOf("BOOKING LOOK (R13"));
    expect(CSS_TEXT.indexOf("FROSTED GLASS (R15")).toBeGreaterThan(start);
    expect(start).toBeLessThan(CSS_TEXT.indexOf(".bb-room-wall {"));
    const rules = rulesOf(GLASS_CSS);
    expect(rules.length).toBeGreaterThan(5);
    for (const r of rules) for (const s of r.sel.split(",")) expect(s.trim(), s).toMatch(/^:root\.bb-look\.dark\.bb-glass[.:\s]/);
  });

  it("<html> carries the glass (over .bb-embed-card's transparent, never while waiting); body, ground, card, receipt, bar and the plain grounds stay clear", () => {
    expect(GLASS_CSS).toContain(":root.bb-look.dark.bb-glass:not(.bb-look-wait) { background-color: var(--bb-glass) !important; }");
    const clear = rulesOf(GLASS_CSS).find((r) => r.body === "background-color: transparent;");
    expect(clear.sel.split(",").map((s) => s.trim())).toEqual([
      ":root.bb-look.dark.bb-glass body",
      ":root.bb-look.dark.bb-glass .bb-ground",
      ":root.bb-look.dark.bb-glass .bb-card",
      ":root.bb-look.dark.bb-glass .bb-solid",
      ":root.bb-look.dark.bb-glass .bb-look-bar",
      ":root.bb-look.dark.bb-glass .dark\\:bg-gray-950:not(.bb-ground)",
    ]);
  });

  it("no outer shadow and, from 450 px, no room round the card: it fills the frame, whose corners clip the blur", () => {
    expect(GLASS_CSS).toContain(":root.bb-look.dark.bb-glass .bb-card { box-shadow: none; }");
    expect(GLASS_CSS).toMatch(/@media \(min-width: 450px\) \{\s*:root\.bb-look\.dark\.bb-glass\.bb-embed-card \.bb-ground \{ padding: 0; \}\s*\}/);
  });

  it("no navy and nothing faint on the glass: hairlines, placeholders, alerts, the disabled main button, hovers", () => {
    const r = (sel) => rulesOf(GLASS_CSS).find((x) => x.sel.split(",").map((s) => s.trim()).includes(sel));
    expect(r(":root.bb-look.dark.bb-glass .dark\\:border-gray-700").body).toBe("border-color: var(--bb-line);");
    expect(r(":root.bb-look.dark.bb-glass .dark\\:border-gray-800").body).toBe("border-color: var(--bb-line);");
    expect(r(":root.bb-look.dark.bb-glass .dark\\:placeholder-gray-500::placeholder").body).toBe("color: var(--bb-ink-soft);");
    expect(r(":root.bb-look.dark.bb-glass .dark\\:text-red-400").body).toBe("color: var(--bb-alert);");
    expect(r(":root.bb-look.dark.bb-glass .dark\\:text-rose-400").body).toBe("color: var(--bb-alert);");
    expect(r(":root.bb-look.dark.bb-glass .dark\\:text-amber-200").body).toBe("color: var(--bb-warn);");
    // a busy main button stays the site's (or our) colour
    expect(r(':root.bb-look.dark.bb-glass .dark\\:disabled\\:bg-gray-700:disabled:not([aria-busy="true"])').body).toMatch(
      /^background-color: var\(--bb-raise\);\s*color: var\(--bb-ink\);$/,
    );
    expect(r(":root.bb-look.dark.bb-glass .dark\\:hover\\:bg-gray-800:hover").body).toBe("background-color: var(--bb-raise);");
    // the back button's hairline and the logo / monogram tile's ring: the glass's line, not gray-700
    expect(r(":root.bb-look.dark.bb-glass .dark\\:shadow-\\[inset_0_0_0_1px_var\\(--color-gray-700\\)\\]").body).toBe("--tw-shadow: inset 0 0 0 1px var(--bb-line);");
    expect(r(":root.bb-look.dark.bb-glass .dark\\:ring-gray-700").body).toBe("--tw-ring-color: var(--bb-line);");
    // the receipt's quiet "Aflys" (dark:text-gray-400!, an important utility): its colour variable, on the element
    expect(r(":root.bb-look.dark.bb-glass .dark\\:text-gray-400\\!").body).toBe("--color-gray-400: var(--bb-ink-soft);");
    // the bar's own frosting is off: only the frame's glass behind it (Chromium painted a grey block under its first line)
    expect(rulesOf(GLASS_CSS).filter((x) => x.sel === ":root.bb-look.dark.bb-glass .bb-look-bar").map((x) => x.body)).toEqual([
      "-webkit-backdrop-filter: none; backdrop-filter: none;",
    ]);
  });

  it("colours only through the look's custom properties (the R13 rule)", () => {
    const colours = [...GLASS_RULES.matchAll(/(?:background-color|color|border-color):\s*([^;]+);/g)].map((m) => m[1].trim());
    expect(colours.length).toBeGreaterThan(5);
    for (const c of colours) expect(c).toMatch(/^(var\(--bb-[a-z0-9-]+\)|transparent)( !important)?$/);
    // calm frosted only: no gloss, gradient, glow or 3D on the frame's side (the blur is the host's)
    expect(GLASS_RULES).not.toMatch(/gradient|text-shadow|transform|perspective|blur\(|drop-shadow/);
    expect([...GLASS_RULES.matchAll(/(?:^|[\s;{])box-shadow:\s*([^;]+);/g)].map((m) => m[1])).toEqual(["none"]);
    for (const m of GLASS_RULES.matchAll(/--tw-shadow:\s*([^;]+);/g)) expect(m[1]).toBe("inset 0 0 0 1px var(--bb-line)"); // a hairline
    expect([...GLASS_RULES.matchAll(/filter:\s*([^;]+);/g)].map((m) => m[1])).toEqual(["none", "none"]);
  });
});

// ── The owner's kit ───────────────────────────────────────────────────
describe("kit: the photo sample shows the glass where the owner's browser can", () => {
  it("sampleLookQuery: glass=1 only for the photo, only when asked, never with 'Lys'", () => {
    expect(sampleLookQuery("photo", AUTO, { glass: true })).toBe(sampleLookQuery("photo", AUTO) + "&glass=1");
    expect(sampleLookQuery("photo", { mode: "dark", accent: "own" }, { glass: true })).toMatch(/&glass=1$/);
    expect(sampleLookQuery("photo", { mode: "light", accent: "site" }, { glass: true })).not.toContain("glass");
    for (const id of ["light", "dark"]) expect(sampleLookQuery(id, AUTO, { glass: true })).toBe(sampleLookQuery(id, AUTO));
    expect(sampleLookQuery("photo", AUTO)).not.toContain("glass");
    for (const id of Object.keys(LOOK_SAMPLES)) expect(sampleLookQuery(id, AUTO, { glass: true })).toMatch(SAFE_Q);
  });

  it("glassSupported: either spelling; no CSS.supports, or one that throws, is no", () => {
    expect(glassSupported({ CSS: { supports: () => true } })).toBe(true);
    expect(glassSupported({ CSS: { supports: (p) => p === "-webkit-backdrop-filter" } })).toBe(true);
    expect(glassSupported({ CSS: { supports: () => false } })).toBe(false);
    expect(glassSupported({})).toBe(false);
    expect(glassSupported({ CSS: { supports: () => { throw new Error("x"); } } })).toBe(false);
    expect(glassSupported(undefined)).toBe(false);
  });

  const PUBLIC = "https://www.bonbox.dk/cafe-mirabelle";
  const t = (k, vars) => {
    let s = da[k] ?? k;
    if (vars && typeof vars === "object") s = s.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
    return s;
  };
  const renderKit = () => {
    render(<WebsiteBookingKit publicUrl={PUBLIC} venueName="Café Mirabelle" t={t} appOrigin="https://www.bonbox.dk" canFramePreview />);
    fireEvent.click(screen.getByRole("tab", { name: t("rsvpWebTabEmbed") }));
  };
  const pick = (group, value) => fireEvent.click(within(screen.getByTestId(group)).getByRole("radio", { name: value }));
  const frame = () => screen.getByTestId("website-preview");

  it("phone and computer: the photo sample's frame is sent glass and blurs the sample photo; the other samples are not", () => {
    window.CSS = { supports: () => true };
    renderKit();
    expect(frame().getAttribute("src")).not.toContain("glass");
    expect(frame().style.backdropFilter || "").toBe("");
    pick("website-look-sample", da.rsvpWebSamplePhoto);
    expect(frame().getAttribute("src")).toMatch(/&glass=1$/);
    expect(frame().style.backdropFilter).toBe(LOOK_GLASS_BLUR);
    expect(frame().style.WebkitBackdropFilter).toBe(LOOK_GLASS_BLUR);
    fireEvent.click(screen.getByRole("radio", { name: new RegExp(da.rsvpWebPreviewComputer) }));
    expect(frame().getAttribute("src")).toMatch(/&glass=1$/);
    expect(frame().style.backdropFilter).toBe(LOOK_GLASS_BLUR);
    pick("website-look-mode", da.rsvpWebColoursLight);
    expect(frame().getAttribute("src")).not.toContain("glass");
    expect(frame().style.backdropFilter || "").toBe("");
  });

  it("where the owner's browser cannot blur: the photo sample shows today's opaque card", () => {
    renderKit();
    pick("website-look-sample", da.rsvpWebSamplePhoto);
    expect(frame().getAttribute("src")).toMatch(/&look=1&surface=photo&/);
    expect(frame().getAttribute("src")).not.toContain("glass");
    expect(frame().style.backdropFilter || "").toBe("");
  });
});

// ── What does not change ──────────────────────────────────────────────
describe("unchanged: the snippet, its mail, and the R4 snippet", () => {
  // The new snippet exactly as R13/R14 give it (bookingEmbed.js @ a6b7f8a7): R15 lives in the hosted
  // file and the page, so what owners paste — and the mail that carries it — stays the same.
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

  it("the new snippet is byte for byte the R13/R14 one, and its mail the same length", () => {
    const s = iframeSnippet({ ...base, compact: true, look: AUTO, hosted: true });
    expect(s).toBe(NEW);
    const mail = mailtoHref({ subject: da.rsvpEmbedMailSubject, body: da.rsvpWebMailBody.replace("{iframe}", s).replace("{link}", base.publicUrl).replace("{origin}", ORIGIN) });
    expect(mail.length).toBeLessThanOrEqual(2000);
  });

  it("the R4 snippet keeps its inline script: no hosted file, so no glass can ever reach it", () => {
    const r4 = iframeSnippet({ ...base, compact: true });
    expect(r4).not.toMatch(/embed1\.js|look=1|glass|backdrop/);
    expect(r4).toContain("a[i].style.setProperty('height',h+'px','important');");
  });
});
