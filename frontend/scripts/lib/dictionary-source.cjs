/**
 * dictionary-source — the English + Danish dictionaries as ONE text, in the
 * layout they had while they lived inside hooks/useLanguage.jsx:
 *
 *   const translations = {
 *     en: {
 *       key: "…",
 *     },
 *     da: {
 *       key: "…",
 *     },
 *   };
 *
 * They moved to src/i18n/en.js and src/i18n/da.js (Sep 2026) so visitors load
 * one language instead of both. The i18n guards parse this layout (block
 * markers `  en: {`, 4-space entries, English first), so they read it from
 * here and keep their parsing unchanged.
 */
const fs = require("fs");
const path = require("path");

const I18N = path.join(__dirname, "..", "..", "src", "i18n");

function body(code) {
  const text = fs.readFileSync(path.join(I18N, `${code}.js`), "utf8");
  const start = text.indexOf(`export const ${code} = {`);
  if (start < 0) throw new Error(`src/i18n/${code}.js: no "export const ${code} = {"`);
  const open = text.indexOf("{", start);
  const close = text.lastIndexOf("};");
  return text.slice(open + 1, close).replace(/^\n/, "").replace(/\n$/, "");
}

function readDictionarySource() {
  return `const translations = {\n  en: {\n${body("en")}\n  },\n  da: {\n${body("da")}\n  },\n};\n`;
}

module.exports = { readDictionarySource };
