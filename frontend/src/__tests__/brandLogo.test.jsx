/**
 * The logo is the kit's, everywhere (docs/brand/README.md, 11 Oct 2026).
 *
 * The old mark drifted three ways before BonBoxMark existed — the app chrome,
 * the landing nav and the favicon each drew their own. These guards pin the
 * one glyph to the kit file, keep the retired notepad from coming back, and
 * check the icon files the HTML and the manifests point at are really there.
 */
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { readFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, extname } from "node:path";
import BonBoxMark from "../components/BonBoxMark";
import { BRAND_LOGO_HEX } from "../config/navChrome";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const FRONTEND = join(SRC, "..");
const REPO = join(FRONTEND, "..");
const PUBLIC = join(FRONTEND, "public");
const read = (p) => readFileSync(p, "utf8");

// ── WCAG 2.1 contrast (same formula as chromeTokens.test.js) ─────────────
const channel = (c) => {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex) => {
  const h = hex.replace("#", "");
  return (
    0.2126 * channel(parseInt(h.slice(0, 2), 16)) +
    0.7152 * channel(parseInt(h.slice(2, 4), 16)) +
    0.0722 * channel(parseInt(h.slice(4, 6), 16))
  );
};
const contrast = (fg, bg) => {
  const [hi, lo] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
  return (hi + 0.05) / (lo + 0.05);
};

/** PNG width/height straight from the IHDR chunk. */
const pngSize = (p) => {
  const b = readFileSync(p);
  return [b.readUInt32BE(16), b.readUInt32BE(20)];
};

const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });

describe("BonBoxMark is the kit's symbol", () => {
  it("draws the one path from docs/brand/symbol/bonbox-symbol.svg, in currentColor", () => {
    const kit = read(join(REPO, "docs/brand/symbol/bonbox-symbol.svg"));
    const kitPath = kit.match(/<path d="([^"]+)"/)[1];
    const { container } = render(<BonBoxMark size={24} />);
    const svg = container.querySelector("svg");
    const paths = svg.querySelectorAll("path");
    expect(paths).toHaveLength(1);
    expect(paths[0].getAttribute("d")).toBe(kitPath);
    expect(svg.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
    expect(svg.getAttribute("width")).toBe("24");
  });

  it("is decorative by default and named when a title is passed", () => {
    const { container, rerender } = render(<BonBoxMark />);
    let svg = container.querySelector("svg");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
    rerender(<BonBoxMark title="BonBox" />);
    svg = container.querySelector("svg");
    expect(svg.getAttribute("role")).toBe("img");
    expect(svg.getAttribute("aria-label")).toBe("BonBox");
    expect(svg.getAttribute("aria-hidden")).toBeNull();
  });

  it("still accepts the old strokeWidth prop without drawing a stroke", () => {
    const { container } = render(<BonBoxMark size={16} strokeWidth={2} className="text-bb-paper" />);
    const svg = container.querySelector("svg");
    expect(svg.getAttribute("stroke-width")).toBeNull();
    expect(svg.getAttribute("stroke")).toBeNull();
    expect(svg.getAttribute("class")).toBe("text-bb-paper");
  });
});

describe("the logo colours", () => {
  const css = read(join(SRC, "index.css")).replace(/\/\*[\s\S]*?\*\//g, "");
  it("index.css carries the kit's forest and paper, mirrored in navChrome", () => {
    expect(css).toMatch(new RegExp(`--color-bb-forest:\\s*${BRAND_LOGO_HEX.tile};`, "i"));
    expect(css).toMatch(new RegExp(`--color-bb-paper:\\s*${BRAND_LOGO_HEX.ink};`, "i"));
    expect(BRAND_LOGO_HEX).toEqual({ tile: "#093A26", ink: "#F6F4EC" });
  });

  it("paper on forest clears AA text contrast (the kit measures 11.6:1)", () => {
    expect(contrast(BRAND_LOGO_HEX.ink, BRAND_LOGO_HEX.tile)).toBeGreaterThan(11);
  });
});

describe("the retired notepad mark is gone from the source", () => {
  const files = walk(SRC).filter(
    (p) => [".js", ".jsx"].includes(extname(p)) && !p.includes("__tests__") && !/\.test\./.test(p),
  );

  it("no file draws the old notepad glyph by hand", () => {
    const offenders = files.filter((p) => {
      const s = read(p);
      return s.includes("M8 8h8M8 12h8M8 16h5") || s.includes("M9 8h10M9 12h10M9 16h6");
    });
    expect(offenders).toEqual([]);
  });

  it("no file in backend/app draws it either (the owner mails used to)", () => {
    const py = walk(join(REPO, "backend/app")).filter((p) => extname(p) === ".py");
    expect(py.length).toBeGreaterThan(50);
    const offenders = py.filter((p) => {
      const s = read(p);
      return s.includes("M8 8h8M8 12h8M8 16h5") || s.includes("M9 8h10M9 12h10M9 16h6");
    });
    expect(offenders).toEqual([]);
  });

  it("no logo tile types the letter B instead of drawing the b", () => {
    const offenders = files.filter((p) => /<(div|span)[^>]*>\s*B\s*<\/(div|span)>/.test(read(p)));
    expect(offenders).toEqual([]);
  });

  it("the first-run headers after /register carry the forest tile", () => {
    for (const page of ["pages/OnboardingPage.jsx", "pages/FirstStepsPage.jsx"]) {
      const s = read(join(SRC, page));
      expect(s, page).toMatch(/import BonBoxMark from/);
      expect(s, page).toContain("bg-bb-forest text-bb-paper");
      expect(s, page).not.toContain("bg-gray-900 dark:bg-gray-100 grid place-items-center");
    }
  });

  it("every file that places the mark puts it on the forest tile", () => {
    const users = files.filter((p) => /import BonBoxMark from/.test(read(p)));
    expect(users.length).toBeGreaterThanOrEqual(10);
    const missing = users.filter((p) => !read(p).includes("bg-bb-forest"));
    expect(missing).toEqual([]);
  });
});

describe("the icon files the HTML and the manifests point at", () => {
  const html = read(join(FRONTEND, "index.html"));
  const hrefs = [...html.matchAll(/<link rel="(?:icon|apple-touch-icon)"[^>]*href="([^"]+)"/g)].map((m) => m[1]);

  it("the icon links are the kit's favicon snippet, with no SVG link", () => {
    // The b is drawn separately for 16 and 32 px. An SVG link would win in
    // Firefox and scale the 32 px drawing down to a soft 16 px tab icon.
    expect(hrefs.map((h) => h.split("?")[0])).toEqual([
      "/favicon.ico", "/favicon-32.png", "/favicon-16.png", "/icon-192.png", "/apple-touch-icon.png",
    ]);
    expect(html).not.toMatch(/<link rel="icon" type="image\/svg\+xml"/);
    expect(html).toMatch(/<link rel="icon" href="\/favicon\.ico\?v=3" sizes="16x16 32x32" \/>/);
    expect(pngSize(join(PUBLIC, "apple-touch-icon.png"))).toEqual([180, 180]);
    expect(pngSize(join(PUBLIC, "vagtplan-apple-touch-icon.png"))).toEqual([180, 180]);
    // Kept as a file: sw.js precaches it, and pages served before the kit
    // (the e-mail opt-out page linked it until 11 Oct) may still ask for it.
    expect(existsSync(join(PUBLIC, "favicon.svg"))).toBe(true);
  });

  it("every icon link resolves to a real file and carries the same cache param", () => {
    expect(hrefs.length).toBeGreaterThanOrEqual(4);
    for (const h of hrefs) {
      const [path, query] = h.split("?");
      expect(existsSync(join(PUBLIC, path)), path).toBe(true);
      expect(query).toBe("v=3");
    }
  });

  it("staff routes swap to a Vagtplan file that exists for every icon link", () => {
    expect(html).toContain('"/vagtplan-apple-touch-icon.png?v=3"');
    expect(html).toContain('href.replace("/favicon", "/vagtplan-favicon")');
    expect(existsSync(join(PUBLIC, "vagtplan-apple-touch-icon.png"))).toBe(true);
    for (const h of hrefs.filter((x) => x.startsWith("/favicon"))) {
      const swapped = h.split("?")[0].replace("/favicon", "/vagtplan-favicon");
      expect(existsSync(join(PUBLIC, swapped)), swapped).toBe(true);
    }
  });

  it.each([
    ["manifest.json", JSON.parse(read(join(PUBLIC, "manifest.json"))).icons],
    ["stand.webmanifest", JSON.parse(read(join(PUBLIC, "stand.webmanifest"))).icons],
  ])("%s: real files, true sizes, and maskable kept apart from any", (_name, icons) => {
    for (const icon of icons) {
      const path = icon.src.split("?")[0];
      expect(existsSync(join(PUBLIC, path)), path).toBe(true);
      const [w, h] = pngSize(join(PUBLIC, path));
      expect(`${w}x${h}`).toBe(icon.sizes);
      // "any maskable" on one file shows the padded art in "any" contexts
      // or crops the full-bleed art under a mask. One purpose per entry.
      expect(["any", "maskable"]).toContain(icon.purpose);
    }
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
    expect(icons.some((i) => i.purpose === "any")).toBe(true);
  });

  it("the staff portal's web manifest points at Vagtplan files the frontend ships", () => {
    const py = read(join(REPO, "backend/app/routers/staff_portal.py"));
    const srcs = [...py.matchAll(/\{"src": "([^"]+)", "sizes": "(\d+x\d+)"/g)];
    expect(srcs.length).toBeGreaterThanOrEqual(4);
    for (const [, src, sizes] of srcs) {
      const path = src.split("?")[0];
      expect(path.startsWith("/vagtplan-"), path).toBe(true);
      expect(existsSync(join(PUBLIC, path)), path).toBe(true);
      const [w, h] = pngSize(join(PUBLIC, path));
      expect(`${w}x${h}`).toBe(sizes);
    }
  });

  it("the favicon SVG is the kit's forest tile, not the old green", () => {
    const svg = read(join(PUBLIC, "favicon.svg"));
    expect(svg).toContain('fill="#093A26"');
    expect(svg).not.toMatch(/#16A34A|#22c55e/i);
  });
});
