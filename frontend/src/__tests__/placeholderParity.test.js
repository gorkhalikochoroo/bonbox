/**
 * A translation must keep the placeholders the original carries.
 *
 * This is the defect class one level down from the dialogs this guard was
 * written for. Twenty-one confirmation dialogs were just rewritten so each one
 * names the row it is about to act on — "Delete {name}?" instead of the same
 * sentence for every row in a list. All of that identification lives inside a
 * {placeholder}. A translator who writes the Danish without the {name} hands
 * a Danish owner back the anonymous dialog the change was made to remove, and
 * nothing else in the suite would notice: the key resolves, the string is real
 * copy, the source guard still sees the variable being passed in.
 *
 * So: for every key defined in both tables, the set of placeholders must match.
 *
 * The one legitimate exception is English pluralisation — "{n} voucher{s}" has
 * no Danish equivalent, and {s} is a suffix, not a value. Those are listed
 * explicitly rather than pattern-matched, so a new one has to be a decision.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "hooks", "useLanguage.jsx"), "utf8");
const I18N = join(HERE, "..", "i18n");

/**
 * The separate locale packs are held to the same rule, but only the ones the
 * picker actually offers — the same line the locked-terms guard draws. A pack
 * nobody can select is allowed to lag; the moment it is flipped to
 * `offered: true` this guard starts enforcing it, which is the point.
 * (Today the non-offered backlog is 12 keys, mostly np.js.)
 */
const offeredPacks = () => {
  const catalog = readFileSync(join(I18N, "languageCatalog.js"), "utf8");
  const codes = [...catalog.matchAll(/\{\s*code:\s*"([a-z_]+)"[^}]*offered:\s*true\s*\}/g)].map(
    (m) => m[1],
  );
  // en and da live inline in useLanguage.jsx and are covered above.
  return codes.filter((c) => c !== "en" && c !== "da");
};

/** Keys where English carries a placeholder Danish genuinely does not need. */
const PLURAL_SUFFIX_EXEMPT = new Set(["taxComplianceFooter", "receiptViewerOcrLegend"]);

const ENTRY = /^ {4}([A-Za-z0-9_]+): "((?:[^"\\]|\\.)*)",\s*$/gm;
const placeholdersOf = (value) => new Set([...value.matchAll(/\{(\w+)\}/g)].map((m) => m[1]));

describe("en and da agree on what a string interpolates", () => {
  it("no translation drops or invents a placeholder", () => {
    const first = new Map();
    const mismatches = [];
    for (const [, key, value] of SOURCE.matchAll(ENTRY)) {
      const here = placeholdersOf(value);
      if (!first.has(key)) {
        first.set(key, here);
        continue;
      }
      const there = first.get(key);
      const dropped = [...there].filter((p) => !here.has(p));
      const invented = [...here].filter((p) => !there.has(p));
      if (!dropped.length && !invented.length) continue;
      // English-only pluralisation suffix, declared above.
      if (
        PLURAL_SUFFIX_EXEMPT.has(key) &&
        !invented.length &&
        dropped.every((p) => p === "s")
      ) {
        continue;
      }
      mismatches.push(
        `${key}: en has {${[...there].join("} {")}}, da has {${[...here].join("} {")}}`,
      );
    }
    // The parse has to have found the tables at all — a guard that silently
    // matches nothing is worse than no guard.
    expect(first.size).toBeGreaterThan(5000);
    expect(
      mismatches,
      `A translated string does not interpolate what the English one does.\n` +
        `In a dialog that names the row it is about to delete, the dropped\n` +
        `placeholder IS the identification:\n` +
        mismatches.join("\n"),
    ).toEqual([]);
  });
});

describe("an offered locale pack keeps the placeholders too", () => {
  const PACK_ENTRY = /^ {2}([A-Za-z0-9_]+): "((?:[^"\\]|\\.)*)",\s*$/gm;

  /** English is the first definition of each key in useLanguage.jsx. */
  const english = new Map();
  for (const [, key, value] of SOURCE.matchAll(ENTRY)) {
    if (!english.has(key)) english.set(key, placeholdersOf(value));
  }

  const packs = offeredPacks();

  it("there is at least one offered pack to check", () => {
    expect(packs.length).toBeGreaterThan(0);
  });

  it.each(packs)("i18n/%s.js", (code) => {
    const text = readFileSync(join(I18N, `${code}.js`), "utf8");
    const mismatches = [];
    let checked = 0;
    for (const [, key, value] of text.matchAll(PACK_ENTRY)) {
      const expected = english.get(key);
      if (!expected) continue; // a pack-only key has nothing to disagree with
      checked += 1;
      const here = placeholdersOf(value);
      const dropped = [...expected].filter((p) => !here.has(p));
      const invented = [...here].filter((p) => !expected.has(p));
      if (PLURAL_SUFFIX_EXEMPT.has(key) && !invented.length && dropped.every((p) => p === "s")) {
        continue;
      }
      if (dropped.length || invented.length) {
        mismatches.push(
          `${key}: en has {${[...expected].join("} {")}}, ${code} has {${[...here].join("} {")}}`,
        );
      }
    }
    expect(checked, `nothing parsed out of i18n/${code}.js`).toBeGreaterThan(100);
    expect(
      mismatches,
      `i18n/${code}.js drops or invents placeholders. In a dialog that names\n` +
        `the row it is about to delete, the dropped placeholder IS the\n` +
        `identification — this locale would show the anonymous version:\n` +
        mismatches.join("\n"),
    ).toEqual([]);
  });
});
