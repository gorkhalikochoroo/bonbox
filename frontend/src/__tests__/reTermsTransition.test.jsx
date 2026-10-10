/**
 * R-e follow-up — the Terms reach existing accounts honestly (Manoj, 10 Oct).
 *
 *   (a) Existing accounts get an IN-APP notice only (no e-mail). The Terms
 *       apply to them from TERMS_EXISTING_FROM (the deploy day + 15 days, so
 *       at least the 14 full days the 13 May Terms §14 promise); new sign-ups
 *       accept them at once. The two dates are RELEASE-TIME constants
 *       (src/legal/terms.js, set on the day R-e ships) — every date and time
 *       here is derived from them. The Terms page prints both dates. The
 *       notice is calm, closable, links to /terms, says what changed (first:
 *       caps on every plan replace the old free-features promise), stops on
 *       its own at 00:00 Copenhagen on TERMS_EXISTING_FROM — also in a tab
 *       left open, on focus / visibility — is never on the day's close, and
 *       closing it is NOT acceptance (it POSTs only /auth/terms-notice/dismiss).
 *   (b) Free is not promised "for altid" / "forever" anywhere user-facing.
 *   (c) The Danish version prevails: § 15 says so (da + en).
 *   (d) VAT status is not confirmed: no Terms / price / checkout / FAQ copy
 *       says moms is or is not added.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
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

const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { post: (...a) => post(...a), get: vi.fn(() => Promise.resolve({ data: {} })) },
}));

let authState;
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => authState,
  AuthProvider: ({ children }) => children,
}));

const {
  TERMS_VERSION, TERMS_EXISTING_FROM, termsDate, copenhagenMidnightMs, termsNoticeWindowOpen,
} = await import("../legal/terms");
const TermsPage = (await import("../pages/TermsPage")).default;
const TermsUpdateNotice = (await import("../components/TermsUpdateNotice")).default;

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

// All derived from the two release-time dates.
const DAY = 86400000;
const EFFECTIVE = new Date(copenhagenMidnightMs(TERMS_EXISTING_FROM));   // 00:00 Copenhagen: Terms apply
const LAST_MINUTE = new Date(EFFECTIVE.getTime() - 60000);              // 23:59 the day before
const DURING = new Date(copenhagenMidnightMs(TERMS_VERSION) + 2 * DAY + 9 * 3600000);
const nextIsoDay = (iso) => new Date(Date.parse(`${iso}T12:00:00Z`) + DAY).toISOString().slice(0, 10);
const DA_DATES = `Gælder for nye konti fra ${termsDate(TERMS_VERSION, "da")} og for eksisterende konti fra ${termsDate(TERMS_EXISTING_FROM, "da")}.`;
const EN_DATES = `Applies to new accounts from ${termsDate(TERMS_VERSION, "en")} and to existing accounts from ${termsDate(TERMS_EXISTING_FROM, "en")}.`;

const owner = (extra = {}) => ({ id: "o1", role: "owner", business_type: "cafe", terms_notice_due: true, ...extra });

beforeEach(() => {
  post.mockReset();
  post.mockImplementation(() => Promise.resolve({ data: { ok: true } }));
  langCode = "da";
  authState = { user: owner() };
  try { localStorage.clear(); } catch { /* ignore */ }
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(DURING);
});
afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

const renderNotice = (at = "/dashboard") =>
  render(<MemoryRouter initialEntries={[at]}><TermsUpdateNotice /></MemoryRouter>);

// ─────────────────────────── the dates ───────────────────────────

describe("the two dates (decision a; release-time constants)", () => {
  it("both are real ISO days", () => {
    for (const d of [TERMS_VERSION, TERMS_EXISTING_FROM]) {
      expect(d).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10)).toBe(d);
    }
  });

  it("existing accounts: at least 15 calendar days after the deploy day = 14 full days of notice", () => {
    const days = (Date.parse(TERMS_EXISTING_FROM) - Date.parse(TERMS_VERSION)) / DAY;
    expect(days).toBeGreaterThanOrEqual(15);
    // In real hours: even a deploy at 23:59 leaves 14 x 24 h before the cut-off.
    const endOfDeployDay = copenhagenMidnightMs(nextIsoDay(TERMS_VERSION));
    expect(EFFECTIVE.getTime() - endOfDeployDay).toBeGreaterThanOrEqual(14 * DAY);
  });

  it("the notice ends at 00:00 Copenhagen (summer and winter time)", () => {
    expect(copenhagenMidnightMs("2026-10-14")).toBe(Date.parse("2026-10-13T22:00:00Z"));
    expect(copenhagenMidnightMs("2026-10-24")).toBe(Date.parse("2026-10-23T22:00:00Z"));
    expect(copenhagenMidnightMs("2026-10-25")).toBe(Date.parse("2026-10-24T22:00:00Z"));
    expect(copenhagenMidnightMs("2026-10-29")).toBe(Date.parse("2026-10-28T23:00:00Z"));
    expect(copenhagenMidnightMs("2026-12-01")).toBe(Date.parse("2026-11-30T23:00:00Z"));
    expect(termsNoticeWindowOpen(LAST_MINUTE.getTime())).toBe(true);
    expect(termsNoticeWindowOpen(EFFECTIVE.getTime())).toBe(false);
  });

  it("the page dates are written the Danish and English way", () => {
    expect(termsDate("2026-10-14", "da")).toBe("14. oktober 2026");
    expect(termsDate("2026-10-29", "da")).toBe("29. oktober 2026");
    expect(termsDate("2026-10-29", "en")).toBe("29 October 2026");
  });
});

// ─────────────────────────── /terms ───────────────────────────

describe("Terms page: effective dates and the language clause", () => {
  const renderTerms = (lang) => {
    langCode = lang;
    return render(<MemoryRouter><TermsPage /></MemoryRouter>).container.textContent;
  };

  it("da", () => {
    const text = renderTerms("da");
    expect(text).toContain(DA_DATES);
    expect(screen.getByTestId("terms-effective-dates").textContent).toContain(termsDate(TERMS_EXISTING_FROM, "da"));
    expect(screen.getByRole("heading", { level: 2, name: "15. Kontakt og sprog" })).toBeTruthy();
    expect(text).toContain("Vilkårene findes på dansk og engelsk. Ved uoverensstemmelse gælder den danske version.");
  });

  it("en", () => {
    const text = renderTerms("en");
    expect(text).toContain(EN_DATES);
    expect(screen.getByTestId("terms-effective-dates").textContent).toContain(termsDate(TERMS_EXISTING_FROM, "en"));
    expect(screen.getByRole("heading", { level: 2, name: "15. Contact and language" })).toBeTruthy();
    expect(text).toContain("These terms exist in Danish and English. If they differ, the Danish version applies.");
  });

  it("§ 8 says where the amount is shown, never whether moms is added (decision d)", () => {
    let text = renderTerms("da");
    expect(text).toContain("Beløbet, du skal betale, vises ved betalingen, før du bekræfter købet.");
    expect(text).not.toMatch(/moms oven i|momsregistr|uden moms|ekskl\. moms|inkl\. moms/i);
    cleanup();
    text = renderTerms("en");
    expect(text).toContain("The amount you pay is shown at checkout before you confirm the purchase.");
    expect(text).not.toMatch(/No VAT|VAT \(moms\) is added|not VAT-registered|excl\. VAT|incl\. VAT/i);
  });
});

// ─────────────────────────── the notice ───────────────────────────

describe("TermsUpdateNotice (decision a: in-app only)", () => {
  it("da: says the Terms are updated, apply from TERMS_EXISTING_FROM, links to /terms; what changed is behind a disclosure", () => {
    renderNotice();
    const row = screen.getByTestId("terms-update-notice");
    expect(row.getAttribute("role")).toBe("status");
    expect(row.textContent).toContain(`Vi har opdateret vores Handelsbetingelser. De gælder for din konto fra ${termsDate(TERMS_EXISTING_FROM, "da")}.`);
    expect(screen.getByRole("link", { name: "Læs betingelserne" }).getAttribute("href")).toBe("/terms");
    const toggle = screen.getByRole("button", { name: "Hvad er ændret?" });
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(row.textContent).not.toContain(da.termsNoticeChangeFounding);

    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    const text = row.textContent;
    for (const k of ["termsNoticeChangeCaps", "termsNoticeChangeRecords", "termsNoticeChangeBusiness",
      "termsNoticeChangeRenewal", "termsNoticeChangeFounding", "termsNoticeChangePrice"]) {
      expect(text).toContain(da[k]);
    }
    // What matters most to today's Free owners comes first; then the § 4
    // change every owner meets before deleting (own records, immediate deletion).
    const items = [...row.querySelectorAll("li")].map((li) => li.textContent);
    expect(items[0]).toBe(da.termsNoticeChangeCaps);
    expect(items[1]).toBe(da.termsNoticeChangeRecords);
    expect(items).toHaveLength(6);
    expect(text).toContain(`Vil du ikke fortsætte på de nye betingelser, kan du opsige dit abonnement eller slette din konto før ${termsDate(TERMS_EXISTING_FROM, "da")}.`);
  });

  it("en", () => {
    langCode = "en";
    renderNotice();
    expect(screen.getByTestId("terms-update-notice").textContent)
      .toContain(`We have updated our Terms of Service. They apply to your account from ${termsDate(TERMS_EXISTING_FROM, "en")}.`);
    expect(screen.getByRole("link", { name: "Read the terms" }).getAttribute("href")).toBe("/terms");
  });

  it("the server decides who: no flag, no notice (staff, new accounts, accepted, closed)", () => {
    for (const user of [owner({ terms_notice_due: false }), owner({ terms_notice_due: undefined }), null]) {
      authState = { user };
      const { unmount } = renderNotice();
      expect(screen.queryByTestId("terms-update-notice")).toBeNull();
      unmount();
    }
  });

  it("stops on its own at 00:00 Copenhagen on TERMS_EXISTING_FROM, even in a tab opened before", () => {
    vi.setSystemTime(LAST_MINUTE);
    const first = renderNotice();
    expect(screen.queryByTestId("terms-update-notice")).not.toBeNull();
    first.unmount();
    vi.setSystemTime(EFFECTIVE);
    renderNotice();
    expect(screen.queryByTestId("terms-update-notice")).toBeNull();
  });

  it("a tab left open drops the row at the cut-off when it gets focus or becomes visible again", () => {
    vi.setSystemTime(LAST_MINUTE);
    renderNotice();
    expect(screen.queryByTestId("terms-update-notice")).not.toBeNull();
    vi.setSystemTime(EFFECTIVE);
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(screen.queryByTestId("terms-update-notice")).toBeNull();
    cleanup();

    vi.setSystemTime(LAST_MINUTE);
    renderNotice();
    expect(screen.queryByTestId("terms-update-notice")).not.toBeNull();
    vi.setSystemTime(EFFECTIVE);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(screen.queryByTestId("terms-update-notice")).toBeNull();
  });

  it("before the cut-off a focus changes nothing", () => {
    renderNotice();
    act(() => { window.dispatchEvent(new Event("focus")); });
    expect(screen.queryByTestId("terms-update-notice")).not.toBeNull();
  });

  it("never on the day's close", () => {
    renderNotice("/daily-close");
    expect(screen.queryByTestId("terms-update-notice")).toBeNull();
  });

  it("closing hides it, is remembered for the account (server) and this device, and is never an acceptance", async () => {
    const first = renderNotice();
    await act(async () => {
      fireEvent.click(screen.getByTestId("terms-update-notice-close"));
    });
    expect(screen.queryByTestId("terms-update-notice")).toBeNull();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0]).toEqual(["/auth/terms-notice/dismiss"]);
    // No acceptance is sent: no body, no accept_terms, no other endpoint.
    expect(JSON.stringify(post.mock.calls)).not.toMatch(/accept/);
    first.unmount();
    // Same device, the /me flag still stale: stays closed.
    renderNotice();
    expect(screen.queryByTestId("terms-update-notice")).toBeNull();
  });

  it("a failed request still closes it on this device", async () => {
    post.mockImplementation(() => Promise.reject(new Error("offline")));
    const first = renderNotice();
    await act(async () => {
      fireEvent.click(screen.getByTestId("terms-update-notice-close"));
    });
    expect(screen.queryByTestId("terms-update-notice")).toBeNull();
    first.unmount();
    renderNotice();
    expect(screen.queryByTestId("terms-update-notice")).toBeNull();
  });

  it("another account on the same device still sees its own notice", async () => {
    const first = renderNotice();
    await act(async () => {
      fireEvent.click(screen.getByTestId("terms-update-notice-close"));
    });
    first.unmount();
    authState = { user: owner({ id: "o2" }) };
    renderNotice();
    expect(screen.queryByTestId("terms-update-notice")).not.toBeNull();
  });

  it("is mounted for every page in the app layout, after the e-mail reminder (source contract)", () => {
    const src = read("components/Layout.jsx");
    expect(src).toContain('import TermsUpdateNotice from "./TermsUpdateNotice";');
    const main = src.slice(src.indexOf('id="main-content"'));
    expect(main.indexOf("<VerifyEmailReminder />")).toBeGreaterThan(-1);
    expect(main.indexOf("<TermsUpdateNotice />")).toBeGreaterThan(main.indexOf("<VerifyEmailReminder />"));
    expect(main.indexOf("<TermsUpdateNotice />")).toBeLessThan(main.indexOf("<Outlet />"));
  });

  it("calm: the neutral row of the app's quiet notices — no amber/red, no glow", () => {
    const src = read("components/TermsUpdateNotice.jsx");
    expect(src).not.toMatch(/amber-|red-|rose-|shadow-|animate-|ring-offset|glow/);
    expect(src).toContain("bg-gray-50/40");
  });

  it("every notice key has real Danish and English", () => {
    const keys = ["termsNoticeText", "termsNoticeRead", "termsNoticeWhatChanged", "termsNoticeHide",
      "termsNoticeChangeCaps", "termsNoticeChangeRecords", "termsNoticeChangeRenewal", "termsNoticeChangeFounding",
      "termsNoticeChangePrice", "termsNoticeChangeBusiness", "termsNoticeObject"];
    for (const k of keys) {
      expect(typeof da[k]).toBe("string");
      expect(typeof en[k]).toBe("string");
      expect(da[k]).not.toBe(en[k]);
    }
    expect(da.termsNoticeText).toContain("Handelsbetingelser");
    expect(da.termsNoticeText).toContain("{date}");
    expect(da.termsNoticeChangeRenewal).toContain("ved udgangen af den periode, du har betalt for");
    expect(da.termsNoticeChangeRenewal).toContain("vi refunderer ikke for en del af en periode");
    expect(da.termsNoticeChangePrice).toContain("mindst 30 dage");
    expect(da.termsNoticeChangeBusiness).toContain("kun for virksomheder");
    // The change that reaches today's Free owners, true to the new § 8 and the
    // live § 8 it replaces.
    expect(da.termsNoticeChangeCaps).toContain("Alle planer, også Free, har forbrugslofter");
    expect(da.termsNoticeChangeCaps).toContain("ændre, begrænse eller fjerne funktioner og forbrugslofter med rimeligt varsel");
    expect(da.termsNoticeChangeCaps).toContain("den eksisterende gratis funktionalitet forbliver tilgængelig");
    expect(da.termsNoticeChangeCaps).toContain("med tilbagevirkende kraft");
    expect(en.termsNoticeChangeCaps).toContain("Every plan, Free included, has usage caps");
    expect(en.termsNoticeChangeCaps).toContain("change, limit or remove features and usage caps with reasonable notice");
    expect(en.termsNoticeChangeCaps).toContain("charge retroactively");
    // The § 4 change, true to the new § 4 on the Terms page (the live 13 May
    // § 4 had BonBox retain records and purge within 30 days).
    expect(da.termsNoticeChangeRecords).toContain("Det er dig, ikke BonBox, der skal opbevare din virksomheds regnskabsmateriale");
    expect(da.termsNoticeChangeRecords).toContain("BonBox er ikke et arkiv");
    expect(da.termsNoticeChangeRecords).toContain("sletter vi kontoen og dataene i den med det samme");
    expect(da.termsNoticeChangeRecords).toContain("hent dine data og de PDF'er, du har brug for");
    expect(en.termsNoticeChangeRecords).toContain("You, not BonBox, must keep your business's accounting records");
    expect(en.termsNoticeChangeRecords).toContain("BonBox is not an archive");
    expect(en.termsNoticeChangeRecords).toContain("we delete the account and the data in it straight away");
    expect(en.termsNoticeChangeRecords).toContain("download your data and the PDFs you need");
    const termsPage = read("pages/TermsPage.jsx");
    expect(termsPage).toContain("der skal opbevare din virksomheds regnskabsmateriale");
    expect(termsPage).toContain("er ikke et arkiv");
    expect(termsPage).toContain("sletter vi kontoen og dataene i den med det samme");
    expect(termsPage).toContain("must keep your business&rsquo;s accounting records");
    expect(termsPage).toContain("is not an archive");
    expect(termsPage).toContain("we delete the account and the data in it straight away");
    expect(termsPage).not.toContain("inden for 30 dage");
  });
});

// ─────────────────────────── (b) Free, (d) VAT sweeps ───────────────────────────

const PACKS = fs.readdirSync(path.join(SRC, "i18n")).filter((f) => f.endsWith(".js"));
const valueOf = (src, key) => {
  const k = key.includes(".") ? `"${key}"` : key;
  const m = src.match(new RegExp(`^\\s+${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}: "((?:[^"\\\\]|\\\\.)*)",?$`, "m"));
  return m ? m[1] : null;
};

describe("VAT status is not confirmed: no price copy says moms is or is not added (decision d)", () => {
  const PRICE_KEYS = ["faqA6", "landingV2.pricing.footnote", "landingCalcOurs", "landingPricingLede",
    "landingPricingHonesty", "landingPricingFinePrint", "landingFaq6A"];
  const VAT_CLAIM = /moms oven|no moms|no vat|moms hariç|ex\.? moms|ekskl\.? moms|excl\.? (moms|vat)|inkl\.? moms|incl\.? (moms|vat)|momsregistr|vat-registered|reverse.charge|omvendt betalingspligt|25 ?%|%25|chưa MOMS|ยังไม่รวม|थपिँदैन|VAT-दर्ता/i;

  it.each(PACKS)("%s", (f) => {
    const src = read(`i18n/${f}`);
    for (const key of PRICE_KEYS) {
      const v = valueOf(src, key);
      if (v !== null) expect([key, v]).toEqual([key, expect.not.stringMatching(VAT_CLAIM)]);
    }
  });

  it("the price surfaces' sources and inline fallbacks", () => {
    for (const f of ["pages/TermsPage.jsx", "components/landing/v2/PricingV2.jsx", "components/landing/WhatDoYouPayNow.jsx",
      "pages/LandingPage.jsx", "pages/SubscriptionPage.jsx", "components/TrialBanner.jsx"]) {
      const offenders = read(f).split("\n").filter((l) => /moms oven|no moms is added|no vat \(moms\)|ex\.? moms|not vat-registered|ikke momsregistr/i.test(l));
      expect([f, offenders]).toEqual([f, []]);
    }
  });

  it("the neutral sentences that replaced them (da + en)", () => {
    expect(da.faqA6).toContain("det præcise beløb ser du ved betalingen, før du bekræfter købet");
    expect(en.faqA6).toContain("you see the exact amount at checkout before you confirm the purchase");
    expect(da["landingV2.pricing.footnote"]).toContain("du ser det præcise beløb ved betalingen");
    expect(en["landingV2.pricing.footnote"]).toContain("you see the exact amount at checkout");
    for (const f of ["np.js", "th.js", "vi.js"]) {
      expect(read(`i18n/${f}`)).not.toMatch(/^\s+faqA6:/m); // falls back to English
    }
  });
});

describe("Free is not promised 'for altid' / 'forever' anywhere user-facing (decision b)", () => {
  const FREE = /\bfree\b|\bgratis\b|ücretsiz/i;
  const FOREVER = /for altid|forever|sonsuza|सधैं/i;

  it.each(PACKS)("%s: no line pairs Free with forever", (f) => {
    const offenders = read(`i18n/${f}`).split("\n").filter((l) => FREE.test(l) && FOREVER.test(l));
    expect(offenders).toEqual([]);
  });

  it("the Free-plan keys themselves (da / en / tr / np)", () => {
    for (const f of ["da.js", "en.js", "tr.js", "np.js"]) {
      const src = read(`i18n/${f}`);
      for (const key of ["pricingForever", "landingV2.pricing.free.period", "landingPricingForever",
        "landingPricingSub", "landingPricingFreeTagline", "landingFaq6A"]) {
        const v = valueOf(src, key);
        if (v !== null) expect([f, key, v]).toEqual([f, key, expect.not.stringMatching(FOREVER)]);
      }
    }
  });

  it("components, inline fallbacks and the public demo reel", () => {
    for (const f of ["pages/LandingPage.jsx", "pages/SubscriptionPage.jsx", "components/landing/v2/PricingV2.jsx",
      "components/TrialBanner.jsx", "components/TermsUpdateNotice.jsx"]) {
      const offenders = read(f).split("\n").filter((l) => /forever free|free forever|for altid|keep free forever|brief forever|livstid/i.test(l));
      expect([f, offenders]).toEqual([f, []]);
    }
    const reel = fs.readFileSync(path.join(SRC, "..", "public", "demo-reel.html"), "utf8");
    expect(reel).not.toMatch(/free forever|forever free/i);
  });
});
