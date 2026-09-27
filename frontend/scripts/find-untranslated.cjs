#!/usr/bin/env node
/**
 * find-untranslated — list user-visible strings that do NOT go through t().
 *
 * "Translation should be 100% when switching": every word an owner can see
 * must change when the language changes. A string typed straight into JSX
 * never does. This finds them, conservatively:
 *
 *   1. JSX text between tags            <p>Refresh</p>
 *   2. User-facing attributes           placeholder="Search", title="…",
 *                                       aria-label="…", alt="…", label="…"
 *   3. String literals rendered as JSX  {"Refreshing…"}, cond ? "On" : "Off"
 *   4. Messages set into UI state       setError("…"), toast("…")
 *
 * It skips comments, className/style values, URLs, keys and anything that
 * already sits inside t(…). Words that are the same in every language
 * (BonBox, MOMS, SKAT, CVR, kr., %, emoji, numbers) are not counted.
 *
 * Usage:
 *   node scripts/find-untranslated.cjs            → per-file counts
 *   node scripts/find-untranslated.cjs --list     → every hit, file:line
 *   node scripts/find-untranslated.cjs --json     → machine-readable
 */
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const SKIP_DIRS = new Set(["__tests__", "i18n", "node_modules", "test"]);
const SKIP_FILES = new Set(["useLanguage.jsx"]);

// Words that are identical in every language the app ships (brands, locked
// Danish terms per the DK terminology lock, units, codes).
const SAME_EVERYWHERE = new Set([
  "BonBox", "MOMS", "SKAT", "CVR", "SAF-T", "PDF", "CSV", "Excel", "Google", "Apple",
  "MobilePay", "Dankort", "Visa", "Mastercard", "iOS", "Android", "OK", "AI", "SMS",
  "e-Boks", "Nets", "Stripe", "Planday", "Mindee", "API", "URL", "QR", "ID", "kr", "kr.",
  "DKK", "EUR", "USD", "NPR", "GBP", "SEK", "NOK", "Wi-Fi", "WiFi", "E-conomic",
  "Dinero", "Billy", "Uniconta", "Shopify", "Zettle", "SumUp", "iZettle", "PIN",
  "BAR", "N/A", "—", "·", "…",
]);

function stripComments(src) {
  // Block comments (incl. JSX {/* */}) keep their newlines so line numbers hold.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`])\/\/[^\n]*/g, (m, p1) => p1 + " ".repeat(m.length - p1.length));
}

function words(s) {
  return (s.match(/[A-Za-zÆØÅæøåÄÖÜäöüß][A-Za-zÆØÅæøåÄÖÜäöüß'’-]*/g) || []);
}

/** Tailwind class lists and CSS values are not copy. */
function looksLikeStyle(t) {
  if (/rgba?\(|hsla?\(|\d+(px|rem|em|ms|s)\b|var\(--|^#[0-9a-f]{3,8}$/i.test(t)) return true;
  const toks = t.split(/\s+/);
  return toks.every((x) => /^[a-z0-9:[\]\-/.%#()_,!&>*~+=]+$/.test(x)) && toks.some((x) => /[-:[]/.test(x));
}

/** Does this literal read as language — not a code, a unit or a brand? */
function isLanguage(s) {
  const t = s.trim();
  if (t.length < 2) return false;
  if (looksLikeStyle(t)) return false;
  if (/^[A-Z]{2,3}$/.test(t)) return false;                                // EN / DA / DKK codes
  if (/&&|\|\||=>|\bundefined\b|\bnull\b|\btrue\b|\bfalse\b/.test(t)) return false; // code
  if (/^[\w.+-]+@[\w.-]+\.[a-z]{2,}$/i.test(t)) return false;              // an email address
  if (/^[\s\d.,:;%+\-–—·…/()×x*#€$£kr]*$/i.test(t)) return false;        // numbers/punctuation
  if (/^(https?:|mailto:|tel:|\/|\.\/|#)/.test(t)) return false;          // links / paths
  if (/^[a-z0-9_.-]+$/.test(t) && !/\s/.test(t)) return false;            // identifiers, keys
  if (/^[A-Z0-9_]+$/.test(t) && t.length > 1 && SAME_EVERYWHERE.has(t)) return false;
  if (/^\{.*\}$/.test(t)) return false;
  const w = words(t).filter((x) => !SAME_EVERYWHERE.has(x) && !SAME_EVERYWHERE.has(x.replace(/\.$/, "")));
  if (w.length === 0) return false;
  // A lone camelCase / snake token is code, not copy.
  if (w.length === 1 && /[a-z][A-Z]|_/.test(w[0])) return false;
  return true;
}

const USER_ATTRS = ["placeholder", "title", "aria-label", "alt", "label", "helper", "subtitle",
  "emptyText", "confirmLabel", "cancelLabel", "tooltip", "description", "headline", "hint", "caption"];

function scanFile(file) {
  const raw = fs.readFileSync(file, "utf8");
  if (!/[<>]/.test(raw)) return [];
  const isJsx = file.endsWith(".jsx");
  const src = stripComments(raw);
  const hits = [];
  const lineOf = (idx) => src.slice(0, idx).split("\n").length;
  const push = (idx, kind, text) => hits.push({ line: lineOf(idx), kind, text: text.trim().slice(0, 90) });

  // 1. JSX text nodes: >Text< on one line, not inside {…}
  const textRe = />([^<>{}\n]*[A-Za-zÆØÅæøå][^<>{}\n]*)</g;
  let m;
  while (isJsx && (m = textRe.exec(src))) {
    const text = m[1];
    const before = src.slice(Math.max(0, m.index - 1), m.index + 1);
    if (/=>$/.test(src.slice(m.index - 1, m.index + 1))) continue;          // arrow fn
    if (/[=!<>]=?$/.test(src.slice(Math.max(0, m.index - 2), m.index))) continue; // comparisons
    if (/^\s*[&|?:]/.test(text)) continue;                                   // expressions
    if (/\b(return|const|let|if|else|&&|\|\|)\b/.test(text)) continue;       // code, not copy
    if (/[;=]/.test(text)) continue;
    if (!isLanguage(text)) continue;
    void before;
    push(m.index, "text", text);
  }

  // 1b. Multi-line text nodes: a line that is only words, between JSX lines
  const lines = src.split("\n");
  lines.forEach((ln, i) => {
    if (!isJsx) return;
    const t = ln.trim();
    if (!t || /[<>{}=;()[\]`"']|^\/\/|^\*|^import|^export/.test(t)) return;
    if (!/[A-Za-zÆØÅæøå]{3,}/.test(t) || !/\s/.test(t)) return;
    const prev = (lines[i - 1] || "").trim();
    const next = (lines[i + 1] || "").trim();
    const jsxAround = /[>}]$/.test(prev) || /^[<{]/.test(next);
    if (!jsxAround) return;
    if (/^(return|const|let|var|if|else|case|default|function|await|throw)\b/.test(t)) return;
    if (!isLanguage(t)) return;
    hits.push({ line: i + 1, kind: "text", text: t.slice(0, 90) });
  });

  // 2. User-facing attributes with a literal value
  const attrRe = new RegExp(`\\b(${USER_ATTRS.join("|")})="([^"]*)"`, "g");
  while ((m = attrRe.exec(src))) {
    if (isLanguage(m[2])) push(m.index, `attr:${m[1]}`, m[2]);
  }

  // 3. String literals rendered directly: {"…"} and ternaries ? "…" : "…"
  const exprRe = /\{\s*"([^"\n]{2,})"\s*\}|\?\s*"([^"\n]{2,})"\s*:\s*"([^"\n]{2,})"/g;
  while ((m = exprRe.exec(src))) {
    for (const g of [m[1], m[2], m[3]]) {
      if (g && isLanguage(g)) push(m.index, "expr", g);
    }
  }

  // 3b. UI copy in object literals: { label: "Open" }, { title: "…" } — option
  //     lists and config arrays the JSX maps over.
  const propRe = /\b(label|title|text|placeholder|description|helper|subtitle|hint|caption|headline|cta|emptyText|tooltip|short|long)\s*:\s*"([^"\n]{2,})"/g;
  while ((m = propRe.exec(src))) {
    if (isLanguage(m[2])) push(m.index, `prop:${m[1]}`, m[2]);
  }

  // 4. Messages pushed into UI: setError("…"), setMsg("…"), toast("…"), alert("…")
  const msgRe = /\b(set[A-Z]\w*(?:Error|Msg|Message|Notice|Toast|Status|Warning|Info|Hint)|toast(?:\.\w+)?|alert|showToast|notify)\(\s*"([^"\n]{2,})"/g;
  while ((m = msgRe.exec(src))) {
    if (isLanguage(m[2])) push(m.index, "message", m[2]);
  }

  // Anything already inside t("…", "fallback") is fine — drop hits whose
  // text appears only as a t() fallback on that line.
  return hits.filter((h) => {
    const ln = lines[h.line - 1] || "";
    return !new RegExp(`\\bt\\(\\s*["'][\\w.]+["']\\s*,\\s*["'\`]${h.text.slice(0, 20).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`).test(ln);
  });
}

function walk(dir, out = []) {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(p, out);
    } else if (/\.(jsx|js)$/.test(name) && !SKIP_FILES.has(name)) {
      out.push(p);
    }
  }
  return out;
}

const results = {};
for (const f of walk(SRC)) {
  const hits = scanFile(f);
  if (hits.length) results[path.relative(SRC, f)] = hits;
}

const args = process.argv.slice(2);
if (args.includes("--json")) {
  process.stdout.write(JSON.stringify(results, null, 2));
} else if (args.includes("--list")) {
  for (const [f, hits] of Object.entries(results)) {
    for (const h of hits) console.log(`${f}:${h.line}  [${h.kind}]  ${h.text}`);
  }
} else {
  const rows = Object.entries(results).map(([f, h]) => [f, h.length]).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((s, r) => s + r[1], 0);
  for (const [f, n] of rows) console.log(String(n).padStart(4), f);
  console.log(`\n${total} untranslated strings in ${rows.length} files`);
}
