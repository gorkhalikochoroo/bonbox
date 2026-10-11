/**
 * Push 6 — Google's own button follows the page's language (B8).
 *
 * @react-oauth/google 0.13.4 leaves `locale` out of its context's useMemo,
 * so <GoogleLogin> never saw a language switch; remounting the provider
 * would have wiped the typed fields. GoogleButton re-renders Google's button
 * with the page's language, keeps what the owner typed, and hands the same
 * { credential } to the same calls (acceptTerms: true) as before.
 */
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { da } from "../i18n/da";
import { en } from "../i18n/en";
import { LanguageProvider } from "../hooks/useLanguage";

vi.mock("@react-oauth/google", () => ({
  GoogleOAuthProvider: ({ children }) => children,
  useGoogleOAuth: () => ({ clientId: "cid.apps.googleusercontent.com", scriptLoadedSuccessfully: true }),
}));
vi.mock("../services/api", () => ({ default: { get: vi.fn(() => Promise.resolve({ data: [] })), post: vi.fn(), put: vi.fn() } }));
const auth = vi.hoisted(() => ({ googleOauthLogin: null }));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ register: vi.fn(), login: vi.fn(), googleLogin: vi.fn(), googleOauthLogin: auth.googleOauthLogin, appleOauthLogin: vi.fn() }),
}));
vi.mock("../components/AppleSignInButton", () => ({ default: () => null }));

const RegisterPage = (await import("../pages/RegisterPage")).default;
const LoginPage = (await import("../pages/LoginPage")).default;
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let gsi;
beforeEach(() => {
  localStorage.clear();
  localStorage.setItem("lang", "da");
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com");
  auth.googleOauthLogin = vi.fn(() => Promise.resolve({ user: { id: 1, email_verified: true } }));
  gsi = { initialize: vi.fn(), renderButton: vi.fn() };
  window.google = { accounts: { id: gsi } };
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  delete window.google;
  localStorage.clear();
});

const lastRender = () => gsi.renderButton.mock.calls[gsi.renderButton.mock.calls.length - 1][1];
const renderIn = (Page, path) => render(
  <LanguageProvider><MemoryRouter initialEntries={[path]}><Page /></MemoryRouter></LanguageProvider>,
);

describe("GoogleButton on /register", () => {
  it("draws Google's button in Danish, redraws it in English on a switch, and keeps the typed e-mail", async () => {
    const { container } = renderIn(RegisterPage, "/register");
    expect(gsi.renderButton).toHaveBeenCalled();
    expect(lastRender()).toMatchObject({ locale: "da", text: "signup_with", size: "large", type: "standard", shape: "rectangular" });
    expect(gsi.initialize.mock.calls[0][0].client_id).toBe("cid.apps.googleusercontent.com");

    fireEvent.change(screen.getByLabelText(da.email), { target: { value: "ole@cafe.dk" } });
    const select = [...container.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "en"));
    await act(async () => { fireEvent.change(select, { target: { value: "en" } }); });

    expect(lastRender().locale).toBe("en");
    // Same page, same field — nothing remounted, nothing lost.
    expect(screen.getByLabelText(en.email).value).toBe("ole@cafe.dk");
  });

  it("Google's credential goes to the same call, with acceptTerms: true", async () => {
    renderIn(RegisterPage, "/register");
    const { callback } = gsi.initialize.mock.calls[0][0];
    await act(async () => { callback({ credential: "id-token-123", select_by: "btn" }); });
    expect(auth.googleOauthLogin).toHaveBeenCalledWith("id-token-123", { acceptTerms: true });
  });
});

describe("GoogleButton on /login", () => {
  it("follows the language too, and signs in with acceptTerms: true", async () => {
    const { container } = renderIn(LoginPage, "/login");
    expect(lastRender()).toMatchObject({ locale: "da", text: "signin_with" });
    const select = [...container.querySelectorAll("select")].find((s) => [...s.options].some((o) => o.value === "en"));
    await act(async () => { fireEvent.change(select, { target: { value: "en" } }); });
    expect(lastRender().locale).toBe("en");
    const { callback } = gsi.initialize.mock.calls[gsi.initialize.mock.calls.length - 1][0];
    await act(async () => { callback({ credential: "tok" }); });
    expect(auth.googleOauthLogin).toHaveBeenCalledWith("tok", { acceptTerms: true });
  });
});

describe("source contract", () => {
  const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
  it("the provider gets the page's language (?hl= on the script's first load)", () => {
    expect(read("App.jsx")).toContain("<GoogleOAuthProvider clientId={GOOGLE_CLIENT_ID} locale={lang}>");
  });
  it("both pages use GoogleButton, not <GoogleLogin>; LoginPage's dead locale prop is gone", () => {
    for (const page of ["pages/RegisterPage.jsx", "pages/LoginPage.jsx"]) {
      const src = read(page);
      expect(src, page).toContain("<GoogleButton");
      expect(src, page).not.toContain("<GoogleLogin");
      expect(src, page).toContain("fn(res.credential, { acceptTerms: true })");
    }
    expect(read("pages/LoginPage.jsx")).not.toMatch(/locale=\{lang\}/);
  });
});
