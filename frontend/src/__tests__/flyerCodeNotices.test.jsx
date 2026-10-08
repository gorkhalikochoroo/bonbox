/**
 * The public notices must say what the flyer code is actually used for.
 *
 * The code from a leave-behind QR is kept on the new account and counted per
 * code against how far that account got (backend/app/routers/admin.py,
 * GET /admin/signup-refs). An earlier text said it "only counts which visits
 * led to a signup" and "which round of visits led to accounts" — narrower
 * than the truth. /cookies also said the Analytics category was "switched off
 * until you turn it on", while BonBox's own usage events (useEventLog.js) run
 * until the owner declines or pauses them. These checks keep both texts true
 * in en and da.
 */
import { render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import PrivacyPolicyPage from "../pages/PrivacyPolicyPage";
import CookiePolicyPage from "../pages/CookiePolicyPage";
import { LanguageProvider } from "../hooks/useLanguage";
import { en } from "../i18n/en";
import { da } from "../i18n/da";

const textAt = (Page, lang) => {
  localStorage.setItem("lang", lang);
  const { container } = render(
    <LanguageProvider>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </LanguageProvider>,
  );
  return container.textContent.replace(/\s+/g, " ");
};

const STAGES = {
  en: ["e-mail confirmed", "setup finished", "first daily close", "staff link made and opened", "active in the last 7 days", "one code is one visit", "numbers per code", "never used to contact"],
  da: ["e-mail bekræftet", "opsætning færdig", "første dagsafslutning", "medarbejderlink lavet og åbnet", "aktiv inden for de seneste 7 dage", "én kode er ét besøg", "tal pr. kode", "aldrig til at kontakte"],
};

const UNTRUE = [
  "only counts which visits", "which round of visits", "It is only counted",
  "tæller kun, hvilke besøg", "hvilken besøgsrunde", "Den bliver kun talt",
  "switched off until you turn it on", "slået fra, indtil du slår den til",
];

beforeEach(() => localStorage.clear());

describe.each([
  ["CookiePolicyPage", CookiePolicyPage],
  ["PrivacyPolicyPage", PrivacyPolicyPage],
])("%s — the flyer code", (_name, Page) => {
  it.each(["en", "da"])("lang=%s names every step it is counted against, per code", (lang) => {
    const text = textAt(Page, lang);
    for (const s of STAGES[lang]) expect(text).toContain(s);
    for (const s of UNTRUE) expect(text).not.toContain(s);
    expect(text).toContain(lang === "en" ? "30 days" : "30 dage");
  });
});

describe("CookiePolicyPage — the Analytics category", () => {
  it.each([
    ["en", "until you decline Analytics in the banner or pause them in Profile", "No third-party analytics tool is loaded"],
    ["da", "indtil du afviser Analyse i banneret eller sætter dem på pause under Profil", "Der indlæses intet analyseværktøj fra tredjeparter"],
  ])("lang=%s says first-party usage events run until declined or paused", (lang, runs, noTool) => {
    const text = textAt(CookiePolicyPage, lang);
    expect(text).toContain(runs);
    expect(text).toContain(noTool);
  });
});

describe("cookie banner — Analytics category description", () => {
  it("names the flyer code's 30 days on the device, in en and da", () => {
    expect(en.cookieCatAnalyticsDesc).toMatch(/printed flyers.*30 days.*signup can be counted/);
    expect(da.cookieCatAnalyticsDesc).toMatch(/trykte foldere.*30 dage.*oprettelse kan tælles/);
  });
});
