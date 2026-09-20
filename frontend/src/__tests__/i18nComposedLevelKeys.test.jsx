/**
 * The badge that stuttered.
 *
 * A Danish owner who photographed a kasserapport read this, at the top of the
 * scan result, on production:
 *
 *     Høj sikkerhed sikkerhed — 5/7 felter fundet
 *
 * Nothing was misspelled and no key was missing. The sentence is composed:
 * `scanConfidenceLevel` is "{level} sikkerhed — {detected}/{total} felter
 * fundet", and the {level} it was handed was `confidenceHigh` — whose value is
 * "Høj sikkerhed", because that key is ALSO a standalone pill label on the
 * staffing card, where the noun has to be there. One key doing two jobs: a
 * whole label in one place, a fragment of one in another. The English read
 * "High confidence confidence — 5/7 fields detected" for exactly the same
 * reason, so this was never a translation slip.
 *
 * The fix is `confidenceLevel*` — the bare word, for templates that already
 * carry the noun. This guard is what keeps the next one from shipping: it
 * RESOLVES each composed template through the real catalogue in BOTH offered
 * languages and fails if any word appears twice in the finished sentence.
 *
 * Adding a new "{level}"-style template? Put it in COMPOSED below. A guard
 * that only knows about the one defect it was written for is a comment.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { LanguageProvider, useLanguage } from "../hooks/useLanguage";

/**
 * Every template whose copy interpolates a LEVEL word, with the keys that can
 * legally fill the slot. `vars` supplies the rest of the placeholders so the
 * assertion sees the sentence the owner sees, not a half-substituted one.
 */
const COMPOSED = [
  {
    template: "scanConfidenceLevel",
    levelKeys: ["confidenceLevelHigh", "confidenceLevelMedium", "confidenceLevelLow"],
    vars: { detected: 5, total: 7 },
  },
];

/**
 * The languages this file can resolve through the real <LanguageProvider>.
 *
 * Only en and da are bundled; every other pack is lazy-loaded (LAZY_LOADERS in
 * useLanguage.jsx), so a synchronous render sees English for all of its keys.
 * Rendering tr here would therefore assert on English and pass no matter what
 * tr.js says — a guard that cannot fail. The other offered locales are checked
 * against their own tables instead, in the second describe below.
 */
const LANGS = ["en", "da"];

function Probe({ tkey, vars }) {
  const { t } = useLanguage();
  return <span data-testid="out">{vars ? t(tkey, undefined, vars) : t(tkey)}</span>;
}

const resolve = (tkey, lang, vars) => {
  localStorage.setItem("lang", lang);
  const { unmount } = render(
    <LanguageProvider>
      <Probe tkey={tkey} vars={vars} />
    </LanguageProvider>,
  );
  const text = screen.getByTestId("out").textContent;
  unmount();
  return text;
};

/**
 * The words of a rendered sentence, lowercased, with punctuation and the
 * numbers dropped. "5/7" is not a word and "—" is not a repeat.
 */
const words = (sentence) =>
  String(sentence)
    .toLowerCase()
    .replace(/[0-9]+/g, " ")
    .split(/[^\p{L}]+/u)
    .filter(Boolean);

/** Words that may legitimately appear twice in one sentence. */
const FUNCTION_WORDS = new Set(["of", "the", "a", "an", "and", "or", "af", "og", "en", "et", "til"]);

const repeatedWord = (sentence) => {
  const seen = new Set();
  for (const w of words(sentence)) {
    if (FUNCTION_WORDS.has(w)) continue;
    if (seen.has(w)) return w;
    seen.add(w);
  }
  return null;
};

describe("composed {level} copy never says the same word twice", () => {
  beforeEach(() => localStorage.clear());

  const cases = COMPOSED.flatMap(({ template, levelKeys, vars }) =>
    LANGS.flatMap((lang) => levelKeys.map((levelKey) => [template, levelKey, lang, vars])),
  );

  it.each(cases)("%s + %s (%s)", (template, levelKey, lang, vars) => {
    const level = resolve(levelKey, lang);
    const sentence = resolve(template, lang, { ...vars, level });
    // The slot was actually filled — a template that silently kept "{level}"
    // would pass a repeat check while saying nothing at all.
    expect(sentence).not.toContain("{level}");
    expect(sentence).toContain(level);
    expect(repeatedWord(sentence)).toBeNull();
  });

  it.each(LANGS)("%s: the level word is bare, the pill label is not", (lang) => {
    // The two families must stay distinct. If someone ever "simplifies" by
    // pointing confidenceLevelHigh back at confidenceHigh, the stutter returns
    // and the per-sentence check above is the only thing that would catch it —
    // this makes the cause, not just the symptom, fail.
    for (const [bare, labelled] of [
      ["confidenceLevelHigh", "confidenceHigh"],
      ["confidenceLevelMedium", "confidenceMedium"],
      ["confidenceLevelLow", "confidenceLow"],
    ]) {
      const bareWords = words(resolve(bare, lang));
      expect(bareWords.length).toBe(1);
      expect(resolve(labelled, lang)).not.toBe(resolve(bare, lang));
    }
  });
});

/* ── Every OTHER offered locale, through the provider, awaited ─────────── */

/**
 * The defect shipped one locale over and this file could not see it.
 *
 * tr is offered (88%, in the picker) and defined none of the three new bare
 * keys, so t() fell back PER KEY to English and the Turkish badge composed to
 * "High güven — 5/7 alan algılandı": an English word welded into a Turkish
 * sentence.
 *
 * The block above cannot catch that, and not because it was scoped to two
 * languages — because every other pack is LAZY-loaded (LAZY_LOADERS in
 * useLanguage.jsx). A synchronous render of lang="tr" reads English for every
 * key and passes whatever tr.js contains. So this half waits for the chunk
 * before reading the sentence. Without the await it is a guard that cannot
 * fail, which is worse than no guard.
 */
describe("composed {level} copy holds in every offered locale, not just the bundled two", () => {
  beforeEach(() => localStorage.clear());

  /** Render, then WAIT for the lazily-imported pack to land before reading. */
  const resolveLoaded = async (tkey, lang, vars, settleOn) => {
    localStorage.setItem("lang", lang);
    const { unmount } = render(
      <LanguageProvider>
        <Probe tkey={tkey} vars={vars} />
      </LanguageProvider>,
    );
    await waitFor(() => {
      expect(screen.getByTestId("out").textContent).not.toBe(settleOn);
    });
    const text = screen.getByTestId("out").textContent;
    unmount();
    return text;
  };

  it("resolves each composed sentence per offered locale and finds no repeated word", async () => {
    const { ALL_LANGUAGES } = await import("../i18n/languageCatalog");
    const offered = ALL_LANGUAGES.filter((l) => l.offered).map((l) => l.code);
    const lazy = offered.filter((c) => c !== "en" && c !== "da");
    // If this ever drops to the two bundled packs, the block is dead weight
    // and should say so rather than quietly passing.
    expect(lazy.length).toBeGreaterThan(0);

    const failures = [];
    for (const lang of lazy) {
      for (const { template, levelKeys, vars } of COMPOSED) {
        // The English value is what a not-yet-loaded pack renders, so it is
        // also the signal that the chunk has not landed yet.
        const enTemplate = resolve(template, "en", { ...vars, level: "" });
        for (const levelKey of levelKeys) {
          const level = await resolveLoaded(levelKey, lang, undefined, resolve(levelKey, "en"));
          const sentence = await resolveLoaded(
            template,
            lang,
            { ...vars, level },
            enTemplate.replace("", ""),
          );
          const dupe = repeatedWord(sentence);
          if (dupe) failures.push(`${lang} · ${template} + ${levelKey} → "${sentence}" (repeats "${dupe}")`);
        }
      }
    }
    expect(failures, `composed copy stutters:\n${failures.join("\n")}`).toEqual([]);
  });

  it("gives every offered locale its OWN level words, not an English fallback", async () => {
    // The repeated-word check above cannot see the original tr defect. With
    // the key simply ABSENT, t() falls back to the English "High" and the
    // sentence reads "High güven — 5/7 alan algılandı": no word appears twice,
    // so nothing stutters — it is just half in the wrong language. That is the
    // shape a new composed key will have on the day it is added, so the
    // presence of the key is its own assertion.
    const { ALL_LANGUAGES } = await import("../i18n/languageCatalog");
    const PACKS = { tr: (await import("../i18n/tr.js")).tr };
    const lazy = ALL_LANGUAGES.filter((l) => l.offered).map((l) => l.code)
      .filter((c) => c !== "en" && c !== "da");

    const missing = [];
    for (const lang of lazy) {
      const pack = PACKS[lang];
      expect(pack, `offered locale "${lang}" has no pack imported here`).toBeTruthy();
      for (const { template, levelKeys } of COMPOSED) {
        for (const key of [template, ...levelKeys]) {
          if (typeof pack[key] !== "string" || !pack[key].trim()) missing.push(`${lang}.${key}`);
        }
      }
    }
    expect(
      missing,
      `these compose an English word into a non-English sentence:\n${missing.join("\n")}`,
    ).toEqual([]);
  });
});
