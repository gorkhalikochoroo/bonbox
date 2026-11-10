/**
 * LANDING V6 — fix round 2, part A (10 Nov 2026): fixes 1 (revised), 2 and 3 of the landing review, as the owner answered them
 * (bonbox-lab-state/landing-review-2026-11-10/SPEC.md and REVIEW.md).
 *
 * Each block holds one change to the page and, where the page now says something new, to the code that makes it true:
 *   1. a professional way to ask: a quiet question link beside the price button (the contact address with the page's own subject)
 *      and the address as text; the founder block keeps its text and adds the company with the CVR linked to the public register,
 *      the main button and the trial line; no photo, no surname, no set-up promise; on the one-column page it sits directly under
 *      the prices, from 1200 px beside the questions; one Tryghed row names the two apps on the App Store;
 *   2. prices: the first-N are the Terms' on the landing and on the sign-up page; the flat-price subhead; "og borde"; the door
 *      tablet takes no login; every plan ends with a quiet outlined button; feature lines in normal weight; the MOMS line; "Priser"
 *      in the phone's top bar once the hero is past; the price headline stays in view on desktop;
 *   3. the small note under each scene says what the owner stops doing, and the notes that mattered show at rest.
 * The page renders as the app renders it (the real LanguageProvider and router links); the scroll engine is stubbed.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LanguageProvider } from "../hooks/useLanguage";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { FOUNDING_LIMIT } from "../lib/planPrices";
import { PLAN_LIMITS } from "../lib/planLimits";
import { PRICE_MOMS_BASIS } from "../components/landing/v2/pricing";
import * as site from "../components/landing/v6/site";
import { placeOf } from "../components/landing/v6/place";

vi.mock("../components/landing/v6/engine", () => ({ mountLanding: () => () => {} }));
const { default: LandingV6Page } = await import("../pages/LandingV6Page");

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const backend = (rel) => fs.readFileSync(path.join(SRC, "../../backend", rel), "utf8");
const norm = (s) => String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const CSS = read("components/landing/v6/landingV6.css");
const { APP_STORE, CONTACT_EMAIL, LEGAL_LINES } = site;

const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID = "Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36";
const ORIGINAL_UA = navigator.userAgent;
const setUA = (ua) => Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });

function show(lang = "da", ua = IPHONE) {
  localStorage.setItem("lang", lang);
  setUA(ua);
  const r = render(<MemoryRouter><LanguageProvider><LandingV6Page /></LanguageProvider></MemoryRouter>);
  const root = r.container.querySelector(".lp6");
  const $ = (s) => root.querySelector(s);
  const $$ = (s) => [...root.querySelectorAll(s)];
  return { root, $, $$, text: (s) => norm($(s)?.textContent ?? "") };
}
afterEach(() => { cleanup(); setUA(ORIGINAL_UA); localStorage.clear(); });

const PAGES = [["da", da], ["en", en]];
/** The stage note of one beat: its text and its links. */
const note = ($$, copy, beat) => {
  const p = $$(`#${copy} .asides .aside`).filter((a) => a.getAttribute("data-b").split(" ").includes(beat));
  expect([copy, beat, p.length]).toEqual([copy, beat, 1]);
  return { text: norm(p[0].textContent), links: [...p[0].querySelectorAll("a")] };
};

describe("fix 3 · the note under each scene says what the owner stops doing", () => {
  it("each scene at rest shows its own line, in Danish and in English", () => {
    const WANT = {
      da: {
        "c1 1a": "I stedet for regnearket og gruppechatten.",
        "c1 1b": "På iPhone i Vagtplan-appen, på Android i browseren. Vagtplan i App Store",
        "c2 2a": "Bookingsiden er ét link til din Instagram-bio og Google-profil. Intet gebyr pr. booking.",
        "c2 S": "Gæsten fra kl. 12.30 sidder ved Vindue 2.",
        "c2 2b": "Tabletten ved døren viser kun reservationer – aldrig regnskab eller løn.",
        "c3 3a": "Du beholder din kasse. BonBox læser Z-bonen fra et foto.",
        "c3 3b": "Kasserapporter som PDF – du gemmer dem selv i 5 år",
      },
      en: {
        "c1 1a": "Instead of the spreadsheet and the group chat.",
        "c1 1b": "On iPhone in the Vagtplan app, on Android in the browser. Vagtplan on the App Store",
        "c2 2a": "One booking link for your Instagram bio and Google profile. No fee per booking.",
        "c2 S": "The guest from 12:30 is seated at Vindue 2.",
        "c2 2b": "The tablet at the door shows reservations only – never accounts or wages.",
        "c3 3a": "You keep your till. BonBox reads the Z-report from a photo.",
        "c3 3b": "Each kasserapport as a PDF – you keep them for 5 years",
      },
    };
    for (const [lang] of PAGES) {
      const { $$ } = show(lang);
      // the seven scenes' resting beats (nav.js NAV): 1a 2a 1b S 2b 3a 3b
      const got = Object.fromEntries(Object.keys(WANT[lang]).map((k) => [k, note($$, ...k.split(" ")).text]));
      expect([lang, got]).toEqual([lang, WANT[lang]]);
      cleanup();
    }
  });

  it("10.00 and 16.40 no longer share one note: 10.00 has no link out of the page; 16.40 keeps the App Store link, in a new tab (rel noopener noreferrer)", () => {
    const { $$ } = show("da");
    expect($$("#c1 .asides .aside").map((a) => a.getAttribute("data-b"))).toEqual(["h 1a", "1b A"]);
    expect(note($$, "c1", "1a").links).toEqual([]);
    expect(note($$, "c1", "h").links).toEqual([]);
    const links = note($$, "c1", "1b").links;
    expect(links.map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel"), norm(a.textContent)])).toEqual([[APP_STORE.scheduler, "_blank", "noopener noreferrer", "Vagtplan i App Store"]]);
    // the engine brings 16.40 back for a keyboard focus on that link (it brought 10.00 back while the two shared the note)
    expect(read("components/landing/v6/engine.js")).toContain('jumpTo(Math.round(beatY(c === c1 ? "1b" : c === c2 ? "2a" : "3a", 0.5)));');
  });

  it("16.40's line is true for both phones: the Vagtplan app is the iPhone app the page links, and on Android the same place opens the browser version", () => {
    const { $$ } = show("da", ANDROID);
    const n = note($$, "c1", "1b");
    expect(n.text).toBe("På iPhone i Vagtplan-appen, på Android i browseren. Vagtplan i browseren");
    expect(n.links.map((a) => [a.getAttribute("href"), a.getAttribute("target")])).toEqual([["/join", null]]);
    expect(APP_STORE.scheduler).toMatch(/^https:\/\/apps\.apple\.com\//);
    expect(read("../ios-scheduler/App/App/Info.plist")).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>Vagtplan<\/string>/);
  });

  it("22.50 shows the tablet line at rest and through its end (2b C); the 63-guests line moved to the moment before it (B2); 00.10: the till line with the photo (3a), the PDF line (3b), then the 06.00 line as the day ends (end)", () => {
    const { $$ } = show("da");
    expect($$("#c2 .asides .aside").map((a) => [a.getAttribute("data-b"), norm(a.textContent).slice(0, 22)])).toEqual([
      ["2a", "Bookingsiden er ét lin"], ["S", "Gæsten fra kl. 12.30 s"], ["B2", "63 gæster: 61 med book"], ["2b C", "Tabletten ved døren vi"],
    ]);
    expect($$("#c3 .asides .aside").map((a) => [a.getAttribute("data-b"), norm(a.textContent)])).toEqual([
      ["3a", "Du beholder din kasse. BonBox læser Z-bonen fra et foto."],
      ["3b", "Kasserapporter som PDF – du gemmer dem selv i 5 år"],
      ["end", "Dagen skifter kl. 06.00, så salget efter midnat hører til tirsdag."],
    ]);
  });

  it("the stacked page (short phones, reduced motion) carries the same lines under its scenes", () => {
    const { $$ } = show("da");
    const notes = (id) => $$(`#${id} .copy.st .aside`).map((p) => norm(p.textContent));
    expect(notes("s1")).toEqual(["I stedet for regnearket og gruppechatten."]);
    expect(notes("s2")).toEqual(["Bookingsiden er ét link til din Instagram-bio og Google-profil. Intet gebyr pr. booking."]);
    expect(notes("s3")).toEqual(["På iPhone i Vagtplan-appen, på Android i browseren. Vagtplan i App Store"]);
    expect(notes("s5")).toEqual(["Tabletten ved døren viser kun reservationer – aldrig regnskab eller løn.", "63 gæster: 61 med booking, 2 som drop-in."]);
    expect(notes("s6")).toEqual(["Du beholder din kasse. BonBox læser Z-bonen fra et foto.", "Dagen skifter kl. 06.00, så salget efter midnat hører til tirsdag.", "Kasserapporter som PDF – du gemmer dem selv i 5 år"]);
    expect($$("#s1 a[href^='http']")).toEqual([]);
    expect($$("#s3 .copy.st a").map((a) => [a.getAttribute("href"), a.getAttribute("target"), a.getAttribute("rel")])).toEqual([[APP_STORE.scheduler, "_blank", "noopener noreferrer"]]);
  });

  it("no new line names a competitor or says 'alle kasser' / 'any till'", () => {
    const NEW = ["landingV6.s1.instead", "landingV6.s3.where", "landingV6.s2.aside", "landingV6.s6.keep", "landingV6.price.flat", "landingV6.price.standNoLogin", "landingV6.price.momsNone", "landingV6.ask.line", "landingV6.trust.apps", "landingV6.founder.company"];
    for (const [lang, d] of PAGES) for (const k of NEW) {
      expect([lang, k, typeof d[k]]).toEqual([lang, k, "string"]);
      expect([lang, k, d[k]]).toEqual([lang, k, expect.not.stringMatching(/planday|tamigo|zenchef|dinnerbooking|resdiary|\bwolt\b|thefork|easytable|pleo|dinero|alle kasser|any till|every till/i)]);
    }
  });
});

describe("fix 3 · 'no fee per booking, no cut of your revenue, one flat price per business' is what billing does", () => {
  it("the flat-price line is the price section's subhead, in ink before the founding-price condition (da + en)", () => {
    for (const [lang, d] of PAGES) {
      const { $$ } = show(lang);
      expect([lang, $$("#pricing .lead .psub").map((p) => [p.className, norm(p.textContent)])]).toEqual([lang, [["psub", norm(d["landingV6.price.flat"])], ["psub pkeep", norm(d["landingV6.price.subhead"])]]]);
      cleanup();
    }
    expect(da["landingV6.price.flat"]).toBe("Én fast pris pr. virksomhed\u00a0– ikke pr. medarbejder. Intet gebyr pr. booking, ingen andel af din omsætning.");
    expect(en["landingV6.price.flat"]).toBe("One flat price per business\u00a0– not per employee. No fee per booking, no cut of your revenue.");
    expect(CSS).toContain(".lp6 .psub:not(.pkeep){color:var(--ink)}");
  });

  it("checkout is one monthly subscription per account, quantity 1; nothing in billing charges per booking, per employee or a share of sales", () => {
    const stripe = backend("app/services/stripe_billing.py"), billing = backend("app/services/billing.py");
    expect(stripe).toMatch(/mode="subscription",/);
    expect(stripe).toMatch(/line_items=\[\{"price": price, "quantity": 1\}\],/);
    for (const [name, src] of [["stripe_billing.py", stripe], ["billing.py", billing]]) {
      expect([name, src.match(/application_fee|transfer_data|usage_record|per_seat|per_booking|booking_fee|revenue_share|percent_of_revenue|commission_rate/gi)]).toEqual([name, null]);
    }
    // the Stripe SDK is imported in that one file, and everything it creates there is a customer, a checkout session and a
    // customer-portal session: never a charge, a transfer, an invoice item or a usage record
    const importers = [];
    const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).forEach((e) => {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name !== "tests" && e.name !== "__pycache__") walk(p); } else if (e.name.endsWith(".py") && /^\s*(import stripe|from stripe)\b/m.test(fs.readFileSync(p, "utf8"))) importers.push(e.name);
    });
    walk(path.join(SRC, "../../backend/app"));
    expect(importers).toEqual(["stripe_billing.py"]);
    expect([...new Set([...stripe.matchAll(/\bs\.([A-Za-z_.]+)\.create\(/g)].map((m) => m[1]))].sort()).toEqual(["Customer", "billing_portal.Session", "checkout.Session"]);
    // and the page says it
    expect(da["landingV6.s2.aside"]).toContain("Intet gebyr pr. booking.");
    expect(da["landingV6.price.flat"]).toContain("ingen andel af din omsætning");
  });
});

describe("fix 2 · prices: one rule for the first 100, on the landing and on the sign-up page", () => {
  it("the headline counts as the Terms count: businesses with a paid subscription (da + en); the number is still lib/planPrices'", () => {
    const terms = read("pages/TermsPage.jsx");
    expect(terms).toContain(`Så længe færre end ${FOUNDING_LIMIT} virksomheder har et betalt abonnement`);
    expect(terms).toContain(`While fewer than ${FOUNDING_LIMIT} businesses have a paid subscription`);
    let p = show("da");
    expect(p.text("#pricing-h")).toContain(`for de første ${FOUNDING_LIMIT} virksomheder med et betalt abonnement – derefter`);
    cleanup();
    p = show("en");
    expect(p.text("#pricing-h")).toContain(`for the first ${FOUNDING_LIMIT} businesses with a paid subscription – then`);
  });

  it("the sign-up page's founding line says the same (it said 'betalende kunder' / 'paying customers')", () => {
    expect(da.trialBenefit3).toBe("Stifterpris fra 129 kr./md for de første 100 virksomheder med et betalt abonnement – den gælder, så længe abonnementet er aktivt");
    expect(en.trialBenefit3).toBe("Founding price from 129 kr/mo for the first 100 businesses with a paid subscription — kept as long as your subscription stays active");
    for (const d of [da, en]) expect(d.trialBenefit3).not.toMatch(/betalende kunder|paying customers/i);
    expect(read("pages/RegisterPage.jsx")).toContain('t("trialBenefit3")');
  });
});

describe("fix 2 · prices: what the plans give, and how to pick one", () => {
  it("Starter and Pro: 'Reservationer og borde, ubegrænset' (both caps are -1); Gratis keeps its numbers", () => {
    expect([PLAN_LIMITS.starter.reservations_per_month, PLAN_LIMITS.starter.bookable_resources_max, PLAN_LIMITS.pro.reservations_per_month, PLAN_LIMITS.pro.bookable_resources_max]).toEqual([-1, -1, -1, -1]);
    for (const [lang, line] of [["da", "Reservationer og borde, ubegrænset"], ["en", "Reservations and tables, unlimited"]]) {
      const { $$ } = show(lang);
      const lines = $$(".price").map((li) => [...li.querySelectorAll(".inc > span")].map((s) => norm(s.textContent)));
      expect([lang, lines[1][1], lines[2][1]]).toEqual([lang, line, line]);
      expect(lines[0][1]).toMatch(lang === "da" ? /^Reservationer, 20 om måneden, op til 3 borde/ : /^Reservations, 20 a month, up to 3 tables/);
      cleanup();
    }
  });

  it("'Tabletten ved døren bruger ikke et login.' sits under the cards (da + en), and pairing a door device never counts a login seat", () => {
    for (const [lang, d] of PAGES) {
      const { $$ } = show(lang);
      expect([lang, $$(".pall").map((p) => norm(p.textContent))]).toEqual([lang, [norm(d["landingV6.price.allPlans"]), norm(d["landingV6.price.standNoLogin"])]]);
      cleanup();
    }
    expect(da["landingV6.price.standNoLogin"]).toBe("Tabletten ved døren bruger ikke et login.");
    expect(en["landingV6.price.standNoLogin"]).toBe("The tablet at the door does not use a login.");
    // the stand is paired with a device code (its own credential); the only gate on creating one is the reservations feature, on for every plan
    const stand = backend("app/routers/stand_link.py");
    const create = stand.slice(stand.indexOf("def create_stand_link("), stand.indexOf("def list_stand_links("));
    expect(create).toContain('enforce_feature(user, "reservations")');
    expect(create).toContain("link = StandLink(");
    expect(stand).not.toMatch(/team_users|enforce_cap|at_cap|TeamMember/);
    // login seats are counted where a team member is invited, and nowhere else
    expect(backend("app/routers/team.py")).toMatch(/at_cap\(user, "team_users", seats_used\)/);
    const billing = backend("app/services/billing.py");
    expect([...billing.matchAll(/^\s+"reservations": (True|False),/gm)].map((m) => m[1])).toEqual(expect.arrayContaining(["True"]));
    expect(billing).not.toMatch(/^\s+"reservations": False,/m);
  });

  it("every plan ends with a quiet outlined button, 44 px high with a forest line: Start gratis, Vælg Starter, Vælg Pro", () => {
    const { $$ } = show("da");
    expect($$(".price .pick a").map((a) => [a.className, a.getAttribute("href"), norm(a.textContent)])).toEqual([
      ["btn btn-q", "/register", "Start gratis"], ["btn btn-q", "/register?plan=starter", "Vælg Starter"], ["btn btn-q", "/register?plan=pro", "Vælg Pro"],
    ]);
    cleanup();
    expect(show("en").$$(".price .pick a").map((a) => norm(a.textContent))).toEqual(["Start free", "Choose Starter", "Choose Pro"]);
    expect(CSS).toMatch(/\.lp6 \.btn\{display:inline-flex;align-items:center;justify-content:center;height:44px;/);
    expect(CSS).toContain(".lp6 .btn.btn-q{background:transparent;color:var(--ink);border:1px solid var(--forest);font-weight:500}");
    expect(CSS).not.toMatch(/\.lp6 \.price \.pick \.tlink/); // no thin text link left
  });

  it("the plans' feature lines are set in normal weight", () => {
    const inc = CSS.match(/\.lp6 \.price \.inc\{([^}]*)\}/);
    expect(inc).not.toBeNull();
    expect(inc[1]).toContain("font-weight:400");
    // rendered: the lines are still the three per plan
    expect(show("da").$$(".price .inc > span")).toHaveLength(9);
  });

  it("the MOMS line: the basis is 'none', so the page says no moms comes on top, and the 'exact amount at checkout' sentence left the price note", () => {
    expect(PRICE_MOMS_BASIS).toBe("none");
    // polish pass (10 Nov): the Danish line writes MOMS in capitals, as the rest of the Danish page does
    for (const [lang, line] of [["da", "Der kommer ikke MOMS oven i prisen."], ["en", "No MOMS is added on top of the price."]]) {
      const { $$, text } = show(lang);
      expect([lang, $$(".pnote").map((p) => norm(p.textContent))[1]]).toEqual([lang, line]);
      expect([lang, text("#pricing")]).toEqual([lang, expect.not.stringMatching(/præcise beløb|exact amount/i)]);
      cleanup();
    }
    // the Terms and the sign-up page say nothing that contradicts it (the spec's stop condition)
    const CONTRA = /ekskl\.? ?moms|excl\.? ?(vat|moms)|moms tillægges|plus moms|\+ ?moms|vat (is|will be) added|plus vat/i;
    expect(read("pages/TermsPage.jsx")).not.toMatch(CONTRA);
    for (const d of [da, en]) for (const k of ["trialBenefit3", "registerSubheadingWeb", "suPanelHeading", "suPanelBody", "suPanelBenefit1", "suPanelBenefit2", "suPlanStarterNote", "suPlanProNote"]) {
      expect([k, typeof d[k]]).toEqual([k, "string"]);
      expect([k, d[k]]).toEqual([k, expect.not.stringMatching(CONTRA)]);
    }
  });

  it("phone top bar: once the hero is past and the bottom bar carries the button, 'Priser' shows where the flags were (under 400 px); desktop: the price headline stays in view beside the plans", () => {
    expect(CSS).toContain("@media (max-width:399px){.lp6.js.cta-past.dock-on .top .lang{display:none}}");
    expect(CSS).toContain("@media (max-width:399px){.lp6.js.cta-past.dock-on .top .navl.prices-l{display:block}}");
    const { $$ } = show("da");
    // the link and both switches are still in the page: the top bar's flags over the hero, the footer's always
    expect($$(".top .navl.prices-l").map((a) => a.getAttribute("href"))).toEqual(["#pricing"]);
    expect([$$(".top .lang button").length, $$(".foot .lang button").length]).toEqual([2, 2]);
    const wide = CSS.slice(CSS.indexOf("/* desktop: the decision keeps the day's grammar"));
    expect(wide.slice(0, wide.indexOf("\n}\n"))).toContain(".lp6 #pricing .rail > .lead{position:sticky;top:calc(var(--hh) + 40px)}");
  });
});

describe("fix 1 · a professional way to ask, beside the price button", () => {
  it("a quiet text link (not a second button) that opens a mail to the contact address with the page's own subject; the address stands beside it as text (da + en)", () => {
    for (const [lang, d, q, linkText] of [["da", da, "Spørgsmål, før du starter? Skriv til os", "Skriv til os"], ["en", en, "Questions before you start? Write to us", "Write to us"]]) {
      const { $, $$ } = show(lang);
      const cta = $("#pcta");
      expect([lang, [...cta.children].map((c) => c.className)]).toEqual([lang, ["btn btn-lg", "ask"]]);
      expect($$("#pcta .btn")).toHaveLength(1);
      const a = $("#pcta .ask a");
      expect([lang, a.className, norm(a.textContent)]).toEqual([lang, "tlink", linkText]);
      expect([lang, a.getAttribute("href")]).toEqual([lang, `mailto:${CONTACT_EMAIL}?subject=${encodeURIComponent(d["landingV6.ask.subject"])}`]);
      expect(a.getAttribute("href")).toBe(site.askHref(d["landingV6.ask.subject"]));
      expect(decodeURIComponent(a.getAttribute("href").split("?subject=")[1])).toBe(lang === "da" ? "Spørgsmål om BonBox" : "Question about BonBox");
      // the address as selectable text (a mailto can fail silently), not inside the link
      const at = $("#pcta .ask .ask-at");
      expect([lang, at.tagName, at.textContent, at.closest("a")]).toEqual([lang, "SPAN", CONTACT_EMAIL, null]);
      expect(norm($("#pcta .ask").textContent)).toBe(`${q} ${CONTACT_EMAIL}`);
      cleanup();
    }
    expect(CSS).toMatch(/\.lp6 \.ask-at\{[^}]*user-select:all/);
    expect(CSS).not.toMatch(/\.lp6 \.ask-at\{[^}]*user-select:none/);
  });
});

describe("fix 1 · who is behind it: the company, a button, and no promise the owner did not make", () => {
  const blocks = ($$) => $$(".human");

  // polish pass (10 Nov): the one-column copy (#bag, under the prices) ends with the address link; only the copy beside the
  // questions (shown from 1200 px) ends with the main button and the trial line
  it("the founder's text is as it was; then the company with the CVR linked to the public register and the address; beside the questions the main button and the trial line follow (da + en)", () => {
    for (const [lang, d, company] of [["da", da, "BonBox drives af Orvexlo (CVR 46417321), København."], ["en", en, "BonBox is run by Orvexlo (CVR 46417321), Copenhagen."]]) {
      const { $$ } = show(lang);
      expect(blocks($$)).toHaveLength(2);
      expect(blocks($$).map((b) => !!b.closest("#bag"))).toEqual([true, false]);
      for (const b of blocks($$)) {
        const up = !!b.closest("#bag");
        expect([lang, up, [...b.children].map((c) => c.className)]).toEqual([lang, up, up ? ["label", "hm-1", "hm-2", "hm-c", "hm-m"] : ["label", "hm-1", "hm-2", "hm-c", "hm-m", "hm-go"]]);
        expect([lang, norm(b.querySelector(".label").textContent), norm(b.querySelector(".hm-1").textContent), norm(b.querySelector(".hm-2").textContent)]).toEqual([lang, d["landingV6.founder.label"], d["landingV6.founder.name"], d["landingV6.founder.reply"]]);
        expect([lang, norm(b.querySelector(".hm-c").textContent)]).toEqual([lang, company]);
        const cvr = b.querySelector(".hm-c a");
        expect([cvr.getAttribute("href"), cvr.getAttribute("target"), cvr.getAttribute("rel"), norm(cvr.textContent)]).toEqual(["https://datacvr.virk.dk/enhed/virksomhed/46417321", "_blank", "noopener noreferrer", LEGAL_LINES[1]]);
        expect(cvr.getAttribute("href")).toBe(site.CVR_REGISTER);
        expect(b.querySelector(".hm-m a").getAttribute("href")).toBe(`mailto:${CONTACT_EMAIL}`);
        const go = b.querySelector(".hm-go");
        if (up) {
          // under the prices: no second "Prøv gratis", no trial line; the block ends with the address link
          expect([lang, go, b.querySelectorAll('a[href="/register"], .btn, .hm-t').length]).toEqual([lang, null, 0]);
          expect(b.lastElementChild).toBe(b.querySelector(".hm-m"));
          expect([lang, norm(b.textContent)]).toEqual([lang, expect.not.stringContaining(norm(d["landingV6.trialEnd"]))]);
        } else {
          expect([...go.children].map((c) => [c.tagName, c.className, c.getAttribute("href"), norm(c.textContent)])).toEqual([["A", "btn btn-lg", "/register", d["landingV6.cta"]], ["SPAN", "hm-t", null, norm(d["landingV6.trialEnd"])]]);
          expect(b.lastElementChild).toBe(go);
        }
      }
      cleanup();
    }
    // the founder's words are the 3 Nov ones, untouched
    expect([da["landingV6.founder.name"], da["landingV6.founder.reply"]]).toEqual(["Jeg hedder Manoj.", "Du taler med den, der bygger BonBox. Det er kun mig indtil videre, så når du skriver, får du fat i mig."]);
    // the register's number is the footer's (site.js LEGAL_LINES), and the link is the one /contact gives
    expect(site.CVR_REGISTER.endsWith(`/${LEGAL_LINES[1].replace(/\D/g, "")}`)).toBe(true);
  });

  it("no photo, no surname, no set-up promise, no call-back and no reply time anywhere on the page (the owner, 10 Nov)", () => {
    for (const [lang] of PAGES) {
      const { root, $$ } = show(lang);
      expect($$(".human img, .human picture, .human svg")).toEqual([]);
      const all = norm(root.textContent);
      expect([lang, all]).toEqual([lang, expect.not.stringMatching(/Chaudhary|Manoj Kumar/i)]);
      expect([lang, all]).toEqual([lang, expect.not.stringMatching(/hjælper dig i gang|sætter (det|din|dit) [^.]{0,40}op sammen|finder vi en tid|ringer (dig|tilbage)|help you get started|set (it|your) [^.]{0,40}up together|call you back|call-back|svar inden for|inden for \d+ (time|dag)|within \d+ (hour|day)|reply within|samme dag|same day/i)]);
      cleanup();
    }
  });

  it("one-column page: the block is its own section directly under the prices; from 1200 px that section steps aside and the copy beside the questions shows", () => {
    const { root, $ } = show("da");
    const sections = [...root.querySelectorAll("#sheet > section")].map((s) => s.id);
    expect(sections).toEqual(["mere", "pricing", "bag", "tryghed", "faq"]);
    const bag = $("#bag");
    expect([bag.className, bag.getAttribute("aria-labelledby"), $("#bag-h").tagName, norm($("#bag-h").textContent)]).toEqual(["sec wrap bag", "bag-h", "H2", "Hvem står bag"]);
    expect(bag.querySelectorAll(".human")).toHaveLength(1);
    expect($("#faq .human .label").tagName).toBe("H3");
    expect($("#faq .human [id]")).toBeNull(); // the ids are the upper copy's: no duplicate id
    expect(CSS).toContain("@media (max-width:1199px){.lp6 #faq .human{display:none}}");
    expect(CSS).toContain("@media (min-width:1200px){.lp6 .bag{display:none}}");
    // the desktop placement beside the questions is the rule it was
    expect(CSS).toContain(".lp6 #faq .rail > .human{grid-column:1;grid-row:2;margin-top:20px}");
  });

  // polish pass (10 Nov): the block under the prices has no button of its own any more (three identical "Prøv gratis" on one phone
  // screen), so the bottom bar steps aside for the price button and the footer only, as before fix round 2, and the engine has no
  // path left for a button that is not there
  it("the block under the prices has no button for the bottom bar to step aside for (it steps aside over the price button only), and a language switch keeps the reader's place in the block", () => {
    const { $, root } = show("da");
    expect([root.querySelector("#bcta"), $("#bag .hm-go"), $("#bag").querySelectorAll('a[href^="/register"]').length]).toEqual([null, null, 0]);
    const engine = read("components/landing/v6/engine.js");
    expect(engine).toContain('const c = $("hero-cta"), p = $("pcta");');
    expect(engine).not.toMatch(/bcta|G\.b0|G\.b1/);
    expect(engine).toContain("const onB = past && !(G.p0 < y + vh - 64 && G.p1 > y) && y + vh < G.foot + 40;");
    // place.js: with the prices scrolled away and the block on screen, the block is the reader's place
    const box = (top, bottom) => () => ({ top, bottom, left: 0, right: 390, width: 390, height: bottom - top });
    const rects = { mere: box(-2400, -1700), pricing: box(-1700, -80), bag: box(-80, 290), tryghed: box(290, 900), faq: box(900, 1300), foot: box(1300, 1900) };
    for (const id of Object.keys(rects)) root.querySelector(`#${id}`).getBoundingClientRect = rects[id];
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    expect(placeOf(root, "top", "en")).toMatchObject({ anchor: "bag", top: -80 });
    // from 1200 px the section is not laid out (an empty box): it is passed over
    root.querySelector("#pricing").getBoundingClientRect = box(-1700, -10);
    root.querySelector("#bag").getBoundingClientRect = box(0, 0);
    root.querySelector("#tryghed").getBoundingClientRect = box(118, 700);
    expect(placeOf(root, "top", "en")).toMatchObject({ anchor: "tryghed", top: 118 });
  });
});

describe("fix 1 · Tryghed: the two apps on the App Store, by their own names", () => {
  // polish pass (10 Nov, the lead's item 7): the row uses the listings' own titles, which differ by store language
  it("one row, after the staff row: 'Findes i App Store: BonBox og BonBox Vagtplan' / 'On the App Store: BonBox and BonBox Vagtplan', each name its App Store link (da + en)", () => {
    for (const [lang, line, staffApp] of [["da", "Findes i App Store: BonBox og BonBox Vagtplan", "BonBox Vagtplan"], ["en", "On the App Store: BonBox and BonBox Vagtplan", "BonBox Vagtplan"]]) {
      const { $$ } = show(lang);
      const rows = $$(".trust li");
      const row = rows[rows.length - 1];
      expect([lang, norm(row.textContent)]).toEqual([lang, line]);
      expect([...row.querySelectorAll("a")].map((a) => [norm(a.textContent), a.getAttribute("href")])).toEqual([["BonBox", APP_STORE.owner], [staffApp, APP_STORE.scheduler]]);
      // each name stays whole on its line (a <nw> around its link), linked or not, and "og" / "and" goes down with the second name
      expect([...row.querySelectorAll(".nw")].map((n) => norm(n.textContent))).toEqual(["BonBox", `${lang === "da" ? "og" : "and"} ${staffApp}`]);
      cleanup();
    }
  });

  it("the names are the App Store listings' titles (read on the two listings, 10 Nov), not the Home-screen names the two iOS projects carry, and both links are the live apps", () => {
    // the Home-screen names stay "BonBox" and "Vagtplan" (what the app is called once installed; 16.40's "Vagtplan-appen" is that name)
    expect(read("../ios/App/App/Info.plist")).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>BonBox<\/string>/);
    expect(read("../ios-scheduler/App/App/Info.plist")).toMatch(/<key>CFBundleDisplayName<\/key>\s*<string>Vagtplan<\/string>/);
    expect(APP_STORE).toEqual({ scheduler: "https://apps.apple.com/dk/app/bonbox-scheduler/id6787010793", owner: "https://apps.apple.com/dk/app/bonbox-daily-close/id6762066960" });
    expect(da["landingV6.trust.apps"]).toBe("Findes i App Store: <nw><a>BonBox</a></nw> <nw>og <a>BonBox Vagtplan</a></nw>");
    expect(en["landingV6.trust.apps"]).toBe("On the App Store: <nw><a>BonBox</a></nw> <nw>and <a>BonBox Vagtplan</a></nw>"); // "og" / "and" is inside the second name's <nw>: no line ends on it
    // the first name is the owner app, the second the staff app, in both languages (Sheet.jsx links by position)
    expect(read("components/landing/v6/Sheet.jsx")).toContain("const to = [APP_STORE.owner, APP_STORE.scheduler];");
  });

  it("Android: the same row as plain text (no link to a store the visitor cannot use)", () => {
    const { $$ } = show("da", ANDROID);
    const rows = $$(".trust li");
    const row = rows[rows.length - 1];
    expect(norm(row.textContent)).toBe("Findes i App Store: BonBox og BonBox Vagtplan");
    expect(row.querySelectorAll("a")).toHaveLength(0);
    expect($$('a[href*="apps.apple.com"]')).toHaveLength(0);
  });
});
