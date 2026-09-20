/**
 * What the close surface says when the money does NOT get saved.
 *
 * Two paths on this page still spoke the server's language to a Danish owner:
 *
 *   • the LOCK. `setError(typeof d === "string" ? d : … : "Failed to save")` —
 *     so a refused lock showed either FastAPI's own English sentence as the
 *     headline, or the literal string "Failed to save", which is not a sentence
 *     in any language the owner reads and does not say WHAT was not saved. At
 *     23:30, on the one screen that exists to put the day's money beyond doubt.
 *   • the PHOTO. "OCR scanning failed. Please enter values manually." as the
 *     fallback — the app's own words, in English, on the Danish audit trail.
 *
 * Both now lead with a Danish sentence that names the action and the way out,
 * and the server's wording is demoted to a muted second line — exactly the
 * shape the offline queue already used, and for the same reason: the raw text
 * is a clue for the revisor, never the thing the closer has to decode.
 *
 * This is a SOURCE guard for the same reason DailyClosePage.surfaceGuard.test
 * is one: the failure branch sits at the end of a nine-step wizard behind a
 * confirm dialog, so a render test for it pins the wizard's navigation far more
 * than it pins the error copy — and the defect is the copy. The catalogue half
 * below then proves the keys it routes through are real in both languages.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { LanguageProvider, useLanguage } from "../hooks/useLanguage";

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, "..", "pages", "DailyClosePage.jsx"), "utf8");

/** The file with comments stripped, so a defect QUOTED in a WHY-comment (this
 *  file's own subject matter, and the page's) is never counted as one. */
const CODE = SOURCE
  .replace(/\/\*[\s\S]*?\*\//g, "")
  .split("\n")
  .filter((l) => !/^\s*(\/\/|\*)/.test(l))
  .join("\n");

describe("the lock failure speaks Danish and demotes the server", () => {
  it('the literal "Failed to save" is gone from the page', () => {
    expect(CODE).not.toMatch(/["'`]Failed to save["'`]/);
  });

  it("the raw-detail ternary that produced it is gone", () => {
    // `setError(typeof d === "string" ? d : …)` put FastAPI's sentence in the
    // headline slot. Nothing on this page may hand setError a server value.
    expect(CODE).not.toMatch(/setError\(\s*typeof\b/);
    expect(CODE).not.toMatch(/setError\([^)\n]*err\.response/);
  });

  it("no error setter on this page takes a non-empty string literal", () => {
    // A string literal in an error setter is, by construction, untranslated:
    // it cannot be anything but the language it was typed in. `setError("")`
    // is excluded — that is a CLEAR, not a message.
    const literals =
      CODE.match(/set(?:Scan|Review|Chip|Unlock|Export)?Error\(\s*(["'`])(?!\1)/g) || [];
    expect(literals).toEqual([]);
  });

  it("the lock failure routes through the Danish key and keeps the detail apart", () => {
    expect(CODE).toMatch(/setError\(t\("dcLockFailed"/);
    expect(CODE).toMatch(/setErrorDetail\(/);
    // Cleared when a new attempt starts — a stale server line under a fresh
    // failure is worse than none.
    expect(CODE).toMatch(/setErrorDetail\(\s*""\s*\)/);
    // And rendered, or the state is a lie.
    expect(CODE).toMatch(/\{errorDetail\}/);
  });

  it("axios's own message never reaches the detail line", () => {
    // errText falls back to "Request failed with status code 500" when the
    // payload said nothing. That is noise dressed as an explanation, so the
    // detail line is gated on the server having actually said something.
    expect(CODE).toMatch(/serverSaid\s*==\s*null\s*\?\s*""\s*:/);
  });

  it("the photo read falls back to the Danish key, not to English prose", () => {
    expect(CODE).toMatch(/setScanError\(errText\(err,\s*t\("dcScanFailed"/);
    expect(CODE).not.toMatch(/OCR scanning failed/);
  });
});

/* ── The keys the guard above routes through must actually exist, in both ──
 *    languages. A source guard that points at a missing key is a guard that
 *    shows the owner a raw key name at the worst possible moment. */
function Probe({ tkey }) {
  const { t } = useLanguage();
  return <span data-testid="out">{t(tkey)}</span>;
}
const resolve = (tkey, lang) => {
  localStorage.setItem("lang", lang);
  const { unmount } = render(
    <LanguageProvider>
      <Probe tkey={tkey} />
    </LanguageProvider>,
  );
  const text = screen.getByTestId("out").textContent;
  unmount();
  return text;
};

describe("dcLockFailed / dcScanFailed are real copy in en and da", () => {
  beforeEach(() => localStorage.clear());

  it.each(["dcLockFailed", "dcScanFailed"])("%s resolves in both languages", (key) => {
    for (const lang of ["en", "da"]) {
      const s = resolve(key, lang);
      expect(s).not.toBe(key); // a raw key leak
      expect(s.length).toBeGreaterThan(20); // a sentence, not a label
    }
    // Genuinely translated, not the English copied across.
    expect(resolve(key, "da")).not.toBe(resolve(key, "en"));
  });

  it("the Danish lock failure names the artefact the owner knows", () => {
    expect(resolve("dcLockFailed", "da").toLowerCase()).toContain("kasserapport");
  });
});
