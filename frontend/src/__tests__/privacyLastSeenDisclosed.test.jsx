/**
 * /privacy names users.last_seen_at (fix round, 11 Oct 2026).
 *
 * The server stamps users.last_seen_at itself: at sign-in, then at most once
 * every 5 minutes on an authenticated request (backend/app/services/
 * last_seen.py). It does this whether or not the owner turned Analytics on
 * or paused it, and the super-admin "Last seen" column reads it. Before this
 * fix /privacy did not mention it. It listed "login/logout" only as a product
 * analytics event the owner can pause, and R-h says browser events are
 * recorded only with Analytics consent. That is a claim on one surface that
 * contradicts the fact on another, for personal data (GDPR Art. 13).
 *
 * Pinned here, in en and da:
 *   • a "privacy-last-seen" bullet under Technical data / Tekniske data,
 *     whose section basis is legitimate interest (Art. 6(1)(f));
 *   • it says the stamp happens also when Analytics is off or paused, that
 *     each value replaces the last, who sees it, how long it is kept, and
 *     that it is in the data export;
 *   • the retention table has a row for it;
 *   • the backend still matches the text: 5-minute interval, the stamp in
 *     get_current_user, and last_seen_at in the GDPR export.
 */
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

let langCode = "da";
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ lang: langCode, setLang: () => {}, LANGUAGES: [], t: (_k, fb) => (typeof fb === "string" ? fb : _k) }),
  LanguageProvider: ({ children }) => children,
  detectInitialLanguage: () => "da",
}));
vi.mock("../components/CookieConsent", () => ({
  CookieSettingsButton: ({ label }) => <button type="button">{label}</button>,
}));
vi.mock("../utils/platform", () => ({
  isNativeApp: () => false,
  canPurchaseInApp: () => true,
  isIPad: () => false,
  platform: { isNative: false, isIOS: false, isAndroid: false, isWeb: true },
}));

const PrivacyPolicyPage = (await import("../pages/PrivacyPolicyPage")).default;

afterEach(() => {
  cleanup();
  langCode = "da";
});

const show = (lang) => {
  langCode = lang;
  render(<MemoryRouter><PrivacyPolicyPage /></MemoryRouter>);
};

const TEXT = {
  en: {
    bullet: "When your account was last used — one timestamp. Our server records it when you sign in and updates it at most once every 5 minutes while you use BonBox, also when Analytics is off or paused. Each new value replaces the old one. It is used for support and to see which accounts are in use; only the founder sees it, in BonBox’s admin view. It is kept until you delete your account and is included in your data export.",
    heading: "Technical data",
    basis: "Legitimate interest (GDPR Article 6(1)(f))",
    row: ["When your account was last used (one timestamp, replaced each time)", "Until you delete your account"],
  },
  da: {
    bullet: "Hvornår din konto sidst blev brugt — ét tidspunkt. Vores server registrerer det, når du logger ind, og opdaterer det højst én gang hvert 5. minut, mens du bruger BonBox, også når Analyse er slået fra eller sat på pause. Hver ny værdi erstatter den gamle. Det bruges til support og til at se, hvilke konti der er i brug; kun stifteren ser det, i BonBox’ administrationsvisning. Det opbevares, indtil du sletter din konto, og er med i din dataeksport.",
    heading: "Tekniske data",
    basis: "Legitim interesse (databeskyttelsesforordningens artikel 6, stk. 1, litra f)",
    row: ["Hvornår din konto sidst blev brugt (ét tidspunkt, der erstattes hver gang)", "Indtil du sletter din konto"],
  },
};

describe.each(["en", "da"])("/privacy discloses the server's last-seen stamp in %s", (lang) => {
  it("says what is recorded, that it does not wait for Analytics, who sees it and for how long", () => {
    show(lang);
    expect(screen.getByTestId("privacy-last-seen").textContent).toBe(TEXT[lang].bullet);
  });

  it("sits under Technical data, whose basis is legitimate interest", () => {
    show(lang);
    const li = screen.getByTestId("privacy-last-seen");
    // The nearest h3 before the bullet is the Technical data heading.
    const headings = [...document.querySelectorAll("h3")];
    const before = headings.filter((h) => h.compareDocumentPosition(li) & Node.DOCUMENT_POSITION_FOLLOWING);
    expect(before.at(-1).textContent).toBe(TEXT[lang].heading);
    // The legal-basis line of that sub-section is the first one after the bullet.
    const bases = [...document.querySelectorAll("p")].filter(
      (p) => (li.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING) && /^(Legal basis|Retsgrundlag):/.test(p.textContent),
    );
    expect(bases[0].textContent).toContain(TEXT[lang].basis);
  });

  it("has its own row in the retention table", () => {
    show(lang);
    const rows = [...document.querySelectorAll("tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
    expect(rows).toContainEqual(TEXT[lang].row);
  });
});

describe("the backend still does what /privacy says", () => {
  const backend = async (...parts) => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const { fileURLToPath } = await import("node:url");
    return fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "backend", "app", ...parts), "utf8");
  };

  it("stamps at most once every 5 minutes", async () => {
    expect(await backend("services", "last_seen.py")).toContain("LAST_SEEN_MIN_INTERVAL = timedelta(minutes=5)");
  });

  it("stamps from get_current_user, with no analytics-consent check in the way", async () => {
    const src = await backend("services", "last_seen.py");
    expect(await backend("services", "auth.py")).toContain("touch_last_seen(");
    expect(src).not.toMatch(/analytics_(paused|consent|enabled)/);
  });

  it("puts last_seen_at in the account holder's data export", async () => {
    expect(await backend("routers", "auth.py")).toMatch(/"last_seen_at",/);
  });
});
