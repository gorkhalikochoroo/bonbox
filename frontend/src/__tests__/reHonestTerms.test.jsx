/**
 * Release R-e — honest Terms and checkout (P0-1, LEG-11/PQ-03, LEG-12, PQ-14).
 *
 *   • /terms (da + en): the provider is "DukaanAI v/Manoz Chaudhary, CVR
 *     46417321"; no "free of charge" service claim, no "90 seconds"; §8 is
 *     "Abonnement og betaling" / "Subscription and payment" with Manoj's four
 *     decisions (B2B only; cancel at period end, no part refunds; founding
 *     price kept while the subscription stays active; 30 days' price notice);
 *     the date is TERMS_VERSION from src/legal/terms.js.
 *   • /register shows "Ved at oprette en konto accepterer du vores
 *     Handelsbetingelser og Privatlivspolitik." ONCE, linked, and the
 *     register request carries accept_terms: true.
 *   • A personal (Privatøkonomi) account cannot start a paid checkout: the
 *     Starter/Pro buttons say "Kun for virksomheder", are disabled, and no
 *     checkout request is sent.
 *   • No "for life" founding-price claim in any language pack or inline
 *     fallback (decision 3).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const post = vi.fn();
const get = vi.fn();
vi.mock("../services/api", () => ({
  default: {
    post: (...a) => post(...a),
    get: (...a) => get(...a),
    put: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));

let authState;
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }) => children,
}));
vi.mock("@react-oauth/google", () => ({
  GoogleLogin: () => null,
  GoogleOAuthProvider: ({ children }) => children,
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ refresh: vi.fn(), isReady: true, hasFeature: () => false }),
}));
vi.mock("../hooks/useFounderRateStatus", () => ({
  default: () => ({ status: { max_slots: 100, available: 100, claimed: 0 }, valid: true }),
}));
vi.mock("../hooks/useEventLog", () => ({ trackEvent: () => {} }));

const { TERMS_VERSION, termsDate, withTermsAcceptance } = await import("../legal/terms");
const TermsPage = (await import("../pages/TermsPage")).default;
const RegisterPage = (await import("../pages/RegisterPage")).default;
const SubscriptionPage = (await import("../pages/SubscriptionPage")).default;

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  get.mockImplementation(() => Promise.resolve({ data: {} }));
  langCode = "da";
});

// ─────────────────────────── /terms ───────────────────────────

describe("Terms page (P0-1)", () => {
  const renderTerms = (lang) => {
    langCode = lang;
    return render(<MemoryRouter><TermsPage /></MemoryRouter>);
  };

  it("da: Handelsbetingelser, dated by TERMS_VERSION, CVR name, §8 Abonnement og betaling", () => {
    const { container } = renderTerms("da");
    const text = container.textContent;
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Handelsbetingelser");
    expect(text).toContain(`Sidst opdateret: ${termsDate(TERMS_VERSION, "da")}`);
    expect(text).toContain("BonBox leveres af DukaanAI v/Manoz Chaudhary, CVR 46417321");
    expect(screen.getByRole("heading", { level: 2, name: "8. Abonnement og betaling" })).toBeTruthy();
    expect(text).toContain("Betalte abonnementer er kun for virksomheder.");
    expect(text).toContain("Opsigelsen får virkning ved udgangen af den periode, du har betalt for.");
    expect(text).toContain("Vi refunderer ikke for en del af en periode.");
    expect(text).toContain("Du beholder stifterprisen, så længe dit abonnement er aktivt uden afbrydelse.");
    expect(text).toContain("mindst 30 dage");
    expect(text).toContain("Der lægges ikke moms oven i prisen.");
    for (const gone of ["90 sekunder", "Manoj Kumar", "gratis til rådighed", "Gratis tjeneste",
      "Indføre betalte abonnementer", "Open Banking", "for livet", "livstid", "13. maj 2026"]) {
      expect(text).not.toContain(gone);
    }
  });

  it("en: Terms of Service, same structure and decisions", () => {
    const { container } = renderTerms("en");
    const text = container.textContent;
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Terms of Service");
    expect(text).toContain(`Last updated: ${termsDate(TERMS_VERSION, "en")}`);
    expect(text).toContain("BonBox is provided by DukaanAI v/Manoz Chaudhary, CVR 46417321");
    expect(screen.getByRole("heading", { level: 2, name: "8. Subscription and payment" })).toBeTruthy();
    expect(text).toContain("Paid subscriptions are for businesses only.");
    expect(text).toContain("We do not refund part of a period.");
    expect(text).toContain("You keep the founding price as long as your subscription stays active without a break.");
    expect(text).toContain("at least 30 days");
    for (const gone of ["90 seconds", "Manoj Kumar", "provided free of charge", "Free service",
      "If we introduce paid features", "Open Banking", "for life", "13 May 2026"]) {
      expect(text).not.toContain(gone);
    }
  });

  it("both documents keep the same numbered sections", () => {
    const heads = (lang) => {
      const { unmount } = renderTerms(lang);
      const nums = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent.split(".")[0]);
      unmount();
      return nums;
    };
    const daNums = heads("da");
    expect(daNums).toEqual(heads("en"));
    expect(daNums).toEqual(Array.from({ length: 15 }, (_, i) => String(i + 1)));
  });
});

describe("legal/terms.js", () => {
  it("formats the version as the page date", () => {
    expect(TERMS_VERSION).toBe("2026-10-10");
    expect(termsDate("2026-10-10", "da")).toBe("10. oktober 2026");
    expect(termsDate("2026-10-10", "en")).toBe("10 October 2026");
  });
  it("adds accept_terms only on an explicit acceptTerms: true", () => {
    expect(withTermsAcceptance({ a: 1 }, { acceptTerms: true })).toEqual({ a: 1, accept_terms: true });
    for (const opts of [undefined, {}, { acceptTerms: "true" }, { acceptTerms: 1 }, { acceptTerms: false }]) {
      expect(withTermsAcceptance({ a: 1 }, opts)).toEqual({ a: 1 });
    }
  });
});

// ─────────────────────────── /register ───────────────────────────

describe("Register page acceptance line (LEG-11 / PQ-03)", () => {
  it("shows the line once, linked, and the register call sends accept_terms: true", async () => {
    const register = vi.fn(async () => ({ user: { id: "u1" } }));
    authState = { register, googleLogin: vi.fn(), googleOauthLogin: vi.fn(), appleOauthLogin: vi.fn() };
    const { container } = render(<MemoryRouter initialEntries={["/register"]}><RegisterPage /></MemoryRouter>);

    const lines = screen.getAllByTestId("signup-terms-line");
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe(
      "Ved at oprette en konto accepterer du vores Handelsbetingelser og Privatlivspolitik.",
    );
    const links = within(lines[0]).getAllByRole("link");
    expect(links.map((a) => a.getAttribute("href"))).toEqual(["/terms", "/privacy"]);

    fireEvent.change(container.querySelector('input[name="email"]'), { target: { value: "ejer@cafe.dk" } });
    fireEvent.change(container.querySelector('input[name="password"]'), { target: { value: "Validpass1" } });
    fireEvent.change(container.querySelector('input[name="business_name"]'), { target: { value: "Café" } });
    fireEvent.change(container.querySelector('select[name="business_type"]'), { target: { value: "cafe" } });
    fireEvent.submit(container.querySelector("form"));
    await waitFor(() => expect(register).toHaveBeenCalled());
    expect(register.mock.calls[0][0].accept_terms).toBe(true);
  });

  it("with a Google button the line sits beside the Google/Apple row, outside the form, once", async () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client.apps.googleusercontent.com");
    try {
      authState = { register: vi.fn(), googleLogin: vi.fn(), googleOauthLogin: vi.fn(), appleOauthLogin: vi.fn() };
      const { container } = render(<MemoryRouter initialEntries={["/register"]}><RegisterPage /></MemoryRouter>);
      const lines = screen.getAllByTestId("signup-terms-line");
      expect(lines).toHaveLength(1);
      expect(container.querySelector("form").contains(lines[0])).toBe(false);
      // It comes before the e-mail form in reading order (the OAuth row is above it).
      expect(lines[0].compareDocumentPosition(container.querySelector("form")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("English line", () => {
    langCode = "en";
    authState = { register: vi.fn(), googleLogin: vi.fn(), googleOauthLogin: vi.fn(), appleOauthLogin: vi.fn() };
    render(<MemoryRouter initialEntries={["/register"]}><RegisterPage /></MemoryRouter>);
    expect(screen.getByTestId("signup-terms-line").textContent).toBe(
      "By creating an account you accept our Terms of Service and Privacy Policy.",
    );
  });

  it("the Google/Apple row gets the line beside it and passes acceptTerms (source contract)", () => {
    const src = read("pages/RegisterPage.jsx");
    // The OAuth row renders the line; the form only when there is no row.
    expect(src).toMatch(/<SignupTermsLine isNative=\{isNative\} className="pt-1" \/>/);
    expect(src).toMatch(/!\(hasAppleWeb \|\| hasAppleNative \|\| hasGoogle\) && \(\s*<SignupTermsLine/);
    expect(src).toContain("fn(res.credential, { acceptTerms: true })");
    expect(src).toContain("await appleOauthLogin(idToken, name, { acceptTerms: true });");
    // The login page shows no acceptance line, so it must never send it.
    expect(read("pages/LoginPage.jsx")).not.toMatch(/acceptTerms|accept_terms/);
  });
});

// ─────────────────────────── /subscription (B2B) ───────────────────────────

describe("Subscription page: businesses only (LEG-12)", () => {
  const billing = {
    plan: "trial", trial_active: false, is_paid: false, subscription_status: null,
    stripe_configured: true, checkout_ready: { starter: true, pro: true, any: true },
  };

  const renderSub = (user) => {
    authState = { user, refreshUser: vi.fn() };
    get.mockImplementation((url) =>
      Promise.resolve({ data: url === "/billing/me" ? billing : url === "/waitlist/status" ? [] : {} }));
    return render(<MemoryRouter initialEntries={["/subscription"]}><SubscriptionPage /></MemoryRouter>);
  };

  it("a personal account sees why, the paid buttons are disabled, and no checkout is sent", async () => {
    renderSub({ id: "p1", email: "privat@gmail.com", business_type: "personal" });
    const notice = await screen.findByTestId("business-only-notice");
    expect(notice.textContent).toContain("Betalte abonnementer er kun for virksomheder");
    expect(notice.textContent).toContain("skift virksomhedstype under Profil");
    const buttons = await screen.findAllByRole("button", { name: "Kun for virksomheder" });
    expect(buttons).toHaveLength(2);
    buttons.forEach((b) => {
      expect(b.disabled).toBe(true);
      fireEvent.click(b);
    });
    expect(post).not.toHaveBeenCalledWith("/billing/stripe/checkout-session", expect.anything());
  });

  it("a personal account in its trial is not offered the lock-in path", async () => {
    const trialBilling = { ...billing, plan: "trial", trial_active: true, trial_days_remaining: 9 };
    authState = { user: { id: "p2", email: "privat2@gmail.com", business_type: "personal" }, refreshUser: vi.fn() };
    get.mockImplementation((url) =>
      Promise.resolve({ data: url === "/billing/me" ? trialBilling : url === "/waitlist/status" ? [] : {} }));
    render(<MemoryRouter initialEntries={["/subscription"]}><SubscriptionPage /></MemoryRouter>);
    await screen.findByTestId("business-only-notice");
    // The free path is still explained; the card-and-lock path is not.
    expect(screen.getByText((c) => c.includes(da.pricingTrialStep2BodyDoNothing))).toBeTruthy();
    expect(screen.queryByText((c) => c.includes(da.pricingTrialStep2BodyLock))).toBeNull();
    expect(screen.queryByText(da.pricingTrialStep3BodyLocked)).toBeNull();
    expect(screen.queryByRole("button", { name: da.pricingLockInRate })).toBeNull();
  });

  it("a business account keeps its buttons", async () => {
    renderSub({ id: "b1", email: "cafe@cafe.dk", business_type: "cafe" });
    await waitFor(() => expect(get).toHaveBeenCalledWith("/billing/me"));
    expect(screen.queryByTestId("business-only-notice")).toBeNull();
    expect(screen.queryByRole("button", { name: "Kun for virksomheder" })).toBeNull();
  });

  it("the 403 checkout_business_only is shown in the app's language (source contract)", () => {
    const src = read("pages/SubscriptionPage.jsx");
    expect(src).toContain('e.response.data?.detail?.code === "checkout_business_only"');
  });
});

// ─────────────────────────── decision 3 guard ───────────────────────────

describe("no founding 'for life' claim anywhere (decision 3)", () => {
  // A line that talks about the founding/founder price AND promises it for
  // life / forever, in any pack the app ships or an inline fallback.
  const FOUNDING = /founding|founder|stifter|129|249/i;
  const LIFE = /for life|livstid|for livet|låst for altid|locked forever|ömür boyu|trọn đời|ตลอดชีพ|जीवनभर/i;
  const files = [
    ...fs.readdirSync(path.join(SRC, "i18n")).filter((f) => f.endsWith(".js")).map((f) => `i18n/${f}`),
    "pages/SubscriptionPage.jsx",
    "components/landing/v2/PricingV2.jsx",
    "components/FounderRatePill.jsx",
  ];
  it.each(files)("%s", (rel) => {
    const offenders = read(rel)
      .split("\n")
      .filter((l) => FOUNDING.test(l) && LIFE.test(l));
    expect(offenders).toEqual([]);
  });

  it("the decision-3 wording is what replaced it (da + en)", () => {
    expect(da.pricingFoundingChipNew).toContain("så længe abonnementet er aktivt");
    expect(en.pricingFoundingChipNew).toContain("as long as your subscription stays active");
    expect(da.pricingLockedSubtitle).toContain("så længe abonnementet er aktivt");
    expect(en.trialFinalSavings).toContain("as long as your subscription stays active");
  });
});
