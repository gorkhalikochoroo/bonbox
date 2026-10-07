/**
 * The app saves its language to the account, so pushes follow it.
 *
 * The language lived only on the device; the server wrote reservation and
 * sick-call pushes in Danish and the morning brief in English whatever the
 * owner read the app in. AccountLanguageSync PATCHes /auth/profile with the
 * app's language when the account's value differs — and only then.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";

const h = vi.hoisted(() => ({
  patch: vi.fn(() => Promise.resolve({ data: {} })),
  user: null,
  lang: "en",
}));
vi.mock("../services/api", () => ({ default: { patch: h.patch } }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: h.user }) }));
vi.mock("../hooks/useLanguage", () => ({ useLanguage: () => ({ lang: h.lang }) }));

import AccountLanguageSync from "../components/AccountLanguageSync";

beforeEach(() => {
  h.patch.mockClear();
});

describe("AccountLanguageSync", () => {
  it("saves the app's language when the account has another", () => {
    h.user = { id: "u1", ui_language: "da" };
    h.lang = "en";
    render(<AccountLanguageSync />);
    expect(h.patch).toHaveBeenCalledTimes(1);
    expect(h.patch).toHaveBeenCalledWith("/auth/profile", { ui_language: "en" });
  });

  it("saves it the first time, when the account has none", () => {
    h.user = { id: "u1", ui_language: null };
    h.lang = "da";
    render(<AccountLanguageSync />);
    expect(h.patch).toHaveBeenCalledWith("/auth/profile", { ui_language: "da" });
  });

  it("sends nothing on an ordinary load — the account already agrees", () => {
    h.user = { id: "u1", ui_language: "en" };
    h.lang = "en";
    render(<AccountLanguageSync />);
    expect(h.patch).not.toHaveBeenCalled();
  });

  it("sends nothing when nobody is logged in", () => {
    h.user = null;
    h.lang = "en";
    render(<AccountLanguageSync />);
    expect(h.patch).not.toHaveBeenCalled();
  });

  it("saves one language once, however often it re-renders", () => {
    h.user = { id: "u1", ui_language: "da" };
    h.lang = "en";
    const { rerender } = render(<AccountLanguageSync />);
    h.user = { ...h.user }; // a fresh user object, same stale value
    rerender(<AccountLanguageSync />);
    expect(h.patch).toHaveBeenCalledTimes(1);
  });
});

describe("AccountLanguageSync on the staff pages", () => {
  // A staffer tapping EN on /join or /s/<token> on a device where the owner
  // is logged in must not switch the OWNER's account language — and with it
  // every push and brief the owner gets.
  for (const path of ["/join", "/s/tok123", "/s/cafe/tok123"]) {
    it(`sends nothing on ${path}`, () => {
      window.history.pushState({}, "", path);
      try {
        h.user = { id: "u1", ui_language: "da" };
        h.lang = "en";
        render(<AccountLanguageSync />);
        expect(h.patch).not.toHaveBeenCalled();
      } finally {
        window.history.pushState({}, "", "/");
      }
    });
  }

  it("still saves on an owner page", () => {
    window.history.pushState({}, "", "/dashboard");
    try {
      h.user = { id: "u1", ui_language: "da" };
      h.lang = "en";
      render(<AccountLanguageSync />);
      expect(h.patch).toHaveBeenCalledWith("/auth/profile", { ui_language: "en" });
    } finally {
      window.history.pushState({}, "", "/");
    }
  });
});
