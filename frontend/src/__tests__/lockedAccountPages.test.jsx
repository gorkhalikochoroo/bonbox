/**
 * Combined fix round (11 Oct) — a locked account on the pages that now get
 * the backend's 401 "Account is locked. Contact support."
 * (services/auth.LOCKED_ACCOUNT_DETAIL):
 *
 *   • /forgot-password (reset step) — said "wrong code" (suErrResetCode), so
 *     the owner would ask for code after code; now magicLinkLocked.
 *   • /accept-invite/team/:token — the 401 bounced the browser to /login
 *     (the interceptor's redirect) and the page would have shown the
 *     server's English; now the page stays and says magicLinkLocked.
 *   • /login/magic — already said magicLinkLocked (code account_locked).
 *
 * magicLinkLocked has real en + da text: "This account is locked. Contact
 * support." / "Denne konto er låst. Kontakt support."
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  return {
    useLanguage: () => ({
      lang: "da",
      setLang: () => {},
      LANGUAGES: [{ code: "da", label: "Dansk" }, { code: "en", label: "English" }],
      t: (k, fb, vars) => {
        const v = typeof fb === "object" && fb ? fb : vars;
        let s = DA[k] ?? (typeof fb === "string" ? fb : k);
        if (v && typeof s === "string") s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
        return s;
      },
    }),
    LanguageProvider: ({ children }) => children,
  };
});
const h = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock("../services/api", async (orig) => {
  const real = await orig();
  return { ...real, default: { post: (...a) => h.post(...a), get: (...a) => h.get(...a) } };
});
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ setUser: vi.fn() }) }));

const { on401 } = await import("../services/api");
const { AUTH_DETAIL, authErrorKey } = await import("../utils/authErrors");
const ForgotPasswordPage = (await import("../pages/ForgotPasswordPage")).default;
const TeamAcceptInvitePage = (await import("../pages/TeamAcceptInvitePage")).default;

const LOCKED = "Account is locked. Contact support.";
const locked401 = { response: { status: 401, data: { detail: LOCKED } } };

beforeEach(() => {
  h.post.mockReset();
  h.get.mockReset();
  h.get.mockResolvedValue({ data: {} });
});
afterEach(cleanup);

describe("the locked-account detail", () => {
  it("is the backend's sentence, mapped to magicLinkLocked on every auth page", () => {
    expect(AUTH_DETAIL.accountLocked).toBe(LOCKED);
    for (const ctx of ["reset", "forgot", "login", "magic", "oauth"]) {
      expect(authErrorKey(locked401, ctx).key).toBe("magicLinkLocked");
    }
    expect(en.magicLinkLocked).toBe("This account is locked. Contact support.");
    expect(da.magicLinkLocked).toBe("Denne konto er låst. Kontakt support.");
  });

  it("a wrong code is still the wrong-code line", () => {
    const wrong = { response: { status: 400, data: { detail: AUTH_DETAIL.resetInvalid } } };
    expect(authErrorKey(wrong, "reset").key).toBe("suErrResetCode");
  });
});

describe("an invite landing is not bounced to /login by a 401", () => {
  it("/accept-invite/team/… and /accept-invite/… keep the page; a stale token is still dropped", () => {
    expect(on401("/accept-invite/team/abc", "/team/accept-invite/abc")).toEqual({ redirect: false, wipeToken: true });
    expect(on401("/accept-invite/abc", "/accountants/signup")).toEqual({ redirect: false, wipeToken: true });
    expect(on401("/dashboard", "/sales").redirect).toBe(true);
  });
});

describe("/forgot-password", () => {
  it("a locked account's correct code says magicLinkLocked, not suErrResetCode", async () => {
    h.post.mockResolvedValueOnce({ data: {} }).mockRejectedValueOnce(locked401);
    render(
      <MemoryRouter initialEntries={[{ pathname: "/forgot-password", state: { prefillEmail: "ole@cafe.dk" } }]}>
        <Routes><Route path="/forgot-password" element={<ForgotPasswordPage />} /></Routes>
      </MemoryRouter>,
    );
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.sendResetCode })); });
    fireEvent.change(screen.getByLabelText(da.fpSixDigitCode), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText(da.fpNewPassword), { target: { value: "NyKaffe2026" } });
    fireEvent.change(screen.getByLabelText(da.fpConfirmPassword), { target: { value: "NyKaffe2026" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.resetPasswordBtn })); });
    expect(screen.getByRole("alert").textContent).toBe(da.magicLinkLocked);
    expect(document.body.textContent).not.toContain(LOCKED);
  });
});

describe("/accept-invite/team/:token", () => {
  it("a locked invitee is told the account is locked, in the owner's language", async () => {
    h.get.mockResolvedValue({ data: { email: "anna@cafe.dk", role: "cashier", owner_business_name: "Bon Bakery" } });
    h.post.mockRejectedValueOnce(locked401);
    const token = "A".repeat(43);
    const { container } = render(
      <MemoryRouter initialEntries={[`/accept-invite/team/${token}`]}>
        <Routes><Route path="/accept-invite/team/:token" element={<TeamAcceptInvitePage />} /></Routes>
      </MemoryRouter>,
    );
    const pw = await screen.findByPlaceholderText(da.taiPwPlaceholder || "At least 8 characters");
    fireEvent.change(pw, { target: { value: "annaspw123" } });
    const inputs = container.querySelectorAll('input[type="password"]');
    fireEvent.change(inputs[inputs.length - 1], { target: { value: "annaspw123" } });
    await act(async () => { fireEvent.submit(container.querySelector("form")); });
    expect(await screen.findByText(da.magicLinkLocked)).toBeTruthy();
    expect(document.body.textContent).not.toContain(LOCKED);
  });
});
