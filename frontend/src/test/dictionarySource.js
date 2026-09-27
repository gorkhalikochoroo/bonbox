/**
 * The English + Danish dictionaries as ONE text, in the layout they had inside
 * hooks/useLanguage.jsx (`  en: {` … `  },` then `  da: {` … `  },`, 4-space
 * entries, English first). They live in src/i18n/en.js and da.js now; the i18n
 * tests parse this layout, so they read it from here. The same helper for the
 * Node scripts is scripts/lib/dictionary-source.cjs.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const I18N = join(dirname(fileURLToPath(import.meta.url)), "..", "i18n");

function body(code) {
  const text = readFileSync(join(I18N, `${code}.js`), "utf8");
  const start = text.indexOf(`export const ${code} = {`);
  if (start < 0) throw new Error(`src/i18n/${code}.js: no "export const ${code} = {"`);
  const open = text.indexOf("{", start);
  const close = text.lastIndexOf("};");
  return text.slice(open + 1, close).replace(/^\n/, "").replace(/\n$/, "");
}

export function readDictionarySource() {
  return `const translations = {\n  en: {\n${body("en")}\n  },\n  da: {\n${body("da")}\n  },\n};\n`;
}
