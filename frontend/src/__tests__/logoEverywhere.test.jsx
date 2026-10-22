/**
 * The logo sweep after the kit landed (docs/brand, 11 Oct 2026): the surfaces
 * that still wore an old tile, a stand-in icon, or no mark at all.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const read = (p) => readFileSync(join(SRC, p), "utf8");
const REPO = join(SRC, "..", "..");

describe("old tiles became the forest tile", () => {
  it.each([
    ["components/TrialBanner.jsx", ["📦"]],
    ["components/InstallAppPrompt.jsx", ['name="Sparkles"', "bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0"]],
    ["pages/StandPairPage.jsx", ["CalendarCheck", "<CalendarCheck"]],
  ])("%s", (file, gone) => {
    const s = read(file);
    expect(s).toMatch(/import BonBoxMark from/);
    expect(s).toContain("bg-bb-forest text-bb-paper");
    for (const g of gone) expect(s, g).not.toContain(g);
  });

  it("InstallAppPrompt carries the tile on both its paths (iOS hint + install)", () => {
    const s = read("components/InstallAppPrompt.jsx");
    expect(s.match(/<BonBoxMark size=\{28\} \/>/g)).toHaveLength(2);
  });

  it.each(["pages/AcceptInvitePage.jsx", "pages/TeamAcceptInvitePage.jsx"])(
    "%s puts the mark above its heading, like the auth pages",
    (file) => {
      const s = read(file);
      const tile = s.indexOf("bg-bb-forest text-bb-paper");
      expect(tile).toBeGreaterThan(-1);
      expect(s.indexOf("<h1", tile)).toBeGreaterThan(tile);
      expect(s.slice(0, tile)).not.toMatch(/<h1/);
    },
  );
});

describe("the staff portal wears the Vagtplan icons after /join", () => {
  const load = () => import("../lib/vagtplanIcons");

  const head = () => {
    document.head.innerHTML = [
      '<link rel="icon" href="/favicon.ico?v=3" sizes="16x16 32x32">',
      '<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png?v=3">',
      '<link rel="icon" type="image/png" sizes="16x16" href="/favicon-16.png?v=3">',
      '<link rel="apple-touch-icon" href="/apple-touch-icon.png?v=3">',
    ].join("");
  };
  const hrefs = () =>
    [...document.head.querySelectorAll("link")].map((l) => l.getAttribute("href"));

  it("swaps every icon link to its Vagtplan file, and puts them back", async () => {
    const { applyVagtplanIcons } = await load();
    head();
    const restore = applyVagtplanIcons();
    expect(hrefs()).toEqual([
      "/vagtplan-favicon.ico?v=3", "/vagtplan-favicon-32.png?v=3",
      "/vagtplan-favicon-16.png?v=3", "/vagtplan-apple-touch-icon.png?v=3",
    ]);
    // A second swap (the head script already ran on /s/…) changes nothing,
    // and undoing it leaves the first swap in place.
    const again = applyVagtplanIcons();
    again();
    expect(hrefs()[0]).toBe("/vagtplan-favicon.ico?v=3");
    restore();
    expect(hrefs()).toEqual([
      "/favicon.ico?v=3", "/favicon-32.png?v=3", "/favicon-16.png?v=3", "/apple-touch-icon.png?v=3",
    ]);
  });

  it("is the same rule as the index.html head script, and every target ships", async () => {
    const { VAGTPLAN_APPLE_TOUCH_ICON } = await load();
    const html = readFileSync(join(SRC, "..", "index.html"), "utf8");
    expect(html).toContain(`"${VAGTPLAN_APPLE_TOUCH_ICON}"`);
    expect(html).toContain('href.replace("/favicon", "/vagtplan-favicon")');
    const lib = read("lib/vagtplanIcons.js");
    expect(lib).toContain('href.replace("/favicon", "/vagtplan-favicon")');
  });

  it("StaffPortalPage applies it on mount, keyed on the token", () => {
    const s = read("pages/StaffPortalPage.jsx");
    expect(s).toMatch(/import \{ applyVagtplanIcons \} from "\.\.\/lib\/vagtplanIcons";/);
    expect(s).toMatch(/if \(!token\) return undefined;\s*return applyVagtplanIcons\(\);\s*\}, \[token\]\);/);
  });

  it("the push hints point at the Vagtplan icon, in en, da and the inline fallbacks", () => {
    const en = read("i18n/en.js");
    const da = read("i18n/da.js");
    const page = read("pages/StaffPortalPage.jsx");
    for (const [src, key, word] of [
      [en, "staffPushIosInstallHint", "Vagtplan icon"],
      [en, "staffPushBlockedHint", "Vagtplan icon"],
      [da, "staffPushIosInstallHint", "Vagtplan-ikon"],
      [da, "staffPushBlockedHint", "Vagtplan-ikon"],
    ]) {
      const line = src.split("\n").find((l) => l.trim().startsWith(`${key}:`));
      expect(line, key).toContain(word);
      expect(line, key).not.toMatch(/Open BonBox|Åbn BonBox|→ BonBox/);
    }
    expect(page).not.toMatch(/Open BonBox from the home-screen icon|Notifications → BonBox/);
  });
});

describe("the wordmark is the kit's, not typed", () => {
  const kit = readFileSync(join(REPO, "docs/brand/wordmark/bonbox-wordmark-forest.svg"), "utf8");

  it("draws the one path from docs/brand/wordmark, in currentColor, sized by height", async () => {
    const { default: BonBoxWordmark, BONBOX_WORDMARK_VIEWBOX } = await import("../components/BonBoxWordmark");
    const { container } = render(<BonBoxWordmark height={17} className="text-bb-forest" />);
    const svg = container.querySelector("svg");
    const paths = svg.querySelectorAll("path");
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute("d")).toBe(kit.match(/<path d="([^"]+)"/)[1]);
    expect(svg.getAttribute("viewBox")).toBe(kit.match(/viewBox="([^"]+)"/)[1]);
    expect(BONBOX_WORDMARK_VIEWBOX).toBe("0 -700 3299.67 710");
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("height")).toBe("17");
    expect(svg.getAttribute("width")).toBe("79"); // 17 x 3299.67 / 710
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("BonBox");
    expect(svg.getAttribute("class")).toContain("text-bb-forest");
  });

  it("is decorative only when told", async () => {
    const { default: BonBoxWordmark } = await import("../components/BonBoxWordmark");
    const svg = render(<BonBoxWordmark title="" />).container.querySelector("svg");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
  });

  // [file, wordmark heights, ground]
  it.each([
    ["components/Layout.jsx", [14, 17], "both"],
    ["components/auth/AuthUI.jsx", [24], "both"],
    ["components/landing/v2/NavV2.jsx", [18], "light"],
    ["components/landing/v2/FooterV2.jsx", [17], "light"],
    ["pages/TermsPage.jsx", [24], "dark"],
    ["pages/PrivacyPolicyPage.jsx", [24], "dark"],
    ["pages/CookiePolicyPage.jsx", [24], "dark"],
    ["pages/OnboardingPage.jsx", [17], "both"],
    ["pages/FirstStepsPage.jsx", [17], "both"],
  ])("%s sets the wordmark next to the mark", (file, heights, ground) => {
    const s = read(file);
    expect(s).toMatch(/import BonBoxWordmark from/);
    for (const h of heights) expect(s).toContain(`<BonBoxWordmark height={${h}}`);
    // No typed word left beside the tile.
    expect(s).not.toMatch(/>\s*BonBox\s*<\/(span|h1|p)>/);
    if (ground === "light") expect(s).toMatch(/BonBoxWordmark height=\{\d+\} className="text-bb-forest"/);
    if (ground === "dark") expect(s).toMatch(/BonBoxWordmark height=\{\d+\} className="text-bb-paper"/);
    if (ground === "both") expect(s).toMatch(/text-bb-forest dark:text-bb-paper/);
  });

  it("the app chrome keeps its one <h1> and the boxes the typed word sat in", () => {
    const s = read("components/Layout.jsx");
    expect(s).toMatch(/<h1 className="flex items-center h-7 text-bb-forest dark:text-bb-paper">\s*<BonBoxWordmark height=\{17\} \/>/);
    expect(s).toMatch(/<p className="flex items-center h-6 text-bb-forest dark:text-bb-paper">\s*<BonBoxWordmark height=\{14\} \/>/);
  });
});

describe("the share image and the public demo pages", () => {
  const PUBLIC = join(SRC, "..", "public");
  const pngSize = (p) => {
    const b = readFileSync(p);
    return [b.readUInt32BE(16), b.readUInt32BE(20)];
  };

  // Landing v6 (port step 5/6, PORT_PLAN 2.6): the card is og-image-v4.png, the v6 page's own (a new name, so no
  // scraper's cache answers with v3's picture). v2 and v3 stay in public/ for pages that already reference them.
  it("index.html shares og-image-v4.png (a new name, 1200 x 630); v2 and v3 stay", () => {
    const html = readFileSync(join(SRC, "..", "index.html"), "utf8");
    expect(html).toContain('<meta property="og:image" content="https://www.bonbox.dk/og-image-v4.png" />');
    expect(html).toContain('<meta name="twitter:image" content="https://www.bonbox.dk/og-image-v4.png" />');
    expect(html).not.toMatch(/content="[^"]*og-image-v[23]\.png/);
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:image:height" content="630" />');
    expect(pngSize(join(PUBLIC, "og-image-v4.png"))).toEqual([1200, 630]);
    expect(pngSize(join(PUBLIC, "og-image-v3.png"))).toEqual([1200, 630]);
    expect(pngSize(join(PUBLIC, "og-image-v2.png"))).toEqual([1200, 630]);
  });

  it("the demo reel opens on the kit's paper lock-up, inline", () => {
    const reel = readFileSync(join(PUBLIC, "demo-reel.html"), "utf8");
    const kit = readFileSync(join(REPO, "docs/brand/lockup/bonbox-lockup-paper.svg"), "utf8");
    const kitPaths = [...kit.matchAll(/<path d="([^"]+)"/g)].map((m) => m[1]);
    expect(kitPaths).toHaveLength(2);
    for (const d of kitPaths) expect(reel).toContain(`<path d="${d}" fill="#F6F4EC"/>`);
    expect(reel).not.toContain('<div class="logo">BonBox</div>');
  });

  it("the icon generator draws the kit's app icon, not the receipt", () => {
    const gen = readFileSync(join(PUBLIC, "icon-generator.html"), "utf8");
    const kit = readFileSync(join(REPO, "docs/brand/app-icon/bonbox-app-icon-1024.svg"), "utf8");
    expect(gen).toContain(`const KIT_B = "${kit.match(/<path d="([^"]+)"/)[1]}";`);
    expect(gen).toContain('const KIT_FOREST = "#093A26";');
    expect(gen).toContain('const KIT_PAPER = "#F6F4EC";');
    expect(gen).not.toMatch(/fillText\('B'|#16a34a'|#facc15/);
  });
});
