/**
 * Release gate R-b (9 Oct) — Danish first on the new screens.
 *
 *   • "Du er klar" → "Inviter dit personale": a network error showed axios's
 *     English "Network Error" in red on the Danish card. Now the owner's
 *     language: "Invitationen kunne ikke laves — prøv igen." (a retry is
 *     safe: the staff member is never created twice), and for a full staff
 *     roster what is true there — never the server's English code.
 *   • The Danish register form's e-mail placeholder said "you@company.com";
 *     it is "dig@firma.dk", as on /login.
 *
 * Real dictionaries (da / en), so the sentence the owner reads is asserted.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const h = vi.hoisted(() => ({ post: vi.fn(), lang: "da" }));

vi.mock("../services/api", () => ({ default: { post: h.post, get: vi.fn(() => Promise.resolve({ data: {} })) } }));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "u1", business_name: "Café Solsikken", role: "owner" }, register: vi.fn() }),
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const { en: EN } = await import("../i18n/en");
  return {
    useLanguage: () => {
      const dict = h.lang === "da" ? DA : EN;
      return {
        lang: h.lang,
        t: (k, fb, vars) => {
          let s = dict[k] ?? (typeof fb === "string" ? fb : k);
          const v = typeof fb === "object" && fb ? fb : vars;
          if (v) Object.entries(v).forEach(([a, b]) => { s = s.replace(`{${a}}`, String(b)); });
          return s;
        },
        setLang: () => {},
        LANGUAGES: [{ code: "da", label: "Dansk" }, { code: "en", label: "English" }],
      };
    },
  };
});
vi.mock("@react-oauth/google", () => ({ GoogleLogin: () => null, GoogleOAuthProvider: ({ children }) => children }));
vi.mock("../components/AppleSignInButton", () => ({ default: () => null }));

const FirstStepsPage = (await import("../pages/FirstStepsPage")).default;
const RegisterPage = (await import("../pages/RegisterPage")).default;

beforeEach(() => {
  h.lang = "da";
  h.post.mockReset();
});

async function inviteWithError(err) {
  h.post.mockImplementation((url) => {
    if (url === "/staff/members") return Promise.resolve({ data: { id: "m1", name: "Sofie" } });
    return Promise.reject(err);
  });
  render(<MemoryRouter><FirstStepsPage /></MemoryRouter>);
  const dict = h.lang === "da" ? da : en;
  fireEvent.change(screen.getByPlaceholderText(dict.firstStepsNamePlaceholder), { target: { value: "Sofie" } });
  await act(async () => { fireEvent.click(screen.getByText(dict.firstStepsMakeInvite)); });
  return screen.getByRole("alert").textContent;
}

const networkError = () => Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" });

describe("'Du er klar' invite card — errors in the owner's language", () => {
  it("a network error on the Danish card: the Danish sentence, never 'Network Error'", async () => {
    const msg = await inviteWithError(networkError());
    expect(msg).toBe(da.firstStepsInviteFailed);
    expect(msg).not.toMatch(/Network Error/);
  });

  it("…and in English for an English owner", async () => {
    h.lang = "en";
    const msg = await inviteWithError(networkError());
    expect(msg).toBe(en.firstStepsInviteFailed);
  });

  it("a server error with an English detail: still the owner's language", async () => {
    const msg = await inviteWithError({ response: { status: 503, data: { detail: "Network blip" } } });
    expect(msg).toBe(da.firstStepsInviteFailed);
  });

  it("a full staff roster (402 cap): says the plan has no room — not the code 'cap_exceeded', not 'prøv igen'", async () => {
    const msg = await inviteWithError({
      response: { status: 402, data: { detail: { error: "cap_exceeded", cap: "staff_members", current: 3, limit: 3, plan: "free", upgrade_to: "starter" } } },
    });
    expect(msg).toBe(da.firstStepsInviteCapFull.replace("{limit}", "3"));
    expect(msg).not.toMatch(/cap_exceeded|prøv igen/);
  });

  it("the dictionaries hold real Danish and English for both lines", () => {
    for (const k of ["firstStepsInviteFailed", "firstStepsInviteCapFull"]) {
      expect(da[k]).toBeTruthy();
      expect(en[k]).toBeTruthy();
      expect(da[k]).not.toEqual(en[k]);
    }
  });
});

describe("register form — the e-mail placeholder", () => {
  it("Danish: 'dig@firma.dk', as on /login", () => {
    render(<MemoryRouter><RegisterPage /></MemoryRouter>);
    expect(document.querySelector('input[name="email"]').getAttribute("placeholder")).toBe("dig@firma.dk");
    expect(screen.queryByPlaceholderText("you@company.com")).toBeNull();
  });

  it("English: 'you@company.com'", () => {
    h.lang = "en";
    render(<MemoryRouter><RegisterPage /></MemoryRouter>);
    expect(document.querySelector('input[name="email"]').getAttribute("placeholder")).toBe("you@company.com");
  });
});
