/**
 * Push 6 — /register: three typed inputs, inline Danish validation, every
 * server answer in the owner's language, and the frozen Terms line untouched.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const h = vi.hoisted(() => ({ lang: "da" }));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const { en: EN } = await import("../i18n/en");
  return {
    useLanguage: () => ({
      lang: h.lang,
      setLang: () => {},
      LANGUAGES: [{ code: "da", label: "Dansk" }, { code: "en", label: "English" }],
      t: (k, fb, vars) => {
        const v = typeof fb === "object" && fb ? fb : vars;
        let s = (h.lang === "da" ? DA : EN)[k] ?? EN[k] ?? (typeof fb === "string" ? fb : k);
        if (v && typeof s === "string") s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
        return s;
      },
    }),
    LanguageProvider: ({ children }) => children,
    detectInitialLanguage: () => ({ lang: h.lang, source: "stored" }),
  };
});
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn() }));
vi.mock("../services/api", () => ({ default: api }));
let authState;
vi.mock("../hooks/useAuth", () => ({ useAuth: () => authState, AuthProvider: ({ children }) => children }));
vi.mock("@react-oauth/google", () => ({
  GoogleOAuthProvider: ({ children }) => children,
  useGoogleOAuth: () => ({ clientId: "cid", scriptLoadedSuccessfully: false }),
}));
vi.mock("../components/AppleSignInButton", () => ({ default: () => null }));

const RegisterPage = (await import("../pages/RegisterPage")).default;

function Where() {
  const loc = useLocation();
  return <p data-testid="where">{loc.pathname}|{JSON.stringify(loc.state)}</p>;
}

function renderRegister(entry = "/register") {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );
}

const fill = (label, value) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

beforeEach(() => {
  h.lang = "da";
  localStorage.clear();
  api.get.mockReset();
  api.get.mockImplementation(() => Promise.resolve({ data: [] }));
  api.put.mockReset();
  api.put.mockImplementation(() => Promise.resolve({ data: {} }));
  authState = { register: vi.fn(async () => ({ user: { id: 42 } })), googleLogin: vi.fn(), googleOauthLogin: vi.fn(), appleOauthLogin: vi.fn() };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("three inputs, each labelled", () => {
  it("exactly 3 typed inputs (the honeypot aside), reachable by label, no type or currency select", () => {
    const { container } = renderRegister();
    const typed = [...container.querySelectorAll("input")].filter((i) => i.name !== "website");
    expect(typed).toHaveLength(3);
    expect(container.querySelectorAll("select[name]")).toHaveLength(0);
    expect(screen.getByLabelText(da.email).id).toBe("su-email");
    expect(screen.getByLabelText(da.password).id).toBe("su-password");
    expect(screen.getByLabelText(da.businessName).id).toBe("su-business-name");
    // The honeypot is still there, hidden from people.
    expect(container.querySelector('input[name="website"]')).toBeTruthy();
  });

  it("autofill / keyboard attributes, and noValidate (no browser bubbles)", () => {
    const { container } = renderRegister();
    expect(container.querySelector("form").noValidate).toBe(true);
    const email = screen.getByLabelText(da.email);
    expect(email.getAttribute("type")).toBe("email");
    expect(email.getAttribute("autocomplete")).toBe("email");
    expect(email.getAttribute("autocapitalize")).toBe("none");
    expect(email.getAttribute("autocorrect")).toBe("off");
    expect(email.getAttribute("spellcheck")).toBe("false");
    expect(screen.getByLabelText(da.password).getAttribute("autocomplete")).toBe("new-password");
    const name = screen.getByLabelText(da.businessName);
    expect(name.getAttribute("autocomplete")).toBe("organization");
    expect(name.getAttribute("autocapitalize")).toBe("words");
    expect(name.getAttribute("placeholder")).toBe(da.suBusinessNamePlaceholder);
  });

  it("show/hide password is a labelled 44 px button", () => {
    renderRegister();
    const btn = screen.getByRole("button", { name: da.showPassword });
    expect(btn.className).toMatch(/\bw-11\b/);
    expect(btn.className).toMatch(/\bh-11\b/);
    fireEvent.click(btn);
    expect(screen.getByLabelText(da.password).getAttribute("type")).toBe("text");
    expect(screen.getByRole("button", { name: da.hidePassword })).toBeTruthy();
  });
});

describe("the payload", () => {
  it("leaves business_type out when nobody chose one, keeps accept_terms and DKK", async () => {
    renderRegister();
    fill(da.email, "  ejer@cafe.dk ");
    fill(da.password, "Kaffe2026");
    fill(da.businessName, "Café Solsikke");
    await act(async () => { fireEvent.submit(document.querySelector("form")); });
    expect(authState.register).toHaveBeenCalledTimes(1);
    const body = authState.register.mock.calls[0][0];
    expect("business_type" in body).toBe(false);
    expect(body).toMatchObject({ email: "ejer@cafe.dk", business_name: "Café Solsikke", currency: "DKK", accept_terms: true, ui_language: "da", website: "" });
    // Not asked → the wizard asks, for this account only.
    expect(localStorage.getItem("bonbox_type_unasked")).toBe("42");
    expect(screen.getByTestId("where").textContent).toContain("/verify-email");
  });

  it("a CVR suggestion that knows the type sends it, and leaves no 'unasked' note", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    api.get.mockImplementation(() => Promise.resolve({ data: [{
      name: "Café Mirabelle ApS", org_number: "12345678", country: "DK", branchekode_inference: { business_type: "cafe" },
    }] }));
    renderRegister();
    fill(da.email, "ejer@mirabelle.dk");
    await act(async () => { vi.advanceTimersByTime(800); });
    fireEvent.click(await screen.findByText("Café Mirabelle ApS"));
    fill(da.password, "Kaffe2026");
    await act(async () => { fireEvent.submit(document.querySelector("form")); });
    const body = authState.register.mock.calls[0][0];
    expect(body.business_type).toBe("cafe");
    expect(body.business_name).toBe("Café Mirabelle ApS");
    expect(localStorage.getItem("bonbox_type_unasked")).toBeNull();
    // and the strip is calm: no 🎯
    expect(document.body.textContent).not.toContain("🎯");
  });
});

describe("the Terms acceptance line (frozen)", () => {
  it("renders once, with the same words as before", () => {
    renderRegister();
    const lines = screen.getAllByTestId("signup-terms-line");
    expect(lines).toHaveLength(1);
    expect(lines[0].textContent).toBe(
      "Ved at oprette en konto accepterer du vores Handelsbetingelser. Læs om, hvordan vi behandler dine data, i vores Privatlivspolitik.",
    );
  });
  it("with the Google row too: once, beside it", () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "cid");
    renderRegister();
    expect(screen.getAllByTestId("signup-terms-line")).toHaveLength(1);
    expect(screen.getByTestId("google-button")).toBeTruthy();
  });
});

describe("inline validation — gentle, Danish, under the field", () => {
  it("nothing red before the owner leaves a field; on blur the e-mail says what is wrong", () => {
    renderRegister();
    const email = screen.getByLabelText(da.email);
    fireEvent.change(email, { target: { value: "ole@cafe" } });
    expect(screen.queryByText(da.suErrEmailInvalid)).toBeNull();
    fireEvent.blur(email);
    const msg = screen.getByText(da.suErrEmailInvalid);
    expect(msg.getAttribute("role")).toBe("alert");
    expect(email.getAttribute("aria-invalid")).toBe("true");
    expect(email.getAttribute("aria-describedby")).toBe(msg.id);
    // …and re-checks as they type once touched
    fireEvent.change(email, { target: { value: "ole@cafe.dk" } });
    expect(screen.queryByText(da.suErrEmailInvalid)).toBeNull();
  });

  it("tabbing past an empty field says nothing yet — that waits for Opret konto", () => {
    renderRegister();
    for (const label of [da.email, da.password, da.businessName]) {
      fireEvent.focus(screen.getByLabelText(label));
      fireEvent.blur(screen.getByLabelText(label));
    }
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
    expect(document.getElementById("su-password-hint").className).not.toMatch(/red/);
  });

  it("the password hint is always there, live, and never red while typing", () => {
    renderRegister();
    const pw = screen.getByLabelText(da.password);
    const hint = document.getElementById("su-password-hint");
    expect(hint.textContent).toBe(da.suPwHint);
    fireEvent.focus(pw);
    fireEvent.change(pw, { target: { value: "kaffe" } });
    expect(hint.textContent).toBe("Mindst 8 tegn — du mangler 3.");
    expect(hint.className).not.toMatch(/red/);
    fireEvent.change(pw, { target: { value: "kaffekop" } });
    expect(hint.textContent).toBe(da.suPwNeedDigit);
    fireEvent.change(pw, { target: { value: "æøåæøå12" } }); // Danish letters count, as on the server
    expect(hint.textContent).toBe(da.suPwOk);
    expect(hint.className).toMatch(/emerald-700/);
    fireEvent.change(pw, { target: { value: "æøåæøå123456" } });
    expect(hint.textContent).toBe(da.suPwStrong);
    fireEvent.change(pw, { target: { value: "12345678" } });
    expect(hint.textContent).toBe(da.suPwNeedLetter);
    expect(hint.className).not.toMatch(/red/);
    fireEvent.blur(pw);
    expect(hint.className).toMatch(/red-700/);
    expect(pw.getAttribute("aria-invalid")).toBe("true");
  });

  it("submit focuses the first field that is not right, and sends nothing", async () => {
    renderRegister();
    fill(da.email, "ejer@cafe.dk");
    await act(async () => { fireEvent.submit(document.querySelector("form")); });
    expect(authState.register).not.toHaveBeenCalled();
    expect(document.activeElement.id).toBe("su-password");
    expect(screen.getByText(da.suErrBusinessNameEmpty)).toBeTruthy();
    // no top error box — the messages sit under the fields
    expect(document.querySelector(".bg-red-50")).toBeNull();
  });
});

describe("server answers, in the owner's language", () => {
  const filled = () => {
    fill(da.email, "ole@cafe.dk");
    fill(da.password, "Kaffe2026");
    fill(da.businessName, "Café");
  };
  const submit = () => act(async () => { fireEvent.submit(document.querySelector("form")); });

  it("the error box is role=alert, never shows the server's English", async () => {
    authState.register.mockRejectedValueOnce({ response: { status: 422, data: { detail: "Registration could not be completed. Please try again or contact support." } } });
    renderRegister();
    filled();
    await submit();
    const box = screen.getByRole("alert");
    expect(box.textContent).toBe(da.suErrRegisterBlocked);
    expect(document.body.textContent).not.toContain("Registration could not be completed");
  });

  it("disposable / no-MX land under the e-mail field", async () => {
    authState.register.mockRejectedValueOnce({ response: { status: 422, data: { detail: "That email domain doesn't appear to exist. Please check the spelling." } } });
    renderRegister();
    filled();
    await submit();
    expect(screen.getByText(da.suErrDomain).id).toBe("su-email-error");
    expect(document.activeElement.id).toBe("su-email");
  });

  it("offline: suErrOffline, and never 'Langsom forbindelse'", async () => {
    authState.register.mockRejectedValueOnce({ code: "ERR_NETWORK", message: "Network Error" });
    renderRegister();
    filled();
    await submit();
    expect(screen.getByRole("alert").textContent).toBe(da.suErrOffline);
    expect(document.body.textContent).not.toContain(da.slowConnection);
    expect(document.body.textContent).not.toContain("Network Error");
  });

  it("slowConnection appears only after 8 s in flight, next to the spinner", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: false });
    let resolve;
    authState.register.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    renderRegister();
    filled();
    await submit();
    const btn = screen.getByRole("button", { name: da.suCreating });
    expect(btn.getAttribute("aria-busy")).toBe("true");
    await act(async () => { vi.advanceTimersByTime(7900); });
    expect(screen.queryByText(da.slowConnection)).toBeNull();
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(screen.getByText(da.slowConnection)).toBeTruthy();
    await act(async () => { resolve({ user: { id: 1 } }); });
  });

  it("409 → the exists panel with Log ind (carrying the address) and Glemt adgangskoden?", async () => {
    authState.register.mockRejectedValueOnce({ response: { status: 409, data: { detail: "Email already registered" } } });
    renderRegister();
    filled();
    await submit();
    expect(screen.getByText(da.suEmailExists)).toBeTruthy();
    const login = screen.getByRole("link", { name: da.signInInstead });
    expect(screen.getByRole("link", { name: da.suForgotQ })).toBeTruthy();
    fireEvent.click(login);
    expect(screen.getByTestId("where").textContent).toBe('/login|{"email":"ole@cafe.dk"}');
  });

  it("a timeout, then a 409 → suEmailExistsAfterTimeout", async () => {
    authState.register
      .mockRejectedValueOnce({ code: "ECONNABORTED", message: "timeout of 60000ms exceeded" })
      .mockRejectedValueOnce({ response: { status: 409, data: { detail: "Email already registered" } } });
    renderRegister();
    filled();
    await submit();
    expect(screen.getByRole("alert").textContent).toBe(da.suErrTimeout);
    await submit();
    expect(screen.getByText(da.suEmailExistsAfterTimeout)).toBeTruthy();
  });

  it("English page: English lines", async () => {
    h.lang = "en";
    authState.register.mockRejectedValueOnce({ code: "ERR_NETWORK" });
    renderRegister();
    fill(en.email, "ole@cafe.dk");
    fill(en.password, "Kaffe2026");
    fill(en.businessName, "Café");
    await submit();
    expect(screen.getByRole("alert").textContent).toBe(en.suErrOffline);
  });
});

describe("arrivals", () => {
  it("an address from /login (router state) is filled in", () => {
    render(
      <MemoryRouter initialEntries={[{ pathname: "/register", state: { email: " ole@cafe.dk " } }]}>
        <Routes><Route path="/register" element={<RegisterPage />} /></Routes>
      </MemoryRouter>,
    );
    expect(screen.getByLabelText(da.email).value).toBe("ole@cafe.dk");
  });

  it("?plan=starter / ?plan=pro say which plan was picked; no plan, no line", () => {
    renderRegister("/register?plan=starter");
    expect(screen.getByTestId("register-plan-note").textContent).toBe(da.suPlanStarterNote);
    cleanup();
    renderRegister("/register?plan=pro");
    expect(screen.getByTestId("register-plan-note").textContent).toBe(da.suPlanProNote);
    cleanup();
    renderRegister("/register");
    expect(screen.queryByTestId("register-plan-note")).toBeNull();
  });

  it("the desktop panel is an <aside> with three true lines and no 'Lavet i København'", () => {
    renderRegister();
    const aside = document.querySelector("aside");
    expect(aside).toBeTruthy();
    expect(within(aside).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      da.suPanelBenefit1, da.suPanelBenefit2, da.trialBenefit3,
    ]);
    expect(aside.textContent).not.toMatch(/København/);
    expect(document.querySelector("main")).toBeTruthy();
  });
});

describe("the answer to Opret konto lands where the owner is looking (phone, scrolled to the button)", () => {
  const filled = () => {
    fill(da.email, "ole@cafe.dk");
    fill(da.password, "Kaffe2026");
    fill(da.businessName, "Café");
  };
  const submit = () => act(async () => { fireEvent.submit(document.querySelector("form")); });
  let scrolled;
  beforeEach(() => {
    scrolled = [];
    Element.prototype.scrollIntoView = vi.fn(function (opts) { scrolled.push({ el: this, opts }); });
  });
  afterEach(() => { delete Element.prototype.scrollIntoView; });

  it("409: the 'already has an account' panel is scrolled to the centre and focused", async () => {
    authState.register.mockRejectedValueOnce({ response: { status: 409, data: { detail: "Email already registered" } } });
    renderRegister();
    filled();
    await submit();
    const panel = screen.getByTestId("register-exists");
    expect(panel.getAttribute("tabindex")).toBe("-1");
    expect(document.activeElement).toBe(panel);
    expect(scrolled.at(-1)).toEqual({ el: panel, opts: { block: "center" } });
  });

  it.each([
    ["offline", { code: "ERR_NETWORK", message: "Network Error" }, "suErrOffline"],
    ["429", { response: { status: 429, data: { detail: "Too many requests" } } }, null],
    ["blocked", { response: { status: 422, data: { detail: "Registration could not be completed. Please try again or contact support." } } }, "suErrRegisterBlocked"],
    ["5xx", { response: { status: 500, data: { detail: "Internal Server Error" } } }, null],
  ])("%s: the error box is scrolled into view and focused", async (_name, err, key) => {
    authState.register.mockRejectedValueOnce(err);
    renderRegister();
    filled();
    await submit();
    const box = screen.getByRole("alert");
    if (key) expect(box.textContent).toBe(da[key]);
    expect(document.activeElement).toBe(box);
    expect(scrolled.at(-1)).toEqual({ el: box, opts: { block: "center" } });
  });

  it("the same answer twice (a second tap) is brought back into view again", async () => {
    authState.register
      .mockRejectedValueOnce({ code: "ERR_NETWORK" })
      .mockRejectedValueOnce({ code: "ERR_NETWORK" });
    renderRegister();
    filled();
    await submit();
    const first = scrolled.length;
    document.querySelector("#su-business-name").focus();
    await submit();
    expect(scrolled.length).toBe(first + 1);
    expect(document.activeElement).toBe(screen.getByRole("alert"));
  });

  it("a field's own message still focuses the field, and scrolls no box", async () => {
    authState.register.mockRejectedValueOnce({ response: { status: 422, data: { detail: "That email domain doesn't appear to exist. Please check the spelling." } } });
    renderRegister();
    filled();
    await submit();
    expect(document.activeElement.id).toBe("su-email");
    expect(scrolled).toHaveLength(0);
  });
});

describe("an owner who is already signed in (the back button from /verify-email)", () => {
  const NEW_UNCONFIRMED = { id: 7, role: "owner", email_verified: false, created_at: "2026-10-11T10:00:00", business_type: "restaurant" };
  const tree = () => (
    <MemoryRouter initialEntries={["/register"]}>
      <Routes>
        <Route path="/register" element={<RegisterPage />} />
        <Route path="*" element={<Where />} />
      </Routes>
    </MemoryRouter>
  );

  it("still has to confirm → /verify-email (where 'Ret den' fixes the address on the SAME account)", () => {
    authState = { ...authState, user: NEW_UNCONFIRMED, loading: false };
    renderRegister();
    expect(screen.getByTestId("where").textContent).toBe("/verify-email|null");
    expect(authState.register).not.toHaveBeenCalled();
  });

  it("confirmed → the app, not a blank sign-up form", () => {
    authState = { ...authState, user: { ...NEW_UNCONFIRMED, email_verified: true }, loading: false };
    renderRegister();
    expect(screen.getByTestId("where").textContent).toBe("/dashboard|null");
  });

  it("'Spring over for nu' within 7 days, or an account from before the grace date → the app (no fresh code mailed by a back tap)", async () => {
    const { rememberVerifySkip } = await import("../utils/verifySkip");
    rememberVerifySkip(7);
    authState = { ...authState, user: NEW_UNCONFIRMED, loading: false };
    renderRegister();
    expect(screen.getByTestId("where").textContent).toBe("/dashboard|null");
    cleanup();
    localStorage.clear();
    sessionStorage.clear();
    authState = { ...authState, user: { ...NEW_UNCONFIRMED, created_at: "2026-01-02T10:00:00" }, loading: false };
    renderRegister();
    expect(screen.getByTestId("where").textContent).toBe("/dashboard|null");
  });

  it("while the session probe is still out, the form shows as before (no spinner in front of a logged-out visitor)", () => {
    authState = { ...authState, user: null, loading: true };
    renderRegister();
    expect(screen.getByLabelText(da.email)).toBeTruthy();
    expect(screen.queryByTestId("where")).toBeNull();
  });

  it("its OWN new account is not bounced: the page stays until it goes to /verify-email itself", async () => {
    let resolve;
    authState.register = vi.fn(() => new Promise((r) => { resolve = r; }));
    const view = render(tree());
    fill(da.email, "ole@cafe.dk");
    fill(da.password, "Kaffe2026");
    fill(da.businessName, "Café");
    await act(async () => { fireEvent.submit(document.querySelector("form")); });
    // useAuth sets the user before register() returns; a render can fall in
    // between. A CONFIRMED user here would be sent to /dashboard by the guard.
    authState = { ...authState, user: { ...NEW_UNCONFIRMED, email_verified: true }, loading: false };
    view.rerender(tree());
    expect(screen.queryByTestId("where")).toBeNull();
    expect(screen.getByRole("button", { name: da.suCreating })).toBeTruthy();
    await act(async () => { resolve({ user: { id: 7 } }); });
    expect(screen.getByTestId("where").textContent).toBe("/verify-email|null");
  });
});
