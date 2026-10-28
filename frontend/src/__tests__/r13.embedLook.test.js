/**
 * Booking R13 — the snippet's HOST half: what the script reads on the
 * restaurant's page (utils/bookingEmbed.js, LOOK_JS), run here in jsdom on
 * stand-in websites:
 *   - a cream site in Georgia with pill buttons;
 *   - a black site with square gold buttons;
 *   - a photo behind the booking;
 *   - a site with no button (and one whose only button is its own ground);
 *   - a site that switches to dark (a class on <html>) after the frame is up;
 *   - fonts: a system font passes, a web font does not, a heading can stand
 *     in for the body, an unstyled document (Wix's Embed HTML box) gives none;
 *   - the owner's override (data-bonbox-look / data-bonbox-accent);
 *   - what leaves the page: hex digits and fixed words only, to the booking
 *     origin only — even from a hostile stylesheet;
 *   - the old snippets: no opt-in, the R4 snippet byte for byte.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LOOK_FRAME_RADIUS, LOOK_SAMPLES, iframeSnippet, lookOf, sampleLookQuery } from "../utils/bookingEmbed";
import { LOOK_FONTS, LOOK_RADII, lookFrom } from "../lib/bookingLook";

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
// snippet's script the way the browser would (innerHTML never runs one).
const pasted = [];
function host({ css = "", body = '<main>{SNIPPET}</main>', look = AUTO, snippet = null, styled = true } = {}) {
  const s = snippet || iframeSnippet({ ...base, compact: true, look });
  const style = document.createElement("style");
  style.textContent = css;
  if (styled) document.head.appendChild(style);
  document.body.innerHTML = body.replace("{SNIPPET}", s.replace(/<script>[\s\S]*<\/script>/, ""));
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
  try {
    new Function("location", scriptOf(s))({ protocol: "https:" });
  } finally {
    window.addEventListener = realAdd;
    window.MutationObserver = RealMO;
  }
  const rec = { style, observers, listeners };
  pasted.push(rec);
  const frame = document.querySelector("iframe[data-bonbox-booking]");
  const q = () => {
    const src = frame.getAttribute("src");
    return src.slice(src.indexOf("look=1"));
  };
  return { frame, q };
}

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
  it("reads its surface, ink, button colour + text, round corners and Georgia — before the frame loads", () => {
    const { frame, q } = host({ css: CREAM, body: CREAM_BODY });
    expect(q()).toBe("look=1&surface=f4efe6&ink=2b2118&accent=7c4a1e&accent_ink=ffffff&radius=round&font=georgia");
    // the frame's own address: the snippet's query first, then the look
    expect(frame.getAttribute("src")).toBe(`${ORIGIN}/r/cafe?embed=1&compact=1&` + q());
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
    expect(iframeSnippet({ ...base, look: AUTO })).toContain('<iframe data-bonbox-booking data-bonbox-look="auto" data-bonbox-accent="site" src=');
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
    ["light", "&scheme=light"], ["normal", ""], ["", ""],
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

  it("reads it again and posts the new look to the frame (no reload), only to the booking origin, at most five times", async () => {
    const { frame, q } = host({ css: CSS, body: '<button class="b">Book</button>{SNIPPET}' });
    const first = q();
    expect(first).toBe("look=1&surface=ffffff&ink=1a1a1a&accent=1d4ed8&accent_ink=ffffff&radius=sharp&font=georgia");
    const posted = [];
    frame.contentWindow.postMessage = (msg, origin) => posted.push({ msg, origin });
    // the frame says its height: it is up
    window.dispatchEvent(new MessageEvent("message", { data: { type: "bonbox:height", height: 700 }, origin: ORIGIN, source: frame.contentWindow }));
    expect(frame.style.height).toBe("700px");
    expect(posted).toEqual([]); // nothing new to say yet

    document.documentElement.classList.add("dark");
    await new Promise((r) => setTimeout(r, 260));
    expect(posted).toHaveLength(1);
    expect(posted[0].origin).toBe(ORIGIN);
    expect(posted[0].msg).toEqual({
      type: "bonbox:look",
      q: "look=1&surface=101010&ink=f0f0f0&accent=1d4ed8&accent_ink=ffffff&radius=sharp&font=georgia",
    });
    expect(posted[0].msg.q).toMatch(SAFE_Q);
    expect(frame.getAttribute("src")).toContain(first); // never reloaded

    // flip-flopping: at most five changes are sent per page view
    for (let i = 0; i < 8; i += 1) {
      document.documentElement.classList.toggle("dark");
      await new Promise((r) => setTimeout(r, 200));
    }
    expect(posted).toHaveLength(5);
  });

  it("a look found before the frame is up is sent with its first height, once", async () => {
    const { frame } = host({ css: CSS, body: '<button class="b">Book</button>{SNIPPET}' });
    const posted = [];
    frame.contentWindow.postMessage = (msg, origin) => posted.push({ msg, origin });
    document.documentElement.classList.add("dark");
    await new Promise((r) => setTimeout(r, 260));
    expect(posted).toEqual([]); // the frame is not up: nothing sent, nothing reloaded
    const send = () =>
      window.dispatchEvent(new MessageEvent("message", { data: { type: "bonbox:height", height: 640 }, origin: ORIGIN, source: frame.contentWindow }));
    send();
    send();
    expect(posted).toHaveLength(1);
    expect(posted[0].msg.q).toMatch(/surface=101010/);
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

describe("the script itself", () => {
  it("is ES5 with no line comments and parses on one line (builders paste it as-is)", () => {
    const body = scriptOf(iframeSnippet({ ...base, look: AUTO }));
    expect(body).not.toMatch(/(^|[^:])\/\//m);
    expect(body).not.toMatch(/=>|\blet\b|\bconst\b|`/);
    expect(() => new Function(body.replace(/\n/g, " "))).not.toThrow();
  });

  it("posts only to the booking origin it was built for", () => {
    const body = scriptOf(iframeSnippet({ ...base, look: AUTO }));
    expect(body.match(/postMessage\([^)]*\)/g)).toEqual([
      "postMessage({type:'bonbox:look',q:a[i].bbQ},o)",
      "postMessage({type:'bonbox:look',q:q},o)",
    ]);
    expect(body).toContain(`var o='${ORIGIN}';`);
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
    expect(frames[1].getAttribute("src")).toMatch(/&look=1&/);
  });
});
