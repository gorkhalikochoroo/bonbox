/**
 * Push 7 — Google sign-in inside Instagram's, Facebook's and Messenger's own
 * browsers. The paid Instagram ad opens /register in Instagram's webview,
 * where Google refuses OAuth ("disallowed_useragent"). There /register and
 * /login show one calm line instead of the Google button; everywhere else —
 * Safari, Chrome — the button is unchanged. Detection: utils/inAppBrowser.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
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
const api = vi.hoisted(() => ({ get: vi.fn(), put: vi.fn(), post: vi.fn() }));
vi.mock("../services/api", () => ({ default: api }));
let authState;
vi.mock("../hooks/useAuth", () => ({ useAuth: () => authState, AuthProvider: ({ children }) => children }));
vi.mock("@react-oauth/google", () => ({
  GoogleOAuthProvider: ({ children }) => children,
  useGoogleOAuth: () => ({ clientId: "cid", scriptLoadedSuccessfully: false }),
}));
vi.mock("../components/AppleSignInButton", () => ({ default: () => null }));

const RegisterPage = (await import("../pages/RegisterPage")).default;
const LoginPage = (await import("../pages/LoginPage")).default;

const UA = {
  instagram:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 337.0.3.23.54 (iPhone15,2; iOS 17_5_1; da_DK; da; scale=3.00; 1179x2556; 614406087; IABMV/1)",
  facebookAndroid:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8 Build/AP2A.240805.005; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/127.0.6533.103 Mobile Safari/537.36 [FB_IAB/FB4A;FBAV/478.0.0.42.109;]",
  messengerIos:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/MessengerForiOS;FBAV/458.0.0.36.108;FBBV/599245498;FBDV/iPhone14,7;FBMD/iPhone;FBSN/iOS;FBSV/17.4.1;FBSS/3;FBCR/;FBID/phone;FBLC/da_DK;FBOP/5;FBRV/0]",
  safari:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  chromeAndroid:
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.6478.122 Mobile Safari/537.36",
};
const asBrowser = (ua) => vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue(ua);
const note = (app, dict = da) => dict.googleInAppNote.replace("{app}", app);

const at = (entry) => render(
  <MemoryRouter initialEntries={[entry]}>
    <Routes>
      <Route path="/register" element={<RegisterPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="*" element={<p data-testid="elsewhere" />} />
    </Routes>
  </MemoryRouter>,
);

beforeEach(() => {
  h.lang = "da";
  localStorage.clear();
  api.get.mockReset();
  api.get.mockImplementation(() => Promise.resolve({ data: [] }));
  api.post.mockReset();
  authState = {
    register: vi.fn(async () => ({ user: { id: 42 } })), login: vi.fn(),
    googleLogin: vi.fn(), googleOauthLogin: vi.fn(), appleOauthLogin: vi.fn(),
  };
  vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "cid.apps.googleusercontent.com");
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("the line itself (da + en)", () => {
  it("is real Danish and English, naming the app and the two ways that work", () => {
    expect(da.googleInAppNote).toBe("Google-login virker ikke inde i {app} — brug e-mail, eller åbn siden i Safari/Chrome.");
    expect(en.googleInAppNote).toBe("Google sign-in doesn't work inside {app} — use email, or open the page in Safari/Chrome.");
  });
});

describe("/register", () => {
  it("in Instagram: no Google button — the line instead, then the e-mail form; the Terms line once, under Opret konto", () => {
    asBrowser(UA.instagram);
    const { container } = at("/register");
    expect(screen.queryByTestId("google-button")).toBeNull();
    const line = screen.getByTestId("google-inapp-note");
    expect(line.textContent).toBe("Google-login virker ikke inde i Instagram — brug e-mail, eller åbn siden i Safari/Chrome.");
    // The line comes before the form; the form is the same three fields.
    const form = container.querySelector("form");
    expect(line.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText(da.email)).toBeInTheDocument();
    expect(screen.getByLabelText(da.password)).toBeInTheDocument();
    expect(screen.getByLabelText(da.businessName)).toBeInTheDocument();
    // No Google/Apple row → the Terms line sits under the button, once.
    const terms = screen.getAllByTestId("signup-terms-line");
    expect(terms).toHaveLength(1);
    expect(form.contains(terms[0])).toBe(true);
  });

  it("in Facebook (Android) and Messenger (iPhone): the line names that app", () => {
    asBrowser(UA.facebookAndroid);
    at("/register");
    expect(screen.getByTestId("google-inapp-note").textContent).toBe(note("Facebook"));
    expect(screen.queryByTestId("google-button")).toBeNull();
    cleanup();
    vi.restoreAllMocks();
    asBrowser(UA.messengerIos);
    at("/register");
    expect(screen.getByTestId("google-inapp-note").textContent).toBe(note("Messenger"));
  });

  it("in English: the English line", () => {
    h.lang = "en";
    asBrowser(UA.instagram);
    at("/register");
    expect(screen.getByTestId("google-inapp-note").textContent).toBe(note("Instagram", en));
  });

  it.each([["Safari on an iPhone", UA.safari], ["Chrome on Android", UA.chromeAndroid]])(
    "in %s: Google's button as before, no line",
    (_name, ua) => {
      asBrowser(ua);
      at("/register");
      expect(screen.getByTestId("google-button")).toBeInTheDocument();
      expect(screen.queryByTestId("google-inapp-note")).toBeNull();
      expect(screen.getAllByTestId("signup-terms-line")).toHaveLength(1);
    },
  );

  it("no Google configured: nothing to explain, even inside Instagram", () => {
    vi.unstubAllEnvs();
    asBrowser(UA.instagram);
    at("/register");
    expect(screen.queryByTestId("google-inapp-note")).toBeNull();
    expect(screen.queryByTestId("google-button")).toBeNull();
  });

  it("e-mail signup still works inside Instagram", async () => {
    asBrowser(UA.instagram);
    at("/register");
    fireEvent.change(screen.getByLabelText(da.email), { target: { value: "ole@cafe.dk" } });
    fireEvent.change(screen.getByLabelText(da.password), { target: { value: "kaffekop1" } });
    fireEvent.change(screen.getByLabelText(da.businessName), { target: { value: "Café Ole" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.suCreateAccount })); });
    expect(authState.register).toHaveBeenCalledTimes(1);
    expect(authState.register.mock.calls[0][0]).toMatchObject({ email: "ole@cafe.dk", accept_terms: true });
    expect(screen.getByTestId("elsewhere")).toBeInTheDocument(); // on to /verify-email
  });
});

describe("/login", () => {
  it("in Instagram: no Google button — the line above the e-mail form", () => {
    asBrowser(UA.instagram);
    const { container } = at("/login");
    expect(screen.queryByTestId("google-button")).toBeNull();
    const line = screen.getByTestId("google-inapp-note");
    expect(line.textContent).toBe(note("Instagram"));
    expect(line.compareDocumentPosition(container.querySelector("form")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByLabelText(da.emailLabel)).toBeInTheDocument();
    expect(screen.getByLabelText(da.passwordLabel)).toBeInTheDocument();
  });

  it("in Messenger: the line names Messenger; in the e-mail-link mode it steps aside with the rest of the row", () => {
    asBrowser(UA.messengerIos);
    at("/login");
    expect(screen.getByTestId("google-inapp-note").textContent).toBe(note("Messenger"));
    fireEvent.click(screen.getByRole("button", { name: da.useEmailInstead }));
    expect(screen.queryByTestId("google-inapp-note")).toBeNull();
  });

  it.each([["Safari on an iPhone", UA.safari], ["Chrome on Android", UA.chromeAndroid]])(
    "in %s: Google's button and the Terms line beside it, as before",
    (_name, ua) => {
      asBrowser(ua);
      at("/login");
      expect(screen.getByTestId("google-button")).toBeInTheDocument();
      expect(screen.queryByTestId("google-inapp-note")).toBeNull();
      const terms = screen.getAllByTestId("signup-terms-line");
      expect(terms).toHaveLength(1);
      expect(within(terms[0]).getAllByRole("link")).toHaveLength(2);
    },
  );
});
