/**
 * Danish first 15 minutes, item 2 — "Spring over for nu" is remembered.
 *
 * The skip lived in sessionStorage only, so the e-mail verification wall came
 * back on every new session. Now it is kept per account for 7 days
 * (utils/verifySkip), a quiet "Bekræft din e-mail" reminder stays in the app
 * meanwhile, and the day's close is never taken away by the wall.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

import {
  VERIFY_SKIP_MS, clearVerifySkip, rememberVerifySkip, verifySkipActive, verifyWallExempt,
} from "../utils/verifySkip";

const h = vi.hoisted(() => ({
  user: { id: "u1", email: "ejer@cafe.dk", email_verified: false },
  needs: true,
  post: vi.fn(() => Promise.resolve({ data: {} })),
  navigate: vi.fn(),
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({
    user: h.user,
    needsEmailVerification: () => h.needs,
    setEmailVerified: vi.fn(),
  }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k, fb) => (typeof fb === "string" ? fb : k), lang: "da" }),
}));
vi.mock("../services/api", () => ({ default: { post: h.post } }));
vi.mock("react-router-dom", async (orig) => {
  const mod = await orig();
  return { ...mod, useNavigate: () => h.navigate };
});

import VerifyEmailReminder from "../components/VerifyEmailReminder";
import VerifyEmailPage from "../pages/VerifyEmailPage";

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
  h.needs = true;
  h.user = { id: "u1", email: "ejer@cafe.dk", email_verified: false };
  h.navigate.mockClear();
});

describe("verifySkip — the 7-day memory", () => {
  it("survives a new session for 7 days, then the wall may ask again", () => {
    const now = 1_760_000_000_000;
    rememberVerifySkip("u1", now);
    sessionStorage.clear(); // a new session (the old flag is gone)
    expect(verifySkipActive("u1", now + 1000)).toBe(true);
    expect(verifySkipActive("u1", now + VERIFY_SKIP_MS - 1)).toBe(true);
    expect(verifySkipActive("u1", now + VERIFY_SKIP_MS + 1)).toBe(false);
  });

  it("is per account — another login on the same phone is not skipped", () => {
    rememberVerifySkip("u1");
    sessionStorage.clear();
    expect(verifySkipActive("u1")).toBe(true);
    expect(verifySkipActive("u2")).toBe(false);
  });

  it("still honours the old session flag (native signup, older tabs)", () => {
    sessionStorage.setItem("skip_email_verify", "1");
    expect(verifySkipActive("anyone")).toBe(true);
  });

  it("is forgotten once the e-mail is verified", () => {
    rememberVerifySkip("u1");
    clearVerifySkip("u1");
    expect(verifySkipActive("u1")).toBe(false);
  });

  it("never throws when storage is blocked", () => {
    const boom = () => { throw new Error("blocked"); };
    const spies = [localStorage, sessionStorage].flatMap((st) => [
      vi.spyOn(st, "getItem").mockImplementation(boom),
      vi.spyOn(st, "setItem").mockImplementation(boom),
      vi.spyOn(st, "removeItem").mockImplementation(boom),
    ]);
    expect(() => rememberVerifySkip("u1")).not.toThrow();
    expect(verifySkipActive("u1")).toBe(false);
    expect(() => clearVerifySkip("u1")).not.toThrow();
    spies.forEach((s) => s.mockRestore());
  });

  it("the day's close is exempt from the wall", () => {
    expect(verifyWallExempt("/daily-close")).toBe(true);
    expect(verifyWallExempt("/daily-close/history")).toBe(true);
    expect(verifyWallExempt("/dashboard")).toBe(false);
    expect(verifyWallExempt("/daily-closet")).toBe(false);
  });
});

describe("the verification page's skip", () => {
  it("'Spring over for nu' remembers the skip for this account and goes on", () => {
    render(<MemoryRouter initialEntries={["/verify-email"]}><VerifyEmailPage /></MemoryRouter>);
    fireEvent.click(screen.getByText("Skip for now"));
    sessionStorage.clear(); // next session
    expect(verifySkipActive("u1")).toBe(true);
    expect(h.navigate).toHaveBeenCalledWith("/dashboard");
    // and the page says what skipping does
    expect(screen.getByText(/next 7 days you'll see a small reminder/)).toBeInTheDocument();
  });
});

describe("VerifyEmailReminder — the quiet 'Bekræft din e-mail'", () => {
  const at = (path) => render(
    <MemoryRouter initialEntries={[path]}><VerifyEmailReminder /></MemoryRouter>,
  );

  it("shows while the owner has skipped, linking to the page on purpose", () => {
    rememberVerifySkip("u1");
    at("/dashboard");
    const link = screen.getByText("Confirm your e-mail");
    expect(link.closest("a").getAttribute("href")).toBe("/verify-email?now=1");
  });

  it("is quiet on the day's close", () => {
    rememberVerifySkip("u1");
    at("/daily-close");
    expect(screen.queryByTestId("verify-email-reminder")).toBeNull();
  });

  it("is absent without a skip, and once verified", () => {
    at("/dashboard");
    expect(screen.queryByTestId("verify-email-reminder")).toBeNull();
    rememberVerifySkip("u1");
    h.needs = false;
    at("/dashboard");
    expect(screen.queryByTestId("verify-email-reminder")).toBeNull();
  });

  it("× hides it for this session only", () => {
    rememberVerifySkip("u1");
    const { unmount } = at("/dashboard");
    fireEvent.click(screen.getByLabelText("Hide for now"));
    expect(screen.queryByTestId("verify-email-reminder")).toBeNull();
    unmount();
    at("/dashboard");
    expect(screen.queryByTestId("verify-email-reminder")).toBeNull();
    // a new session brings it back
    sessionStorage.removeItem("bonbox_verify_reminder_hidden");
    at("/expenses");
    expect(screen.getByTestId("verify-email-reminder")).toBeInTheDocument();
  });
});
