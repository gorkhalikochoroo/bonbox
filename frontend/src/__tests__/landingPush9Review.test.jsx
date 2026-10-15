/**
 * Push 9 — the review round (15 Oct 2026). Each block guards one finding the
 * reviewers raised on the p9-landing branch, so a later edit that brings the
 * old state back fails here with the reason beside it.
 *
 *  M2  No struck-through "before" price anywhere checkout starts: the plan
 *      page (/subscription) and every UpgradeNudge say "Efter de første 100:
 *      199 kr./md." from the one price module (lib/planPrices) the landing
 *      uses too.
 *  M3  The search snippet, social previews and JSON-LD in index.html say
 *      what the landing says — no payroll wording, no "one app", the same
 *      audience as the headline.
 *  m   The in-app plan page puts the till merge on Free, like the landing;
 *      the demo MOMS card works its weekly amount out the way the product
 *      does; the demo rota and month are one realistic business; the demo
 *      Book button answers; /join has a way out for an owner; the landing's
 *      phone cut-down stops at 640 px; the cookie banner's "Læs mere" has a
 *      44 px hit area; Danish copy names the product's own modules.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

let nativeFlag = false;
vi.mock("../utils/platform", async (orig) => ({
  ...(await orig()),
  isNativeApp: () => nativeFlag,
}));
// EntitlementsProvider-free UpgradeNudge: no `feature` prop, so only the hook
// shape is needed.
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ isReady: true, hasFeature: () => false }),
}));

const { LanguageProvider } = await import("../hooks/useLanguage");
const { da } = await import("../i18n/da.js");
const { en } = await import("../i18n/en.js");
const { tr } = await import("../i18n/tr.js");
const { FOUNDING_LIMIT, FROM_PRICE, PLAN_PRICES } = await import("../lib/planPrices");
const landingPricing = await import("../components/landing/v2/pricing");
const UpgradeNudge = (await import("../components/ui/UpgradeNudge")).default;
const HeroV2 = (await import("../components/landing/v2/HeroV2")).default;
const BookingCardV2 = (await import("../components/landing/v2/BookingCardV2")).default;
const ScheduleGridV2 = (await import("../components/landing/v2/ScheduleGridV2")).default;
const JoinPage = (await import("../pages/JoinPage")).default;
const demo = await import("../components/landing/v2/demoData");
const { nextMomsDeadline } = await import("../utils/nextMomsDeadline");

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const stripComments = (s) =>
  s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1");

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
  vi.useRealTimers();
  nativeFlag = false;
  localStorage.removeItem("lang");
});

describe("M2 — one price module, no strikethrough where checkout starts", () => {
  it("the landing, the plan page and UpgradeNudge read the same numbers", () => {
    expect(landingPricing.PLAN_PRICES).toBe(PLAN_PRICES);
    expect(landingPricing.FOUNDING_LIMIT).toBe(FOUNDING_LIMIT);
    expect(landingPricing.FROM_PRICE).toBe(FROM_PRICE);
    for (const f of ["pages/SubscriptionPage.jsx", "components/ui/UpgradeNudge.jsx"]) {
      const src = stripComments(read(f));
      expect(src, f).toMatch(/from "\.\.\/(\.\.\/)?lib\/planPrices"/);
      expect(src, f).not.toMatch(/line-through/);
    }
    // no typed-in price on the plan cards or in the nudge: every 129 / 199 /
    // 249 / 349 there comes from planPrices
    const sub = stripComments(read("pages/SubscriptionPage.jsx"));
    expect(sub).toContain("price_monthly: PLAN_PRICES.starter.regular");
    expect(sub).toContain("founding_price: PLAN_PRICES.pro.founding");
    expect(sub).not.toMatch(/(price_monthly|founding_price):\s*[1-9]/); // Free's 0 is not a price
    expect(stripComments(read("components/ui/UpgradeNudge.jsx"))).not.toMatch(/\b(129|199|249|349)\b/);
  });

  it.each(["card", "dialog"])("UpgradeNudge %s (da): founding price, then 'Efter de første 100' — nothing crossed out, no English", (intent) => {
    const { container } = renderIn("da", <UpgradeNudge intent={intent} tier="starter" benefit="Send kasserapporten automatisk" />);
    const price = screen.getByTestId("upgrade-price");
    expect(price.textContent).toContain("129 kr./md.");
    expect(price.textContent).toContain("Efter de første 100: 199 kr./md.");
    expect(container.querySelector(".line-through, s, del, strike")).toBeNull();
    expect(document.body.textContent).toContain("Stifterpris · første 100");
    expect(document.body.textContent).not.toMatch(/Founding rate|Maybe later/);
  });

  it("UpgradeNudge Pro (en): 249, then 349 after the first 100", () => {
    renderIn("en", <UpgradeNudge intent="card" tier="pro" benefit="x" />);
    const price = screen.getByTestId("upgrade-price");
    expect(price.textContent).toContain("249 kr./mo");
    expect(price.textContent).toContain("After the first 100: 349 kr./mo");
  });

  it("the plan page's after-line is the landing's sentence (one claim, every surface)", () => {
    expect(da.pricingAfterFounding).toBe(da["landingV2.pricing.thenPrice"]);
    expect(en.pricingAfterFounding).toBe(en["landingV2.pricing.thenPrice"]);
  });
});

describe("M3 — index.html says what the landing says", () => {
  const html = fs.readFileSync(path.join(SRC, "../index.html"), "utf8");
  const noComments = html.replace(/<!--[\s\S]*?-->/g, "");
  const meta = (attr, name) => {
    const m = noComments.match(new RegExp(`<meta ${attr}="${name}" content="([^"]*)"`));
    return m && m[1];
  };

  it("description, og:description and twitter:description are one text, with the headline's audience", () => {
    const d = meta("name", "description");
    expect(d).toBeTruthy();
    expect(meta("property", "og:description")).toBe(d);
    expect(meta("name", "twitter:description")).toBe(d);
    expect(d).toContain("caféer, restauranter, barer og saloner");
    expect(da.landingV2HeroAudience).toContain("caféer, restauranter, barer og saloner");
  });

  it("no payroll wording, no 'one app', no bookkeeping claim — in meta, keywords or JSON-LD", () => {
    const ld = JSON.parse(noComments.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/)[1]);
    const texts = [
      meta("name", "description"),
      meta("property", "og:description"),
      meta("name", "twitter:description"),
      meta("name", "keywords"),
      ld.description,
    ];
    for (const s of texts) {
      expect(s).not.toMatch(/løn|lønseddel|payroll|én app|one app|bogføring Danmark|bistroer|butikker/i);
    }
    expect(ld.operatingSystem).not.toMatch(/Android/);
  });
});

describe("in-app plan page — the till merge is Free there too", () => {
  it("Free lists the till merge; Pro's multi-terminal line is the landing's Pro wording", () => {
    const src = read("pages/SubscriptionPage.jsx");
    const free = src.slice(src.indexOf('id: "free"'), src.indexOf('id: "starter"'));
    expect(free).toContain('t("featFreeTillsSummed"');
    expect(da.featFreeTillsSummed).toBe(da["landingV2.pricing.free.f8"]);
    expect(en.featFreeTillsSummed).toBe(en["landingV2.pricing.free.f8"]);
    expect(da.featProMultiTerm).toBe(da["landingV2.pricing.pro.f2"]);
    expect(en.featProMultiTerm).toBe(en["landingV2.pricing.pro.f2"]);
    expect(da.featProMultiTerm).not.toMatch(/saml Z-rapporter/);
  });
});

describe("demo MOMS card — worked out like the product's card", () => {
  it("weekly = whole weeks left, rounded up to 100 kr.; none inside the last week", () => {
    const total = demo.DEMO_MOMS.halfYear;
    // ComplianceCountdownCard: ceil(expected / max(1, round(days / 7)) / 100) * 100
    for (const days of [7, 30, 137, 180]) {
      expect(demo.demoMomsWeekly(days)).toBe(Math.ceil(total / Math.max(1, Math.round(days / 7)) / 100) * 100);
    }
    expect(demo.demoMomsWeekly(6)).toBeNull();
    expect(demo.demoMomsWeekly(0)).toBeNull();
  });

  it("15 Oct 2026: '~9.300 kr./uge' beside '~185.700 kr. forfalder 1. marts 2027'", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 9, 15, 12));
    expect(nextMomsDeadline().daysUntil).toBe(137);
    renderIn("da", <HeroV2 />);
    expect(screen.getByTestId("hero-moms-weekly").textContent).toBe("Sæt ~9.300 kr./uge til side for at dække MOMS");
    expect(document.body.textContent).toContain("~185.700 kr. forfalder 1. marts 2027");
  });

  it("24 Feb 2027 (5 days left): no weekly rate — the amount is due", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2027, 1, 24, 12));
    renderIn("da", <HeroV2 />);
    expect(screen.queryByTestId("hero-moms-weekly")).toBeNull();
    expect(screen.getByTestId("hero-moms-due").textContent).toBe("~185.700 kr. forfalder 1. marts 2027");
  });
});

describe("demo rota + month — one realistic bistro", () => {
  const minutes = (hhmm) => {
    const [h, m] = hhmm.split(":").map(Number);
    return h * 60 + m;
  };

  it("a cook and a server every evening; the same 30-minute break on every shift; contracts = rostered hours", () => {
    for (let day = 0; day < 7; day++) {
      const depts = demo.DEMO_ROTA.filter((p) => p.shifts[day]).map((p) => p.shifts[day].dept);
      expect(depts, `day ${day}`).toContain("kitchen");
      expect(depts, `day ${day}`).toContain("floor");
    }
    for (const p of demo.DEMO_ROTA) {
      let total = 0;
      for (const s of Object.values(p.shifts)) {
        let span = minutes(s.to) - minutes(s.from);
        if (span < 0) span += 24 * 60;
        expect(span / 60 - 0.5, `${p.name} ${s.from}`).toBe(s.hours);
        total += s.hours;
      }
      if (p.contract != null) expect(p.contract, p.name).toBe(total);
    }
  });

  it("the month's wages are the rota's estimate over a month, and the month adds up", () => {
    const m = demo.DEMO_MONTH;
    expect(m.wages).toBe(Math.round((demo.rotaTotals().wage * 52) / 12));
    expect(m.moms + m.goods + m.wages + m.running + m.profit).toBe(m.revenue);
    for (const k of ["goods", "wages", "running", "profit"]) expect(m[k], k).toBeGreaterThan(0);
  });

  it("the week builder rounds a row and the week the way it rounds a shift", () => {
    renderIn("da", <ScheduleGridV2 />);
    const text = document.body.textContent;
    expect(text).toContain("82 t");
    expect(text).not.toMatch(/\d,\d t\b/); // no one-decimal total beside two-decimal shifts
    expect(text).toContain("29 % af ugens forventede omsætning — mål 30 %");
    expect(text).not.toContain("indtil nu");
  });
});

describe("the demo Book button answers", () => {
  it("a tap says it is an example and nothing was booked; a new choice clears it", () => {
    renderIn("da", <BookingCardV2 />);
    const cta = screen.getByTestId("booking-demo-cta");
    expect(cta.textContent).toBe("Book bord kl. 19:00 til 2 pers.");
    expect(screen.getByTestId("booking-demo-note").textContent).toBe(da.landingV2BookingNoteDa);
    fireEvent.click(cta);
    expect(screen.getByTestId("booking-demo-note").textContent).toBe(da.landingV2BookingDemoDoneDa);
    fireEvent.click(screen.getByRole("button", { name: "4" }));
    expect(screen.getByTestId("booking-demo-note").textContent).toBe(da.landingV2BookingNoteDa);
  });
});

describe("/join — a way out for an owner (web only)", () => {
  const mount = () =>
    renderIn("da", <JoinPage />);

  it("web: 'Er du ejer…? Opret en konto' -> /register", () => {
    mount();
    const line = screen.getByTestId("join-owner-line");
    expect(line.textContent).toContain(da.joinOwnerPrompt);
    expect(screen.getByRole("link", { name: da.joinOwnerLink }).getAttribute("href")).toBe("/register");
  });

  it("native shell: no owner signup on the staff join screen", async () => {
    nativeFlag = true;
    await act(async () => { mount(); });
    expect(screen.queryByTestId("join-owner-line")).toBeNull();
  });

  it("the Vagtplan app build (scheduler) never shows it either", () => {
    expect(read("pages/JoinPage.jsx")).toMatch(/import\.meta\.env\.VITE_APP_MODE !== "scheduler" && !isNativeApp\(\) &&/);
  });
});

describe("phone cut-down below 640 px only; desktop and 640-767 keep every section", () => {
  it("no landing section is hidden below md (768) any more — the gate is sm (640)", () => {
    const files = [
      "pages/LandingV2Page.jsx",
      ...fs.readdirSync(path.join(SRC, "components/landing/v2")).filter((f) => f.endsWith(".jsx")).map((f) => `components/landing/v2/${f}`),
    ];
    for (const f of files) expect(stripComments(read(f)), f).not.toMatch(/max-md:/);
    const page = read("pages/LandingV2Page.jsx");
    expect((page.match(/max-sm:hidden/g) || []).length).toBe(3); // floor plan, phones, week builder
  });
});

describe("cookie banner — 'Læs mere' is easy to hit", () => {
  it("the inline link carries a 44 px hit area; the buttons stay on top of it", () => {
    const src = read("components/CookieConsent.jsx");
    expect(src).toMatch(/const inlineLink =\s*"relative after:absolute after:-inset-x-1 after:-inset-y-\[14px\] after:content-\[''\]/);
    expect(src).toMatch(/const choice =\s*"relative /);
    expect(src).toMatch(/const textBtn =\s*"relative /);
  });
});

describe("copy — plain Danish, one claim per fact", () => {
  it("the add-on modules are named as the product names them", () => {
    expect(da["landingV2.pricing.starter.f10"]).toContain(`${da.moduleBarPourName}, ${da.moduleWineName} eller ${da.moduleWorkshopName}`);
    expect(en["landingV2.pricing.starter.f10"]).toContain(`${en.moduleBarPourName}, ${en.moduleWineName} or ${en.moduleWorkshopName}`);
  });

  it("the footnote matches Terms § 8: cancel any time, it takes effect at the end of the paid period", () => {
    expect(da["landingV2.pricing.footnote"]).not.toMatch(/Opsig samme dag|^Intet kort/);
    expect(en["landingV2.pricing.footnote"]).not.toMatch(/Cancel the same day|^No card/);
    expect(tr["landingV2.pricing.footnote"]).not.toMatch(/Aynı gün iptal/);
    expect(da["landingV2.pricing.footnote"]).toMatch(/udgangen af den måned, du har betalt for/);
    expect(read("pages/TermsPage.jsx")).toMatch(/Opsigelsen får virkning ved udgangen af den periode, du har betalt for/);
  });

  it("the autopilot is described the same way on the plan card and under the week builder", () => {
    for (const d of [da, en]) {
      expect(d["landingV2.pricing.starter.f5"]).toMatch(/48/);
      expect(d["landingV2.schedule.autopilotNote"]).toMatch(/48/);
    }
  });

  it("salons book a time, not only a table; the Danish page has no 'Copilot' / 'Snap'", () => {
    expect(da["landingV2.reservations.title"]).toContain("bord eller tid");
    expect(en["landingV2.reservations.title"]).toContain("appointment");
    const landing = Object.entries(da).filter(([k]) => /^landingV2/.test(k));
    for (const [k, v] of landing) {
      expect(String(v), k).not.toMatch(/copilot/i);
      expect(String(v), k).not.toMatch(/\bSnap\b/);
    }
    expect(da.landingV2HeroCardSnapReceipt).toBe(da.snapReceipt);
  });

  it("the trust line does not claim the policy lists every recipient", () => {
    expect(da.landingV2HeroTrustHosting).not.toMatch(/\balle\b/);
    expect(en.landingV2HeroTrustHosting).not.toMatch(/\bevery\b|\ball\b/);
    expect(tr.landingV2HeroTrustHosting).not.toMatch(/\btüm\b/);
  });

  it("one price unit on a plan card", () => {
    expect(da["landingV2.pricing.perMonth"]).toBe("kr./md.");
    expect(en["landingV2.pricing.perMonth"]).toBe("kr./mo");
    expect(da["landingV2.pricing.thenPrice"]).toMatch(/kr\.\/md\.$/);
    expect(en["landingV2.pricing.thenPrice"]).toMatch(/kr\.\/mo$/);
  });
});
