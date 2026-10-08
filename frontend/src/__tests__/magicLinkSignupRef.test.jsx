/**
 * "E-mail me a link" is a self-signup too: a new address becomes an owner on
 * verify. The door-visit code must ride along — on the request (so the mailed
 * link carries it as &ref= to whichever tab opens it) and on the verify — and
 * be forgotten once the link has signed someone in.
 */
import { render, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const post = vi.fn(() => Promise.resolve({ data: { access_token: "jwt" } }));
vi.mock("../services/api", () => ({ default: { post: (...a) => post(...a), get: vi.fn(() => Promise.resolve({ data: {} })) } }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({}) }));

import LoginMagicPage from "../pages/LoginMagicPage";
import { LanguageProvider } from "../hooks/useLanguage";
import { captureSignupRef, clearSignupRef, getSignupRef } from "../utils/signupRef";

const TOKEN = "a".repeat(43);

beforeEach(() => {
  post.mockClear();
  clearSignupRef();
  localStorage.clear();
});

const open = () =>
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[`/login/magic?token=${TOKEN}&ref=r1-a-07`]}>
        <Routes>
          <Route path="/login/magic" element={<LoginMagicPage />} />
        </Routes>
      </MemoryRouter>
    </LanguageProvider>,
  );

describe("magic-link verify and the door-visit code", () => {
  it("sends the kept code with the token, then forgets it", async () => {
    // main.jsx keeps ?ref= from the link's own URL on load.
    captureSignupRef(`?token=${TOKEN}&ref=r1-a-07`);
    open();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/auth/magic-link/verify", { token: TOKEN, signup_ref: "r1-a-07" });
    await waitFor(() => expect(getSignupRef()).toBeNull());
  });

  it("without a kept code the body is the token alone", async () => {
    open();
    await waitFor(() => expect(post).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith("/auth/magic-link/verify", { token: TOKEN });
  });
});
