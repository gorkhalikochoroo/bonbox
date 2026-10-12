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

describe("phone keyboard, AutoFill and paste (mobile walk, 12 Oct)", () => {
  const boxes = () => screen.getAllByRole("textbox").filter((el) => el.getAttribute("inputmode") === "numeric");
  const verifyCalls = () => h.post.mock.calls.filter(([u]) => u === "/auth/verify-email");

  it("every box: numeric keypad, one-time-code, pattern [0-9]*, and NO maxLength (it cut an AutoFilled code to one digit)", () => {
    open();
    for (const b of boxes()) {
      expect(b.getAttribute("autocomplete")).toBe("one-time-code");
      expect(b.getAttribute("inputmode")).toBe("numeric");
      expect(b.getAttribute("pattern")).toBe("[0-9]*");
      expect(b.hasAttribute("maxlength")).toBe(false);
    }
  });

  it("the whole code arriving in the first box as ONE input (iOS code AutoFill, Android's clipboard chip) fills the row and is checked once", async () => {
    open();
    await act(async () => { fireEvent.change(boxes()[0], { target: { value: "482913" } }); });
    expect(verifyCalls()).toEqual([["/auth/verify-email", { code: "482913" }]]);
  });

  it("the same, arriving in the fourth box: the row fills from the first box", async () => {
    h.post.mockImplementation((url) => (url === "/auth/verify-email" ? new Promise(() => {}) : Promise.resolve({ data: {} })));
    open();
    await act(async () => { fireEvent.change(boxes()[3], { target: { value: "482913" } }); });
    expect(boxes().map((b) => b.value).join("")).toBe("482913");
    expect(verifyCalls()).toHaveLength(1);
  });

  it("a paste of 'Din kode: 482913' fills the six boxes and is checked", async () => {
    open();
    const row = screen.getByTestId("verify-code-row");
    await act(async () => { fireEvent.paste(row, { clipboardData: { getData: () => "Din kode: 482913" } }); });
    expect(verifyCalls()).toEqual([["/auth/verify-email", { code: "482913" }]]);
  });

  it("filled out of order, the code is checked when the last empty box gets its digit", async () => {
    open();
    await act(async () => {
      "82913".split("").forEach((d, i) => fireEvent.change(boxes()[i + 1], { target: { value: d } }));
    });
    expect(verifyCalls()).toHaveLength(0);
    await act(async () => { fireEvent.change(boxes()[0], { target: { value: "4" } }); });
    expect(verifyCalls()).toEqual([["/auth/verify-email", { code: "482913" }]]);
  });

  it("typing over a filled box replaces its digit (a full box used to refuse it)", () => {
    open();
    fireEvent.change(boxes()[0], { target: { value: "1" } });
    fireEvent.change(boxes()[0], { target: { value: "17" } });
    expect(boxes()[0].value).toBe("7");
    expect(document.activeElement).toBe(boxes()[1]);
  });

  it("Backspace in an empty box takes the digit before it, in one press", () => {
    open();
    fireEvent.change(boxes()[0], { target: { value: "4" } });
    fireEvent.change(boxes()[1], { target: { value: "8" } });
    boxes()[2].focus();
    fireEvent.keyDown(boxes()[2], { key: "Backspace" });
    expect(boxes()[1].value).toBe("");
    expect(document.activeElement).toBe(boxes()[1]);
  });

  it("while the code is checked the boxes stay enabled (disabling them closed the phone's keyboard); a wrong code clears the row and the first box has the focus", async () => {
    let reject;
    h.post.mockImplementation((url) => (url === "/auth/verify-email"
      ? new Promise((_, rej) => { reject = rej; })
      : Promise.resolve({ data: {} })));
    open();
    await typeCode("000000");
    expect(boxes().every((b) => !b.disabled)).toBe(true);
    expect(screen.getByTestId("verify-code-row").getAttribute("aria-busy")).toBe("true");
    await act(async () => { reject({ response: { status: 400, data: { detail: "Invalid verification code" } } }); });
    expect(screen.getByRole("alert").textContent).toBe(da.suErrCodeWrong);
    expect(boxes().map((b) => b.value).join("")).toBe("");
    expect(document.activeElement).toBe(boxes()[0]);
  });

  it("no answer (offline): the six digits stay, and Bekræft e-mail tries them again", async () => {
    h.post
      .mockImplementationOnce(() => Promise.reject({ code: "ERR_NETWORK", message: "Network Error" }))
      .mockImplementation(() => Promise.resolve({ data: {} }));
    open();
    await typeCode("482913");
    expect(screen.getByRole("alert").textContent).toBe(da.suErrOffline);
    expect(boxes().map((b) => b.value).join("")).toBe("482913");
    const btn = screen.getByRole("button", { name: da.suVerifyBtn });
    expect(btn.disabled).toBe(false);
    await act(async () => { fireEvent.click(btn); });
    expect(verifyCalls()).toEqual([["/auth/verify-email", { code: "482913" }], ["/auth/verify-email", { code: "482913" }]]);
  });

  it("the first box takes the focus on arrival WITHOUT scrolling (it cut the route's jump to the top short)", () => {
    const focus = vi.spyOn(HTMLElement.prototype, "focus");
    try {
      open();
      const first = boxes()[0];
      const call = focus.mock.calls.find((_, i) => focus.mock.instances[i] === first);
      expect(call).toEqual([{ preventScroll: true }]);
    } finally {
      focus.mockRestore();
    }
  });
});

describe("Ret den on a phone (mobile walk, 12 Oct)", () => {
  it("the new address says next and goes on to the password; the password says send", async () => {
    open();
    // Ret den puts the focus in the new address on the next tick.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: da.suWrongEmail }));
      await new Promise((r) => setTimeout(r, 0));
    });
    const email = screen.getByLabelText(da.suChangeEmailLabel);
    const pw = screen.getByLabelText(da.suChangeEmailPwLabel);
    expect(email.getAttribute("enterkeyhint")).toBe("next");
    expect(pw.getAttribute("enterkeyhint")).toBe("send");
    expect(document.activeElement).toBe(email);
    await act(async () => { fireEvent.keyDown(email, { key: "Enter", keyCode: 13 }); });
    expect(document.activeElement).toBe(pw);
    expect(h.patch).not.toHaveBeenCalled();
  });
});
