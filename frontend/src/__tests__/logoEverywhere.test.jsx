/**
 * The logo sweep after the kit landed (docs/brand, 11 Oct 2026): the surfaces
 * that still wore an old tile, a stand-in icon, or no mark at all.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const read = (p) => readFileSync(join(SRC, p), "utf8");

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
