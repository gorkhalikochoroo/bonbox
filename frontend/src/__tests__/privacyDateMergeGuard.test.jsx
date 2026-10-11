/**
 * Merge guard for /privacy (fix round, 11 Oct 2026).
 *
 * This bundle (backup + R-i + R-h + R-sec) and release-brand both change
 * PrivacyPolicyPage.jsx, and a trial merge (git merge-tree b41657fc push4)
 * conflicts in its import block:
 *   • release-brand adds `import BonBoxMark` (the nav renders <BonBoxMark/>)
 *     and keeps the date on TERMS_VERSION;
 *   • this bundle moves the date to PRIVACY_UPDATED.
 * Both sides must survive. Two one-sided resolutions would build and still
 * pass the date test in push3Privacy.test.jsx today:
 *   • brand's side only: the page shows TERMS_VERSION, and while the two
 *     constants hold the same day the date line cannot tell them apart;
 *   • this side only: <BonBoxMark/> has no import and /privacy throws a
 *     ReferenceError at render (push3Privacy's render tests and the
 *     pre-commit no-undef guard catch this one).
 * This file pins the first: with PRIVACY_UPDATED set to a day no other
 * constant holds, the page must print that day, in both languages.
 *
 * /cookies too (combined-release fix round): its analytics text changes in
 * the same release as /privacy's, and its date was a hard-coded "8 October
 * 2026" that no release step would ever move. It now prints PRIVACY_UPDATED.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const DISTINCT_DAY = "2099-01-02";

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
vi.mock("../legal/terms", async (importOriginal) => ({
  ...(await importOriginal()),
  PRIVACY_UPDATED: "2099-01-02",
}));

const PrivacyPolicyPage = (await import("../pages/PrivacyPolicyPage")).default;
const CookiePolicyPage = (await import("../pages/CookiePolicyPage")).default;

afterEach(() => {
  cleanup();
  langCode = "da";
});

const renderPage = (lang) => {
  langCode = lang;
  return render(<MemoryRouter><PrivacyPolicyPage /></MemoryRouter>);
};

describe("/privacy prints its own date, PRIVACY_UPDATED", () => {
  it("the mocked day is one no other legal constant holds", async () => {
    const real = await vi.importActual("../legal/terms");
    expect([real.TERMS_VERSION, real.TERMS_EXISTING_FROM, real.PRIVACY_UPDATED]).not.toContain(DISTINCT_DAY);
  });

  it("Danish", () => {
    renderPage("da");
    expect(screen.getByTestId("privacy-updated").textContent).toBe("Senest opdateret: 2. januar 2099");
  });

  it("English", () => {
    renderPage("en");
    expect(screen.getByTestId("privacy-updated").textContent).toBe("Last updated: 2 January 2099");
  });
});

describe("/cookies prints the same date, PRIVACY_UPDATED", () => {
  const renderCookies = (lang) => {
    langCode = lang;
    return render(<MemoryRouter><CookiePolicyPage /></MemoryRouter>);
  };

  it("Danish", () => {
    renderCookies("da");
    expect(screen.getByTestId("cookies-updated").textContent).toBe("Senest opdateret: 2. januar 2099");
  });

  it("English", () => {
    renderCookies("en");
    expect(screen.getByTestId("cookies-updated").textContent).toBe("Last updated: 2 January 2099");
  });
});

describe("the PRIVACY_UPDATED comment says what the constant dates and when to set it", () => {
  it("names both pages, says both print it, and says to set it to the deploy day", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = (...p) => fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", ...p), "utf8");
    const terms = src("legal", "terms.js");
    const end = terms.indexOf("export const PRIVACY_UPDATED");
    const comment = terms.slice(terms.lastIndexOf("/*", end), end);
    expect(comment).toContain("BOTH /privacy AND /cookies");
    expect(comment).toContain("SET IT TO THE DEPLOY DAY");
    expect(comment).toMatch(/it dates\s+both pages at once/);
    // …and the fact the comment states: both pages print the constant.
    for (const page of ["PrivacyPolicyPage.jsx", "CookiePolicyPage.jsx"]) {
      expect(src("pages", page)).toMatch(/termsDate\(PRIVACY_UPDATED, "da"\)/);
      expect(src("pages", page)).toMatch(/termsDate\(PRIVACY_UPDATED, "en"\)/);
    }
  });
});
