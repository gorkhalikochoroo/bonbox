/**
 * A sign-in honours "Spring over for nu" (review, 8 Oct).
 *
 * LoginPage sent every unconfirmed owner created after the grace date to
 * /verify-email after a password / Google / Apple sign-in and never checked
 * the 7-day skip (utils/verifySkip). VerifyEmailRoute keeps a skipped owner
 * who arrives there (purposeful arrivals must reach it) and mails a fresh
 * code on arrival — so every sign-in inside the 7 days met the wall again
 * and mailed an unrequested code. The login now lands such an owner on the
 * dashboard; the route itself is unchanged.
 */
import { Suspense } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { post: (...a) => post(...a), get: vi.fn(() => Promise.resolve({ data: {} })) },
}));

let authState;
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }) => children,
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da", setLang: () => {}, LANGUAGES: [] }),
  LanguageProvider: ({ children }) => children,
  detectInitialLanguage: () => "da",
}));
vi.mock("@react-oauth/google", () => ({
  GoogleLogin: () => null,
  GoogleOAuthProvider: ({ children }) => children,
}));

const { VerifyEmailRoute } = await import("../App");
const LoginPage = (await import("../pages/LoginPage")).default;
const { postLoginPath, rememberVerifySkip, clearVerifySkip } = await import("../utils/verifySkip");

const PRE_GRACE = "2026-02-01T10:00:00";
const POST_GRACE = "2026-09-01T10:00:00";

function owner(over = {}) {
  return { id: "u-77", email: "ejer@cafe.dk", email_verified: false, created_at: POST_GRACE, ...over };
}

// The real rule from hooks/useAuth: unconfirmed and created after the grace date.
function makeAuth(signedIn) {
  const state = {
    user: null,
    loading: false,
    setEmailVerified: vi.fn(),
    needsEmailVerification: () => {
      const u = state.user;
      return !!u && !u.email_verified && !!u.created_at
        && new Date(u.created_at) >= new Date("2026-04-13T00:00:00");
    },
    login: vi.fn(async () => {
      state.user = signedIn;
      return { user: signedIn };
    }),
    googleLogin: vi.fn(),
    googleOauthLogin: vi.fn(),
    appleOauthLogin: vi.fn(),
  };
  return state;
}

async function signIn() {
  const { container } = render(
    <MemoryRouter initialEntries={["/login"]}>
      <Suspense fallback={<p>loading</p>}>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/verify-email" element={<VerifyEmailRoute />} />
          <Route path="/dashboard" element={<p>DASHBOARD</p>} />
        </Routes>
      </Suspense>
    </MemoryRouter>,
  );
  fireEvent.change(container.querySelector("#email"), { target: { value: "ejer@cafe.dk" } });
  fireEvent.change(container.querySelector("#password"), { target: { value: "hemmelig-123" } });
  fireEvent.submit(container.querySelector("form"));
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ data: { message: "Verification code sent" } });
  try { sessionStorage.clear(); localStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => {
  vi.clearAllMocks();
  try { sessionStorage.clear(); localStorage.clear(); } catch { /* jsdom */ }
});

describe("LoginPage → after a sign-in", () => {
  it("a skip-active post-grace owner lands on the dashboard, and no code is mailed", async () => {
    rememberVerifySkip("u-77");
    sessionStorage.clear(); // a NEW session: only the 7-day skip remains
    authState = makeAuth(owner());
    await signIn();
    expect(await screen.findByText("DASHBOARD")).toBeTruthy();
    expect(screen.queryByText("verifyEmailHeading")).toBeNull();
    // Give any arrival effect a chance to fire, then make sure it did not.
    await new Promise((r) => setTimeout(r, 20));
    expect(post).not.toHaveBeenCalledWith("/auth/resend-verification");
  });

  it("without a skip, the post-grace owner still meets the wall", async () => {
    authState = makeAuth(owner());
    await signIn();
    expect(await screen.findByText("verifyEmailHeading")).toBeTruthy();
    expect(screen.queryByText("DASHBOARD")).toBeNull();
  });

  it("an expired skip brings the wall back", async () => {
    rememberVerifySkip("u-77", Date.now() - 8 * 24 * 60 * 60 * 1000);
    sessionStorage.clear();
    authState = makeAuth(owner());
    await signIn();
    expect(await screen.findByText("verifyEmailHeading")).toBeTruthy();
  });

  it("a skip on ANOTHER account on this device does not count", async () => {
    rememberVerifySkip("someone-else");
    sessionStorage.clear();
    authState = makeAuth(owner());
    await signIn();
    expect(await screen.findByText("verifyEmailHeading")).toBeTruthy();
  });
});

describe("postLoginPath", () => {
  it("follows the grace date, the confirmation and the skip", () => {
    expect(postLoginPath(owner())).toBe("/verify-email");
    expect(postLoginPath(owner({ email_verified: true }))).toBe("/dashboard");
    expect(postLoginPath(owner({ created_at: PRE_GRACE }))).toBe("/dashboard");
    expect(postLoginPath(owner({ created_at: null }))).toBe("/dashboard");
    expect(postLoginPath(null)).toBe("/dashboard");
    rememberVerifySkip("u-77");
    expect(postLoginPath(owner())).toBe("/dashboard");
    clearVerifySkip("u-77");
    expect(postLoginPath(owner())).toBe("/verify-email");
  });
});
