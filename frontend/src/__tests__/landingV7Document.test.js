// @vitest-environment node
/**
 * Landing v7 speed (12 Nov 2026): "/" and "/v2" get their own document (dist/landing.html), every other address keeps
 * today's (dist/app.html, byte for byte index.html).
 *
 * Pins:
 *   - the build (vite.config.js landingDocument, after every transformIndexHtml hook, htmlDiet included): landing.html is
 *     index.html plus one phone-only rule carrying the hero picture's committed phone cut, last in <body>; app.html is
 *     index.html; index.html itself carries no hero picture and stays where it is, except in the Vercel build (VERCEL=1),
 *     which leaves it out so vercel.json's "/" rewrite decides; the Vagtplan build is untouched;
 *   - the landing document draws the same first screen (the markup React's first render equals:
 *     landingV7FirstScreen.test.jsx), with the same script as index.html;
 *   - the cut: 700 px wide, the hero picture's shape, small; drawn under the network picture on a phone only, with a
 *     selector that outranks the blur placeholder's;
 *   - vercel.json: "/" and "/v2" → /landing.html, /stand* → /stand.html, everything else → /app.html, read the way Vercel
 *     reads it (a real file first, then the rewrites in order): booking pages, staff links, the kitchen screen, deep links
 *     and the files (robots, sitemap, assets) all land where they did; with index.html present (a build without VERCEL),
 *     "/" is index.html and nothing breaks.
 * Node environment: htmlDiet runs esbuild, which does not start under jsdom.
 */
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import zlib from "node:zlib";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { FROM_PRICE } from "../lib/planPrices";
import {
  APP_DOC_V7, HERO_IMG_V7, HERO_PHONE_FILE_V7, HERO_PHONE_QUERY_V7, LANDING_DOC_V7, firstScreenMarkupV7, heroPhoneCssV7,
  landingDocumentV7,
} from "../../scripts/landingFirstScreenV7.mjs";

const FRONTEND = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const SRC = path.join(FRONTEND, "src");
const INDEX = fs.readFileSync(path.join(FRONTEND, "index.html"), "utf8");
const VERCEL = JSON.parse(fs.readFileSync(path.join(FRONTEND, "vercel.json"), "utf8"));
const CUT = fs.readFileSync(path.join(SRC, HERO_PHONE_FILE_V7));
const CUT_B64 = CUT.toString("base64");
const BUILT = INDEX
  .replace('<script type="module" src="/src/main.jsx"></script>', "")
  .replace("</head>", '<script type="module" crossorigin src="/assets/index-1.js"></script>\n<link rel="modulepreload" crossorigin href="/assets/vendor-react-2.js">\n<link rel="stylesheet" crossorigin href="/assets/index-3.css">\n</head>');
const LANDING_CHUNK = {
  type: "chunk", fileName: "assets/LandingV7Page-abc.js", facadeModuleId: "/repo/frontend/src/pages/LandingV7Page.jsx",
  imports: ["assets/index-1.js"], viteMetadata: { importedCss: new Set(["assets/LandingV7Page-abc.css"]) },
};
const BUNDLE = {
  "assets/LandingV7Page-abc.js": LANDING_CHUNK,
  "assets/index-1.js": { type: "chunk", fileName: "assets/index-1.js", facadeModuleId: "/repo/frontend/index.html", imports: [] },
  "assets/da-x.js": { type: "chunk", fileName: "assets/da-x.js", facadeModuleId: "/repo/frontend/src/i18n/da.js" },
  "assets/en-x.js": { type: "chunk", fileName: "assets/en-x.js", facadeModuleId: "/repo/frontend/src/i18n/en.js" },
  f400: { type: "asset", fileName: "assets/inter-latin-400-normal-a.woff2" },
};

/** index.html as the build writes it: every post transformIndexHtml hook, in order (htmlDiet last). */
async function builtIndex() {
  const { default: config } = await import("../../vite.config.js");
  let html = BUILT;
  for (const p of config.plugins.flat().filter((x) => x && x.transformIndexHtml && x.transformIndexHtml.order === "post")) {
    html = await p.transformIndexHtml.handler(html, { bundle: BUNDLE });
  }
  return html;
}
/** The landingDocument hook over a bundle holding that index.html: what it emits and what is left. */
async function runDocumentHook(index, { landing = true } = {}) {
  const { default: config } = await import("../../vite.config.js");
  const plugin = config.plugins.flat().find((x) => x && x.name === "bonbox-landing-document");
  const bundle = { "index.html": { type: "asset", fileName: "index.html", source: index }, "assets/index-1.js": BUNDLE["assets/index-1.js"] };
  if (landing) bundle["assets/LandingV7Page-abc.js"] = LANDING_CHUNK;
  const emitted = {};
  const ctx = { emitFile: (f) => { emitted[f.fileName] = f.source; }, error: (m) => { throw new Error(m); } };
  await plugin.generateBundle.handler.call(ctx, {}, bundle);
  return { emitted, bundle, plugin };
}
const scriptsOf = (html) => [...html.matchAll(/<script(\b[^>]*)>([\s\S]*?)<\/script>/g)].map((m) => m[2]);
const firstScreenScript = (html) => scriptsOf(html).find((x) => x.includes("lp6-first") && x.includes("insertAdjacentHTML"));
/** Run a document's first-screen script for a marked visitor; returns the markup it writes before itself. */
function drawFirstScreen(html, lang) {
  let written = null;
  const fakeRoot = { querySelectorAll: () => [], querySelector: () => null, addEventListener: () => {} };
  new Function("window", "document", "location", firstScreenScript(html))(
    { __lp6First: { lang } },
    { currentScript: { insertAdjacentHTML: (w, h) => { written = h; } }, getElementById: () => fakeRoot, head: { appendChild: () => {} }, createElement: () => ({}), addEventListener: () => {} },
    { search: "" });
  return written;
}
const savedVercel = process.env.VERCEL;
afterEach(() => { if (savedVercel === undefined) delete process.env.VERCEL; else process.env.VERCEL = savedVercel; });

describe("the build writes the landing its own document", () => {
  it("landing.html = index.html + the hero cut's rule, last in <body>; app.html = index.html, byte for byte", async () => {
    delete process.env.VERCEL;
    const index = await builtIndex();
    const { emitted, bundle } = await runDocumentHook(index);
    expect(Object.keys(emitted).sort()).toEqual([APP_DOC_V7, LANDING_DOC_V7].sort());
    expect(APP_DOC_V7).toBe("app.html");
    expect(LANDING_DOC_V7).toBe("landing.html");
    expect(emitted["app.html"]).toBe(index);
    const landing = emitted["landing.html"];
    expect(landing).toBe(landingDocumentV7(index));
    const style = `<style id="lp7-hero">${heroPhoneCssV7()}</style>`;
    expect(landing).toBe(index.replace("</body>", style + "</body>"));
    expect(landing.split('id="lp7-hero"')).toHaveLength(2);
    expect(landing.split(CUT_B64)).toHaveLength(2);
    // index.html stays in a build without VERCEL (the native apps load it)
    expect(bundle["index.html"].source).toBe(index);
  });

  it("every other route's document (index.html, app.html) carries no hero picture", async () => {
    delete process.env.VERCEL;
    const index = await builtIndex();
    const { emitted } = await runDocumentHook(index);
    for (const doc of [index, emitted["app.html"]]) {
      expect(doc).not.toContain("lp7-hero");
      expect(doc).not.toContain(CUT_B64.slice(0, 200));
      // the only pictures written into it are the two blur placeholders of the first-screen sheet (210 / 152 bytes)
      const inline = [...doc.matchAll(/data:image\/webp;base64,([A-Za-z0-9+/=]+)/g)].map((m) => Buffer.from(m[1], "base64").length);
      expect(inline.length).toBeLessThanOrEqual(2);
      for (const n of inline) expect(n).toBeLessThan(400);
    }
    // the landing's document is index.html plus about the cut's size (base64), nothing else
    const extra = emitted["landing.html"].length - index.length;
    expect(extra).toBeGreaterThan(CUT_B64.length);
    expect(extra).toBeLessThan(CUT_B64.length + 400);
    const br = (s) => zlib.brotliCompressSync(Buffer.from(s)).length;
    expect(br(emitted["landing.html"]) - br(index)).toBeLessThan(16000);
  });

  it("the Vercel build (VERCEL=1) leaves index.html out, so the rewrite decides \"/\"; the two documents are the same", async () => {
    const index = await builtIndex();
    process.env.VERCEL = "1";
    const { emitted, bundle } = await runDocumentHook(index);
    expect(bundle["index.html"]).toBeUndefined();
    expect(emitted["app.html"]).toBe(index);
    expect(emitted["landing.html"]).toBe(landingDocumentV7(index));
  });

  it("a build without the landing (the Vagtplan app) is untouched", async () => {
    process.env.VERCEL = "1";
    const { emitted, bundle } = await runDocumentHook("<html><body></body></html>", { landing: false });
    expect(emitted).toEqual({});
    expect(bundle["index.html"].source).toBe("<html><body></body></html>");
  });

  it("the hook runs after Vite has written index.html (generateBundle, order post); htmlDiet stays the last html hook", async () => {
    const { plugin } = await runDocumentHook(await builtIndex());
    expect(plugin.apply).toBe("build");
    expect(plugin.generateBundle.order).toBe("post");
    expect(plugin.transformIndexHtml).toBeUndefined();
    const cfg = fs.readFileSync(path.join(FRONTEND, "vite.config.js"), "utf8");
    expect(cfg).toMatch(/schedulerIcons\(\), landingDocument\(\), htmlDiet\(\),\n/);
    expect(cfg).toContain("if (process.env.VERCEL === '1') delete bundle['index.html']");
  });

  it("refuses a document it cannot place the rule in (no first screen, two </body>, already done)", () => {
    expect(() => landingDocumentV7("<html><body></body></html>")).toThrow(/no landing first screen/);
    expect(() => landingDocumentV7('<style id="lp6-css"></style></body></body>')).toThrow(/one <\/body>/);
    expect(() => landingDocumentV7('<style id="lp6-css"></style><style id="lp7-hero"></style></body>')).toThrow(/already/);
  });
});

describe("the landing document draws the same first screen", () => {
  it.each(["da", "en"])("%s: its script writes the first screen React's first render equals, as index.html's does", async (lang) => {
    const index = await builtIndex();
    const landing = landingDocumentV7(index);
    expect(firstScreenScript(landing)).toBe(firstScreenScript(index));
    const want = firstScreenMarkupV7(lang, { da, en, price: FROM_PRICE });
    expect(drawFirstScreen(landing, lang)).toBe(want);
    expect(drawFirstScreen(index, lang)).toBe(want);
    // the cut's rule sits after #root (React empties #root at takeover; the rule outlives it)
    expect(landing.indexOf('<style id="lp7-hero">')).toBeGreaterThan(landing.indexOf('<div id="root">'));
  });
});

describe("the hero picture's phone cut", () => {
  const webpSize = (buf) => {
    expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
    expect(buf.toString("ascii", 8, 15)).toBe("WEBPVP8");
    const vp8 = buf.indexOf(Buffer.from([0x9d, 0x01, 0x2a]));
    return { w: buf.readUInt16LE(vp8 + 3) & 0x3fff, h: buf.readUInt16LE(vp8 + 5) & 0x3fff };
  };
  it("is a 700 px cut of the week's draft: its shape, at most 16 KB", () => {
    const { w, h } = webpSize(CUT);
    expect(w).toBe(700);
    expect(Math.abs(w / h - 1600 / 1112)).toBeLessThan(0.01);
    const full = webpSize(fs.readFileSync(path.join(FRONTEND, "public", HERO_IMG_V7.src)));
    expect(full).toEqual({ w: 1600, h: 1112 });
    expect(CUT.length).toBeLessThan(16 * 1024);
    // never narrower than a phone draws the iPad (the hero's sizes: calc(100vw - 40px) up to 719 px), so Chrome sizes it
    // as the network picture and keeps it as the largest paint
    expect(HERO_IMG_V7.sizes.startsWith("(max-width: 719px) calc(100vw - 40px)")).toBe(true);
    expect(w).toBeGreaterThanOrEqual(719 - 40);
  });

  it("is drawn on a phone only, under the network picture, with a selector that outranks the blur placeholder's", () => {
    const css = heroPhoneCssV7();
    expect(HERO_PHONE_QUERY_V7).toBe("(max-width:719px)");
    expect(css.startsWith(`@media ${HERO_PHONE_QUERY_V7}{`)).toBe(true);
    expect(css).toContain(`url(data:image/webp;base64,${CUT_B64})`);
    expect(css).toContain("center top/cover no-repeat");
    const sel = css.match(/\{([^{}]+)\{/)[1];
    expect(sel).toBe(".lp7 .stage-wrap .stage .ipad .scr");
    const sheet = fs.readFileSync(path.join(SRC, "components/landing/v7/landingV7.css"), "utf8");
    expect(sheet).toContain(".lp7 .stage .ipad .scr{background:var(--paper) url(\"data:image/webp;base64,");
    const classes = (s) => (s.match(/\.[\w-]+/g) || []).length;
    expect(classes(sel)).toBeGreaterThan(classes(".lp7 .stage .ipad .scr"));
    // the network picture keeps the same crop as the cut (cover, top)
    expect(sheet).toContain(".lp7 .scr img{display:block;width:100%;height:100%;object-fit:cover;object-position:top center}");
  });
});

/* Vercel's order for vercel.json (rewrites after the filesystem): a real file wins — "/" is its directory index,
 * /index.html, when the output has one — then the rewrites, in order, each destination checked against the files. */
function vercelServe(files, path0) {
  const has = (p) => files.includes(p);
  const fileAt = (p) => (p.endsWith("/") ? (has(p + "index.html") ? p + "index.html" : null) : has(p) ? p : null);
  const direct = fileAt(path0);
  if (direct) return direct;
  for (const r of VERCEL.rewrites) {
    if (!r.destination.startsWith("/")) continue;
    const re = new RegExp("^" + r.source.split("(.*)").map((part) => part.replace(/[.+?^${}|[\]\\*()]/g, "\\$&")
      .replace(/\/:\w+\\\*/g, "(?:/.*)?").replace(/:\w+/g, "[^/]+")).join("(.*)") + "$");
    if (re.test(path0)) { const d = fileAt(r.destination); if (d) return d; }
  }
  return null;
}
const OUTPUT = ["/landing.html", "/app.html", "/stand.html", "/assets/index-1.js", "/robots.txt", "/sitemap.xml",
  "/manifest.json", "/sw.js", "/og-image-v7.png", "/static/landing-v7/sched-draft-700.webp", "/favicon.ico"];

describe("vercel.json: the landing's document for \"/\" and \"/v2\", today's for everything else", () => {
  it("rewrites, in order: the API manifest, /stand, /stand/*, \"/\" and \"/v2\" → /landing.html, the catch-all → /app.html", () => {
    expect(VERCEL.rewrites.map((r) => [r.source, r.destination])).toEqual([
      ["/portal/:token/app.webmanifest", "https://api.bonbox.dk/api/portal/:token/manifest.webmanifest"],
      ["/stand", "/stand.html"],
      ["/stand/:path*", "/stand.html"],
      ["/", "/landing.html"],
      ["/v2", "/landing.html"],
      ["/(.*)", "/app.html"],
    ]);
    // the redirect runs before any rewrite, the security headers match by the address asked for ("/" included)
    expect(VERCEL.redirects.map((r) => r.source)).toEqual(["/api/email/unsubscribe"]);
    const site = VERCEL.headers.find((h) => h.source === "/(.*)");
    expect(new RegExp("^" + site.source + "$").test("/")).toBe(true);
    expect(site.headers.map((h) => h.key)).toContain("Content-Security-Policy");
  });

  it("the Vercel output (no index.html): every address lands where it should", () => {
    const at = (p) => vercelServe(OUTPUT, p);
    expect(at("/")).toBe("/landing.html");
    expect(at("/v2")).toBe("/landing.html");
    for (const p of ["/login", "/register", "/dashboard", "/r/cafe-roma", "/r/cafe-roma/embed", "/s/abc123", "/kitchen", "/kitchen/abc",
      "/join", "/contact", "/privacy", "/index.html", "/v2/", "/workshop/job/1", "/assets/missing-old-chunk.js"]) {
      expect([p, at(p)]).toEqual([p, "/app.html"]);
    }
    expect(at("/stand")).toBe("/stand.html");
    expect(at("/stand/tok")).toBe("/stand.html");
    for (const f of ["/robots.txt", "/sitemap.xml", "/manifest.json", "/sw.js", "/og-image-v7.png", "/assets/index-1.js",
      "/static/landing-v7/sched-draft-700.webp", "/favicon.ico", "/landing.html", "/app.html"]) expect(at(f)).toBe(f);
  });

  it("an output that still has index.html (a build without VERCEL) answers \"/\" with it and every other address as before", () => {
    const at = (p) => vercelServe([...OUTPUT, "/index.html"], p);
    expect(at("/")).toBe("/index.html");
    expect(at("/v2")).toBe("/landing.html");
    expect(at("/r/cafe-roma")).toBe("/app.html");
    expect(at("/stand")).toBe("/stand.html");
  });

  it("a deep link to a section (/#priser) is \"/\" to the server: the landing's document", () => {
    expect(new URL("https://www.bonbox.dk/#priser").pathname).toBe("/");
    expect(vercelServe(OUTPUT, new URL("https://www.bonbox.dk/#priser").pathname)).toBe("/landing.html");
  });

  it("the native apps keep index.html: Capacitor's webDir is dist and package.json's build is unchanged", () => {
    const cap = JSON.parse(fs.readFileSync(path.join(FRONTEND, "capacitor.config.json"), "utf8"));
    expect(cap.webDir).toBe("dist");
    expect(cap.server && cap.server.url).toBeUndefined();
    expect(JSON.parse(fs.readFileSync(path.join(FRONTEND, "package.json"), "utf8")).scripts.build).toBe("vite build && vite build --config vite.stand.config.js");
  });
});
