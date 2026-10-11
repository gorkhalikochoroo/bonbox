/**
 * Push 3 (Manoj, 11 Oct 2026, decision 3): /privacy says what Terms § 4 and
 * the code say — now, in the same release as the new Terms.
 *
 *   • Deleting the account deletes it and its data straight away; the change
 *     log, the security and error logs and the accounting-document images
 *     (about 6 years) are kept; backups expire on their own cycle (no number).
 *   • No IP anonymisation after 30 days (the change log and the security log
 *     keep the IP), no "adjustable 5–10 years" setting, no "the law requires
 *     US to keep your records" — the owner keeps them.
 *   • Processors: a location only where confirmed (Supabase: Ireland,
 *     Render: Frankfurt, Companies House: UK); the rest say "Not confirmed".
 *     The list names every service the code can send data to.
 *
 * The backend sibling (backend/tests/test_privacy_matches_code.py) holds the
 * same sentences against the code's own constants.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

let langCode = "da";
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ lang: langCode, setLang: () => {}, LANGUAGES: [], t: (_k, fb) => (typeof fb === "string" ? fb : _k) }),
  LanguageProvider: ({ children }) => children,
  detectInitialLanguage: () => "da",
}));
vi.mock("../components/CookieConsent", () => ({
  CookieSettingsButton: ({ label }) => <button type="button">{label}</button>,
}));
vi.mock("../utils/platform", () => ({
  isNativeApp: () => false,
  canPurchaseInApp: () => true,
  isIPad: () => false,
  platform: { isNative: false, isIOS: false, isAndroid: false, isWeb: true },
}));

const PrivacyPolicyPage = (await import("../pages/PrivacyPolicyPage")).default;
const TermsPage = (await import("../pages/TermsPage")).default;

afterEach(() => {
  cleanup();
  langCode = "da";
});

const renderPage = (Page, lang) => {
  langCode = lang;
  return render(<MemoryRouter><Page /></MemoryRouter>);
};

const tableRows = (container, headerText) => {
  const table = [...container.querySelectorAll("table")].find((t) => t.querySelector("th")?.textContent === headerText);
  return [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
};

const FALSE_BEFORE = {
  en: [
    "anonymized after 30 days", "adjustable 5–10 years", "Per your faktura retention setting",
    "extend up to 10 years", "requires us to retain", "cold storage", "Backups are purged within 90 days",
    "is erased within 30 days", "kept for the 5-year window", "Deleted within 30 days of import",
    "within 30 days of import", "10 years (Skatteforvaltningsloven", "365 days", "personal data is stripped",
    "not retained beyond Anthropic's operational logs", "typically 30 days", "EU/US servers",
    "do not keep it beyond their operational logs", "required by Bogføringsloven §9",
  ],
  da: [
    "anonymiseres efter 30 dage", "kan justeres til 5–10 år", "Følger din opbevaringsindstilling",
    "forlænge op til 10 år", "kræver, at vi opbevarer", "arkivlager", "Sikkerhedskopier slettes inden for 90 dage",
    "slettes inden for 30 dage", "opbevares i 5-årsperioden", "inden for 30 dage efter import",
    "10 år (maksimum efter skatteforvaltningslovens", "365 dage", "personoplysninger fjernes",
    "opbevares ikke ud over Anthropics driftslogge", "typisk 30 dage", "servere i EU/USA",
    "opbevarer det ikke ud over deres driftslogge", "Det kræves af bogføringslovens § 9",
  ],
};

describe("/privacy no longer says what the code does not do", () => {
  for (const lang of ["en", "da"]) {
    it(`${lang}: none of the old false sentences`, () => {
      const text = renderPage(PrivacyPolicyPage, lang).container.textContent;
      for (const gone of FALSE_BEFORE[lang]) expect(text).not.toContain(gone);
    });
  }
});

describe("deletion: /privacy says what Terms § 4 says", () => {
  for (const lang of ["en", "da"]) {
    it(`${lang}: the deletion paragraph is the Terms § 4 paragraph (minus the subscription sentence)`, () => {
      renderPage(PrivacyPolicyPage, lang);
      const privacy = screen.getByTestId("privacy-deletion").textContent;
      cleanup();
      const terms = renderPage(TermsPage, lang).container.textContent;
      expect(terms).toContain(privacy);
      expect(privacy).toContain(lang === "da" ? "med det samme" : "straight away");
      expect(privacy).toContain(lang === "da" ? "ca. 6 år efter sletningen" : "about 6 years after the deletion");
    });
  }

  it("en: the retention table says what the code keeps", () => {
    const { container } = renderPage(PrivacyPolicyPage, "en");
    const rows = Object.fromEntries(tableRows(container, "Data type"));
    expect(rows["Images of accounting documents you upload (kasserapport photos, receipt and sales photos, stock import files)"])
      .toBe("Until you delete your account, then about 6 years after the deletion; then deleted");
    expect(rows["Change log (every mark-paid / void / brand change), incl. your IP address"])
      .toBe("No end date: it cannot be edited or deleted through BonBox, and it is kept when you delete your account");
    expect(rows["Error log (technical errors, incl. IP address)"]).toBe("30 days, also after you delete your account");
    expect(rows["Security log (sign-ups we block or flag, e-mail sign-in links, admin access attempts and admin actions, changes to subscriptions and trials, plan limits and locked features you run into, and price lookups; some of them with IP address)"])
      .toBe("No end date; kept when you delete your account");
    expect(rows["Bank CSV files (raw)"]).toBe("Not saved: read in memory during the import");
    expect(rows["Backups of our database"]).toBe("Copies disappear when those backups expire");
    // No number of days for backups — the period is not confirmed.
    expect(rows["Backups of our database"]).not.toMatch(/\d/);
  });

  it("da: the retention table says the same", () => {
    const { container } = renderPage(PrivacyPolicyPage, "da");
    const rows = Object.fromEntries(tableRows(container, "Datatype"));
    expect(rows["Billeder af regnskabsbilag, du uploader (fotos af kasserapporter, kvitteringer og salg samt filer fra lagerimport)"])
      .toBe("Indtil du sletter din konto, derefter ca. 6 år efter sletningen; så slettes de");
    expect(rows["Ændringslog (hver markering som betalt / annullering / ændring af branding), inkl. din IP-adresse"])
      .toBe("Ingen slutdato: den kan ikke redigeres eller slettes gennem BonBox, og den beholdes, når du sletter din konto");
    expect(rows["Fejllog (tekniske fejl, inkl. IP-adresse)"]).toBe("30 dage, også efter at du har slettet din konto");
    expect(rows["Sikkerhedskopier af vores database"]).not.toMatch(/\d/);
  });

  it("the owner keeps the accounting records, not BonBox (da + en)", () => {
    let text = renderPage(PrivacyPolicyPage, "da").container.textContent;
    expect(text).toContain("Efter bogføringsloven er det dig — ikke BonBox — der skal opbevare din virksomheds regnskabsmateriale");
    expect(text).toContain("Der er ingen indstilling i BonBox, der ændrer, hvor længe vi opbevarer data.");
    cleanup();
    text = renderPage(PrivacyPolicyPage, "en").container.textContent;
    expect(text).toContain("Under the Danish Bookkeeping Act it is you — not BonBox — who must keep your business’s accounting records");
    expect(text).toContain("There is no setting in BonBox that changes how long we keep data.");
  });
});

describe("processors: complete, and a location only where confirmed", () => {
  const ALLOWED = {
    en: ["EU (Ireland)", "EU (Frankfurt, Germany)", "Global CDN", "Global", "United Kingdom", "Not confirmed"],
    da: ["EU (Irland)", "EU (Frankfurt, Tyskland)", "Globalt CDN", "Globalt", "Storbritannien", "Ikke bekræftet"],
  };
  for (const lang of ["en", "da"]) {
    it(`${lang}: every service the code calls is listed, with a confirmed location or 'not confirmed'`, () => {
      const { container } = renderPage(PrivacyPolicyPage, lang);
      const rows = tableRows(container, lang === "da" ? "Tjeneste" : "Service");
      const names = rows.map((r) => r[0]);
      for (const svc of ["Supabase", "Render", "Vercel", "Resend", "Postmark", "Anthropic (Claude API)", "OCR.space",
        "Google Cloud Vision", "Mindee", "Stripe", "Cloudflare", "Sentry", "Simply.com", "cvrapi.dk", "Companies House",
        "GatewayAPI", "Twilio", "Apple Push Notification service", "Slack"]) {
        expect(names).toContain(svc);
      }
      for (const r of rows) expect(ALLOWED[lang]).toContain(r[2]);
      const loc = Object.fromEntries(rows.map((r) => [r[0], r[2]]));
      expect(loc.Supabase).toBe(lang === "da" ? "EU (Irland)" : "EU (Ireland)");
      expect(loc.Render).toBe(lang === "da" ? "EU (Frankfurt, Tyskland)" : "EU (Frankfurt, Germany)");
      expect(screen.getByTestId("privacy-location-note")).toBeTruthy();
    });
  }

  it("Stripe's row names what checkout sends (account id, business type, Terms version)", () => {
    const { container } = renderPage(PrivacyPolicyPage, "en");
    const stripe = tableRows(container, "Service").find((r) => r[0] === "Stripe");
    expect(stripe[3]).toContain("business type and the Terms version you accepted");
  });
});

// ───── B1 / B2 (Manoj, 11 Oct): what the Copilot sends, and what we record ─────

describe("B1: /privacy says what the Copilot sends to Anthropic — never phone numbers or e-mails", () => {
  const SENDS = {
    en: "Your message, the earlier messages in the same conversation (up to 10) and the data from your account that the answer needs are sent to Anthropic's API to generate a reply. That data is your business name and type, figures (for example revenue, expenses, stock, waste, credit (khata) and the cash book), the names of your products, khata customers and staff, staff roles and shifts, the pages you use most and recent insights. We never send the phone numbers or e-mail addresses stored in your account.",
    da: "Din besked, de tidligere beskeder i samme samtale (op til 10) og de data fra din konto, som svaret kræver, sendes til Anthropics API for at generere et svar. Det er din virksomheds navn og type, tal (fx omsætning, udgifter, lager, spild, kredit (khata) og kassebog), navnene på dine varer, khata-kunder og medarbejdere, medarbejdernes roller og vagter, de sider, du bruger mest, og seneste indsigter. Vi sender aldrig de telefonnumre eller e-mailadresser, der er gemt på din konto.",
  };
  for (const lang of ["en", "da"]) {
    it(`${lang}: the Copilot bullet names the data, and no 'never raw customer data' / 'only you can see them'`, () => {
      const { container } = renderPage(PrivacyPolicyPage, lang);
      expect(screen.getByTestId("privacy-copilot-sends").textContent).toBe(SENDS[lang]);
      const text = container.textContent;
      for (const gone of ["never raw customer data", "aldrig rå kundedata", "only you can see them", "kun du kan se det",
        "The one exception", "Den eneste undtagelse", "summary of your business context", "resumé af din virksomheds kontekst"]) {
        expect(text).not.toContain(gone);
      }
    });

    it(`${lang}: the Anthropic processor row says the same — names and figures, never phone numbers or e-mails`, () => {
      const { container } = renderPage(PrivacyPolicyPage, lang);
      const row = tableRows(container, lang === "da" ? "Tjeneste" : "Service").find((r) => r[0] === "Anthropic (Claude API)");
      expect(row[3]).toContain(lang === "da"
        ? "navnene på varer, khata-kunder og medarbejdere, medarbejdernes roller og vagter), aldrig de telefonnumre eller e-mailadresser, der er gemt på din konto"
        : "the names of products, khata customers and staff, staff roles and shifts), never the phone numbers or e-mail addresses stored in your account");
    });

    it(`${lang}: who sees the books in BonBox names the team members and the revisor, and Anthropic for the AI features`, () => {
      const text = renderPage(PrivacyPolicyPage, lang).container.textContent.replace(/\s+/g, " ");
      expect(text).toContain(lang === "da"
        ? "I BonBox ser du det, og det gør de teammedlemmer og den revisor, du giver adgang, også, så langt deres adgang rækker."
        : "In BonBox, you see them, and so do the team members and the revisor you give access to, as far as their access allows.");
      expect(text).toContain(lang === "da"
        ? "For at give dig AI-funktionerne (Copilot, morgenbriefen og aflæsning af kvitteringer) sender vi data til Anthropic"
        : "To give you the AI features (the Copilot, the daily brief and reading receipts) we send data to Anthropic");
    });
  }
});

describe("B2: /privacy records only THAT a Copilot question was asked (true since July) — no review screen", () => {
  for (const lang of ["en", "da"]) {
    it(`${lang}: no 200-character log 'so you can review', no 'so we can improve the AI'`, () => {
      const text = renderPage(PrivacyPolicyPage, lang).container.textContent;
      for (const gone of ["so you can review what was sent", "så du kan se, hvad der blev sendt",
        "(so we can improve the AI)", "(så vi kan forbedre AI'en)", "AI Copilot question logs (first 200 chars)",
        "Log over spørgsmål til AI Copilot (første 200 tegn)"]) {
        expect(text).not.toContain(gone);
      }
      expect(text).toContain(lang === "da"
        ? "Vi registrerer, at du har stillet et spørgsmål, og hvor mange tokens svaret brugte — ikke selve teksten i dit spørgsmål."
        : "We record that you asked a question and how many tokens the reply used — not the text of your question.");
      expect(text).toContain(lang === "da"
        ? "For BonBox AI Copilot: at du har stillet et spørgsmål — ikke selve spørgsmålet"
        : "For the BonBox AI Copilot: that you asked a question — not the question itself");
    });
  }

  it("the code records the event with no text (BonBoxAgent sends null as the detail)", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "components", "BonBoxAgent.jsx"), "utf8");
    expect(src).toContain('trackEvent("ai_question_asked", "agent", null);');
    // Every ai_question_asked event is that exact call: no text, ever.
    expect(src.split('trackEvent("ai_question_asked"').length).toBe(src.split('trackEvent("ai_question_asked", "agent", null);').length);
  });

  it("the retention table: only the fact is recorded; texts saved until mid-July 2026 go after 180 days", () => {
    let rows = Object.fromEntries(tableRows(renderPage(PrivacyPolicyPage, "en").container, "Data type"));
    expect(rows["AI Copilot questions"]).toBe("Only the fact that a question was asked is recorded: 180 days, like other analytics events. Question texts saved until mid-July 2026 (first 200 characters) are deleted 180 days after they were asked");
    cleanup();
    rows = Object.fromEntries(tableRows(renderPage(PrivacyPolicyPage, "da").container, "Datatype"));
    expect(rows["Spørgsmål til AI Copilot"]).toBe("Kun at der blev stillet et spørgsmål, registreres: 180 dage, som andre hændelser til produktanalyse. Spørgsmålstekster, der blev gemt indtil midten af juli 2026 (de første 200 tegn), slettes 180 dage efter, at de blev stillet");
  });
});

describe("should-fixes: who is controller, the date, the insights row", () => {
  it("da + en: controller for the owner's account data; processor for what a business puts in about guests, customers and staff", () => {
    let text = renderPage(PrivacyPolicyPage, "da").container.textContent.replace(/\s+/g, " ");
    expect(text).toContain("Denne virksomhed er dataansvarlig for de oplysninger om dig og din BonBox-konto, der er beskrevet på denne side.");
    expect(text).not.toContain("dataansvarlig for alt");
    expect(screen.getByTestId("privacy-processor-role").textContent.replace(/\s+/g, " ").trim()).toBe(
      "For de oplysninger, en virksomhed lægger ind i BonBox om sine gæster, kunder og medarbejdere (fx reservationer, khata-kunder og medarbejderoplysninger), er det den virksomhed, der er dataansvarlig, og vi behandler oplysningerne på dens vegne som dens databehandler.",
    );
    cleanup();
    text = renderPage(PrivacyPolicyPage, "en").container.textContent.replace(/\s+/g, " ");
    expect(text).toContain("That business is the data controller for the data about you and your BonBox account described on this page.");
    expect(text).not.toContain("for everything described");
    expect(screen.getByTestId("privacy-processor-role").textContent.replace(/\s+/g, " ").trim()).toBe(
      "For the data a business puts into BonBox about its guests, customers and staff (for example reservations, khata customers and staff details), that business is the data controller, and we process the data on its behalf as its data processor.",
    );
  });

  it("the 'Last updated' date is the Terms' date (TERMS_VERSION), in both languages", async () => {
    const { TERMS_VERSION, termsDate } = await import("../legal/terms");
    renderPage(PrivacyPolicyPage, "da");
    expect(screen.getByTestId("privacy-updated").textContent).toBe(`Senest opdateret: ${termsDate(TERMS_VERSION, "da")}`);
    cleanup();
    renderPage(PrivacyPolicyPage, "en");
    expect(screen.getByTestId("privacy-updated").textContent).toBe(`Last updated: ${termsDate(TERMS_VERSION, "en")}`);
  });

  it("insights: kept until the account is deleted (expired ones stay in the archive) — no 'auto-expire 1–30 days'", () => {
    let rows = Object.fromEntries(tableRows(renderPage(PrivacyPolicyPage, "en").container, "Data type"));
    expect(rows["AI insights derived from events"]).toBe("Until you delete your account; expired and dismissed insights stay in your insights archive");
    cleanup();
    rows = Object.fromEntries(tableRows(renderPage(PrivacyPolicyPage, "da").container, "Datatype"));
    expect(rows["AI-indsigter afledt af hændelser"]).toBe("Indtil du sletter din konto; udløbne og fjernede indsigter bliver i dit arkiv over indsigter");
  });
});

// ─────────────── (E) the delete-account texts say what § 4 says ───────────────

const packs = {
  da: (await import("../i18n/da")).da,
  en: (await import("../i18n/en")).en,
  tr: (await import("../i18n/tr")).tr,
  np: (await import("../i18n/np")).np,
  th: (await import("../i18n/th")).th,
  vi: (await import("../i18n/vi")).vi,
};

describe("(E) Profile → Delete account says what Terms § 4 says", () => {
  it("da + en: not 'ALL your data … everything'; names what we keep and points to § 4", () => {
    expect(packs.da.deleteAccountDesc).toBe("Slet din konto og dataene i den. Det kan ikke fortrydes. § 4 i Handelsbetingelserne nævner, hvad vi beholder.");
    expect(packs.en.deleteAccountDesc).toBe("Delete your account and the data in it. This cannot be undone. § 4 of the Terms of Service lists what we keep.");
    expect(packs.da.deleteConfirmWarning).toBe(
      "Dette sletter din konto og dataene i den med det samme: salg, udgifter, lager, rapporter. Vi beholder ændringsloggen, sikkerheds- og fejlloggene og billederne af dine regnskabsbilag (i ca. 6 år) — se § 4 i Handelsbetingelserne. Et aktivt abonnement stopper samtidig. Hent dine data og PDF'er først. Indtast din adgangskode for at bekræfte.",
    );
    expect(packs.en.deleteConfirmWarning).toBe(
      "This deletes your account and the data in it straight away: sales, expenses, inventory, reports. We keep the change log, the security and error logs, and the images of your accounting documents (for about 6 years) — see § 4 of the Terms of Service. An active subscription stops at the same moment. Download your data and PDFs first. Enter your password to confirm.",
    );
  });

  it("every pack that has the keys: no 'all data, permanently, everything' left, and § 4 is named", () => {
    const OLD = /ALLE|ALL your data|everything|alle data|tüm veri|TÜM|her şey|सबै डाटा|ทั้งหมด|ทุกอย่าง|mọi dữ liệu|TẤT CẢ|mọi thứ/;
    for (const [lang, d] of Object.entries(packs)) {
      for (const k of ["deleteAccountDesc", "deleteConfirmWarning"]) {
        expect(typeof d[k], `${lang}.${k}`).toBe("string");
        expect(d[k], `${lang}.${k}`).not.toMatch(OLD);
      }
      expect(d.deleteAccountDesc, lang).toMatch(/§ ?4|ข้อ 4|mục 4/);
      expect(d.deleteConfirmWarning, lang).toMatch(/6|६/); // np writes ६
    }
  });

  it("the page's inline English fallbacks match en (no stale 'ALL your data')", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pages", "ProfilePage.jsx"), "utf8");
    expect(src).toContain(JSON.stringify(packs.en.deleteAccountDesc));
    expect(src).toContain(JSON.stringify(packs.en.deleteConfirmWarning));
    expect(src).not.toContain("ALL your data");
  });
});
