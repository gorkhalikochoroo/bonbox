/**
 * Nightly backup (Manoj, 11 Oct 2026): /privacy names the separate Supabase
 * project the nightly job copies the database and the uploaded files to —
 * where it is (Frankfurt, eu-central-1) and that the copy is encrypted
 * before it leaves BonBox — in EN and DA, right after the main Supabase row.
 *
 * Frankfurt move (Landing v6 + Frankfurt release): the main row is the
 * Frankfurt project now; while the old project's fallback copy exists
 * (IRELAND_COPY_ROW in legal/terms.js) a third Supabase row follows the
 * backup row. frankfurtEverywhere.test.js holds that row's text and both
 * states of the constant.
 *
 * The backend sibling (backend/tests/test_nightly_backup.py,
 * test_privacy_names_the_encrypted_backup_copy) ties the same rows to the
 * code: the backup does not run without its encryption key.
 */
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IRELAND_COPY_ROW } from "../legal/terms";

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

afterEach(() => {
  cleanup();
  langCode = "da";
});

const processorRows = (lang) => {
  langCode = lang;
  const { container } = render(<MemoryRouter><PrivacyPolicyPage /></MemoryRouter>);
  const header = lang === "da" ? "Tjeneste" : "Service";
  const table = [...container.querySelectorAll("table")].find((t) => t.querySelector("th")?.textContent === header);
  return [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
};

const ROWS = {
  en: {
    main: ["Supabase", "Database (PostgreSQL) and file storage", "EU (Frankfurt, Germany)", "All account and business data, and the files you upload"],
    backup: ["Supabase", "Encrypted backup copy (database + the files you upload)", "EU (Germany, Frankfurt)", "All account and business data and the files you upload, encrypted before they leave BonBox"],
  },
  da: {
    main: ["Supabase", "Database (PostgreSQL) og fillagring", "EU (Frankfurt, Tyskland)", "Alle konto- og virksomhedsdata og de filer, du uploader"],
    backup: ["Supabase", "Krypteret sikkerhedskopi (database + de filer, du uploader)", "EU (Tyskland, Frankfurt)", "Alle konto- og virksomhedsdata og de filer, du uploader, krypteret før de forlader BonBox"],
  },
};

describe("/privacy: the encrypted backup copy is a processor row of its own", () => {
  for (const lang of ["en", "da"]) {
    it(`${lang}: the main Supabase row, then the backup row, word for word`, () => {
      const rows = processorRows(lang);
      const i = rows.findIndex((r) => r[0] === "Supabase");
      expect(rows[i]).toEqual(ROWS[lang].main);
      expect(rows[i + 1]).toEqual(ROWS[lang].backup);
      // main + backup, + the old project's fallback copy while it exists
      expect(rows.filter((r) => r[0] === "Supabase")).toHaveLength(IRELAND_COPY_ROW ? 3 : 2);
    });
  }

  it("en and da have the same number of processor rows, Supabase's rows at the same places", () => {
    const en = processorRows("en").map((r) => r[0]);
    cleanup();
    const da = processorRows("da").map((r) => r[0]);
    expect(da).toHaveLength(en.length);
    const at = (names) => names.flatMap((n, i) => (n === "Supabase" ? [i] : []));
    expect(at(da)).toEqual(at(en));
  });
});
