/**
 * R-h fix round: /privacy "Product analytics events" says what the H-7 gate
 * does, in the same deploy as the gate.
 *
 * Since H-7 (C1) the events a browser sends are recorded only after a "yes"
 * to Analytics in the cookie banner. The notice used to name legitimate
 * interest as the only basis for the same events — two lawful bases for one
 * set of events (banner and /cookies vs /privacy, GDPR Art. 13(1)(c)). Now:
 *   • the R-j (b) sentence: browser-sent events only after Analytics is on;
 *   • the basis line splits them: browser-sent events on consent
 *     (Art. 6(1)(a)), the records the server writes itself on legitimate
 *     interest (Art. 6(1)(f)). Final wording: the attorney (R-j).
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

afterEach(() => {
  cleanup();
  langCode = "da";
});

const show = (lang) => {
  langCode = lang;
  render(<MemoryRouter><PrivacyPolicyPage /></MemoryRouter>);
};

const TEXT = {
  en: {
    consent: "The events your browser sends (pages you visit and actions you take) are recorded only after you turn on Analytics in the cookie banner.",
    browserBasis: "For the events your browser sends: consent (GDPR Article 6(1)(a))",
    serverBasis: "legitimate interest (GDPR Article 6(1)(f))",
    withdraw: "can withdraw at any time under “Cookie settings”",
    oldBasis: "Legal basis: Legitimate interest (GDPR Article 6(1)(f)) — improving BonBox",
  },
  da: {
    consent: "De hændelser, din browser sender (hvilke sider du besøger, og hvilke handlinger du foretager), registreres først, når du har slået Analyse til i cookiebanneret.",
    browserBasis: "For de hændelser, din browser sender: samtykke (databeskyttelsesforordningens artikel 6, stk. 1, litra a)",
    serverBasis: "legitim interesse (databeskyttelsesforordningens artikel 6, stk. 1, litra f)",
    withdraw: "til enhver tid kan trække tilbage under „Cookieindstillinger“",
    oldBasis: "Retsgrundlag: Legitim interesse (databeskyttelsesforordningens artikel 6, stk. 1, litra f) — at forbedre BonBox",
  },
};

describe.each(["en", "da"])("/privacy product analytics in %s matches the consent gate (R-h fix round)", (lang) => {
  it("says the events the browser sends are recorded only after Analytics is turned on", () => {
    show(lang);
    expect(screen.getByTestId("privacy-analytics-consent").textContent).toBe(TEXT[lang].consent);
  });
  it("gives consent as the basis for browser-sent events and legitimate interest only for what the server writes", () => {
    show(lang);
    const basis = screen.getByTestId("privacy-analytics-basis").textContent;
    expect(basis).toContain(TEXT[lang].browserBasis);
    expect(basis).toContain(TEXT[lang].withdraw);
    expect(basis).toContain(TEXT[lang].serverBasis);
    expect(basis.indexOf(TEXT[lang].browserBasis)).toBeLessThan(basis.indexOf(TEXT[lang].serverBasis));
    expect(document.body.textContent).not.toContain(TEXT[lang].oldBasis);
  });
  it("the withdrawal route it names exists on the page", () => {
    show(lang);
    expect(screen.getByRole("button", { name: lang === "da" ? "Cookieindstillinger" : "Cookie settings" })).toBeTruthy();
  });
});
