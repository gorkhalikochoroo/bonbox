#!/usr/bin/env node
/**
 * Duplicate-key guard for the translation dictionaries.
 *
 * WHY THIS EXISTS. A duplicate key in a JS object literal is legal: the LAST
 * one silently wins and every earlier one is unreachable. The dictionaries had
 * accumulated 274 duplicate groups this way — 168 harmless (both copies said
 * the same thing) and 113 where a real translation was dead.
 *
 * The failure is quiet and it is expensive twice over:
 *
 *   1. MAINTENANCE. Someone edits the shadowed copy, reloads, sees no change,
 *      and loses an afternoon before suspecting the key appears twice in a
 *      7,800-line object.
 *   2. CORRECTNESS. When the two copies are genuinely different messages the
 *      key is doing two jobs, and one of its call sites is showing the wrong
 *      text right now. Two real examples, both fixed 2026-08-30:
 *        • rsvpCancelConfirmBody — an owner cancelling someone else's table
 *          was shown the GUEST's copy ("You're welcome to book again") and the
 *          {name} argument was silently discarded, because t() only substitutes
 *          when the surviving string actually contains a placeholder.
 *        • rsvpClosed — the one-word day-chip label shadowed the ClosedScreen
 *          headline, so an un-named venue's public booking page was titled
 *          simply "closed" / "lukket".
 *
 * eslint's no-dupe-keys already reports these, but eslint is not run at commit
 * time here and 183 pre-existing errors in this file meant new ones arrived
 * invisibly. This guard is narrow, fast, and blocking.
 *
 * WHAT IT CHECKS. Every object literal with more than 200 properties — i.e. a
 * translation table, not an options bag — in useLanguage.jsx and src/i18n/*.js.
 * Reports the key, both values, and whether they differ (a differing pair is
 * the correctness case above, not just noise).
 *
 * Run:  node scripts/check-i18n-dupe-keys.cjs
 * Override (emergency only):  I18N_DUPE_KEYS_SKIP=1
 */
const fs = require("fs");
const path = require("path");

if (process.env.I18N_DUPE_KEYS_SKIP === "1") {
  console.log("i18n duplicate-key guard: SKIPPED (I18N_DUPE_KEYS_SKIP=1)");
  process.exit(0);
}

let espree;
try {
  espree = require("espree");
} catch {
  // Degrade gracefully rather than blocking a commit on a missing dev dep —
  // the same posture as the no-undef guard.
  console.log("i18n duplicate-key guard: espree unavailable — skipped.");
  process.exit(0);
}

const FRONTEND = path.resolve(__dirname, "..");
const TARGETS = [
  path.join(FRONTEND, "src/hooks/useLanguage.jsx"),
  ...(fs.existsSync(path.join(FRONTEND, "src/i18n"))
    ? fs
        .readdirSync(path.join(FRONTEND, "src/i18n"))
        .filter((f) => f.endsWith(".js"))
        .map((f) => path.join(FRONTEND, "src/i18n", f))
    : []),
].filter((p) => fs.existsSync(p));

/** Translation tables are big; an options object is not. */
const TABLE_MIN_PROPS = 200;

const keyName = (p) =>
  p.key.type === "Identifier" ? p.key.name
  : p.key.type === "Literal" ? String(p.key.value)
  : null;

const findings = [];
let tablesChecked = 0;
let keysChecked = 0;

for (const file of TARGETS) {
  const code = fs.readFileSync(file, "utf8");
  let ast;
  try {
    ast = espree.parse(code, {
      ecmaVersion: "latest",
      sourceType: "module",
      loc: true,
      ecmaFeatures: { jsx: file.endsWith(".jsx") },
    });
  } catch (err) {
    console.error(`i18n duplicate-key guard: could not parse ${path.relative(FRONTEND, file)} — ${err.message}`);
    process.exit(1);
  }

  const seen = new Set();
  (function walk(node) {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);

    if (node.type === "ObjectExpression" && node.properties.length >= TABLE_MIN_PROPS) {
      tablesChecked++;
      const byKey = new Map();
      for (const p of node.properties) {
        if (p.type !== "Property" || p.computed) continue;
        const n = keyName(p);
        if (n == null) continue;
        keysChecked++;
        if (!byKey.has(n)) byKey.set(n, []);
        byKey.get(n).push(p);
      }
      for (const [key, occ] of byKey) {
        if (occ.length < 2) continue;
        const vals = occ.map((p) => (p.value.type === "Literal" ? p.value.value : `<${p.value.type}>`));
        findings.push({
          file: path.relative(FRONTEND, file),
          key,
          lines: occ.map((p) => p.loc.start.line),
          identical: vals.every((v) => v === vals[0]),
          dead: vals.slice(0, -1),
          live: vals[vals.length - 1],
        });
      }
    }

    for (const k of Object.keys(node)) {
      if (k === "loc" || k === "range") continue;
      const v = node[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object" && v.type) walk(v);
    }
  })(ast);
}

if (!findings.length) {
  console.log(
    `✅ i18n duplicate-key guard: 0 duplicates across ${tablesChecked} translation table(s), ${keysChecked} keys.`,
  );
  process.exit(0);
}

const differing = findings.filter((f) => !f.identical);
console.error(`\n❌ i18n duplicate-key guard: ${findings.length} duplicated key(s).\n`);
console.error(
  "A later duplicate silently overwrites the earlier one, so the earlier value is\n" +
  "unreachable. Delete the dead copy — and if the two values are DIFFERENT messages,\n" +
  "the key is doing two jobs and one of its call sites is showing the wrong text:\n" +
  "give that use its own key.\n",
);
for (const f of findings) {
  const tag = f.identical ? "identical" : "DIFFERING";
  console.error(`  ${f.file}  ${f.key}  (lines ${f.lines.join(", ")}) [${tag}]`);
  if (!f.identical) {
    for (const d of f.dead) console.error(`      dead: ${JSON.stringify(d)}`);
    console.error(`      live: ${JSON.stringify(f.live)}`);
  }
}
if (differing.length) {
  console.error(
    `\n  ${differing.length} of these have DIFFERING values — a real translation is dead.`,
  );
}
console.error("\n  Emergency override: I18N_DUPE_KEYS_SKIP=1\n");
process.exit(1);
