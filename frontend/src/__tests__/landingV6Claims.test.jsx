/**
 * LANDING V6 — what the page says is true (PORT_PLAN 5.1 "landingV6Claims"; removal audit items 2, 3, 5, 6, 7, 9,
 * 17, 18, 21, 26; port step 10).
 *
 * The page renders here as the app renders it: the real LanguageProvider (da.js / en.js), the real router links,
 * the real Android test (navigator.userAgent). The scroll engine is stubbed (it writes no claim). Each block holds one
 * claim to its source of truth, both ways where a number is involved: the page follows the source when the source
 * changes, and the source is what the backend or the legal text says.
 *   - prices: lib/planPrices.js = backend/app/config.py PLAN_PRICES_DKK / FOUNDING_MEMBER_LIMIT, and nothing on the
 *     page is typed (swapped numbers render swapped; the real ones never appear typed in the tree or the values);
 *   - plan limits: the card lines carry billing.py PLAN_CAPS (read from the file), and follow lib/planLimits.js;
 *   - no MOMS claim on the price while PRICE_MOMS_BASIS is null (and the note shows once it is set);
 *   - the price note's two sentences say what Terms § 8 says (amount at checkout; end of the paid month);
 *   - the founding price: as long as the subscription is active, never "for life"; the first-N = the Terms' N;
 *   - "14 dage gratis" = billing.py TRIAL_DAYS;
 *   - CTAs: router links, in order, to /register, /register?plan=…, /login, #pricing; no absolute bonbox.dk link;
 *   - every demo picture is labelled as a demo;
 *   - App Store links on iPhone / desktop (the two live app ids, = the app's own staff-invite link), the web app on
 *     Android (a real Android user agent);
 *   - Tryghed's data-handling row says what the privacy policy says (Anthropic, place not confirmed);
 *   - the footer: /terms, /privacy, /contact, the address /contact gives, Cookieindstillinger, the CVR lines as the
 *     old footer, no Databehandleraftale.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LanguageProvider } from "../hooks/useLanguage";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { VAGTPLAN_APP_URL } from "../utils/staffInvite";

// The sources the page reads, with a switch: S.swap renders the page on other numbers, S.moms sets the MOMS basis.
const S = vi.hoisted(() => ({ swap: false, moms: null }));
const ODD = vi.hoisted(() => ({
  prices: { starter: { regular: 211, founding: 137 }, pro: { regular: 367, founding: 263 } },
  limit: 77,
  limits: {
    free: { team_users: 2, branches: 2, staff_members: 7, reservations_per_month: 33, z_report_scans_per_day: 5, kasse_extracts_per_day: 5, daily_close_export_days: 9, bookable_resources_max: 11 },
    starter: { team_users: 6, branches: 1, staff_members: 61, reservations_per_month: -1, z_report_scans_per_day: 20, kasse_extracts_per_day: 40, daily_close_export_days: 31, bookable_resources_max: -1 },
    pro: { team_users: 9, branches: 4, staff_members: 222, reservations_per_month: -1, z_report_scans_per_day: 100, kasse_extracts_per_day: 200, daily_close_export_days: 366, bookable_resources_max: -1 },
  },
}));
vi.mock("../lib/planPrices", async (importOriginal) => {
  const a = await importOriginal();
  return {
    get FOUNDING_LIMIT() { return S.swap ? ODD.limit : a.FOUNDING_LIMIT; },
    get PLAN_PRICES() { return S.swap ? ODD.prices : a.PLAN_PRICES; },
    get FROM_PRICE() { return S.swap ? ODD.prices.starter.founding : a.FROM_PRICE; },
  };
});
vi.mock("../lib/planLimits", async (importOriginal) => {
  const a = await importOriginal();
  const cur = () => (S.swap ? ODD.limits : a.PLAN_LIMITS);
  return { get PLAN_LIMITS() { return cur(); }, teamBesidesOwner: (plan) => cur()[plan].team_users - 1 };
});
vi.mock("../components/landing/v2/pricing", async (importOriginal) => {
  const a = await importOriginal();
  return { ...a, get PRICE_MOMS_BASIS() { return S.moms; } };
});
vi.mock("../components/landing/v6/engine", () => ({ mountLanding: () => () => {} }));

const { default: LandingV6Page } = await import("../pages/LandingV6Page");
const REAL = {
  prices: await vi.importActual("../lib/planPrices"),
  limits: (await vi.importActual("../lib/planLimits")).PLAN_LIMITS,
  moms: (await vi.importActual("../components/landing/v2/pricing")).PRICE_MOMS_BASIS,
};

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const backend = (rel) => fs.readFileSync(path.join(SRC, "../../backend", rel), "utf8");
const V6 = "components/landing/v6";
const TREE = ["pages/LandingV6Page.jsx", ...fs.readdirSync(path.join(SRC, V6)).filter((f) => /\.jsx?$/.test(f)).map((f) => `${V6}/${f}`)];
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'])\/\/.*$/gm, "$1").replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
const KEYS = Object.keys(da).filter((k) => k.startsWith("landingV6."));
const norm = (s) => String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const ORIGINAL_UA = navigator.userAgent;
const setUA = (ua) => Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });

function show(lang = "da", { ua = IPHONE } = {}) {
  localStorage.setItem("lang", lang);
  setUA(ua);
  const r = render(<MemoryRouter><LanguageProvider><LandingV6Page /></LanguageProvider></MemoryRouter>);
  const root = r.container.querySelector(".lp6");
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  return { root, $, $$, text: (s) => norm($(s)?.textContent ?? "") };
}
const cards = ($$) => $$(".price").map((li) => ({
  name: norm(li.querySelector(".pn").textContent), price: norm(li.querySelector(".pp").textContent),
  then: norm(li.querySelector(".then").textContent), lines: [...li.querySelectorAll(".inc > span")].map((s) => norm(s.textContent)),
  pick: [...li.querySelectorAll(".pick a")].map((a) => a.getAttribute("href")),
}));

/** The backend's numbers, read from the files (a parser that finds nothing fails, never passes vacuously). */
function configPrices() {
  const cfg = backend("app/config.py");
  const m = cfg.match(/PLAN_PRICES_DKK: dict = \{\s*"starter": \{"regular": (\d+), "founding": (\d+)\},\s*"pro": \{"regular": (\d+), "founding": (\d+)\},/);
  expect(m, "PLAN_PRICES_DKK in config.py").not.toBeNull();
  const lim = cfg.match(/FOUNDING_MEMBER_LIMIT: int = (\d+)\b/);
  expect(lim, "FOUNDING_MEMBER_LIMIT in config.py").not.toBeNull();
  return { starter: { regular: +m[1], founding: +m[2] }, pro: { regular: +m[3], founding: +m[4] }, limit: +lim[1] };
}
function billingCaps(tier) {
  const billing = backend("app/services/billing.py");
  const start = billing.indexOf("PLAN_CAPS: dict[str, dict[str, int]] = {");
  expect(start, "PLAN_CAPS in billing.py").toBeGreaterThan(-1);
  const m = billing.slice(start).match(new RegExp(`^    "${tier}": \\{([\\s\\S]*?)^    \\},`, "m"));
  expect(m, `PLAN_CAPS["${tier}"]`).toBeTruthy();
  const caps = Object.fromEntries([...m[1].replace(/#.*$/gm, "").matchAll(/"([a-z_]+)":\s*(-?\d+)/g)].map(([, k, v]) => [k, Number(v)]));
  expect(Object.keys(caps).length).toBeGreaterThan(10);
  return caps;
}

beforeEach(() => { S.swap = false; S.moms = null; });
afterEach(() => { cleanup(); setUA(ORIGINAL_UA); localStorage.clear(); });

describe("prices: one source (config.py), nothing typed", () => {
  it("lib/planPrices.js = backend config.py PLAN_PRICES_DKK and FOUNDING_MEMBER_LIMIT; the trial line's 'fra' price is Starter's founding price", () => {
    const cfg = configPrices();
    expect(REAL.prices.PLAN_PRICES).toEqual({ starter: cfg.starter, pro: cfg.pro });
    expect(REAL.prices.FOUNDING_LIMIT).toBe(cfg.limit);
    expect(REAL.prices.FROM_PRICE).toBe(cfg.starter.founding);
  });

  it("the page prints config.py's numbers (da and en)", () => {
    const cfg = configPrices();
    let p = show("da");
    expect(p.text("#pricing-h")).toBe(`${cfg.starter.founding} kr./md. for de første ${cfg.limit} virksomheder — derefter ${cfg.starter.regular} kr./md.`);
    expect(cards(p.$$).map((c) => [c.price, c.then])).toEqual([
      ["Gratis", "uden kort"],
      [`${cfg.starter.founding} kr./md.`, `Efter de første ${cfg.limit}: ${cfg.starter.regular} kr./md.`],
      [`${cfg.pro.founding} kr./md.`, `Efter de første ${cfg.limit}: ${cfg.pro.regular} kr./md.`],
    ]);
    expect(p.text(".trial")).toContain(`fra ${cfg.starter.founding} kr./md.`);
    cleanup();
    p = show("en");
    expect(p.text("#pricing-h")).toBe(`${cfg.starter.founding} kr./mo for the first ${cfg.limit} businesses — then ${cfg.starter.regular} kr./mo.`);
    expect(cards(p.$$).slice(1).map((c) => c.price)).toEqual([`${cfg.starter.founding} kr./mo`, `${cfg.pro.founding} kr./mo`]);
  });

  it("swapped numbers render swapped: every price and the first-N on the page come from lib/planPrices.js", () => {
    S.swap = true;
    const p = show("da");
    expect(p.text("#pricing-h")).toBe("137 kr./md. for de første 77 virksomheder — derefter 211 kr./md.");
    expect(cards(p.$$).map((c) => [c.price, c.then])).toEqual([
      ["Gratis", "uden kort"], ["137 kr./md.", "Efter de første 77: 211 kr./md."], ["263 kr./md.", "Efter de første 77: 367 kr./md."],
    ]);
    expect(p.text(".trial")).toContain("fra 137 kr./md.");
    const all = norm(p.root.textContent);
    for (const n of [129, 199, 249, 349]) expect([n, new RegExp(`\\b${n}\\b`).test(all)]).toEqual([n, false]);
    expect(p.text("#pricing")).not.toMatch(/\b100\b/);
  });

  it("no price is typed in the tree's code (generated geometry aside) or in any landingV6 value", () => {
    for (const f of TREE.filter((f) => !/RoomSvg\.jsx|floor\.js|images\.js/.test(f))) {
      expect([f, stripComments(read(f)).match(/\b(129|199|249|349)\b/g)]).toEqual([f, null]);
    }
    for (const k of KEYS) for (const d of [da, en]) expect([k, /\b(129|199|249|349)\b/.test(d[k])]).toEqual([k, false]);
  });

  it("the founding offer: the first N businesses is the Terms' N; kept while the subscription stays active, never 'for life'", () => {
    const terms = read("pages/TermsPage.jsx");
    expect(terms).toContain(`Så længe færre end ${REAL.prices.FOUNDING_LIMIT} virksomheder har et betalt abonnement`);
    expect(terms).toContain(`While fewer than ${REAL.prices.FOUNDING_LIMIT} businesses have a paid subscription`);
    expect(terms).toContain("Du beholder stifterprisen, så længe dit abonnement er aktivt uden afbrydelse.");
    expect(da["landingV6.price.subhead"]).toContain("så længe dit abonnement er aktivt uden afbrydelse");
    expect(en["landingV6.price.subhead"]).toContain("as long as your subscription stays active without a break");
    expect(terms).toContain("You keep the founding price as long as your subscription stays active without");
    const LIFE = /for life|for livet|livstid|for altid|forever|lifetime|permanent/i;
    for (const k of KEYS) for (const d of [da, en]) expect([k, LIFE.test(d[k])]).toEqual([k, false]);
  });

  it("the trial answer says what checkout does: no paid plan → the free plan, no charge; a paid plan picked in the trial is charged when the trial ends (fix round)", () => {
    // stripe_billing.py carries the remaining trial days into the Stripe subscription (trial_period_days = remaining):
    // the card is charged when the trial ends, so "no auto-charge" without the condition was not true for that owner
    expect(backend("app/services/stripe_billing.py")).toMatch(/sub_data\["trial_period_days"\] = int\(remaining\)/);
    expect(da["landingV6.faq.trialA"]).toBe("Har du ikke valgt en betalt plan, falder du automatisk ned til gratisplanen — intet kort, intet træk. Vælger du Starter eller Pro i prøveperioden, betaler du først, når de 14 dage er gået.");
    expect(en["landingV6.faq.trialA"]).toBe("If you haven't chosen a paid plan, you drop to the free plan automatically — no card, no charge. If you choose Starter or Pro during the trial, you pay only once the 14 days are up.");
    for (const d of [da, en]) expect(d["landingV6.faq.trialA"]).not.toMatch(/auto-træk|auto-charge/i);
  });

  it("'14 dage gratis' is billing.py TRIAL_DAYS, in every trial line and the trial question (da + en)", () => {
    const m = backend("app/services/billing.py").match(/^TRIAL_DAYS = (\d+)$/m);
    expect(m).not.toBeNull();
    const days = Number(m[1]);
    for (const k of ["landingV6.trial", "landingV6.trialEnd", "landingV6.trialDock", "landingV6.faq.trialQ", "landingV6.faq.trialA"]) {
      expect([k, da[k].match(/\d+/)[0], en[k].match(/\d+/)[0]]).toEqual([k, String(days), String(days)]);
    }
  });
});

describe("plan limits: the cards carry billing.py PLAN_CAPS", () => {
  it("Gratis 3 staff / 20 reservations / 3 Z-bon photos a day ('hver dags' kasserapport PDF), Starter 'Dig + 2' / 50, Pro 3 locations / 'dig + 4' / 200 — read from billing.py", () => {
    const free = billingCaps("free"), starter = billingCaps("starter"), pro = billingCaps("pro");
    // the Gratis line's "3 om dagen" holds on both photo paths; the period export cap is why the PDF line says "hver dags"
    expect(free.kasse_extracts_per_day).toBe(free.z_report_scans_per_day);
    expect(free.daily_close_export_days).toBeGreaterThan(0);
    const { $$ } = show("da");
    expect(cards($$).map((c) => [c.name, c.lines])).toEqual([
      ["", [
        `${free.team_users} bruger, ${free.branches} afdeling, op til ${free.staff_members} medarbejdere på vagtplanen`,
        `Reservationer, ${free.reservations_per_month} om måneden, op til ${free.bookable_resources_max} borde — bookingside, bordplan, venteliste`,
        `Z-bon-aflæsning fra foto: ${free.z_report_scans_per_day} om dagen — hver dags kasserapport som PDF uden grænse`,
      ]],
      ["Starter", [`Dig + ${starter.team_users - 1} teammedlemmer med rollerettigheder, op til ${starter.staff_members} medarbejdere på vagtplanen`, "Reservationer, ubegrænset"]],
      ["Pro", [`${pro.branches} afdelinger, dig + ${pro.team_users - 1} teammedlemmer, op til ${pro.staff_members} medarbejdere på vagtplanen`, "Reservationer, ubegrænset"]],
    ]);
    expect([starter.reservations_per_month, pro.reservations_per_month]).toEqual([-1, -1]); // "ubegrænset" is true
    // the numbers Manoj approved for the Gratis card (21 Oct); the table cap (fix round, forslag) is the one create_resource enforces
    expect([free.staff_members, free.reservations_per_month, free.z_report_scans_per_day, free.bookable_resources_max]).toEqual([3, 20, 3, 3]);
    expect(backend("app/routers/reservations.py")).toMatch(/enforce_cap\(user, "bookable_resources_max"/);
  });

  it("swapped limits render swapped (da + en): every number on the cards comes from lib/planLimits.js", () => {
    S.swap = true;
    let p = show("da");
    expect(cards(p.$$).map((c) => c.lines)).toEqual([
      ["2 bruger, 2 afdeling, op til 7 medarbejdere på vagtplanen", "Reservationer, 33 om måneden, op til 11 borde — bookingside, bordplan, venteliste", "Z-bon-aflæsning fra foto: 5 om dagen — hver dags kasserapport som PDF uden grænse"],
      ["Dig + 5 teammedlemmer med rollerettigheder, op til 61 medarbejdere på vagtplanen", "Reservationer, ubegrænset"],
      ["4 afdelinger, dig + 8 teammedlemmer, op til 222 medarbejdere på vagtplanen", "Reservationer, ubegrænset"],
    ]);
    cleanup();
    p = show("en");
    expect(cards(p.$$).map((c) => c.lines[0])).toEqual([
      "2 user, 2 location, up to 7 staff on the schedule",
      "You + 5 team members with role permissions, up to 61 staff on the schedule",
      "4 locations, you + 8 team members, up to 222 staff on the schedule",
    ]);
    expect(cards(p.$$)[0].lines[1]).toBe("Reservations, 33 a month, up to 11 tables — booking page, floor plan, waitlist");
  });
});

describe("MOMS on our own price: not claimed while unknown", () => {
  it("PRICE_MOMS_BASIS is null today: the price section says nothing about moms / VAT (da + en)", () => {
    expect(REAL.moms).toBeNull();
    for (const lang of ["da", "en"]) {
      const p = show(lang);
      expect([lang, p.text("#pricing")]).toEqual([lang, expect.not.stringMatching(/moms|\bvat\b/i)]);
      expect(p.$$(".pnote")).toHaveLength(1);
      cleanup();
    }
  });

  it("once the basis is set, the one note shows under the prices (both ways, da + en)", () => {
    for (const [basis, key] of [["excl", "landingV6.price.momsExcl"], ["incl", "landingV6.price.momsIncl"]]) {
      S.moms = basis;
      for (const [lang, d] of [["da", da], ["en", en]]) {
        const p = show(lang);
        expect(p.$$(".pnote").map((n) => norm(n.textContent))[1]).toBe(norm(d[key]));
        cleanup();
      }
    }
  });
});

describe("the price note says what Terms § 8 says", () => {
  it("the amount is shown at checkout before you confirm; cancelling ends with the month you paid for (da + en, = the live footnote)", () => {
    const terms = read("pages/TermsPage.jsx");
    let p = show("da");
    const daNote = p.text(".pnote");
    expect(daNote).toContain("Opsig når som helst. Ingen binding, intet opstartsgebyr. Priserne er pr. virksomhed.");
    expect(daNote).toContain("Du ser det præcise beløb ved betalingen, før du bekræfter.");
    expect(daNote).toContain("Opsigelsen gælder fra udgangen af den måned, du har betalt for.");
    // the live footnote these were cut from, and the Terms they stand on
    expect(da["landingV2.pricing.footnote"]).toContain("du ser det præcise beløb ved betalingen, før du bekræfter");
    expect(da["landingV2.pricing.footnote"]).toContain("opsigelsen gælder fra udgangen af den måned, du har betalt for");
    expect(terms).toContain("Beløbet, du skal betale, vises ved betalingen, før du bekræfter købet.");
    expect(terms).toContain("Opsigelsen får virkning ved udgangen af den periode, du har betalt for.");
    expect(terms).toContain("Priserne er pr. virksomhed");
    cleanup();
    p = show("en");
    const enNote = p.text(".pnote");
    expect(enNote).toContain("You see the exact amount at checkout before you confirm.");
    expect(enNote).toContain("Cancelling takes effect at the end of the month you have paid for.");
    expect(en["landingV2.pricing.footnote"]).toContain("you see the exact amount at checkout before you confirm");
    expect(terms).toContain("The amount you pay is shown at checkout before you confirm the purchase.");
    expect(terms).toMatch(/The cancellation takes effect at the end of the period/);
  });
});

describe("CTAs: router links, in order", () => {
  it("every way in goes to /register (top bar, hero, end of the day, bottom bar, prices) or /login; Vælg Starter / Vælg Pro carry the plan; Free has none", () => {
    const { $$ } = show("da");
    const where = (a) => (a.closest("#top-bar") ? "top" : a.closest("#hero") ? "hero" : a.closest("#snend") ? "end" : a.closest("#dock") ? "dock" : a.closest(".price") ? "card" : a.closest("#pcta") ? "prices" : "other");
    const ins = $$("a").filter((a) => /^\/(register|login)/.test(a.getAttribute("href"))).map((a) => [where(a), a.getAttribute("href"), norm(a.textContent)]);
    expect(ins).toEqual([
      ["top", "/login", "Log ind"],
      ["top", "/register", "Prøv gratis"],
      ["hero", "/register", "Prøv gratis"],
      ["end", "/register", "Prøv gratis"],
      ["dock", "/register", "Prøv gratis"],
      ["card", "/register?plan=starter", "Vælg Starter"],
      ["card", "/register?plan=pro", "Vælg Pro"],
      ["prices", "/register", "Prøv gratis"],
    ]);
    expect(cards($$).map((c) => [c.price.split(" ")[0], c.pick])).toEqual([["Gratis", []], [String(REAL.prices.PLAN_PRICES.starter.founding), ["/register?plan=starter"]], [String(REAL.prices.PLAN_PRICES.pro.founding), ["/register?plan=pro"]]]);
  });

  it("Priser and Se priser go to #pricing, the price section is #pricing with its heading; no absolute bonbox.dk link anywhere", () => {
    const { $, $$ } = show("da");
    expect($$("a[href='#pricing']").map((a) => norm(a.textContent))).toEqual(["Priser", "Se priser"]);
    expect($("section#pricing").getAttribute("aria-labelledby")).toBe("pricing-h");
    expect($("#pricing-h").tagName).toBe("H2");
    expect($$("[id='priser']")).toHaveLength(0);
    expect($$("a").map((a) => a.getAttribute("href")).filter((h) => /^(https?:)?\/\/(www\.)?bonbox\.dk/i.test(h))).toEqual([]);
  });
});

describe("demo data is labelled", () => {
  it("every picture on the stage, the plate and the room carry 'Eksempel · demodata' (en: 'Example · demo data')", () => {
    for (const [lang, d] of [["da", da], ["en", en]]) {
      const { $, $$ } = show(lang);
      const figs = $$("#frame figure");
      expect(figs.length).toBeGreaterThanOrEqual(13);
      const labelled = (f) => [...f.querySelectorAll(".demo")].some((c) => norm(c.textContent) === d["landingV6.demo"]);
      // the 22.50 tile ("16 sidder nu") is the prototype's one unlabelled figure: it shows only beside the host-stand
      // plan (#stand, same scene, both phone-only), whose label covers the pair; every other figure has its own
      for (const f of figs) expect([f.id, f.id === "tal" || labelled(f)]).toEqual([f.id, true]);
      const tal = $("#tal"), stand = $("#stand");
      expect([tal.parentElement.id, stand.parentElement.id, tal.classList.contains("ph-only"), stand.classList.contains("ph-only"), labelled(stand)]).toEqual(["s5", "s5", true, true, true]);
      expect(norm($("#plate .pcap").textContent)).toBe(d["landingV6.demo"]);
      // every picture of the app is inside a labelled figure
      for (const img of $$("img")) expect([img.getAttribute("src"), !!img.closest("#frame figure")]).toEqual([img.getAttribute("src"), true]);
      // the roster card is read as a demo by a screen reader too
      expect($("#roster").getAttribute("aria-label")).toContain(d["landingV6.demo"]);
      cleanup();
    }
  });
});

describe("the two iPhone apps, or the web app on Android", () => {
  it("iPhone (and desktop): App Store links to the two live apps; the Vagtplan link is the app's own staff-invite link", () => {
    const { $$ } = show("da", { ua: IPHONE });
    const store = $$('a[href^="https://apps.apple.com/"]').map((a) => a.getAttribute("href"));
    expect(store.map((h) => h.match(/id\d+$/)[0])).toEqual(["id6787010793", "id6787010793", "id6787010793", "id6762066960"]);
    expect(store[0]).toBe(VAGTPLAN_APP_URL);
    expect($$('a[href="/join"]')).toHaveLength(0);
  });

  it("Android (a real Android user agent): no App Store link; Vagtplan → /join, BonBox → /register, in the browser", () => {
    for (const [lang, d] of [["da", da], ["en", en]]) {
      const { $$ } = show(lang, { ua: ANDROID });
      expect($$('a[href*="apps.apple.com"]')).toHaveLength(0);
      expect($$('a[href="/join"]').map((a) => norm(a.textContent))).toEqual([d["landingV6.web.scheduler"], d["landingV6.web.scheduler"], d["landingV6.web.scheduler"]]);
      const owner = $$(".foot .apps a")[0];
      expect([owner.getAttribute("href"), norm(owner.textContent)]).toEqual(["/register", d["landingV6.web.owner"]]);
      cleanup();
    }
  });
});

describe("Tryghed: who reads the receipt images, said the way the privacy policy says it", () => {
  it("Anthropic named, the place not yet confirmed, nothing sold, no training — no USA, no 'all'", () => {
    const { $$ } = show("da");
    const rows = $$(".trust li").map((li) => norm(li.textContent));
    expect(rows[1]).toBe(norm(da["landingV6.trust.data"]));
    for (const [d, notYet] of [[da, /endnu ikke bekræftet/], [en, /not yet confirmed/]]) {
      const v = d["landingV6.trust.data"];
      expect(v).toMatch(/Anthropic/);
      expect(v).toMatch(notYet);
      expect(v).not.toMatch(/USA|\bUS\b|\balle\b|\ball\b/i);
    }
    expect(da["landingV6.trust.data"]).toMatch(/Vi sælger ikke dine data og træner ikke modeller på dit regnskab\./);
    expect(en["landingV6.trust.data"]).toMatch(/We don't sell your data and we don't train models on your books\./);
    const privacy = read("pages/PrivacyPolicyPage.jsx");
    expect(privacy).toMatch(/\["Anthropic \(Claude API\)", "Aflæsning af kvitteringer[^"]*", "Ikke bekræftet"/);
    expect(privacy).toMatch(/\["Anthropic \(Claude API\)", "Reading receipts[^"]*", "Not confirmed"/);
  });
});

describe("the footer reaches a person and the legal texts", () => {
  it("Handelsbetingelser, Privatlivspolitik, Kontakt as in-app links; the address /contact gives; Cookieindstillinger; no Databehandleraftale (da + en)", () => {
    const contact = read("pages/ContactPage.jsx").match(/const SUPPORT_EMAIL = "([^"]+)"/)[1];
    for (const [lang, d] of [["da", da], ["en", en]]) {
      const { $, $$, root } = show(lang);
      expect($$(".foot .links a").map((a) => [a.getAttribute("href"), norm(a.textContent)])).toEqual([
        ["/terms", d["landingV6.foot.terms"]], ["/privacy", d["landingV6.foot.privacy"]], ["/contact", d["landingV6.foot.contact"]],
      ]);
      const cookies = $(".foot .links button");
      expect([norm(cookies.textContent), cookies.getAttribute("data-cookie-settings")]).toEqual([d["landingV6.foot.cookies"], "open"]);
      expect($$('a[href^="mailto:"]').map((a) => a.getAttribute("href"))).toEqual([`mailto:${contact}`, `mailto:${contact}`]);
      expect(root.textContent).not.toMatch(/databehandler|data processing agreement/i);
      cleanup();
    }
    // the legal documents keep their Danish titles on the English page (section 8 item 9)
    expect([en["landingV6.foot.terms"], en["landingV6.foot.privacy"]]).toEqual(["Handelsbetingelser", "Privatlivspolitik"]);
  });

  it("the registry lines are the old footer's, word for word (the CVR register)", () => {
    const { $ } = show("da");
    const old = read("components/landing/v2/FooterV2.jsx");
    const lines = $(".foot .legal p").innerHTML.split("<br>").slice(1, 3);
    expect(lines).toEqual(["DukaanAI v/Manoz Chaudhary", "CVR 46417321"]);
    for (const l of lines) expect(old).toContain(`"${l}"`);
  });
});
