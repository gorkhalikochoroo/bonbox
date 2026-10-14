/**
 * Push 9 — the landing page says only what is true (landing review, 15 Oct
 * 2026). Each block guards one finding, so a later edit that brings the old
 * claim back fails here with the reason beside it.
 *
 *  A1  BonBox is not the archive (Terms § 4): "som du selv gemmer i 5 år".
 *  A2  No struck-through "before" prices; founding price stated as an offer,
 *      every number from components/landing/v2/pricing.js = backend config.
 *  A3  MOMS on our own price is unknown from the code: no ekskl./inkl. claim
 *      until the owner sets PRICE_MOMS_BASIS.
 *  A4  A Kontakt link and the company address in the footer.
 *  A5  Only what exists: the 11/48-hour rules (not "dansk arbejdsret"), hours
 *      + export (not payroll), tills summed on Free, no App Store-only
 *      button on Android, receipt reading said the way the privacy policy
 *      says it.
 *  A6  The demo gift card is the demo venue's, not BonBox's company.
 *  B2/B3/B4, C — price line, "Se priser", one demo dataset with a visible
 *      label, plain Danish.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { render, screen, within, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { LanguageProvider } from "../hooks/useLanguage";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { tr } from "../i18n/tr.js";
import HeroV2 from "../components/landing/v2/HeroV2";
import PricingV2 from "../components/landing/v2/PricingV2";
import FooterV2 from "../components/landing/v2/FooterV2";
import GavekortV2 from "../components/landing/v2/GavekortV2";
import StaffCopyV2 from "../components/landing/v2/StaffCopyV2";
import AiPanelV2 from "../components/landing/v2/AiPanelV2";
import BookingCardV2 from "../components/landing/v2/BookingCardV2";
import PhoneFanV2 from "../components/landing/v2/PhoneFanV2";
import ScheduleGridV2 from "../components/landing/v2/ScheduleGridV2";
import FloorPlan from "../components/landing/FloorPlan";
import LandingV2Page from "../pages/LandingV2Page";
import { FOUNDING_LIMIT, FROM_PRICE, PLAN_PRICES, PRICE_MOMS_BASIS, momsNoteKey } from "../components/landing/v2/pricing";
import {
  DEMO_MARGIN_PCT,
  DEMO_MONTH,
  DEMO_NET,
  DEMO_ROTA,
  DEMO_WEEK,
  DEMO_WEEK_DELTA_PCT,
  formatKr,
  isoWeek,
  nextShiftFor,
  onShiftToday,
  rotaLabourPct,
  rotaTotals,
} from "../components/landing/v2/demoData";
import { isAndroidBrowser } from "../components/landing/v2/platform";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const LANDING_FILES = [
  "pages/LandingV2Page.jsx",
  "components/landing/FloorPlan.jsx",
  ...fs.readdirSync(path.join(SRC, "components/landing/v2")).filter((f) => /\.jsx?$/.test(f)).map((f) => `components/landing/v2/${f}`),
];
const landingEntries = (d) => Object.entries(d).filter(([k]) => /^landing(V2|Plan)/.test(k));

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const ORIGINAL_UA = navigator.userAgent;
function setUA(ua) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
}

function renderIn(lang, ui) {
  localStorage.setItem("lang", lang);
  localStorage.removeItem("bonbox_lang_auto_picked");
  return render(
    <MemoryRouter>
      <LanguageProvider>{ui}</LanguageProvider>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  setUA(ORIGINAL_UA);
  localStorage.removeItem("lang");
});

describe("A1 — BonBox is not the archive", () => {
  it("the hero says the owner keeps the PDFs (da, en, tr)", () => {
    expect(da.landingV2HeroTrustArchive).toBe("Kasserapporter som PDF, som du selv gemmer i 5 år");
    expect(en.landingV2HeroTrustArchive).toBe("Each kasserapport as a PDF, for you to keep for 5 years");
    expect(tr.landingV2HeroTrustArchive).toContain("kendin saklarsın");
  });

  it("no landing string says BonBox archives or files your documents", () => {
    for (const [code, d] of [["da", da], ["en", en], ["tr", tr]]) {
      const bad = landingEntries(d).filter(([, v]) => /arkiver|archiv|klar til at gemme|ready to keep|saklamaya hazır|filed the way|dosyalanır/i.test(String(v)));
      expect(bad, code).toEqual([]);
    }
  });
});

describe("A2 — no struck-through prices; the founding offer said as it is", () => {
  it("the pricing source has no line-through and no typed-in price", () => {
    const src = stripComments(read("components/landing/v2/PricingV2.jsx"));
    expect(src).not.toMatch(/line-through/);
    expect(src).not.toMatch(/>\s*(129|199|249|349)\s*</);
  });

  it("pricing.js mirrors backend config.py PLAN_PRICES_DKK and FOUNDING_MEMBER_LIMIT", () => {
    const cfg = fs.readFileSync(path.join(SRC, "../../backend/app/config.py"), "utf8");
    const m = cfg.match(/PLAN_PRICES_DKK: dict = \{\s*"starter": \{"regular": (\d+), "founding": (\d+)\},\s*"pro": \{"regular": (\d+), "founding": (\d+)\},/);
    expect(m).not.toBeNull();
    expect(PLAN_PRICES).toEqual({
      starter: { regular: Number(m[1]), founding: Number(m[2]) },
      pro: { regular: Number(m[3]), founding: Number(m[4]) },
    });
    expect(cfg).toMatch(new RegExp(`FOUNDING_MEMBER_LIMIT: int = ${FOUNDING_LIMIT}\\b`));
    expect(FROM_PRICE).toBe(PLAN_PRICES.starter.founding);
  });

  it("renders 129 / 249 with 'after the first 100: 199 / 349' — nothing crossed out", () => {
    const { container } = renderIn("da", <PricingV2 />);
    expect(container.querySelector(".line-through")).toBeNull();
    expect(container.querySelector("s, del, strike")).toBeNull();
    expect(screen.getByRole("heading", { level: 2 }).textContent).toBe("129 kr./md., låst for de første 100 virksomheder — derefter 199 kr./md.");
    expect(screen.getByTestId("price-then-starter").textContent).toBe("Efter de første 100: 199 kr./md.");
    expect(screen.getByTestId("price-then-pro").textContent).toBe("Efter de første 100: 349 kr./md.");
  });

  it("the Terms carry the same numbers (one claim, every surface)", () => {
    const terms = read("pages/TermsPage.jsx");
    expect(terms).toContain("Starter 129 kr. og Pro 249 kr. pr. måned (normalpris: Starter 199 kr. og Pro 349 kr.)");
  });
});

describe("A3 — MOMS on our own price is not claimed until it is known", () => {
  it("the basis is unset, so no price says ekskl./inkl. moms", () => {
    expect(PRICE_MOMS_BASIS).toBeNull();
    expect(momsNoteKey()).toBeNull();
    const { container } = renderIn("da", <><HeroV2 /><PricingV2 /></>);
    const text = container.textContent;
    expect(text).not.toMatch(/Priserne er (ekskl|inkl)\. moms/i);
    expect(screen.getByTestId("hero-price-line").textContent).not.toMatch(/moms/i);
  });

  it("both notes are written and ready for the owner's answer (da + en)", () => {
    for (const basis of ["excl", "incl"]) {
      const key = momsNoteKey(basis);
      expect(typeof da[key]).toBe("string");
      expect(typeof en[key]).toBe("string");
      expect(da[key]).toMatch(/moms/i);
    }
  });
});

describe("A4 — the footer reaches a person", () => {
  it("Kontakt goes to /contact and the address is the one /contact gives", () => {
    renderIn("da", <FooterV2 />);
    expect(screen.getByRole("link", { name: "Kontakt" }).getAttribute("href")).toBe("/contact");
    const contactEmail = read("pages/ContactPage.jsx").match(/const SUPPORT_EMAIL = "([^"]+)"/)[1];
    const mail = screen.getByTestId("footer-email");
    expect(mail.getAttribute("href")).toBe(`mailto:${contactEmail}`);
    expect(mail.textContent).toBe(contactEmail);
  });
});

describe("A5 — only what the product does", () => {
  it("the autopilot names the 11-hour and 48-hour rules, never 'labour law'", () => {
    for (const [code, d] of [["da", da], ["en", en], ["tr", tr]]) {
      const bad = landingEntries(d).filter(([, v]) => /arbejdsret|labour law|labor law|iş hukuk/i.test(String(v)));
      expect(bad, code).toEqual([]);
    }
    expect(da["landingV2.schedule.autopilotNote"]).toMatch(/11-timers- og 48-timersreglen/);
    expect(en["landingV2.schedule.autopilotNote"]).toMatch(/11-hour and 48-hour rules/);
    // and the autopilot really checks both
    const ap = fs.readFileSync(path.join(SRC, "../../backend/app/services/schedule_autopilot.py"), "utf8");
    expect(ap).toMatch(/DK_MAX_HOURS_PER_WEEK = 48\.0/);
    expect(ap).toMatch(/DK_MIN_DAILY_REST_HOURS = 11\.0/);
  });

  it("hours are tracked and exported — no payroll, payslip, feriepenge or 'before tax'", () => {
    for (const [code, d] of [["da", da], ["en", en], ["tr", tr]]) {
      const bad = landingEntries(d).filter(([, v]) => /lønseddel|payslip|feriepenge|før skat|before tax|Timer & løn|maaş tahmini|vergiden önce/i.test(String(v)));
      expect(bad, code).toEqual([]);
    }
    expect(da["landingV2.modules.hours.title"]).toBe("Timer");
    expect(en["landingV2.modules.hours.title"]).toBe("Hours");
  });

  it("summing two tills is on the Free card; Pro is the multi-location report", () => {
    expect(da["landingV2.pricing.free.f8"]).toMatch(/Z-bonerne lægges sammen/);
    expect(en["landingV2.pricing.pro.f2"]).not.toMatch(/terminal/i);
    expect(da["landingV2.pricing.pro.f2"]).not.toMatch(/terminal/i);
    renderIn("da", <PricingV2 />);
    expect(screen.getByText(da["landingV2.pricing.free.f8"]).closest("#plan-free-features")).not.toBeNull();
  });

  it("Android: no App Store button — the web app instead (owner and staff)", () => {
    setUA(ANDROID);
    expect(isAndroidBrowser()).toBe(true);
    const { container } = renderIn("da", <><HeroV2 /><StaffCopyV2 /></>);
    expect(container.querySelector('[data-platform-link="app-store"]')).toBeNull();
    expect(container.querySelector('a[href*="apps.apple.com"]')).toBeNull();
    expect(screen.getByRole("link", { name: "BonBox i browseren" }).getAttribute("href")).toBe("/register");
    expect(screen.getByRole("link", { name: "Vagtplan i browseren" }).getAttribute("href")).toBe("/join");
  });

  it("iPhone (and desktop): the App Store links stay", () => {
    setUA(IPHONE);
    const { container } = renderIn("da", <><HeroV2 /><StaffCopyV2 /></>);
    expect(container.querySelectorAll('[data-platform-link="app-store"]')).toHaveLength(2);
    expect(container.querySelector('[data-platform-link="web"]')).toBeNull();
  });

  it("no 'one app' promise a phone without an App Store cannot keep", () => {
    for (const k of ["landingV2HeroLead", "landingV2.staff.title", "landingV2.staff.body"]) {
      expect(da[k], k).not.toMatch(/én app|egen app|i appen/);
      expect(en[k], k).not.toMatch(/one app|own app|in the app/);
    }
  });

  it("receipt reading is said the way the privacy policy says it (provider named, place not confirmed)", () => {
    for (const d of [da, en]) {
      expect(d.landingV2HeroTrustHosting).not.toMatch(/USA|\bUS\b/);
      expect(d["landingV2.access.bonbox.detail"]).not.toMatch(/USA|in the US\b/);
      expect(d["landingV2.access.bonbox.detail"]).toMatch(/Anthropic/);
    }
    expect(da["landingV2.access.bonbox.detail"]).toMatch(/ikke bekræftet/);
    expect(en["landingV2.access.bonbox.detail"]).toMatch(/not yet confirmed/);
    const privacy = read("pages/PrivacyPolicyPage.jsx");
    expect(privacy).toMatch(/\["Anthropic \(Claude API\)", "Aflæsning af kvitteringer[^"]*", "Ikke bekræftet"/);
    expect(privacy).toMatch(/\["Anthropic \(Claude API\)", "Reading receipts[^"]*", "Not confirmed"/);
  });
});

describe("A6 — the demo gift card is the demo venue's", () => {
  it("no BonBox company name or CVR on it", () => {
    const { container } = renderIn("da", <GavekortV2 />);
    expect(container.textContent).not.toMatch(/46417321|DukaanAI|Manoz/);
    expect(container.textContent).toContain("Bistro Nørrebro");
    // The MOMS row is with the owner's revisor — unchanged on purpose.
    expect(da["landingV2.gavekort.spec.moms.value"]).toBe("Afregnes ved indløsning (MPV)");
  });
});

describe("B2/B3 — the price under the button; the second button goes to pricing", () => {
  it("one plain price line under the CTAs, from pricing.js", () => {
    renderIn("da", <HeroV2 />);
    expect(screen.getByTestId("hero-price-line").textContent).toBe(
      `14 dage gratis · intet kort · derefter gratis-planen eller fra ${FROM_PRICE} kr./md. (de første ${FOUNDING_LIMIT} virksomheder)`,
    );
    const second = screen.getByRole("link", { name: "Se priser" });
    expect(second.getAttribute("href")).toBe("#pricing");
    expect(screen.queryByText("Se bordplanen")).toBeNull();
  });

  it("the reservations band says what it is", () => {
    renderIn("da", <LandingV2Page />);
    const band = document.getElementById("reservations");
    expect(within(band).getByRole("heading", { level: 2 }).textContent).toBe(da["landingV2.reservations.title"]);
  });
});

describe("B4 — one demo business, labelled as a demo", () => {
  it("the month adds up and the margin counts wages and MOMS", () => {
    const m = DEMO_MONTH;
    expect(m.moms + m.goods + m.wages + m.running + m.profit).toBe(m.revenue);
    expect(m.moms).toBe(Math.round(m.revenue * 0.2));
    expect(DEMO_MARGIN_PCT).toBe(Math.round((m.profit / DEMO_NET) * 100));
    expect(DEMO_MARGIN_PCT).toBeGreaterThanOrEqual(5);
    expect(DEMO_MARGIN_PCT).toBeLessThanOrEqual(20);
    expect(DEMO_WEEK_DELTA_PCT).toBe(Math.round((DEMO_WEEK.last / DEMO_WEEK.before - 1) * 100));
  });

  it("the rota totals are derived: 8 shifts, 52,75 t, ≈ 9.123 kr., 18 %", () => {
    expect(rotaTotals()).toEqual({ hours: 52.75, wage: 9123, shifts: 8 });
    expect(rotaLabourPct()).toBe(18);
    expect(DEMO_ROTA).toHaveLength(4);
  });

  it("the hero and the AI panel quote the same last week", () => {
    const { container } = renderIn("da", <><HeroV2 /><AiPanelV2 /></>);
    const week = formatKr(DEMO_WEEK.last);
    const hits = container.textContent.split(week).length - 1;
    expect(hits).toBeGreaterThanOrEqual(3); // hero metric, AI answer, AI card
    expect(container.textContent).toContain(`${DEMO_WEEK_DELTA_PCT} % over ugen før`);
    expect(container.textContent).not.toMatch(/82 %|\+12 %|\+94 %|182\.304|223\.022/);
  });

  it("every demo picture carries a visible demo label", () => {
    for (const [name, El] of [["hero", HeroV2], ["booking", BookingCardV2], ["floor", FloorPlan], ["phones", PhoneFanV2], ["schedule", ScheduleGridV2], ["ai", AiPanelV2], ["gavekort", GavekortV2]]) {
      const { container, unmount } = renderIn("da", <El />);
      const tags = [...container.querySelectorAll("[data-demo-tag]")];
      expect(tags.length, name).toBeGreaterThan(0);
      for (const tag of tags) {
        expect(tag.textContent, name).toBe("Eksempel · demodata");
        expect(tag.className, name).not.toMatch(/\bsr-only\b/);
      }
      unmount();
    }
  });

  it("dates come from today, not July", () => {
    const now = new Date();
    const { container } = renderIn("da", <><ScheduleGridV2 /><PhoneFanV2 /><HeroV2 /></>);
    expect(container.textContent).toContain(`Uge ${isoWeek(now)}`);
    expect(container.textContent).not.toMatch(/27\/7|31\. jul|Uge 31 · 27/);
    const shift = onShiftToday(now);
    expect(container.textContent).toContain(shift.person.name);
    expect(nextShiftFor()).not.toBeNull();
  });
});

describe("C — plain Danish on the Danish page", () => {
  it("the headline names caféer, restauranter, barer og saloner", () => {
    renderIn("da", <HeroV2 />);
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toContain("Til caféer, restauranter, barer og saloner.");
  });

  it("no stray English or jargon in the rendered Danish landing", () => {
    const { container } = renderIn("da", <LandingV2Page />);
    const text = container.textContent;
    expect(text).not.toMatch(/\b(MON|TUE|WED|THU|FRI|SAT|SUN)\b/);
    expect(text).not.toMatch(/\b(Kitchen|Floor|DRAFT|Free)\b/);
    expect(text).not.toMatch(/\bOCR\b/);
    expect(text).not.toMatch(/bank-CSV/i);
    expect(da["landingV2.pricing.free.name"]).toBe("Gratis");
  });

  it("every inline fallback on the landing equals the English dictionary", () => {
    const re = /\bt\(\s*"([^"]+)"\s*,\s*"((?:[^"\\]|\\.)*)"/g;
    const drift = [];
    for (const f of LANDING_FILES) {
      for (const m of read(f).matchAll(re)) {
        const fb = JSON.parse(`"${m[2]}"`);
        if (!(m[1] in en)) drift.push(`${f}: ${m[1]} missing in en`);
        else if (en[m[1]] !== fb) drift.push(`${f}: ${m[1]}`);
        if (!(m[1] in da)) drift.push(`${f}: ${m[1]} missing in da`);
      }
    }
    expect(drift).toEqual([]);
  });
});
