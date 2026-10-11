/**
 * One cookie banner on every route (12 Oct 2026, Manoj: "our cookie asking
 * looks a bit outdated — make it nice, modern, good size, not whole-screen
 * catching").
 *
 *   • the same banner on every route — landing, sign-up doors, the app, the
 *     staff portal: no emoji, no aria-live, no fixed bottom-nav offset;
 *   • Accept all and Decline non-essential: one class (same size, same
 *     weight), side by side; "Tilpas" is a text button;
 *   • the visible text is ONE short sentence (cookieBannerShort, en + da) that
 *     stays true to the code: necessary storage keeps you signed in AND keeps
 *     the settings you choose yourself (theme, dismissed tips); Analytics and
 *     Marketing only on a yes. "Læs mere" → /cookies;
 *   • the full text (cookieBannerBody, unchanged) is in Tilpas;
 *   • the consent logic is unchanged: nothing is allowed before an answer,
 *     a decline stores analytics: false, only a yes turns Analytics on;
 *   • placement: on a phone the sheet sits on any bar marked
 *     data-bb-consent-clear (never over it); on desktop it floats 24 px off
 *     the corner, or 16 px above a marked button there.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import CookieConsent, { MARKETING_TEXT, getCookieConsent } from "../components/CookieConsent";
import { LanguageProvider } from "../hooks/useLanguage";
import { analyticsAllowed, analyticsDeclined } from "../hooks/useEventLog";
import { en } from "../i18n/en";
import { da } from "../i18n/da";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const KEY = "bonbox_cookie_consent";
const DICT = { en, da };
const EMOJI = /\p{Extended_Pictographic}/u;

async function openAt(pathname, { lang = "da", extra = null, beforeOpen = null } = {}) {
  localStorage.setItem("lang", lang);
  vi.useFakeTimers();
  render(
    <LanguageProvider>
      <MemoryRouter initialEntries={[pathname]}>
        {extra}
        <CookieConsent />
      </MemoryRouter>
    </LanguageProvider>,
  );
  if (beforeOpen) beforeOpen();
  await act(async () => { vi.advanceTimersByTime(700); });
  vi.useRealTimers();
  return document.querySelector('[data-cookie-consent="banner"]');
}

// Everything that decides how the banner looks, as one comparable value.
const shape = (banner) => ({
  outer: banner.className,
  card: banner.firstElementChild.className,
  buttons: within(banner).getAllByRole("button").map((b) => b.className),
  ariaLive: banner.getAttribute("aria-live"),
  compact: banner.getAttribute("data-cookie-compact"),
});

const rect = (top, height, width = 390) => () => ({
  top, height, width, bottom: top + height, left: 0, right: width, x: 0, y: top, toJSON() {},
});

beforeEach(() => { localStorage.clear(); document.documentElement.style.removeProperty("--bb-consent-h"); });
afterEach(() => { cleanup(); localStorage.clear(); delete window.matchMedia; });

describe("one banner on every route", () => {
  const ROUTES = ["/", "/register", "/login", "/verify-email", "/forgot-password", "/dashboard", "/sales", "/s/abc", "/cookies"];
  it.each(ROUTES)("%s looks exactly like the front page's", async (route) => {
    const home = shape(await openAt("/"));
    cleanup();
    localStorage.clear();
    const here = await openAt(route);
    expect(shape(here)).toEqual(home);
    expect(here.hasAttribute("aria-live")).toBe(false);
    expect(here.className).not.toMatch(/3\.5rem/);
  });
});

describe.each(["en", "da"])("the banner in %s", (lang) => {
  const d = DICT[lang];

  it("Accept and Decline share one class, side by side; Tilpas is a text button", async () => {
    const banner = await openAt("/", { lang });
    const accept = within(banner).getByRole("button", { name: d.cookieAcceptAll });
    const decline = within(banner).getByRole("button", { name: d.cookieDeclineNonEssential });
    const tilpas = within(banner).getByRole("button", { name: d.cookieCustomize });
    expect(accept.className).toBe(decline.className);
    expect(accept.parentElement).toBe(decline.parentElement);
    expect(accept.parentElement.className).toMatch(/grid-cols-2/);
    expect(accept.className).toMatch(/min-h-11/); // 44 px tap target
    expect(tilpas.className).not.toBe(accept.className);
    expect(tilpas.className).toMatch(/underline/);
    expect(tilpas.className).toMatch(/min-h-11/);
  });

  it("no emoji — on the banner or in Tilpas", async () => {
    const banner = await openAt("/", { lang });
    expect(banner.textContent).not.toMatch(EMOJI);
    fireEvent.click(within(banner).getByRole("button", { name: d.cookieCustomize }));
    expect(screen.getByRole("dialog").textContent).not.toMatch(EMOJI);
  });

  it("shows the one short sentence, not the full text, and Læs mere goes to /cookies", async () => {
    const banner = await openAt("/", { lang });
    expect(banner.querySelector("#cookie-banner-short").textContent).toBe(d.cookieBannerShort);
    expect(banner.textContent).not.toContain(d.cookieBannerBody);
    expect(d.cookieBannerShort.length).toBeLessThan(d.cookieBannerBody.length / 3);
    expect(within(banner).getByRole("link", { name: d.suCookieMore }).getAttribute("href")).toBe("/cookies");
  });

  it("the full text, word for word, is in Tilpas with the three switches", async () => {
    const banner = await openAt("/", { lang });
    fireEvent.click(within(banner).getByRole("button", { name: d.cookieCustomize }));
    expect(document.querySelector("#cookie-banner-body").textContent).toBe(d.cookieBannerBody);
    expect(screen.getAllByRole("switch")).toHaveLength(3);
    expect(screen.getByRole("dialog").textContent).toContain(d.cookieDrawerTitle);
  });
});

describe("the short sentence stays true to the code", () => {
  it("en: signed in + the settings you choose are necessary; Analytics and marketing only on a yes", () => {
    expect(en.cookieBannerShort).toBe(
      "We use necessary cookies to keep you signed in and remember the settings you choose. Analytics and marketing are optional and only used if you say yes.",
    );
  });
  it("da: logget ind + de indstillinger, du selv vælger, er nødvendige; Analyse og markedsføring kun ved et ja", () => {
    expect(da.cookieBannerShort).toBe(
      "Vi bruger nødvendige cookies til at holde dig logget ind og huske de indstillinger, du selv vælger. Analyse og markedsføring er valgfrie og bruges kun, hvis du siger ja.",
    );
  });
  it("names the same optional categories the switches do", () => {
    expect(en.cookieBannerShort.toLowerCase()).toContain(en.cookieCatAnalytics.toLowerCase());
    expect(en.cookieBannerShort.toLowerCase()).toContain(en.cookieCatMarketing.toLowerCase());
    expect(da.cookieBannerShort.toLowerCase()).toContain(da.cookieCatAnalytics.toLowerCase());
    expect(da.cookieBannerShort.toLowerCase()).toContain(da.cookieCatMarketing.toLowerCase());
  });
});

describe("the consent logic is unchanged", () => {
  it("nothing is allowed before an answer; Decline stores analytics: false", async () => {
    const banner = await openAt("/", { lang: "en" });
    expect(getCookieConsent()).toBeNull();
    expect(analyticsAllowed()).toBe(false);
    fireEvent.click(within(banner).getByRole("button", { name: en.cookieDeclineNonEssential }));
    expect(getCookieConsent()).toEqual({ necessary: true, analytics: false, marketing: false });
    expect(analyticsAllowed()).toBe(false);
    expect(analyticsDeclined()).toBe(true);
    expect(document.querySelector('[data-cookie-consent="banner"]')).toBeNull();
  });

  it("only Accept all turns Analytics on, stamped as before", async () => {
    const banner = await openAt("/", { lang: "en" });
    fireEvent.click(within(banner).getByRole("button", { name: en.cookieAcceptAll }));
    const saved = JSON.parse(localStorage.getItem(KEY));
    expect(saved.version).toBe(1);
    expect(saved.marketingText).toBe(MARKETING_TEXT);
    expect(saved.choices).toEqual({ necessary: true, analytics: true, marketing: true });
    expect(analyticsAllowed()).toBe(true);
  });

  it("Tilpas → Analytics on, Marketing off → Save keeps exactly that", async () => {
    const banner = await openAt("/", { lang: "en" });
    fireEvent.click(within(banner).getByRole("button", { name: en.cookieCustomize }));
    fireEvent.click(screen.getAllByRole("switch")[1]);
    fireEvent.click(screen.getByRole("button", { name: en.cookieSaveChoices }));
    expect(getCookieConsent()).toEqual({ necessary: true, analytics: true, marketing: false });
  });

  it("an answered banner stays closed", async () => {
    localStorage.setItem(KEY, JSON.stringify({
      version: 1, marketingText: MARKETING_TEXT, timestamp: new Date().toISOString(),
      choices: { necessary: true, analytics: false, marketing: false },
    }));
    expect(await openAt("/")).toBeNull();
  });
});

describe("placement", () => {
  const bar = <nav data-bb-consent-clear="" data-testid="bar" />;
  const markBar = (top, height, width) => () => {
    document.querySelector('[data-testid="bar"]').getBoundingClientRect = rect(top, height, width);
  };

  it("phone, no bar: on the bottom edge, padding for the home indicator", async () => {
    const banner = await openAt("/");
    expect(banner.style.bottom).toBe("0px");
    // jsdom drops env() values, so read the rule: the sheet pads for the home
    // indicator only when nothing is under it (on a bar, the bar does).
    expect(read("components/CookieConsent.jsx")).toContain('edgePad ? { paddingBottom: "env(safe-area-inset-bottom, 0px)" } : undefined');
    expect(read("components/CookieConsent.jsx")).toContain("const edgePad = !wide && clear === 0;");
  });

  it("phone with a tab bar: sits on the bar, never over it", async () => {
    const banner = await openAt("/dashboard", { extra: bar, beforeOpen: markBar(window.innerHeight - 64, 64) });
    expect(banner.style.bottom).toBe("64px");
    expect(banner.firstElementChild.style.paddingBottom).toBe("");
  });

  it("a hidden bar (zero size, e.g. md:hidden) is ignored", async () => {
    const banner = await openAt("/dashboard", { extra: bar, beforeOpen: markBar(window.innerHeight - 64, 0, 0) });
    expect(banner.style.bottom).toBe("0px");
  });

  it("desktop: 24 px off the corner, or 16 px above a marked button there", async () => {
    window.matchMedia = vi.fn(() => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }));
    let banner = await openAt("/");
    expect(banner.style.bottom).toBe("24px");
    expect(banner.className).toMatch(/md:left-6/);
    expect(banner.className).toMatch(/md:w-\[420px\]/);
    cleanup();
    localStorage.clear();
    banner = await openAt("/dashboard", { extra: bar, beforeOpen: markBar(window.innerHeight - 64, 40, 40) });
    expect(banner.style.bottom).toBe("80px");
  });

  it("fades in on opacity only, and only when motion is allowed", async () => {
    const banner = await openAt("/");
    expect(banner.className).toMatch(/motion-safe:animate-\[bbFade_180ms_ease-out\]/);
    expect(read("index.css")).toMatch(/@keyframes bbFade \{\s*from \{ opacity: 0; \}\s*to \{ opacity: 1; \}\s*\}/);
  });
});

describe("the page pads for the banner (--bb-consent-h)", () => {
  it("the bars the banner sits on, and the desktop '+', are marked", () => {
    expect(read("components/MobileBottomNav.jsx")).toContain('data-bb-consent-clear=""');
    expect(read("pages/StaffPortalPage.jsx")).toContain('<nav data-bb-consent-clear=""');
    expect(read("components/QuickAdd.jsx")).toContain('data-bb-consent-clear=""');
  });
  it("body pads by it on a phone (not on AuthShell pages, which pad themselves, nor the portal)", () => {
    const css = read("index.css");
    expect(css).toContain("body:not(.portal-shell):not(:has([data-auth-shell]))");
    expect(css).toContain("padding-bottom: calc(env(safe-area-inset-bottom) + var(--bb-consent-h, 0px));");
    expect(read("components/auth/AuthUI.jsx")).toContain('data-auth-shell=""');
  });
  it("the staff portal's own scroller pads by it", () => {
    expect(read("pages/StaffPortalPage.jsx")).toContain('paddingBottom: "calc(6rem + var(--bb-consent-h, 0px))"');
  });
  it("every route publishes it while the banner is up and clears it once answered", async () => {
    const banner = await openAt("/");
    expect(document.documentElement.style.getPropertyValue("--bb-consent-h")).toMatch(/^\d+px$/);
    fireEvent.click(within(banner).getByRole("button", { name: da.cookieAcceptAll }));
    expect(document.documentElement.style.getPropertyValue("--bb-consent-h")).toBe("");
  });
});
