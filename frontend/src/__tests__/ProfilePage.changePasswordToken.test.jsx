/**
 * CMS-2 (R-f) — a password change keeps THIS device signed in.
 *
 * The server bumps token_version (every other session dies) and returns this
 * device's new token, in the same shared-device ("Delt enhed") state. The page
 * ignored it: the native app kept the revoked token in storage and signed
 * itself out on the next request. It now replaces a stored token; on the web
 * (no token in storage, the cookie was re-set by the server) nothing is
 * written to storage.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), me: {}, grants: [] }));
vi.mock("../services/api", () => ({
  default: { get: (...a) => h.get(...a), post: (...a) => h.post(...a), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.me, refreshUser: vi.fn() }) }));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true, plan: "pro" }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fb, vars) => {
      let s = typeof fb === "string" ? fb : k;
      const v = typeof fb === "object" && fb ? fb : vars;
      if (v) Object.entries(v).forEach(([a, b]) => { s = s.replace(`{${a}}`, String(b)); });
      return s;
    },
    lang: "da", setLang: () => {}, LANGUAGES: [],
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

const ProfilePage = (await import("../pages/ProfilePage")).default;

const BASE_ME = { id: "u1", email: "ejer@cafe.dk", business_name: "Café Nora", business_type: "cafe",
  currency: "DKK", role: "owner", email_verified: true, claim_question_open: false };

function profileGets() {
  h.get.mockImplementation((url) => {
    if (url === "/auth/me") return Promise.resolve({ data: h.me });
    if (url === "/business") return Promise.resolve({ data: { accountant_email: "pia@realrevisor.dk", accountant_name: "Pia", accountant_auto_send: true } });
    if (url === "/email/preferences") return Promise.resolve({ data: { daily_digest_enabled: false, expense_alerts_enabled: true, daily_brief_email_enabled: true } });
    if (url === "/accountants/grants") return Promise.resolve({ data: h.grants });
    if (url === "/billing/usage") return Promise.resolve({ data: { meters: [] } });
    return Promise.resolve({ data: {} });
  });
}

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset();
  h.me = { ...BASE_ME };
  h.grants = [];
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  if (!globalThis.IntersectionObserver) {
    globalThis.IntersectionObserver = class {
      observe() {} unobserve() {} disconnect() {} takeRecords() { return []; }
    };
  }
});

const renderProfile = async () => {
  profileGets();
  const view = render(<MemoryRouter><ProfilePage /></MemoryRouter>);
  await screen.findByText(/Send the kasserapport to my revisor automatically/);
  return view;
};

async function changePassword(container) {
  h.post.mockImplementation((url) =>
    url === "/auth/change-password"
      ? Promise.resolve({ data: { message: "ok", token: "new-token" } })
      : Promise.resolve({ data: {} }),
  );
  fireEvent.change(container.querySelector('input[autocomplete="current-password"]'), { target: { value: "oldpass-123" } });
  const fresh = container.querySelectorAll('input[autocomplete="new-password"]');
  fireEvent.change(fresh[0], { target: { value: "newpass-8642" } });
  fireEvent.change(fresh[1], { target: { value: "newpass-8642" } });
  await act(async () => {
    fireEvent.submit(fresh[0].closest("form"));
  });
  await waitFor(() => expect(h.post).toHaveBeenCalledWith("/auth/change-password", expect.any(Object)));
}

describe("password change keeps this device signed in", () => {
  it("replaces the stored token (the native app)", async () => {
    localStorage.setItem("token", "old-token");
    const { container } = await renderProfile();
    await changePassword(container);
    await waitFor(() => expect(localStorage.getItem("token")).toBe("new-token"));
  });

  it("writes no token to storage on the web", async () => {
    localStorage.removeItem("token");
    const { container } = await renderProfile();
    await changePassword(container);
    await waitFor(() => expect(h.post).toHaveBeenCalled());
    expect(localStorage.getItem("token")).toBeNull();
  });
});
