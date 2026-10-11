/**
 * Push 3 pre-ship review F2 — one "Bekræft sletning" = one DELETE.
 *
 * The server refuses an account deletion with 503 when Stripe cannot stop
 * the subscription (subscription_cancel_failed) or settle the customer
 * record (stripe_customer_failed). The api.js interceptor retries every 503
 * (the Render cold start) up to 4 more times with 2/4/8/12 s back-off, so one
 * click sent 5 DELETE /auth/delete-account requests behind a 28.8 s spinner
 * before the refusal showed. The deletion call now opts out of the automatic
 * retry (`_noRetry`); reads keep their cold-start retry.
 *
 * The page runs on the REAL api module here; only its HTTP adapter is
 * replaced, so the interceptor that retried is the one under test.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiosError } from "axios";
import { en } from "../i18n/en";

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "ejer@cafe.dk", business_name: "Café Nora", business_type: "cafe",
      currency: "DKK", role: "owner", email_verified: true, claim_question_open: false },
    refreshUser: vi.fn(),
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true, plan: "pro" }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fb, vars) => {
      let s = en[k] ?? (typeof fb === "string" ? fb : k);
      const v = typeof fb === "object" && fb ? fb : vars;
      if (v) Object.entries(v).forEach(([a, b]) => { s = s.replace(`{${a}}`, String(b)); });
      return s;
    },
    lang: "en", setLang: () => {}, LANGUAGES: [],
  }),
  LanguageProvider: ({ children }) => children,
}));
vi.mock("../hooks/usePushNotifications", () => ({
  default: () => ({ permission: "default", supported: false, subscribed: false, busy: false,
    subscribe: vi.fn(), unsubscribe: vi.fn(), sendTest: vi.fn() }),
}));
vi.mock("../components/OperatingProfileSection", () => ({ default: () => null }));
vi.mock("../components/SmartStaffingCard", () => ({ default: () => null }));
vi.mock("../components/DeviceShareSettingsCard", () => ({ default: () => null }));
vi.mock("../components/BusinessLookup", () => ({ default: () => null, countryFromCurrency: () => "DK" }));

const api = (await import("../services/api")).default;
const ProfilePage = (await import("../pages/ProfilePage")).default;

const sent = [];
let refusalCode = "stripe_customer_failed";
let getReply = null;
const origAdapter = api.defaults.adapter;

const ok = (config, data = {}) => ({ data, status: 200, statusText: "OK", headers: {}, config, request: {} });
const unavailable = (config, data) => {
  const response = { data, status: 503, statusText: "Service Unavailable", headers: {}, config, request: {} };
  throw new AxiosError("Request failed with status code 503", "ERR_BAD_RESPONSE", config, {}, response);
};

beforeEach(() => {
  sent.length = 0;
  getReply = null;
  localStorage.clear();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  if (!globalThis.IntersectionObserver) {
    globalThis.IntersectionObserver = class {
      observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
    };
  }
  api.defaults.adapter = async (config) => {
    const method = (config.method || "get").toUpperCase();
    sent.push({ method, url: config.url });
    if (method === "DELETE" && config.url === "/auth/delete-account") {
      return unavailable(config, { detail: { code: refusalCode, message: "refused" } });
    }
    if (getReply) return getReply(config, sent.filter((s) => s.url === config.url).length);
    if (config.url === "/accountants/grants") return ok(config, []);
    if (config.url === "/billing/usage") return ok(config, { meters: [] });
    return ok(config, {});
  };
});
afterEach(() => {
  api.defaults.adapter = origAdapter;
  localStorage.clear();
});

const deletes = () => sent.filter((s) => s.method === "DELETE" && s.url === "/auth/delete-account");

describe("account deletion refused with 503: one click, one DELETE, the refusal at once", () => {
  it.each([
    ["stripe_customer_failed", "deleteStripeCustomerFailed"],
    ["subscription_cancel_failed", "deleteSubscriptionStopFailed"],
  ])("%s", async (code, key) => {
    refusalCode = code;
    const { container } = render(<MemoryRouter><ProfilePage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("button", { name: en.deleteMyAccount }));
    const pw = container.querySelector('input[placeholder="Enter your password"]');
    fireEvent.change(pw, { target: { value: "pw123456" } });
    const t0 = Date.now();
    fireEvent.click(screen.getByRole("button", { name: en.confirmDelete }));
    // The first automatic retry would wait 2 s; the refusal must show before it.
    await screen.findByText(en[key], {}, { timeout: 1500 });
    expect(Date.now() - t0).toBeLessThan(1500);
    expect(deletes()).toHaveLength(1);
    // Nothing is cleared and nobody is sent to /login on a refusal.
    expect(window.location.pathname).not.toBe("/login");
  }, 10000);
});

describe("reads keep the cold-start retry", () => {
  it("a GET that meets a 503 is retried and then succeeds", async () => {
    getReply = (config, n) => (n === 1 ? unavailable(config, "cold start") : ok(config, { ok: true }));
    const res = await api.get("/config/ping");
    expect(res.data).toEqual({ ok: true });
    expect(sent.filter((s) => s.url === "/config/ping")).toHaveLength(2);
  }, 10000);
});

describe("source contract", () => {
  it("ProfilePage's delete call opts out of the automatic retry", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    const src = fs.readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../pages/ProfilePage.jsx"), "utf8");
    expect(src).toMatch(/api\.delete\("\/auth\/delete-account", \{[^}]*\}[^)]*_noRetry: true/);
  });
});
