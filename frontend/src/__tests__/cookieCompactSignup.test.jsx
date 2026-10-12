/**
 * Push 6 (B3) — on /register and /login, and on the two auth pages that come
 * next (/verify-email, /forgot-password), the cookie banner is compact: the
 * same words, the body clamped behind "Læs mere", Accept and Decline side by
 * side with equal weight, "Tilpas" as a text link, no bottom-nav offset and
 * no aria-live; and the page pads its bottom by the banner's height
 * (--bb-consent-h) so the form can always be scrolled clear of it.
 *
 * 12 Oct 2026: that compact banner became THE banner on every route (see
 * cookieOneBanner.test.jsx). It shows one short sentence (cookieBannerShort)
 * with "Læs mere" → /cookies instead of the clamped body; the full body,
 * word for word, sits in "Tilpas". The rest of this file holds as it was.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  return {
    useLanguage: () => ({ lang: "da", t: (k, fb) => DA[k] ?? (typeof fb === "string" ? fb : k) }),
  };
});

const CookieConsent = (await import("../components/CookieConsent")).default;
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function openAt(pathname) {
  vi.useFakeTimers();
  render(<MemoryRouter initialEntries={[pathname]}><CookieConsent /></MemoryRouter>);
  await act(async () => { vi.advanceTimersByTime(700); });
  vi.useRealTimers();
  return document.querySelector('[data-cookie-consent="banner"]');
}

beforeEach(() => { localStorage.clear(); document.documentElement.style.removeProperty("--bb-consent-h"); });
afterEach(() => { cleanup(); localStorage.clear(); });

describe.each(["/register", "/login", "/verify-email", "/forgot-password"])("compact banner on %s", (route) => {
  it("short sentence, no 🍪, no aria-live, Læs mere → /cookies; the full words behind Tilpas", async () => {
    const banner = await openAt(route);
    expect(banner.getAttribute("role")).toBe("dialog");
    expect(banner.getAttribute("aria-label")).toBe(da.cookieBannerAria);
    expect(banner.hasAttribute("aria-live")).toBe(false);
    expect(banner.textContent).not.toContain("🍪");
    expect(banner.textContent).toContain(da.cookieBannerTitle);
    expect(banner.querySelector("#cookie-banner-short").textContent).toBe(da.cookieBannerShort);
    expect(banner.textContent).not.toContain(da.cookieBannerBody);
    expect(within(banner).getByRole("link", { name: da.suCookieMore }).getAttribute("href")).toBe("/cookies");
    fireEvent.click(within(banner).getByRole("button", { name: da.cookieCustomize }));
    expect(document.querySelector("#cookie-banner-body").textContent).toBe(da.cookieBannerBody);
    // no fixed 3.5rem bottom-nav offset: the banner sits on a marked bar instead
    expect(banner.className).not.toMatch(/3\.5rem/);
  });

  it("Accept and Decline side by side with equal weight; Tilpas opens the drawer; the answer is saved", async () => {
    const banner = await openAt(route);
    const accept = within(banner).getByRole("button", { name: da.cookieAcceptAll });
    const decline = within(banner).getByRole("button", { name: da.cookieDeclineNonEssential });
    expect(accept.className).toBe(decline.className);
    expect(accept.parentElement).toBe(decline.parentElement);
    expect(accept.parentElement.className).toMatch(/grid-cols-2/);
    fireEvent.click(within(banner).getByRole("button", { name: da.cookieCustomize }));
    expect(screen.getByText(da.cookieDrawerTitle)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: da.cookieAcceptAll }).pop());
    expect(JSON.parse(localStorage.getItem("bonbox_cookie_consent")).choices.analytics).toBe(true);
  });

  it("publishes its height for the page to pad by, and clears it once answered", async () => {
    const banner = await openAt(route);
    expect(document.documentElement.style.getPropertyValue("--bb-consent-h")).toMatch(/^\d+px$/);
    fireEvent.click(within(banner).getByRole("button", { name: da.cookieDeclineNonEssential }));
    expect(document.documentElement.style.getPropertyValue("--bb-consent-h")).toBe("");
    expect(JSON.parse(localStorage.getItem("bonbox_cookie_consent")).choices.analytics).toBe(false);
  });
});

describe("everywhere else it is the same banner (12 Oct 2026)", () => {
  it("/ has the short sentence, no fixed offset and no aria-live — the full text is in Tilpas", async () => {
    const banner = await openAt("/");
    expect(banner.hasAttribute("aria-live")).toBe(false);
    expect(banner.className).not.toMatch(/3\.5rem/);
    expect(banner.querySelector("#cookie-banner-short").textContent).toBe(da.cookieBannerShort);
    expect(banner.textContent).not.toContain(da.cookieBannerBody);
    fireEvent.click(within(banner).getByRole("button", { name: da.cookieCustomize }));
    expect(screen.getByRole("dialog").textContent).toContain(da.cookieBannerBody);
  });
});

describe("the auth shell pads for it", () => {
  it("AuthShell's frame reads --bb-consent-h (where the banner can sit over the form — Push 8)", () => {
    const src = fs.readFileSync(path.join(SRC, "components/auth/AuthUI.jsx"), "utf8");
    expect(src).toContain("max-lg:pb-[var(--bb-consent-h,0px)]");
    expect(src).toContain("max-[1287px]:pb-[var(--bb-consent-h,0px)]");
  });
  it("every page with the compact banner is drawn in AuthShell (so it pads)", () => {
    for (const page of ["RegisterPage", "LoginPage", "VerifyEmailPage", "ForgotPasswordPage"]) {
      const src = fs.readFileSync(path.join(SRC, `pages/${page}.jsx`), "utf8");
      expect(src, page).toMatch(/<AuthShell[\s>]/);
    }
  });
});
