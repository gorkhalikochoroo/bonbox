/**
 * LANDING V6 — the generated parts and the assets (PORT_PLAN 1.2 / 1.8, port step 2).
 *
 * The room drawing, the table timeline and the logo lockup are cut from the
 * v6.3 prototype build once (lab: port-build/tools/gen_parts.mjs); the eleven
 * pictures and the social card are byte copies. These checks read the real
 * files — the pictures' own pixel sizes, the drawing as React renders it, the
 * lockup against the brand kit file — so a later edit cannot drift silently.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import RoomSvg from "../components/landing/v6/RoomSvg";
import Lockup, { LOCKUP_VIEWBOX } from "../components/landing/v6/Lockup";
import { FLOOR } from "../components/landing/v6/floor";
import { IMG } from "../components/landing/v6/images";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, "..");
const FRONTEND = join(SRC, "..");
const REPO = join(FRONTEND, "..");
const V6 = join(SRC, "components", "landing", "v6");
const IMG_DIR = join(V6, "img");

// a WebP file's own pixel size, from its header (VP8 lossy, VP8L lossless, VP8X extended)
function webpSize(buf) {
  expect(buf.toString("ascii", 0, 4)).toBe("RIFF");
  expect(buf.toString("ascii", 8, 12)).toBe("WEBP");
  const kind = buf.toString("ascii", 12, 16);
  if (kind === "VP8X") return { width: 1 + buf.readUIntLE(24, 3), height: 1 + buf.readUIntLE(27, 3) };
  if (kind === "VP8L") {
    const b = buf.readUInt32LE(21);
    return { width: 1 + (b & 0x3fff), height: 1 + ((b >> 14) & 0x3fff) };
  }
  if (kind === "VP8 ") return { width: buf.readUInt16LE(26) & 0x3fff, height: buf.readUInt16LE(28) & 0x3fff };
  throw new Error("unknown webp chunk " + kind);
}

describe("landing v6 — the eleven pictures", () => {
  const entries = Object.entries(IMG);

  it("images.js lists the eleven files the v6.3 page uses, and the folder holds exactly those", () => {
    expect(entries).toHaveLength(11);
    const files = entries.map(([, v]) => v.file).sort();
    expect(files).toEqual(
      [
        "vagt-uge-v8.webp",
        "1945_booking_gaest.webp",
        "bord-gaest.webp",
        "1640_vagtplan_naeste_vagt_c15.webp",
        "vagt-app-v8.webp",
        "stand-sidder.webp",
        "2250_stand_bordplan.webp",
        "stand-tal2.webp",
        "kasse-foto.webp",
        "kasse-foto-hel-v7.webp",
        "kasse-moms.webp",
      ].sort(),
    );
    expect(readdirSync(IMG_DIR).sort()).toEqual(files);
    // the superseded captures were not copied
    for (const old of ["1640_vagtplan_naeste_vagt_c14.webp", "vagt-app.webp", "vagt-app-v6.webp", "vagt-uge.webp", "vagt-uge-v6.webp", "vagt-uge-v7.webp", "kasse-foto-hel.webp"])
      expect(existsSync(join(IMG_DIR, old)), old).toBe(false);
  });

  it("every width / height is the file's own pixel size (the page reserves the right box)", () => {
    for (const [key, v] of entries) {
      const size = webpSize(readFileSync(join(IMG_DIR, v.file)));
      expect({ key, ...size }).toEqual({ key, width: v.width, height: v.height });
    }
  });

  it("each import resolves to its own file", () => {
    for (const [, v] of entries) expect(String(v.src)).toContain(v.file.replace(/\.webp$/, ""));
  });

  it("phone set + desktop set stay inside the plan's picture budget (all eleven ≤ 470 KB)", () => {
    const total = entries.reduce((n, [, v]) => n + statSync(join(IMG_DIR, v.file)).size, 0);
    expect(total).toBeLessThanOrEqual(470 * 1024);
  });

  it("no picture goes into public/", () => {
    for (const [, v] of entries) expect(existsSync(join(FRONTEND, "public", v.file)), v.file).toBe(false);
  });
});

describe("landing v6 — the social card", () => {
  it("public/og-image-v4.png is a 1200 × 630 PNG (a new name, so link scrapers fetch it fresh)", () => {
    const buf = readFileSync(join(FRONTEND, "public", "og-image-v4.png"));
    expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(buf.toString("ascii", 12, 16)).toBe("IHDR");
    expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([1200, 630]);
  });
});

describe("landing v6 — the room drawing and the table timeline", () => {
  const html = renderToStaticMarkup(<RoomSvg />);
  const doc = new DOMParser().parseFromString(html, "image/svg+xml");
  const svg = doc.documentElement;

  it("is the stand screen's crop (viewBox 1101 × 690), hidden from screen readers, open (the door at 19.45)", () => {
    expect(svg.getAttribute("viewBox")).toBe("0 0 1101 690");
    expect(svg.getAttribute("class")).toBe("room-svg open");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("focusable")).toBe("false");
  });

  it("has one table group per FLOOR entry, same ids, same order; Vindue 2 is FLOOR[1] (the engine follows T[1])", () => {
    const groups = [...svg.querySelectorAll("g.t")];
    expect(groups.map((g) => g.getAttribute("id"))).toEqual(FLOOR.map((t) => "t-" + t.id));
    expect(FLOOR).toHaveLength(12);
    expect(FLOOR[1].id).toBe("v2");
    for (const g of groups) {
      expect(["free", "up", "seat", "late"]).toContain(g.getAttribute("data-s"));
      for (const layer of ["base", "up", "seat", "late", "globe"]) expect(g.querySelector(`g.L.${layer}`), `${g.id} ${layer}`).not.toBeNull();
    }
    expect(svg.querySelector("#t-v2 g.L.hl circle.hlr")).not.toBeNull();
  });

  it("every timeline is a list of [from, to) minute pairs and every table has a centre and radius", () => {
    for (const t of FLOOR) {
      for (const k of ["lit", "late", "up", "on"]) {
        expect(Array.isArray(t[k])).toBe(true);
        for (const [a, b] of t[k]) expect(a).toBeLessThan(b);
      }
      expect(t.r).toBeGreaterThan(0);
      expect(t.cx).toBeGreaterThan(0);
      expect(t.cy).toBeGreaterThan(0);
    }
    // 19.45: the guest from 12.30 sits at Vindue 2 until 21.15 (TV2 in the engine)
    expect(FLOOR[1].lit).toEqual([[1185, 1275]]);
  });

  it("carries the renamed classes, never the colliding ones", () => {
    expect(svg.querySelectorAll(".lp6-glass")).toHaveLength(1);
    expect(svg.querySelectorAll(".lp6-ring")).toHaveLength(12);
    expect(svg.querySelectorAll(".glass, .ring")).toHaveLength(0);
  });

  it("keeps what the engine reads: the door leaf's hinge (M x y) and the draw-on order (--o, pathLength)", () => {
    const leaf = svg.querySelector(".door .leaf");
    expect(leaf.getAttribute("d")).toMatch(/^M([\d.]+) ([\d.]+)/);
    expect(svg.querySelectorAll("[pathLength]").length).toBeGreaterThan(100);
    for (const g of svg.querySelectorAll("g.t")) expect(g.getAttribute("style")).toMatch(/^--o:0\.\d{3}$/);
  });
});

describe("landing v6 — the logo", () => {
  const kit = readFileSync(join(REPO, "docs", "brand", "lockup", "bonbox-lockup-forest.svg"), "utf8");

  it("is the brand kit's lockup: same viewBox, same two paths, drawn in currentColor", () => {
    const html = renderToStaticMarkup(<Lockup />);
    const svg = new DOMParser().parseFromString(html, "image/svg+xml").documentElement;
    expect(svg.getAttribute("viewBox")).toBe(kit.match(/viewBox="([^"]+)"/)[1]);
    expect(LOCKUP_VIEWBOX).toBe("0 -998 4475.67 1008");
    const paths = [...svg.querySelectorAll("path")];
    expect(paths.map((p) => p.getAttribute("d"))).toEqual([...kit.matchAll(/ d="([^"]+)"/g)].map((m) => m[1]));
    for (const p of paths) expect(p.getAttribute("fill")).toBe("currentColor");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
  });
});
