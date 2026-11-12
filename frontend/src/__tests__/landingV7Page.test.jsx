/**
 * Landing v7 (12 Nov 2026): Manoj's Claude Design page as the front door (pages/LandingV7Page.jsx).
 *
 * Pins:
 *   - the route: App.jsx loads LandingV7Page on "/" and "/v2"; the page renders its root, headline and sections;
 *   - language: Danish and English from the repo's dictionaries; the menu switches; Portuguese is not offered;
 *   - prices and plan numbers come from lib/planPrices.js and lib/planLimits.js (a changed price shows on the page);
 *     the MOMS line follows PRICE_MOMS_BASIS;
 *   - honesty: every add-on says "Kommer snart" / "Coming soon"; no "rigtige skærme" / real screens, no notification
 *     claim, no payroll file, no "free until" time; no competitor, founder or set-up promise;
 *   - links: real <a href> to /register (plans ?plan=starter|pro), /login, the App Store pages (not on Android),
 *     /contact, /privacy, /terms, /cookies;
 *   - 12 Nov 2026 (approved): the rota line claims no time ("Ugens plan, lagt hurtigt"); the plans line says what starts
 *     at Starter (invoices, bank matching, time registration); the footer carries the CVR line, the contact address and
 *     Kontakt; the 3D rise keeps the screens lit from its first frame;
 *   - pictures: width and height on every one, lazy below the hero, the hero's draft at high priority;
 *   - the stylesheet is scoped to the page's root.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import postcss from "postcss";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { APP_STORE, CONTACT_EMAIL, LEGAL_LINES } from "../components/landing/v6/site";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

// the app's t(): the language on screen, then English, then the key; {var} substitution (hooks/useLanguage.jsx)
const lang = { current: "da", setLang: vi.fn() };
const makeT = (code) => (key, vars) => {
  const dict = code === "da" ? da : en;
  let v = dict[key] || en[key] || key;
  if (vars && typeof v === "string") v = v.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return v;
};
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ lang: lang.current, t: makeT(lang.current), setLang: lang.setLang }),
}));
const platform = { android: false };
vi.mock("../components/landing/v2/platform", () => ({ isAndroidBrowser: () => platform.android }));
vi.mock("../utils/reportClientError", () => ({ reportClientError: () => {} }));

async function page() {
  return (await import("../pages/LandingV7Page")).default;
}
async function show(code = "da", { android = false } = {}) {
  const LandingV7Page = await page();
  lang.current = code; platform.android = android;
  const r = render(<MemoryRouter><LandingV7Page /></MemoryRouter>);
  // the page arms right after its first commit (language list, hero parts) and starts the motion
  await act(() => new Promise((r) => setTimeout(r, 20)));
  const root = r.container.querySelector(".lp7");
  return { ...r, root, $: (s) => root.querySelector(s), $$: (s) => [...root.querySelectorAll(s)], LandingV7Page };
}
afterEach(() => { cleanup(); lang.setLang.mockReset(); vi.doUnmock("../lib/planPrices"); });

describe("the route", () => {
  it("App.jsx loads LandingV7Page for the front door; the v6 page stays in the tree, unrouted", () => {
    const app = read("App.jsx");
    expect(app).toMatch(/const loadLanding = \(\) => import\("\.\/pages\/LandingV7Page"\);/);
    expect(app).not.toMatch(/import\("\.\/pages\/LandingV6Page"\)/);
    expect(fs.existsSync(path.join(SRC, "pages/LandingV6Page.jsx"))).toBe(true);
    expect(app).toContain(`document.querySelector('[data-page="landing"]')`);
  });

  it("renders one root with the headline, the sections and the consent markers", async () => {
    const { root, $, $$ } = await show("da");
    expect(root.getAttribute("data-page")).toBe("landing");
    expect(root.getAttribute("lang")).toBe("da");
    expect(root.hasAttribute("data-bb-consent-skip")).toBe(true);
    expect($("h1").textContent).toBe("Vagterne.Bordene.Kassen.");
    for (const id of ["dag", "vagterne", "bordene", "gaest", "kassen", "tilvalg", "nye", "priser", "faq", "start"]) expect($$(`#${id}`), id).toHaveLength(1);
    expect($(".mbar").hasAttribute("data-bb-consent-clear")).toBe(true);
  });
});

describe("language: Danish and English, no Portuguese", () => {
  it("the menu offers Dansk and English only, and a pick calls the app's setLang", async () => {
    const { $, $$ } = await show("da");
    const btn = $(".lang-btn");
    expect(btn.getAttribute("aria-label")).toBe("Sprog: Dansk");
    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const items = $$('[role="menuitemradio"]');
    expect(items.map((b) => b.getAttribute("lang"))).toEqual(["da", "en"]);
    expect(items.map((b) => b.textContent)).toEqual(["DanskDK", "EnglishENG"]);
    expect(document.body.textContent).not.toMatch(/Português|Portugu/);
    expect($$('[lang="pt"], [lang="pt-PT"]')).toHaveLength(0);
    fireEvent.click(items[1]);
    expect(lang.setLang).toHaveBeenCalledWith("en");
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });

  it("the English page is English throughout; another app language reads the English page", async () => {
    const { root, $ } = await show("en");
    expect(root.getAttribute("lang")).toBe("en");
    expect($("h1").textContent).toBe("Shifts.Tables.Till.");
    expect($(".lang-btn").getAttribute("aria-label")).toBe("Language: English");
    expect(root.textContent).not.toContain("Prøv gratis");
    cleanup();
    const tr = await show("tr");
    expect(tr.root.getAttribute("lang")).toBe("en");
    expect(tr.$("h1").textContent).toBe("Shifts.Tables.Till.");
  });

  it("switching re-renders in place: the same root, the new words", async () => {
    const { root, rerender, LandingV7Page, $ } = await show("da");
    lang.current = "en";
    rerender(<MemoryRouter><LandingV7Page /></MemoryRouter>);
    expect(document.querySelector(".lp7")).toBe(root);
    expect($(".hero .lede").textContent).toBe(en["landingV7.hero.lede"]);
  });

  it("every landingV7 key has real Danish and English (no empty, no English left in Danish)", () => {
    const keys = Object.keys(da).filter((k) => k.startsWith("landingV7."));
    expect(keys.length).toBeGreaterThan(150);
    expect(Object.keys(en).filter((k) => k.startsWith("landingV7.")).sort()).toEqual(keys.sort());
    for (const k of keys) { expect(da[k], k).toBeTruthy(); expect(en[k], k).toBeTruthy(); }
    // the visible sentences differ between the two (names and product words aside)
    const same = keys.filter((k) => da[k] === en[k] && !/^(Starter|Pro|Cookies|Kasserapporter)$/.test(da[k]));
    expect(same).toEqual([]);
  });
});

describe("prices come from lib/planPrices.js and lib/planLimits.js", () => {
  it("a changed price, limit count and founding number show on the page as they are", async () => {
    vi.resetModules();
    vi.doMock("../lib/planPrices", () => ({
      FOUNDING_LIMIT: 77,
      PLAN_PRICES: { starter: { regular: 211, founding: 111 }, pro: { regular: 333, founding: 222 } },
      FROM_PRICE: 111,
    }));
    const { $, root } = await show("da");
    expect($("#lp7-price-h").textContent).toBe("111 kr./md. for de første 77 virksomheder – derefter 211 kr./md.");
    expect($('[data-plan="starter"] .price').textContent).toBe("111 kr./md.");
    expect($('[data-plan="starter"] .after').textContent).toBe("Efter de første 77: 211 kr./md.");
    expect($('[data-plan="pro"] .price').textContent).toBe("222 kr./md.");
    expect($('[data-plan="pro"] .after').textContent).toBe("Efter de første 77: 333 kr./md.");
    expect($(".hero .fine").textContent).toBe("Intet kort · derefter gratisplanen eller fra 111 kr./md.");
    expect($("#start .end p").textContent).toContain("fra 111 kr./md.");
    expect(root.textContent).not.toMatch(/\b(129|199|249|349)\b/);
    vi.resetModules();
  });

  it("the plan lines are planLimits' numbers; no price is typed in the page's code", async () => {
    const { PLAN_LIMITS } = await import("../lib/planLimits");
    const { $ } = await show("da");
    const f = PLAN_LIMITS.free, s = PLAN_LIMITS.starter, p = PLAN_LIMITS.pro;
    const lines = (plan) => [...$(`[data-plan="${plan}"]`).querySelectorAll("li")].map((li) => li.textContent);
    expect(lines("free")).toEqual([
      `${f.team_users} bruger, ${f.branches} sted, op til ${f.staff_members} medarbejdere på vagtplanen`,
      `Reservationer, ${f.reservations_per_month} om måneden`,
      `Z-bon fra et foto: ${f.z_report_scans_per_day} om dagen`,
    ]);
    expect(lines("starter")[0]).toBe(`Dig + ${s.team_users - 1} med rolleadgang, op til ${s.staff_members} medarbejdere`);
    expect(lines("starter")[2]).toBe(`Z-bon fra et foto: ${s.z_report_scans_per_day} om dagen`);
    expect(lines("pro")[0]).toBe(`${p.branches} steder, dig + ${p.team_users - 1}, op til ${p.staff_members} medarbejdere`);
    expect(lines("pro")[2]).toBe(`Z-bon fra et foto: ${p.z_report_scans_per_day} om dagen`);
    for (const f2 of ["components/landing/v7/Sections.jsx", "components/landing/v7/Hero.jsx", "pages/LandingV7Page.jsx"]) {
      expect(read(f2), f2).not.toMatch(/\b(129|199|249|349)\b/);
    }
    for (const k of Object.keys(da).filter((x) => x.startsWith("landingV7."))) {
      expect(da[k], k).not.toMatch(/\b(129|199|249|349)\b/);
      expect(en[k], k).not.toMatch(/\b(129|199|249|349)\b/);
    }
  });

  it("the MOMS sentence is PRICE_MOMS_BASIS's (price note and the lock-in answer)", async () => {
    const { PRICE_MOMS_BASIS } = await import("../components/landing/v2/pricing");
    const want = { excl: "landingV7.price.momsExcl", incl: "landingV7.price.momsIncl", none: "landingV7.price.momsNone" }[PRICE_MOMS_BASIS];
    const { $, $$, root } = await show("da");
    if (want) {
      expect($(".price-note").textContent).toContain(da[want]);
      expect($$("#faq details")[4].querySelector("p").textContent).toContain(da[want]);
    }
    for (const k of ["landingV7.price.momsExcl", "landingV7.price.momsIncl", "landingV7.price.momsNone"].filter((k) => k !== want)) {
      expect(root.textContent).not.toContain(da[k]);
    }
  });
});

describe("the MOMS sentence for every basis", () => {
  it("excl / incl / none give their own sentence; an unknown basis none", async () => {
    const { momsLine } = await import("../components/landing/v7/moms");
    const t = (k) => da[k];
    expect(momsLine(t, "excl")).toBe("Priserne er ekskl. moms.");
    expect(momsLine(t, "incl")).toBe("Priserne er inkl. moms.");
    expect(momsLine(t, "none")).toBe("Der kommer ikke moms oven i prisen.");
    expect(momsLine(t, null)).toBeNull();
  });
});

describe("honesty (the facts Manoj approved, 12 Nov 2026)", () => {
  it("every add-on shows Kommer snart / Coming soon", async () => {
    for (const [code, word] of [["da", "Kommer snart"], ["en", "Coming soon"]]) {
      const { $$ } = await show(code);
      const addons = $$("[data-addon]");
      expect(addons.map((a) => a.getAttribute("data-addon"))).toEqual(["egenkontrol", "drikkepenge", "s1", "s2", "s3", "s4"]);
      for (const a of addons) expect(a.querySelector(".soon")?.textContent, a.getAttribute("data-addon")).toBe(word);
      const names = addons.map((a) => (a.querySelector(".tag") || a.querySelector("h3")).textContent);
      expect(names).toEqual(code === "da"
        ? ["Egenkontrol", "Drikkepenge", "Første uge for nye", "Køkkenskærm", "Allergener pr. ret", "Bordplan med sektioner"]
        : ["Food safety", "Tips", "First week for new starters", "Kitchen screen", "Allergens per dish", "Floor plan with sections"]);
      cleanup();
    }
  });

  const BANNED = [/rigtige skærme/i, /\brigtige\b/i, /real (BonBox )?screens/i, /får besked/i, /fået besked/i, /notified/i, /notification/i,
    /lønfil/i, /payroll file/i, /ledigt til \d/i, /free until/i, /Planday|Dinero|e-conomic|Tabesto|DinnerBooking|Resengo|OpenTable/i,
    /\bManoj\b|grundlægger|founder of/i, /vi sætter (det )?op for dig|we set (it )?up for you/i];
  it("no 'real screens', no notification claim, no payroll file, no free-until time, no rival, founder or set-up promise", async () => {
    for (const code of ["da", "en"]) {
      const { root } = await show(code);
      const text = root.textContent + " " + [...root.querySelectorAll("[aria-label],[alt]")].map((e) => e.getAttribute("aria-label") || e.getAttribute("alt")).join(" ");
      for (const re of BANNED) expect(text, `${code} ${re}`).not.toMatch(re);
      expect(root.textContent).toContain(code === "da" ? "Skærme fra BonBox · eksempeldata" : "Screens from BonBox · demo data");
      expect(root.textContent).toContain(code === "da" ? "personalet ser den i Vagtplan-appen" : "your staff see it in the Vagtplan app");
      expect(root.textContent).toContain(code === "da" ? "eksport af godkendte timer" : "export of approved hours");
      cleanup();
    }
    for (const k of Object.keys(da).filter((x) => x.startsWith("landingV7."))) for (const re of BANNED) {
      expect(da[k], `${k} ${re}`).not.toMatch(re);
      expect(en[k], `${k} ${re}`).not.toMatch(re);
    }
  });

  it("the rota line claims no measured time (12 Nov 2026): 'Ugens plan, lagt hurtigt' / 'The week's rota, set up fast'", async () => {
    expect(da["landingV7.shifts.h"]).toBe("Ugens plan, lagt hurtigt.");
    expect(en["landingV7.shifts.h"]).toBe("The week’s rota, set up fast.");
    const MINUTES = /minut|few minutes|\bminutes?\b/i;
    for (const k of Object.keys(da).filter((x) => x.startsWith("landingV7."))) {
      expect(da[k], k).not.toMatch(MINUTES);
      expect(en[k], k).not.toMatch(MINUTES);
    }
    for (const code of ["da", "en"]) {
      const { root, $ } = await show(code);
      expect($("#lp7-shifts-h").textContent).toBe(code === "da" ? "Ugens plan, lagt hurtigt." : "The week’s rota, set up fast.");
      const alts = [...root.querySelectorAll("[alt],[aria-label]")].map((e) => e.getAttribute("alt") || e.getAttribute("aria-label")).join(" ");
      expect(root.textContent + " " + alts).not.toMatch(MINUTES);
      cleanup();
    }
    // the shared head (description, og and share-card alt) makes no time claim either
    expect(fs.readFileSync(path.join(SRC, "../index.html"), "utf8").replace(/<!--[\s\S]*?-->/g, "")).not.toMatch(/par minutter|few minutes/i);
  });

  it("the plans line says what starts at Starter (invoices, bank matching, time registration); the Free plan sells no staff app or punch clock", async () => {
    expect(da["landingV7.price.allPlans"]).toBe("Timer, Lager og Økonomi er med på alle planer – fakturaer, bankafstemning og tidsregistrering fra Starter.");
    expect(en["landingV7.price.allPlans"]).toBe("Hours, Stock and Finance are included on every plan; invoices, bank matching and time registration start at Starter.");
    // backend/app/services/billing.py, the Free plan: no invoices, no bank auto-match, no time registration, no staff link
    const billing = fs.readFileSync(path.join(SRC, "../../backend/app/services/billing.py"), "utf8");
    const free = billing.slice(billing.indexOf('"staff_portal_link": False'), billing.indexOf('"starter": {', billing.indexOf('"staff_portal_link": False')));
    expect(free).toContain('"time_registration": False');
    expect(billing).toMatch(/"invoices_per_month": 0,/);
    for (const code of ["da", "en"]) {
      const { $ } = await show(code);
      expect($(".price-note").textContent).toContain(code === "da" ? da["landingV7.price.allPlans"] : en["landingV7.price.allPlans"]);
      const freeCard = $('[data-plan="free"]').textContent;
      expect(freeCard).not.toMatch(/stempl|tidsregistrering|Vagtplan-app|faktura|bankafstemning|punch|clock|time registration|staff app|Vagtplan app|invoice|bank/i);
      cleanup();
    }
    for (const k of ["landingV7.price.freeFor", "landingV7.price.free1", "landingV7.price.free2", "landingV7.price.scans", "landingV7.price.freeBtn",
      "landingV7.hero.fine", "landingV7.end.p"]) {
      for (const d of [da, en]) expect(d[k], k).not.toMatch(/stempl|tidsregistrering|Vagtplan-app|punch|clock|time registration|staff app|Vagtplan app/i);
    }
  });

  it("the footer names who sells it: the company, its CVR line from LEGAL_LINES, the contact address and Kontakt (e-handelsloven § 7)", async () => {
    expect(LEGAL_LINES[1]).toMatch(/^CVR \d{8}$/);
    for (const code of ["da", "en"]) {
      const { $ } = await show(code);
      const foot = $("footer.foot");
      expect(foot.textContent).toContain(code === "da" ? `BonBox er et produkt fra ${LEGAL_LINES[0]}` : `BonBox is a product by ${LEGAL_LINES[0]}`);
      expect(foot.textContent).toContain(`${LEGAL_LINES[1]} · ${CONTACT_EMAIL}`);
      expect(foot.querySelector(`a[href="mailto:${CONTACT_EMAIL}"]`).textContent).toBe(CONTACT_EMAIL);
      const contact = [...foot.querySelectorAll("nav a")].find((a) => a.getAttribute("href") === "/contact");
      expect(contact.textContent).toBe(code === "da" ? "Kontakt" : "Contact");
      expect([...foot.querySelectorAll("nav a")].map((a) => a.getAttribute("href"))).toEqual(["/contact", "/privacy", "/terms", "/cookies"]);
      cleanup();
    }
    // read from the constants, never retyped in the page's code
    const sections = read("components/landing/v7/Sections.jsx");
    expect(sections).not.toMatch(/46417321|contact@bonbox\.dk/);
    expect(sections).toContain("LEGAL_LINES.slice(1)");
    expect(sections).toContain("mailto:${CONTACT_EMAIL}");
  });

  it("the walk-in line says what the host stand does; 'sidste bord' is the booking page's own label", async () => {
    expect(da["landingV7.day.r5s"]).toBe("Værtspulten viser et ledigt bord, der passer til to. Ét tryk, så sidder de.");
    expect(da["landingV7.guest.b"]).toContain(`“${da.rsvpSlotLastTable.toLowerCase()}”`);
    expect(en["landingV7.guest.b"]).toContain(`“${en.rsvpSlotLastTable.toLowerCase()}”`);
    expect(read("utils/slotNote.js")).toContain('t("rsvpSlotLastTable"');
  });
});

describe("links are real links", () => {
  const hrefs = (root, text) => [...root.querySelectorAll("a")].filter((a) => a.textContent.trim() === text).map((a) => a.getAttribute("href"));
  it("Prøv gratis, the plans, Log ind, the apps and the legal pages", async () => {
    const { root, $ } = await show("da");
    expect(hrefs(root, "Prøv gratis")).toEqual(["/register", "/register"]); // top bar, last call
    expect(hrefs(root, "Prøv gratis i 14 dage")).toEqual(["/register", "/register"]); // hero, phone bar
    expect(hrefs(root, "Start gratis")).toEqual(["/register"]);
    expect(hrefs(root, "Vælg Starter")).toEqual(["/register?plan=starter"]);
    expect(hrefs(root, "Vælg Pro")).toEqual(["/register?plan=pro"]);
    expect(hrefs(root, "Log ind")).toEqual(["/login"]);
    expect(hrefs(root, "Åbn i browseren")).toEqual(["/login"]);
    expect(hrefs(root, "BonBox i App Store")).toEqual([APP_STORE.owner]);
    expect(hrefs(root, "Vagtplan i App Store")).toEqual([APP_STORE.scheduler]);
    expect(hrefs(root, "Privatliv")).toEqual(["/privacy"]);
    expect(hrefs(root, "Vilkår")).toEqual(["/terms"]);
    expect(hrefs(root, "Cookies")).toEqual(["/cookies"]);
    expect(hrefs(root, "Kontakt")).toEqual(["/contact"]);
    expect(hrefs(root, CONTACT_EMAIL)).toEqual([`mailto:${CONTACT_EMAIL}`]);
    expect(hrefs(root, "Se en dag i restauranten")).toEqual(["#dag"]);
    expect($(".brand").getAttribute("href")).toBe("#top");
    // no dead link: every in-page link has its target, no "#" alone
    for (const a of root.querySelectorAll('a[href^="#"]')) {
      const id = a.getAttribute("href").slice(1);
      expect(id, a.textContent).not.toBe("");
      expect(root.querySelector(`[id="${id}"]`), a.getAttribute("href")).not.toBeNull();
    }
  });

  it("on Android the App Store buttons are not shown; the browser link stays", async () => {
    const { root } = await show("da", { android: true });
    expect(root.querySelectorAll('a[href*="apps.apple.com"]')).toHaveLength(0);
    expect(hrefs(root, "Åbn i browseren")).toEqual(["/login"]);
  });
});

describe("an address that names a section", () => {
  it("opens the page on that section; any other fragment is ignored", async () => {
    const { arrivalOf } = await import("../components/landing/v7/assets");
    expect(arrivalOf("#priser")).toBe("priser");
    expect(arrivalOf("#faq")).toBe("faq");
    for (const h of ["", "#", "#s1", "#pricing", "#<img src=x>", "#priser x", "#__proto__", "#constructor"]) expect(arrivalOf(h), h).toBeNull();
    const seen = [];
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function () { seen.push(this.id); };
    window.history.replaceState({}, "", "/#priser");
    try { await show("da"); } finally { Element.prototype.scrollIntoView = orig; window.history.replaceState({}, "", "/"); }
    expect(seen).toEqual(["priser"]);
  });
});

describe("pictures", () => {
  it("every picture has width and height; lazy below the hero; the hero's draft first, at high priority", async () => {
    const { $$, $ } = await show("da");
    const imgs = $$("img");
    expect(imgs.length).toBe(12); // hero: draft, published week, staff phone; two phones; tables; three guests; till; two add-ons
    for (const i of imgs) {
      expect(+i.getAttribute("width"), i.src).toBeGreaterThan(0);
      expect(+i.getAttribute("height"), i.src).toBeGreaterThan(0);
      expect(i.getAttribute("src")).toMatch(/^\/static\/landing-v7\/[a-z-]+\.webp$/);
      expect(fs.existsSync(path.join(SRC, "../public", i.getAttribute("src"))), i.getAttribute("src")).toBe(true);
      for (const part of (i.getAttribute("srcset") || "").split(",").map((x) => x.trim().split(" ")[0]).filter(Boolean)) {
        expect(fs.existsSync(path.join(SRC, "../public", part)), part).toBe(true);
      }
    }
    const hero = $(".stage .ipad img");
    expect(hero.getAttribute("fetchpriority")).toBe("high");
    expect(hero.getAttribute("loading")).toBeNull();
    for (const i of $$("main > section:not(.hero) img")) expect(i.getAttribute("loading"), i.src).toBe("lazy");
  });

  it("the published week no longer says the staff were notified (the picture's own line was changed)", () => {
    const fixed = fs.readFileSync(path.join(SRC, "../public/static/landing-v7/sched-pub.webp"));
    const original = 78262; // the design's file
    expect(fixed.length).not.toBe(original);
    expect(read("components/landing/v7/assets.js")).toContain("Personalet ser den i Vagtplan-appen");
    // the tips screen (coming soon) without a payroll file or a named payroll system
    expect(fs.readFileSync(path.join(SRC, "../public/static/landing-v7/tips.webp")).length).not.toBe(70750);
    expect(read("components/landing/v7/assets.js")).toContain('"Hent lønfil (CSV)" reads "Eksportér (CSV)"');
  });
});

describe("the stylesheet", () => {
  const css = read("components/landing/v7/landingV7.css");
  it("every rule is scoped to the page's root (.lp7) or the document while the page is on it", () => {
    const bad = [];
    postcss.parse(css).walkRules((r) => {
      for (let p = r.parent; p; p = p.parent) if (p.type === "atrule" && /keyframes$/i.test(p.name)) return;
      for (const s of r.selectors) if (!/^(\.lp7\b|html:has\(\.lp7\))/.test(s.trim())) bad.push(s);
    });
    expect(bad).toEqual([]);
    expect(css).not.toMatch(/@import|@font-face/);
    expect(css).not.toMatch(/fonts\.googleapis|Geist/);
  });

  it("the 3D rise stays, the screens are lit from its first frame; reduced motion as before", () => {
    // the rise: wide fine-pointer screens only, never with reduced motion
    expect(css).toContain(".lp7 .stage.enter{animation:lp7-rise3d 1.7s");
    expect(css).toMatch(/@keyframes lp7-rise3d\{from\{transform:rotateX\(26deg\) rotateY\(-9deg\) translateY\(70px\) scale\(\.93\)\}/);
    expect(css).toContain("@media (prefers-reduced-motion:reduce){.lp7 *,.lp7 *::before,.lp7 *::after{animation:none!important;transition:none!important}");
    // no rule turns a screen (or what is in it) off while the stage rises (12 Nov 2026: that held the largest paint ~2.4 s)
    const off = [];
    postcss.parse(css).walkRules((r) => {
      if (!r.selectors.some((s) => /\.enter\b/.test(s))) return;
      r.walkDecls((d) => { if (/^(opacity|visibility|display)$/.test(d.prop)) off.push(`${r.selector}{${d.prop}:${d.value}}`); });
    });
    expect(off).toEqual([]);
    // the published week rests nearly invisible but drawn (not 0), so the demo's fade-in adds no late "largest paint"
    expect(css).toContain(".lp7 .scr .over{position:absolute;inset:0;opacity:.002;transition:opacity .9s ease}");
    expect(css).toContain(".lp7 .scr .over.on{opacity:1}");
  });

  it("the type is Sora (headings, numbers) and DM Sans (body), self-hosted", () => {
    expect(css).toMatch(/--f-head:"Sora"/);
    expect(css).toMatch(/--f-text:"DM Sans"/);
    const styles = read("components/landing/v7/styles.js");
    for (const f of ["@fontsource/sora/latin-400.css", "@fontsource/sora/latin-600.css", "@fontsource/dm-sans/latin-400.css", "@fontsource/dm-sans/latin-500.css", "@fontsource/dm-sans/latin-600.css"]) expect(styles).toContain(f);
  });
});
