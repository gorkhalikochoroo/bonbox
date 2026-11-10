/**
 * The characters a WOFF2 file maps (its cmap), read without any font library: the header, the table directory, the
 * one Brotli stream, then cmap formats 4 and 12. Used by the landing speed tests to check that a committed font cut
 * holds every character it must draw (landingSpeedFirstFonts.test.js, landingSpeedStageFonts.test.js).
 */
import zlib from "node:zlib";

const KNOWN = ["cmap", "head", "hhea", "hmtx", "maxp", "name", "OS/2", "post", "cvt ", "fpgm", "glyf", "loca", "prep", "CFF ", "VORG", "EBDT", "EBLC", "gasp", "hdmx", "kern", "LTSH", "PCLT", "VDMX", "vhea", "vmtx", "BASE", "GDEF", "GPOS", "GSUB"];
export function woff2Cmap(buf) {
  if (buf.toString("latin1", 0, 4) !== "wOF2") throw new Error("not a WOFF2 file");
  const numTables = buf.readUInt16BE(12);
  let p = 48;
  const base128 = () => { let v = 0; for (let i = 0; i < 5; i++) { const b = buf[p++]; v = v * 128 + (b & 0x7f); if (!(b & 0x80)) return v; } throw new Error("bad UIntBase128"); };
  const tables = [];
  for (let t = 0; t < numTables; t++) {
    const flags = buf[p++];
    let tag = KNOWN[flags & 0x3f];
    if ((flags & 0x3f) === 63) { tag = buf.toString("latin1", p, p + 4); p += 4; }
    const version = flags >> 6;
    const orig = base128();
    const transformed = (tag === "glyf" || tag === "loca") ? version === 0 : version !== 0;
    const length = transformed ? base128() : orig;
    tables.push({ tag, length });
  }
  const data = zlib.brotliDecompressSync(buf.subarray(p, p + buf.readUInt32BE(20)));
  let off = 0;
  const at = {};
  for (const t of tables) { at[t.tag] = data.subarray(off, off + t.length); off += t.length; }
  const cmap = at.cmap;
  const chars = new Set();
  const n = cmap.readUInt16BE(2);
  for (let i = 0; i < n; i++) {
    const sub = cmap.subarray(cmap.readUInt32BE(4 + i * 8 + 4));
    const format = sub.readUInt16BE(0);
    if (format === 4) {
      const seg = sub.readUInt16BE(6) / 2;
      const end = 14, start = end + seg * 2 + 2, delta = start + seg * 2, ro = delta + seg * 2;
      for (let s = 0; s < seg; s++) {
        const e = sub.readUInt16BE(end + s * 2), b = sub.readUInt16BE(start + s * 2), d = sub.readInt16BE(delta + s * 2), r = sub.readUInt16BE(ro + s * 2);
        for (let c = b; c <= e && c !== 0xffff; c++) {
          let g;
          if (!r) g = (c + d) & 0xffff;
          else { const gi = sub.readUInt16BE(ro + s * 2 + r + (c - b) * 2); g = gi ? (gi + d) & 0xffff : 0; }
          if (g) chars.add(String.fromCodePoint(c));
        }
      }
    } else if (format === 12) {
      const groups = sub.readUInt32BE(12);
      for (let g = 0; g < groups; g++) {
        const s0 = sub.readUInt32BE(16 + g * 12), e0 = sub.readUInt32BE(20 + g * 12);
        for (let c = s0; c <= e0; c++) chars.add(String.fromCodePoint(c));
      }
    }
  }
  return chars;
}

