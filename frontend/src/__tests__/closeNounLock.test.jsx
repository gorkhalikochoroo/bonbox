/**
 * The daily close has ONE owner-facing noun, and it is the locked term
 * "kasserapport".
 *
 * The rename was done once and three names survived on reachable surfaces —
 * including the sidebar, where "Kasserapport" sat directly above
 * "Multi-terminal lukning", and the page below it was headed "Gennemgå aftens
 * lukning" while its own button had already become "Start endnu en
 * kasserapport". Renaming by hand does not stay done; this is the part that
 * does.
 *
 * Two halves, because the defect had two shapes:
 *   1. NAMES — no string reachable from a /daily-close* route or from a nav
 *      row pointing at one may say lukning / dagsafslutning / daily close.
 *   2. FALLBACKS — an inline t(key, "literal") whose literal still carries the
 *      pre-rename wording. It is latent (the catalogue wins at runtime) right
 *      up until a key is dropped or a pack loads without it, and then the old
 *      name is back on screen with nothing to show for it in the catalogue.
 *      The repo has a standing gotcha for exactly this.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CATALOGUE = fs.readFileSync(path.join(SRC, "hooks/useLanguage.jsx"), "utf8");

/** Pull one language block's key → value pairs out of the catalogue source. */
function localeTable(code) {
  const start = CATALOGUE.indexOf(`  ${code}: {`);
  expect(start, `no ${code} block`).toBeGreaterThan(-1);
  // The next top-level `  xx: {` after this one bounds the block.
  const rest = CATALOGUE.slice(start + 8);
  const nextRel = rest.search(/^ {2}[a-z]{2}: \{/m);
  const block = nextRel === -1 ? rest : rest.slice(0, nextRel);
  const table = {};
  for (const m of block.matchAll(/([A-Za-z0-9_]+):\s*(["'])((?:\\.|(?!\2).)*)\2/g)) {
    if (!(m[1] in table)) table[m[1]] = m[3];
  }
  return table;
}

const EN = localeTable("en");
const DA = localeTable("da");

/* Every key the daily-close pages and the nav rows that point at them render
   as a NAME for the thing. Not every string on those pages — a sentence may
   legitimately use the verb "luk dagen". These are the nouns. */
const NAME_KEYS = [
  "navToday",
  "multiClose",
  "consolidatedClose",
  "reviewTitle",
  "newClose",
  "whatIsDailyClose",
  "noDailyClosesYet",
  "dcHeatmapNoClose",
  "fromDailyCloses",
  "onbFeatDailyClose",
  "taxReconGoToDailyClose",
  "taxReconHistoryLink",
  "landingV2HeroCardAlert",
];

/* The eight old names. "close" alone is too broad in English (it is also the
   verb and the dialog-dismiss word), so the English side checks the compound
   forms that actually named the page. */
const OLD_DA = /\b(lukning|lukningen|lukninger|dagsafslutning|dagsafslutninger)\b/i;
const OLD_EN = /\b(daily close|multi-terminal close|consolidated close|tonight's close|no close|lukning)\b/i;

describe("the daily close has one owner-facing noun", () => {
  for (const key of NAME_KEYS) {
    it(`${key} names it "kasserapport" in Danish`, () => {
      expect(DA[key], `${key} missing from the da catalogue`).toBeTruthy();
      expect(
        OLD_DA.test(DA[key]) ? DA[key] : null,
        `da.${key} still carries a pre-rename name: ${DA[key]}`,
      ).toBeNull();
    });

    it(`${key} names it "kasserapport" in English too`, () => {
      expect(EN[key], `${key} missing from the en catalogue`).toBeTruthy();
      expect(
        OLD_EN.test(EN[key]) ? EN[key] : null,
        `en.${key} still carries a pre-rename name: ${EN[key]}`,
      ).toBeNull();
    });
  }

  it("keeps the VERB distinct from the noun", () => {
    // "Luk dagen" is a fine action and is deliberately NOT renamed. The lock
    // is on what the page IS, not on what the owner DOES there — a test that
    // banned "luk" outright would have forced the wrong fix.
    expect(DA.closeTheDayCta).toBe("Luk dagen");
    expect(DA.dailyCloseAction).toBe("Luk dagen");
  });

  it("does not pluralise the locked Danish term with an English -s", () => {
    // "{n} kasserapport{s}" with s="s" rendered "12 kasserapports" three lines
    // above a sibling that said "12 kasserapporter". Danish does not form this
    // plural with -s, so the two forms are two keys.
    for (const table of [EN, DA]) {
      expect(table.taxReconClosesCount).not.toMatch(/\{s\}/);
      expect(table.taxReconClosesCountOne).toBeTruthy();
    }
    expect(DA.taxReconClosesCount).toContain("kasserapporter");
    expect(DA.taxReconClosesCountOne).not.toContain("kasserapporter");
  });
});

/* ── The inline-fallback half ─────────────────────────────────────────── */

/** Walk src/, skipping the catalogue itself and the tests. */
function sourceFiles(dir = SRC, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name !== "__tests__") sourceFiles(p, out);
    } else if (/\.jsx?$/.test(e.name) && !p.endsWith("hooks/useLanguage.jsx") && !p.includes(`${path.sep}i18n${path.sep}`)) {
      out.push(p);
    }
  }
  return out;
}

/* Scoped deliberately. A blanket "every fallback must equal the en value"
   would fail on ~700 sites where a DANISH fallback is the house convention —
   Denmark is the market and those are intentional. What is NOT intentional is
   an ENGLISH fallback left holding a word this pass renamed. So the guard
   covers the vocabulary the pass locked, which is the vocabulary at risk. */
const LOCKED_VOCAB_KEYS = [
  ...NAME_KEYS,
  "thisSession",
  "thisSessionInline",
  "reconcile",
  "openDailyClose",
  "rsvpEditTitle",
  "rsvpPlanNext",
  "walkInsTab",
  "rsvpWalkIn",
  "rsvpInsSourceWalkIn",
  "rsvpSourceWalkIn",
  "rsvpSeatNowTitle",
  "rsvpSeatNowBtn",
  "rsvpStatusSeated",
  "manualEntrySubtitle",
  // The landing hero. It is a PICTURE of nyqUnreconciled, and it was the last
  // place still saying "lukning" — on the surface a prospect reads first.
  "landingV2HeroCardAlert",
];

describe("inline fallbacks do not hold the pre-rename wording", () => {
  it("every t(key, \"literal\") on a locked-vocabulary key matches the en catalogue", () => {
    const drifted = [];
    for (const file of sourceFiles()) {
      const src = fs.readFileSync(file, "utf8");
      const re = /\bt\(\s*(["'])([A-Za-z0-9_]+)\1\s*,\s*(["'])((?:\\.|(?!\3).)*)\3/g;
      let m;
      while ((m = re.exec(src))) {
        const [, , key, , literal] = m;
        if (!LOCKED_VOCAB_KEYS.includes(key)) continue;
        const want = EN[key];
        if (want === undefined) continue;
        if (literal.replace(/\\"/g, '"') !== want) {
          const line = src.slice(0, m.index).split("\n").length;
          drifted.push(
            `${path.relative(SRC, file)}:${line}  ${key}\n` +
              `    fallback : ${JSON.stringify(literal)}\n` +
              `    catalogue: ${JSON.stringify(want)}`,
          );
        }
      }
    }
    expect(drifted, `stale inline fallbacks:\n${drifted.join("\n")}`).toEqual([]);
  });
});
