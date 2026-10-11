/**
 * Push 6 — /verify-email: the full address, "Forkert e-mail? Ret den" in
 * place, every error in the owner's language, labelled code boxes and a calm
 * success moment.
 */
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";

vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  return {
    useLanguage: () => ({
      lang: "da",
      setLang: () => {},
      LANGUAGES: [],
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
const h = vi.hoisted(() => ({ post: vi.fn(), patch: vi.fn(), navigate: vi.fn() }));
vi.mock("../services/api", () => ({ default: { post: h.post, patch: h.patch, get: vi.fn(() => Promise.resolve({ data: {} })) } }));
let authState;
vi.mock("../hooks/useAuth", () => ({ useAuth: () => authState }));
vi.mock("react-router-dom", async (orig) => ({ ...(await orig()), useNavigate: () => h.navigate }));

const VerifyEmailPage = (await import("../pages/VerifyEmailPage")).default;

beforeEach(() => {
  h.post.mockReset();
  h.post.mockImplementation(() => Promise.resolve({ data: {} }));
  h.patch.mockReset();
  h.navigate.mockReset();
  authState = {
    user: { id: 7, email: "Ole.Hansen@gmail.com", email_verified: false },
    setEmailVerified: vi.fn(),
    refreshUser: vi.fn(() => Promise.resolve({})),
    logout: vi.fn(() => Promise.resolve()),
  };
});

const open = () => render(<MemoryRouter><VerifyEmailPage /></MemoryRouter>);
const typeCode = async (digits) => {
  const boxes = screen.getAllByRole("textbox").filter((el) => el.getAttribute("inputmode") === "numeric");
  await act(async () => {
    digits.split("").forEach((d, i) => fireEvent.change(boxes[i], { target: { value: d } }));
  });
};

describe("the address and the code boxes", () => {
  it("shows the FULL address in bold (no mask), and the Ret den link", () => {
    open();
    const strong = screen.getByText("Ole.Hansen@gmail.com");
    expect(strong.tagName).toBe("STRONG");
    expect(strong.parentElement.textContent).toBe("Vi har sendt en kode med 6 cifre til Ole.Hansen@gmail.com.");
    expect(screen.getByRole("button", { name: da.suWrongEmail })).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/O\*+n@/);
  });

  it("six boxes in a labelled group, each one named, one-time-code + numeric kept", () => {
    open();
    const group = screen.getByRole("group", { name: da.suCodeGroupLabel });
    const boxes = within(group).getAllByRole("textbox");
    expect(boxes).toHaveLength(6);
    boxes.forEach((b, i) => {
      expect(b.getAttribute("aria-label")).toBe(`Ciffer ${i + 1} af 6`);
      expect(b.getAttribute("inputmode")).toBe("numeric");
      expect(b.getAttribute("autocomplete")).toBe("one-time-code");
    });
  });

  it("the button says what the heading says (Bekræft e-mail)", () => {
    open();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(da.verifyEmailHeading);
    expect(screen.getByRole("button", { name: da.suVerifyBtn })).toBeTruthy();
  });
});

describe("Forkert e-mail? Ret den", () => {
  const openFix = () => fireEvent.click(screen.getByRole("button", { name: da.suWrongEmail }));
  const fillFix = (email = "ole.hansen@icloud.com", pw = "Kaffe2026") => {
    fireEvent.change(screen.getByLabelText(da.suChangeEmailLabel), { target: { value: email } });
    fireEvent.change(screen.getByLabelText(da.suChangeEmailPwLabel), { target: { value: pw } });
  };
  const send = () => act(async () => { fireEvent.click(screen.getByRole("button", { name: da.suChangeEmailBtn })); });

  it("PATCHes {email, current_password}, refreshes the user, resets the cooldown and says where the code went", async () => {
    h.patch.mockResolvedValueOnce({ data: {} });
    open();
    openFix();
    expect(screen.getByLabelText(da.suChangeEmailPwLabel).getAttribute("autocomplete")).toBe("current-password");
    fillFix();
    await send();
    expect(h.patch).toHaveBeenCalledWith("/auth/profile", { email: "ole.hansen@icloud.com", current_password: "Kaffe2026" });
    expect(authState.refreshUser).toHaveBeenCalled();
    expect(screen.getByText("Ny kode sendt til ole.hansen@icloud.com.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Send en ny kode om \d+ s/ })).toBeTruthy();
    // the panel closed
    expect(screen.queryByLabelText(da.suChangeEmailLabel)).toBeNull();
  });

  it.each([
    [{ status: 403, data: { detail: { code: "password_required", message: "Enter your current password to change your login email." } } }, "suErrChangeEmailPw"],
    [{ status: 400, data: { detail: "Email already in use" } }, "suErrChangeEmailTaken"],
    [{ status: 409, data: { detail: { code: "claim_question_open", message: "This account is waiting for an answer" } } }, "suErrClaimOpen"],
    [{ status: 429, data: { detail: { code: "email_change_daily_cap", message: "The login e-mail can be changed a few times a day." } } }, "suErrEmailChangeCap"],
  ])("%j → %s, never the server's English", async (response, key) => {
    h.patch.mockRejectedValueOnce({ response });
    open();
    openFix();
    fillFix();
    await send();
    const alert = screen.getAllByRole("alert").find((el) => el.textContent.includes(da[key]));
    expect(alert).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/Enter your current password|already in use|waiting for an answer|a few times a day/);
  });

  it("the address already has an account → Log ud, then /login with that address", async () => {
    h.patch.mockRejectedValueOnce({ response: { status: 400, data: { detail: "Email already in use" } } });
    open();
    openFix();
    fillFix("ejer@cafe.dk");
    await send();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.logout })); });
    expect(authState.logout).toHaveBeenCalled();
    expect(h.navigate).toHaveBeenCalledWith("/login", { state: { email: "ejer@cafe.dk" } });
  });

  it("the address it already has (any letter case): a fresh code goes there, no PATCH — the line stays true", async () => {
    open();
    openFix();
    fillFix("OLE.HANSEN@gmail.com");
    await send();
    expect(h.patch).not.toHaveBeenCalled();
    expect(h.post).toHaveBeenCalledWith("/auth/resend-verification");
    expect(screen.getByText("Ny kode sendt til OLE.HANSEN@gmail.com.")).toBeTruthy();
  });

  it("a malformed address is caught in place, nothing is sent", async () => {
    open();
    openFix();
    fillFix("ole@cafe");
    await send();
    expect(h.patch).not.toHaveBeenCalled();
    expect(screen.getByText(da.suErrEmailInvalid)).toBeTruthy();
  });
});

describe("codes and resend, in Danish", () => {
  it.each([
    ["Invalid verification code", "suErrCodeWrong"],
    ["Verification code has expired. Please request a new one.", "suErrCodeExpired"],
    ["No verification code found. Please request a new one.", "suErrCodeNone"],
  ])("%s → %s", async (detail, key) => {
    h.post.mockImplementation((url) => (url === "/auth/verify-email"
      ? Promise.reject({ response: { status: 400, data: { detail } } })
      : Promise.resolve({ data: {} })));
    open();
    await typeCode("123456");
    expect(screen.getByRole("alert").textContent).toBe(da[key]);
    expect(document.body.textContent).not.toContain(detail);
  });

  it("the resend daily cap says 'today', not 'wait a moment'", async () => {
    h.post.mockImplementation(() => Promise.reject({ response: { status: 429, data: { detail: { code: "verification_resend_daily_cap" } } } }));
    render(<MemoryRouter initialEntries={["/verify-email?now=1"]}><VerifyEmailPage /></MemoryRouter>);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.suResend })); });
    expect(screen.getByRole("alert").textContent).toBe(da.suErrResendDailyCap);
  });

  it("success: the panel gives way to the confirmation, then /dashboard after 1.2 s", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      open();
      await typeCode("123456");
      expect(screen.getByText(da.suVerifiedTitle)).toBeTruthy();
      expect(screen.getByText(da.suVerifiedBody)).toBeTruthy();
      expect(screen.queryByRole("group")).toBeNull();
      // marked confirmed at the hand-over (the route would skip the moment)
      expect(authState.setEmailVerified).not.toHaveBeenCalled();
      await act(async () => { vi.advanceTimersByTime(1300); });
      expect(authState.setEmailVerified).toHaveBeenCalled();
      expect(h.navigate).toHaveBeenCalledWith("/dashboard");
    } finally {
      vi.useRealTimers();
    }
  });
});
