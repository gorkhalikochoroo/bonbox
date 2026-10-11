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
 *     Handelsbetingelser. Læs om, hvordan vi behandler dine data, i vores
 *     Privatlivspolitik." ONCE, linked, and the register request carries
 *     accept_terms: true. The privacy policy is information, not accepted.
 *   • /login (R-e fix-up) shows "Ved at fortsætte accepterer du vores
 *     Handelsbetingelser. …" beside Google/Apple and under the e-mail-link
 *     button, and those requests carry accept_terms (the server stamps only
 *     a NEW account); the mailed link's &terms=1 reaches the verify.
 *   • /subscription (R-e fix-up, P0-1): beside every button that opens a
 *     real Stripe checkout, "Når du går videre til betaling, accepterer du
 *     vores Handelsbetingelser og bekræfter, at du køber abonnementet til
 *     din virksomhed.", and the checkout request carries accept_terms.
 *   • A personal (Privatøkonomi) account cannot start a paid checkout: the
 *     Starter/Pro buttons say "Kun for virksomheder", are disabled, and no
 *     checkout request is sent.
 *   • No "for life" founding-price claim in any language pack or inline
 *     fallback (decision 3).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
let entState = { refresh: vi.fn(), isReady: true, hasFeature: () => false };
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => entState,
}));
vi.mock("../hooks/useFounderRateStatus", () => ({
  default: () => ({ status: { max_slots: 100, available: 100, claimed: 0 }, valid: true }),
}));
vi.mock("../hooks/useEventLog", () => ({ trackEvent: () => {} }));

const { TERMS_VERSION, termsDate, withTermsAcceptance } = await import("../legal/terms");
const TermsPage = (await import("../pages/TermsPage")).default;
const RegisterPage = (await import("../pages/RegisterPage")).default;
const SubscriptionPage = (await import("../pages/SubscriptionPage")).default;
const LoginPage = (await import("../pages/LoginPage")).default;
const LoginMagicPage = (await import("../pages/LoginMagicPage")).default;
const TrialBanner = (await import("../components/TrialBanner")).default;

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

beforeEach(() => {
  post.mockReset();
  get.mockReset();
  get.mockImplementation(() => Promise.resolve({ data: {} }));
  post.mockImplementation(() => Promise.resolve({ data: {} }));
  langCode = "da";
  entState = { refresh: vi.fn(), isReady: true, hasFeature: () => false };
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
    // VAT status is not confirmed (Manoj, 10 Oct, decision d): § 8 says
    // where the amount is shown, never whether moms is or is not added.
    expect(text).toContain("Beløbet, du skal betale, vises ved betalingen, før du bekræfter købet.");
    expect(text).not.toContain("Der lægges ikke moms oven i prisen.");
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

  it("R-e fix-up: § 4 deletion, § 6 bank import and § 8 plans say what the app does (da + en)", () => {
    let text = renderTerms("da").container.textContent;
    // § 4 — deletion asks for a password; Google/Apple/e-mail-link accounts
    // set one first (or write to us); team members are removed first.
    expect(text).toContain("Du kan til enhver tid slette din konto under Profil. Sletningen beder om din adgangskode: har du oprettet kontoen med Google, Apple eller et e-maillink, så vælg først en adgangskode via »Glemt?« på login-siden, eller skriv til contact@bonbox.dk.");
    expect(text).toContain("Har kontoen teammedlemmer med eget login, skal de fjernes først.");
    // § 6 — there is no "delete the whole import"; the entries can be deleted.
    expect(text).toContain("Du kan slette de posteringer, en import har oprettet (salg og udgifter)");
    expect(text).not.toContain("slette alle importerede bankdata");
    // § 8 — prices by reference, not the marketing feature lists; the
    // reservation to change features and caps is back.
    expect(text).toContain("Priserne står på bonbox.dk under Priser");
    expect(text).not.toContain("Hvad hver plan indeholder, og hvad den koster");
    expect(text).toContain("Vi kan ændre, begrænse eller fjerne funktioner og forbrugslofter med rimeligt varsel.");
    cleanup();
    text = renderTerms("en").container.textContent;
    expect(text).toContain("You can delete your account at any time under Profile. Deleting asks for your password: if you created the account with Google, Apple or an e-mail link, first choose a password with “Forgot?” on the login page, or write to contact@bonbox.dk.");
    expect(text).toContain("If the account has team members with their own login, remove them first.");
    expect(text).toContain("You can delete the entries an import created (sales and expenses)");
    expect(text).not.toContain("delete all imported bank data");
    expect(text).toContain("The prices are shown on bonbox.dk under Pricing");
    expect(text).toContain("We may change, limit or remove features and usage caps with reasonable notice.");
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
    // TERMS_VERSION is a release-time constant (set on the deploy day, see
    // src/legal/terms.js): a real ISO day, never pinned to one value here.
    expect(TERMS_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(termsDate(TERMS_VERSION, "da")).toMatch(/^\d{1,2}\. [a-zæø]+ \d{4}$/);
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
      "Ved at oprette en konto accepterer du vores Handelsbetingelser. Læs om, hvordan vi behandler dine data, i vores Privatlivspolitik.",
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
      "By creating an account you accept our Terms of Service. Read how we handle your data in our Privacy Policy.",
    );
  });

  it("the privacy policy is information, never something to accept (da + en)", () => {
    for (const d of [da, en]) {
      const [accept, info] = d.signupAcceptTerms.split(/\.\s/);
      expect(accept).toContain("{terms}");
      expect(accept).not.toContain("{privacy}");
      expect(info).toContain("{privacy}");
    }
    expect(da.continueAcceptTerms.split(/\.\s/)[0]).not.toContain("{privacy}");
    expect(en.continueAcceptTerms.split(/\.\s/)[0]).not.toContain("{privacy}");
  });

  it("tapping a link opens a new tab and never submits the form", () => {
    const register = vi.fn(async () => ({ user: { id: "u1" } }));
    authState = { register, googleLogin: vi.fn(), googleOauthLogin: vi.fn(), appleOauthLogin: vi.fn() };
    const { container } = render(<MemoryRouter initialEntries={["/register"]}><RegisterPage /></MemoryRouter>);
    const line = screen.getByTestId("signup-terms-line");
    // No Google/Apple row here, so the line sits inside the form, under the button.
    expect(container.querySelector("form").contains(line)).toBe(true);
    for (const a of within(line).getAllByRole("link")) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
      fireEvent.click(a);
    }
    expect(register).not.toHaveBeenCalled();
  });

  it("the Google/Apple row gets the line beside it and passes acceptTerms (source contract)", () => {
    const src = read("pages/RegisterPage.jsx");
    // The OAuth row renders the line; the form only when there is no row.
    expect(src).toMatch(/<SignupTermsLine isNative=\{isNative\} className="pt-1" \/>/);
    expect(src).toMatch(/!\(hasAppleWeb \|\| hasAppleNative \|\| hasGoogle\) && \(\s*<SignupTermsLine/);
    expect(src).toContain("fn(res.credential, { acceptTerms: true })");
    expect(src).toContain("await appleOauthLogin(idToken, name, { acceptTerms: true });");
  });
});

// ─────────────────────────── /login (R-e fix-up) ───────────────────────────

describe("Login page acceptance line (Google, Apple and the e-mail link create accounts too)", () => {
  const loginAuth = () => ({
    login: vi.fn(), googleLogin: vi.fn(), googleOauthLogin: vi.fn(),
    appleOauthLogin: vi.fn(), needsEmailVerification: false, user: null,
  });
  const CONTINUE_DA =
    "Ved at fortsætte accepterer du vores Handelsbetingelser. Læs om, hvordan vi behandler dine data, i vores Privatlivspolitik.";

  it("beside the Google/Apple row: once, linked, before the e-mail form", () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client.apps.googleusercontent.com");
    try {
      authState = loginAuth();
      const { container } = render(<MemoryRouter initialEntries={["/login"]}><LoginPage /></MemoryRouter>);
      const lines = screen.getAllByTestId("signup-terms-line");
      expect(lines).toHaveLength(1);
      expect(lines[0].textContent).toBe(CONTINUE_DA);
      expect(within(lines[0]).getAllByRole("link").map((a) => a.getAttribute("href"))).toEqual(["/terms", "/privacy"]);
      expect(container.querySelector("form").contains(lines[0])).toBe(false);
      expect(lines[0].compareDocumentPosition(container.querySelector("form")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("password mode without Google/Apple shows no line (a password sign-in never creates an account)", () => {
    authState = loginAuth();
    render(<MemoryRouter initialEntries={["/login"]}><LoginPage /></MemoryRouter>);
    expect(screen.queryByTestId("signup-terms-line")).toBeNull();
  });

  it("e-mail-link mode: the line sits under the button and the request carries accept_terms", async () => {
    authState = loginAuth();
    post.mockImplementation(() => Promise.resolve({ data: { ok: true } }));
    const { container } = render(<MemoryRouter initialEntries={["/login"]}><LoginPage /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: da.useEmailInstead }));
    const line = screen.getByTestId("signup-terms-line");
    expect(line.textContent).toBe(CONTINUE_DA);
    fireEvent.change(container.querySelector('input[type="email"]'), { target: { value: "ny@cafe.dk" } });
    fireEvent.submit(container.querySelector("form"));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [url, body] = post.mock.calls[0];
    expect(url).toBe("/auth/magic-link/request");
    expect(body).toMatchObject({ email: "ny@cafe.dk", accept_terms: true });
  });

  it("Google and Apple (web + native) pass acceptTerms (source contract)", () => {
    const src = read("pages/LoginPage.jsx");
    expect(src).toContain("fn(res.credential, { acceptTerms: true })");
    expect(src.match(/appleOauthLogin\(idToken, name, \{ acceptTerms: true \}\)/g)).toHaveLength(2);
    expect(src).not.toMatch(/appleOauthLogin\(idToken, name\)/);
  });

  it("the mailed link's &terms=1 reaches the verify as accept_terms; without it, nothing is sent", async () => {
    const token = "a".repeat(43);
    for (const [search, expected] of [[`?token=${token}&terms=1`, true], [`?token=${token}`, undefined]]) {
      post.mockReset();
      post.mockImplementation(() => new Promise(() => {})); // stay on "verifying"
      authState = {};
      const { unmount } = render(
        <MemoryRouter initialEntries={[`/login/magic${search}`]}><LoginMagicPage /></MemoryRouter>,
      );
      await waitFor(() => expect(post).toHaveBeenCalled());
      const [url, body] = post.mock.calls[0];
      expect(url).toBe("/auth/magic-link/verify");
      expect(body.accept_terms).toBe(expected);
      unmount();
    }
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

  it("P0-1: a business account sees the Terms line beside Starter and Pro, and the checkout carries accept_terms", async () => {
    renderSub({ id: "b2", email: "cafe2@cafe.dk", business_type: "cafe" });
    const lines = await screen.findAllByTestId("checkout-terms-line");
    expect(lines).toHaveLength(2);
    expect(lines[0].textContent).toBe(
      "Når du går videre til betaling, accepterer du vores Handelsbetingelser og bekræfter, at du køber abonnementet til din virksomhed.",
    );
    expect(within(lines[0]).getByRole("link").getAttribute("href")).toBe("/terms");
    // The line sits right under its button, inside the same card.
    const btn = lines[0].previousElementSibling;
    expect(btn.tagName).toBe("BUTTON");
    post.mockImplementation(() => new Promise(() => {}));
    fireEvent.click(btn);
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post.mock.calls[0][0]).toBe("/billing/stripe/checkout-session");
    expect(post.mock.calls[0][1]).toMatchObject({ accept_terms: true });
  });

  it("P0-1: English line", async () => {
    langCode = "en";
    renderSub({ id: "b3", email: "cafe3@cafe.dk", business_type: "cafe" });
    const lines = await screen.findAllByTestId("checkout-terms-line");
    expect(lines[0].textContent).toBe(
      "By continuing to payment you accept our Terms of Service and confirm that you are buying the subscription for your business.",
    );
  });

  it("P0-1: the trial card's lock-in button has the line too; a personal account gets none", async () => {
    const trialBilling = { ...billing, plan: "trial", trial_active: true, trial_days_remaining: 9 };
    authState = { user: { id: "b4", email: "cafe4@cafe.dk", business_type: "cafe" }, refreshUser: vi.fn() };
    get.mockImplementation((url) =>
      Promise.resolve({ data: url === "/billing/me" ? trialBilling : url === "/waitlist/status" ? [] : {} }));
    const { unmount } = render(<MemoryRouter initialEntries={["/subscription"]}><SubscriptionPage /></MemoryRouter>);
    expect(await screen.findByTestId("checkout-terms-line-trial")).toBeTruthy();
    unmount();
    renderSub({ id: "p5", email: "privat5@gmail.com", business_type: "personal" });
    await screen.findByTestId("business-only-notice");
    expect(screen.queryByTestId("checkout-terms-line")).toBeNull();
    expect(screen.queryByTestId("checkout-terms-line-trial")).toBeNull();
  });

  it("no line where the button does not open a checkout (tier not ready → waitlist)", async () => {
    authState = { user: { id: "b6", email: "cafe6@cafe.dk", business_type: "cafe" }, refreshUser: vi.fn() };
    get.mockImplementation((url) => Promise.resolve({
      data: url === "/billing/me"
        ? { ...billing, stripe_configured: false, checkout_ready: { starter: false, pro: false, any: false } }
        : url === "/waitlist/status" ? [] : {},
    }));
    render(<MemoryRouter initialEntries={["/subscription"]}><SubscriptionPage /></MemoryRouter>);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/billing/me"));
    await screen.findAllByRole("button", { name: da.pricingJoinWaitlist });
    expect(screen.queryByTestId("checkout-terms-line")).toBeNull();
  });

  it("Free is not promised 'for altid' / 'forever' (Terms § 8 reserves price and feature changes)", async () => {
    for (const d of [da, en]) {
      expect(d.pricingForever).not.toMatch(/altid|forever/i);
      expect(d["landingV2.pricing.free.period"]).not.toMatch(/altid|forever/i);
    }
    renderSub({ id: "b7", email: "cafe7@cafe.dk", business_type: "cafe" });
    expect(await screen.findByText("uden kort")).toBeTruthy();
    expect(read("pages/SubscriptionPage.jsx")).not.toContain('"forever"');
    expect(read("components/landing/v2/PricingV2.jsx")).not.toContain('"forever"');
  });
});

// ─────────────── founding-price copy = the Terms (R-e fix-up) ───────────────

describe("founding-price copy at the point of purchase says what the Terms say", () => {
  it("faqA3 (da + en): the Terms rule, Starter included, no false 'regular price on rejoin'", () => {
    expect(da.faqA3).toContain("Så længe færre end 100 virksomheder har et betalt abonnement");
    expect(da.faqA3).toContain("Starter 129");
    expect(da.faqA3).toContain("Du beholder stifterprisen, så længe abonnementet er aktivt uden afbrydelse.");
    expect(da.faqA3).toContain("den pris, der gælder på det tidspunkt");
    expect(da.faqA3).not.toMatch(/Du betaler normalpris|De første 100 Pro/);
    expect(en.faqA3).toContain("While fewer than 100 businesses have a paid subscription");
    expect(en.faqA3).toContain("the price that applies at that time");
    expect(en.faqA3).not.toMatch(/You'd pay regular price|first 100 Pro/i);
  });

  it("trialOpenDetail (da + en) uses the same scope", () => {
    expect(da.trialOpenDetail).toContain("så længe færre end 100 virksomheder har et betalt abonnement");
    expect(en.trialOpenDetail).toContain("while fewer than 100 businesses have a paid subscription");
    expect(da.trialOpenDetail).not.toContain("første 100 kunder");
  });

  it("the paid-status lines do not call every subscription a founding one", () => {
    for (const d of [da, en]) {
      expect(d.pricingLockedTrialing).not.toMatch(/founding|stifter/i);
      expect(d.pricingLockedActive).not.toMatch(/founding|stifter/i);
    }
  });

  it("other packs carry no stale founding rule (fall back to English, or translated anew)", () => {
    for (const f of ["np.js", "th.js", "vi.js"]) {
      const src = read(`i18n/${f}`);
      expect(src).not.toMatch(/^\s+(faqA3|trialOpenDetail|pricingLockedTrialing|pricingLockedActive):/m);
    }
    const tr = read("i18n/tr.js");
    expect(tr).toMatch(/faqA3: "100'den az işletmenin/);
    expect(tr).not.toMatch(/landingV2\.pricing\.free\.period": "süresiz"/);
  });
});

describe("TrialBanner: no founding offer to an account that cannot buy", () => {
  const trialEnt = { loading: false, isPaid: false, inTrial: true, trialDaysRemaining: 9 };

  it("a business account sees the founding sentence", () => {
    entState = trialEnt;
    authState = { user: { id: "b8", business_type: "cafe" } };
    render(<MemoryRouter><TrialBanner /></MemoryRouter>);
    expect(screen.getByText((c) => c.includes(da.trialOpenDetail))).toBeTruthy();
  });

  it("a personal account is told it stays on Free instead", () => {
    entState = trialEnt;
    authState = { user: { id: "p8", business_type: "personal" } };
    render(<MemoryRouter><TrialBanner /></MemoryRouter>);
    expect(screen.queryByText((c) => c.includes(da.trialOpenDetail))).toBeNull();
    expect(screen.getByText((c) => c.includes(da.trialClosingDetail))).toBeTruthy();
  });
});

describe("account deletion refused when the subscription cannot be stopped (source contract)", () => {
  it("ProfilePage shows the refusal in the app's language", () => {
    const src = read("pages/ProfilePage.jsx");
    expect(src).toContain('err?.response?.data?.detail?.code === "subscription_cancel_failed"');
    expect(src).toContain('t("deleteSubscriptionStopFailed"');
    expect(da.deleteSubscriptionStopFailed).toContain("din konto er ikke slettet");
    expect(en.deleteSubscriptionStopFailed).toContain("your account was not deleted");
  });

  it("…and the refusal when Stripe can't settle the customer record (Manoj, 11 Oct)", () => {
    const src = read("pages/ProfilePage.jsx");
    expect(src).toContain('err?.response?.data?.detail?.code === "stripe_customer_failed"');
    expect(src).toContain('t("deleteStripeCustomerFailed"');
    expect(da.deleteStripeCustomerFailed).toContain("din konto er ikke slettet");
    expect(en.deleteStripeCustomerFailed).toContain("your account was not deleted");
    // No "nothing was changed": the subscription may already be stopped.
    expect(da.deleteStripeCustomerFailed).not.toContain("intet er ændret");
    expect(en.deleteStripeCustomerFailed).not.toContain("nothing was changed");
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
