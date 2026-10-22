// Google showed "&amp;" in our snippet and kept a stale copy: every page
// signal named https://bonbox.dk while the server sends everyone to
// https://www.bonbox.dk. These pins keep the head honest and consistent.
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SHELL_TITLES } from "../lib/shellTitles";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = readFileSync(resolve(root, "index.html"), "utf8");
const sitemap = readFileSync(resolve(root, "public", "sitemap.xml"), "utf8");
const robots = readFileSync(resolve(root, "public", "robots.txt"), "utf8");

const metaContent = (attr, name) => {
  const m = html.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`));
  return m ? m[1] : null;
};

describe("landing head for search engines", () => {
  // Landing v6 (PORT_PLAN 2.6, removal audit 12/14): the shell's tab title is the landing's headline, and the
  // runtime swap for an English reader only fires while document.title is one of SHELL_TITLES — so the static
  // <title> must be exactly SHELL_TITLES.da, and the share cards say the same.
  it("the tab title, og:title and twitter:title are SHELL_TITLES.da exactly; the og image is the absolute v4 card", () => {
    const title = html.match(/<title>([^<]*)<\/title>/)[1];
    expect(title).toBe(SHELL_TITLES.da);
    expect(metaContent("property", "og:title")).toBe(SHELL_TITLES.da);
    expect(metaContent("name", "twitter:title")).toBe(SHELL_TITLES.da);
    expect(SHELL_TITLES.en).toBeTruthy();
    expect(SHELL_TITLES.en).not.toBe(SHELL_TITLES.da);
    expect(metaContent("property", "og:image")).toBe("https://www.bonbox.dk/og-image-v4.png");
    expect(metaContent("name", "twitter:image")).toBe("https://www.bonbox.dk/og-image-v4.png");
    expect(existsSync(resolve(root, "public", "og-image-v4.png"))).toBe(true);
  });

  it("descriptions carry no HTML entity (no '&amp;' can leak into a snippet)", () => {
    for (const [attr, name] of [["name", "description"], ["property", "og:description"], ["name", "twitter:description"]]) {
      const c = metaContent(attr, name);
      expect(c, name).toBeTruthy();
      expect(c, name).not.toMatch(/&[a-z]+;|&#/);
    }
  });

  it("canonical, og:url, structured data, sitemap and robots all name www.bonbox.dk", () => {
    expect(html).toContain('<link rel="canonical" href="https://www.bonbox.dk/" />');
    expect(metaContent("property", "og:url")).toBe("https://www.bonbox.dk/");
    expect(html).not.toMatch(/https:\/\/bonbox\.dk[/"]/);
    const locs = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]);
    expect(locs.length).toBeGreaterThan(0);
    for (const l of locs) expect(l.startsWith("https://www.bonbox.dk/")).toBe(true);
    expect(robots).toMatch(/^Sitemap: https:\/\/www\.bonbox\.dk\/sitemap\.xml$/m);
  });

  it("structured data claims only what is true: offered languages, no free price", () => {
    const ld = JSON.parse(html.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    expect(ld.url).toBe("https://www.bonbox.dk/");
    expect(ld.availableLanguage).toEqual(["da", "en"]);
    expect(ld.offers).toBeUndefined();
    expect(ld.description).not.toMatch(/&/);
  });

  it("offers Google a favicon that is a multiple of 48 px (owner and Vagtplan twins exist)", () => {
    for (const n of [48, 96]) {
      expect(html).toContain(`<link rel="icon" type="image/png" sizes="${n}x${n}" href="/favicon-${n}.png?v=3" />`);
      for (const f of [`favicon-${n}.png`, `vagtplan-favicon-${n}.png`]) {
        const buf = readFileSync(resolve(root, "public", f));
        expect(existsSync(resolve(root, "public", f))).toBe(true);
        expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([n, n]);
      }
    }
  });
});
