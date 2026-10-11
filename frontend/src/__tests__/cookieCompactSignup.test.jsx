/**
 * Push 6 (B3) — on /register and /login the cookie banner is compact: the
 * same words, the body clamped behind "Læs mere", Accept and Decline side by
 * side with equal weight, "Tilpas" as a text link, no bottom-nav offset and
 * no aria-live; and the page pads its bottom by the banner's height
 * (--bb-consent-h) so the banner never sits on the form. Everywhere else the
 * banner is as it was.
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

describe.each(["/register", "/login"])("compact banner on %s", (route) => {
  it("same words, no 🍪, no aria-live, clamped body behind Læs mere / Vis mindre", async () => {
    const banner = await openAt(route);
    expect(banner.getAttribute("data-cookie-compact")).toBe("1");
    expect(banner.getAttribute("role")).toBe("dialog");
    expect(banner.getAttribute("aria-label")).toBe(da.cookieBannerAria);
    expect(banner.hasAttribute("aria-live")).toBe(false);
    expect(banner.textContent).not.toContain("🍪");
    expect(banner.textContent).toContain(da.cookieBannerTitle);
    const body = banner.querySelector("#cookie-banner-body");
    expect(body.textContent).toBe(da.cookieBannerBody);
    expect(body.className).toMatch(/line-clamp-2/);
    const more = within(banner).getByRole("button", { name: da.suCookieMore });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(more);
    expect(body.className).not.toMatch(/line-clamp-2/);
    expect(within(banner).getByRole("button", { name: da.suCookieLess })).toBeTruthy();
    // no 3.5rem bottom-nav offset on these pages
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

describe("everywhere else the banner is unchanged", () => {
  it("/ keeps the full banner with its offset and aria-live", async () => {
    const banner = await openAt("/");
    expect(banner.hasAttribute("data-cookie-compact")).toBe(false);
    expect(banner.getAttribute("aria-live")).toBe("polite");
    expect(banner.className).toMatch(/3\.5rem/);
    expect(banner.textContent).toContain(da.cookieBannerBody);
  });
});

describe("the auth shell pads for it", () => {
  it("AuthShell's frame reads --bb-consent-h", () => {
    const src = fs.readFileSync(path.join(SRC, "components/auth/AuthUI.jsx"), "utf8");
    expect(src).toContain('paddingBottom: "var(--bb-consent-h, 0px)"');
  });
});
