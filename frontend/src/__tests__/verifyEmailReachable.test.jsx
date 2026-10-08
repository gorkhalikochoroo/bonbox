/**
 * /verify-email must be reachable for every unconfirmed owner (review, 8 Oct).
 *
 * The backend now refuses faktura mail and team invites for an account whose
 * own address is not confirmed (403 email_unverified), and the refusal points
 * the owner to Profile → Ikke bekræftet → /verify-email. VerifyEmailRoute used
 * to bounce anyone the grace date exempted (every account created before
 * 2026-04-13) or who tapped "skip" straight back to /dashboard — so the fix
 * the message named was a dead end, and those features were a permanent 403
 * for two-thirds of real accounts.
 *
 * The grace date still decides who is SENT to the page; only a confirmed
 * address now leaves it. An owner who arrives on purpose was mailed nothing,
 * so the page mails a fresh code on arrival — once.
 */
import { Suspense } from "react";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
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

const { VerifyEmailRoute } = await import("../App");
const VerifyEmailPage = (await import("../pages/VerifyEmailPage")).default;

const PRE_GRACE = "2026-02-01T10:00:00";
const POST_GRACE = "2026-09-01T10:00:00";

function owner(over = {}) {
  return { id: 1, email: "ejer@cafe.dk", email_verified: false, created_at: PRE_GRACE, ...over };
}

function authFor(user) {
  const needs = () =>
    !!user && !user.email_verified && !!user.created_at && new Date(user.created_at) >= new Date("2026-04-13T00:00:00");
  return { user, loading: false, needsEmailVerification: needs, setEmailVerified: vi.fn() };
}

function openVerify() {
  return render(
    <MemoryRouter initialEntries={["/verify-email"]}>
      <Suspense fallback={<p>loading</p>}>
        <Routes>
          <Route path="/verify-email" element={<VerifyEmailRoute />} />
          <Route path="/dashboard" element={<p>DASHBOARD</p>} />
        </Routes>
      </Suspense>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({ data: { message: "Verification code sent" } });
  try { sessionStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => vi.clearAllMocks());

describe("VerifyEmailRoute", () => {
  it("a pre-grace owner who is not verified sees the verify page, not the dashboard", async () => {
    authState = authFor(owner());
    openVerify();
    expect(await screen.findByText("verifyEmailHeading")).toBeTruthy();
    expect(screen.queryByText("DASHBOARD")).toBeNull();
  });

  it("an owner who tapped skip can still come back on purpose", async () => {
    sessionStorage.setItem("skip_email_verify", "1");
    authState = authFor(owner({ created_at: POST_GRACE }));
    openVerify();
    expect(await screen.findByText("verifyEmailHeading")).toBeTruthy();
  });

  it("a verified owner is sent on to the dashboard", async () => {
    authState = authFor(owner({ email_verified: true }));
    openVerify();
    expect(await screen.findByText("DASHBOARD")).toBeTruthy();
  });

  it("an owner who came on purpose is mailed a fresh code, once", async () => {
    authState = authFor(owner());
    openVerify();
    await screen.findByText("verifyEmailHeading");
    await waitFor(() => expect(post).toHaveBeenCalledWith("/auth/resend-verification"));
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("a fresh signup sent here at registration is not mailed a second code", async () => {
    authState = authFor(owner({ created_at: POST_GRACE }));
    openVerify();
    await screen.findByText("verifyEmailHeading");
    expect(post).not.toHaveBeenCalled();
  });
});

describe("VerifyEmailPage sendOnArrival", () => {
  it("says so when the code could not be sent, and leaves Resend open", async () => {
    authState = authFor(owner());
    post.mockRejectedValueOnce({ response: { status: 500 } });
    render(
      <MemoryRouter>
        <VerifyEmailPage sendOnArrival />
      </MemoryRouter>,
    );
    expect(await screen.findByText("couldNotResendCode")).toBeTruthy();
    const resend = screen.getByText("resendCode").closest("button");
    expect(resend.disabled).toBe(false);
  });
});
