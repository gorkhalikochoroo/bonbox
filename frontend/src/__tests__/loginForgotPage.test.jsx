/**
 * Push 6 — /login and /forgot-password: the shell's labelled fields, every
 * error in the owner's language (the hard-coded English at LoginPage's catch
 * is gone), and the address carried between the pages without a URL.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { da } from "../i18n/da";

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
const api = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn(() => Promise.resolve({ data: {} })) }));
vi.mock("../services/api", () => ({ default: api }));
let authState;
vi.mock("../hooks/useAuth", () => ({ useAuth: () => authState }));
vi.mock("../components/AppleSignInButton", () => ({ default: () => null }));

const LoginPage = (await import("../pages/LoginPage")).default;
const ForgotPasswordPage = (await import("../pages/ForgotPasswordPage")).default;
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname}|{JSON.stringify(loc.state)}</p>;
}
const at = (entry) => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/forgot-password" element={<ForgotPasswordPage />} />
      <Route path="*" element={<Where />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  api.post.mockReset();
  authState = { login: vi.fn(), googleLogin: vi.fn(), googleOauthLogin: vi.fn(), appleOauthLogin: vi.fn() };
});
afterEach(cleanup);

describe("/login", () => {
  const signIn = async (email = "ole@cafe.dk", pw = "Forkert123") => {
    fireEvent.change(screen.getByLabelText(da.emailLabel), { target: { value: email } });
    fireEvent.change(screen.getByLabelText(da.passwordLabel), { target: { value: pw } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.suSignInBtn })); });
  };

  it("labelled fields, autocomplete, noValidate, one <main>, the forest CTA", () => {
    const { container } = at("/login");
    expect(screen.getByLabelText(da.emailLabel).getAttribute("autocomplete")).toBe("email");
    expect(screen.getByLabelText(da.passwordLabel).getAttribute("autocomplete")).toBe("current-password");
    expect(container.querySelector("form").noValidate).toBe(true);
    expect(container.querySelectorAll("main")).toHaveLength(1);
    expect(screen.getByRole("button", { name: da.suSignInBtn }).className).toMatch(/bg-bb-forest/);
    // the language picker sits under the column, not in a top bar
    expect(container.querySelector("header")).toBeNull();
    expect(screen.getByRole("combobox", { name: da.regLanguageLabel })).toBeTruthy();
  });

  it("401 → suLoginWrong with 'Lav en ny adgangskode', which fills the address in on /forgot-password", async () => {
    authState.login.mockRejectedValueOnce({ response: { status: 401, data: { detail: "Invalid email or password" } } });
    at("/login");
    await signIn();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain(da.suLoginWrong);
    expect(document.body.textContent).not.toContain("Invalid email or password");
    fireEvent.click(screen.getByRole("link", { name: da.suResetLink }));
    // prefill only — nothing is mailed until the owner presses the button
    expect(screen.getByLabelText(da.fpEmailAddress).value).toBe("ole@cafe.dk");
    expect(api.post).not.toHaveBeenCalled();
  });

  it.each([
    [{ code: "ERR_NETWORK", message: "Network Error" }, "suErrOffline"],
    [{ code: "ECONNABORTED", message: "timeout" }, "suErrTimeout"],
    [{ response: { status: 502 } }, "suErrServer"],
    [{ response: { status: 429, data: { detail: "Rate limit exceeded" } } }, "tooManyAttempts"],
  ])("%j → %s (no hard-coded English)", async (err, key) => {
    authState.login.mockRejectedValueOnce(err);
    at("/login");
    await signIn();
    expect(screen.getByRole("alert").textContent).toBe(da[key]);
    expect(document.body.textContent).not.toMatch(/Cannot reach server|Server is waking up|Server error/);
  });

  it("an empty submit is answered under the fields, in Danish", async () => {
    at("/login");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.suSignInBtn })); });
    expect(screen.getByText(da.suErrEmailEmpty)).toBeTruthy();
    expect(authState.login).not.toHaveBeenCalled();
  });

  it("'Opret konto' and 'Glemt?' carry the typed address as router state, never in the URL", () => {
    at("/login");
    fireEvent.change(screen.getByLabelText(da.emailLabel), { target: { value: "ole@cafe.dk" } });
    fireEvent.click(screen.getByRole("link", { name: da.createAccount }));
    expect(screen.getByTestId("where").textContent).toBe('/register|{"email":"ole@cafe.dk"}');
  });

  it("an address from /register is filled in", () => {
    at({ pathname: "/login", state: { email: "ole@cafe.dk" } });
    expect(screen.getByLabelText(da.emailLabel).value).toBe("ole@cafe.dk");
  });

  it("the e-mail-link 'sent' panel says the link also creates an account", async () => {
    api.post.mockResolvedValueOnce({ data: {} });
    at("/login");
    fireEvent.click(screen.getByRole("button", { name: da.useEmailInstead }));
    fireEvent.change(screen.getByLabelText(da.emailLabel), { target: { value: "ny@cafe.dk" } });
    await act(async () => { fireEvent.submit(document.querySelector("form")); });
    expect(screen.getByText(da.magicLinkSent)).toBeTruthy();
    expect(document.body.textContent).toContain("Vi sender et login-link til ny@cafe.dk. Det virker i 15 minutter. Har du ingen konto endnu, opretter linket en til dig.");
    expect(da.magicLinkSent).toBe("Tjek din e-mail");
  });

  it("the frozen pieces are where they were (source contract)", () => {
    const src = fs.readFileSync(path.join(SRC, "pages/LoginPage.jsx"), "utf8");
    expect(src.match(/<SignupTermsLine variant="continue"/g)).toHaveLength(2);
    expect(src).toContain("withSignupRef(withTermsAcceptance({ email: email.trim().toLowerCase() }, { acceptTerms: true }))");
    expect(src).toContain("bonbox:api-retry-exhausted");
  });
});

describe("/forgot-password", () => {
  it("labels, ids and autocomplete on every field", async () => {
    api.post.mockResolvedValueOnce({ data: { message: "If an account exists with that email, we've sent a reset code." } });
    at({ pathname: "/forgot-password", state: { prefillEmail: "ole@cafe.dk" } });
    const email = screen.getByLabelText(da.fpEmailAddress);
    expect(email.id).toBe("fp-email");
    expect(email.getAttribute("autocomplete")).toBe("email");
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.sendResetCode })); });
    expect(api.post).toHaveBeenCalledWith("/auth/forgot-password", { email: "ole@cafe.dk" });
    expect(screen.getByLabelText(da.fpSixDigitCode).getAttribute("autocomplete")).toBe("one-time-code");
    expect(screen.getByLabelText(da.fpNewPassword).getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByLabelText(da.fpConfirmPassword).getAttribute("autocomplete")).toBe("new-password");
    expect(screen.getByLabelText(da.fpNewPassword).id).toBe("fp-new");
    expect(screen.getByLabelText(da.fpConfirmPassword).id).toBe("fp-confirm");
    expect(screen.getByLabelText(da.fpSixDigitCode).id).toBe("fp-code");
  });

  it("offline says suErrOffline, not axios's 'Network Error'", async () => {
    api.post.mockRejectedValueOnce({ code: "ERR_NETWORK", message: "Network Error" });
    at({ pathname: "/forgot-password", state: { prefillEmail: "ole@cafe.dk" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.sendResetCode })); });
    expect(screen.getByRole("alert").textContent).toBe(da.suErrOffline);
    expect(document.body.textContent).not.toContain("Network Error");
  });

  it("a wrong code → suErrResetCode; success ignores the server's English and says suResetDone", async () => {
    api.post
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce({ response: { status: 400, data: { detail: "Invalid or expired reset code" } } })
      .mockResolvedValueOnce({ data: { message: "Password reset successfully" } });
    at({ pathname: "/forgot-password", state: { prefillEmail: "ole@cafe.dk" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.sendResetCode })); });
    fireEvent.change(screen.getByLabelText(da.fpSixDigitCode), { target: { value: "123456" } });
    fireEvent.change(screen.getByLabelText(da.fpNewPassword), { target: { value: "NyKaffe2026" } });
    fireEvent.change(screen.getByLabelText(da.fpConfirmPassword), { target: { value: "NyKaffe2026" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.resetPasswordBtn })); });
    expect(screen.getByRole("alert").textContent).toBe(da.suErrResetCode);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.resetPasswordBtn })); });
    expect(screen.getByText(da.suResetDone)).toBeTruthy();
    expect(document.body.textContent).not.toContain("Password reset successfully");
  });

  it("LoginMagicPage's hand-over (state.email) still sends the code at once", async () => {
    api.post.mockResolvedValueOnce({ data: {} });
    at({ pathname: "/forgot-password", state: { email: "ole@cafe.dk" } });
    await act(async () => {});
    expect(api.post).toHaveBeenCalledWith("/auth/forgot-password", { email: "ole@cafe.dk" });
  });
});
