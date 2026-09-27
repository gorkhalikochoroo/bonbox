/**
 * The legal pages follow the app language: Dansk reads Danish.
 *
 * Privacy, Terms and Cookies used to be hardcoded English, so an owner who had
 * switched BonBox to Dansk still got these pages in English. They are also the
 * pages a Danish owner (or their revisor) reads most closely. Each page now
 * holds two whole documents, English and Danish, and picks one from the app
 * language. This test mounts the real pages and checks what renders:
 *
 *   • lang "da" shows the Danish h1 and a Danish section heading, and none of
 *     the English ones; lang "en" shows the reverse.
 *   • The page chrome (back link) switches too.
 *   • The document declares its own language, so a screen reader reads it in
 *     the right language even when <html lang> says something else.
 *   • The two versions stay in step: same number of sections and sub-headings,
 *     same links in the same order. A section added to one language only
 *     fails here instead of shipping as a silently shorter legal text.
 */
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import PrivacyPolicyPage from "../pages/PrivacyPolicyPage";
import TermsPage from "../pages/TermsPage";
import CookiePolicyPage from "../pages/CookiePolicyPage";
import { LanguageProvider } from "../hooks/useLanguage";

const PAGES = [
  {
    name: "PrivacyPolicyPage",
    Page: PrivacyPolicyPage,
    da: { h1: "Privatlivspolitik", h2: "Dine rettigheder efter databeskyttelsesforordningen" },
    en: { h1: "Privacy Policy", h2: "Your rights under GDPR" },
  },
  {
    name: "TermsPage",
    Page: TermsPage,
    da: { h1: "Servicevilkår", h2: "11. Ansvarsbegrænsning" },
    en: { h1: "Terms of Service", h2: "11. Limitation of liability" },
  },
  {
    name: "CookiePolicyPage",
    Page: CookiePolicyPage,
    da: { h1: "Cookiepolitik", h2: "Cookies, vi bruger" },
    en: { h1: "Cookie Policy", h2: "Cookies we use" },
  },
];

const BACK = { da: "Tilbage til BonBox", en: "Back to BonBox" };

const renderAt = (Page, lang) => {
  localStorage.setItem("lang", lang);
  return render(
    <LanguageProvider>
      <MemoryRouter>
        <Page />
      </MemoryRouter>
    </LanguageProvider>,
  );
};

describe.each(PAGES)("$name", ({ Page, da, en }) => {
  beforeEach(() => {
    localStorage.clear();
  });

  it.each([
    ["da", da, en],
    ["en", en, da],
  ])("lang=%s renders that language's document", (lang, want, other) => {
    const { container } = renderAt(Page, lang);

    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(want.h1);
    expect(screen.getByRole("heading", { level: 2, name: want.h2 })).toBeInTheDocument();

    expect(screen.queryByRole("heading", { level: 1, name: other.h1 })).toBeNull();
    expect(screen.queryByRole("heading", { level: 2, name: other.h2 })).toBeNull();

    expect(screen.getByRole("link", { name: new RegExp(BACK[lang]) })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: new RegExp(BACK[lang === "da" ? "en" : "da"]) })).toBeNull();

    expect(container.firstChild.getAttribute("lang")).toBe(lang);
  });

  it("the Danish and English documents have the same sections and links", () => {
    const shape = (lang) => {
      const { container, unmount } = renderAt(Page, lang);
      const result = {
        h2: container.querySelectorAll("h2").length,
        h3: container.querySelectorAll("h3").length,
        hrefs: [...container.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")),
      };
      unmount();
      localStorage.clear();
      return result;
    };
    const daShape = shape("da");
    expect(daShape.h2).toBeGreaterThan(0);
    expect(daShape).toEqual(shape("en"));
  });
});
