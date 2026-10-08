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
 *
 * 8 Oct review: the code is per account and every code maps to a venue in
 * the founder's visit log, so "only as numbers per code" was untrue; the
 * per-round totals also feed the founder's SDU thesis; the e-mail sign-in
 * link carries the code; it is deleted from accounts on 31 January 2027; and
 * the device switch is Marketing (channel measurement), not Analytics. The
 * banner's Analytics text no longer says "aggregate only, never tied to your
 * sales data" — events are stored per account and a sale's amount is in
 * one — in any language the banner can show.
 *
 * 8 Oct, Manoj's decision 1: the notices must NOT say the flyer totals are
 * used in his SDU thesis until SDU/DPO sign-off. The thesis sentence and the
 * thesis wording in the legal-basis line are gone; the flyer code is again
 * used "for nothing but the counts described above". The checks below assert
 * the thesis wording is ABSENT from both pages in every UI language (np, vi,
 * th and tr read the English document) and from every locale's cookie keys.
 */
import { render, waitFor } from "@testing-library/react";
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
  en: [
    "e-mail confirmed", "setup finished", "first daily close", "staff link made and opened",
    "active in the last 7 days", "one code is one visit", "never used to contact",
    "We note which venue we left each flyer at", "how far that venue's account got",
    "Only the founder sees them",
    "31 January 2027", "e-mail sign-in link, the code is added to that link", "allow Marketing",
  ],
  da: [
    "e-mail bekræftet", "opsætning færdig", "første daglige lukning (kasserapport)",
    "medarbejderlink lavet og åbnet", "aktiv inden for de seneste 7 dage", "én kode er ét besøg",
    "aldrig til at kontakte", "Vi noterer, hvilket sted vi har afleveret hver folder",
    "hvor langt det steds konto er nået", "Kun stifteren ser dem",
    "31. januar 2027", "login-link på e-mail, sættes koden på linket", "tillader Markedsføring",
  ],
};

const UNTRUE = [
  "only counts which visits", "which round of visits", "It is only counted",
  "tæller kun, hvilke besøg", "hvilken besøgsrunde", "Den bliver kun talt",
  "switched off until you turn it on", "slået fra, indtil du slår den til",
  // 8 Oct review
  "numbers per code", "tal pr. kode", "allow Analytics", "tillader Analyse",
  "Analytics consent", "samtykke til Analyse", "Turning Analytics on", "Slår du Analyse til",
  "første dagsafslutning", "(round, argument, visit)", "(runde, argument, besøg)",
  "du oprettede dig fra", "holdes koden kun", "skrives aldrig på", "kommer den ikke på din enhed",
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

// Manoj's decision 1 (8 Oct): no thesis use is announced until SDU/DPO
// sign-off. Every phrase the 5bdf9f2a thesis sentence and legal-basis line
// used, in both documents.
const THESIS_WORDING = [
  "thesis", "SDU", "Totals per round", "groups smaller than 5", "the thesis totals",
  "speciale", "Samlede tal pr. runde", "grupper under 5", "specialets samlede tal",
];

describe.each([
  ["CookiePolicyPage", CookiePolicyPage],
  ["PrivacyPolicyPage", PrivacyPolicyPage],
])("%s — no thesis use is announced", (_name, Page) => {
  it.each(["en", "da", "np", "vi", "th", "tr"])("lang=%s: the thesis sentence is absent", async (lang) => {
    localStorage.setItem("lang", lang);
    const { container } = render(
      <LanguageProvider>
        <MemoryRouter>
          <Page />
        </MemoryRouter>
      </LanguageProvider>,
    );
    // np/vi/th/tr dictionaries load lazily, so wait until the page has
    // rendered the flyer item at all — a blank render must not pass the
    // absence check vacuously. Those four read the English document.
    const shown = lang === "da" ? /kampagnekode/i : /campaign code/i;
    await waitFor(() => expect(container.textContent).toMatch(shown));
    const text = container.textContent.replace(/\s+/g, " ");
    for (const s of THESIS_WORDING) expect(text).not.toContain(s);
  });
});

describe("CookiePolicyPage — the flyer code is used for the counts only", () => {
  it.each([
    ["en", "the flyer code is used for nothing but the counts described above"],
    ["da", "folderkoden bruges ikke til andet end optællingen ovenfor"],
  ])("lang=%s says the counts are the only use", (lang, line) => {
    expect(textAt(CookiePolicyPage, lang)).toContain(line);
  });
});

describe("PrivacyPolicyPage — the legal-basis line names no thesis", () => {
  it.each([
    ["en", "Legal basis for this one item: our legitimate interest in knowing which visits work (GDPR Article 6(1)(f))"],
    ["da", "Retsgrundlag for netop dette punkt: vores legitime interesse i at vide, hvilke besøg der virker"],
  ])("lang=%s", (lang, line) => {
    expect(textAt(PrivacyPolicyPage, lang)).toContain(line);
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

describe("PrivacyPolicyPage — how long the flyer code stays on the account", () => {
  it.each([
    ["en", "Deleted on 31 January 2027, or earlier if you delete your account"],
    ["da", "Slettes den 31. januar 2027 eller tidligere, hvis du sletter din konto"],
  ])("lang=%s has a retention row with an end date", (lang, row) => {
    expect(textAt(PrivacyPolicyPage, lang)).toContain(row);
  });
});

describe("cookie banner — Marketing holds the flyer code, Analytics says what events are", () => {
  it("en and da: Marketing names the flyer code's 30 days; Analytics is per account, 180 days", () => {
    expect(en.cookieCatMarketingDesc).toMatch(/printed flyers.*30 days.*new account can be linked to that visit/);
    expect(da.cookieCatMarketingDesc).toMatch(/trykte foldere.*30 dage.*ny konto kan knyttes til det besøg/);
    expect(en.cookieCatAnalyticsDesc).toContain("Recorded per account in BonBox's own database, never shared with an analytics company, deleted after 180 days.");
    expect(da.cookieCatAnalyticsDesc).toContain("Registreres pr. konto i BonBox' egen database, deles aldrig med et analysefirma og slettes efter 180 dage.");
  });

  // useLanguage picks np/vi/th/tr from the browser, and t() uses a locale's
  // own key before English — so every locale that defines these keys is a
  // consent surface. (A locale without them falls back to the English text.)
  const OLD_ANALYTICS_CLAIMS = [
    "Aggregate only", "never tied to your sales data", "Kun aggregeret", "aldrig koblet til dine salgsdata",
    "केवल एकत्रित", "Chỉ tổng hợp", "รวมเฉพาะภาพรวม", "Yalnızca toplu",
  ];
  const locales = Object.entries(import.meta.glob("../i18n/*.js", { eager: true }))
    .flatMap(([file, mod]) => Object.values(mod).filter((v) => v && typeof v === "object" && !Array.isArray(v))
      .map((dict) => [file.replace(/^.*\//, ""), dict]))
    .filter(([, dict]) => "cookieCatMarketingDesc" in dict || "cookieCatAnalyticsDesc" in dict);

  it("covers every locale the browser can pick that carries the keys", () => {
    const files = locales.map(([f]) => f).sort();
    for (const f of ["da.js", "en.js", "np.js", "th.js", "tr.js", "vi.js"]) expect(files).toContain(f);
  });

  it.each(locales)("%s: Marketing names the 30 days; Analytics has no flyer sentence and no aggregate claim", (_f, dict) => {
    expect(dict.cookieCatMarketingDesc).toBeTruthy();
    expect(dict.cookieCatMarketingDesc).toMatch(/30|३०/);
    expect(dict.cookieCatMarketingDesc).toContain("QR");
    expect(dict.cookieCatAnalyticsDesc).toMatch(/180|१८०/);
    expect(dict.cookieCatAnalyticsDesc).not.toMatch(/QR|30\b|३०/);
    for (const claim of OLD_ANALYTICS_CLAIMS) expect(dict.cookieCatAnalyticsDesc).not.toContain(claim);
  });

  // Manoj's decision 1 (8 Oct): no banner text or cookie key in any of the
  // six languages announces a thesis use of the flyer totals.
  const THESIS_IN_ANY_LANGUAGE = /thesis|SDU|speciale|luận văn|วิทยานิพนธ์|शोधपत्र|थेसिस|\btez(?:de|i|imde)?\b/i;
  it.each(locales)("%s: no cookie key mentions a thesis", (_f, dict) => {
    const cookieKeys = Object.keys(dict).filter((k) => /^cookie/i.test(k));
    expect(cookieKeys).toContain("cookieCatMarketingDesc");
    for (const k of cookieKeys) expect(String(dict[k])).not.toMatch(THESIS_IN_ANY_LANGUAGE);
  });
});
