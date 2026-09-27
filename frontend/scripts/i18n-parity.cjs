#!/usr/bin/env node
/**
 * i18n-parity — does switching English ⇄ Dansk change every translated word?
 *
 * A key can still show English to a Danish owner three ways:
 *   • used in code, missing from BOTH dictionaries → the inline English
 *     fallback of t("key", "Fallback") renders in every language;
 *   • present in `en`, missing from `da`       → English in Danish mode;
 *   • present in both, but the Danish value is the English text copied.
 *
 *   node scripts/i18n-parity.cjs           → summary
 *   node scripts/i18n-parity.cjs --list    → every key, by category
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const DICT = path.join(SRC, "hooks", "useLanguage.jsx");

/** Parse `  en: { … }` / `  da: { … }` blocks into {key: value} with a small
 *  tokenizer that respects strings (so "Note: x" inside a value is not a key). */
function parseBlock(src, startMarker) {
  const start = src.indexOf(startMarker);
  if (start < 0) throw new Error("no block " + startMarker);
  let i = src.indexOf("{", start) + 1;
  let depth = 1;
  const out = {};
  let pendingKey = null;
  while (i < src.length && depth > 0) {
    const c = src[i];
    if (c === "/" && src[i + 1] === "/") { i = src.indexOf("\n", i); continue; }
    if (c === "/" && src[i + 1] === "*") { i = src.indexOf("*/", i) + 2; continue; }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1, val = "";
      while (j < src.length && src[j] !== c) { if (src[j] === "\\") { val += src[j + 1]; j += 2; continue; } val += src[j]; j++; }
      // quoted key?
      let k = j + 1;
      while (/\s/.test(src[k])) k++;
      if (depth === 1 && src[k] === ":" && pendingKey === null) { pendingKey = val; i = k + 1; continue; }
      if (depth === 1 && pendingKey !== null) { out[pendingKey] = val; pendingKey = null; }
      i = j + 1; continue;
    }
    if (c === "{" || c === "[" || c === "(") { depth++; i++; continue; }
    if (c === "}" || c === "]" || c === ")") { depth--; i++; continue; }
    if (depth === 1 && /[A-Za-z_$]/.test(c)) {
      let j = i; while (/[\w$.]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let k = j; while (/\s/.test(src[k])) k++;
      if (src[k] === ":" && pendingKey === null) { pendingKey = word; i = k + 1; continue; }
      if (pendingKey !== null) { out[pendingKey] = "\u0000expr"; pendingKey = null; }
      i = j; continue;
    }
    if (c === "," && pendingKey !== null && depth === 1) { pendingKey = null; }
    i++;
  }
  return out;
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    if (fs.statSync(p).isDirectory()) {
      if (!["__tests__", "i18n", "node_modules"].includes(name)) walk(p, out);
    } else if (/\.(jsx|js)$/.test(name)) out.push(p);
  }
  return out;
}

const src = fs.readFileSync(DICT, "utf8");
const en = parseBlock(src, "\n  en: {");
const da = parseBlock(src, "\n  da: {");

// Keys the code asks for (literal first argument only).
const used = new Map(); // key -> [file:line]
for (const f of walk(SRC)) {
  const text = fs.readFileSync(f, "utf8");
  const re = /\b(?:t|tr|translate)\(\s*["']([A-Za-z][\w.]*)["']/g;
  let m;
  while ((m = re.exec(text))) {
    const line = text.slice(0, m.index).split("\n").length;
    if (!used.has(m[1])) used.set(m[1], []);
    used.get(m[1]).push(`${path.relative(SRC, f)}:${line}`);
  }
}

const SAME_OK = /^(BonBox|MOMS|SKAT|CVR|OK|PDF|CSV|AI|SMS|QR|PIN|ID|API|URL|kr\.?|DKK|%|—|·|…|\s|\d|[A-Z]{2,5})+$/;
const missingBoth = [], missingDa = [], missingEn = [], copied = [];
for (const [k, where] of used) {
  const inEn = k in en, inDa = k in da;
  if (!inEn && !inDa) missingBoth.push([k, where[0]]);
  else if (inEn && !inDa) missingDa.push([k, where[0]]);
  else if (!inEn && inDa) missingEn.push([k, where[0]]);
  else if (en[k] === da[k] && typeof en[k] === "string" && /[a-z]{3,}/.test(en[k]) && !SAME_OK.test(en[k]))
    copied.push([k, where[0], en[k]]);
}

if (process.argv.includes("--list")) {
  const dump = (title, rows) => { console.log(`\n== ${title} (${rows.length})`); rows.forEach((r) => console.log("  " + r.join("  "))); };
  dump("used in code, in NEITHER dictionary (fallback shows in every language)", missingBoth);
  dump("in English, missing in Danish", missingDa);
  dump("in Danish, missing in English", missingEn);
  dump("Danish value is the English text", copied);
} else {
  console.log(`dictionary: ${Object.keys(en).length} en keys, ${Object.keys(da).length} da keys; ${used.size} keys used in code`);
  console.log(`used, in neither dictionary : ${missingBoth.length}`);
  console.log(`in English, missing in Danish: ${missingDa.length}`);
  console.log(`in Danish, missing in English: ${missingEn.length}`);
  console.log(`Danish = English copy       : ${copied.length}`);
}
