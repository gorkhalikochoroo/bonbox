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
 *   (C) The iPhone app (App Store 3.1.1 / 3.1.3) renders /terms too: its
 *       § 8 carries no link and no instruction to buy or manage outside the
 *       app, and the web text says "when you use BonBox in a browser" where
 *       it names the Plan & Billing page (the iPhone app's page has no
 *       prices, portal or card update).
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

let nativeFlag = false;
vi.mock("../utils/platform", () => ({
  isNativeApp: () => nativeFlag,
  canPurchaseInApp: () => !nativeFlag,
  isIPad: () => false,
  platform: { isNative: false, isIOS: false, isAndroid: false, isWeb: true },
}));

const TermsPage = (await import("../pages/TermsPage")).default;

afterEach(() => {
  cleanup();
  langCode = "da";
  nativeFlag = false;
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

// ─────────────────────── (C) the iPhone app's /terms ───────────────────────

const section = (n) => {
  const h = screen.getAllByRole("heading", { level: 2 }).find((x) => x.textContent.startsWith(`${n}.`));
  return h.closest("section");
};
const textOutside8 = () =>
  screen.getAllByRole("heading", { level: 2 })
    .filter((h) => !h.textContent.startsWith("8."))
    .map((h) => h.closest("section").textContent)
    .join("\n");

describe("(C) § 8 in the iPhone app: no link, address or instruction to buy or manage outside the app", () => {
  for (const lang of ["da", "en"]) {
    it(`${lang}: § 8 has no link at all, and says 'outside the app' instead`, () => {
      nativeFlag = true;
      renderTerms(lang);
      const s8 = section(8);
      expect(s8.querySelectorAll("a")).toHaveLength(0);
      const text = s8.textContent;
      for (const cta of ["skriv til", "write to", "contact@bonbox.dk", "bonbox.dk under", "i en browser", "in a browser",
        "Administrer abonnement", "Manage subscription"]) {
        expect(text).not.toContain(cta);
      }
      if (lang === "da") {
        expect(text).toContain("Abonnementer administreres uden for appen.");
        expect(text).toContain("Et skift mellem Starter og Pro foretager vi for dig efter anmodning pr. e-mail.");
        expect(text).toContain("Du kan opsige abonnementet når som helst. Det sker uden for appen, i Stripes kundeportal.");
        expect(text).toContain("Imens kan du opdatere dit kort uden for appen, i Stripes kundeportal.");
        expect(text).toContain("Vi opkræver aldrig betaling med tilbagevirkende kraft.");
      } else {
        expect(text).toContain("Subscriptions are managed outside the app.");
        expect(text).toContain("We switch a subscription between Starter and Pro for you on request by e-mail.");
        expect(text).toContain("You can cancel at any time. This is done outside the app, in Stripe’s customer portal.");
        expect(text).toContain("Meanwhile you can update your card outside the app, in Stripe’s customer portal.");
        expect(text).toContain("We never charge retroactively.");
      }
    });

    it(`${lang}: every other section reads exactly as on the web`, () => {
      renderTerms(lang);
      const web = textOutside8();
      cleanup();
      nativeFlag = true;
      renderTerms(lang);
      expect(textOutside8()).toBe(web);
    });
  }

  it("the whole native page links nowhere near a purchase (no /#pricing, no /subscription)", () => {
    for (const lang of ["da", "en"]) {
      nativeFlag = true;
      const { container } = renderTerms(lang);
      const hrefs = [...container.querySelectorAll("a")].map((a) => a.getAttribute("href"));
      expect(hrefs.some((h) => /pricing|subscription|checkout|stripe/i.test(h))).toBe(false);
      cleanup();
    }
  });
});

describe("(C) § 8 on the web names where the page works: in a browser", () => {
  it("da", () => {
    renderTerms("da");
    const text = section(8).textContent;
    expect(text).toContain("Priserne står på bonbox.dk under Priser og på siden Abonnement & betaling, når du bruger BonBox i en browser.");
    expect(text).toContain("Du kan opsige abonnementet når som helst, når du bruger BonBox i en browser: på siden Abonnement & betaling vælger du Administrer abonnement, som åbner Stripes kundeportal.");
    expect(text).toContain("Imens kan du, når du bruger BonBox i en browser, se på siden Abonnement & betaling, at betalingen er fejlet, og opdatere dit kort der.");
    expect(text).not.toContain("i appen");
  });

  it("en", () => {
    renderTerms("en");
    const text = section(8).textContent;
    expect(text).toContain("The prices are shown on bonbox.dk under Pricing and on the Plan & Billing page when you use BonBox in a browser.");
    expect(text).toContain("You can cancel at any time when you use BonBox in a browser: on the Plan & Billing page, choose Manage subscription, which opens Stripe’s customer portal.");
    expect(text).toContain("Meanwhile, when you use BonBox in a browser, the Plan & Billing page shows that the payment failed, and you can update your card there.");
    expect(text).not.toContain("in the app");
  });
});
