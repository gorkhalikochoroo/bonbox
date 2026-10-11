/**
 * Push 3 — Manoj's decisions of 11 Oct 2026, held to the code.
 *
 *   (1) Terms § 8 keeps "Vi opkræver aldrig betaling med tilbagevirkende
 *       kraft." / "We never charge retroactively." — and the in-app notice
 *       no longer says that promise is replaced (it keeps the caps sentence).
 *   (2) Plan switching: § 8 says "Vil du skifte mellem Starter og Pro, så
 *       skriv til contact@bonbox.dk — så skifter vi planen for dig." The
 *       Stripe portal has plan switching OFF, so nothing in the app may
 *       promise a self-serve switch. Round 2: "Skiftet gælder fra den dag,
 *       vi skifter. Prisforskellen for resten af perioden lægges på næste
 *       betaling eller fratrækkes." (Stripe's default proration when the
 *       plan is switched in the Dashboard.)
 *   (C) The iPhone app (App Store 3.1.1 / 3.1.3) renders /terms too: its
 *       § 8 carries no link and no instruction to buy or manage outside the
 *       app, and the web text says "when you use BonBox in a browser" where
 *       it names the Plan & Billing page (the iPhone app's page has no
 *       prices, portal or card update).
 */
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
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

const post = vi.fn();
const get = vi.fn();
vi.mock("../services/api", () => ({
  default: {
    post: (...a) => post(...a),
    get: (...a) => get(...a),
    put: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));
let authState = { user: null };
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }) => children,
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ refresh: vi.fn(), isReady: true, hasFeature: () => false }),
}));
vi.mock("../hooks/useFounderRateStatus", () => ({
  default: () => ({ status: { max_slots: 100, available: 100, claimed: 0 }, valid: true }),
}));
vi.mock("../hooks/useEventLog", () => ({ trackEvent: () => {} }));

const TermsPage = (await import("../pages/TermsPage")).default;
const SubscriptionPage = (await import("../pages/SubscriptionPage")).default;

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
      "Skift af plan. Vil du skifte mellem Starter og Pro, så skriv til contact@bonbox.dk — så skifter vi planen for dig. Skiftet gælder fra den dag, vi skifter. Prisforskellen for resten af perioden lægges på næste betaling eller fratrækkes.",
    );
    expect(within(p).getByRole("link").getAttribute("href")).toBe("mailto:contact@bonbox.dk");
  });

  it("en: the same sentence in English", () => {
    renderTerms("en");
    const p = screen.getByTestId("terms-plan-switch");
    expect(p.textContent).toBe(
      "Switching plans. If you want to switch between Starter and Pro, write to contact@bonbox.dk — we will switch the plan for you. The switch applies from the day we make it. The price difference for the rest of the period is added to your next payment or deducted from it.",
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
      // App Review 3.1.1: the app names no price — not even in the Terms.
      expect(text).not.toMatch(/\b(129|249|199|349)\b|\d+\s?kr\./);
      expect(screen.getByTestId("terms-founding-price").textContent).toBe(lang === "da"
        ? "Stifterpris. Så længe færre end 100 virksomheder har et betalt abonnement hos os, får nye abonnementer stifterprisen. Du beholder stifterprisen, så længe dit abonnement er aktivt uden afbrydelse. Opsiger du abonnementet, eller ophører det, fordi en betaling ikke går igennem, mister du stifterprisen, og et nyt abonnement senere koster den pris, der gælder på det tidspunkt."
        : "Founding price. While fewer than 100 businesses have a paid subscription with us, new subscriptions get the founding price. You keep the founding price as long as your subscription stays active without a break. If you cancel the subscription, or it ends because a payment does not go through, the founding price is lost, and a new subscription later costs the price that applies at that time.");
      if (lang === "da") {
        expect(text).toContain("Abonnementer administreres uden for appen.");
        expect(screen.getByTestId("terms-plan-switch").textContent).toBe(
          "Skift af plan. Et skift mellem Starter og Pro foretager vi for dig uden for appen. Skiftet gælder fra den dag, vi skifter. Prisforskellen for resten af perioden lægges på næste betaling eller fratrækkes.",
        );
        expect(text).toContain("Du kan opsige abonnementet når som helst. Det sker uden for appen, i Stripes kundeportal.");
        expect(text).toContain("Imens kan du opdatere dit kort uden for appen, i Stripes kundeportal.");
        expect(text).toContain("Vi opkræver aldrig betaling med tilbagevirkende kraft.");
      } else {
        expect(text).toContain("Subscriptions are managed outside the app.");
        expect(screen.getByTestId("terms-plan-switch").textContent).toBe(
          "Switching plans. We switch a subscription between Starter and Pro for you, outside the app. The switch applies from the day we make it. The price difference for the rest of the period is added to your next payment or deducted from it.",
        );
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

describe("Switch (Manoj, 11 Oct round 2): from when a switch applies and what happens to the price", () => {
  it("web § 8 still names the prices (the iPhone app does not)", () => {
    for (const lang of ["da", "en"]) {
      renderTerms(lang);
      expect(screen.getByTestId("terms-founding-price").textContent).toContain(lang === "da"
        ? "stifterprisen: Starter 129 kr. og Pro 249 kr. pr. måned (normalpris: Starter 199 kr. og Pro 349 kr.)."
        : "the founding price: Starter 129 kr. and Pro 249 kr. per month (regular price: Starter 199 kr. and Pro 349 kr.).");
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

// ─────────────── (B) plan switching on the subscription page ───────────────

describe("(B) a paying subscriber's other plan shows the e-mail line, never a checkout", () => {
  const paying = (plan, status = "active") => ({
    plan, trial_active: false, is_paid: true, subscription_status: status,
    stripe_configured: true, checkout_ready: { starter: true, pro: true, any: true },
  });
  const renderSub = (billing, lang = "da") => {
    langCode = lang;
    authState = { user: { id: "u1", email: "cafe@cafe.dk", business_type: "cafe" }, refreshUser: vi.fn() };
    post.mockReset();
    post.mockImplementation(() => Promise.resolve({ data: {} }));
    get.mockReset();
    get.mockImplementation((url) =>
      Promise.resolve({ data: url === "/billing/me" ? billing : url === "/waitlist/status" ? [] : {} }));
    return render(<MemoryRouter initialEntries={["/subscription"]}><SubscriptionPage /></MemoryRouter>);
  };

  it("paying Starter: the Pro card says Manoj's sentence with a mailto, and no checkout line or button", async () => {
    renderSub(paying("starter"));
    const line = await screen.findByTestId("plan-switch-by-email");
    expect(line.textContent).toBe(
      "Vil du skifte mellem Starter og Pro, så skriv til contact@bonbox.dk — så skifter vi planen for dig.",
    );
    expect(within(line).getByRole("link").getAttribute("href")).toBe("mailto:contact@bonbox.dk");
    expect(screen.getAllByTestId("plan-switch-by-email")).toHaveLength(1);
    expect(screen.queryByTestId("checkout-terms-line")).toBeNull();
    expect(screen.queryByTestId("checkout-terms-line-trial")).toBeNull();
    // The line sits in the Pro card, where the Pro button used to be.
    const card = line.closest(".relative");
    expect(card.textContent).toContain("Pro");
    expect(within(card).queryByRole("button")).toBeNull();
    // Nothing on the page started a checkout.
    expect(post).not.toHaveBeenCalledWith("/billing/stripe/checkout-session", expect.anything());
  });

  it("paying Pro: the Starter card gets the line", async () => {
    renderSub(paying("pro"));
    const line = await screen.findByTestId("plan-switch-by-email");
    const card = line.closest(".relative");
    expect(card.textContent).toContain("Starter");
    expect(screen.queryByTestId("checkout-terms-line")).toBeNull();
  });

  for (const status of ["trialing", "past_due"]) {
    it(`a ${status} subscription is a paying subscriber too`, async () => {
      renderSub(paying("starter", status));
      expect(await screen.findByTestId("plan-switch-by-email")).toBeTruthy();
      expect(screen.queryByTestId("checkout-terms-line")).toBeNull();
    });
  }

  it("English", async () => {
    renderSub(paying("starter"), "en");
    const line = await screen.findByTestId("plan-switch-by-email");
    expect(line.textContent).toBe(
      "If you want to switch between Starter and Pro, write to contact@bonbox.dk — we will switch the plan for you.",
    );
  });

  it("no subscription yet (trial): no e-mail line; both paid cards open a checkout with the Terms line", async () => {
    renderSub({ ...paying("trial", null), is_paid: false });
    expect(await screen.findAllByTestId("checkout-terms-line")).toHaveLength(2);
    expect(screen.queryByTestId("plan-switch-by-email")).toBeNull();
  });

  it("the Terms § 8 sentence and the app's line are the same sentence (da + en)", () => {
    const fill = (s) => s.replace("{email}", "contact@bonbox.dk");
    for (const lang of ["da", "en"]) {
      const text = renderTerms(lang).container.textContent;
      expect(text).toContain(fill(lang === "da" ? da.planSwitchByEmail : en.planSwitchByEmail));
      cleanup();
    }
  });
});

describe("(B/C) the iPhone app's plan page shows none of it", () => {
  it("native: read-only plan, no switch line, no checkout line, no mailto, no price", async () => {
    window.Capacitor = { isNativePlatform: () => true };
    try {
      vi.resetModules();
      const NativeSub = (await import("../pages/SubscriptionPage")).default;
      langCode = "da";
      authState = { user: { id: "u2", email: "cafe@cafe.dk", business_type: "cafe" }, refreshUser: vi.fn() };
      get.mockReset();
      get.mockImplementation((url) => Promise.resolve({
        data: url === "/billing/me"
          ? { plan: "starter", subscription_status: "active", is_paid: true, stripe_configured: true,
            checkout_ready: { starter: true, pro: true, any: true } }
          : url === "/waitlist/status" ? [] : {},
      }));
      const { container } = render(<MemoryRouter initialEntries={["/subscription"]}><NativeSub /></MemoryRouter>);
      await waitFor(() => expect(get).toHaveBeenCalledWith("/billing/me"));
      await screen.findByText("Starter");
      expect(screen.getByText(da.planNativeStatusNote)).toBeTruthy();
      expect(screen.queryByTestId("plan-switch-by-email")).toBeNull();
      expect(screen.queryByTestId("checkout-terms-line")).toBeNull();
      expect(container.querySelectorAll("a")).toHaveLength(0);
      expect(container.textContent).not.toMatch(/kr|DKK|contact@bonbox\.dk|bonbox\.dk/);
    } finally {
      delete window.Capacitor;
      vi.resetModules();
    }
  });
});

// ─────────────── B3 (Manoj, 11 Oct round 2): monthly only ───────────────

describe("B3: the buying page is monthly only — no Annual toggle, no '-20%', no 'Årlig sparer 20%'", () => {
  const trial = {
    plan: "trial", trial_active: true, is_paid: false, subscription_status: null,
    stripe_configured: true, checkout_ready: { starter: true, pro: true, any: true },
  };
  const renderSub = (lang) => {
    langCode = lang;
    authState = { user: { id: "u3", email: "cafe@cafe.dk", business_type: "cafe" }, refreshUser: vi.fn() };
    get.mockReset();
    get.mockImplementation((url) =>
      Promise.resolve({ data: url === "/billing/me" ? trial : url === "/waitlist/status" ? [] : {} }));
    return render(<MemoryRouter initialEntries={["/subscription"]}><SubscriptionPage /></MemoryRouter>);
  };

  for (const lang of ["da", "en"]) {
    it(`${lang}: no billing-period toggle and no annual offer; the regular prices are the monthly 199 / 349`, async () => {
      const { container } = renderSub(lang);
      await screen.findAllByTestId("checkout-terms-line");
      const text = container.textContent;
      for (const gone of ["-20%", "20%", "Årlig", "Annual", "faktureres årligt", "billed annually", "Månedlig", "Monthly"]) {
        expect(text).not.toContain(gone);
      }
      expect(screen.queryByRole("button", { name: /Årlig|Annual|Månedlig|Monthly/ })).toBeNull();
      // The struck-through regular price is the monthly one (never 159 / 279).
      const struck = [...container.querySelectorAll(".line-through")].map((n) => n.textContent);
      expect(struck.some((s) => s.startsWith("199"))).toBe(true);
      expect(struck.some((s) => s.startsWith("349"))).toBe(true);
      expect(text).not.toMatch(/\b(159|279)\b/);
      expect(screen.getByText(lang === "da" ? "Hvad du får på hver plan." : "What you get on each tier.")).toBeTruthy();
    });
  }

  it("the source and every language pack: no annual price, no toggle keys, no '20%' in the subtitle", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "pages", "SubscriptionPage.jsx"), "utf8");
    for (const gone of ["price_annual", "setAnnual", "pricingAnnual", "pricingBilledAnnually", "Annual saves"]) {
      expect(src).not.toContain(gone);
    }
    // The pill was a JSX text node of its own: "-20%" on a line.
    expect(src).not.toMatch(/^\s*-20%\s*$/m);
    const packs = {
      da, en,
      tr: (await import("../i18n/tr")).tr,
      np: (await import("../i18n/np")).np,
      th: (await import("../i18n/th")).th,
      vi: (await import("../i18n/vi")).vi,
    };
    for (const [lang, d] of Object.entries(packs)) {
      for (const k of ["pricingMonthly", "pricingAnnual", "pricingBilledAnnually"]) expect(d[k], `${lang}.${k}`).toBeUndefined();
      if (d.pricingComparePlansSubtitle) expect(d.pricingComparePlansSubtitle, lang).not.toMatch(/20|२०/);
    }
    expect(da.pricingComparePlansSubtitle).toBe("Hvad du får på hver plan.");
    expect(en.pricingComparePlansSubtitle).toBe("What you get on each tier.");
  });
});
