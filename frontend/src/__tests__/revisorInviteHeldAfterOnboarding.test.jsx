/**
 * The onboarding wizard's revisor invite was SAVED, not e-mailed (the owner's
 * own e-mail is unconfirmed). The wizard finishes and redirects at once, so a
 * notice inside it was on screen for one round-trip (review, 8 Oct). The held
 * state now travels with the redirect and the landing page says it.
 *
 * Real router here (no navigate mock): the assertion is made AFTER the route
 * change, with the wizard gone.
 *
 * Also: a revisor login is never sent to the verification wall — its session
 * is read-only (the server refuses the code request and check), and one made
 * from a never-mailed invite link is deliberately left unconfirmed.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const h = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(() => Promise.resolve({ data: {} })),
  patch: vi.fn(() => Promise.resolve({ data: {} })),
  user: null,
}));

vi.mock("../services/api", () => ({
  default: { get: h.get, post: h.post, put: h.put, patch: h.patch },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: h.user, refreshUser: vi.fn(() => Promise.resolve()) }),
}));
vi.mock("../hooks/useLanguage", async () => {
  const { en } = await import("../i18n/en");
  return {
    useLanguage: () => ({
      lang: "en",
      t: (k, fb, vars) => {
        let s = en[k] ?? (typeof fb === "string" ? fb : k);
        const v = typeof fb === "object" && fb ? fb : vars;
        if (v) Object.entries(v).forEach(([a, b]) => { s = s.replace(`{${a}}`, String(b)); });
        return s;
      },
    }),
  };
});
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ plan: "trial", isReady: true, hasFeature: () => true }),
}));

import OnboardingPage from "../pages/OnboardingPage";
import RevisorInviteHeldNotice from "../components/RevisorInviteHeldNotice";
import { postLoginPath } from "../utils/verifySkip";

const OWNER = {
  id: "u1", business_name: "Café Solsikken", business_type: "cafe",
  currency: "DKK", role: "owner", onboarding_completed_at: null, email_verified: false,
};

beforeEach(() => {
  h.user = { ...OWNER };
  h.get.mockReset();
  h.get.mockImplementation((url) => {
    if (url === "/pillars/preset") return Promise.resolve({ data: { suggested: [] } });
    return Promise.resolve({ data: {} });
  });
  h.post.mockReset();
  h.post.mockImplementation((url) => (
    url === "/accountants/invite"
      ? Promise.resolve({ data: {
        id: "g1", status: "pending", accept_url: "https://bonbox.dk/accept-invite/x",
        email_sent: false, email_not_sent_reason: "email_unverified",
      } })
      : Promise.resolve({ data: { ok: true } })
  ));
});

function App() {
  return (
    <MemoryRouter initialEntries={["/onboarding"]}>
      <Routes>
        <Route path="/onboarding" element={<OnboardingPage />} />
        <Route
          path="/getting-started"
          element={<div data-testid="landed"><RevisorInviteHeldNotice /></div>}
        />
      </Routes>
    </MemoryRouter>
  );
}

async function finishWithHeldInvite() {
  render(<App />);
  fireEvent.click(screen.getByText("Get started"));
  await act(async () => { fireEvent.click(screen.getByText("Next")); });
  await screen.findByTestId("onb-acct-no-mail");
  await act(async () => { fireEvent.click(screen.getByText("Next")); });
  await screen.findByTestId("onb-explore-sample");
  fireEvent.change(document.getElementById("onb-revisor-email"), { target: { value: "revisor@regnskab.dk" } });
  await act(async () => { fireEvent.click(screen.getByText("Send invite & finish")); });
}

describe("after the wizard, a held revisor invite", () => {
  it("is still said on the page the wizard landed on", async () => {
    await finishWithHeldInvite();
    await waitFor(() => expect(screen.getByTestId("landed")).toBeInTheDocument());
    // The wizard is gone — this is the landing page speaking.
    expect(screen.queryByTestId("onb-explore-sample")).toBeNull();
    const notice = screen.getByTestId("revisor-invite-held-after-onboarding");
    expect(notice.textContent).toMatch(/invite is saved, but not e-mailed yet/);
    expect(notice.textContent).not.toMatch(/mail to others/);
    const link = screen.getByText("Confirm now");
    expect(link.closest("a").getAttribute("href")).toBe("/verify-email?now=1");
  });

  it("can be hidden", async () => {
    await finishWithHeldInvite();
    await waitFor(() => expect(screen.getByTestId("landed")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Hide for now" }));
    expect(screen.queryByTestId("revisor-invite-held-after-onboarding")).toBeNull();
  });
});

describe("RevisorInviteHeldNotice", () => {
  const at = (state) => render(
    <MemoryRouter initialEntries={[{ pathname: "/dashboard", state }]}>
      <RevisorInviteHeldNotice />
    </MemoryRouter>,
  );

  it("renders nothing without the wizard's state", () => {
    at(undefined);
    expect(screen.queryByTestId("revisor-invite-held-after-onboarding")).toBeNull();
  });

  it("renders nothing once the owner's e-mail is confirmed", () => {
    h.user = { ...OWNER, email_verified: true };
    at({ revisorInviteHeld: true });
    expect(screen.queryByTestId("revisor-invite-held-after-onboarding")).toBeNull();
  });
});

describe("a revisor login and the verification wall", () => {
  it("is never sent to /verify-email, confirmed or not", () => {
    const created_at = "2026-10-08T10:00:00";
    expect(postLoginPath({ id: "a1", role: "accountant", email_verified: false, created_at })).toBe("/dashboard");
    // An owner in the same state still meets it.
    expect(postLoginPath({ id: "o1", role: "owner", email_verified: false, created_at })).toBe("/verify-email");
  });
});
