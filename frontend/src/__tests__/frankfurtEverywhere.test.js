/**
 * Frankfurt move (Landing v6 + Frankfurt release, port plan section 4).
 *
 * On 20 Oct 2026 the database and the uploaded files moved to the Supabase
 * project in Frankfurt. The old project is kept unchanged as a fallback copy
 * until Manoj says delete. One wording rule for every UI string:
 *   DA "i Irland"  → "i EU (Frankfurt, Tyskland)"
 *   EN "in Ireland" → "in the EU (Frankfurt, Germany)"
 * and the rest of each sentence stays word for word.
 *
 * Pinned here, both ways (memory: verify a zero both ways):
 *   • no dictionary value in any language names Ireland, and no source file
 *     under src/ does — the one allowed place is the fallback-copy row of
 *     /privacy, and only while IRELAND_COPY_ROW (legal/terms.js) is true;
 *   • every key that named Ireland now names Frankfurt, with the same place
 *     /privacy gives for the main Supabase row (da + en), and the v6
 *     landing's Tryghed line names that same place;
 *   • the inline fallbacks (memory: fallbacks go stale) say Frankfurt too;
 *   • /privacy renders the Frankfurt main row and, while the constant is
 *     true, the fallback row with its deletion day — and with the constant
 *     false, no row and no Ireland anywhere on the page.
 *   • 28 Oct 2026: the old project was deleted. The constant is pinned off
 *     ("no Ireland copy kept") and the page says, in one sentence per
 *     language, that the copy was deleted on that day — never naming the
 *     old place.
 * The push-day date itself is privacyUpdatedPushDay.test.js. The committed
 * Vagtplan bundle is schedulerBundleVagtplan.test.js.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { da } from "../i18n/da";
import { en } from "../i18n/en";
import { tr } from "../i18n/tr";
import { np } from "../i18n/np";
import { vi as viPack } from "../i18n/vi";
import { th } from "../i18n/th";
import { de } from "../i18n/de";
import { es } from "../i18n/es";
import { fr } from "../i18n/fr";
import { it as itPack } from "../i18n/it";
import { ja } from "../i18n/ja";
import { nl } from "../i18n/nl";
import { no_ } from "../i18n/no";
import { pt } from "../i18n/pt";
import { sv } from "../i18n/sv";
import { IRELAND_COPY_ROW, IRELAND_COPY_DELETE_BY, IRELAND_COPY_DELETED_ON, PRIVACY_UPDATED, TERMS_VERSION, termsDate } from "../legal/terms";

// Every spelling of the old location a pack could carry, plus the region id.
const IRELAND = /Irland|Ireland|İrlanda|Irlanda|Irlande|Ierland|Irlanti|आयरल्यान्ड|ไอร์แลนด์|アイルランド|爱尔兰|Dublin|eu-west-1/;
const IRELAND_ALL = new RegExp(IRELAND.source, "g");

let langCode = "da";
// null = the real constant; true / false = forced for one test.
const force = { copyRow: null };
vi.mock("../legal/terms", async (importOriginal) => {
  const real = await importOriginal();
  return {
    ...real,
    get IRELAND_COPY_ROW() { return force.copyRow === null ? real.IRELAND_COPY_ROW : force.copyRow; },
  };
});
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ lang: langCode, setLang: () => {}, LANGUAGES: [], t: (_k, fb) => (typeof fb === "string" ? fb : _k) }),
  LanguageProvider: ({ children }) => children,
  detectInitialLanguage: () => "da",
}));
vi.mock("../components/CookieConsent", () => ({
  CookieSettingsButton: ({ label }) => createElement("button", { type: "button" }, label),
}));
vi.mock("../utils/platform", () => ({
  isNativeApp: () => false,
  canPurchaseInApp: () => true,
  isIPad: () => false,
  platform: { isNative: false, isIOS: false, isAndroid: false, isWeb: true },
}));

const PrivacyPolicyPage = (await import("../pages/PrivacyPolicyPage")).default;

afterEach(() => {
  cleanup();
  langCode = "da";
  force.copyRow = null;
});

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

const renderPrivacy = (lang) => {
  langCode = lang;
  const { container } = render(createElement(MemoryRouter, null, createElement(PrivacyPolicyPage)));
  const header = lang === "da" ? "Tjeneste" : "Service";
  const table = [...container.querySelectorAll("table")].find((t) => t.querySelector("th")?.textContent === header);
  const rows = [...table.querySelectorAll("tbody tr")].map((tr) => [...tr.querySelectorAll("td")].map((td) => td.textContent));
  return { container, rows };
};

// The place /privacy names for the main Supabase row — the one every UI
// line must repeat.
const MAIN = { da: "EU (Frankfurt, Tyskland)", en: "EU (Frankfurt, Germany)" };

const PACKS = { da, en, tr, np, vi: viPack, th, de, es, fr, it: itPack, ja, nl, no: no_, pt, sv };

// Every key that named Ireland before the move, and the Frankfurt text it
// carries now. tr / np / vi / th: forslag, no native check.
const MOVED = {
  da: {
    pricingReassureDenmarkSub: "Database i EU (Frankfurt, Tyskland) · DKK og MOMS indbygget",
    faqA8: "Din database ligger i EU (Frankfurt, Tyskland). For at blive læst ",
    landingCheckGdpr: "Database i EU (Frankfurt, Tyskland)",
    landingFactEuVal: "EU (Frankfurt, Tyskland)",
    landingFaq4A: "Databasen ligger i EU (Frankfurt, Tyskland). Når en kvittering skal læses, ",
    "landingV2.access.bonbox.detail": "Database i EU (Frankfurt, Tyskland). Billeder af bilag ",
    landingV2HeroTrustHosting: "Database i EU (Frankfurt, Tyskland) · underleverandører i privatlivspolitikken",
    landingTrustGdprBody: "Database i EU (Frankfurt, Tyskland). Kvitteringer læses i USA. ",
    madeInCph: "Lavet i København · database i EU (Frankfurt, Tyskland)",
    trialBenefit1: "Lavet i København · database i EU (Frankfurt, Tyskland)",
    suPanelBenefit2: "Databasen står i EU (Frankfurt, Tyskland). Opsig når som helst, og tag dine data med.",
  },
  en: {
    pricingReassureDenmarkSub: "Database in the EU (Frankfurt, Germany) · DKK and MOMS built in",
    faqA8: "Your database is in the EU (Frankfurt, Germany). To be read, ",
    landingCheckGdpr: "Database in the EU (Frankfurt, Germany)",
    landingFactEuVal: "EU (Frankfurt, Germany)",
    landingFaq4A: "The database is in the EU (Frankfurt, Germany). When a receipt needs reading, ",
    "landingV2.access.bonbox.detail": "Database in the EU (Frankfurt, Germany). Receipt images ",
    landingV2HeroTrustHosting: "Database in the EU (Frankfurt, Germany) · providers listed in the privacy policy",
    landingTrustGdprBody: "Database in the EU (Frankfurt, Germany). Receipts are read in the US. ",
    madeInCph: "Made in Copenhagen · database in the EU (Frankfurt, Germany)",
    trialBenefit1: "Built in Copenhagen · database in the EU (Frankfurt, Germany)",
    suPanelBenefit2: "The database is in the EU (Frankfurt, Germany). Cancel any time and take your data with you.",
  },
  tr: {
    faqA8: "Veritabanınız AB'de (Frankfurt, Almanya). ",
    landingCheckGdpr: "Veritabanı AB'de (Frankfurt, Almanya)",
    landingFactEuVal: "AB (Frankfurt, Almanya)",
    "landingV2.access.bonbox.detail": "Veritabanı AB'de (Frankfurt, Almanya). ",
    landingV2HeroTrustHosting: "Veritabanı AB'de (Frankfurt, Almanya) · hizmet sağlayıcılar gizlilik politikasında",
    landingTrustGdprBody: "Veritabanı AB'de (Frankfurt, Almanya). Fişler ABD'de okunur. ",
    landingFaq4A: "Veritabanı AB'de (Frankfurt, Almanya). ",
  },
  np: {
    faqA8: "तपाईंको डाटाबेस EU (फ्र्याङ्कफर्ट, जर्मनी) मा छ। ",
    madeInCph: "Made in Copenhagen · database in the EU (Frankfurt, Germany)",
    trialBenefit1: "Built in Copenhagen · database in the EU (Frankfurt, Germany)",
  },
  vi: { faqA8: "Cơ sở dữ liệu của bạn nằm ở EU (Frankfurt, Đức). " },
  th: { faqA8: "ฐานข้อมูลของคุณอยู่ใน EU (แฟรงก์เฟิร์ต, เยอรมนี) " },
};

describe("dictionaries: Ireland is gone, Frankfurt is there", () => {
  for (const [code, pack] of Object.entries(PACKS)) {
    it(`${code}: no value names Ireland (or eu-west-1)`, () => {
      const hits = Object.entries(pack).filter(([, v]) => typeof v === "string" && IRELAND.test(v)).map(([k]) => k);
      expect(hits).toEqual([]);
    });
  }

  for (const [code, keys] of Object.entries(MOVED)) {
    it(`${code}: every key that named Ireland now names Frankfurt`, () => {
      for (const [key, text] of Object.entries(keys)) {
        const value = PACKS[code][key];
        expect(typeof value, `${code}.${key}`).toBe("string");
        // A full value is pinned whole; a sentence prefix pins the changed start.
        if (text.endsWith(" ")) expect(value.startsWith(text), `${code}.${key}: ${value.slice(0, 90)}`).toBe(true);
        else expect(value, `${code}.${key}`).toBe(text);
      }
    });
  }

  it("da/en: each moved line names the same place as the main Supabase row of /privacy, never 'Data i EU'", () => {
    for (const lang of ["da", "en"]) {
      for (const key of Object.keys(MOVED[lang])) {
        expect(PACKS[lang][key], `${lang}.${key}`).toContain(MAIN[lang]);
        expect(PACKS[lang][key]).not.toMatch(/Data i EU|dine data bliver i EU|Data in the EU|your data stays in the EU/i);
      }
    }
  });

  it("the v6 landing's Tryghed line names the same place as the main Supabase row (da + en)", () => {
    expect(da["landingV6.trust.db"].match(/Database i (EU \([^)]*\))/)?.[1]).toBe(MAIN.da);
    expect(en["landingV6.trust.db"].match(/Database in the (EU \([^)]*\))/)?.[1]).toBe(MAIN.en);
  });
});

describe("inline fallbacks say Frankfurt too (memory: fallbacks go stale)", () => {
  // [file, key, pack]: the fallback text in the file equals the pack's value.
  const FALLBACKS = [
    ["components/landing/v2/HeroV2.jsx", "landingV2HeroTrustHosting", en],
    ["components/landing/v2/AccessV2.jsx", "landingV2.access.bonbox.detail", en],
    ["pages/SubscriptionPage.jsx", "pricingReassureDenmarkSub", en],
    ["pages/LandingPage.jsx", "landingCheckGdpr", da],
    ["pages/LandingPage.jsx", "landingFactEuVal", en],
    ["pages/LandingPage.jsx", "landingTrustGdprBody", en],
    ["pages/LandingPage.jsx", "landingFaq4A", en],
  ];
  for (const [file, key, pack] of FALLBACKS) {
    it(`${file}: the "${key}" fallback is the dictionary's Frankfurt text`, () => {
      const src = read(file);
      expect(src).toContain(JSON.stringify(pack[key]));
      expect(src).not.toMatch(IRELAND);
    });
  }
});

describe("source: the fallback-copy row of /privacy is the only place under src/ that names Ireland", () => {
  it("every hit outside the tests is one of that row's two location cells", () => {
    const hits = [];
    const walk = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__") walk(p);
        } else if (/\.(jsx?|mjs|cjs|css|html|json)$/.test(entry.name) && !/\.(test|spec)\.jsx?$/.test(entry.name)) {
          fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
            if (IRELAND.test(line)) hits.push({ file: path.relative(SRC, p), line: i + 1, text: line.trim() });
          });
        }
      }
    };
    walk(SRC);
    const where = hits.map((h) => h.file);
    expect(new Set(where)).toEqual(new Set(["pages/PrivacyPolicyPage.jsx"]));
    expect(hits).toHaveLength(2);
    expect(hits.map((h) => h.text.match(IRELAND_ALL))).toEqual([["Ireland"], ["Irland"]]);
    expect(hits[0].text).toMatch(/^en: \["Supabase", `Previous database and file storage\./);
    expect(hits[0].text).toContain('"EU (Ireland)"');
    expect(hits[1].text).toMatch(/^da: \["Supabase", `Tidligere database og fillagring\./);
    expect(hits[1].text).toContain('"EU (Irland)"');
  });
});

describe("/privacy: Frankfurt main row; the fallback copy only behind IRELAND_COPY_ROW", () => {
  const FALLBACK = {
    en: ["Supabase", `Previous database and file storage. After the move to Frankfurt on 20 October 2026 a copy is kept as a fallback; it will be deleted by ${termsDate(IRELAND_COPY_DELETE_BY, "en")}. Until then, receipt pictures uploaded before the move are still loaded from this copy.`, "EU (Ireland)", "A copy of all account and business data and the files you had uploaded, as of 20 October 2026"],
    da: ["Supabase", `Tidligere database og fillagring. Efter flytningen til Frankfurt den 20. oktober 2026 beholdes en kopi som reserve; den slettes senest ${termsDate(IRELAND_COPY_DELETE_BY, "da")}. Indtil da hentes billeder af bilag, der blev uploadet før flytningen, stadig fra denne kopi.`, "EU (Irland)", "En kopi af alle konto- og virksomhedsdata og de filer, du havde uploadet, pr. 20. oktober 2026"],
  };

  // Security fix round (23 Oct): the copy is not a passive reserve. A receipt picture is stored as a full signed URL on
  // the host that was live at upload (backend services/receipt_ocr.py signs for a year), and the move copied the rows
  // without re-signing them, so pictures uploaded before 20 Oct still load from the old project. The row said so until
  // the old project was deleted (and the packet made "0 rows point at Ireland" the condition for that deletion).
  // 28 Oct: the receipt re-link release (74db5a43) reads every pre-move link from Frankfurt at read time
  // (services/storage_links.py, RETIRED_PROJECT_REFS) and new uploads sign with the shared TTL on the configured
  // project, so nothing loads from the old project any more — which is what let it be deleted and the row go off.
  it("the row is off because nothing loads from the old project: pre-move links are re-linked to Frankfurt; its own words stay", () => {
    const ocr = fs.readFileSync(path.join(SRC, "../../backend/app/services/receipt_ocr.py"), "utf8");
    expect(ocr).toMatch(/signed = storage\.signed_url\(key, ttl_seconds=RECEIPT_URL_TTL_SECONDS\)/);
    const links = fs.readFileSync(path.join(SRC, "../../backend/app/services/storage_links.py"), "utf8");
    expect(links).toMatch(/^RETIRED_PROJECT_REFS = \("ahlqhztujpeccmaivkhr",\)$/m);
    expect(links).toMatch(/^def client_receipt_ref\(/m);
    expect(IRELAND_COPY_ROW).toBe(false);
    // The row's text, kept for the forced-on state below, still reads as it did.
    expect(FALLBACK.da[1]).toMatch(/Indtil da hentes billeder af bilag, der blev uploadet før flytningen, stadig fra denne kopi\.$/);
    expect(FALLBACK.en[1]).toMatch(/Until then, receipt pictures uploaded before the move are still loaded from this copy\.$/);
    // the sentence never names the old place itself: Ireland stays in the Location column only
    expect(FALLBACK.da[1]).not.toMatch(IRELAND);
    expect(FALLBACK.en[1]).not.toMatch(IRELAND);
  });

  it("the deletion day is a real day after the move", () => {
    expect(IRELAND_COPY_DELETE_BY).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(IRELAND_COPY_DELETE_BY > "2026-10-20").toBe(true);
    expect(termsDate(IRELAND_COPY_DELETE_BY, "da")).toMatch(/^\d{1,2}\. [a-z]+ \d{4}$/);
  });

  // Landing fix round (22 Oct): the row promises "slettes senest <day>". If that day passes with the row still on,
  // /privacy states a promise in the past. CI goes red the day after, so the release that deletes the old project
  // (IRELAND_COPY_ROW = false) or moves the date is never forgotten.
  it("while the fallback row is on, its deletion day has not passed (Copenhagen time)", () => {
    const copenhagenToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
    expect(copenhagenToday).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    if (IRELAND_COPY_ROW) {
      expect(copenhagenToday <= IRELAND_COPY_DELETE_BY, `IRELAND_COPY_DELETE_BY (${IRELAND_COPY_DELETE_BY}) has passed while IRELAND_COPY_ROW is on: delete the old project and set the row off, or move the date (src/legal/terms.js)`).toBe(true);
    }
  });

  for (const lang of ["da", "en"]) {
    it(`${lang}: the main Supabase row is Frankfurt, and Ireland appears only in the fallback row (constant as committed: ${IRELAND_COPY_ROW})`, () => {
      const { container, rows } = renderPrivacy(lang);
      const supa = rows.filter((r) => r[0] === "Supabase");
      expect(supa[0][2]).toBe(MAIN[lang]);
      const text = container.textContent;
      if (IRELAND_COPY_ROW) {
        expect(supa).toHaveLength(3);
        expect(supa[2]).toEqual(FALLBACK[lang]);
        expect(text.match(IRELAND_ALL)).toEqual([lang === "da" ? "Irland" : "Ireland"]);
      } else {
        expect(supa).toHaveLength(2);
        expect(text).not.toMatch(IRELAND);
      }
    });

    it(`${lang}: constant false → no fallback row, no Ireland anywhere on the page`, () => {
      force.copyRow = false;
      const { container, rows } = renderPrivacy(lang);
      const supa = rows.filter((r) => r[0] === "Supabase");
      expect(supa.map((r) => r[2])).toEqual(lang === "da"
        ? ["EU (Frankfurt, Tyskland)", "EU (Tyskland, Frankfurt)"]
        : ["EU (Frankfurt, Germany)", "EU (Germany, Frankfurt)"]);
      expect(container.textContent).not.toMatch(IRELAND);
    });

    it(`${lang}: constant true → the fallback row right after the backup row, word for word`, () => {
      force.copyRow = true;
      const { rows } = renderPrivacy(lang);
      const i = rows.findIndex((r) => r[0] === "Supabase");
      expect(rows[i][2]).toBe(MAIN[lang]);
      expect(rows[i + 1][2]).toBe(lang === "da" ? "EU (Tyskland, Frankfurt)" : "EU (Germany, Frankfurt)");
      expect(rows[i + 2]).toEqual(FALLBACK[lang]);
    });
  }

  it("en and da carry the same number of rows, Supabase's at the same places, in both states", () => {
    const at = (rows) => rows.flatMap((r, i) => (r[0] === "Supabase" ? [i] : []));
    for (const state of [true, false]) {
      force.copyRow = state;
      const en_ = renderPrivacy("en").rows;
      cleanup();
      const da_ = renderPrivacy("da").rows;
      cleanup();
      expect(da_).toHaveLength(en_.length);
      expect(at(da_)).toEqual(at(en_));
      expect(at(en_)).toHaveLength(state ? 3 : 2);
    }
  });

  // 28 Oct 2026 (~14:10 CET): Manoj deleted the old project after the receipt re-link release went live and its check
  // said safe to delete. Pinned: no Ireland copy kept — the row is off as committed, and the page says when it went.
  it("the old project is deleted: the fallback row is off as committed (no Ireland copy kept)", () => {
    expect(IRELAND_COPY_ROW).toBe(false);
    expect(IRELAND_COPY_DELETED_ON).toBe("2026-10-28");
    expect(IRELAND_COPY_DELETED_ON > "2026-10-20").toBe(true);
    expect(IRELAND_COPY_DELETED_ON <= IRELAND_COPY_DELETE_BY).toBe(true);
  });

  const DELETED = {
    en: "The fallback copy we kept in our previous database project after the move to Frankfurt on 20 October 2026 was deleted on 28 October 2026.",
    da: "Den reservekopi, vi beholdt i vores tidligere databaseprojekt efter flytningen til Frankfurt den 20. oktober 2026, blev slettet den 28. oktober 2026.",
  };
  for (const lang of ["da", "en"]) {
    it(`${lang}: one plain sentence says the copy was deleted on 28 October 2026, right under the location note, never naming the old place`, () => {
      const { container } = renderPrivacy(lang);
      const line = container.querySelector('[data-testid="privacy-old-copy-deleted"]');
      expect(line).not.toBeNull();
      expect(line.textContent).toBe(DELETED[lang]);
      expect(line.textContent).not.toMatch(IRELAND);
      expect(line.previousElementSibling?.getAttribute("data-testid")).toBe("privacy-location-note");
      expect(container.querySelectorAll('[data-testid="privacy-old-copy-deleted"]')).toHaveLength(1);
      expect(container.textContent).not.toMatch(/slettes senest|will be deleted by/);
    });

    it(`${lang}: the two states never meet — with the row forced on there is no "deleted" sentence`, () => {
      force.copyRow = true;
      const { container } = renderPrivacy(lang);
      expect(container.querySelector('[data-testid="privacy-old-copy-deleted"]')).toBeNull();
    });
  }

  it("PRIVACY_UPDATED is a day after the last /privacy date (2026-10-12) and not before the Terms", () => {
    expect(PRIVACY_UPDATED).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(PRIVACY_UPDATED > "2026-10-12").toBe(true);
    expect(PRIVACY_UPDATED >= TERMS_VERSION).toBe(true);
  });
});
