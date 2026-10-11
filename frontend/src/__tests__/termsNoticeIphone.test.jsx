/**
 * Brand release (Manoj, 11 Oct 2026; App Store guideline 3.1.1): the in-app
 * Terms notice on the iPhone app says nothing about renewal, the founding
 * price, prices or buying — the same line the iPhone § 8 in TermsPage holds.
 * The browser keeps the full "what changed" list (reTermsTransition pins it).
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

let langCode = "da";
const dict = () => (langCode === "da" ? da : en);
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    lang: langCode,
    setLang: () => {},
    LANGUAGES: [],
    t: (k, fb, vars) => {
      const v = typeof fb === "object" && fb ? fb : vars;
      let s = dict()[k] ?? en[k] ?? (typeof fb === "string" ? fb : k);
      if (v && typeof s === "string") s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
      return s;
    },
  }),
  LanguageProvider: ({ children }) => children,
}));

vi.mock("../services/api", () => ({
  default: { post: vi.fn(() => Promise.resolve({ data: { ok: true } })), get: vi.fn(() => Promise.resolve({ data: {} })) },
}));

vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "o1", role: "owner", business_type: "cafe", terms_notice_due: true } }),
  AuthProvider: ({ children }) => children,
}));

let native = true;
vi.mock("../utils/platform", () => ({
  isNativeApp: () => native,
  canPurchaseInApp: () => !native,
  platform: { isNative: false, isIOS: false, isAndroid: false, isWeb: true },
  isIPad: () => false,
}));

const { TERMS_VERSION, TERMS_EXISTING_FROM, termsDate, copenhagenMidnightMs } = await import("../legal/terms");
const TermsUpdateNotice = (await import("../components/TermsUpdateNotice")).default;

const DURING = new Date(copenhagenMidnightMs(TERMS_VERSION) + 2 * 86400000 + 9 * 3600000);

// Words that would mention renewal, the founding price, a price or a purchase.
const PRICE_WORDS = {
  en: /renew|founding|price|purchase|\bbuy|\bpaid\b|\bpay|charge|refund|\bkr\b|kroner|DKK|checkout|upgrade|Starter|\bPro\b/i,
  da: /forny|stifterpris|pris|køb|betal|refunder|\bkr\b|kr\.|kroner|DKK|opgrader|Starter|\bPro\b/i,
};

beforeEach(() => {
  native = true;
  langCode = "da";
  try { localStorage.clear(); } catch { /* ignore */ }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DURING);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const openNotice = () => {
  render(<MemoryRouter initialEntries={["/dashboard"]}><TermsUpdateNotice /></MemoryRouter>);
  fireEvent.click(screen.getByRole("button", { name: langCode === "da" ? "Hvad er ændret?" : "What changed?" }));
  return screen.getByTestId("terms-update-notice");
};

describe("iPhone app: the Terms notice names no renewal, founding price, price or purchase", () => {
  for (const lang of ["da", "en"]) {
    it(lang, () => {
      langCode = lang;
      const d = lang === "da" ? da : en;
      const row = openNotice();
      const text = row.textContent;
      expect(text).not.toMatch(PRICE_WORDS[lang]);
      for (const k of ["termsNoticeChangeBusiness", "termsNoticeChangeRenewal", "termsNoticeChangeFounding", "termsNoticeChangePrice"]) {
        expect(text).not.toContain(d[k]);
      }
      const items = [...row.querySelectorAll("li")].map((li) => li.textContent);
      expect(items).toEqual([d.termsNoticeChangeCaps, d.termsNoticeChangeRecords, d.termsNoticeChangeSubscriptionsNative]);
      // It still points to the terms (which open the iPhone § 8) and keeps the
      // date and the way out.
      expect(screen.getByRole("link", { name: lang === "da" ? "Læs betingelserne" : "Read the terms" }).getAttribute("href")).toBe("/terms");
      expect(text).toContain(termsDate(TERMS_EXISTING_FROM, lang));
    });
  }

  it("the neutral § 8 line is real Danish and English, with no price words", () => {
    expect(da.termsNoticeChangeSubscriptionsNative).toBe("§ 8 om abonnementer er også ændret. Du kan læse den i betingelserne.");
    expect(en.termsNoticeChangeSubscriptionsNative).toBe("§ 8 about subscriptions has changed too. You can read it in the terms.");
    expect(da.termsNoticeChangeSubscriptionsNative).not.toMatch(PRICE_WORDS.da);
    expect(en.termsNoticeChangeSubscriptionsNative).not.toMatch(PRICE_WORDS.en);
  });
});

describe("browser: the full list is unchanged", () => {
  it("all six bullets, no iPhone line", () => {
    native = false;
    const row = openNotice();
    const items = [...row.querySelectorAll("li")].map((li) => li.textContent);
    expect(items).toEqual([
      da.termsNoticeChangeCaps, da.termsNoticeChangeRecords, da.termsNoticeChangeBusiness,
      da.termsNoticeChangeRenewal, da.termsNoticeChangeFounding, da.termsNoticeChangePrice,
    ]);
    expect(screen.queryByTestId("terms-notice-native-subscriptions")).toBeNull();
  });
});
