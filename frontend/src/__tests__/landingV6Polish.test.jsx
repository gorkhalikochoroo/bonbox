/**
 * LANDING V6 — the polish pass after the reviews (10 Nov 2026). Seven small things the lead still saw as unfinished:
 *
 * 1. The phone's first screen never ends through the first statement's label. At 390 × 664 and five more common Safari sizes the
 *    Danish page showed a sliver of "VAGTPLAN"'s letter tops on the bottom edge. Where the edge would cut the label (or leave less
 *    than 12 px on either side of it) the stage starts that much lower under the hero (guard.js foldPush; engine.js layout()).
 * 2. The end of the prices on the one-column page (under 1200 px): one phone screen showed three identical "Prøv gratis" buttons
 *    and the address twice. There the address under the question link is not shown, and the "who is behind it" block ends with
 *    the company line and the address link. From 1200 px nothing changed.
 * 3. The phone's 7 / 7 (the MOMS card) ends in blank card: the window ended 3 px under a rule of the card's inner panel.
 * 4. The phone's 6 / 7 (the Z-bon): the slip is one step larger where the slot has the room, and "Eksempel · demodata" sits as
 *    close under it as under every other picture, at the page's caption size at any scale.
 * 5. The wide 00.10 photo step was taken again: the app's tab bar no longer cuts a toggle, and there is no notification badge
 *    (landingV6Assets.test.jsx and landingV6ReviewFixesB.test.jsx hold the files and their size).
 * 6. One dash: the Danish tankestreg "–" with a no-break space before it and a space after it, in every landingV6.* string of
 *    da.js and en.js; no "—" anywhere on the page; no line can start with a dash. The Danish price line says MOMS in capitals.
 * 7. The App Store row names the apps by their listings' titles (landingV6ReviewFixesA.test.jsx holds the row).
 *
 * The numbers were measured on the built page in a browser: bonbox-lab-state/landing-review-2026-11-10/fix2/polish/ (NOTES-POLISH.md,
 * measure-polish.json). The engine's own behaviour for 1 and 2 is in landingV6Engine.test.jsx (its last two blocks).
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { render, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import postcss from "postcss";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import * as guard from "../components/landing/v6/guard";
import { CONTACT_EMAIL } from "../components/landing/v6/site";

const HERE = dirname(fileURLToPath(import.meta.url));
const V6 = join(HERE, "..", "components", "landing", "v6");
const css = readFileSync(join(V6, "landingV6.css"), "utf8");
const engine = readFileSync(join(V6, "engine.js"), "utf8");
const NB = String.fromCharCode(160); // the no-break space, spelled out so it cannot be mistaken for a space
const LONG = String.fromCharCode(0x2014); // the long dash the page no longer uses
const DASH = String.fromCharCode(0x2013); // the tankestreg

const lang = { current: "da" };
const android = { current: false };
const fill = (s, vars = {}) => String(s).replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
const makeT = (code) => (key, vars) => fill((code === "da" ? da : en)[key] || en[key] || key, vars && typeof vars === "object" ? vars : {});
vi.mock("../hooks/useLanguage", () => ({ useLanguage: () => ({ lang: lang.current, t: makeT(lang.current), setLang: () => {} }) }));
vi.mock("../components/landing/v6/engine", () => ({ mountLanding: () => () => {} }));
vi.mock("../components/landing/v2/platform", () => ({ isAndroidBrowser: () => android.current }));
vi.mock("../utils/reportClientError", () => ({ reportClientError: () => {} }));
const { default: LandingV6Page } = await import("../pages/LandingV6Page");
const show = (code, onAndroid = false) => { lang.current = code; android.current = onAndroid; return render(<MemoryRouter><LandingV6Page /></MemoryRouter>).container.querySelector(".lp6"); };
afterEach(cleanup);
const norm = (s) => String(s).split(NB).join(" ").replace(/\s+/g, " ").trim();

/* the stylesheet as rules: [media | "", selector, declarations] */
const RULES = (() => {
  const out = [];
  postcss.parse(css).walkRules((r) => {
    const m = r.parent && r.parent.type === "atrule" && r.parent.name === "media" ? r.parent.params : "";
    const d = {}; r.walkDecls((x) => { d[x.prop] = x.value; });
    for (const sel of r.selector.split(/,(?![^(]*\))/)) out.push([m, sel.trim(), d]);
  });
  return out;
})();
const decl = (media, selector) => Object.assign({}, ...RULES.filter(([m, s]) => m === media && s === selector).map(([, , d]) => d));

describe("polish 1 · the phone's first screen never ends through the first statement's label", () => {
  // [first screen's height, the label's top in the page] as measured on the built page at the review's commit (9d636262), Danish
  // and English: fix2/shots-fixup/fold-fixup.json. The label's box is 16 px
  const BEFORE = {
    "da 390×664": [664, 660], "da 390×667": [667, 663], "da 393×659": [659, 655], "da 402×681": [681, 677], "da 390×720": [720, 716], "da 360×700": [700, 696],
    "da 390×844": [844, 911], "da 430×932": [932, 982], "en 390×664": [664, 624], "en 390×667": [667, 627], "en 390×844": [844, 911], "en 430×932": [932, 982],
  };
  const LABEL = 16;
  const clean = (fold, top) => top - fold >= 12 || fold - (top + LABEL) >= 12;

  it("12 px of air is the rule, on either side of the edge", () => {
    expect(guard.FOLD_AIR).toBe(12);
  });

  it("the six Danish sizes whose edge cut the label: each starts the stage 16 px lower, and the label then starts 12 px under the edge", () => {
    for (const key of ["da 390×664", "da 390×667", "da 393×659", "da 402×681", "da 390×720", "da 360×700"]) {
      const [fold, top] = BEFORE[key];
      expect([key, clean(fold, top)]).toEqual([key, false]); // it was cut: 4 px of its box above the edge
      const push = guard.foldPush({ fold, labelTop: top, labelHeight: LABEL });
      expect([key, push, top + push - fold]).toEqual([key, 16, 12]);
    }
  });

  it("the sizes that were already clean do not move: English (the whole label on the screen with 24 px under it), 390 × 844 and 430 × 932 (far under the edge)", () => {
    for (const key of ["en 390×664", "en 390×667", "da 390×844", "da 430×932", "en 390×844", "en 430×932"]) {
      const [fold, top] = BEFORE[key];
      expect([key, clean(fold, top), guard.foldPush({ fold, labelTop: top, labelHeight: LABEL })]).toEqual([key, true, 0]);
    }
  });

  it("wherever the label lands, the result is clean, and nothing moves that did not have to (every px from 80 above the edge to 80 under it)", () => {
    const fold = 664;
    for (let top = fold - 80; top <= fold + 80; top++) {
      const push = guard.foldPush({ fold, labelTop: top, labelHeight: LABEL });
      expect([top, clean(fold, top + push)]).toEqual([top, true]);
      expect([top, push === 0]).toEqual([top, clean(fold, top)]);
      expect([top, push >= 0 && push < LABEL + 24 && Number.isInteger(push)]).toEqual([top, true]);
    }
    // a fraction of a px short of the air is a whole px lower, never a fraction short
    expect(guard.foldPush({ fold, labelTop: 675.4, labelHeight: LABEL })).toBe(1);
    // without measures (no layout) nothing moves
    expect(guard.foldPush({ fold: NaN, labelTop: NaN, labelHeight: NaN })).toBe(0);
    expect(guard.foldPush({ fold: 664, labelTop: NaN, labelHeight: 16 })).toBe(0);
  });

  it("engine.js asks it on the phone only, with the small viewport's height and the label's place in the page, and moves nothing but the hero's own margin", () => {
    expect(engine).toContain('import { clearanceMisses, repairMiss, NOFIX, foldPush } from "./guard.js";');
    expect(engine.match(/foldPush\(/g)).toHaveLength(1);
    const i = engine.indexOf("foldPush({");
    const call = engine.slice(engine.lastIndexOf("if (!wide) {", i), engine.indexOf("\n", engine.indexOf("\n", i) + 1));
    expect(call).toContain('const lab = c1.querySelector(".label")');
    expect(call).toContain("foldPush({ fold: svh, labelTop: docTop(track) + relTop(lab, frameEl), labelHeight: lab.offsetHeight })");
    expect(call).toContain('if (push) hero.style.setProperty("--hero-pull", hp + push);');
    // the only things written there: the hero's pull. No band, slot or picture size (they are set above, from the stage's own height)
    expect(call).not.toMatch(/--slot|--bt|--bc|--bm|place\(|win\(/);
    // the desktop hero (the 3 Nov frame that hugs the card) is the other branch and has no pull
    expect(decl("not all and (min-width:1024px) and (min-aspect-ratio:5/4)", ".lp6.story .hero")).toEqual({ "margin-bottom": "calc(var(--hero-pull,0) * 1px)" });
  });
});

describe("polish 2 · the end of the prices on the one-column page: one button, the address once", () => {
  it.each(["da", "en"])("%s: the block under the prices ends with the company line and the address link: no button, no trial line", (code) => {
    const d = code === "da" ? da : en;
    const root = show(code);
    const up = root.querySelector("#bag .human");
    expect([...up.children].map((c) => c.className)).toEqual(["label", "hm-1", "hm-2", "hm-c", "hm-m"]);
    expect(up.querySelectorAll(".btn, .hm-go, .hm-t, a[href^='/register']")).toHaveLength(0);
    expect(norm(up.textContent)).not.toContain(norm(d["landingV6.trialEnd"]));
    expect(norm(up.textContent)).not.toContain(d["landingV6.cta"]);
    const last = up.lastElementChild.querySelector("a");
    expect([last.getAttribute("href"), last.textContent]).toEqual([`mailto:${CONTACT_EMAIL}`, CONTACT_EMAIL]);
    // no id for a button that is not there, and nothing empty left in its place
    expect(root.querySelector("#bcta")).toBeNull();
    expect([...up.children].every((c) => norm(c.textContent).length > 0)).toBe(true);
  });

  it.each(["da", "en"])("%s: from 1200 px nothing changed: the copy beside the questions ends with the main button and the trial line, the address stands under the question link", (code) => {
    const d = code === "da" ? da : en;
    const root = show(code);
    const side = root.querySelector("#faq .human");
    expect([...side.children].map((c) => c.className)).toEqual(["label", "hm-1", "hm-2", "hm-c", "hm-m", "hm-go"]);
    expect([...side.querySelector(".hm-go").children].map((c) => [c.tagName, c.getAttribute("href"), norm(c.textContent)])).toEqual([["A", "/register", d["landingV6.cta"]], ["SPAN", null, norm(d["landingV6.trialEnd"])]]);
    const at = root.querySelector("#pcta .ask .ask-at");
    expect([at.tagName, at.textContent]).toEqual(["SPAN", CONTACT_EMAIL]);
    // which copy shows where is the stylesheet's, as it was
    expect(decl("(max-width:1199px)", ".lp6 #faq .human")).toEqual({ display: "none" });
    expect(decl("(min-width:1200px)", ".lp6 .bag")).toEqual({ display: "none" });
  });

  it("under 1200 px the address under the question link is not shown; from 1200 px it is, as text that can be selected", () => {
    expect(decl("(max-width:1199px)", ".lp6 .ask-at")).toEqual({ display: "none" });
    expect(decl("", ".lp6 .ask-at")).toMatchObject({ display: "block", "user-select": "all" });
    // no other rule hides or shows it
    expect(RULES.filter(([, s]) => s === ".lp6 .ask-at").map(([m]) => m)).toEqual(["", "(max-width:1199px)"]);
  });

  it.each(["da", "en"])("%s: what a phone shows from the price button to the end of the block: one 'Prøv gratis', the address once (a link); the desktop column: one button each side", (code) => {
    const d = code === "da" ? da : en;
    const root = show(code);
    // the one-column page: #faq .human and .ask-at are display:none (the two rules above)
    const phone = [...root.querySelectorAll("#pcta, #bag")];
    const shown = (el) => !el.closest(".ask-at");
    const buttons = phone.flatMap((s) => [...s.querySelectorAll("a.btn")]).filter(shown).map((a) => [a.getAttribute("href"), norm(a.textContent)]);
    expect(buttons).toEqual([["/register", d["landingV6.cta"]]]);
    const texts = phone.flatMap((s) => { const out = []; const walk = document.createTreeWalker(s, NodeFilter.SHOW_TEXT); while (walk.nextNode()) if (shown(walk.currentNode.parentElement)) out.push(walk.currentNode.nodeValue); return out; }).join(" ");
    expect(texts.split(CONTACT_EMAIL).length - 1).toBe(1);
    expect(phone.flatMap((s) => [...s.querySelectorAll("a[href^='mailto:']")]).map((a) => a.getAttribute("href").split("?")[0])).toEqual([`mailto:${CONTACT_EMAIL}`, `mailto:${CONTACT_EMAIL}`]); // the question link, then the address link
    // from 1200 px (#bag is display:none): the price button with the address as text, and the block beside the questions with its own
    expect([...root.querySelectorAll("#pcta a.btn, #faq .human a.btn")].map((a) => a.getAttribute("href"))).toEqual(["/register", "/register"]);
  });

  it("the engine has no path left for the block's button: the bottom bar steps aside over the price button and the footer only", () => {
    expect(engine).not.toMatch(/bcta|G\.b0|G\.b1/);
    expect(engine).toContain('const c = $("hero-cta"), p = $("pcta");');
    expect(engine).toContain("const onB = past && !(G.p0 < y + vh - 64 && G.p1 > y) && y + vh < G.foot + 40;");
    expect(readFileSync(join(V6, "Sheet.jsx"), "utf8")).not.toMatch(/bcta/);
  });
});

describe("polish 3 · the phone's MOMS card ends in blank card, not on a rule", () => {
  // rows of kasse-moms(.en).webp (1095 × 1511), 0-based, read from the two files' pixels (the same rows in both; a retake must
  // re-read them): the rule over the "Omsætning (uden moms)" row, the row's text, the rule under it
  const ROWS = { ruleAbove: [547, 549], text: [586, 627], ruleBelow: [670, 673], width: 1095 };
  const stop = +engine.match(/KS = \[(\d+), 978, 1511\]/)[1];

  it("the window stops between the row's text and the rule under it: 660 (it was 676, 3 px under that rule)", () => {
    expect(stop).toBe(660);
    expect(engine).toContain("stop = KS[0], cw = Math.min(cw0, ((Hx - TAG) * 1095) / stop);");
    expect(engine).toContain("const wh = (cw * stop) / 1095, full = (cw * 1511) / 1095; place(kasse, (W - cw) / 2, midC(wh + TAG, 2), cw); win(kasse, wh);");
    expect(stop).toBeGreaterThan(ROWS.text[1]);
    expect(stop).toBeLessThan(ROWS.ruleBelow[0]);
  });

  it("no rule and no text in the window's last 8 px, at every size the phone story shows the card (rounding included)", () => {
    // the card's width on screen: 390 px on a 430 px phone, 350 on a 390 px one, 328 on a 360 px one, about 320 where the slot is short
    // (390 × 667), and narrower on the shortest story phones. The engine rounds the window's height to a whole px and the card's
    // width too, so the window can be up to half a px taller than the picture's scale asks while the picture is up to 1 px narrower
    for (const cw of [390, 350, 328, 320, 317, 300, 250, 200]) {
      const worst = (Math.round((cw * stop) / ROWS.width) + 0.5) / ((cw - 1) / ROWS.width); // the last picture row such a window can show
      expect([cw, worst < ROWS.ruleBelow[0] - 1]).toEqual([cw, true]); // the rule under the row stays out, with a row to spare even then
    }
    // blank card under the text, in screen px, at the sizes measured on the built page (the smallest: 0.2895 px a row at 390 × 667)
    for (const cw of [390, 350, 328, 317]) {
      const k = cw / ROWS.width, shown = Math.round((cw * stop) / ROWS.width) / k;
      expect([cw, (shown - (ROWS.text[1] + 1)) * k >= 8]).toEqual([cw, true]);
    }
    // (at 664, the row's own symmetry, the built page's window at 390 × 667 reached row 667 of the 670: 1 px from the rule)
  });

  it("the row sits in the window much as it sits under its own rule: 36 rows of blank over the text, 32 under it (about 1 px less on screen)", () => {
    const over = ROWS.text[0] - (ROWS.ruleAbove[1] + 1), under = stop - (ROWS.text[1] + 1);
    expect([over, under]).toEqual([36, 32]);
  });

  it("no other scene's picture moves: the band maths keeps the card's old height, the wide screens the whole card", () => {
    expect(engine).toContain("121 + (W * 176) / 584 + TAG, (W * 676) / 1095 + TAG) - (s + 2 * reach);");
    expect(engine).toContain('place(kasse, x0 + zw1 + gap, ky, kw); win(kasse, kh); kasse.classList.remove("cut"); kasse.style.setProperty("--k0", 0);');
  });
});

describe("polish 4 · the phone's Z-bon: one step larger where there is room, its caption where every caption is", () => {
  it("the slip scales up to 1.15 where the slot has the room and down where it is short; the caption block does not scale", () => {
    expect(engine).toContain('const zbh = zb.offsetHeight, zin = zb.querySelector(".zb-in"), zph = zin ? zin.offsetHeight : 0, zcap = zbh - zph;');
    expect(engine).toContain("const zk = Hx > 0 && zph > 0 ? clamp(0.5, Math.floor(((Hx - zcap) / zph) * 1000) / 1000, 1.15) : 1;");
    expect(engine).toContain("place(zb, (W - 240 * zk) / 2, midC(zph * zk + zcap, 2), 240);");
    // the scale for a slot, as the engine works it out: paper 211.5 px, caption block 26 px (measured on the built page), and the
    // slots of 390 × 844, 390 × 720, 360 × 700 and 390 × 667 (the scales the built page wrote: 1.15, 1.15, 1.066, 0.908; they were 1, 1, 1, 0.867)
    const zk = (Hx) => Math.max(0.5, Math.min(1.15, Math.floor(((Hx - 26) / 211.5) * 1000) / 1000));
    expect([zk(358), zk(272), zk(251.5), zk(218.1)]).toEqual([1.15, 1.15, 1.066, 0.908]);
    for (const Hx of [358, 272, 251.5, 218.1, 147]) expect([Hx, 211.5 * zk(Hx) + 26 <= Hx || zk(Hx) === 0.5]).toEqual([Hx, true]); // it fits its slot
  });

  it("the caption sits 8 px under the paper, at 13 / 18 px on screen whatever the slip's scale (the phone story only)", () => {
    const M = "(max-width:767px)";
    expect(decl(M, ".lp6.story .zb .zb-clip")).toEqual({ "padding-bottom": "0" });
    expect(decl(M, ".lp6.story .zb figcaption.demo")).toEqual({ "margin-top": "calc(8px / var(--zs,1))", "font-size": "calc(var(--fs-cap) / var(--zs,1))", "line-height": "calc(18px / var(--zs,1))" });
    // every other picture's caption: 8 px under its picture, the page's caption size
    expect(decl("", ".lp6 .fig figcaption.demo")).toEqual({ "margin-top": "8px" });
    expect(decl("", ".lp6 .demo")).toMatchObject({ "font-size": "var(--fs-cap)", "line-height": "18px" });
    // the stacked page and the wide screens keep the clip's air under the paper
    expect(decl("", ".lp6 .zb-clip")).toEqual({ overflow: "hidden", padding: "0 0 14px" });
  });
});

describe("polish 6 · one dash, one word", () => {
  const LANDING = (d) => Object.entries(d).filter(([k]) => k.startsWith("landingV6."));

  it.each([["da", da], ["en", en]])("%s: no long dash in any landingV6 string", (code, d) => {
    expect(LANDING(d).length).toBeGreaterThan(140);
    expect(LANDING(d).filter(([, v]) => v.includes(LONG)).map(([k]) => k)).toEqual([]);
  });

  it.each([["da", da], ["en", en]])("%s: every dash is the tankestreg with a no-break space before it and a space after it, or stands between two digits (a range of times)", (code, d) => {
    const odd = [];
    let dashes = 0, ranges = 0;
    for (const [k, v] of LANDING(d)) for (let i = v.indexOf(DASH); i !== -1; i = v.indexOf(DASH, i + 1)) {
      const before = v[i - 1], after = v[i + 1];
      if (/\d/.test(before || "") && /\d/.test(after || "")) ranges++;
      else if (before === NB && after === " " && /\S/.test(v[i - 2] || "") && /\S/.test(v[i + 2] || "")) dashes++;
      else odd.push(k);
    }
    expect(odd).toEqual([]);
    // the page's dashes, so an empty list above is not an empty search: 12 in Danish, 11 in English (the English all-plans line has a
    // semicolon); the ranges are the roster's three times and the two descriptions that read them out
    expect([dashes, ranges]).toEqual(code === "da" ? [12, 7] : [11, 7]);
    // no line can start with a dash: none follows an ordinary space or starts a string, and no hyphen stands in for one
    for (const [k, v] of LANDING(d)) expect([k, /(^|[ \t\n])[–—-] /.test(v)]).toEqual([k, false]);
  });

  it("the lines the reviews named: the price headline keeps its no-break space, the Free plan's reservation line has one", () => {
    expect(da["landingV6.price.headline"]).toBe(`{founding} kr./md. for de første {n} virksomheder med et betalt abonnement${NB}${DASH} derefter {regular}${NB}kr./md.`);
    expect(en["landingV6.price.headline"]).toBe(`{founding} kr./mo for the first {n} businesses with a paid subscription${NB}${DASH} then {regular}${NB}kr./mo.`);
    expect(da["landingV6.price.freeResv"]).toBe(`Reservationer, {resv} om måneden, op til {tables} borde${NB}${DASH} bookingside, bordplan, venteliste`);
    expect(en["landingV6.price.freeResv"]).toBe(`Reservations, {resv} a month, up to {tables} tables${NB}${DASH} booking page, floor plan, waitlist`);
  });

  it("wording and numbers are unchanged: with the dash and its space put back, every changed line is the line it was", () => {
    // the Danish lines as they stood at the review's commit (9d636262), dash and spaces as then
    const WAS = {
      "landingV6.s5.stand": "Tabletten ved døren viser kun reservationer — aldrig regnskab eller løn.",
      "landingV6.s6.archive": "Kasserapporter som PDF – du gemmer dem selv i 5 år",
      "landingV6.price.flat": "Én fast pris pr. virksomhed – ikke pr. medarbejder. Intet gebyr pr. booking, ingen andel af din omsætning.",
      "landingV6.price.allPlans": "Timer, Lager og Økonomi er med på alle planer — fakturaer, bankafstemning og tidsregistrering fra Starter.",
      "landingV6.faq.posA": "BonBox erstatter ikke din POS — den læser det, der kommer ud af den. Tag et billede af Z-bonen med en hvilken som helst telefon, og BonBox henter tallene. Det virker med alle kasser, også dem der kun printer på papir.",
      "landingV6.faq.trialA": "Har du ikke valgt en betalt plan, falder du automatisk ned til gratisplanen — intet kort, intet træk. Vælger du Starter eller Pro i prøveperioden, betaler du først, når de 14 dage er gået.",
      "landingV6.faq.salonA": "Ja. På din bookingside vælger kunden en behandling, en behandler — eller den første ledige — og en tid. For hver behandler bestemmer du, om der kan bookes i dine åbningstider eller kun i behandlerens udgivne vagter i vagtplanen.",
      "landingV6.foot.operatedBy": "BonBox – et produkt fra {company}",
    };
    const same = (s) => s.replace(new RegExp(`[ ${NB}][${DASH}${LONG}] `, "g"), " - ");
    for (const [k, was] of Object.entries(WAS)) expect([k, same(da[k])]).toEqual([k, same(was)]);
  });

  it.each([["da", false], ["en", false], ["da", true], ["en", true]])("%s (Android: %s): the page as rendered has no long dash, in its text or in any description or label", (code, onAndroid) => {
    const root = show(code, onAndroid);
    expect(root.textContent.includes(LONG)).toBe(false);
    const attrs = [...root.querySelectorAll("*")].flatMap((el) => [...el.attributes].filter((a) => a.value.includes(LONG)).map((a) => `${el.tagName} ${a.name}`));
    expect(attrs).toEqual([]);
    // and the dashes it prints are the dictionary's: none follows an ordinary space
    expect(new RegExp(` [${DASH}${LONG}]`).test(root.textContent)).toBe(false);
  });

  it("no text literal under components/landing/v6 carries a long dash (comments may)", () => {
    const strip = (src) => src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");
    const files = readdirSync(V6).filter((f) => /\.(jsx?|mjs)$/.test(f));
    expect(files.length).toBeGreaterThan(15);
    const hits = files.filter((f) => strip(readFileSync(join(V6, f), "utf8")).includes(LONG));
    expect(hits).toEqual([]);
    expect(strip(readFileSync(join(HERE, "..", "pages", "LandingV6Page.jsx"), "utf8")).includes(LONG)).toBe(false);
  });

  it("the Danish price line says MOMS as the rest of the Danish page does; the words are the same", () => {
    expect(da["landingV6.price.momsNone"]).toBe("Der kommer ikke MOMS oven i prisen.");
    expect(en["landingV6.price.momsNone"]).toBe("No MOMS is added on top of the price.");
    const root = show("da");
    expect([...root.querySelectorAll(".pnote")].map((p) => norm(p.textContent))[1]).toBe("Der kommer ikke MOMS oven i prisen.");
    // every "moms" the Danish page prints is in capitals
    expect(root.textContent.match(/\bmoms\b/gi).every((m) => m === "MOMS")).toBe(true);
  });
});
