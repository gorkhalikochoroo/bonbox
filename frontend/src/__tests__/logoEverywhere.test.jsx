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
