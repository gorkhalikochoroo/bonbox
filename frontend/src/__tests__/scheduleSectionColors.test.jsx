/**
 * Every SECTION roleSections.js can resolve must be paintable by the owner grid.
 *
 * The grid looked up ROLE_COLORS[section] and dereferenced the result on the
 * next line — `colors.dot`, `colors.bg` — with no guard. That map held the three
 * HOSPITALITY sections; roleSections.js resolves FIVE, because a salon splits
 * into `treatment` and `front`. So every salon owner's Vagtplan threw
 * "Cannot read properties of undefined" on first paint: the desktop grid, the
 * phone day-list and the staff panel, all three.
 *
 * Nobody noticed because no salon account has ever opened the page and no test
 * rendered it with a non-restaurant business_type. This file is the guard that
 * makes adding a SECTION id unable to ship that crash again — it asserts TOTAL
 * coverage rather than spot-checking the two that were missing.
 *
 * It also pins the labels end-to-end: a section whose label key is absent from
 * the catalogue renders the raw key ("sectionTreatment") to the owner, which is
 * exactly what roleSections.js's SECTION_META was set up to do before these two
 * keys existed in useLanguage.jsx.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { SECTION, SECTION_META } from "../config/roleSections";
import {
  SECTION_BAR,
  SECTION_BAR_NEUTRAL,
  SECTION_COLORS,
  SECTION_HEADER,
  SECTION_LABEL_FALLBACK,
  SECTION_LABEL_KEY,
} from "../config/scheduleSectionColors";
import { OTHER_SECTION } from "../config/scheduleGrid";
import { LanguageProvider, useLanguage } from "../hooks/useLanguage";

const ALL_SECTIONS = Object.values(SECTION);

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

describe("owner grid section palette", () => {
  it("covers every section id roleSections can return", () => {
    expect(ALL_SECTIONS.length).toBeGreaterThan(3); // salon's two are in there
    for (const s of ALL_SECTIONS) {
      expect(SECTION_COLORS[s], `SECTION_COLORS["${s}"]`).toBeTruthy();
      expect(SECTION_BAR[s], `SECTION_BAR["${s}"]`).toBeTruthy();
      expect(SECTION_LABEL_KEY[s], `SECTION_LABEL_KEY["${s}"]`).toBeTruthy();
      expect(SECTION_LABEL_FALLBACK[s], `SECTION_LABEL_FALLBACK["${s}"]`).toBeTruthy();
    }
  });

  it("gives every section the four class slots the grid dereferences", () => {
    // bg/text/border/dot are read unconditionally at the shift chip, the staff
    // panel badge and the row dot. A partial entry crashes exactly like a
    // missing one, just further down the page.
    for (const s of ALL_SECTIONS) {
      for (const slot of ["bg", "text", "border", "dot"]) {
        expect(SECTION_COLORS[s][slot], `SECTION_COLORS["${s}"].${slot}`).toBeTruthy();
      }
    }
  });

  it("agrees with roleSections' own label key for each section", () => {
    // Two maps naming the same section is how ROLE_CATEGORY and roleBarColor
    // drifted in the first place. They may differ in COLOUR (each surface owns
    // its palette) but never in which i18n key names the section.
    for (const s of ALL_SECTIONS) {
      expect(SECTION_LABEL_KEY[s]).toBe(SECTION_META[s].labelKey);
    }
  });

  it("renders a real word, never a raw key, in en and da", () => {
    for (const s of ALL_SECTIONS) {
      const key = SECTION_LABEL_KEY[s];
      for (const lang of ["en", "da"]) {
        expect(resolve(key, lang), `${key} @ ${lang}`).not.toBe(key);
      }
    }
  });

  it("keeps the salon sections on the staff app's hues", () => {
    // StaffPortalPage.roleBarColor paints treatment violet and front blue, and
    // the owner grid had claimed no hue for these two — a stylist reading both
    // surfaces should not have to re-learn the palette.
    expect(SECTION_COLORS[SECTION.TREATMENT].dot).toBe("bg-violet-500");
    expect(SECTION_BAR[SECTION.TREATMENT]).toBe("border-violet-500");
    expect(SECTION_COLORS[SECTION.FRONT].dot).toBe("bg-blue-500");
    expect(SECTION_BAR[SECTION.FRONT]).toBe("border-blue-500");
  });

  it("leaves emerald to mean exactly one thing: seen by staff", () => {
    // `floor` used to be emerald here. It moved to violet (the hue the staff
    // app already uses for it) the moment emerald became the grid's
    // acknowledgement signal — the day-header dot and the check on a card. A
    // role bar wearing the same green makes that signal unreadable: every Gulv
    // row would look acknowledged whether or not anyone had opened it.
    expect(SECTION_COLORS[SECTION.FLOOR].dot).toBe("bg-violet-500");
    expect(SECTION_BAR[SECTION.FLOOR]).toContain("border-violet-500");
    for (const s of ALL_SECTIONS) {
      expect(SECTION_COLORS[s].dot, `SECTION_COLORS["${s}"].dot`).not.toContain("emerald");
      expect(SECTION_BAR[s], `SECTION_BAR["${s}"]`).not.toContain("emerald");
      expect(SECTION_HEADER[s].bg, `SECTION_HEADER["${s}"].bg`).not.toContain("emerald");
    }
  });

  it("gives the Option-B section header every slot it dereferences", () => {
    // Same failure mode as SECTION_COLORS, one row higher up the table: the
    // header reads hdr.bg / hdr.bar / hdr.text / hdr.dot unconditionally.
    // `other` is in here too — it is not a section roleSections can return,
    // but the grid renders a header for it whenever a role resolves to null.
    for (const s of [...ALL_SECTIONS, OTHER_SECTION]) {
      for (const slot of ["bg", "bar", "text", "dot"]) {
        expect(SECTION_HEADER[s]?.[slot], `SECTION_HEADER["${s}"].${slot}`).toBeTruthy();
      }
    }
    // …and `other` stays colourless rather than borrowing a real section's hue.
    expect(SECTION_HEADER[OTHER_SECTION].bar).toBe("border-gray-300");
  });

  it("has a neutral card bar for a vertical with no sections", () => {
    // retail / services / personal render no "Roller:" legend, so a hued bar on
    // their cards is a key with nothing to read it by. The bar still has to
    // EXIST — it carries the card's left inset — so it goes grey, not away.
    expect(SECTION_BAR_NEUTRAL).toContain("border-gray-200");
    for (const s of ALL_SECTIONS) {
      expect(SECTION_BAR_NEUTRAL).not.toBe(SECTION_BAR[s]);
    }
    expect(SECTION_BAR_NEUTRAL).not.toMatch(/emerald|violet|red-500|blue-500|amber/);
  });

  it("names the `other` bucket in both locales", () => {
    expect(SECTION_LABEL_KEY[OTHER_SECTION]).toBeTruthy();
    for (const lang of ["en", "da"]) {
      expect(resolve(SECTION_LABEL_KEY[OTHER_SECTION], lang)).not.toBe(
        SECTION_LABEL_KEY[OTHER_SECTION],
      );
    }
  });
});
