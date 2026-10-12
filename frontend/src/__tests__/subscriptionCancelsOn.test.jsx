/**
 * /subscription after "cancel at period end" (12 Oct 2026).
 *
 * Stripe keeps a cancelled subscription 'active' until the period ends, and
 * BonBox never read cancel_at_period_end — so the page kept saying
 * "Abonnement aktivt — betales månedligt" to an owner who will not be charged
 * again. /billing/me now sends subscription_cancel_at and the banner says
 * "Opsiges <dato> — du bliver ikke trukket igen". Display only.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: "da",
    setLang: () => {},
    LANGUAGES: [],
    t: (k, fb, vars) => {
      const v = typeof fb === "object" && fb ? fb : vars;
      let s = da[k] ?? en[k] ?? (typeof fb === "string" ? fb : k);
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
const get = vi.fn();
vi.mock("../services/api", () => ({
  default: { post: vi.fn(() => Promise.resolve({ data: {} })), get: (...a) => get(...a), put: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", email: "cafe@cafe.dk", business_type: "cafe" }, refreshUser: vi.fn() }),
  AuthProvider: ({ children }) => children,
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ refresh: vi.fn(), isReady: true, hasFeature: () => true }),
}));
vi.mock("../hooks/useFounderRateStatus", () => ({
  default: () => ({ status: { max_slots: 100, available: 100, claimed: 0 }, valid: true }),
}));
vi.mock("../hooks/useEventLog", () => ({ trackEvent: () => {} }));

const SubscriptionPage = (await import("../pages/SubscriptionPage")).default;

beforeEach(() => { localStorage.clear(); localStorage.setItem("lang", "da"); });
afterEach(() => cleanup());

const ACTIVE = {
  plan: "pro", is_paid: true, subscription_status: "active", stripe_configured: true,
  checkout_ready: { starter: true, pro: true, any: true },
};
const showPage = (billing) => {
  get.mockImplementation((url) => Promise.resolve({ data: url === "/billing/me" ? billing : [] }));
  return render(<MemoryRouter><SubscriptionPage /></MemoryRouter>);
};

describe("/subscription banner", () => {
  it("cancelled at period end: says when it ends and that there is no further charge", async () => {
    showPage({ ...ACTIVE, subscription_cancel_at: "2026-11-12T10:00:00" });
    expect(await screen.findByText("Opsiges 12. nov. 2026 — du bliver ikke trukket igen")).toBeTruthy();
    expect(screen.queryByText(da.pricingLockedActive)).toBeNull();
  });

  it("not cancelled: unchanged 'betales månedligt'", async () => {
    showPage({ ...ACTIVE, subscription_cancel_at: null });
    expect(await screen.findByText(da.pricingLockedActive)).toBeTruthy();
  });

  // QA 12 Oct: the green check stayed beside "Opsiges …", and the Pro card
  // still offered "Administrer abonnement / opsig" — a second cancel.
  it("cancelled at period end: a neutral icon, not the green check", async () => {
    showPage({ ...ACTIVE, subscription_cancel_at: "2026-11-12T10:00:00" });
    await screen.findByText("Opsiges 12. nov. 2026 — du bliver ikke trukket igen");
    const icon = screen.getByTestId("sub-status-icon");
    expect(icon.dataset.state).toBe("cancels");
    expect(icon.textContent).not.toContain("✓");
    expect(icon.className).not.toMatch(/emerald/);
    expect(icon.className).toMatch(/text-gray-500/);
    expect(icon.querySelector("svg")).not.toBeNull();
  });

  it("cancelled at period end: the Pro card offers 'Administrer abonnement', never 'opsig' again", async () => {
    showPage({ ...ACTIVE, subscription_cancel_at: "2026-11-12T10:00:00" });
    await screen.findByText("Opsiges 12. nov. 2026 — du bliver ikke trukket igen");
    const manage = screen.getByTestId("plan-card-manage");
    expect(manage.textContent).toBe(da.pricingManageSubscription);
    expect(screen.queryByText(da.pricingManageOrCancel)).toBeNull();
    // No control on the page offers to cancel again.
    for (const b of screen.getAllByRole("button")) expect(b.textContent).not.toMatch(/\bopsig\b/i);
  });

  it("not cancelled: the green check and 'Administrer abonnement / opsig' stay", async () => {
    showPage({ ...ACTIVE, subscription_cancel_at: null });
    await screen.findByText(da.pricingLockedActive);
    const icon = screen.getByTestId("sub-status-icon");
    expect(icon.dataset.state).toBe("ok");
    expect(icon.textContent).toBe("✓");
    expect(icon.className).toMatch(/emerald/);
    expect(screen.getByTestId("plan-card-manage").textContent).toBe(da.pricingManageOrCancel);
  });
});

describe("/subscription after cancel at period end", () => {
  it("names the end date instead of 'billed monthly'", async () => {
    const { cancelDateLabel } = await import("../utils/subscriptionCancel");
    localStorage.setItem("lang", "da");
    const label = cancelDateLabel({ subscription_status: "active", subscription_cancel_at: "2026-11-12T10:00:00" });
    expect(label).toBe("12. nov. 2026");
    // Only while it still runs; nothing scheduled → no line.
    expect(cancelDateLabel({ subscription_status: "canceled", subscription_cancel_at: "2026-11-12T10:00:00" })).toBeNull();
    expect(cancelDateLabel({ subscription_status: "active", subscription_cancel_at: null })).toBeNull();
    expect(da.pricingLockedCancels).toBe("Opsiges {date} — du bliver ikke trukket igen");
    expect(en.pricingLockedCancels).toBe("Cancels {date} — you won't be charged again");
  });
});

