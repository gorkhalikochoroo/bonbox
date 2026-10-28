/**
 * Booking R13 — the snippet's HOST half. A new snippet loads ONE hosted
 * script (frontend/public/static/embed1.js, /static/embed1.js on the booking
 * origin — R13 fix round: the inline look made the snippet 5.7 kB and the
 * hand-off mail 10 kB); it is run here in jsdom on stand-in websites:
 *   - a cream site in Georgia with pill buttons;
 *   - a black site with square gold buttons;
 *   - a photo behind the booking;
 *   - a site with no button (and one whose only button is its own ground);
 *   - a site that switches to dark (a class on <html>) after the frame is up,
 *     the five-change budget (spent only on real changes; a color-scheme
 *     change always followed), a script that arrives after the frame is up;
 *   - fonts: a system font passes, a web font does not, a heading can stand
 *     in for the body, an unstyled document (Wix's Embed HTML box) gives none;
 *   - the owner's override (data-bonbox-look / data-bonbox-accent);
 *   - what leaves the page: hex digits and fixed words only, to the booking
 *     origin only — even from a hostile stylesheet;
 *   - the new snippet is short and its hand-off mail is a mailto: link of at
 *     most 2,000 characters in every case; the file's cache header;
 *   - the old snippets: no opt-in, the R4 snippet byte for byte.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  EMBED_SCRIPT_PATH, LOOK_FRAME_RADIUS, LOOK_SAMPLES, iframeSnippet, lookOf, mailtoHref, sampleLookQuery,
} from "../utils/bookingEmbed";
import { LOOK_FONTS, LOOK_RADII, lookFrom } from "../lib/bookingLook";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const HOSTED = fs.readFileSync(path.join(FRONTEND, "public", EMBED_SCRIPT_PATH), "utf8");
const ORIGIN = "https://www.bonbox.dk";
const base = { publicUrl: "https://www.bonbox.dk/cafe", label: "Book bord", venueName: "Café", fallbackLabel: "Åbn booking →" };
const AUTO = { mode: "auto", accent: "site" };
// Every query the script may send: hex digits and fixed words, in its order.
const SAFE_Q =
  /^look=1(&theme=(light|dark))?(&scheme=(light|dark|ld))?(&surface=([0-9a-f]{6}|photo))?(&ink=[0-9a-f]{6})?(&accent=[0-9a-f]{6}(&accent_ink=[0-9a-f]{6})?)?(&radius=(sharp|soft|round))?(&font=(system|helvetica|georgia|times))?$/;

const scriptOf = (snippet) =>
  snippet.slice(snippet.indexOf("<script>") + "<script>".length, snippet.indexOf("</" + "script>"));

// Build a host page: its stylesheet in <head>, its markup in <body> with the
// snippet's markup where the owner pasted it ({SNIPPET}), then run the
// snippet's script the way the browser would (innerHTML never runs one): an
// inline one (R4) as written, a <script src> as the hosted file, with
// document.currentScript pointing at that tag.
const pasted = [];
function runScriptOf(s, protocol = "https:") {
  const src = /<script src="([^"]+)">/.exec(s);
  if (!src) return new Function("location", scriptOf(s))({ protocol });
  const tag = document.createElement("script");
  tag.src = src[1];
  Object.defineProperty(document, "currentScript", { value: tag, configurable: true });
  try {
    new Function("location", HOSTED)({ protocol });
  } finally {
    delete document.currentScript;
  }
}
function host({ css = "", body = '<main>{SNIPPET}</main>', look = AUTO, snippet = null, styled = true, protocol = "https:", before = null } = {}) {
  const s = snippet || iframeSnippet({ ...base, compact: true, look, hosted: true });
  const style = document.createElement("style");
  style.textContent = css;
  if (styled) document.head.appendChild(style);
  document.body.innerHTML = body.replace("{SNIPPET}", s.replace(/<script[\s\S]*<\/script>/, ""));
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
  // What the script says to each frame (R13 fix round 2: looks travel by message only).
  const posted = [];
  for (const f of document.querySelectorAll("iframe[data-bonbox-booking]")) {
    f.contentWindow.postMessage = (msg, origin) => posted.push({ frame: f, msg, origin });
  }
  const srcBefore = [...document.querySelectorAll("iframe[data-bonbox-booking]")].map((f) => f.getAttribute("src"));
  try {
    if (before) before(document.querySelector("iframe[data-bonbox-booking]"));
    runScriptOf(s, protocol);
  } finally {
    window.addEventListener = realAdd;
    window.MutationObserver = RealMO;
  }
  const rec = { style, observers, listeners };
  pasted.push(rec);
  const frame = document.querySelector("iframe[data-bonbox-booking]");
  // the frame (look=1 in its address) says it is ready for its look
  const ready = (f = frame) =>
    window.dispatchEvent(new MessageEvent("message", { data: { type: "bonbox:ready" }, origin: ORIGIN, source: f.contentWindow }));
  const looks = (f = frame) => posted.filter((p) => p.frame === f && p.msg.type === "bonbox:look");
  const q = () => {
    if (!looks().length) ready();
    const l = looks();
    return l.length ? l[l.length - 1].msg.q : null;
  };
  return { frame, q, ready, looks, posted, srcBefore };
}
const heightFrom = (frame, height = 700) =>
  window.dispatchEvent(new MessageEvent("message", { data: { type: "bonbox:height", height }, origin: ORIGIN, source: frame.contentWindow }));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => {
  // jsdom lays nothing out: every element is 120 × 40 unless it says otherwise.
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function () {
    const w = this.dataset?.w ? Number(this.dataset.w) : 120;
    const h = this.dataset?.h ? Number(this.dataset.h) : 40;
    return { width: w, height: h, top: 0, left: 0, right: w, bottom: h, x: 0, y: 0 };
  });
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
  document.body.innerHTML = "";
  document.documentElement.className = "";
});

const CREAM = `
  body { font-family: Georgia, "Times New Roman", serif; color: #2b2118; margin: 0; }
  .site { background-color: #f4efe6; }
  nav button { background-color: transparent; color: #2b2118; }
  .btn { background-color: #7c4a1e; color: #ffffff; border-radius: 999px; }
`;
const CREAM_BODY = `
  <nav><button>Menu</button></nav>
  <section class="site">
    <a class="btn" href="#menu">Se menu</a>
    <div class="col">{SNIPPET}</div>
    <a class="btn" href="#kontakt">Kontakt</a>
  </section>`;

describe("a cream site in Georgia with pill buttons", () => {
  it("reads its surface, ink, button colour + text, round corners and Georgia — sent the moment the frame is ready", () => {
    const { frame, q } = host({ css: CREAM, body: CREAM_BODY });
    expect(q()).toBe("look=1&surface=f4efe6&ink=2b2118&accent=7c4a1e&accent_ink=ffffff&radius=round&font=georgia");
    // the frame's own address is the snippet's, look=1 included, and never changes (one load)
    expect(frame.getAttribute("src")).toBe(`${ORIGIN}/r/cafe?embed=1&compact=1&look=1`);
    expect(frame.style.borderRadius).toBe(LOOK_FRAME_RADIUS.round);
    // …and the frame makes a light, cream-tinted card of it, with the brown on the picks
    const look = lookFrom("?embed=1&compact=1&" + q(), LOOK_RADII, LOOK_FONTS);
    expect(look.dark).toBe(false);
    expect(look.card).not.toBe("#FFFFFF");
    expect(look.accent.bg).toBe("#7c4a1e");
    expect(look.accent.fg).toBe("#ffffff");
    expect(look.ink).toBe("#2b2118");
    expect(look.radius).toBe("round");
    expect(look.font).toBe("georgia");
  });
});

describe("a black site with square gold buttons", () => {
  const CSS = `
    html, body { background-color: #0b0b0b; color: #eeeeee; font-family: "Helvetica Neue", Arial, sans-serif; }
    .cta { background-color: #c9a45c; color: #111111; border-radius: 0; }`;
  it("dark surface, light ink, gold with its dark text, sharp corners, Helvetica", () => {
    const { frame, q } = host({ css: CSS, body: '<header><button class="cta">Book</button></header><div>{SNIPPET}</div>' });
    expect(q()).toBe("look=1&surface=0b0b0b&ink=eeeeee&accent=c9a45c&accent_ink=111111&radius=sharp&font=helvetica");
    expect(frame.style.borderRadius).toBe(LOOK_FRAME_RADIUS.sharp);
    const look = lookFrom("?" + q(), LOOK_RADII, LOOK_FONTS);
    expect(look.dark).toBe(true);
    expect(look.card).not.toBe("#111827"); // one step lighter than the site, not our own grey
    expect(look.accent.bg).toBe("#c9a45c");
    expect(look.accent.fg).toBe("#111111");
  });
});

describe("a photo behind the booking", () => {
  it("a background image on an ancestor is 'photo' (and so is a gradient)", () => {
    const { q } = host({
      css: `body { color: #ffffff; } .hero { background-color: #333; background-image: url(photo.jpg); }`,
      body: '<div class="hero"><div>{SNIPPET}</div></div>',
    });
    expect(q()).toMatch(/^look=1&surface=photo&ink=ffffff/);
    expect(lookFrom("?" + q(), LOOK_RADII, LOOK_FONTS)).toMatchObject({ dark: true, card: "#111827" });
    document.body.innerHTML = "";
    const g = host({
      css: `.band { background-image: linear-gradient(#fff, #000); }`,
      body: '<div class="band">{SNIPPET}</div>',
    });
    expect(g.q()).toMatch(/&surface=photo/);
  });

  it("the walk stops at the first ancestor with a colour: a transparent chain gives no surface", () => {
    const { q } = host({ css: `body { color: #222222; }`, body: "<div><div>{SNIPPET}</div></div>" });
    expect(q()).not.toMatch(/surface=/);
    expect(q()).toMatch(/^look=1&ink=222222/);
    // the frame then keeps today's light card
    expect(lookFrom("?" + q(), LOOK_RADII, LOOK_FONTS)).toMatchObject({ dark: false, card: "#FFFFFF" });
  });
});

describe("no button to match", () => {
  it("links only: no accent, no corners — the owner's colour (or ours) and our corners stay", () => {
    const { frame, q } = host({
      css: `body { background-color: #ffffff; color: #111111; } a { color: #0645ad; }`,
      body: '<p><a href="#x">Om os</a> <a href="#y">Menu</a></p>{SNIPPET}',
    });
    expect(q()).toBe("look=1&surface=ffffff&ink=111111");
    expect(frame.style.borderRadius).toBe("16px"); // the snippet's own, untouched
  });

  it("a button the colour of its own ground is not a brand colour; hidden and tiny ones don't count", () => {
    const { q } = host({
      css: `
        body { background-color: #ffffff; color: #111111; }
        .ghost { background-color: #fdfdfd; }
        .hidden { background-color: #e11d48; display: none; }
        .faded { background-color: #e11d48; opacity: 0; }
        .tiny { background-color: #e11d48; }`,
      body:
        '<button class="ghost">A</button><button class="hidden">B</button><button class="faded">C</button>' +
        '<button class="tiny" data-w="10" data-h="10">D</button>{SNIPPET}',
    });
    expect(q()).toBe("look=1&surface=ffffff&ink=111111");
  });

  it("the colour most buttons share wins (a lone cookie button does not)", () => {
    const { q } = host({
      css: `body { background-color: #ffffff; } .x { background-color: #222222; } .brand { background-color: #b91c1c; color: #fff; border-radius: 8px; }`,
      body: '<button class="x">Cookies</button><a class="btn brand">Book</a><a class="btn brand">Menu</a>{SNIPPET}',
    });
    expect(q()).toMatch(/&accent=b91c1c&accent_ink=ffffff&radius=soft/);
  });
});

describe("fonts: a short list of system fonts, or Inter stays", () => {
  const run = (css, body = "<main>{SNIPPET}</main>", styled = true) => host({ css, body, styled }).q();
  it.each([
    ["system-ui, sans-serif", "system"],
    ["-apple-system, BlinkMacSystemFont, sans-serif", "system"],
    ["Arial, sans-serif", "helvetica"],
    ['"Times New Roman", serif', "times"],
    ["Georgia, serif", "georgia"],
  ])("%s → %s", (family, id) => {
    expect(run(`body { font-family: ${family}; }`)).toMatch(new RegExp(`&font=${id}$`));
  });

  it("a web font (Google, self-hosted) is not matched: no font, Inter stays", () => {
    expect(run(`body { font-family: "Playfair Display", Georgia, serif; }`)).not.toMatch(/font=/);
    expect(run(`body { font-family: Lato, sans-serif; }`)).not.toMatch(/font=/);
  });

  it("a heading can stand in when the body's font is not on the list", () => {
    expect(run(`body { font-family: Lato, sans-serif; } h1 { font-family: Georgia, serif; }`, "<h1>Bistro</h1>{SNIPPET}")).toMatch(/&font=georgia$/);
  });

  it("an unstyled document (Wix's Embed HTML box) gives no font and no ink: those are the browser's, not the site's", () => {
    const q = run("", "<div>{SNIPPET}</div>", false);
    expect(document.styleSheets.length).toBe(0);
    expect(q).toBe("look=1");
  });
});

describe("the owner's override", () => {
  it("Lys / Mørk ride as theme; 'Din BonBox-farve' sends no button colour (the corners still come)", () => {
    const dark = host({ css: CREAM, body: CREAM_BODY, look: { mode: "dark", accent: "own" } }).q();
    expect(dark).toBe("look=1&theme=dark&surface=f4efe6&ink=2b2118&radius=round&font=georgia");
    // forced dark on a cream site: our dark card; the site's dark ink fails on it, so ours
    expect(lookFrom("?" + dark, LOOK_RADII, LOOK_FONTS)).toMatchObject({ dark: true, card: "#111827", ink: null, accent: null });
    document.body.innerHTML = "";
    expect(host({ css: CREAM, body: CREAM_BODY, look: { mode: "light", accent: "site" } }).q()).toMatch(/^look=1&theme=light&/);
  });

  it("the snippet carries the choice as data- attributes; garbage choices fall back to auto / site", () => {
    expect(iframeSnippet({ ...base, look: AUTO })).toContain('<iframe data-bonbox-booking data-bonbox-look="auto" src=');
    // the site's colour is the default, so only the owner's is written out
    expect(iframeSnippet({ ...base, look: AUTO })).not.toContain("data-bonbox-accent");
    expect(iframeSnippet({ ...base, look: { mode: "dark", accent: "own" } })).toContain('data-bonbox-look="dark" data-bonbox-accent="own"');
    expect(lookOf({ mode: '"><script>', accent: "x" })).toEqual({ mode: "auto", accent: "site" });
    expect(lookOf(null)).toBeNull();
    expect(lookOf("auto")).toBeNull();
  });
});

describe("the frame's own color-scheme, mirrored (else the browser paints the frame an opaque box)", () => {
  // jsdom knows no color-scheme: the iframe's computed value is stubbed, the rest is real.
  const withScheme = (value) => {
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const st = real(el);
      return el.tagName === "IFRAME" ? new Proxy(st, { get: (t, k) => (k === "colorScheme" ? value : Reflect.get(t, k)) }) : st;
    });
  };
  it.each([
    ["dark", "&scheme=dark"], ["only dark", "&scheme=dark"], ["light dark", "&scheme=ld"], ["dark light", "&scheme=ld"],
    ["light", ""], ["normal", ""], ["", ""], // light is the frame's own (the snippet pins it): nothing to say
  ])("color-scheme %j → %j", (value, want) => {
    withScheme(value);
    const q = host({ css: "body { background-color: #0b0b0b; }", body: "<div>{SNIPPET}</div>" }).q();
    expect(q).toBe("look=1" + want + "&surface=0b0b0b");
    expect(q).toMatch(SAFE_Q);
  });
});

describe("a site that switches to dark after the frame is up", () => {
  const CSS = `
    body { background-color: #ffffff; color: #1a1a1a; font-family: Georgia, serif; }
    html.dark body { background-color: #101010; color: #f0f0f0; }
    .b { background-color: #1d4ed8; color: #ffffff; border-radius: 6px; }`;

  it("reads it again and posts the new look to the frame (no reload), only to the booking origin, at most five changes", async () => {
    const { frame, q, looks, srcBefore } = host({ css: CSS, body: '<button class="b">Book</button>{SNIPPET}' });
    expect(q()).toBe("look=1&surface=ffffff&ink=1a1a1a&accent=1d4ed8&accent_ink=ffffff&radius=sharp&font=georgia");
    heightFrom(frame);
    expect(frame.style.height).toBe("700px");
    expect(looks()).toHaveLength(1); // the height says nothing new

    document.documentElement.classList.add("dark");
    await wait(300);
    expect(looks()).toHaveLength(2);
    expect(looks()[1].origin).toBe(ORIGIN);
    expect(looks()[1].msg).toEqual({
      type: "bonbox:look",
      q: "look=1&surface=101010&ink=f0f0f0&accent=1d4ed8&accent_ink=ffffff&radius=sharp&font=georgia",
    });
    expect(looks()[1].msg.q).toMatch(SAFE_Q);
    expect(frame.getAttribute("src")).toBe(srcBefore[0]); // never reloaded

    // flip-flopping: the first look is free, then at most five changes per page view
    for (let i = 0; i < 8; i += 1) {
      document.documentElement.classList.toggle("dark");
      await wait(300);
    }
    expect(looks()).toHaveLength(6);
  });

  it("a look found before the frame is ready is the one sent on its ready (and again on a later ready)", async () => {
    const { frame, ready, looks, srcBefore } = host({ css: CSS, body: '<button class="b">Book</button>{SNIPPET}' });
    document.documentElement.classList.add("dark");
    await wait(300);
    expect(looks()).toEqual([]); // the frame is not ready: nothing sent, nothing reloaded
    ready();
    expect(looks()).toHaveLength(1);
    expect(looks()[0].msg.q).toMatch(/surface=101010/);
    ready(); // the frame answered a hello too
    expect(looks()).toHaveLength(2);
    expect(looks()[1].msg.q).toBe(looks()[0].msg.q);
    expect(frame.getAttribute("src")).toBe(srcBefore[0]);
  });

  it("a ready from another origin or another window gets nothing", () => {
    const { frame, looks } = host({ css: CSS, body: '<button class="b">Book</button>{SNIPPET}' });
    window.dispatchEvent(new MessageEvent("message", { data: { type: "bonbox:ready" }, origin: "https://evil.example", source: frame.contentWindow }));
    window.dispatchEvent(new MessageEvent("message", { data: { type: "bonbox:ready" }, origin: ORIGIN, source: window }));
    expect(looks()).toEqual([]);
  });
});

describe("exactly one load of the frame (R13 fix round 2)", () => {
  // The frame's src is never set by the script — not at once, not on a hello, ready or theme switch: a
  // second load painted the plain white card first (4 of 8 runs, every slow or async run).
  const watchSrc = (f) => {
    const sets = [];
    Object.defineProperty(f, "src", {
      configurable: true,
      get: () => f.getAttribute("src"),
      set: (v) => {
        sets.push(v);
      },
    });
    f.__sets = sets;
  };
  it.each(["at once (a sync script)", "after the frame is up (async: hello)"])("%s", async (when) => {
    const { frame, ready, srcBefore } = host({ css: CREAM, body: CREAM_BODY, before: watchSrc });
    if (when.includes("hello")) heightFrom(frame);
    ready();
    document.documentElement.classList.add("dark");
    await wait(300);
    ready();
    expect(frame.__sets).toEqual([]);
    expect(frame.getAttribute("src")).toBe(srcBefore[0]);
    expect(frame.getAttribute("src")).toBe(`${ORIGIN}/r/cafe?embed=1&compact=1&look=1`);
  });

  it("the snippet itself: look=1 in the frame's address, color-scheme:light on the <iframe> (no box, script or no script)", () => {
    const on = iframeSnippet({ ...base, compact: true, look: AUTO });
    expect(on).toContain('src="https://www.bonbox.dk/r/cafe?embed=1&amp;compact=1&amp;look=1"');
    expect(on).toContain('style="display:block;border:0;width:100%;border-radius:16px;color-scheme:light"');
    const off = iframeSnippet({ ...base, compact: true, hosted: true });
    expect(off).not.toContain("look=1");
    expect(off).toContain(";color-scheme:light\"");
    // R4: neither
    const r4 = iframeSnippet({ ...base, compact: true });
    expect(r4).not.toMatch(/look=1|color-scheme/);
  });
});

describe("only hex digits and fixed words leave the page", () => {
  it("a hostile stylesheet cannot put anything else in the address", () => {
    const { q } = host({
      css: `
        body { font-family: "x;}</style><script>alert(1)</script>", serif; color: rgb(10 20 30 / 0.9); }
        main { background-color: oklch(0.5 0.1 200); }
        .b { background-color: rgba(200, 30, 30, 0.95); color: currentColor; border-radius: 50%; }`,
      body: '<main><button class="b">x</button>{SNIPPET}</main>',
    });
    expect(q()).toMatch(SAFE_Q);
    expect(q()).toContain("&radius=round");
    expect(q()).not.toMatch(/font=/);
  });

  it("every sample site's query is a query the script could send", () => {
    for (const id of Object.keys(LOOK_SAMPLES)) {
      for (const mode of ["auto", "light", "dark"]) {
        for (const accent of ["site", "own"]) expect(sampleLookQuery(id, { mode, accent })).toMatch(SAFE_Q);
      }
    }
    expect(sampleLookQuery("light", null)).toBe("");
  });
});

describe("the hosted script itself (/static/embed1.js)", () => {
  it("is plain ES5 that parses, and posts only to the booking origin it came from", () => {
    expect(() => new Function(HOSTED)).not.toThrow();
    expect(HOSTED).not.toMatch(/=>|\blet\b|\bconst\b|`/);
    expect(HOSTED.match(/postMessage\([^)]*\)/g)).toEqual([
      'postMessage({ type: "bonbox:look", q: q }, o)',
      'postMessage({ type: "bonbox:hello" }, o)',
    ]);
    expect(HOSTED).toContain("o = new URL(me.src).origin;");
  });

  it("one copy serves every frame: a second snippet on the page re-reads, never adds a second set of listeners", () => {
    const first = host({ css: CREAM, body: CREAM_BODY });
    expect(first.q()).toMatch(/^look=1&surface=f4efe6/);
    const listenersBefore = pasted[0].listeners.length;
    runScriptOf(iframeSnippet({ ...base, look: AUTO }));
    expect(pasted[0].listeners.length).toBe(listenersBefore);
  });

  it("a frame already up when the file arrives (a builder that makes scripts async) is asked to say its height", () => {
    const asked = [];
    host({
      css: CREAM,
      body: CREAM_BODY,
      before: (f) => {
        f.contentWindow.postMessage = (msg, origin) => asked.push({ msg, origin });
      },
    });
    expect(asked).toContainEqual({ msg: { type: "bonbox:hello" }, origin: ORIGIN });
  });

  it("on a plain-http page the https frame can never load: the box hides, the link stays", () => {
    const { frame } = host({ css: CREAM, body: CREAM_BODY, protocol: "http:" });
    expect(frame.style.display).toBe("none");
    expect(document.querySelector("[data-bonbox-booking-link]").style.display).toBe("");
  });
});

describe("the new snippet is short, and its hand-off mail stays one mailto: link (R13 fix round)", () => {
  it("about 0.7 kB: the frame, the link and one <script src> from the booking origin — no inline code", () => {
    const s = iframeSnippet({ ...base, compact: true, look: AUTO });
    expect(s.length).toBeLessThan(1024);
    expect(s).toContain(`<script src="${ORIGIN}${EMBED_SCRIPT_PATH}"></script>`);
    expect(s).not.toMatch(/<script>|addEventListener|getComputedStyle/);
    // "Tilpas automatisk" off: the same short snippet without the opt-in
    const off = iframeSnippet({ ...base, compact: true, hosted: true });
    expect(off).toContain(`<script src="${ORIGIN}${EMBED_SCRIPT_PATH}"></script>`);
    expect(off).not.toContain("data-bonbox-look");
    // a local build loads its own copy
    expect(iframeSnippet({ ...base, publicUrl: "http://127.0.0.1:5200/cafe", look: AUTO })).toContain('<script src="http://127.0.0.1:5200/static/embed1.js">');
  });

  it("≤ 2,000 characters in every case, with the complete snippet inside (da + en, longest names and slugs)", () => {
    let worst = 0;
    const url = "https://www.bonbox.dk/" + "a".repeat(60); // the longest slug the backend allows
    for (const d of [da, en]) {
      for (const label of [d.rsvpEmbedButtonLabel, d.rsvpWebButtonLabelProvider]) {
        for (const venueName of ["Café Mirabelle", "Ææ Øø Åå ".repeat(14).slice(0, 120), '&"<>&"<>'.repeat(15), "x".repeat(120)]) {
          for (const look of [AUTO, { mode: "dark", accent: "own" }, null]) {
            for (const width of [460, 560]) {
              const iframe = iframeSnippet({ publicUrl: url, label, venueName, fallbackLabel: d.rsvpEmbedOpenInNewTab, compact: true, flat: true, width, look, hosted: true });
              const href = mailtoHref({ subject: d.rsvpEmbedMailSubject, body: d.rsvpWebMailBody.replace("{iframe}", iframe).replace("{link}", url) });
              expect(new URLSearchParams(href.slice("mailto:?".length)).get("body")).toContain(iframe);
              expect(iframe.length).toBeLessThanOrEqual(850);
              worst = Math.max(worst, href.length);
            }
          }
        }
      }
    }
    expect(worst).toBeLessThanOrEqual(2000);
  });

  it("the file is served with an hour's cache (and a day stale while it revalidates), never as an immutable asset", () => {
    const v = JSON.parse(fs.readFileSync(path.join(FRONTEND, "vercel.json"), "utf8"));
    const rule = v.headers.find((h) => h.source === "/static/(.*)");
    expect(rule.headers).toEqual([{ key: "Cache-Control", value: "public, max-age=3600, stale-while-revalidate=86400" }]);
    expect(EMBED_SCRIPT_PATH.startsWith("/assets/")).toBe(false);
    expect(fs.existsSync(path.join(FRONTEND, "public", EMBED_SCRIPT_PATH))).toBe(true);
  });
});

describe("the re-read budget (R13 fix round)", () => {
  const CSS = `
    body { background-color: #ffffff; color: #1a1a1a; }
    html.dark body { background-color: #101010; color: #f0f0f0; }
    .b { background-color: #1d4ed8; color: #ffffff; border-radius: 6px; }`;

  it("40 class flips that change nothing (a sticky header) spend nothing: a real change afterwards still reaches the frame", async () => {
    const { ready, looks } = host({ css: CSS, body: '<button class="b">Book</button>{SNIPPET}' });
    ready();
    expect(looks()).toHaveLength(1);
    for (let i = 0; i < 40; i += 1) {
      document.body.classList.toggle("is-scrolled");
      await wait(i % 8 === 0 ? 300 : 5);
    }
    await wait(300);
    expect(looks()).toHaveLength(1);
    document.documentElement.classList.add("dark");
    await wait(300);
    expect(looks()).toHaveLength(2);
    expect(looks()[1].msg.q).toMatch(/surface=101010/);
  });

  it("after the five changes, a color-scheme change is still followed (else the browser paints the frame an opaque box)", async () => {
    let scheme = "light";
    const real = window.getComputedStyle.bind(window);
    vi.spyOn(window, "getComputedStyle").mockImplementation((el) => {
      const st = real(el);
      return el.tagName === "IFRAME" ? new Proxy(st, { get: (t, k) => (k === "colorScheme" ? scheme : Reflect.get(t, k)) }) : st;
    });
    const { ready, looks } = host({ css: CSS, body: '<button class="b">Book</button>{SNIPPET}' });
    ready();
    for (let i = 0; i < 7; i += 1) {
      document.documentElement.classList.toggle("dark");
      await wait(300);
    }
    expect(looks()).toHaveLength(6); // the first look and five changes: the budget is spent
    scheme = "dark";
    document.documentElement.classList.toggle("dark");
    await wait(300);
    expect(looks()).toHaveLength(7);
    expect(looks()[6].msg.q).toContain("&scheme=dark");
  });
});

describe("snippets without the opt-in are the R4 snippet, byte for byte", () => {
  // The exact snippet the kit gave before R13 (bookingEmbed.js @ 349a367f,
  // compact header on, 460 px) — what owners have pasted since R4.
  const R4 = [
    '<div data-bonbox-booking-wrap style="width:100%;max-width:460px;margin:0 auto">',
    '  <iframe data-bonbox-booking src="https://www.bonbox.dk/r/cafe?embed=1&amp;compact=1"',
    '    title="Book bord — Café" width="100%" height="720" loading="lazy"',
    '    style="display:block;border:0;width:100%;border-radius:16px"></iframe>',
    '  <p data-bonbox-booking-link style="margin:8px 0 0;text-align:center;font:400 14px/1.4 system-ui,sans-serif">',
    '    <a href="https://www.bonbox.dk/cafe" target="_blank" rel="noopener">Åbn booking →</a>',
    "  </p>",
    "  <script>",
    "  (function(){",
    "    var o='https://www.bonbox.dk';",
    "    function all(){return document.querySelectorAll('iframe[data-bonbox-booking]');}",
    "    if(location.protocol==='http:'&&o.indexOf('https:')===0){",
    "      var a=all();for(var i=0;i<a.length;i++)a[i].style.display='none';",
    "    }",
    "    window.addEventListener('message',function(e){",
    "      var d=e.data,h=d&&Math.round(+d.height);",
    "      if(e.origin!==o||!d||d.type!=='bonbox:height'||!(h>0&&h<20000))return;",
    "      var a=all();",
    "      for(var i=0;i<a.length;i++){",
    "        if(a[i].contentWindow!==e.source)continue;",
    "        a[i].style.setProperty('height',h+'px','important');",
    "        var w=a[i].closest&&a[i].closest('[data-bonbox-booking-wrap]');",
    "        var l=w&&w.querySelector('[data-bonbox-booking-link]');",
    "        if(l)l.style.display='none';",
    "      }",
    "    });",
    "  })();",
    "  </" + "script>",
    "</div>",
  ].join("\n");

  it("look off (and the default of iframeSnippet) = the R4 snippet exactly", () => {
    expect(iframeSnippet({ ...base, compact: true })).toBe(R4);
    expect(iframeSnippet({ ...base, compact: true, look: null })).toBe(R4);
    expect(R4).not.toMatch(/look|getComputedStyle|bonbox:look/);
  });

  it("an R4 snippet on a dark page: its address never gains a look, its frame never gets one", () => {
    const { frame } = host({ snippet: R4, css: "body { background-color: #000; color: #fff; }", body: "<div>{SNIPPET}</div>" });
    expect(frame.getAttribute("src")).toBe(`${ORIGIN}/r/cafe?embed=1&compact=1`);
    expect(lookFrom("?embed=1&compact=1", LOOK_RADII, LOOK_FONTS)).toBeNull();
  });

  it("a new snippet's script leaves an old frame on the same page alone", () => {
    document.body.innerHTML = "";
    const { frame } = host({
      css: CREAM,
      body: CREAM_BODY.replace("{SNIPPET}", R4.replace(/<script>[\s\S]*<\/script>/, "") + "{SNIPPET}"),
    });
    const frames = document.querySelectorAll("iframe[data-bonbox-booking]");
    expect(frames).toHaveLength(2);
    expect(frames[0].getAttribute("src")).toBe(`${ORIGIN}/r/cafe?embed=1&compact=1`);
    expect(frame.getAttribute("src")).toBe(`${ORIGIN}/r/cafe?embed=1&compact=1`); // querySelector finds the old one first
    expect(frames[1].getAttribute("src")).toMatch(/&look=1$/);
  });
});
