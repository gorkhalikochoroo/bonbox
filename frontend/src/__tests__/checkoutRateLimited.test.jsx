/**
 * Manoj, 11 Oct 2026: pressing Upgrade 2-3 times showed "Too many requests —
 * please try again in a minute." The server now hands back the checkout
 * already open at Stripe, and its cap on NEW sessions answers 429
 * checkout_rate_limited with the wait in its own words (message_da /
 * message). The plan page shows those words in the app's language; any
 * other 429 keeps the generic tooManyRequests text.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
vi.mock("../utils/platform", () => ({
  isNativeApp: () => false,
  canPurchaseInApp: () => true,
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
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", email: "cafe@cafe.dk", business_type: "cafe" }, refreshUser: vi.fn() }),
  AuthProvider: ({ children }) => children,
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ refresh: vi.fn(), isReady: true, hasFeature: () => false }),
}));
vi.mock("../hooks/useFounderRateStatus", () => ({
  default: () => ({ status: { max_slots: 100, available: 100, claimed: 0 }, valid: true }),
}));
vi.mock("../hooks/useEventLog", () => ({ trackEvent: () => {} }));

const SubscriptionPage = (await import("../pages/SubscriptionPage")).default;

afterEach(() => {
  cleanup();
  langCode = "da";
});

const TRIAL = {
  plan: "trial", trial_active: true, is_paid: false, subscription_status: null,
  stripe_configured: true, checkout_ready: { starter: true, pro: true, any: true },
};

const SERVER = {
  code: "checkout_rate_limited",
  message: "You've started a lot of new checkouts in a short time, so we're pausing for a moment. Try again in about 10 minutes, or write to contact@bonbox.dk.",
  message_da: "Du har startet mange nye betalinger på kort tid, så vi holder en pause. Prøv igen om ca. 10 minutter, eller skriv til contact@bonbox.dk.",
  retry_after_seconds: 600,
};

const reject = (status, data) => Promise.reject(Object.assign(new Error("x"), { response: { status, data } }));

async function pressStarter(lang, answer) {
  langCode = lang;
  post.mockReset();
  post.mockImplementation((url) => (url === "/billing/stripe/checkout-session" ? answer() : Promise.resolve({ data: {} })));
  get.mockReset();
  get.mockImplementation((url) =>
    Promise.resolve({ data: url === "/billing/me" ? TRIAL : url === "/waitlist/status" ? [] : {} }));
  render(<MemoryRouter initialEntries={["/subscription"]}><SubscriptionPage /></MemoryRouter>);
  // The Starter card's button opens a checkout (the Terms line beside it).
  const lines = await screen.findAllByTestId("checkout-terms-line");
  const button = lines[0].parentElement.querySelector("button");
  fireEvent.click(button);
  expect(post).toHaveBeenCalledWith("/billing/stripe/checkout-session", expect.objectContaining({ accept_terms: true }));
}

describe("429 checkout_rate_limited on the plan page", () => {
  it("da: the server's Danish sentence, with the wait", async () => {
    await pressStarter("da", () => reject(429, { detail: SERVER }));
    expect(await screen.findByText(SERVER.message_da)).toBeTruthy();
    expect(screen.queryByText(da.tooManyRequests)).toBeNull();
  });

  it("en: the server's English sentence, with the wait", async () => {
    await pressStarter("en", () => reject(429, { detail: SERVER }));
    expect(await screen.findByText(SERVER.message)).toBeTruthy();
    expect(screen.queryByText(en.tooManyRequests)).toBeNull();
  });

  it("an older server without the sentence: the real i18n key, never 'in a minute'", async () => {
    await pressStarter("da", () => reject(429, { detail: { code: "checkout_rate_limited" } }));
    expect(await screen.findByText(da.checkoutRateLimited)).toBeTruthy();
    expect(da.checkoutRateLimited).not.toMatch(/minut/);
    expect(en.checkoutRateLimited).not.toMatch(/minute/);
    expect(da.checkoutRateLimited).not.toBe(en.checkoutRateLimited);
  });

  it("any other 429 keeps the generic text", async () => {
    await pressStarter("da", () => reject(429, { detail: "Rate limit exceeded: 10 per 1 minute" }));
    expect(await screen.findByText(da.tooManyRequests)).toBeTruthy();
  });
});
