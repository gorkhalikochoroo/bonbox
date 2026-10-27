/**
 * Booking R5 — the language provider on the booking page.
 *
 *  • On a booking address (Danish or English) the full dictionary is never
 *    asked for — not by the module's start-up preload, not by the provider's
 *    effect: the page's own words (lib/pageDict.js) are what it shows.
 *  • The page's words resolve in t(), in the guest's language, the moment
 *    the page registers them — and a later switch to the venue's language is
 *    instant (no download).
 *  • A key outside them is not a raw key for long: the full dictionary is
 *    fetched once.
 *  • Any other language still renders (the page's English while its own pack
 *    loads) — never a blank first paint.
 *  • `fullReady` stays about the FULL dictionary: App.jsx's gate lets the
 *    booking page through, holds every other route, and asks for the full
 *    dictionary when the guest leaves the page.
 */
import { useEffect } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const at = (p) => window.history.replaceState({}, "", p);

const PAGE_WORDS = {
  da: { rsvpConfirm: "Bekræft reservation", rsvpContinue: "Fortsæt" },
  en: { rsvpConfirm: "Confirm reservation", rsvpContinue: "Continue" },
};

async function freshProvider({ path = "/r/cafe", stored = "da", resolve = false } = {}) {
  vi.resetModules();
  const cache = {};
  const loadLocale = vi.fn((c) =>
    resolve ? Promise.resolve((cache[c] = { dashboardTitle: c === "da" ? "Oversigt" : "Overview" })) : new Promise(() => {}),
  );
  vi.doMock("../lib/localeStore", () => ({
    loadLocale,
    loadedLocales: () => cache,
    localesFor: (c) => (c === "da" || c === "en" ? [c] : [c, "en"]),
    hasLocale: () => true,
    primeLocales: () => {},
  }));
  localStorage.clear();
  if (stored) localStorage.setItem("lang", stored);
  at(path);
  const mod = await import("../hooks/useLanguage");
  const pageDict = await import("../lib/pageDict");
  return { ...mod, ...pageDict, loadLocale };
}

// The provider's hook for the test (set per test, after the fresh import),
// and the language switch it hands out — kept outside React, set in an effect.
let useLang = null;
let switchLang = null;
function Probe({ k = "rsvpConfirm" }) {
  const { t, lang, fullReady, setLang } = useLang();
  useEffect(() => {
    switchLang = setLang;
  }, [setLang]);
  return (
    <div>
      <span data-testid="word">{t(k)}</span>
      <span data-testid="lang">{lang}</span>
      <span data-testid="full">{String(fullReady)}</span>
    </div>
  );
}

afterEach(() => {
  cleanup();
  vi.doUnmock("../lib/localeStore");
  vi.resetModules();
  localStorage.clear();
  at("/");
  useLang = null;
  switchLang = null;
});

describe("on the booking page (Danish or English)", () => {
  it.each(["/r/cafe", "/cafe-nordlys", "/r/cafe?embed=1"])("%s: renders at once and never asks for the full dictionary", async (p) => {
    const { LanguageProvider, useLanguage, registerPageDict, loadLocale } = await freshProvider({ path: p });
    useLang = useLanguage;
    render(<LanguageProvider><Probe /></LanguageProvider>);
    expect(screen.getByTestId("lang").textContent).toBe("da");
    expect(screen.getByTestId("full").textContent).toBe("false");
    await act(async () => registerPageDict(PAGE_WORDS));
    expect(screen.getByTestId("word").textContent).toBe("Bekræft reservation");
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(loadLocale).not.toHaveBeenCalled();
  });

  it("before the page's words arrive, a miss fetches nothing (nothing on screen is the page yet)", async () => {
    const { LanguageProvider, useLanguage, loadLocale } = await freshProvider({ resolve: true });
    useLang = useLanguage;
    render(<LanguageProvider><Probe k="dashboardTitle" /></LanguageProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(loadLocale).not.toHaveBeenCalled();
  });

  it("an English guest at a Danish venue: the switch to Danish is instant (no download)", async () => {
    const { LanguageProvider, useLanguage, registerPageDict, loadLocale } = await freshProvider({ stored: "en" });
    useLang = useLanguage;
    registerPageDict(PAGE_WORDS);
    render(<LanguageProvider><Probe /></LanguageProvider>);
    expect(screen.getByTestId("word").textContent).toBe("Confirm reservation");
    await act(async () => switchLang("da"));
    expect(screen.getByTestId("lang").textContent).toBe("da");
    expect(screen.getByTestId("word").textContent).toBe("Bekræft reservation");
    expect(loadLocale).not.toHaveBeenCalled();
  });

  it("a key outside the page's words: the full dictionary is fetched once (never a raw key for long)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { LanguageProvider, useLanguage, registerPageDict, loadLocale } = await freshProvider({ resolve: true });
    useLang = useLanguage;
    registerPageDict(PAGE_WORDS);
    render(<LanguageProvider><Probe k="dashboardTitle" /></LanguageProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(new Set(loadLocale.mock.calls.map((c) => c[0]))).toEqual(new Set(["da"]));
    // ...and the word shows once it is in
    expect(screen.getByTestId("word").textContent).toBe("Oversigt");
    warn.mockRestore();
  });

  it("another language still paints at once (the page's English), its own pack loading behind", async () => {
    const { LanguageProvider, useLanguage, registerPageDict, loadLocale } = await freshProvider({ stored: "tr" });
    useLang = useLanguage;
    registerPageDict(PAGE_WORDS);
    render(<LanguageProvider><Probe /></LanguageProvider>);
    expect(screen.getByTestId("word").textContent).toBe("Confirm reservation");
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(loadLocale).toHaveBeenCalledWith("tr");
  });
});

describe("anywhere else, as before", () => {
  it("the owner app asks for its dictionary and waits for it", async () => {
    const { LanguageProvider, useLanguage, loadLocale } = await freshProvider({ path: "/dashboard", stored: "da" });
    useLang = useLanguage;
    render(<LanguageProvider><Probe /></LanguageProvider>);
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(loadLocale).toHaveBeenCalledWith("da");
    expect(screen.getByTestId("full").textContent).toBe("false");
  });
});

describe("App.jsx's FullDictionaryGate", () => {
  async function loadGate(fullReady) {
    vi.resetModules();
    const ensureFull = vi.fn();
    vi.doMock("../hooks/useLanguage", async (orig) => {
      const real = await orig();
      return { ...real, useLanguage: () => ({ ...real.useLanguage(), fullReady, ensureFull }) };
    });
    const app = await import("../App.jsx");
    const { LanguageProvider } = await import("../hooks/useLanguage");
    return { ...app, LanguageProvider, ensureFull };
  }
  const gateAt = (FullDictionaryGate, LanguageProvider, p) =>
    render(
      <MemoryRouter initialEntries={[p]}>
        <LanguageProvider>
          <FullDictionaryGate><span data-testid="page">page</span></FullDictionaryGate>
        </LanguageProvider>
      </MemoryRouter>,
    );

  it.each(["/r/cafe", "/cafe-nordlys", "/r/cafe?embed=1&compact=1"])("lets the booking page %s through on its own words", async (p) => {
    const { FullDictionaryGate, LanguageProvider, ensureFull } = await loadGate(false);
    gateAt(FullDictionaryGate, LanguageProvider, p);
    expect(screen.queryByTestId("page")).not.toBeNull();
    expect(ensureFull).not.toHaveBeenCalled();
    vi.doUnmock("../hooks/useLanguage");
  });

  it("holds any other route behind the loader and asks for the full dictionary", async () => {
    const { FullDictionaryGate, LanguageProvider, ensureFull } = await loadGate(false);
    gateAt(FullDictionaryGate, LanguageProvider, "/login");
    expect(screen.queryByTestId("page")).toBeNull();
    expect(screen.getByTestId("page-loader")).toBeTruthy();
    expect(ensureFull).toHaveBeenCalled();
    vi.doUnmock("../hooks/useLanguage");
  });
});
