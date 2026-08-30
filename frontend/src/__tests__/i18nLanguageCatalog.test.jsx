/**
 * Every language the picker OFFERS must actually stick.
 *
 * Two lists have to agree and nothing was checking that they did:
 *   • languageCatalog.js  — ALL_LANGUAGES[].offered: what the picker shows.
 *   • useLanguage.jsx     — SUPPORTED: the set detectInitialLanguage() gates
 *                           the STORED choice on.
 *
 * "de" was offered but absent from SUPPORTED, so picking Deutsch did not
 * survive a reload — and not merely by being ignored. detectInitialLanguage()
 * falls through to browser detection, and LanguageProvider then PERSISTS that
 * result, so the user's stored "de" was overwritten with "en". Verified in a
 * browser before the fix: set lang=de, reload, localStorage.lang came back
 * "en" and <html lang> was "en"; the same steps with "tr" kept Turkish.
 *
 * That contradicts the comment above SUPPORTED, which promises that once
 * "lang" is in localStorage we trust the user's explicit choice.
 */
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";

import { ALL_LANGUAGES, LANGUAGES, COMPLETE_LANGUAGE_COUNT } from "../i18n/languageCatalog";
import { detectInitialLanguage, LanguageProvider } from "../hooks/useLanguage";

const OFFERED = ALL_LANGUAGES.filter((l) => l.offered).map((l) => l.code);

describe("offered languages survive a reload", () => {
  beforeEach(() => localStorage.clear());

  it.each(OFFERED)("%s is honoured as a stored choice", (code) => {
    localStorage.setItem("lang", code);
    expect(detectInitialLanguage()).toEqual({ lang: code, source: "stored" });
  });

  it.each(OFFERED)("%s is not overwritten in storage on mount", (code) => {
    // The damaging half, and it happens in the PROVIDER, not in
    // detectInitialLanguage(): when the stored value fails the SUPPORTED gate,
    // LanguageProvider persists the auto-detected language over it. So the
    // preference is not ignored for one render — it is destroyed.
    localStorage.setItem("lang", code);
    const { unmount } = render(
      <LanguageProvider>
        <span />
      </LanguageProvider>,
    );
    expect(localStorage.getItem("lang")).toBe(code);
    unmount();
  });

  it("a language that is NOT offered is still rejected", () => {
    // The guard must stay a guard — this is what stops a stale or hand-edited
    // localStorage value putting the app into a pack the picker never showed.
    localStorage.setItem("lang", "xx-not-a-language");
    expect(detectInitialLanguage().source).not.toBe("stored");
  });
});

describe("the catalog and the picker agree", () => {
  it("LANGUAGES is exactly the offered subset", () => {
    expect(LANGUAGES.map((l) => l.code)).toEqual(OFFERED);
  });

  it("the count quoted in copy is derived, not typed", () => {
    expect(COMPLETE_LANGUAGE_COUNT).toBe(OFFERED.length);
  });

  it("every offered language has a dictionary that loads", async () => {
    // en and da live inside useLanguage.jsx itself; the rest are lazy chunks.
    const lazy = OFFERED.filter((c) => c !== "en" && c !== "da");
    for (const code of lazy) {
      const mod = await import(`../i18n/${code}.js`);
      // no.js exports `no_` because `no` is awkward as an identifier.
      const dict = mod[code] ?? mod[`${code}_`];
      expect(dict, `${code}.js exports no dictionary`).toBeTruthy();
      expect(Object.keys(dict).length).toBeGreaterThan(100);
    }
  });

  it("no NEW orphan dictionary appears", async () => {
    // Eight packs sit in src/i18n/ with working loaders in useLanguage.jsx but
    // appear in NEITHER the catalog NOR SUPPORTED, so no user can select them.
    // They still build: ~210KB of lazy chunks shipped to the CDN that nobody
    // can ever load. They are lazy, so this costs deploy weight rather than
    // anything a visitor downloads — which is why it went unnoticed.
    //
    // Deleting them is a product call (the packs are real work, and the same
    // note in languageCatalog.js records that hiding a language deliberately
    // keeps its dictionary on disk). So this test does NOT demand removal — it
    // pins the known set, so adding a NINTH orphan fails instead of drifting in
    // quietly the way these did.
    const KNOWN_ORPHANS = ["es", "fr", "it", "ja", "nl", "no", "pt", "sv"];

    const modules = import.meta.glob("../i18n/*.js");
    const codes = Object.keys(modules)
      .map((p) => p.split("/").pop().replace(/\.js$/, ""))
      .filter((c) => c !== "languageCatalog");

    const catalogued = new Set(ALL_LANGUAGES.map((l) => l.code));
    const orphans = codes.filter((c) => !catalogued.has(c)).sort();

    expect(orphans).toEqual([...KNOWN_ORPHANS].sort());
  });

  it("no offered language is missing a catalog entry", () => {
    for (const code of OFFERED) {
      const entry = ALL_LANGUAGES.find((l) => l.code === code);
      expect(entry.label, `${code} has no label`).toBeTruthy();
      expect(typeof entry.coverage).toBe("number");
    }
  });
});
