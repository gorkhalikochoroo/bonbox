/**
 * Landing fix round, 3 Nov 2026 (bonbox-lab-state/landing-audit-2026-11-03/SPEC.md): the Orvexlo rename and the audit fixes.
 *
 *   1. Orvexlo everywhere: the CVR register's text ("Orvexlo", "CVR 46417321") on the landing footer, /terms, /privacy,
 *      /cookies and /contact, in every dictionary and in the code (history comments aside). The footer names the product
 *      once: "BonBox – et produkt fra Orvexlo" / "BonBox – a product of Orvexlo". /privacy prints no owner name until
 *      one is copied from the CVR register's entry (review, 3 Nov). PRIVACY_UPDATED and the Terms' "Sidst opdateret" are the push day; the
 *      Terms version is NOT bumped (a bump re-runs the in-app notice to every owner: a name change is not a material change).
 *   2. Tryghed's data line says what is known first (stored in Frankfurt, a copy sent to be read), then the open point;
 *      receipt photos only, no new claim.
 *   3. Starter's line is about the week, and each part of it is what billing.py gives Starter over Free.
 *   4. The paid cards print their Z-bon photo reads a day; one line under the cards says what every plan has and what starts
 *      at Starter, each part read from billing.py's gates. No invoice counts.
 *   5. One salon question, saying only what the salon booking does.
 *   6. The founder line leads with the benefit, keeps "just me", and makes no reply-time promise.
 *   7. (phone bar: landingV6CssScope.test.js, polish item 2)
 *   8. Accessibility, nothing visible: live counters, a screen-reader time before each story sentence, the flag at .7
 *      (landingV6CssScope.test.js), the three rows as h3 under a hidden h2.
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { LanguageProvider } from "../hooks/useLanguage";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { tr } from "../i18n/tr.js";
import { PLAN_LIMITS } from "../lib/planLimits";
import { LEGAL_LINES } from "../components/landing/v6/site";
import { PRIVACY_UPDATED, TERMS_TEXT_UPDATED, TERMS_VERSION, TERMS_EXISTING_FROM, termsDate } from "../legal/terms";
import TermsPage from "../pages/TermsPage";
import PrivacyPolicyPage from "../pages/PrivacyPolicyPage";
import CookiePolicyPage from "../pages/CookiePolicyPage";

vi.mock("../components/landing/v6/engine", () => ({ mountLanding: () => () => {} }));
const { default: LandingV6Page } = await import("../pages/LandingV6Page");

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const backend = (rel) => fs.readFileSync(path.join(SRC, "../../backend", rel), "utf8");
const norm = (s) => String(s).replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
const stripComments = (s) => s.replace(/\{\/\*[\s\S]*?\*\/\}/g, "").replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
const walk = (dir) => fs.readdirSync(dir).flatMap((n) => {
  const p = path.join(dir, n);
  return fs.statSync(p).isDirectory() ? (n === "__tests__" ? [] : walk(p)) : [p];
});
const OLD = /DukaanAI|Manoz/;

function show(lang) {
  localStorage.setItem("lang", lang);
  const r = render(<MemoryRouter><LanguageProvider><LandingV6Page /></LanguageProvider></MemoryRouter>);
  const root = r.container.querySelector(".lp6");
  return { root, $: (s) => root.querySelector(s), $$: (s) => [...root.querySelectorAll(s)] };
}
function legal(Page, lang) {
  localStorage.setItem("lang", lang);
  return render(<LanguageProvider><MemoryRouter><Page /></MemoryRouter></LanguageProvider>);
}
/** One tier's block of a billing.py dict, as { key: value } (a parser that finds nothing fails). */
function billingBlock(dict, tier) {
  const src = backend("app/services/billing.py");
  const start = src.indexOf(`${dict}: dict[str, dict[str, `);
  expect(start, `${dict} in billing.py`).toBeGreaterThan(-1);
  const m = src.slice(start).match(new RegExp(`^    "${tier}": \\{([\\s\\S]*?)^    \\},`, "m"));
  expect(m, `${dict}["${tier}"]`).toBeTruthy();
  const out = Object.fromEntries([...m[1].replace(/#.*$/gm, "").matchAll(/"([a-z_]+)":\s*(True|False|-?\d+)/g)].map(([, k, v]) => [k, v === "True" ? true : v === "False" ? false : Number(v)]));
  expect(Object.keys(out).length).toBeGreaterThan(10);
  return out;
}

afterEach(() => { cleanup(); localStorage.clear(); });

describe("1 · Orvexlo, as the CVR register has it", () => {
  it("the landing's registry lines are the register's: Orvexlo, CVR 46417321", () => {
    expect(LEGAL_LINES).toEqual(["Orvexlo", "CVR 46417321"]);
  });

  it("the footer names the product once — 'BonBox – et produkt fra Orvexlo' / 'BonBox – a product of Orvexlo' — then the CVR; the copyright line is Orvexlo's (3 Nov: Manoj, BonBox is not a company)", () => {
    for (const [lang, line] of [["da", "BonBox&nbsp;– et produkt fra Orvexlo"], ["en", "BonBox&nbsp;– a product of Orvexlo"]]) {
      const { root, $ } = show(lang);
      const parts = $(".foot .legal p").innerHTML.split("<br>");
      expect([lang, parts[0], parts[1]]).toEqual([lang, line, "CVR 46417321"]);
      // the footer: the product line and the copyright. Fix round 2 (10 Nov; the owner: present the company, no photo, no surname):
      // the founder block names it once more, with the CVR linked to the register (the block is in the markup twice, one shown per layout)
      expect([lang, $(".foot").textContent.split("Orvexlo").length - 1]).toEqual([lang, 2]);
      expect([lang, [...root.querySelectorAll(".human")].map((h) => h.textContent.split("Orvexlo").length - 1)]).toEqual([lang, [1, 1]]);
      expect([lang, root.textContent.split("Orvexlo").length - 1]).toEqual([lang, 4]);
      expect([lang, $(".copy-r").textContent.startsWith("© 2026 Orvexlo · ")]).toEqual([lang, true]);
      expect([lang, OLD.test(root.textContent)]).toEqual([lang, false]);
      cleanup();
    }
  });

  it("no dictionary value names the old company (da, en, tr)", () => {
    for (const [code, d] of [["da", da], ["en", en], ["tr", tr]]) {
      expect([code, Object.entries(d).filter(([, v]) => typeof v === "string" && OLD.test(v)).map(([k]) => k)]).toEqual([code, []]);
    }
    expect(en["landingFooterEntity"]).toBe("a product of Orvexlo");
    expect(da["landingFooterEntity"]).toBe("et produkt fra Orvexlo");
    expect(tr["landingFooterEntity"]).toBe("Orvexlo ürünüdür");
  });

  it("no code under src/ names the old company (comments that tell the history aside)", () => {
    const hits = walk(SRC).filter((p) => /\.(jsx?|mjs|cjs)$/.test(p)).filter((p) => OLD.test(stripComments(fs.readFileSync(p, "utf8"))));
    expect(hits.map((p) => path.relative(SRC, p))).toEqual([]);
    // the printed leave-behind (backend script) carries the new name too
    expect(backend("scripts/fieldwork_leave_behinds.py")).toMatch(/^COMPANY_LINE = "Orvexlo · CVR 46417321 · bonbox\.dk"$/m);
    expect(backend("scripts/fieldwork_leave_behinds.py")).not.toMatch(OLD);
  });

  it("/terms, /privacy and /cookies name Orvexlo, CVR 46417321, in both languages, and never the old name", () => {
    for (const Page of [TermsPage, PrivacyPolicyPage, CookiePolicyPage]) {
      for (const lang of ["da", "en"]) {
        const text = legal(Page, lang).container.textContent;
        expect([Page.name, lang, text.includes("Orvexlo"), text.includes("46417321"), OLD.test(text)]).toEqual([Page.name, lang, true, true, false]);
        cleanup();
      }
    }
  });

  it("/privacy: the registered name is the register's, the CVR links to the register, and no owner name the register does not show", () => {
    // The only register text in the repo (July: the old company name) spells the owner differently from the spec,
    // and nothing here proves either spelling. The controller's identity (GDPR art. 13(1)(a)) is Orvexlo + CVR, with
    // the register one click away. When the owner line comes back, its text is the register entry's, pinned here.
    const cvr = "https://datacvr.virk.dk/enhed/virksomhed/46417321";
    let r = legal(PrivacyPolicyPage, "da");
    let text = r.container.textContent;
    expect(text).toContain("Registreret navn: Orvexlo");
    expect([...r.container.querySelectorAll(`a[href="${cvr}"]`)].map((a) => a.textContent)).toEqual(["46417321"]);
    expect(screen.queryByTestId("privacy-owner")).toBeNull();
    expect(text).not.toMatch(/Ejer:|Owner:|Manoj|Chaudhary/);
    expect(text).toContain("BonBox er et produkt fra Orvexlo, der er registreret i Danmark som Personligt ejet Mindre Virksomhed.");
    cleanup();
    r = legal(PrivacyPolicyPage, "en");
    text = r.container.textContent;
    expect(text).toContain("Registered name: Orvexlo");
    expect([...r.container.querySelectorAll(`a[href="${cvr}"]`)].map((a) => a.textContent)).toEqual(["46417321"]);
    expect(screen.queryByTestId("privacy-owner")).toBeNull();
    expect(text).not.toMatch(/Ejer:|Owner:|Manoj|Chaudhary/);
    expect(text).toContain("BonBox is a product of Orvexlo, registered in Denmark as a Personligt ejet Mindre Virksomhed.");
  });

  it("dates: /privacy and /cookies and the Terms' 'Sidst opdateret' carry the push day (not before the rename); the Terms version is not bumped", () => {
    expect(PRIVACY_UPDATED >= "2026-11-03").toBe(true);
    // The Orvexlo push dated the three pages on one day (3 Nov). Edited on
    // purpose 12 Nov 2026 (DAWA replacement): /privacy then changed ALONE
    // (two vendor rows: Klimadatastyrelsen, OpenStreetMap Foundation), so its
    // date moves to that push day while the Terms text keeps 3 Nov. The rule
    // that stays: the Terms date is never after /privacy's, and never before
    // the rename.
    expect(TERMS_TEXT_UPDATED).toBe("2026-11-03");
    expect(TERMS_TEXT_UPDATED <= PRIVACY_UPDATED).toBe(true);
    // a TERMS_VERSION bump re-runs the "Vi har opdateret vores Handelsbetingelser" notice for every owner until
    // TERMS_EXISTING_FROM, with October's change list: the rename changes the text, not the version
    expect(TERMS_VERSION < TERMS_TEXT_UPDATED).toBe(true);
    expect(TERMS_EXISTING_FROM < TERMS_TEXT_UPDATED).toBe(true); // no notice window is opened by this push
    const m = backend("app/services/terms.py").match(/^TERMS_VERSION = "([0-9-]+)"$/m);
    expect(m && m[1]).toBe(TERMS_VERSION);
    for (const lang of ["da", "en"]) {
      legal(TermsPage, lang);
      expect(screen.getByTestId("terms-updated").textContent).toBe(lang === "da" ? `Sidst opdateret: ${termsDate(TERMS_TEXT_UPDATED, "da")}` : `Last updated: ${termsDate(TERMS_TEXT_UPDATED, "en")}`);
      cleanup();
      legal(PrivacyPolicyPage, lang);
      expect(screen.getByTestId("privacy-updated").textContent).toContain(termsDate(PRIVACY_UPDATED, lang));
      cleanup();
    }
  });
});

describe("2 · Tryghed: what is known first, then the open point (receipt photos only, no new claim)", () => {
  it("the line's order: stored in Frankfurt → a copy goes to the AI provider to be read → where they process it is not yet confirmed → nothing sold, no training", () => {
    for (const [d, steps] of [
      [da, ["Dine bilag gemmes i Frankfurt.", "sender BonBox en kopi til vores AI-leverandør, Anthropic", "Hvor de behandler det, er endnu ikke bekræftet.", "Vi sælger ikke dine data"]],
      [en, ["Your receipt photos are stored in Frankfurt.", "BonBox sends a copy to our AI provider, Anthropic", "Where they process it is not yet confirmed.", "We don't sell your data"]],
    ]) {
      const v = d["landingV6.trust.data"];
      const at = steps.map((s) => v.indexOf(s));
      expect([v, at.every((i) => i >= 0)]).toEqual([v, true]);
      expect([...at].sort((a, b) => a - b)).toEqual(at);
      expect(v.startsWith(steps[0])).toBe(true);
    }
    expect(en["landingV6.trust.data"]).toBe("Your receipt photos are stored in Frankfurt. To read one, BonBox sends a copy to our AI provider, Anthropic, or another provider listed in the privacy policy. Where they process it is not yet confirmed. We don't sell your data and we don't train models on your books.");
    expect(da["landingV6.trust.data"]).toBe("Dine bilag gemmes i Frankfurt. For at aflæse et billede sender BonBox en kopi til vores AI-leverandør, Anthropic, eller en anden udbyder på listen i privatlivspolitikken. Hvor de behandler det, er endnu ikke bekræftet. Vi sælger ikke dine data og træner ikke modeller på dit regnskab.");
  });

  it("the open point covers every reader the line names: no provider is singled out, because /privacy has none of them confirmed", () => {
    // Expense receipts go to Mindee first when its key is set, then Claude, OCR.space and Google Vision
    // (verified-claims C1b). /privacy lists all four with no confirmed place. A sentence naming one of them
    // ("Where Anthropic processes it…") reads as if the others' places were known (review, 3 Nov).
    const privacy = read("pages/PrivacyPolicyPage.jsx");
    for (const reader of ["Anthropic \\(Claude API\\)", "Mindee", "Google Cloud Vision", "OCR\\.space"]) {
      expect([reader, new RegExp(`\\["${reader}", "[^"]*", "Not confirmed"`).test(privacy)]).toEqual([reader, true]);
      expect([reader, new RegExp(`\\["${reader}", "[^"]*", "Ikke bekræftet"`).test(privacy)]).toEqual([reader, true]);
    }
    for (const [d, notYet] of [[da, "endnu ikke bekræftet"], [en, "not yet confirmed"]]) {
      const open = d["landingV6.trust.data"].split(/(?<=\.) /).find((x) => x.includes(notYet));
      expect(open).toBeTruthy();
      expect(open).not.toMatch(/Anthropic|Mindee|Google|OCR|Claude/);
    }
  });

  it("no new claim: no EU endpoint or region for the AI, no retention promise, nothing beyond receipt photos", () => {
    for (const d of [da, en]) {
      const v = d["landingV6.trust.data"];
      expect(v).not.toMatch(/endpoint|region|retention|opbevar|zero|nul |slette|deleted|EU|hosted|hostet|brief|copilot|chat/i);
    }
    // the receipt photo is uploaded to storage before it is read (receipt_ocr.save_receipt_photo_ex → _upload_to_supabase)
    const ocr = backend("app/services/receipt_ocr.py");
    expect(ocr).toMatch(/def save_receipt_photo_ex\(/);
    expect(ocr).toMatch(/def _upload_to_supabase\(/);
  });
});

describe("3 · Starter: the week, and every part of the line is what Starter adds over Free", () => {
  it("the line (da + en)", () => {
    expect(en["landingV6.price.starterPos"]).toBe("For running the whole week: unlimited bookings, the whole team on the rota, and invoices.");
    expect(da["landingV6.price.starterPos"]).toBe("Til at drive hele ugen: ubegrænsede bookinger, hele holdet på vagtplanen og fakturaer.");
    const { $$ } = show("da");
    expect(norm($$(".price")[1].querySelector(".pos").textContent)).toBe(norm(da["landingV6.price.starterPos"]));
  });

  it("unlimited bookings, the team on the rota and invoices are Starter's and not Free's (billing.py)", () => {
    const free = billingBlock("PLAN_CAPS", "free"), starter = billingBlock("PLAN_CAPS", "starter");
    expect([free.reservations_per_month > 0, starter.reservations_per_month]).toEqual([true, -1]);
    expect(starter.staff_members).toBeGreaterThan(free.staff_members);
    expect([free.invoices_per_month, starter.invoices_per_month > 0]).toEqual([0, true]);
    expect(PLAN_LIMITS.starter.reservations_per_month).toBe(-1);
  });
});

describe("4 · the price cards: photo reads a day on every card, and what every plan has", () => {
  it("each paid card prints its Z-bon photo reads a day from PLAN_LIMITS (20 / 100), never 'unlimited', and no invoice count", () => {
    for (const [lang, line] of [["da", (n) => `Z-bon-aflæsning fra foto: ${n} om dagen`], ["en", (n) => `Z-report reading from a photo: ${n} a day`]]) {
      const { $, $$ } = show(lang);
      const lines = $$(".price").map((li) => [...li.querySelectorAll(".inc > span")].map((s) => norm(s.textContent)));
      expect(lines[1]).toContain(line(PLAN_LIMITS.starter.z_report_scans_per_day));
      expect(lines[2]).toContain(line(PLAN_LIMITS.pro.z_report_scans_per_day));
      const pricing = norm($("#pricing").textContent);
      expect(pricing).not.toMatch(/(foto|photo)[^.—]*(ubegrænset|unlimited)/i);
      expect(pricing).not.toMatch(/\d+\s*(fakturaer|invoices)|(fakturaer|invoices)[^.]*\d/i);
      cleanup();
    }
    expect([PLAN_LIMITS.starter.z_report_scans_per_day, PLAN_LIMITS.pro.z_report_scans_per_day]).toEqual([20, 100]);
  });

  it("one line under the cards, before the price note: Hours, Stock and Money on every plan; invoices, bank matching and time registration from Starter", () => {
    expect(en["landingV6.price.allPlans"]).toBe("Hours, Stock and Money come with every plan; invoices, bank matching and time registration start at Starter.");
    expect(da["landingV6.price.allPlans"]).toBe("Timer, Lager og Økonomi er med på alle planer\u00a0– fakturaer, bankafstemning og tidsregistrering fra Starter.");
    for (const [lang, d] of [["da", da], ["en", en]]) {
      const { $, $$ } = show(lang);
      // fix round 2 (10 Nov): the door-tablet line follows it (landingV6ReviewFixesA.test.jsx holds what it rests on)
      expect($$(".pall").map((p) => norm(p.textContent))).toEqual([norm(d["landingV6.price.allPlans"]), norm(d["landingV6.price.standNoLogin"])]);
      const body = $("#pricing .body");
      const order = [...body.children].map((c) => c.className.split(" ")[0]);
      expect(order.indexOf("prices") < order.indexOf("pall") && order.indexOf("pall") < order.indexOf("pnote")).toBe(true);
      // the rows' names are the line's words
      for (const k of ["landingV6.more.hours", "landingV6.more.stock", "landingV6.more.money"]) expect(d["landingV6.price.allPlans"]).toContain(d[k]);
      cleanup();
    }
  });

  it("each part of that line is billing.py's gate: invoices 0 on Free; bank matching and time registration off on Free, on from Starter; the Hours core is not gated", () => {
    const capsFree = billingBlock("PLAN_CAPS", "free"), capsStarter = billingBlock("PLAN_CAPS", "starter");
    const free = billingBlock("PLAN_FEATURES", "free"), starter = billingBlock("PLAN_FEATURES", "starter"), pro = billingBlock("PLAN_FEATURES", "pro");
    expect([capsFree.invoices_per_month, capsStarter.invoices_per_month > 0]).toEqual([0, true]);
    for (const f of ["bank_auto_reconcile", "time_registration"]) expect([f, free[f], starter[f], pro[f]]).toEqual([f, false, true, true]);
    // the time register's endpoints check the gate; clock-in and approving hours do not
    const staff = backend("app/routers/staff.py");
    expect(staff).toMatch(/def _require_time_registration\(user: User\):\s*\n[^\n]*\n\s*if not has_feature\(user, "time_registration"\)/);
    const approve = staff.slice(staff.indexOf('@router.post("/hours/approve")'), staff.indexOf('@router.post("/hours/approve")') + 3000);
    expect(approve.length).toBeGreaterThan(100);
    expect(approve.split("\n@router")[0]).not.toMatch(/_require_time_registration|enforce_feature|has_feature/);
    const portal = backend("app/routers/staff_portal.py");
    const clockIn = portal.slice(portal.indexOf("def portal_clock_in("));
    expect(clockIn.split("\n@router")[0]).not.toMatch(/enforce_feature|has_feature/);
    // the stock list is not gated (only the autopilot is)
    const inv = backend("app/routers/inventory.py");
    expect([...inv.matchAll(/has_feature\(user, "([a-z_]+)"\)/g)].map((m) => m[1])).toEqual(["inventory_autopilot"]);
  });
});

describe("5 · one salon question, saying only what the salon booking does", () => {
  it("the question and answer (da + en), the fourth question; 'og saloner' stays in the sub-line", () => {
    expect(en["landingV6.faq.salonQ"]).toBe("Does BonBox work for salons?");
    expect(en["landingV6.faq.salonA"]).toBe("Yes. On your booking page, customers choose a service, a stylist\u00a0– or the first free one\u00a0– and a time. For each stylist you decide whether they can be booked in your opening hours or only on their published shifts in the schedule.");
    expect(da["landingV6.faq.salonQ"]).toBe("Passer BonBox til saloner?");
    expect(da["landingV6.faq.salonA"]).toBe("Ja. På din bookingside vælger kunden en behandling, en behandler\u00a0– eller den første ledige\u00a0– og en tid. For hver behandler bestemmer du, om der kan bookes i dine åbningstider eller kun i behandlerens udgivne vagter i vagtplanen.");
    for (const [lang, d] of [["da", da], ["en", en]]) {
      const { $, $$ } = show(lang);
      const qa = $$("#faq details.qa");
      expect(qa).toHaveLength(4);
      expect([norm(qa[3].querySelector("summary").textContent), norm(qa[3].querySelector("p").textContent)]).toEqual([d["landingV6.faq.salonQ"], norm(d["landingV6.faq.salonA"])]); // norm: the answer's dashes carry a no-break space before them (polish pass, 10 Nov); its exact text is pinned above
      expect(norm($(".sub").textContent)).toMatch(lang === "da" ? /og saloner\.$/ : /and salons\.$/);
      cleanup();
    }
    for (const d of [da, en]) expect(d["landingV6.faq.salonA"]).not.toMatch(/snart|soon|kommer|coming|plan(lagt|ned)|later|senere|AI/i);
  });

  it("the answer's words are the app's own (EN 'service' / 'stylist', DA 'behandling' / 'behandler') and each part is in the code", () => {
    expect([en.rsvpColBehandling, en.rsvpColBehandler, da.rsvpColBehandling, da.rsvpColBehandler]).toEqual(["Service", "Stylist", "Behandling", "Behandler"]);
    expect(en.rsvpBookValgfriHint).toMatch(/first free stylist/);
    const pub = backend("app/routers/public_reservations.py");
    // a pinned stylist, or none = the first free one
    expect(pub).toMatch(/stylist_id: str \| None = Field\(default=None/);
    expect(pub).toMatch(/Omitting stylist_id = "valgfri behandler"/);
    // the times come from the published shifts, or the opening hours for a stylist set to follow them
    expect(pub).toMatch(/published-shift-driven/);
    expect(backend("app/services/reservation_service.py")).toMatch(/if getattr\(resource, "follows_opening_hours", False\):\s*\n[\s\S]{0,200}_opening_hours_windows\(settings, day\)/);
    expect([en.rsvpStylistModeHours, en.rsvpStylistModeShiftsHint]).toEqual(["Opening hours", "Bookable only on published shifts in the Schedule."]);
    // the guest page offers the treatment and the stylist
    const page = read("pages/ReservationPublicPage.jsx");
    expect(page).toContain('t("rsvpPublicPickBehandling")');
    expect(page).toContain('t("rsvpBookValgfri")');
  });
});

describe("6 · who is behind it: the benefit first, 'just me' kept, no reply-time promise", () => {
  it("the line (da + en)", () => {
    expect(en["landingV6.founder.reply"]).toBe("You talk to the person who builds BonBox. It's just me for now, so when you email, you get me.");
    expect(da["landingV6.founder.reply"]).toBe("Du taler med den, der bygger BonBox. Det er kun mig indtil videre, så når du skriver, får du fat i mig.");
    for (const [d, solo] of [[da, /kun mig indtil videre/], [en, /just me for now/]]) {
      expect(d["landingV6.founder.reply"]).toMatch(solo);
      expect(d["landingV6.founder.reply"]).not.toMatch(/samme dag|same day|som regel|usually|inden for|within|\d/i);
    }
    const { $ } = show("da");
    expect(norm($(".hm-2").textContent)).toBe(da["landingV6.founder.reply"]);
    expect(norm($(".hm-1").textContent)).toBe("Jeg hedder Manoj.");
  });
});

describe("8 · accessibility, nothing visible", () => {
  it("both step counters are polite live regions (a step with Næste / Forrige is announced)", () => {
    const { $ } = show("da");
    for (const id of ["#count", "#dcount"]) expect([id, $(id).getAttribute("aria-live"), $(id).getAttribute("aria-atomic")]).toEqual([id, "polite", "true"]);
  });

  it("each story sentence starts with its time for a screen reader (the clock is aria-hidden; every <time> is in the stacked layout)", () => {
    for (const [lang, d] of [["da", da], ["en", en]]) {
      const { $ } = show(lang);
      expect($("#clock").getAttribute("aria-hidden")).toBe("true");
      for (const [sel, key] of [["#c1 .s1", "s1"], ["#c1 .s2", "s3"], ["#c2 .s1", "s2"], ["#c2 .s2", "s4"], ["#c3 .s1", "s6"]]) {
        const first = $(sel).firstElementChild;
        expect([lang, sel, first && first.className, first && first.textContent]).toEqual([lang, sel, "sr", `${d[`landingV6.time.${key}`]} `]);
        expect($(sel).firstChild).toBe(first); // before the sentence, not after
      }
      expect($("#c3 .s2 .sr")).toBeNull(); // the second half of the 00.10 sentence has no time of its own
      cleanup();
    }
    // .sr is the page's own visually-hidden rule
    expect(read("components/landing/v6/landingV6.css")).toContain(".lp6 .sr{position:absolute!important;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap}");
  });

  it("Timer · Lager · Økonomi: three h3s under the section's hidden h2 (landingV6.more.label), styled as the <b> they were", () => {
    for (const [lang, d] of [["da", da], ["en", en]]) {
      const { $, $$ } = show(lang);
      const sec = $("#mere");
      expect(sec.getAttribute("aria-labelledby")).toBe("mere-h");
      expect(sec.hasAttribute("aria-label")).toBe(false);
      const h2 = $("#mere-h");
      expect([h2.tagName, h2.className, h2.textContent]).toEqual(["H2", "sr", d["landingV6.more.label"]]);
      expect($$("#mere .rows h3").map((h) => h.textContent)).toEqual([d["landingV6.more.hours"], d["landingV6.more.stock"], d["landingV6.more.money"]]);
      expect($$("#mere .rows b")).toHaveLength(0);
      // heading order: the day, then these three, then Priser
      const hs = $$("h2, h3").map((h) => h.id || h.textContent);
      expect(hs.indexOf("mere-h") < hs.indexOf(d["landingV6.more.hours"]) && hs.indexOf(d["landingV6.more.money"]) < hs.indexOf("pricing-h")).toBe(true);
      cleanup();
    }
    const css = read("components/landing/v6/landingV6.css");
    expect(css).toContain(".lp6 .rows h3{font-size:var(--fs-row);line-height:1.3;font-weight:600;letter-spacing:-.01em;color:var(--ink)}");
    expect(css).toContain(".lp6 #mere .rows h3{display:block}");
    expect(css).not.toMatch(/\.rows b\b/);
  });
});

describe("kept as they are", () => {
  it("every demo picture keeps its 'Eksempel · demodata' label (14 in the markup)", () => {
    const { $$ } = show("da");
    const labels = $$("figcaption.demo, .pcap, .room-foot .demo");
    expect(labels).toHaveLength(14);
    expect(labels.every((e) => e.textContent === "Eksempel · demodata")).toBe(true);
  });
});
