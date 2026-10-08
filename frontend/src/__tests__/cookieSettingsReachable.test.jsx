/**
 * "Cookie settings" — consent can be changed and withdrawn without clearing
 * site data.
 *
 * The banner's drawer says the choice "can be changed anytime via the link in
 * the footer", and /cookies says withdrawing Marketing consent removes the
 * flyer code from the device. Until 8 Oct 2026 nothing in the app opened the
 * drawer again: openCookieSettings() had no caller, so the only way to
 * withdraw was to clear site data (GDPR Art. 7(3): withdrawing must be as easy
 * as giving). These tests click the real button on the real pages, with the
 * real banner mounted, and check the withdrawal reaches the device.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import CookieConsent, { MARKETING_TEXT, getCookieConsent } from "../components/CookieConsent";
import CookiePolicyPage from "../pages/CookiePolicyPage";
import PrivacyPolicyPage from "../pages/PrivacyPolicyPage";
import FooterV2 from "../components/landing/v2/FooterV2";
import { LanguageProvider } from "../hooks/useLanguage";
import {
  captureSignupRef, clearSignupRef, watchCookieConsentForSignupRef,
} from "../utils/signupRef";

const REF_KEY = "bonbox_signup_ref";

// An "Accept all" saved by this release's banner.
const acceptedAll = () =>
  localStorage.setItem(
    "bonbox_cookie_consent",
    JSON.stringify({
      version: 1,
      marketingText: MARKETING_TEXT,
      timestamp: new Date().toISOString(),
      choices: { necessary: true, functional: true, analytics: true, marketing: true },
    }),
  );

const renderWithBanner = (ui, lang = "en") => {
  localStorage.setItem("lang", lang);
  return render(
    <LanguageProvider>
      <MemoryRouter>
        {ui}
        <CookieConsent />
      </MemoryRouter>
    </LanguageProvider>,
  );
};

beforeEach(() => {
  clearSignupRef();
  localStorage.clear();
});

describe.each([
  ["CookiePolicyPage", CookiePolicyPage],
  ["PrivacyPolicyPage", PrivacyPolicyPage],
])("%s footer", (_name, Page) => {
  it.each([
    ["en", "Cookie settings", "Cookie preferences"],
    ["da", "Cookieindstillinger", "Vælg hvilke cookie"],
  ])("lang=%s: the footer button reopens the drawer", async (lang, button, drawerTitle) => {
    acceptedAll();
    renderWithBanner(<Page />, lang);
    // An answered banner stays closed.
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: button }));
    await waitFor(() => expect(screen.getByRole("dialog")).toBeInTheDocument());
    // The drawer opens on the current answer: all four switches on.
    const switches = screen.getAllByRole("switch");
    expect(switches).toHaveLength(4);
    for (const s of switches) expect(s.getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("dialog").textContent).toMatch(new RegExp(drawerTitle, "i"));
  });
});

describe("withdrawing Marketing from the footer removes the flyer code", () => {
  it("Marketing off + Save: the answer says no and the code leaves the device", async () => {
    acceptedAll();
    watchCookieConsentForSignupRef();
    captureSignupRef("?ref=r1-a-03");
    expect(JSON.parse(localStorage.getItem(REF_KEY)).ref).toBe("r1-a-03");

    renderWithBanner(<CookiePolicyPage />, "en");
    fireEvent.click(screen.getByRole("button", { name: "Cookie settings" }));
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(4));
    // necessary, preferences, analytics, marketing (the drawer re-creates the
    // switches on every render, so query again after the click)
    fireEvent.click(screen.getAllByRole("switch")[3]);
    expect(screen.getAllByRole("switch")[3].getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: /save my choices/i }));

    expect(getCookieConsent().marketing).toBe(false);
    expect(getCookieConsent().analytics).toBe(true); // the other answers are kept
    expect(localStorage.getItem(REF_KEY)).toBeNull();
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("landing footer", () => {
  it("carries the Cookie settings button, and it reopens the drawer", async () => {
    acceptedAll();
    renderWithBanner(<FooterV2 />, "en");
    fireEvent.click(screen.getByRole("button", { name: "Cookie settings" }));
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(4));
  });
});

describe("Profile → Privacy & data", () => {
  it("renders the Cookie settings button in the privacy section", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const src = readFileSync(join(here, "..", "pages", "ProfilePage.jsx"), "utf8");
    expect(src).toContain('import { CookieSettingsButton } from "../components/CookieConsent";');
    const privacy = src.slice(src.indexOf('<SectionAnchor id="privacy">'));
    const section = privacy.slice(0, privacy.indexOf("</SectionAnchor>"));
    expect(section).toContain("<CookieSettingsButton");
  });
});
