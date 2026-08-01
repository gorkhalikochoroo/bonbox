/**
 * The language count BonBox advertises.
 *
 * This is a sales claim on the pricing page and in the landing "fact" row, and
 * it was wrong: the copy said 6, the picker offered 7, and only 3 locales were
 * actually finished. Someone comparing plans could pick Deutsch and land in a
 * 90%-English app.
 *
 * Two things keep that from coming back:
 *   1. the picker only offers locales at full coverage, and
 *   2. every count shown to a user is DERIVED from that list, never typed.
 *
 * (2) is the one a future edit is most likely to undo — a literal "6 languages"
 * is a very natural thing to type into a marketing string — so the last test
 * greps the shipped dictionaries for one.
 */
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ALL_LANGUAGES,
  COMPLETE_LANGUAGE_COUNT,
  COMPLETE_LANGUAGE_NAMES,
  LANGUAGES,
} from "../i18n/languageCatalog";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

describe("advertised language count", () => {
  it("is a real count, not a typed-in number", () => {
    expect(COMPLETE_LANGUAGE_COUNT).toBeGreaterThan(0);
    // The names list must agree with the count — they are shown side by side.
    expect(COMPLETE_LANGUAGE_NAMES.split(", ")).toHaveLength(COMPLETE_LANGUAGE_COUNT);
  });

  it("counts Danish and English, the two markets we actually serve", () => {
    expect(COMPLETE_LANGUAGE_NAMES).toContain("Dansk");
    expect(COMPLETE_LANGUAGE_NAMES).toContain("English");
  });

  it("does not offer Nepali", () => {
    // Hidden by product decision. The dictionary and the "np" code stay — this
    // asserts only that we stop OFFERING it, which is the part that regressed
    // once already by simply never being done.
    expect(COMPLETE_LANGUAGE_NAMES).not.toContain("नेपाली");
    expect(LANGUAGES.map((l) => l.code)).not.toContain("np");
  });

  it("still resolves Nepali for anyone already reading it", () => {
    // The whole point of hiding rather than deleting.
    const np = ALL_LANGUAGES.find((l) => l.code === "np");
    expect(np).toBeDefined();
    expect(np.label).toBe("नेपाली");
  });

  it("has no hardcoded language count anywhere in the UI", () => {
    // e.g. "6 languages", "6 sprog", "7 dil" — the exact defect this replaced.
    const claim = /\b\d+\s*(languages?|sprog|dil|ngôn ngữ|ภาษา|भाषा)\b/i;
    const offenders = [];

    const walk = (dir) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(full);
          continue;
        }
        if (!/\.(js|jsx)$/.test(entry.name)) continue;
        readFileSync(full, "utf8").split("\n").forEach((line, i) => {
          // Comments explain the history and are allowed to quote the old copy.
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (claim.test(line)) offenders.push(`${entry.name}:${i + 1}: ${line.trim()}`);
        });
      }
    };
    walk(SRC);

    expect(
      offenders,
      `Hardcoded language count found. Use COMPLETE_LANGUAGE_COUNT / a {n} ` +
        `placeholder instead, so the claim tracks what the picker offers:\n` +
        offenders.join("\n"),
    ).toEqual([]);
  });
});
