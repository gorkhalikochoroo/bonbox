#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * check-i18n-keys.cjs — BonBox i18n raw-key-leak guard.
 *
 * WHY THIS EXISTS
 * ---------------
 * `t(key, fallbackOrVars, maybeVars)` in src/hooks/useLanguage.jsx resolves
 *   const hit = loaded[lang]?.[key] || loaded.en[key];
 *   result = hit ? hit : (fallback !== undefined ? fallback : key);
 * so the EN block is the source of truth. If a key is ABSENT from EN and the
 * call has NO string fallback (a bare `t("k")` or the `t("k") || "..."`
 * antipattern — note `||` never fires because t() returns the truthy key
 * string), the USER SEES THE RAW KEY rendered as text. That is the leak class
 * this guard kills.
 *
 * WHAT IT DOES
 * ------------
 *   1. Parses the `en: { ... }` object literal out of useLanguage.jsx and
 *      evaluates it (NOT a naive regex — handles many keys per line and dotted
 *      keys like "smartScan.title") to get the authoritative set of EN keys.
 *   2. Scans frontend/src/**.{js,jsx} (excluding useLanguage.jsx, src/i18n/,
 *      and test files) for boundary-aware literal `t("key")` / `t('key')`
 *      calls, after stripping comments + strings-noise. Dynamic/template calls
 *      `t(expr)` / t(`...`) are skipped, as are an allowlist of known dynamic
 *      key PREFIXES that are composed at runtime.
 *   3. Classifies each static call against EN:
 *        • missing + bare `t("k")`            → ERROR (raw-key leak)
 *        • missing + `t("k") || "..."`        → ERROR (raw-key leak; || dead)
 *        • missing + `t("k", "fallback")`     → WARN  (shows English, not raw)
 *        • present in EN                      → ok
 *   4. Prints offending file:line list and EXITS 1 if any ERROR, else 0.
 *
 * Usage:  node scripts/check-i18n-keys.cjs        (from frontend/)
 */

const fs = require("fs");
const path = require("path");

const FRONTEND_DIR = path.resolve(__dirname, "..");
const SRC_DIR = path.join(FRONTEND_DIR, "src");
const LANG_FILE = path.join(SRC_DIR, "hooks", "useLanguage.jsx");

// Known runtime-composed key prefixes — keys built like `t("allergen_" + x)`
// surface in source as a bare prefix string and must NOT be flagged.
const DYNAMIC_PREFIX_ALLOWLIST = [
  "allergen_",
  "rsvpSeverity_",
  "day_",
  "bookingMatchesConfidence",
];

// ─────────────────────────────────────────────────────────────────────────
// 1. Extract + evaluate the EN block of useLanguage.jsx as an object literal.
// ─────────────────────────────────────────────────────────────────────────

/**
 * Given the full file text, return the substring of the `en: { ... }` object
 * literal body (the text between the outer braces, exclusive). Uses a
 * brace-depth scan that is aware of strings, template literals, and comments
 * so braces inside those don't throw off the depth count.
 */
function extractBlockBody(text, blockKey) {
  const marker = new RegExp("(^|\\n)\\s*" + blockKey + "\\s*:\\s*\\{");
  const m = marker.exec(text);
  if (!m) {
    throw new Error(`Could not locate "${blockKey}:" block in useLanguage.jsx`);
  }
  // Index of the opening brace of the block.
  let i = text.indexOf("{", m.index + m[0].length - 1);
  const start = i + 1;
  let depth = 1;
  let inS = false; // single-quote string
  let inD = false; // double-quote string
  let inT = false; // template literal
  let inLine = false; // // comment
  let inBlock = false; // /* */ comment
  for (i = start; i < text.length; i++) {
    const c = text[i];
    const prev = text[i - 1];
    const next = text[i + 1];
    if (inLine) {
      if (c === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (inS) {
      if (c === "\\") { i++; continue; }
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      if (c === "\\") { i++; continue; }
      if (c === '"') inD = false;
      continue;
    }
    if (inT) {
      if (c === "\\") { i++; continue; }
      if (c === "`") inT = false;
      continue;
    }
    // not in any string/comment
    if (c === "/" && next === "/") { inLine = true; i++; continue; }
    if (c === "/" && next === "*") { inBlock = true; i++; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === "`") { inT = true; continue; }
    if (c === "{") { depth++; continue; }
    if (c === "}") {
      depth--;
      if (depth === 0) {
        return text.slice(start, i);
      }
    }
  }
  throw new Error(`Unbalanced braces while parsing "${blockKey}:" block`);
}

/**
 * Evaluate the EN block body into a real object and return its key set.
 * The body is a sequence of `key: value,` pairs (JSX-free for EN labels —
 * values are strings/templates). We wrap it in `({ ... })` and eval in a
 * sandboxed Function. Values may contain template literals / concatenation;
 * that's fine — we only need Object.keys afterwards.
 */
function loadEnKeys() {
  const text = fs.readFileSync(LANG_FILE, "utf8");
  const body = extractBlockBody(text, "en");
  let obj;
  try {
    // eslint-disable-next-line no-new-func
    obj = Function(`"use strict"; return ({${body}});`)();
  } catch (e) {
    throw new Error(
      "Failed to eval the EN block as an object literal. A syntax slip " +
        "(stray comma, unterminated string, duplicate key) likely exists in " +
        "useLanguage.jsx's en{} block.\nUnderlying error: " + e.message,
    );
  }
  return new Set(Object.keys(obj));
}

// ─────────────────────────────────────────────────────────────────────────
// 2. Walk source files and collect literal t() calls.
// ─────────────────────────────────────────────────────────────────────────

function listSourceFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Skip test dirs and the i18n locale dir.
      if (entry.name === "__tests__" || entry.name === "test" || entry.name === "i18n") continue;
      if (entry.name === "node_modules") continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(jsx?|cjs|mjs)$/.test(entry.name)) {
      if (entry.name === "useLanguage.jsx") continue;
      if (/\.(test|spec)\.[jt]sx?$/.test(entry.name)) continue;
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip // line comments and block comments from a source string while
 * preserving newlines (so line numbers stay accurate) and leaving string
 * literals intact. Returns the comment-stripped text.
 */
function stripComments(src) {
  let out = "";
  let inS = false, inD = false, inT = false, inLine = false, inBlock = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const next = src[i + 1];
    if (inLine) {
      if (c === "\n") { inLine = false; out += c; }
      continue;
    }
    if (inBlock) {
      if (c === "*" && next === "/") { inBlock = false; i++; }
      else if (c === "\n") out += c; // keep line count
      continue;
    }
    if (inS) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i++; continue; }
      if (c === "'") inS = false;
      continue;
    }
    if (inD) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i++; continue; }
      if (c === '"') inD = false;
      continue;
    }
    if (inT) {
      out += c;
      if (c === "\\") { out += src[i + 1] ?? ""; i++; continue; }
      if (c === "`") inT = false;
      continue;
    }
    if (c === "/" && next === "/") { inLine = true; continue; }
    if (c === "/" && next === "*") { inBlock = true; continue; }
    if (c === "'") { inS = true; out += c; continue; }
    if (c === '"') { inD = true; out += c; continue; }
    if (c === "`") { inT = true; out += c; continue; }
    out += c;
  }
  return out;
}

// Matches a boundary-aware t( ... ) opening: `t(` NOT preceded by an
// identifier char or a dot (so get(, post(, setShareToast(, obj.t( are
// excluded). The leading char (if any) is captured to re-emit.
const T_CALL = /(^|[^A-Za-z0-9_$.])t\(/g;

/**
 * Parse a single argument list starting just after the `(` and return:
 *   { key, hasStringFallback, dynamic }
 * by reading the first argument (must be a plain string literal to be a key)
 * and detecting whether a 2nd positional arg is a string literal fallback.
 */
function parseTCall(text, openParenIdx) {
  let i = openParenIdx; // points at '('
  i++; // move past '('
  // Skip leading whitespace.
  while (i < text.length && /\s/.test(text[i])) i++;
  const first = text[i];
  if (first !== '"' && first !== "'") {
    // Dynamic / template / variable first arg — not a static key.
    return { dynamic: true };
  }
  const quote = first;
  let key = "";
  i++;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\") { key += c + (text[i + 1] ?? ""); i += 2; continue; }
    if (c === quote) { i++; break; }
    key += c;
    i++;
  }
  // Unescape simple escapes so the key matches the EN object key.
  const cleanKey = key
    .replace(/\\"/g, '"')
    .replace(/\\'/g, "'")
    .replace(/\\\\/g, "\\");

  // Now determine if there's a 2nd positional arg, and whether it's a string
  // fallback. Walk to the next top-level comma or the closing paren.
  let depth = 0;
  let inS = false, inD = false, inT = false;
  let sawComma = false;
  let secondArgStart = -1;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inS) { if (c === "\\") { i++; continue; } if (c === "'") inS = false; continue; }
    if (inD) { if (c === "\\") { i++; continue; } if (c === '"') inD = false; continue; }
    if (inT) { if (c === "\\") { i++; continue; } if (c === "`") inT = false; continue; }
    if (c === "'") { inS = true; continue; }
    if (c === '"') { inD = true; continue; }
    if (c === "`") { inT = true; continue; }
    if (c === "(" || c === "[" || c === "{") { depth++; continue; }
    if (c === ")" || c === "]" || c === "}") {
      if (depth === 0) break; // end of t( ... )
      depth--;
      continue;
    }
    if (c === "," && depth === 0 && !sawComma) {
      sawComma = true;
      // Find start of second arg (skip whitespace).
      let j = i + 1;
      while (j < text.length && /\s/.test(text[j])) j++;
      secondArgStart = j;
      // We have what we need; stop scanning.
      break;
    }
  }

  let hasStringFallback = false;
  if (sawComma && secondArgStart !== -1) {
    const sc = text[secondArgStart];
    // A string-literal second arg = developer-supplied English fallback.
    // An object literal ({...}) second arg = vars, NOT a fallback.
    if (sc === '"' || sc === "'" || sc === "`") hasStringFallback = true;
  }

  return { key: cleanKey, hasStringFallback, dynamic: false };
}

function isAllowlistedDynamic(key) {
  return DYNAMIC_PREFIX_ALLOWLIST.some((p) => key.startsWith(p));
}

function lineNumberAt(text, idx) {
  let line = 1;
  for (let i = 0; i < idx && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

// ─────────────────────────────────────────────────────────────────────────
// 3. Run.
// ─────────────────────────────────────────────────────────────────────────

function main() {
  const enKeys = loadEnKeys();
  const files = listSourceFiles(SRC_DIR);

  const errors = []; // raw-key leaks  → fail
  const warnings = []; // 2-arg fallback misses → warn

  for (const file of files) {
    const raw = fs.readFileSync(file, "utf8");
    const src = stripComments(raw);
    const rel = path.relative(FRONTEND_DIR, file);
    T_CALL.lastIndex = 0;
    let m;
    while ((m = T_CALL.exec(src)) !== null) {
      // openParen is the index of '(' in the matched `...t(`.
      const openParenIdx = m.index + m[0].length - 1;
      const parsed = parseTCall(src, openParenIdx);
      if (parsed.dynamic) continue; // t(expr) / t(`...`)
      const { key, hasStringFallback } = parsed;
      if (!key) continue;
      if (isAllowlistedDynamic(key)) continue;
      if (enKeys.has(key)) continue; // present → fine
      const line = lineNumberAt(src, m.index);
      const rec = { file: rel, line, key };
      if (hasStringFallback) warnings.push(rec);
      else errors.push(rec);
    }
  }

  // Sort for stable output.
  const byLoc = (a, b) => (a.file === b.file ? a.line - b.line : a.file.localeCompare(b.file));
  errors.sort(byLoc);
  warnings.sort(byLoc);

  if (warnings.length) {
    console.log(`\n⚠️  ${warnings.length} key(s) missing from EN but called with a string fallback (shows English, not a raw key):`);
    for (const w of warnings) {
      console.log(`   ${w.file}:${w.line}  t("${w.key}", "…")`);
    }
  }

  if (errors.length) {
    console.error(`\n❌ i18n raw-key-leak guard: ${errors.length} key(s) called WITHOUT a fallback and MISSING from the EN block.`);
    console.error("   These render the literal key string to the user. Add each to BOTH en{} and da{} in src/hooks/useLanguage.jsx.\n");
    for (const e of errors) {
      console.error(`   ${e.file}:${e.line}  t("${e.key}")`);
    }
    console.error("");
    process.exit(1);
  }

  console.log(`\n✅ i18n raw-key-leak guard: 0 errors. ${enKeys.size} EN keys; scanned ${files.length} source files.`);
  if (warnings.length) {
    console.log(`   (${warnings.length} non-fatal fallback warning(s) above — these show English, fix when convenient.)`);
  }
  process.exit(0);
}

main();
