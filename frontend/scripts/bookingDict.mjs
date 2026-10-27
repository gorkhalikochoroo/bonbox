// The booking page's own dictionary, built at build time (booking R5).
//
// vite.config.js (bonbox-booking-dictionary) serves it as
// virtual:bonbox-booking-dict = { da: {...}, en: {...} }: every key the public
// booking page — and every file its code reaches through static imports — can
// show, copied from src/i18n/da.js and en.js (still the one place a string is
// written; lints and parity guards are unchanged). ~400 keys, ~10 KB gz for
// both languages, instead of the ~200 KB full Danish dictionary a guest
// downloaded before the page could say anything.
//
// How a key is found, so a new string on the page is picked up by itself:
//   • any quoted string in those files that IS a key ("rsvpConfirm", and the
//     keys kept in tables, e.g. utils/bookingRefusal.js);
//   • any template-literal prefix (`rsvpOccasion_${k}`) — every key that
//     starts with it.
// r5.bookingDict.test.js checks the result against every t() call in the
// page's files, both ways. And a key that still slips through is not a raw
// key on screen: on the booking page the language provider fetches the full
// dictionary the moment such a key is asked for (hooks/useLanguage.jsx).
import fs from "node:fs";
import path from "node:path";

const EXTS = ["", ".js", ".jsx", "/index.js", "/index.jsx"];

const stripComments = (s) => s.replace(/^\s*\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");

function resolveLocal(from, spec) {
  if (!spec.startsWith(".")) return null;
  const base = path.resolve(path.dirname(from), spec);
  for (const e of EXTS) {
    const p = base + e;
    try {
      if (fs.statSync(p).isFile()) return p;
    } catch {
      /* next extension */
    }
  }
  return null;
}

function importsOf(src) {
  const out = [];
  const code = stripComments(src);
  for (const m of code.matchAll(/^\s*(?:import|export)\s+(?:[^'"]*?\s+from\s+)?["']([^"']+)["']/gm)) out.push(m[1]);
  // A part of the page loaded on demand (the 2D table picker, R5) still shows
  // the page's words: follow import("./…") too.
  for (const m of code.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1]);
  return out;
}

/** Every .js/.jsx file the entry reaches through its imports, static and
 *  import("./…") (absolute paths, sorted). */
export function bookingGraph(srcRoot, entry = "pages/ReservationPublicPage.jsx") {
  const start = path.join(srcRoot, entry);
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const file = queue.shift();
    if (!/\.jsx?$/.test(file)) continue;
    let src = "";
    try {
      src = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    for (const spec of importsOf(src)) {
      const r = resolveLocal(file, spec);
      // Never the dictionaries themselves (lib/localeStore.js loads every
      // language on demand): they are what the words are picked FROM.
      if (r && /[\\/]i18n[\\/]/.test(r)) continue;
      if (r && !seen.has(r)) {
        seen.add(r);
        queue.push(r);
      }
    }
  }
  return [...seen].filter((f) => /\.jsx?$/.test(f)).sort();
}

/** The keys a piece of source can show: quoted keys and template prefixes. */
export function keysIn(src, en) {
  const keys = new Set();
  const has = (k) => Object.prototype.hasOwnProperty.call(en, k);
  // One pass per quote kind, each on its own: an apostrophe in a comment or
  // in JSX text ("don't") can never pair with a quote of the other kind and
  // hide a key — and empty strings ("") are consumed whole, so `"" : t("k")`
  // still yields "k".
  for (const re of [/"((?:\\.|[^"\\\n])*)"/g, /'((?:\\.|[^'\\\n])*)'/g, /`([^`$\\]*)`/g]) {
    for (const m of src.matchAll(re)) if (has(m[1])) keys.add(m[1]);
  }
  const all = Object.keys(en);
  for (const m of src.matchAll(/`([A-Za-z][A-Za-z0-9_.]*)\$\{/g)) {
    const prefix = m[1];
    for (const k of all) if (k.startsWith(prefix) && k !== prefix) keys.add(k);
  }
  return keys;
}

/** The sorted key list for a set of files. */
export function bookingKeys(files, en) {
  const keys = new Set();
  for (const f of files) {
    for (const k of keysIn(fs.readFileSync(f, "utf8"), en)) keys.add(k);
  }
  return [...keys].sort();
}

/** { da, en } holding exactly those keys, each language's own text. */
export function buildBookingDict({ files, da, en }) {
  const keys = bookingKeys(files, en);
  const pick = (d) => Object.fromEntries(keys.filter((k) => Object.prototype.hasOwnProperty.call(d, k)).map((k) => [k, d[k]]));
  return { da: pick(da), en: pick(en) };
}
