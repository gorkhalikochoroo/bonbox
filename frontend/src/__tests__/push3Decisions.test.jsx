/**
 * Push 3 — Manoj's decisions of 11 Oct 2026, held to the code.
 *
 *   (1) Terms § 8 keeps "Vi opkræver aldrig betaling med tilbagevirkende
 *       kraft." / "We never charge retroactively." — and the in-app notice
 *       no longer says that promise is replaced (it keeps the caps sentence).
 *   (2) Plan switching: § 8 says "Vil du skifte mellem Starter og Pro, så
 *       skriv til contact@bonbox.dk — så skifter vi planen for dig." The
 *       Stripe portal has plan switching OFF, so nothing in the app may
 *       promise a self-serve switch.
 */
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

let langCode = "da";
const dict = () => (langCode === "da" ? da : en);
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: langCode,
    setLang: () => {},
    LANGUAGES: [],
    t: (k, fb, vars) => {
      const v = typeof fb === "object" && fb ? fb : vars;
      let s = dict()[k] ?? en[k] ?? (typeof fb === "string" ? fb : k);
      if (v && typeof s === "string") s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
      return s;
    },
  }),
  LanguageProvider: ({ children }) => children,
  detectInitialLanguage: () => "da",
}));

const TermsPage = (await import("../pages/TermsPage")).default;

afterEach(() => {
  cleanup();
  langCode = "da";
});

const renderTerms = (lang) => {
  langCode = lang;
  return render(<MemoryRouter><TermsPage /></MemoryRouter>);
};

describe("decision 1: the no-retroactive-charge promise stays in § 8", () => {
  it("da: § 8 says it, word for word", () => {
    const text = renderTerms("da").container.textContent;
    expect(text).toContain("Vi opkræver aldrig betaling med tilbagevirkende kraft.");
  });

  it("en: § 8 says it, word for word", () => {
    const text = renderTerms("en").container.textContent;
    expect(text).toContain("We never charge retroactively.");
  });

  it("the notice keeps the caps sentence and no longer says the promise is replaced", () => {
    expect(da.termsNoticeChangeCaps).toBe(
      "Alle planer, også Free, har forbrugslofter, og vi kan ændre, begrænse eller fjerne funktioner og forbrugslofter med rimeligt varsel. Det erstatter løftet i de tidligere betingelser om, at den eksisterende gratis funktionalitet forbliver tilgængelig.",
    );
    expect(en.termsNoticeChangeCaps).toBe(
      "Every plan, Free included, has usage caps, and we may change, limit or remove features and usage caps with reasonable notice. This replaces the promise in the earlier terms that existing free functionality stays available.",
    );
  });
});

describe("decision 2: § 8 says how to switch between Starter and Pro", () => {
  it("da: Manoj's sentence, with the address as an e-mail link", () => {
    renderTerms("da");
    const p = screen.getByTestId("terms-plan-switch");
    expect(p.textContent).toBe(
      "Skift af plan. Vil du skifte mellem Starter og Pro, så skriv til contact@bonbox.dk — så skifter vi planen for dig.",
    );
    expect(within(p).getByRole("link").getAttribute("href")).toBe("mailto:contact@bonbox.dk");
  });

  it("en: the same sentence in English", () => {
    renderTerms("en");
    const p = screen.getByTestId("terms-plan-switch");
    expect(p.textContent).toBe(
      "Switching plans. If you want to switch between Starter and Pro, write to contact@bonbox.dk — we will switch the plan for you.",
    );
    expect(within(p).getByRole("link").getAttribute("href")).toBe("mailto:contact@bonbox.dk");
  });

  it("nothing in the Terms promises a self-serve switch in the portal", () => {
    for (const lang of ["da", "en"]) {
      const text = renderTerms(lang).container.textContent;
      expect(text).not.toMatch(/skifte plan i (kunde)?portalen|switch plans? in the (customer )?portal/i);
      cleanup();
    }
  });
});
