/**
 * Release gate R-b (9 Oct), blocker — the wizard's finish lands where it says.
 *
 * Finishing the café wizard ("Afslut & start", or "Send invitation og afslut"
 * with a revisor typed) must land on "Du er klar" (/getting-started), and a
 * revisor invite the server saved but did not mail must be said there
 * (RevisorInviteHeldNotice, from router state). It landed on /dashboard with
 * no state: refreshUser() set onboarding_completed_at while the page was still
 * on /onboarding (React Router 7 applies the finish navigation as a
 * transition, so the user update renders first), and the "already completed →
 * /dashboard" guards replaced the destination and its state.
 *
 * Unlike onboardingOwnBusinessFirst.test.jsx (navigate mocked — the race never
 * shows there), this mounts the REAL BrowserRouter, the real OnboardingRoute
 * guard from App.jsx and the real OnboardingPage, with a refreshUser that
 * really sets the completed user, and reads where the browser ends up.
 */
import { Suspense } from "react";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(() => Promise.resolve({ data: {} })),
  patch: vi.fn(() => Promise.resolve({ data: {} })),
  inviteAnswer: null,
}));

vi.mock("../services/api", () => ({
  default: { get: h.get, post: h.post, put: h.put, patch: h.patch },
}));

// A real auth state: refreshUser re-reads /auth/me and sets the user, as
// AuthProvider does — which is what re-renders the /onboarding guards.
vi.mock("../hooks/useAuth", async () => {
  const React = await import("react");
  const api = (await import("../services/api")).default;
  const Ctx = React.createContext(null);
  function TestAuthProvider({ initial, children }) {
    const [user, setUser] = React.useState(initial);
    const refreshUser = React.useCallback(async () => {
      const res = await api.get("/auth/me");
      setUser(res.data);
      return res.data;
    }, []);
    const value = React.useMemo(() => ({
      user, loading: false, needsEmailVerification: () => false, refreshUser,
    }), [user, refreshUser]);
    return React.createElement(Ctx.Provider, { value }, children);
  }
  return {
    useAuth: () => React.useContext(Ctx),
    AuthProvider: TestAuthProvider,
  };
});
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: "da",
    t: (k, fb, vars) => {
      let s = typeof fb === "string" ? k : k;
      const v = typeof fb === "object" && fb ? fb : vars;
      if (v) s = `${s}:${Object.values(v).join("|")}`;
      return s;
    },
    setLang: () => {},
    LANGUAGES: [],
  }),
  LanguageProvider: ({ children }) => children,
  detectInitialLanguage: () => "da",
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ plan: "trial", isReady: true, hasFeature: () => true }),
  EntitlementsProvider: ({ children }) => children,
}));

const { AuthProvider } = await import("../hooks/useAuth");
const { OnboardingRoute } = await import("../App");
const RevisorInviteHeldNotice = (await import("../components/RevisorInviteHeldNotice")).default;
const { clearFinishTarget } = await import("../utils/onboardingFinish");

const OWNER = {
  id: "u1", email: "ejer@cafe.dk", business_name: "Café Solsikken", business_type: "cafe",
  currency: "DKK", role: "owner", email_verified: false, onboarding_completed_at: null,
  created_at: "2026-10-09T10:00:00",
};

function GettingStarted() {
  return (
    <div>
      <p>DU_ER_KLAR</p>
      <RevisorInviteHeldNotice />
    </div>
  );
}

function app() {
  return render(
    <AuthProvider initial={OWNER}>
      <BrowserRouter>
        <Suspense fallback={<p>loading</p>}>
          <Routes>
            <Route path="/onboarding" element={<OnboardingRoute />} />
            <Route path="/getting-started" element={<GettingStarted />} />
            <Route path="/dashboard" element={<p>DASHBOARD</p>} />
          </Routes>
        </Suspense>
      </BrowserRouter>
    </AuthProvider>,
  );
}

async function toStep4() {
  app();
  fireEvent.click(await screen.findByText("onbStep1Cta"));
  await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
  await screen.findByTestId("onb-acct-no-mail");
  await act(async () => { fireEvent.click(screen.getByText("onbNext")); });
  await screen.findByTestId("onb-explore-sample");
}

beforeEach(() => {
  window.history.replaceState(null, "", "/onboarding");
  window.scrollTo = () => {};
  clearFinishTarget();
  h.inviteAnswer = { data: { email_sent: false, email_not_sent_reason: "email_unverified" } };
  h.get.mockReset();
  h.get.mockImplementation((url) => {
    if (url === "/pillars/preset") return Promise.resolve({ data: { suggested: [] } });
    if (url === "/auth/me") {
      return Promise.resolve({ data: { ...OWNER, onboarding_completed_at: "2026-10-09T13:03:35" } });
    }
    return Promise.resolve({ data: {} });
  });
  h.post.mockReset();
  h.post.mockImplementation((url) => {
    if (url === "/accountants/invite") return Promise.resolve(h.inviteAnswer);
    return Promise.resolve({ data: { ok: true } });
  });
});
afterEach(() => {
  clearFinishTarget();
  window.history.replaceState(null, "", "/");
});

describe("the wizard's finish lands where it says (real router, real guards)", () => {
  it("'Afslut & start' → 'Du er klar' (/getting-started), never overridden to /dashboard", async () => {
    await toStep4();
    await act(async () => { fireEvent.click(screen.getByText("onbFinishToFirstWin")); });
    expect(await screen.findByText("DU_ER_KLAR")).toBeInTheDocument();
    // Let every queued navigation and effect run: still there.
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(window.location.pathname).toBe("/getting-started");
    expect(screen.queryByText("DASHBOARD")).toBeNull();
    expect(h.post).toHaveBeenCalledWith("/auth/onboarding/complete");
  });

  it("'Send invitation og afslut' with the invite held → /getting-started WITH the 'gemt, men ikke sendt' line", async () => {
    await toStep4();
    fireEvent.change(document.getElementById("onb-revisor-email"), { target: { value: "anna@revisor.dk" } });
    await act(async () => { fireEvent.click(screen.getByText("onbStep4Finish")); });
    expect(await screen.findByText("DU_ER_KLAR")).toBeInTheDocument();
    for (let i = 0; i < 5; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(window.location.pathname).toBe("/getting-started");
    expect(window.history.state?.usr).toMatchObject({ revisorInviteHeld: true, revisorInviteHeldReason: "email_unverified" });
    const held = screen.getByTestId("revisor-invite-held-after-onboarding");
    expect(held.textContent).toContain("onbRevisorInviteHeld");
    expect(h.post).toHaveBeenCalledWith("/accountants/invite", { email: "anna@revisor.dk", name: null });
  });

  it("the completed-user bounce still guards the wizard once the finish is over (back button → /dashboard)", async () => {
    await toStep4();
    await act(async () => { fireEvent.click(screen.getByText("onbFinishToFirstWin")); });
    await screen.findByText("DU_ER_KLAR");
    // The finish is over (its target has lapsed): /onboarding again is the dashboard.
    clearFinishTarget();
    await act(async () => {
      window.history.pushState(null, "", "/onboarding");
      window.dispatchEvent(new PopStateEvent("popstate"));
    });
    await waitFor(() => expect(window.location.pathname).toBe("/dashboard"));
    expect(await screen.findByText("DASHBOARD")).toBeInTheDocument();
  });
});
