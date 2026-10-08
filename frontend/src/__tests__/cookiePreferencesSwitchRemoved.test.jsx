/**
 * The cookie banner has no "Preferences" switch (Manoj, 8 Oct 2026).
 *
 * It did nothing: no code read getCookieConsent().functional, and theme,
 * dismissed tips and similar self-chosen settings were stored whatever it
 * said. It is gone, and the banner, /cookies and /privacy say plainly that
 * settings you choose yourself are stored on your device because they are
 * necessary for what you asked BonBox to do, and are used for nothing else.
 *
 *   • every banner language (en, da, np, vi, th, tr): three switches —
 *     necessary (locked), Analytics, Marketing — and no Preferences title;
 *   • the banner text and the necessary category say it, in each language;
 *   • an answer saved by the older banner (with a "functional" key) still
 *     loads: the banner stays closed and Analytics/Marketing keep their value;
 *     a new answer never writes "functional";
 *   • /cookies and /privacy (en + da) carry the sentence.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it } from "vitest";
import CookieConsent, { MARKETING_TEXT, getCookieConsent } from "../components/CookieConsent";
import CookiePolicyPage from "../pages/CookiePolicyPage";
import PrivacyPolicyPage from "../pages/PrivacyPolicyPage";
import { LanguageProvider } from "../hooks/useLanguage";
import { en } from "../i18n/en";
import { da } from "../i18n/da";
import { np } from "../i18n/np";
import { vi as viDict } from "../i18n/vi";
import { th } from "../i18n/th";
import { tr } from "../i18n/tr";

const KEY = "bonbox_cookie_consent";

// The Preferences title each banner language used to show.
const OLD_TITLE = {
  en: "Preferences", da: "Præferencer", np: "प्राथमिकताहरू", vi: "Tuỳ chọn", th: "การตั้งค่า", tr: "Tercihler",
};
const DICT = { en, da, np, vi: viDict, th, tr };
// Every dictionary is flat or nested; find a key anywhere.
const lookup = (dict, key) => {
  if (!dict || typeof dict !== "object") return undefined;
  if (typeof dict[key] === "string") return dict[key];
  for (const v of Object.values(dict)) {
    const hit = lookup(v, key);
    if (hit !== undefined) return hit;
  }
  return undefined;
};
// What each language says about self-chosen settings (theme, tips).
const THEME_WORD = { en: "theme", da: "tema", np: "थिम", vi: "giao diện", th: "ธีม", tr: "tema" };
// The word for "language" each necessary-category text used to list.
const LANGUAGE_WORD = { en: "language", da: "sprog", np: "भाषा", vi: "ngôn ngữ", th: "ภาษา", tr: "dil," };

const mount = (ui, lang) => {
  localStorage.setItem("lang", lang);
  return render(
    <LanguageProvider>
      <MemoryRouter>
        {ui}
      </MemoryRouter>
    </LanguageProvider>,
  );
};

beforeEach(() => {
  localStorage.clear();
});

describe.each(Object.keys(OLD_TITLE))("banner in %s", (lang) => {
  it("has no Preferences switch and says self-chosen settings are necessary storage", async () => {
    mount(<CookieConsent />, lang);
    const dialog = await screen.findByRole("dialog", {}, { timeout: 3000 });
    const body = lookup(DICT[lang], "cookieBannerBody");
    expect(body).toContain(THEME_WORD[lang]);
    expect(dialog.textContent).toContain(body);

    fireEvent.click(within(dialog).getAllByRole("button").at(-1)); // Customize
    await waitFor(() => expect(screen.getAllByRole("switch")).toHaveLength(3));
    const switches = screen.getAllByRole("switch");
    expect(switches[0]).toBeDisabled(); // strictly necessary, locked on
    expect(screen.queryByText(OLD_TITLE[lang], { exact: true })).toBeNull();
    const necessary = lookup(DICT[lang], "cookieCatNecessaryDesc");
    expect(necessary).toContain(THEME_WORD[lang]);
    expect(screen.getByText(necessary)).toBeInTheDocument();
  });

  it("the necessary text does not say the language stays on the device (it is also saved on the account)", () => {
    // AccountLanguageSync saves ui_language on the account so pushes and
    // mails arrive in it; /privacy lists "Foretrukket sprog" as account data.
    const necessary = lookup(DICT[lang], "cookieCatNecessaryDesc");
    expect(necessary).not.toContain(LANGUAGE_WORD[lang]);
    expect(necessary).toContain(THEME_WORD[lang]);
  });

  it("the dictionary no longer carries the switch's texts", () => {
    expect(lookup(DICT[lang], "cookieCatFunctional")).toBeUndefined();
    expect(lookup(DICT[lang], "cookieCatFunctionalDesc")).toBeUndefined();
  });
});

describe("stored answers", () => {
  it("an older answer with a 'functional' key still loads, and the banner stays closed", async () => {
    localStorage.setItem(KEY, JSON.stringify({
      version: 1, marketingText: MARKETING_TEXT, timestamp: new Date().toISOString(),
      choices: { necessary: true, functional: true, analytics: false, marketing: true },
    }));
    expect(getCookieConsent()).toEqual({ necessary: true, analytics: false, marketing: true });
    mount(<CookieConsent />, "da");
    await new Promise((r) => setTimeout(r, 700));
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("an answer saved without the key (an older one declined everything) loads the same way", () => {
    localStorage.setItem(KEY, JSON.stringify({
      version: 1, timestamp: new Date().toISOString(),
      choices: { necessary: true, functional: false, analytics: false, marketing: false },
    }));
    expect(getCookieConsent()).toEqual({ necessary: true, analytics: false, marketing: false });
  });

  it("a new answer never writes 'functional'", async () => {
    mount(<CookieConsent />, "en");
    const dialog = await screen.findByRole("dialog", {}, { timeout: 3000 });
    fireEvent.click(within(dialog).getByRole("button", { name: /accept all/i }));
    const saved = JSON.parse(localStorage.getItem(KEY));
    expect(saved.version).toBe(1);
    expect(saved.choices).toEqual({ necessary: true, analytics: true, marketing: true });
    expect("functional" in saved.choices).toBe(false);
  });
});

describe.each([
  ["/cookies", CookiePolicyPage, "cookies-own-settings"],
  ["/privacy", PrivacyPolicyPage, "privacy-own-settings"],
])("%s says it plainly", (_path, Page, testId) => {
  it.each([
    ["en", ["light/dark theme", "dismissed tips", "necessary for what you asked BonBox", "not used for anything else"]],
    ["da", ["lyst/mørkt tema", "tip, du har lukket", "nødvendige for det, du har bedt BonBox om", "bruges ikke til andet"]],
  ])("%s", (lang, parts) => {
    localStorage.setItem(KEY, JSON.stringify({
      version: 1, marketingText: MARKETING_TEXT, timestamp: new Date().toISOString(),
      choices: { necessary: true, analytics: false, marketing: false },
    }));
    mount(<Page />, lang);
    const el = screen.getByTestId(testId);
    for (const p of parts) expect(el.textContent).toContain(p);
  });
});
