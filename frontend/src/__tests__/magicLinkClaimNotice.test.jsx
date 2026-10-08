/**
 * An e-mail link that confirms a never-confirmed address replaces the
 * account's old password and signs out other devices (backend
 * claim_unverified_account, review 8 Oct). That used to happen silently: the
 * page redirected in 250 ms and the owner's next password sign-in just failed.
 * Now the answer carries password_reset, and the page stops to say so, with
 * the way to a new password — and a normal sign-in still goes straight on.
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn();
vi.mock("../services/api", () => ({ default: { post: (...a) => post(...a), get: vi.fn(() => Promise.resolve({ data: {} })) } }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({}) }));

import LoginMagicPage from "../pages/LoginMagicPage";
import { LanguageProvider } from "../hooks/useLanguage";

const TOKEN = "b".repeat(43);

const open = () =>
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[`/login/magic?token=${TOKEN}`]}>
        <Routes>
          <Route path="/login/magic" element={<LoginMagicPage />} />
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  );

beforeEach(() => {
  post.mockReset();
  localStorage.clear();
  vi.useFakeTimers({ shouldAdvanceTime: true });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("magic-link sign-in that claimed an unconfirmed account", () => {
  it("stops and says the old password no longer works, with the way to a new one", async () => {
    post.mockResolvedValue({ data: { access_token: "jwt", password_reset: true, access_closed: false } });
    open();
    const box = await screen.findByTestId("magic-link-claimed");
    expect(screen.getByText("Your e-mail is confirmed")).toBeTruthy();
    expect(document.body.textContent).toMatch(/previous password no longer works/);
    expect(document.body.textContent).not.toMatch(/Revisor access and host-stand devices/);
    const link = screen.getByText("Choose a new password");
    expect(link.closest("a").getAttribute("href")).toBe("/forgot-password");
    expect(box.textContent).toMatch(/Continue to BonBox/);
    // No silent redirect: still on the notice after the old 250 ms.
    vi.advanceTimersByTime(1000);
    expect(screen.getByTestId("magic-link-claimed")).toBeTruthy();
  });

  it("names the closed revisor / host-stand access when there was any", async () => {
    post.mockResolvedValue({ data: { access_token: "jwt", password_reset: true, access_closed: true } });
    open();
    await screen.findByTestId("magic-link-claimed");
    expect(document.body.textContent).toMatch(/Revisor access and host-stand devices given before were closed too/);
  });

  it("an ordinary sign-in shows no notice", async () => {
    post.mockResolvedValue({ data: { access_token: "jwt", password_reset: false } });
    open();
    await waitFor(() => expect(screen.getByText("You're in. Redirecting…")).toBeTruthy());
    expect(screen.queryByTestId("magic-link-claimed")).toBeNull();
  });
});
