/**
 * One notation for hours, enforced.
 *
 * Vagtplan and Timer & løn are the same week seen twice. They drifted anyway:
 * the schedule grid printed "38h" (its own local formatter) while the hours
 * page printed "38,0 t" (its own), and the Vagtplan Shield tooltips did not
 * format at all — they carried a literal "t" inside the catalogue string
 * ("{h}t of {cap}t"), so an English session read "34t of 37t".
 *
 * Two halves:
 *   1. utils/hours.js is the rule — unit-tested here.
 *   2. Neither page may re-type a unit after an interpolation. That is the
 *      shape every one of those bugs had (`${n}h`, `{h}t`), and it is what the
 *      grep below refuses. A page that needs a different precision passes
 *      `decimals`; it never types the letter.
 */
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { formatHours, hoursUnit } from "../utils/hours";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const GUARDED = [
  "pages/StaffSchedulePage.jsx",
  "pages/StaffHoursPage.jsx",
];

/* `}` immediately followed by a bare h/t — i.e. an interpolation with the unit
   typed after it. The trailing lookahead keeps `${x}hidden` and `${n}total`
   out: only a unit STANDING ALONE is a unit. */
const BARE_UNIT = /\}[ht](?![A-Za-z0-9_])/g;

describe("hours notation is single-sourced", () => {
  for (const rel of GUARDED) {
    it(`${rel} never types an hour unit after an interpolation`, () => {
      const src = fs.readFileSync(path.join(SRC, rel), "utf8");
      const hits = [];
      const lines = src.split("\n");
      lines.forEach((line, i) => {
        BARE_UNIT.lastIndex = 0;
        if (BARE_UNIT.test(line)) hits.push(`${rel}:${i + 1}  ${line.trim().slice(0, 100)}`);
      });
      expect(hits, `use formatHours() from utils/hours.js instead:\n${hits.join("\n")}`)
        .toEqual([]);
    });
  }
});

describe("formatHours", () => {
  it("writes the Danish unit with a decimal comma", () => {
    expect(formatHours(6.25, { lang: "da", decimals: 2 })).toBe("6,25 t");
  });

  it("writes the English unit with a decimal point", () => {
    expect(formatHours(6.25, { lang: "en", decimals: 2 })).toBe("6.25 h");
  });

  it("drops the decimals on a whole number", () => {
    // "38,0 t" claims a precision that says nothing. 38 hours is 38 hours.
    expect(formatHours(38, { lang: "da" })).toBe("38 t");
    expect(formatHours(38, { lang: "en" })).toBe("38 h");
  });

  it("always separates the number from the unit", () => {
    // The whole Vagtplan/Timer drift was visible in this one character.
    expect(formatHours(9, { lang: "da" })).toBe("9 t");
    expect(formatHours(9, { lang: "en" })).toBe("9 h");
  });

  it("renders the unknown as an em-dash, never 0", () => {
    for (const v of [null, undefined, "", NaN, "abc"]) {
      expect(formatHours(v, { lang: "da" })).toBe("—");
    }
  });

  it("does not claim a decimal the rounding threw away", () => {
    expect(formatHours(38.04, { lang: "da" })).toBe("38 t");
    expect(formatHours(38.16, { lang: "da" })).toBe("38,2 t");
  });

  it("signs a delta when asked", () => {
    expect(formatHours(2.5, { lang: "da", sign: true })).toBe("+2,5 t");
    expect(formatHours(-2.5, { lang: "da", sign: true })).toBe("-2,5 t");
  });

  it("maps the unit off the language in exactly one place", () => {
    expect(hoursUnit("da")).toBe("t");
    expect(hoursUnit("en")).toBe("h");
    expect(hoursUnit("tr")).toBe("sa");
    expect(hoursUnit("de")).toBe("h");
  });

  it("takes no unit override, so a caller cannot re-introduce a second source", () => {
    // The drift did not come from the formatter — it came from the schedule
    // grid supplying its OWN unit through t("schedHoursUnit"), which reads
    // "sa" in Turkish against hoursUnit()'s "h". An accepted override is an
    // invitation to do that again, so the option no longer exists: a stray
    // `unit` is ignored and the language still decides.
    expect(formatHours(9, { lang: "da", unit: "h" })).toBe("9 t");
    expect(formatHours(9, { lang: "tr", unit: "h" })).toBe("9 sa");
  });

  it("keys the decimal mark on the language, not on the unit's spelling", () => {
    // Keying it on `unit === "t"` only worked because Danish happened to be
    // the one language whose unit is "t" — Turkish then got an English
    // decimal point under a Turkish unit: "38.5 sa".
    expect(formatHours(38.5, { lang: "tr" })).toBe("38.5 sa");
    expect(formatHours(38.5, { lang: "da" })).toBe("38,5 t");
  });
});

/**
 * The cross-page half of the defect, at the level it actually bit: not "does
 * the formatter work", but "do the two pages agree". They agreed in da and en
 * while disagreeing in Turkish — an OFFERED locale — because each derived the
 * unit from a different source.
 */
describe("Vagtplan and Timer & løn print the same unit in every offered locale", () => {
  it("resolves one unit per locale, from one place", async () => {
    const { ALL_LANGUAGES } = await import("../i18n/languageCatalog");
    const offered = ALL_LANGUAGES.filter((l) => l.offered).map((l) => l.code);
    expect(offered.length).toBeGreaterThan(1);
    for (const code of offered) {
      // Both pages call formatHours with { lang } and nothing else, so this is
      // the whole disagreement surface. A page that starts passing its own
      // unit again fails the "no unit override" test above.
      expect(formatHours(38, { lang: code })).toBe(`38 ${hoursUnit(code)}`);
    }
  });

  it("gives every offered locale a unit that is not an English leftover by accident", () => {
    expect(hoursUnit("da")).not.toBe(hoursUnit("tr"));
  });
});
