/**
 * LANDING V6 — the page's markup (port step 5/6: PORT_PLAN 1.2, 1.3, 2.1–2.3, section 3 items 2, 3, 5, 6, 7, 9, 17, 18).
 *
 * LandingV6Page renders the v6.3 prototype's DOM as static JSX in the visitor's language and mounts the engine on it.
 * These tests render the real components with the real da.js / en.js values (useLanguage mocked to them) and pin:
 *   - every element the engine reads, once, inside the root, in its first state (engine.js's hand-over list);
 *   - the Danish text is the prototype's, numbers from planPrices / planLimits (never typed);
 *   - CTAs are router links, prices at #pricing, no absolute bonbox.dk link; Android gets the web app, not the store;
 *   - the English page, and a Turkish reader getting the English page whole (no mix);
 *   - DK · EN with drawn flags from the catalog; a pick stores the language;
 *   - the engine: mounted once on the root, destroyed on unmount, re-mounted on a language re-key; a re-render with a
 *     new dictionary function writes nothing to the DOM; the real engine mounts on this markup without an error and
 *     its destroy() puts the DOM back exactly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, cleanup, fireEvent, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { ALL_LANGUAGES } from "../i18n/languageCatalog";
import { PLAN_PRICES, FOUNDING_LIMIT } from "../lib/planPrices";

const NB = " ";

// the app's t(): the language on screen, then English, then the key; {var} substitution (hooks/useLanguage.jsx)
const lang = { current: "da", setLang: vi.fn() };
const makeT = (code) => (key, vars) => {
  const dict = code === "da" ? da : code === "en" ? en : {};
  let v = dict[key] || en[key] || key;
  if (vars && typeof v === "string") v = v.replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
  return v;
};
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ lang: lang.current, t: lang.t || makeT(lang.current), setLang: lang.setLang }),
}));
const engine = { mount: vi.fn(), destroy: vi.fn() };
vi.mock("../components/landing/v6/engine", () => ({
  mountLanding: (root, opts) => { engine.mount(root, opts); return engine.destroy; },
}));
const platform = { android: false };
vi.mock("../components/landing/v2/platform", () => ({ isAndroidBrowser: () => platform.android }));
const beacon = vi.fn();
vi.mock("../utils/reportClientError", () => ({ reportClientError: (o) => beacon(o) }));

const { default: LandingV6Page } = await import("../pages/LandingV6Page");

function show(code = "da", { android = false } = {}) {
  lang.current = code; lang.t = null; platform.android = android;
  const r = render(<MemoryRouter><LandingV6Page /></MemoryRouter>);
  const root = r.container.querySelector(".lp6");
  return { ...r, root, $: (s) => root.querySelector(s), $$: (s) => [...root.querySelectorAll(s)], text: (s) => root.querySelector(s)?.textContent };
}

beforeEach(() => { engine.mount.mockClear(); engine.destroy.mockClear(); lang.setLang.mockClear(); });
afterEach(cleanup);

describe("the root and what the engine reads (engine.js hand-over, step 4)", () => {
  it("one .lp6 root: data-page=landing, lang, no class but lp6, consent-skip marker", () => {
    const { root } = show("da");
    expect(root.className).toBe("lp6");
    expect(root.getAttribute("data-page")).toBe("landing");
    expect(root.getAttribute("lang")).toBe("da");
    expect(root.hasAttribute("data-bb-consent-skip")).toBe(true);
  });

  it("every id the engine queries exists exactly once inside the root", () => {
    const { root } = show("da");
    const ids = "night top-bar hero hero-cta track frame aften-h date ix clock scene plate zbline c1 c2 c3 roster uge booking bookw vagt vapp nb room roombox v2l roomfoot tal stand standw foto fotow zb kasse snav snev count prog prev next snend eprev dock dprev dnext dcount dprog sheet pcta foot probe".split(" ");
    for (const id of ids) expect([id, root.querySelectorAll(`#${id}`).length]).toEqual([id, 1]);
    for (const id of ["t-v1", "t-v2"]) expect(root.querySelector(`#${id}`)).not.toBeNull();
    const all = [...root.querySelectorAll("[id]")].map((e) => e.id);
    expect(all.length).toBe(new Set(all).size); // no duplicate id in the page
  });

  it("the classes and attributes it reads, in their first state", () => {
    const { $, $$, text } = show("da");
    expect($$(".room-svg")).toHaveLength(1);
    expect($(".door .leaf")).not.toBeNull();
    expect($$(".ix a[data-c] .w")).toHaveLength(3);
    expect($$(".clock .dg").map((d) => [...d.querySelectorAll("b")].map((b) => b.textContent))).toEqual([["1", ""], ["0", ""], ["0", ""], ["0", ""]]);
    expect($$(".copy.sc .line")).toHaveLength(3);
    expect($$(".copy.sc .aside[data-b]").map((a) => a.getAttribute("data-b"))).toEqual(["h 1a 1b A", "2a A2 S0", "S", "B2", "2b C", "3a", "3b end"]);
    expect($$("[data-go]").map((a) => a.getAttribute("data-go"))).toEqual(["1a", "2a", "3a", "1a", "2a", "3a"]);
    expect($$("dd[data-v]").map((d) => [d.dataset.v, d.textContent])).toEqual([["640", "640,00"], ["6610", "6.610,00"], ["990", "990,00"], ["8240", "8.240,00"]]);
    expect($(".tot dd").textContent).toBe("8.240,00");
    expect($$(".booking-any")).toHaveLength(2);
    expect($$(".hold")).toHaveLength(3);
    expect($("#frame").getAttribute("data-beat")).toBe("1a");
    expect($("#prev").hidden).toBe(true);
    expect($("#dprev").className).toBe("next prev off");
    expect($("#snend").hasAttribute("inert")).toBe(true);
    expect([text("#count"), text("#dcount")]).toEqual(["1 / 7", "1 / 7"]);
    expect($("#probe").getAttribute("style")).toContain("height: 100svh");
    expect($("#dock").hasAttribute("data-bb-consent-clear")).toBe(true);
    expect($("#roster").classList.contains("on")).toBe(true);
    // the three class renames of the CSS port never appear as their old names in the markup
    expect($$(".glass, .ring, .end")).toHaveLength(0);
  });
});

describe("the Danish page is the prototype's text (v6.3), numbers from one place", () => {
  it("hero, stage statements and asides", () => {
    const { $, $$, text } = show("da");
    expect($$(".h1 a span").map((s) => s.textContent)).toEqual(["Vagterne.", "Bordene.", "Kassen."]);
    expect(text(".sub")).toBe("Bagkontoret til caféer, restauranter, barer og saloner.");
    expect(text(".trial")).toBe(`14 dage gratis · intet kort · derefter gratisplanen eller fra ${PLAN_PRICES.starter.founding} kr./md.`);
    expect($(".trial .nw").textContent).toBe(`derefter gratisplanen eller fra ${PLAN_PRICES.starter.founding} kr./md.`);
    expect(text("#aften-h")).toBe("En dag på Bistro Nørrebro");
    expect(text("#date")).toBe("Tir. 20. okt.");
    expect(text("#c1 .line")).toBe(`Læg ugens vagter, og${NB}udgiv planen. Personalet ser den på telefonen.`);
    expect(text("#c2 .line")).toBe(`Gæsterne booker selv bord eller${NB}tid, uden${NB}konto. Bookingen lander i din reservationsbog.`);
    expect(text("#c3 .line")).toBe("Tag et billede af Z-bonen. BonBox fylder tallene ud og regner MOMS ud. Du tjekker og låser dagen.");
    expect($$("#c2 .aside").map((p) => p.innerHTML)).toEqual([
      'Bookingsiden er ét link: sæt det i din <span class="nw">Instagram-bio</span> og på din <span class="nw">Google-profil.</span>',
      "Gæsten fra kl. 12.30 sidder ved Vindue 2.",
      "Tabletten ved døren viser kun reservationer — aldrig regnskab eller løn.",
      '63 gæster: 61 med booking, <span class="nw">2 som drop-in.</span>',
    ]);
    expect($$(".copy.st time").map((e) => e.textContent)).toEqual(["10.00", "12.30", "16.40", "19.45", "22.50", "00.10"]);
    expect(text(".clock .dot")).toBe(".");
    expect(text(".sn-trial")).toBe(`14 dage gratis · intet${NB}kort`);
    expect(text(".dk-trial")).toBe("14 dage gratis · intet kort");
    expect($$("figcaption.demo, .pcap, .room-foot .demo").every((e) => e.textContent === "Eksempel · demodata")).toBe(true);
    expect($$("figcaption.demo, .pcap, .room-foot .demo")).toHaveLength(14);
    expect($$("img").every((i) => i.getAttribute("alt") && i.getAttribute("loading") === "lazy" && i.getAttribute("width") && i.getAttribute("height"))).toBe(true);
  });

  it("prices: frozen names and lines, every number from planPrices / planLimits", () => {
    const { $, $$ } = show("da");
    const { starter, pro } = PLAN_PRICES;
    expect($("#pricing-h").textContent).toBe(`${starter.founding} kr./md. for de første ${FOUNDING_LIMIT} virksomheder — derefter ${starter.regular}${NB}kr./md.`);
    const cards = $$(".price").map((li) => [li.querySelector(".pn").textContent, li.querySelector(".pp").textContent, li.querySelector(".then").textContent, [...li.querySelectorAll(".inc > span")].map((s) => s.textContent)]);
    expect(cards).toEqual([
      ["", "Gratis", "uden kort", ["1 bruger, 1 afdeling, op til 3 medarbejdere på vagtplanen", "Reservationer, 20 om måneden — bookingside, bordplan, venteliste", `Z-bon-aflæsning fra foto: 3${NB}om${NB}dagen — hver dags kasserapport som PDF uden grænse`]],
      ["Starter", `${starter.founding} kr./md.`, `Efter de første ${FOUNDING_LIMIT}: ${starter.regular}${NB}kr./md.`, ["Dig + 2 teammedlemmer med rollerettigheder, op til 50 medarbejdere på vagtplanen", "Reservationer, ubegrænset"]],
      ["Pro", `${pro.founding} kr./md.`, `Efter de første ${FOUNDING_LIMIT}: ${pro.regular}${NB}kr./md.`, ["3 afdelinger, dig + 4 teammedlemmer, op til 200 medarbejdere på vagtplanen", "Reservationer, ubegrænset"]],
    ]);
    expect($(".pnote").innerHTML.replace(/&nbsp;/g, NB)).toBe(`<b>Opsig når som helst.</b> Ingen binding, intet opstartsgebyr. Priserne er pr.${NB}virksomhed. Du ser det præcise beløb ved betalingen, før du bekræfter. Opsigelsen gælder fra udgangen af den måned, du har betalt for.`);
    expect($$(".pnote")).toHaveLength(1); // no MOMS note while PRICE_MOMS_BASIS is null
  });

  it("Tryghed, Spørgsmål, who is behind it, footer", () => {
    const { $, $$, text } = show("da");
    const trust = $$(".trust li").map((li) => li.textContent);
    expect(trust[0]).toBe("Database i EU (Frankfurt, Tyskland) · underleverandører i privatlivspolitikken");
    expect(trust[1]).toMatch(/Anthropic.*endnu ikke bekræftet.*Vi sælger ikke dine data/);
    expect(trust.slice(2)).toEqual(["Ingen andel af din omsætning", "MedarbejderEgne vagter og timer. Indsender kasserapporten — ser ikke omsætningen."]);
    expect($$(".qa summary").map((s) => s.textContent)).toEqual(["Virker det med min POS?", "Hvad sker der efter de 14 dages prøveperiode?", "Skal personalet have en app?"]);
    expect(text(".hm-1")).toBe("Jeg hedder Manoj.");
    expect($(".hm-m a").getAttribute("href")).toBe("mailto:contact@bonbox.dk");
    expect($(".foot .legal p").innerHTML).toBe('BonBox er et produkt fra<br>DukaanAI v/Manoz Chaudhary<br>CVR 46417321<br><a href="mailto:contact@bonbox.dk">contact@bonbox.dk</a>');
    expect($$(".foot .links li").map((li) => li.textContent)).toEqual(["Handelsbetingelser", "Privatlivspolitik", "Kontakt", "Cookieindstillinger"]);
    expect($(".foot .links button").getAttribute("data-cookie-settings")).toBe("open");
    expect(text(".copy-r")).toBe("© 2026 BonBox · Lavet i København");
  });
});

describe("links: router links in the app, #pricing, the right store", () => {
  it("every CTA is an in-app link to /register or /login; no absolute bonbox.dk link", () => {
    const { $$ } = show("da");
    const hrefs = $$("a").map((a) => a.getAttribute("href"));
    expect(hrefs.filter((h) => /^https?:\/\/(www\.)?bonbox\.dk/.test(h))).toEqual([]);
    expect(hrefs.filter((h) => h === "/register")).toHaveLength(5); // top bar, hero, end of the day, bottom bar, prices
    expect(hrefs.filter((h) => h === "/register?plan=starter" || h === "/register?plan=pro")).toEqual(["/register?plan=starter", "/register?plan=pro"]);
    expect(hrefs.filter((h) => h === "/login")).toHaveLength(1);
    expect(hrefs.filter((h) => h === "#pricing")).toHaveLength(2); // Priser, Se priser
    expect(hrefs.filter((h) => h === "/privacy")).toHaveLength(2); // Tryghed, footer
    expect(hrefs).toEqual(expect.arrayContaining(["/terms", "/contact", "https://www.instagram.com/bonbox.dk/"]));
  });

  it("iPhone / desktop: App Store links to the two live apps", () => {
    const { $$ } = show("da");
    const store = $$('a[href^="https://apps.apple.com/"]').map((a) => [a.getAttribute("href").match(/id\d+$/)[0], a.textContent]);
    expect(store).toEqual([["id6787010793", "Vagtplan i App Store"], ["id6787010793", "Vagtplan i App Store"], ["id6787010793", "Vagtplan i App Store"], ["id6762066960", "BonBox i App Store"]]);
  });

  it("Android: no App Store link; the web app instead (/join for staff, /register for the owner)", () => {
    const { $$ } = show("da", { android: true });
    expect($$('a[href*="apps.apple.com"]')).toHaveLength(0);
    expect($$('a[href="/join"]').map((a) => a.textContent)).toEqual(["Vagtplan i browseren", "Vagtplan i browseren", "Vagtplan i browseren"]);
    expect($$(".foot .apps a")[0].textContent).toBe("BonBox i browseren");
    expect($$(".foot .apps a")[0].getAttribute("href")).toBe("/register");
  });
});

describe("English, and a reader in a language the page does not have", () => {
  it("the English page: English text, the time colon, prices in kr./mo", () => {
    const { root, $, $$, text } = show("en");
    expect(root.getAttribute("lang")).toBe("en");
    expect($$(".h1 a span").map((s) => s.textContent)).toEqual(["Shifts.", "Tables.", "Till."]);
    expect(text(".clock .dot")).toBe(":");
    expect($$(".copy.st time").map((e) => e.textContent)).toEqual(["10:00", "12:30", "16:40", "19:45", "22:50", "00:10"]);
    expect($(".price:nth-child(2) .pp").textContent).toBe(`${PLAN_PRICES.starter.founding} kr./mo`);
    expect(text(".foot .links li:nth-child(1)")).toBe("Handelsbetingelser"); // the legal documents keep their names
    expect(root.textContent).not.toMatch(/Prøv gratis|Eksempel · demodata|Forrige|Næste/);
  });

  it("Turkish: the whole page in English (root lang=en), never a mix", () => {
    const tr = show("tr");
    const trText = tr.root.textContent, trLang = tr.root.getAttribute("lang");
    cleanup();
    const enPage = show("en");
    expect(trLang).toBe("en");
    expect(trText).toBe(enPage.root.textContent);
  });
});

describe("DK · EN with drawn flags", () => {
  it("labels from the catalog, the current language as text, the other a named button; no emoji flag", () => {
    const { $, root } = show("da");
    const cat = Object.fromEntries(ALL_LANGUAGES.map((l) => [l.code, l]));
    expect($(".lang [aria-current]").textContent).toBe(cat.da.short);
    const btn = $(".lang button");
    expect(btn.textContent).toBe(cat.en.short);
    expect(btn.getAttribute("lang")).toBe("en");
    expect(btn.getAttribute("aria-label")).toBe(cat.en.label);
    expect(root.querySelectorAll(".lang svg.flag")).toHaveLength(2);
    expect(root.textContent).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u);
    fireEvent.click(btn);
    expect(lang.setLang).toHaveBeenCalledWith("en");
  });

  it("on the English page the button offers Dansk", () => {
    const { $ } = show("en");
    expect($(".lang [aria-current]").textContent).toBe("EN");
    expect($(".lang button").getAttribute("aria-label")).toBe("Dansk");
    expect($(".lang button").getAttribute("lang")).toBe("da");
  });
});

describe("the engine's lifecycle around React", () => {
  it("mounts once on the root, destroys on unmount", () => {
    const { root, unmount } = show("da");
    expect(engine.mount).toHaveBeenCalledTimes(1);
    expect(engine.mount.mock.calls[0][0]).toBe(root);
    unmount();
    expect(engine.destroy).toHaveBeenCalledTimes(1);
  });

  // port step 7: a mount that fails half-way leaves the static page (engine.js item 13) and is reported, so a broken
  // front door shows up in the super-admin error panel, not only in a visitor's console
  it("hands the engine an onError that logs and beacons the failure (kind render)", () => {
    show("da");
    const opts = engine.mount.mock.calls[0][1];
    expect(typeof opts.onError).toBe("function");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    beacon.mockClear();
    opts.onError(new Error("no #frame"));
    expect(beacon).toHaveBeenCalledWith({ kind: "render", message: "landing engine: no #frame" });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it("a language change re-keys: the old engine is destroyed, a new one mounts on the new root", () => {
    const r = show("da");
    const first = r.root;
    lang.current = "en";
    r.rerender(<MemoryRouter><LandingV6Page /></MemoryRouter>);
    const second = r.container.querySelector(".lp6");
    expect(second).not.toBe(first);
    expect(second.getAttribute("lang")).toBe("en");
    expect(engine.destroy).toHaveBeenCalledTimes(1);
    expect(engine.mount).toHaveBeenCalledTimes(2);
    expect(engine.mount.mock.calls[1][0]).toBe(second);
  });

  it("a re-render with a new dictionary function (the full dictionary arriving) writes nothing to the DOM", async () => {
    const r = show("da");
    // what the engine does to the DOM: classes, styles, text it owns; React must leave all of it alone
    r.root.classList.add("js", "motion", "story");
    r.root.querySelector("#count").textContent = "4 / 7";
    r.root.querySelector("#prev").hidden = false;
    const records = [];
    const mo = new MutationObserver((l) => records.push(...l));
    mo.observe(r.root, { subtree: true, attributes: true, childList: true, characterData: true });
    lang.t = makeT("da"); // a new function identity, the same values
    r.rerender(<MemoryRouter><LandingV6Page /></MemoryRouter>);
    await act(async () => {});
    mo.disconnect();
    expect(records).toEqual([]);
    expect(engine.mount).toHaveBeenCalledTimes(1);
    expect(r.root.className).toBe("lp6 js motion story");
    expect(r.root.querySelector("#count").textContent).toBe("4 / 7");
  });
});

describe("the real engine on this markup (jsdom: no layout, so this proves the wiring, not the maths)", () => {
  it("mounts without an error and destroy() puts the DOM back exactly", async () => {
    const { mountLanding } = await vi.importActual("../components/landing/v6/engine");
    const { root } = show("da");
    const before = root.outerHTML;
    const mq = (q) => { const l = new EventTarget(); l.matches = false; l.media = q; return l; };
    const saved = { matchMedia: window.matchMedia, RO: window.ResizeObserver, IO: window.IntersectionObserver, scrollTo: window.scrollTo };
    class Obs { observe() {} unobserve() {} disconnect() {} }
    window.matchMedia = (q) => mq(q);
    window.ResizeObserver = Obs;
    window.IntersectionObserver = Obs;
    window.scrollTo = () => {};
    Object.defineProperty(window, "innerWidth", { value: 390, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 844, configurable: true });
    const errors = [];
    try {
      const destroy = mountLanding(root, { onError: (e) => errors.push(e) });
      expect(errors).toEqual([]);
      expect(root.classList.contains("story")).toBe(true);
      expect(root.classList.contains("js")).toBe(true);
      destroy();
      expect(root.outerHTML).toBe(before);
      expect(window.__lp6).toBeUndefined();
    } finally {
      Object.assign(window, { matchMedia: saved.matchMedia, ResizeObserver: saved.RO, IntersectionObserver: saved.IO, scrollTo: saved.scrollTo });
    }
  });
});
