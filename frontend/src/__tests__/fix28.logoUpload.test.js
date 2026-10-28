/**
 * 28 Oct 2026: the logo upload in Profil took PNG or JPEG up to 1 MB, which
 * refused most phone photos of a logo and every WebP logo saved from a
 * website. The page and the server now agree on 10 MB and PNG / JPEG / WebP
 * (the server stores a small PNG). The words say the same in da and en.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const HERE = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(HERE, "..", "pages", "ProfilePage.jsx"), "utf8");
const server = readFileSync(join(HERE, "..", "..", "..", "backend", "app", "services", "logo_service.py"), "utf8");

describe("logo upload limits match the server", () => {
  it("the page allows 10 MB, the server's MAX_LOGO_BYTES", () => {
    expect(server).toMatch(/^MAX_LOGO_BYTES = 10_000_000\b/m);
    expect(page).toContain("file.size > 10_000_000");
    expect(page).not.toContain("file.size > 1_000_000");
  });

  it("the page takes PNG, JPEG and WebP, and the picker offers the same", () => {
    expect(page).toContain('["image/png", "image/jpeg", "image/webp"].includes(file.type)');
    expect(page).toContain('accept="image/png,image/jpeg,image/webp"');
    expect(server).toContain('formats=["PNG", "JPEG", "WEBP"]');
  });

  it("the words say 10 MB and WebP in da and en, and the inline fallbacks agree", async () => {
    const { da } = await import("../i18n/da");
    const { en } = await import("../i18n/en");
    for (const d of [da, en]) {
      expect(d.profLogoTooLargeError).toContain("10 MB");
      expect(d.brandLogoHint).toContain("10 MB");
      expect(d.brandLogoHint).toContain("WebP");
      expect(d.profLogoFormatError).toContain("WebP");
    }
    expect(page).toContain('"Logo too large (max 10 MB)"');
    expect(page).toContain('"PNG, JPEG or WebP, max 10 MB. Auto-resized + EXIF stripped for privacy."');
  });
});
