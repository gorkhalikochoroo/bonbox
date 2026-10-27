/**
 * Booking R5 — the booking page's own words (virtual:bonbox-booking-dict).
 *
 * A guest's phone used to download the ~200 KB full Danish dictionary before
 * the page could say anything; the page uses ~400 of its 10.000 keys. The
 * build now generates the page's own (scripts/bookingDict.mjs, from
 * i18n/da.js + en.js) and the page registers it (lib/bookingDict.js).
 *
 *  • it holds every key any file the page's code reaches can show, as a
 *    t("…") literal or a t(`prefix${…}`) template — in BOTH languages;
 *  • every value is the dictionaries' own text (generated, never a copy);
 *  • it is the page's, not the landing's: small, and its own chunk;
 *  • the index.html dictionary preload stays away from the booking page.
 */
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import BOOKING from "virtual:bonbox-booking-dict";
import { da } from "../i18n/da.js";
import { en } from "../i18n/en.js";
import { bookingGraph, bookingKeys, buildBookingDict, keysIn } from "../../scripts/bookingDict.mjs";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FRONTEND = path.resolve(SRC, "..");
const rel = (f) => path.relative(SRC, f);
const graph = bookingGraph(SRC);

describe("which files the page's words come from", () => {
  it("the page and everything its code reaches", () => {
    const files = graph.map(rel);
    for (const f of [
      "pages/ReservationPublicPage.jsx",
      "components/MonthCalendar.jsx",
      "components/PublicFloorMap.jsx",
      "components/VenueHours.jsx",
      "components/ui/Sheet.jsx",
      "utils/dayState.js",
      "utils/bookingRefusal.js",
      "utils/slotNote.js",
      "hooks/useConfirm.jsx",
    ]) {
      expect(files, f).toContain(f);
    }
    // never the owner app's pages
    expect(files.some((f) => /pages\/ReservationsPage/.test(f))).toBe(false);
  });
});

describe("the words", () => {
  it("cover every t() key of every file the page reaches, in Danish and English", () => {
    const missing = [];
    for (const f of graph) {
      const src = fs.readFileSync(f, "utf8");
      for (const m of src.matchAll(/\bt\(\s*"([^"]+)"/g)) {
        const k = m[1];
        if (!(k in en)) continue; // a key no dictionary has is the i18n lint's business
        if (!BOOKING.da[k] || !BOOKING.en[k]) missing.push(`${rel(f)}: ${k}`);
      }
      for (const m of src.matchAll(/\bt\(\s*`([^`$]+)\$\{/g)) {
        const keys = Object.keys(en).filter((k) => k.startsWith(m[1]));
        expect(keys.length, `${rel(f)}: ${m[1]}*`).toBeGreaterThan(0);
        for (const k of keys) if (!BOOKING.da[k] || !BOOKING.en[k]) missing.push(`${rel(f)}: ${k}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("include the keys the page keeps in tables (refusals, day words, occasions, severities, allergens)", () => {
    for (const k of ["rsvpOccasion_birthday", "rsvpSeverity_severe", "rsvpConfirm", "rsvpLoading", "rsvpContinue"]) {
      expect(BOOKING.da[k], k).toBe(da[k]);
      expect(BOOKING.en[k], k).toBe(en[k]);
    }
    const allergens = Object.keys(en).filter((k) => k.startsWith("allergen_"));
    expect(allergens.length).toBeGreaterThan(5);
    for (const k of allergens) expect(BOOKING.da[k], k).toBeTruthy();
  });

  it("are the dictionaries' own text (generated, never a second copy)", () => {
    for (const k of Object.keys(BOOKING.da)) expect(BOOKING.da[k], k).toBe(da[k]);
    for (const k of Object.keys(BOOKING.en)) expect(BOOKING.en[k], k).toBe(en[k]);
    expect(Object.keys(BOOKING.da).sort()).toEqual(Object.keys(BOOKING.en).sort());
  });

  it("are the page's: a few hundred keys, ~10 KB gz — not the landing, not the owner app", () => {
    const n = Object.keys(BOOKING.da).length;
    expect(n).toBeGreaterThan(250);
    expect(n).toBeLessThan(900);
    expect(Object.keys(BOOKING.da).some((k) => k.startsWith("landingV6."))).toBe(false);
    expect(Object.keys(BOOKING.da).some((k) => k.startsWith("rsvpWeb"))).toBe(false); // the owner's website kit
    expect(JSON.stringify(BOOKING).length).toBeLessThan(80_000); // raw; the full Danish one is ~600 KB
  });
});

describe("the scanner", () => {
  const EN = { rsvpA: "A", rsvpB: "B", rsvpOccasion_x: "X", rsvpOccasion_y: "Y", other: "O" };
  it("takes quoted keys anywhere (tables too) and template prefixes", () => {
    const src = `const T = { a: "rsvpA" }; t('rsvpB'); t(\`rsvpOccasion_\${k}\`); "not a key"; "other"`;
    expect([...keysIn(src, EN)].sort()).toEqual(["other", "rsvpA", "rsvpB", "rsvpOccasion_x", "rsvpOccasion_y"]);
  });

  it("builds both languages from the same key list", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r5-scan-"));
    const tmp = path.join(dir, "page.js");
    try {
      fs.writeFileSync(tmp, 't("rsvpA"); t("rsvpB");');
      expect(bookingKeys([tmp], EN)).toEqual(["rsvpA", "rsvpB"]);
      expect(buildBookingDict({ files: [tmp], da: { rsvpA: "a", rsvpB: "b" }, en: EN })).toEqual({
        da: { rsvpA: "a", rsvpB: "b" },
        en: { rsvpA: "A", rsvpB: "B" },
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("wiring", () => {
  const config = fs.readFileSync(path.join(FRONTEND, "vite.config.js"), "utf8");
  it("the page registers its words as its code is evaluated", () => {
    const page = fs.readFileSync(path.join(SRC, "pages/ReservationPublicPage.jsx"), "utf8");
    expect(page).toContain('import "../lib/bookingDict";');
    const reg = fs.readFileSync(path.join(SRC, "lib/bookingDict.js"), "utf8");
    expect(reg).toMatch(/registerPageDict\(BOOKING\);/);
  });

  it("the words are their own chunk; the plugin runs in dev, build and vitest", () => {
    expect(config).toMatch(/\{ name: 'booking-dict', test: \/bonbox-booking-dict\/, priority: 35 \}/);
    expect(config).toMatch(/plugins: \[[^\]]*bookingDictionary\(\)/);
  });

  it("index.html's dictionary preload stays away from the booking page (Danish and English)", () => {
    expect(config).toContain(`'if(window.__bbBooking&&(l==="da"||l==="en"))return;' +`);
    // and it sits after the line that settles the language, before the preload is written
    expect(config.indexOf("window.__bbBooking&&(l===")).toBeGreaterThan(config.indexOf('l=/(^|,)(da|fo)/.test(n)'));
    expect(config.indexOf("window.__bbBooking&&(l===")).toBeLessThan(config.indexOf('var h=l==="da"?f.da:f.en;'));
  });
});
