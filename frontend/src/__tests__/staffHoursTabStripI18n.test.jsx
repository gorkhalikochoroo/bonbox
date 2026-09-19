/**
 * One tab strip, one language.
 *
 * THE BUG (measured on the live app, on the founder's own signed-in account):
 *   an ENGLISH session read the /staff/hours strip as
 *
 *       Hours · Tidsregistrering · Tips · Løn
 *
 *   — four labels, two languages, side by side. No fallback can produce that:
 *   `t()` falls back to EN and only EN (`loaded[lang]?.[key] || loaded.en[key]`),
 *   so a missing key yields English, never Danish.
 *
 *   ONE of the two is fully accounted for. `staffTimeReg` — and `tregTitle`,
 *   the page header under it — held the literal string "Tidsregistrering" in
 *   the `en` table, which is exactly why no `t("key", "fallback")` would have
 *   fixed it: the key exists, so the fallback never fires.
 *
 *   THE OTHER IS NOT. `staffPayroll` reads "Payroll" in the EN table at
 *   d495a4cf and in the deployed bundle, and StaffBackOfficePage is the only
 *   place that resolves the tab. So "Løn" in an English session is not
 *   reproducible from this code, and this file does not pretend otherwise: it
 *   pins that `staffPayroll` answers in English, so IF a path to that reading
 *   exists, a future change cannot quietly become it.
 *
 * WHAT THE LOCK ACTUALLY COVERS, since this is the argument that keeps
 * recurring: the DK terminology lock names ARTEFACTS a Danish business files
 * or hands over — kasserapport, revisor, MOMS, faktura, lønseddel — plus the
 * statutes and authorities themselves (Arbejdstidsloven, Arbejdstilsynet,
 * SKAT). A tab label is not an artefact; neither "Tidsregistrering" nor the
 * "Løn" TAB is on that list. They are ordinary chrome, so they translate. The
 * lønseddel DOWNLOAD inside the Løn tab is on the list and stays Danish — and
 * `lockedTerms` below asserts that distinction rather than leaving it to
 * prose, so the next reader does not have to relitigate it.
 *
 * WHY A TEST. The four labels live ~8,000 lines apart in one catalogue and no
 * call site reads both tables, so nothing structural stops a fifth tab landing
 * with a Danish EN value. This pins the INVARIANT — every tab in the strip
 * answers in the language it was asked in — and reads the key names out of the
 * page source so a future repoint is followed rather than silently skipped.
 */
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";

import { LanguageProvider, useLanguage } from "../hooks/useLanguage";

const SRC = join(dirname(fileURLToPath(import.meta.url)), "..");

/** Renders one t() call so assertions read the resolved string. */
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

/* The strip's keys, read from the page rather than hardcoded — if the tabs are
   ever repointed at different keys, this follows them instead of quietly
   testing four keys nothing renders any more. */
function tabKeysFromSource() {
  const src = readFileSync(join(SRC, "pages/StaffBackOfficePage.jsx"), "utf8");
  const block = /const tabs = \[([\s\S]*?)\]\.filter/.exec(src);
  if (!block) throw new Error("StaffBackOfficePage: `const tabs = [` block not found");
  return [...block[1].matchAll(/label:\s*t\("([^"]+)"/g)].map((m) => m[1]);
}

const TAB_KEYS = tabKeysFromSource();

// Danish letters are the cheap, reliable tell. A Danish word spelled with only
// ASCII ("Tidsregistrering") slips past it — which is why the identity check
// below exists as well: that one catches any EN value that was never written.
const DANISH_LETTERS = /[æøåÆØÅ]/;

describe("the /staff/hours tab strip answers in the language it was asked in", () => {
  beforeEach(() => localStorage.clear());

  it("reads all four tabs out of the page", () => {
    expect(TAB_KEYS).toEqual(["staffHours", "staffTimeReg", "staffTips", "staffPayroll"]);
  });

  it.each(TAB_KEYS)("%s resolves to a real label in both tables", (key) => {
    // t() returns the KEY NAME when nothing resolves, so "not empty" is not
    // enough — a missing entry would sail through as the string "staffTips".
    for (const lang of ["en", "da"]) {
      const label = resolve(key, lang);
      expect(label).toBeTruthy();
      expect(label).not.toBe(key);
    }
  });

  it.each(TAB_KEYS)("%s: the English label is English", (key) => {
    expect(resolve(key, "en")).not.toMatch(DANISH_LETTERS);
  });

  it.each(TAB_KEYS)("%s: English and Danish are actually two entries", (key) => {
    // Byte-identical across the two tables means one of them was never
    // written. Every label in THIS strip is an ordinary noun with a real
    // translation on both sides, so identity here is always the defect.
    expect(resolve(key, "en")).not.toBe(resolve(key, "da"));
  });

  it("English keeps its own words — including the half that was never explained", () => {
    // Stated as exact values, not just "contains no ø". The measured strip
    // reported "Løn" on an English session and nothing in this repo produces
    // that; if some path to it exists, these four are the values it would have
    // to move through first.
    expect(resolve("staffHours", "en")).toBe("Hours");
    expect(resolve("staffTimeReg", "en")).toBe("Time tracking");
    expect(resolve("staffTips", "en")).toBe("Tips");
    expect(resolve("staffPayroll", "en")).toBe("Payroll");
  });

  it("Danish keeps its own words", () => {
    // Pins the DIRECTION: the strip could be made consistent by flipping the
    // Danish labels to English, which would be consistent and wrong.
    expect(resolve("staffTimeReg", "da")).toBe("Tidsregistrering");
    expect(resolve("staffPayroll", "da")).toBe("Løn");
    expect(resolve("staffHours", "da")).toBe("Timer");
    expect(resolve("staffTips", "da")).toBe("Drikkepenge");
  });

  it.each(["en", "da"])("%s: the tab and the page under it are one noun", (lang) => {
    // tregTitle is the PageHeader inside the Tidsregistrering tab. A tab that
    // says one word above a heading that says another is the same defect, one
    // click later — so the title moved with the label.
    expect(resolve("tregTitle", lang)).toBe(resolve("staffTimeReg", lang));
  });

  it("the lønseddel download inside the Løn tab stays Danish in English", () => {
    // The distinction the whole fix rests on: the TAB translates, the ARTEFACT
    // does not. Without this, "translate the tab" reads as licence to translate
    // the payslip too.
    expect(resolve("payrollLoenseddelPdf", "en")).toMatch(/Lønseddel/);
  });
});
