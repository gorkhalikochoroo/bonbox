/**
 * /privacy gets ONE sentence on the staff app's location use at clock-in
 * (Manoj, 11 Oct 2026), written from the code, not from the store copy:
 *
 *   • read only at clock-IN, only when the workplace's location check is on
 *     (StaffPortalPage useClock: `dir === "in" && st?.geofence_on`);
 *   • sent once with the clock-in; the server only computes the distance
 *     (staff_portal.portal_clock_in) and stores no coordinates — HoursLogged
 *     has no position column; only notes = "Location unverified" when there
 *     is no usable fix (denied, off, or accuracy over 200 m);
 *   • the business sees that as the "Location not verified" chip.
 *
 * The source-contract block at the bottom fails if the code stops matching
 * the sentence.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

let langCode = "da";
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ lang: langCode, setLang: () => {}, LANGUAGES: [], t: (_k, fb) => (typeof fb === "string" ? fb : _k) }),
  LanguageProvider: ({ children }) => children,
  detectInitialLanguage: () => "da",
}));
vi.mock("../components/CookieConsent", () => ({
  CookieSettingsButton: ({ label }) => <button type="button">{label}</button>,
}));

const PrivacyPolicyPage = (await import("../pages/PrivacyPolicyPage")).default;

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

afterEach(() => {
  cleanup();
  langCode = "da";
});

const sentence = (lang) => {
  langCode = lang;
  render(<MemoryRouter><PrivacyPolicyPage /></MemoryRouter>);
  return screen.getByTestId("privacy-clock-in-location").textContent.replace(/\s+/g, " ").trim();
};

describe("/privacy: one true sentence on location at clock-in", () => {
  it("da", () => {
    expect(sentence("da")).toBe(
      "Placering ved indstempling: Appen BonBox Vagtplan (og personalesiden i en browser) læser kun telefonens placering, når en medarbejder stempler ind på en arbejdsplads, der har slået placeringstjek til; BonBox bruger kun koordinaterne til at tjekke afstanden til arbejdspladsen og gemmer dem ikke, og virksomheden ser kun mærket »Placering ikke verificeret« ved en indstempling uden en brugbar placering.",
    );
  });

  it("en", () => {
    expect(sentence("en")).toBe(
      "Location at clock-in: the BonBox Vagtplan app (and the staff page in a browser) reads the phone’s location only when a staff member clocks in at a workplace that has turned on the location check; BonBox uses the coordinates only to check the distance to the workplace and does not save them, and the business sees only a “Location not verified” mark on a clock-in made without a usable location.",
    );
  });

  it("is one sentence in each language, sits with the processor paragraph, and quotes the owner's real chip label", () => {
    for (const lang of ["da", "en"]) {
      const s = sentence(lang);
      expect(s.match(/\.(\s|$)/g)).toHaveLength(1);
      const role = screen.getByTestId("privacy-processor-role");
      expect(role.nextElementSibling).toBe(screen.getByTestId("privacy-clock-in-location"));
      cleanup();
    }
    expect(sentence("da")).toContain(`»${da.schedGeoUnverifiedChip}«`);
    cleanup();
    expect(sentence("en")).toContain(`“${en.schedGeoUnverifiedChip}”`);
  });
});

describe("the code still does what the sentence says (source contract)", () => {
  const portal = read("pages/StaffPortalPage.jsx");

  it("the staff page reads the position once, only on clock-in with the location check on", () => {
    expect(portal.match(/getCurrentPosition\(/g)).toHaveLength(1);
    expect(portal.match(/watchPosition\(/g)).toBeNull();
    expect(portal).toContain('if (dir === "in" && st?.geofence_on) {');
    // getPos() is only called inside that branch.
    const calls = [...portal.matchAll(/await getPos\(\)/g)];
    expect(calls).toHaveLength(1);
    const branch = portal.indexOf('if (dir === "in" && st?.geofence_on) {');
    expect(calls[0].index).toBeGreaterThan(branch);
    expect(calls[0].index - branch).toBeLessThan(200);
  });

  it("the location prompt in the staff app says the same (never tracked in the background, never stored)", () => {
    const plist = fs.readFileSync(path.join(SRC, "..", "ios-scheduler/App/App/Info.plist"), "utf8");
    expect(plist).toContain("uses your location only when you clock in");
    expect(plist).toContain("your location is never stored");
  });
});
