/**
 * Push 6 (PQ-16) — each sign-up page names itself in the tab, follows a
 * language switch, and hands the shell title back (in the language on
 * screen) when it goes.
 */
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";
import { LanguageProvider, shellTitle } from "../hooks/useLanguage";

vi.mock("../services/api", () => ({
  default: {
    get: vi.fn(() => Promise.resolve({ data: {} })),
    post: vi.fn(() => new Promise(() => {})),
    put: vi.fn(() => Promise.resolve({ data: {} })),
    patch: vi.fn(() => Promise.resolve({ data: {} })),
  },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "u1", email: "ole@cafe.dk", email_verified: false, business_type: "cafe", business_name: "Café", role: "owner", onboarding_completed_at: null },
    register: vi.fn(), login: vi.fn(), googleLogin: vi.fn(), googleOauthLogin: vi.fn(), appleOauthLogin: vi.fn(),
    setEmailVerified: vi.fn(), refreshUser: vi.fn(), logout: vi.fn(),
  }),
}));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ({ plan: "trial", isReady: true, hasFeature: () => false }) }));
vi.mock("../components/AppleSignInButton", () => ({ default: () => null }));

const pages = {
  "/register": [(await import("../pages/RegisterPage")).default, "suTitleRegister"],
  "/login": [(await import("../pages/LoginPage")).default, "suTitleLogin"],
  "/forgot-password": [(await import("../pages/ForgotPasswordPage")).default, "suTitleForgot"],
  "/verify-email": [(await import("../pages/VerifyEmailPage")).default, "suTitleVerify"],
  "/onboarding": [(await import("../pages/OnboardingPage")).default, "suTitleOnboarding"],
};

function renderAt(path) {
  const [Page] = pages[path];
  return render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[path]}><Page /></MemoryRouter>
    </LanguageProvider>,
  );
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("lang", "da");
  document.title = shellTitle("da");
});
afterEach(() => { cleanup(); localStorage.clear(); });

describe("a title per page", () => {
  it.each(Object.keys(pages))("%s sets its own title", (path) => {
    renderAt(path);
    expect(document.title).toBe(da[pages[path][1]]);
    expect(document.title).not.toBe(shellTitle("da"));
  });

  it("the five titles are different", () => {
    const titles = Object.values(pages).map(([, key]) => da[key]);
    expect(new Set(titles).size).toBe(5);
  });
});

describe("language switch and unmount", () => {
  it("switching to English updates the title; unmounting restores the ENGLISH shell title", async () => {
    const { container, unmount } = renderAt("/register");
    expect(document.title).toBe(da.suTitleRegister);
    const select = container.querySelector("select");
    expect(select).toBeTruthy();
    await act(async () => { fireEvent.change(select, { target: { value: "en" } }); });
    expect(document.title).toBe(en.suTitleRegister);
    unmount();
    expect(document.title).toBe(shellTitle("en"));
  });

  it("unmounting without a switch restores the Danish shell title", () => {
    const { unmount } = renderAt("/login");
    expect(document.title).toBe(da.suTitleLogin);
    unmount();
    expect(document.title).toBe(shellTitle("da"));
  });
});
