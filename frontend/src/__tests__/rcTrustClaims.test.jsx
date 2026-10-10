/**
 * Release R-c — owner-facing claims on the three front doors (landing, login,
 * register) are true (RELEASE_GATE rule 5: no unmeasured numbers; legal text
 * needs Manoj's OK — the sentences below are the ones put to him).
 *
 *   (e) /register: Servicevilkår (/terms) and Privatlivspolitik (/privacy)
 *       one tap away (a new tab on the web: the form stays as typed) —
 *       "Læs vores …", informational (R-c review: an "accepterer du" line
 *       made owners accept Terms whose §8 price and §4 retention text do not
 *       match the code — that wording waits for Manoj + the DK attorney).
 *       Rendered once, where every sign-up path passes it: beside the
 *       Google / Apple row when there is one, else under "Opret konto".
 *   (f) landing: "Daglig lukning på 30 sekunder" (never measured) → "Daglig
 *       lukning: tag et billede af Z-bonen, BonBox fylder tallene ud" (a Z-bon
 *       scan is on every plan — Free: 3 a day); "Arkiv bygget til
 *       Bogføringsloven" → "Kasserapporter som PDF, klar til at gemme i 5 år"
 *       (GET /daily-close/{id}/pdf, every plan — BonBox itself keeps no
 *       5-year archive promise: an erased account's closes are deleted).
 *   (g) login: "… — tager 30 sekunder" and "det tager normalt 20-30
 *       sekunder" (never measured) → no number; the iOS hint names the link
 *       as it reads ("Glemt?" — forgotShort), not "Glemt adgangskode".
 *   Turkish is OFFERED (languageCatalog): its pack carries the new true
 *   sentences, never English fallbacks for removed ones.
 * Plus a guard: no "N sekunder / N seconds" on those three pages, in any
 * language pack or inline fallback.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";
import { tr } from "../i18n/tr";
import { ALL_LANGUAGES } from "../i18n/languageCatalog";

const h = vi.hoisted(() => ({ lang: "da" }));

vi.mock("../services/api", () => ({ default: { post: vi.fn(), get: vi.fn(() => Promise.resolve({ data: {} })) } }));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: null, register: vi.fn(), login: vi.fn(), loading: false }),
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const { en: EN } = await import("../i18n/en");
  return {
    useLanguage: () => {
      const dict = h.lang === "da" ? DA : EN;
      return {
        lang: h.lang,
        t: (k, fb, vars) => {
          let s = dict[k] ?? (typeof fb === "string" ? fb : k);
          const v = typeof fb === "object" && fb ? fb : vars;
          if (v) Object.entries(v).forEach(([a, b]) => { s = s.replace(`{${a}}`, String(b)); });
          return s;
        },
        setLang: () => {},
        LANGUAGES: [{ code: "da", label: "Dansk" }, { code: "en", label: "English" }],
      };
    },
  };
});
vi.mock("@react-oauth/google", () => ({ GoogleLogin: () => null, GoogleOAuthProvider: ({ children }) => children }));
vi.mock("../components/AppleSignInButton", () => ({ default: () => null }));

const RegisterPage = (await import("../pages/RegisterPage")).default;

beforeEach(() => { h.lang = "da"; vi.unstubAllEnvs(); });

describe("(e) /register — the service terms and privacy policy, one tap away", () => {
  it("Danish: the sentence, with both documents linked (new tab), under the button (no Google / Apple row)", () => {
    render(<MemoryRouter><RegisterPage /></MemoryRouter>);
    const line = screen.getByTestId("register-legal-line");
    expect(line.textContent).toBe("Læs vores Servicevilkår og Privatlivspolitik.");
    const terms = within(line).getByRole("link", { name: "Servicevilkår" });
    const privacy = within(line).getByRole("link", { name: "Privatlivspolitik" });
    expect(terms.getAttribute("href")).toBe("/terms");
    expect(privacy.getAttribute("href")).toBe("/privacy");
    for (const a of [terms, privacy]) {
      expect(a.getAttribute("target")).toBe("_blank");
      expect(a.getAttribute("rel")).toContain("noopener");
    }
    // Directly under the create-account button, inside the form.
    const button = screen.getByRole("button", { name: da.createAccount });
    expect(button.nextElementSibling).toBe(line);
    expect(line.closest("form")).not.toBeNull();
  });

  it("English: the same sentence in English", () => {
    h.lang = "en";
    render(<MemoryRouter><RegisterPage /></MemoryRouter>);
    const line = screen.getByTestId("register-legal-line");
    expect(line.textContent).toBe("Read our Terms of Service and Privacy Policy.");
    expect(within(line).getByRole("link", { name: "Terms of Service" }).getAttribute("href")).toBe("/terms");
    expect(within(line).getByRole("link", { name: "Privacy Policy" }).getAttribute("href")).toBe("/privacy");
  });

  it("tapping a link never submits the form", () => {
    render(<MemoryRouter><RegisterPage /></MemoryRouter>);
    const line = screen.getByTestId("register-legal-line");
    const submit = vi.fn((e) => e.preventDefault());
    line.closest("form").addEventListener("submit", submit);
    fireEvent.click(within(line).getByRole("link", { name: "Servicevilkår" }));
    expect(submit).not.toHaveBeenCalled();
  });

  it("with the Google / Apple row: once, beside those buttons, above both paths — never only under the e-mail form", () => {
    vi.stubEnv("VITE_GOOGLE_CLIENT_ID", "test-client");
    render(<MemoryRouter><RegisterPage /></MemoryRouter>);
    const lines = screen.getAllByTestId("register-legal-line");
    expect(lines).toHaveLength(1);
    const [line] = lines;
    expect(line.textContent).toBe("Læs vores Servicevilkår og Privatlivspolitik.");
    expect(line.closest("form")).toBeNull();
    // In the OAuth row, right before its "eller brug e-mail" divider, and
    // before the form in the page.
    const divider = line.nextElementSibling;
    expect(divider?.textContent).toContain(da.orUseEmail || "or use email");
    const form = document.querySelector("form");
    expect(line.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("says no acceptance (no pack): informational until Manoj + the DK attorney approve accept-wording and the Terms", () => {
    const ACCEPT = /accept|accepter|kabul|agree|godkend/i;
    for (const [code, dict] of [["da", da], ["en", en], ["tr", tr]]) {
      expect(typeof dict.registerLegalRead, code).toBe("string");
      expect(ACCEPT.test(dict.registerLegalRead), `${code}: ${dict.registerLegalRead}`).toBe(false);
      expect(dict.registerLegalRead).toContain("{terms}");
      expect(dict.registerLegalRead).toContain("{privacy}");
    }
    expect(da.registerLegalAccept).toBeUndefined();
    expect(en.registerLegalAccept).toBeUndefined();
  });
});

describe("(f) landing and (g) login — the new sentences", () => {
  it("say exactly what was put to Manoj (da + en)", () => {
    expect(da["landingV2.pricing.free.f1"]).toBe("Daglig lukning: tag et billede af Z-bonen, BonBox fylder tallene ud");
    expect(en["landingV2.pricing.free.f1"]).toBe("Daily close: take a photo of the Z-report and BonBox fills in the figures");
    expect(da.landingV2HeroTrustArchive).toBe("Kasserapporter som PDF, klar til at gemme i 5 år");
    expect(en.landingV2HeroTrustArchive).toBe("Each kasserapport as a PDF, ready to keep for 5 years");
    expect(da.loginGoogleHintNative).toBe("Tilmeldt med Google på web? Tryk på “Glemt?” ved adgangskoden ovenfor for at sætte en app-adgangskode.");
    expect(en.loginGoogleHintNative).toBe("Signed up with Google on the web? Tap “Forgot?” next to the password above to set an app password.");
    // (R-c round 2: only what the client knows — no answer, and it retries.)
    expect(da.loginWarmingUp).toBe("Kan ikke nå BonBox lige nu — prøver igen.");
    expect(en.loginWarmingUp).toBe("Can't reach BonBox right now — retrying.");
    expect(da.registerLegalRead).toBe("Læs vores {terms} og {privacy}.");
    expect(en.registerLegalRead).toBe("Read our {terms} and {privacy}.");
    expect(da.registerLegalTerms).toBe("Servicevilkår");
    expect(en.registerLegalTerms).toBe("Terms of Service");
  });

  it("the iOS hint names the link above the password as it reads (forgotShort) — da, en, tr, and the inline fallback", () => {
    for (const [code, dict] of [["da", da], ["en", en], ["tr", tr]]) {
      expect(dict.loginGoogleHintNative, code).toContain(`“${dict.forgotShort}”`);
    }
    expect(da.loginGoogleHintNative).not.toMatch(/Glemt adgangskode/);
    expect(en.loginGoogleHintNative).not.toMatch(/Forgot password/);
    const login = fs.readFileSync(path.join(SRC, "pages/LoginPage.jsx"), "utf8");
    expect(login).toContain("“Forgot?” next to the password above");
    expect(login).not.toMatch(/Tap “Forgot password” above/);
  });

  it("Turkish is offered — its pack carries the new sentences (never an English line in a Turkish hero, Free card, login or register)", () => {
    expect(ALL_LANGUAGES.find((l) => l.code === "tr")?.offered).toBe(true);
    expect(tr.landingV2HeroTrustArchive).toBe("Her kasserapport PDF olarak, 5 yıl saklamaya hazır");
    expect(tr["landingV2.pricing.free.f1"]).toBe("Günlük kapanış: Z-raporunun fotoğrafını çek, BonBox rakamları doldurur");
    expect(tr.loginWarmingUp).toBe("BonBox'a şu anda ulaşılamıyor — yeniden deneniyor.");
    expect(tr.loginGoogleHintNative).toBe("Web'de Google ile mi kaydoldun? Uygulama şifresi belirlemek için yukarıda şifrenin yanındaki “Unuttun mu?”ya dokun.");
    expect(tr.registerLegalRead).toBe("{terms} ve {privacy} belgelerimizi okuyabilirsin.");
    expect(tr.registerLegalTerms).toBe("Hizmet Şartları");
    expect(tr.registerLegalPrivacy).toBe("Gizlilik Politikası");
    expect(tr.registerSubheading).toBe("Bugün başla.");
    // Every key the R-c trust change touched is in every OFFERED pack.
    for (const l of ALL_LANGUAGES.filter((x) => x.offered)) {
      const dict = { da, en, tr }[l.code];
      expect(dict, l.code).toBeTruthy();
      for (const k of ["landingV2HeroTrustArchive", "landingV2.pricing.free.f1", "loginWarmingUp", "loginGoogleHintNative",
        "registerLegalRead", "registerLegalTerms", "registerLegalPrivacy", "registerSubheading"]) {
        expect(typeof dict[k], `${l.code} ${k}`).toBe("string");
      }
    }
  });
});

// ── The guard: no unmeasured "N seconds" on the three front doors ─────────
const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONT_DOORS = [
  "pages/LandingV2Page.jsx",
  ...fs.readdirSync(path.join(SRC, "components/landing/v2")).filter((f) => f.endsWith(".jsx")).map((f) => `components/landing/v2/${f}`),
  "components/landing/FloorPlan.jsx",
  "pages/LoginPage.jsx",
  "pages/RegisterPage.jsx",
];
// (Every pack: "30 seconds" in Danish, English, Turkish, Nepali, Thai,
// Vietnamese, German, Spanish, French, Italian, Dutch, Portuguese, Swedish,
// Norwegian, Japanese.)
const SECONDS = /(?:\d+|[०-९]+)(?:\s*[-–]\s*\d+)?\s*-?\s*(?:sek\.?|sekunder|sekund|seconds?|second|saniye|सेकेन्ड|วินาที|giây|sekunden|segundos|secondes|secondi|seconden|秒)/i;
const BOOKKEEPING_CLAIM = /arkiv bygget til bogføringsloven|archive built for bogføringsloven|bogføringsloven için yapılmış arşiv/i;

describe("guard — no unmeasured seconds on landing, login and register", () => {
  const keys = new Set();
  const sources = {};
  for (const f of FRONT_DOORS) {
    const s = fs.readFileSync(path.join(SRC, f), "utf8");
    sources[f] = s;
    for (const m of s.matchAll(/["'`]([A-Za-z][A-Za-z0-9_.]+)["'`]/g)) keys.add(m[1]);
  }

  it("not in a key those pages use, in any language pack", async () => {
    const packs = fs.readdirSync(path.join(SRC, "i18n")).filter((f) => /^[a-z]{2}\.js$/.test(f));
    const hits = [];
    for (const p of packs) {
      const mod = await import(/* @vite-ignore */ path.join(SRC, "i18n", p));
      const dict = mod[p.slice(0, 2)] || mod.default || {};
      for (const k of keys) {
        const v = dict[k];
        if (typeof v === "string" && (SECONDS.test(v) || BOOKKEEPING_CLAIM.test(v))) hits.push(`${p} ${k}: ${v}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("not in an inline fallback on those pages", () => {
    const hits = [];
    for (const [f, s] of Object.entries(sources)) {
      for (const m of s.matchAll(/["'`]([^"'`\n]{6,300})["'`]/g)) {
        if (SECONDS.test(m[1]) || BOOKKEEPING_CLAIM.test(m[1])) hits.push(`${f}: ${m[1]}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("the guard itself catches the old sentences", () => {
    for (const old of ["Daglig lukning på 30 sekunder", "30-second daily close", "— tager 30 sekunder.",
      "this usually takes 20-30 seconds the first time.", "det tager normalt 20-30 sekunder første gang.",
      "30 saniyede günlük kapanış", "— ३० सेकेन्ड लाग्छ।"]) {
      expect(SECONDS.test(old)).toBe(true);
    }
    expect(BOOKKEEPING_CLAIM.test("Arkiv bygget til Bogføringsloven")).toBe(true);
    expect(BOOKKEEPING_CLAIM.test("Bogføringsloven için yapılmış arşiv")).toBe(true);
    // A true expiry is not a duration claim of this kind.
    expect(SECONDS.test("Det udløber om 15 minutter.")).toBe(false);
  });
});
