#!/usr/bin/env node
/**
 * Locked-terminology guard for the i18n locale modules.
 *
 * WHY THIS EXISTS. A set of Danish words in this product are not vocabulary,
 * they are the names of specific legal artefacts a Danish business files with
 * SKAT or hands to a revisor. "MOMS" is not "VAT" and certainly not "KDV";
 * a kasserapport is a specific document; Bogføringsloven is a named statute.
 * Every locale module already says so in its own header — but a header is a
 * request, not a check, and we are about to bulk-fill several languages from
 * ~21% to ~99%. At that volume a translator (human or machine) rendering
 * "MOMS" as the local word for VAT is close to certain, and the failure is
 * silent: the UI reads fluently and tells a Turkish user to file a tax that
 * does not exist while the accountant export cites a statute by the wrong
 * name.
 *
 * THE RULE. If an English source string contains a locked term, the
 * translation of that same key must contain it too. Nothing else is checked —
 * this is deliberately not a translation-quality tool.
 *
 * Case-insensitive on purpose: Danish uses "Moms" mid-sentence and "MOMS" as
 * a label, and both are correct. Casing conventions are a separate concern
 * (see the DK terminology note in useLanguage.jsx).
 *
 * Run:  node scripts/check-i18n-locked-terms.cjs
 * Override (emergency only):  I18N_LOCKED_TERMS_SKIP=1
 */
const fs = require("fs");
const path = require("path");

if (process.env.I18N_LOCKED_TERMS_SKIP === "1") {
  console.log("⚠️  i18n locked-terms guard SKIPPED (I18N_LOCKED_TERMS_SKIP=1)");
  process.exit(0);
}

const SRC = path.join(__dirname, "..", "src");
const HOOK = path.join(SRC, "hooks", "useLanguage.jsx");
const I18N_DIR = path.join(SRC, "i18n");

/**
 * Terms that name a Denmark-bound legal artefact, a statute, or a brand.
 * Adding one here is cheap; removing one needs a reason in the commit.
 */
const LOCKED = [
  "MOMS",
  "SKAT",
  "kasserapport",
  "kreditnota",
  "Bogføringsloven",
  "lønseddel",
  "AM-bidrag",
  "A-skat",
  "feriepenge",
  "eIndkomst",
  "Dankort",
  "MobilePay",
  "BonBox",
];

/** Extract `key: "value"` pairs from a JS object literal body. */
function extractPairs(body) {
  const out = new Map();
  const re = /(?:^|[\s{,])"?([A-Za-z_][\w.]*)"?\s*:\s*"((?:[^"\\]|\\.)*)"/g;
  let m;
  while ((m = re.exec(body)) !== null) out.set(m[1], m[2]);
  return out;
}

/** Slice the body of a top-level `name: {` block, brace-balanced. */
function sliceBlock(src, name) {
  const m = new RegExp("\\n\\s{2}" + name + "\\s*:\\s*\\{").exec(src);
  if (!m) return null;
  let i = m.index + m[0].length;
  let depth = 1;
  while (i < src.length && depth > 0) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") depth--;
    i++;
  }
  return src.slice(m.index + m[0].length, i);
}

const hookSrc = fs.readFileSync(HOOK, "utf8");
const enBody = sliceBlock(hookSrc, "en");
if (!enBody) {
  console.error("✖ i18n locked-terms guard: could not find the `en` block in useLanguage.jsx");
  process.exit(1);
}
const en = extractPairs(enBody);

/** Every locale: the inline ones plus each i18n/*.js module. */
const locales = [];
for (const inline of ["da", "np"]) {
  const body = sliceBlock(hookSrc, inline);
  if (body) locales.push({ name: `useLanguage.jsx (${inline})`, pairs: extractPairs(body) });
}
if (fs.existsSync(I18N_DIR)) {
  for (const f of fs.readdirSync(I18N_DIR).filter((f) => f.endsWith(".js")).sort()) {
    const body = fs.readFileSync(path.join(I18N_DIR, f), "utf8");
    locales.push({ name: `i18n/${f}`, pairs: extractPairs(body) });
  }
}

const violations = [];
for (const { name, pairs } of locales) {
  for (const [key, translated] of pairs) {
    const source = en.get(key);
    if (!source) continue; // stale key — the raw-key-leak guard's job, not ours
    for (const term of LOCKED) {
      const inSource = source.toLowerCase().includes(term.toLowerCase());
      if (!inSource) continue;
      const inTranslation = translated.toLowerCase().includes(term.toLowerCase());
      if (!inTranslation) {
        violations.push({ file: name, key, term, source, translated });
      }
    }
  }
}

const checked = locales.reduce((n, l) => n + l.pairs.size, 0);
if (violations.length === 0) {
  console.log(
    `✅ i18n locked-terms guard: 0 violations. ` +
      `${locales.length} locales, ${checked} strings, ${LOCKED.length} locked terms.`,
  );
  process.exit(0);
}

console.error(
  `\n✖ i18n locked-terms guard: ${violations.length} translation(s) dropped a locked Danish term.\n`,
);
for (const v of violations.slice(0, 40)) {
  console.error(`  ${v.file}  ${v.key}`);
  console.error(`    lost "${v.term}"`);
  console.error(`    en : ${v.source.slice(0, 100)}`);
  console.error(`    got: ${v.translated.slice(0, 100)}\n`);
}
if (violations.length > 40) {
  console.error(`  … and ${violations.length - 40} more.\n`);
}
console.error(
  "These words name Denmark-bound legal artefacts. Put the term back verbatim —\n" +
    "translate the sentence around it, not the term itself.\n",
);
process.exit(1);
