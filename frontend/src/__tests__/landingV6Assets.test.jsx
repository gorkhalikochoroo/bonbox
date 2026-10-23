/**
 * LANDING V6 — the generated parts and the assets (PORT_PLAN 1.2 / 1.8, port step 2).
 *
 * The room drawing, the table timeline and the logo lockup are cut from the
 * v6.3 prototype build once (lab: port-build/tools/gen_parts.mjs); the eleven
 * pictures (Danish, and since 23 Oct 2026 their English twins) and the social card
 * are byte copies, pinned by sha256 (fixtures/landingV6Pictures.sha256.json). These checks read the real
 * files — the pictures' own pixel sizes, the drawing as React renders it, the
 * lockup against the brand kit file — so a later edit cannot drift silently.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import RoomSvg from "../components/landing/v6/RoomSvg";
import Lockup, { LOCKUP_VIEWBOX } from "../components/landing/v6/Lockup";
import { FLOOR } from "../components/landing/v6/floor";
import { IMG, imagesFor } from "../components/landing/v6/images";
import { pageLangFor } from "../components/landing/v6/site";

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

describe("landing v6 — the eleven pictures, each in Danish and English", () => {
  const entries = Object.entries(IMG);
  const LANGS = ["da", "en"];
  const NAMES = [
    "vagt-uge-v8",
    "1945_booking_gaest",
    "bord-gaest",
    "1640_vagtplan_naeste_vagt_c15",
    "vagt-app-v8",
    "stand-sidder",
    "2250_stand_bordplan",
    "stand-tal2",
    "kasse-foto",
    "kasse-foto-hel-v7",
    "kasse-moms",
  ];

  it("images.js lists the eleven pictures the v6.3 page uses, each with a Danish and an English file, and the folder holds exactly those", () => {
    expect(entries).toHaveLength(11);
    for (const [key, v] of entries) for (const l of LANGS) expect([key, l, typeof v[l]?.src, typeof v[l]?.file]).toEqual([key, l, "string", "string"]);
    expect(entries.map(([, v]) => v.da.file).sort()).toEqual(NAMES.map((n) => `${n}.webp`).sort());
    // the English twin is the Danish name + ".en" (23 Oct 2026: "eng should be eng and danish should be danish")
    for (const [, v] of entries) expect(v.en.file).toBe(v.da.file.replace(/\.webp$/, ".en.webp"));
    const files = entries.flatMap(([, v]) => [v.da.file, v.en.file]).sort();
    expect(files).toHaveLength(22);
    expect(readdirSync(IMG_DIR).sort()).toEqual(files);
    // the superseded captures were not copied (nor the capture's alternates under their own names)
    for (const old of ["1640_vagtplan_naeste_vagt_c14.webp", "vagt-app.webp", "vagt-app-v6.webp", "vagt-uge.webp", "vagt-uge-v6.webp", "vagt-uge-v7.webp", "kasse-foto-hel.webp", "vagt-uge-v8.en.alt.webp", "kasse-foto.en.alt.webp"])
      expect(existsSync(join(IMG_DIR, old)), old).toBe(false);
  });

  it("every picture's Danish and English file have the same pixel size, and it is the width / height the page reserves", () => {
    for (const [key, v] of entries) {
      for (const l of LANGS) {
        const size = webpSize(readFileSync(join(IMG_DIR, v[l].file)));
        expect({ key, l, ...size }).toEqual({ key, l, width: v.width, height: v.height });
      }
    }
  });

  it("each import resolves to its own file, Danish and English apart", () => {
    for (const [, v] of entries) {
      expect(String(v.da.src)).toContain(v.da.file.replace(/\.webp$/, ""));
      expect(String(v.da.src)).not.toContain(".en.");
      expect(String(v.en.src)).toContain(v.en.file.replace(/\.webp$/, ""));
      expect(v.en.src).not.toBe(v.da.src);
    }
  });

  it("imagesFor: the Danish set for da, the English set for en and every language that reads the English page", () => {
    const pick = (set) => Object.fromEntries(Object.entries(set).map(([k, v]) => [k, v.src]));
    const da = Object.fromEntries(entries.map(([k, v]) => [k, v.da.src]));
    const en = Object.fromEntries(entries.map(([k, v]) => [k, v.en.src]));
    expect(pick(imagesFor("da"))).toEqual(da);
    for (const code of ["en", "tr", "de", "ne", undefined, null, ""]) expect([code, pick(imagesFor(code))]).toEqual([code, en]);
    // the page language decides, exactly as for the text (site.js pageLangFor); the box is the picture's, in both
    for (const code of ["da", "en", "tr"]) {
      expect(imagesFor(code)).toBe(imagesFor(pageLangFor(code)));
      for (const [k, v] of entries) expect([k, imagesFor(code)[k].width, imagesFor(code)[k].height]).toEqual([k, v.width, v.height]);
    }
  });

  it("phone set + desktop set stay inside the plan's picture budget in each language (eleven files ≤ 470 KB)", () => {
    for (const l of LANGS) {
      const total = entries.reduce((n, [, v]) => n + statSync(join(IMG_DIR, v[l].file)).size, 0);
      expect([l, total <= 470 * 1024]).toEqual([l, true]);
    }
  });

  it("the landing chunk inlines no English picture: each English file is over Vite's 4 KB inline limit or imported ?no-inline", () => {
    const src = readFileSync(join(V6, "images.js"), "utf8");
    const imports = [...src.matchAll(/^import \w+ from "\.\/img\/([^"?]+)(\?no-inline)?";$/gm)].map((m) => ({ file: m[1], noInline: !!m[2] }));
    expect(imports).toHaveLength(22);
    const LIMIT = 4096; // vite build.assetsInlineLimit default (vite.config.js does not set it)
    expect(readFileSync(join(FRONTEND, "vite.config.js"), "utf8")).not.toMatch(/assetsInlineLimit/);
    for (const { file, noInline } of imports) {
      const small = statSync(join(IMG_DIR, file)).size < LIMIT;
      if (file.endsWith(".en.webp")) expect([file, !small || noInline]).toEqual([file, true]);
      else expect([file, noInline]).toEqual([file, false]); // the Danish files are imported exactly as before
    }
    expect(imports.filter((i) => i.noInline).map((i) => i.file)).toEqual(["stand-sidder.en.webp"]);
  });

  it("no picture goes into public/", () => {
    for (const [, v] of entries) for (const l of LANGS) expect(existsSync(join(FRONTEND, "public", v[l].file)), v[l].file).toBe(false);
  });
});

describe("landing v6 — the pictures are the files they were checked as (sha256 fixture)", () => {
  const FIX = JSON.parse(readFileSync(join(HERE, "fixtures", "landingV6Pictures.sha256.json"), "utf8"));
  const LAB = join(REPO, "..", FIX.source_dir);
  const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

  it("the English files are byte for byte the English captures (the 10.00 week plan from the alternate box)", () => {
    expect(Object.keys(FIX.en).sort()).toEqual(Object.values(IMG).map((v) => v.en.file).sort());
    expect(FIX.en["vagt-uge-v8.en.webp"].source).toBe("img/alt/vagt-uge-v8.en.alt.webp");
    for (const [file, f] of Object.entries(FIX.en)) {
      const p = join(IMG_DIR, file);
      expect([file, statSync(p).size, sha(p)]).toEqual([file, f.bytes, f.sha256]);
    }
  });

  it.skipIf(!existsSync(LAB))("…and the lab's capture files hash to the same fixture (local check; CI has no lab folder)", () => {
    for (const [file, f] of Object.entries(FIX.en)) expect([file, sha(join(LAB, f.source))]).toEqual([file, f.sha256]);
  });

  it("the Danish files are unchanged by the English step", () => {
    expect(Object.keys(FIX.da).sort()).toEqual(Object.values(IMG).map((v) => v.da.file).sort());
    for (const [file, f] of Object.entries(FIX.da)) expect([file, sha(join(IMG_DIR, file))]).toEqual([file, f.sha256]);
  });
});

describe("landing v6 — the social card", () => {
  it("public/og-image-v4.png is a 1200 × 630 PNG (a new name, so link scrapers fetch it fresh)", () => {
    const buf = readFileSync(join(FRONTEND, "public", "og-image-v4.png"));
    expect(buf.subarray(1, 4).toString("ascii")).toBe("PNG");
    expect(buf.toString("ascii", 12, 16)).toBe("IHDR");
    expect([buf.readUInt32BE(16), buf.readUInt32BE(20)]).toEqual([1200, 630]);
  });

  it("is unchanged by the English pictures (same bytes; index.html shares it for both languages)", () => {
    const FIX = JSON.parse(readFileSync(join(HERE, "fixtures", "landingV6Pictures.sha256.json"), "utf8"));
    const buf = readFileSync(join(FRONTEND, "public", "og-image-v4.png"));
    const og = FIX.og["public/og-image-v4.png"];
    expect([buf.length, createHash("sha256").update(buf).digest("hex")]).toEqual([og.bytes, og.sha256]);
    const html = readFileSync(join(FRONTEND, "index.html"), "utf8");
    expect([...html.matchAll(/<meta (?:property|name)="(?:og|twitter):image" content="([^"]+)"/g)].map((m) => m[1])).toEqual([
      "https://www.bonbox.dk/og-image-v4.png",
      "https://www.bonbox.dk/og-image-v4.png",
    ]);
    // the share card is not one of the page's pictures, in either language
    for (const v of Object.values(IMG)) expect([v.da.file, v.en.file]).not.toContain("og-image-v4.png");
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
