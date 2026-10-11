/**
 * Push icons and the service-worker cache after the logo kit (docs/brand).
 *
 * - The status-bar badge is a white b on transparent (Android uses only its
 *   alpha); the full-colour app icon there drew a solid white square.
 * - The precached icons are the URLs the pages request (?v=3), and the cache
 *   key is bumped so v9's pre-kit copies are dropped.
 * - A staff device's push names the Vagtplan icon (backend push_sender).
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { Buffer } from "node:buffer";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FRONTEND = join(HERE, "..", "..");
const PUBLIC = join(FRONTEND, "public");
const REPO = join(FRONTEND, "..");
const read = (p) => readFileSync(p, "utf8");

/** Decode an 8-bit RGBA, non-interlaced PNG (what rsvg-convert writes). */
function decodeRgba(path) {
  const b = readFileSync(path);
  let off = 8;
  let width = 0;
  let height = 0;
  const idat = [];
  while (off < b.length) {
    const len = b.readUInt32BE(off);
    const type = b.toString("ascii", off + 4, off + 8);
    const data = b.subarray(off + 8, off + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      expect([data[8], data[9], data[12]]).toEqual([8, 6, 0]); // 8-bit RGBA, no interlace
    }
    if (type === "IDAT") idat.push(data);
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const r = raw[y * (stride + 1) + 1 + x];
      const a = x >= 4 ? out[y * stride + x - 4] : 0;
      const up = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= 4 && y > 0 ? out[(y - 1) * stride + x - 4] : 0;
      let v = r;
      if (f === 1) v = r + a;
      else if (f === 2) v = r + up;
      else if (f === 3) v = r + ((a + up) >> 1);
      else if (f === 4) {
        const p = a + up - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - c);
        v = r + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c);
      }
      out[y * stride + x] = v & 0xff;
    }
  }
  return { width, height, px: out };
}

describe("the push badge", () => {
  const { width, height, px } = decodeRgba(join(PUBLIC, "badge-96.png"));

  it("is 96 px, white only, and mostly transparent around the b", () => {
    expect([width, height]).toEqual([96, 96]);
    let clear = 0;
    let solid = 0;
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 3] === 0) clear++;
      else {
        expect([px[i], px[i + 1], px[i + 2]]).toEqual([255, 255, 255]);
        if (px[i + 3] === 255) solid++;
      }
    }
    // The corners are clear and the b's stem is solid.
    expect(px[3]).toBe(0);
    expect(px[(30 * 96 + 24) * 4 + 3]).toBe(255);
    expect(clear).toBeGreaterThan(96 * 96 * 0.6);
    expect(solid).toBeGreaterThan(96 * 96 * 0.1);
  });

  it("is what sw.js and usePushNotifications pass as the badge", () => {
    const sw = read(join(PUBLIC, "sw.js"));
    expect(sw).toContain('const PUSH_BADGE = "/badge-96.png?v=3";');
    expect(sw).toMatch(/badge: PUSH_BADGE,/);
    expect(sw).toContain('const PUSH_ICON = "/icon-192.png?v=3";');
    expect(sw).toMatch(/icon: data\.icon \|\| PUSH_ICON,/);
    const hook = read(join(FRONTEND, "src/hooks/usePushNotifications.js"));
    expect(hook).toContain('badge: "/badge-96.png?v=3"');
    expect(hook).not.toMatch(/badge: "\/icon-192\.png/);
  });
});

describe("the service worker cache", () => {
  const sw = read(join(PUBLIC, "sw.js"));
  const assets = JSON.parse(sw.match(/const STATIC_ASSETS = (\[[^\]]*\]);/)[1]);

  it("is keyed bonbox-v10", () => {
    expect(sw).toMatch(/^const CACHE_NAME = "bonbox-v10";/m);
  });

  it("precaches the icon URLs the pages request, and every one exists", () => {
    const html = read(join(FRONTEND, "index.html"));
    for (const href of ["/favicon.ico?v=3", "/favicon-32.png?v=3", "/favicon-16.png?v=3"]) {
      expect(html).toContain(`"${href}"`);
      expect(assets).toContain(href);
    }
    for (const a of assets) {
      const path = a.split("?")[0];
      expect(existsSync(join(PUBLIC, path)), path).toBe(true);
      if (/(^\/icon-|^\/favicon-|\.ico$|^\/badge-)/.test(path)) expect(a, a).toMatch(/\?v=3$/);
    }
  });

  it("manifest shortcut icons carry the same ?v=3", () => {
    const m = JSON.parse(read(join(PUBLIC, "manifest.json")));
    const srcs = m.shortcuts.flatMap((s) => s.icons.map((i) => i.src));
    expect(srcs.length).toBeGreaterThan(0);
    for (const s of srcs) expect(s).toBe("/icon-192.png?v=3");
  });
});

describe("staff pushes", () => {
  it("name the Vagtplan icon, a file the frontend ships", () => {
    const py = read(join(REPO, "backend/app/services/push_sender.py"));
    const icon = py.match(/STAFF_PUSH_ICON = "([^"]+)"/)[1];
    expect(icon).toBe("/vagtplan-icon-192.png?v=3");
    expect(existsSync(join(PUBLIC, icon.split("?")[0]))).toBe(true);
  });
});
