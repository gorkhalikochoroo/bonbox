/**
 * LANDING V6 — its dictionary (port step 5/6, PORT_PLAN 2.1–2.4).
 *
 * One prefix, landingV6.*, for every visible string, aria-label, alt text and time on the page:
 *   - every key in da.js is in en.js and back, with real, non-empty text; English differs from Danish except an
 *     allow-list (brand, plan and fixture names, and the legal documents' Danish titles, section 8 item 9);
 *   - Danish and English carry the same placeholders and the same <a>/<b> markers (rich.jsx);
 *   - numbers that come from planPrices / planLimits are placeholders, never typed;
 *   - every t("…") literal in the v6 tree exists in both, every key is used, no inline fallback, and every one is
 *     a boot key (the first paint is already in the visitor's language);
 *   - no other language pack has landingV6.* (a Turkish reader gets the English page whole, never a mix, until
 *     Manoj decides a Turkish landing, [DECIDE] 11);
 *   - no emoji flag anywhere in the page's source or text (Windows shows them as two letters).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, it, expect } from "vitest";
import BOOT from "virtual:bonbox-boot-dict";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { isBootKey } from "../lib/bootKeys";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const V6 = "components/landing/v6";
const TREE = ["pages/LandingV6Page.jsx", ...fs.readdirSync(path.join(SRC, V6)).filter((f) => /\.(jsx?|css)$/.test(f)).map((f) => `${V6}/${f}`)];
const CODE = TREE.filter((f) => /\.jsx?$/.test(f));
const KEYS = Object.keys(da).filter((k) => k.startsWith("landingV6."));
const SAME_OK = new Set([
  "landingV6.role.bartender", "landingV6.room.bar", "landingV6.room.online", "landingV6.zb.mobilepay",
  "landingV6.price.starterName", "landingV6.price.proName", "landingV6.foot.terms", "landingV6.foot.privacy",
]);
const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
const markers = (s) => [...s.matchAll(/<(a|b)>/g)].map((m) => m[1]).sort();

describe("landingV6.* in da.js and en.js", () => {
  it("the same keys in both, real text in each (about 120)", () => {
    const enKeys = Object.keys(en).filter((k) => k.startsWith("landingV6."));
    expect(KEYS.length).toBeGreaterThanOrEqual(100);
    expect([...enKeys].sort()).toEqual([...KEYS].sort());
    for (const k of KEYS) {
      expect([k, typeof da[k], typeof en[k]]).toEqual([k, "string", "string"]);
      expect([k, da[k].trim().length > 0, en[k].trim().length > 0]).toEqual([k, true, true]);
    }
  });

  it("English is English: it differs from the Danish outside the allow-list", () => {
    expect(KEYS.filter((k) => da[k] === en[k] && !SAME_OK.has(k))).toEqual([]);
    for (const k of SAME_OK) expect(KEYS).toContain(k); // the allow-list names real keys only
  });

  it("the same placeholders and the same link / bold markers in both languages", () => {
    for (const k of KEYS) {
      expect([k, vars(en[k])]).toEqual([k, vars(da[k])]);
      expect([k, markers(en[k])]).toEqual([k, markers(da[k])]);
      // markers are only the three rich.jsx renders, each closed
      for (const v of [da[k], en[k]]) {
        expect([k, v.replace(/<(nw|a|b)>[\s\S]*?<\/\1>/g, "").replace(/<\/?(nw|a|b)>/g, "")]).toEqual([k, expect.not.stringMatching(/[<>]/)]);
      }
    }
  });

  it("prices and plan limits are placeholders, never typed numbers", () => {
    for (const k of KEYS) for (const v of [da[k], en[k]]) expect([k, v]).toEqual([k, expect.not.stringMatching(/\b(129|199|249|349)\b/)]);
    for (const k of KEYS.filter((k) => k.startsWith("landingV6.price."))) {
      for (const v of [da[k], en[k]]) expect([k, v.replace(/\{\w+\}/g, "")]).toEqual([k, expect.not.stringMatching(/\d/)]);
    }
    expect(vars(da["landingV6.price.headline"])).toEqual(["founding", "n", "regular"]);
    expect(vars(da["landingV6.price.freeTeam"])).toEqual(["branches", "staff", "users"]);
    expect(vars(da["landingV6.price.freeResv"])).toEqual(["resv"]);
    expect(vars(da["landingV6.price.freeScans"])).toEqual(["scans"]);
    expect(vars(da["landingV6.trial"])).toEqual(["price"]);
  });

  it("locked Danish terms stay Danish on the English page (MOMS, kasserapport); Z-bon is Z-report", () => {
    for (const k of KEYS) {
      if (/MOMS/.test(da[k])) expect([k, en[k]]).toEqual([k, expect.stringMatching(/MOMS/)]);
      if (/kasserapport/i.test(da[k])) expect([k, en[k]]).toEqual([k, expect.stringMatching(/kasserapport/i)]);
      expect([k, en[k]]).toEqual([k, expect.not.stringMatching(/\bVAT\b|Z-bon/)]);
    }
  });

  it("no other language pack has landingV6.* (Turkish reads the English page, never a mix)", () => {
    for (const f of fs.readdirSync(path.join(SRC, "i18n")).filter((f) => f.endsWith(".js") && f !== "da.js" && f !== "en.js")) {
      expect([f, read(`i18n/${f}`).includes('"landingV6.')]).toEqual([f, false]);
    }
  });
});

describe("the v6 tree's keys", () => {
  const used = new Set();
  for (const f of CODE) for (const m of read(f).matchAll(/\bt\(\s*"([^"]+)"/g)) used.add(m[1]);

  it("every t(\"…\") in the tree is a landingV6 key that exists in da and en; every landingV6 key is used", () => {
    expect([...used].filter((k) => !k.startsWith("landingV6.") || !(k in da) || !(k in en))).toEqual([]);
    expect(KEYS.filter((k) => !used.has(k))).toEqual([]);
  });

  it("no inline fallback (t(\"k\", \"text\") or t(…) || \"text\") and no composed key in the tree", () => {
    for (const f of CODE) {
      const src = read(f);
      expect([f, src.match(/\bt\(\s*"[^"]+"\s*,\s*["'`]/g)]).toEqual([f, null]);
      expect([f, src.match(/\bt\([^)]*\)\s*\|\|/g)]).toEqual([f, null]);
      expect([f, src.match(/\bt\(\s*`/g)]).toEqual([f, null]);
      expect([f, src.match(/\bt\(\s*[a-zA-Z_]/g)]).toEqual([f, null]);
    }
  });

  it("every key is a boot key, in the boot dictionary in da and en (the first paint is in the visitor's language)", () => {
    for (const k of used) expect([k, isBootKey(k), !!BOOT.da[k], !!BOOT.en[k]]).toEqual([k, true, true, true]);
  });

  it("no emoji flag (regional indicators) in the page's source or its text", () => {
    const RI = /[\u{1F1E6}-\u{1F1FF}]/u;
    for (const f of TREE) expect([f, RI.test(read(f))]).toEqual([f, false]);
    for (const k of KEYS) expect([k, RI.test(da[k]) || RI.test(en[k])]).toEqual([k, false]);
  });
});
