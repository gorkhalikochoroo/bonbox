/**
 * bonbox.dk/staff opens Vagtplan, never the guests' booking page (Push 8).
 *
 * "staff" is a reserved word on the backend (RESERVED_SLUGS) — no venue can
 * hold it — but App.jsx had no /staff route, so the address fell to "/:slug"
 * and a signed-in owner saw "Dette link er ikke åbent for booking". Now:
 * signed in → /staff/schedule; signed out → /login?next=/staff/schedule, and
 * the sign-in lands on the schedule. The login's ?next= takes an in-app path
 * only, and the verification wall still comes first.
 */
import { Suspense } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { post: vi.fn(() => Promise.resolve({ data: {} })), get: vi.fn(() => Promise.resolve({ data: {} })) },
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

const { StaffEntryRedirect, VerifyEmailRoute } = await import("../App");
const LoginPage = (await import("../pages/LoginPage")).default;

const VERIFIED = { id: "u-1", email: "ejer@cafe.dk", email_verified: true, created_at: "2026-09-01T10:00:00" };

function auth({ user = null, loading = false, signsInAs = VERIFIED } = {}) {
  const state = {
    user,
    loading,
    setEmailVerified: vi.fn(),
    needsEmailVerification: () => {
      const u = state.user;
      return !!u && !u.email_verified && new Date(u.created_at) >= new Date("2026-04-13T00:00:00");
    },
    login: vi.fn(async () => {
      state.user = signsInAs;
      return { user: signsInAs };
    }),
    googleLogin: vi.fn(),
    googleOauthLogin: vi.fn(),
    appleOauthLogin: vi.fn(),
  };
  return state;
}

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname + loc.search}</p>;
}

function mount(path) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Suspense fallback={<p>loading</p>}>
        <Routes>
          <Route path="/staff" element={<StaffEntryRedirect />} />
          <Route path="/staff/schedule" element={<p>SCHEDULE</p>} />
          <Route path="/login" element={<><LoginPage /><Where /></>} />
          <Route path="/verify-email" element={<VerifyEmailRoute />} />
          <Route path="/dashboard" element={<p>DASHBOARD</p>} />
          <Route path="/:slug" element={<p>GUEST BOOKING PAGE</p>} />
        </Routes>
      </Suspense>
    </MemoryRouter>,
  );
}

function signIn(container) {
  fireEvent.change(container.querySelector("#email"), { target: { value: "ejer@cafe.dk" } });
  fireEvent.change(container.querySelector("#password"), { target: { value: "hemmelig-123" } });
  fireEvent.submit(container.querySelector("form"));
}

beforeEach(() => {
  try { sessionStorage.clear(); localStorage.clear(); } catch { /* jsdom */ }
});
afterEach(() => vi.clearAllMocks());

describe("/staff", () => {
  it("a signed-in owner lands on the schedule, not the guest page", async () => {
    authState = auth({ user: VERIFIED });
    mount("/staff");
    expect(await screen.findByText("SCHEDULE")).toBeTruthy();
    expect(screen.queryByText("GUEST BOOKING PAGE")).toBeNull();
  });

  it("a signed-out visitor is sent to sign in, then lands on the schedule", async () => {
    authState = auth();
    const { container } = mount("/staff");
    expect((await screen.findByTestId("where")).textContent).toBe("/login?next=/staff/schedule");
    signIn(container);
    expect(await screen.findByText("SCHEDULE")).toBeTruthy();
  });

  it("waits for the session check instead of guessing", () => {
    authState = auth({ loading: true });
    mount("/staff");
    expect(screen.queryByText("SCHEDULE")).toBeNull();
    expect(screen.queryByTestId("where")).toBeNull();
    expect(screen.queryByText("GUEST BOOKING PAGE")).toBeNull();
  });
});

describe("/login?next=", () => {
  it("ignores a next that leaves the site", async () => {
    authState = auth();
    const { container } = mount("/login?next=//evil.example");
    signIn(container);
    expect(await screen.findByText("DASHBOARD")).toBeTruthy();
  });

  it("the verification wall still comes first", async () => {
    authState = auth({ signsInAs: { ...VERIFIED, email_verified: false } });
    const { container } = mount("/login?next=/staff/schedule");
    signIn(container);
    expect(await screen.findByText("verifyEmailHeading")).toBeTruthy();
    expect(screen.queryByText("SCHEDULE")).toBeNull();
  });
});
