/**
 * Booking R3 — "Refined, finished" (judge 24 Oct 2026): the booking-local
 * tile classes, the balanced time columns, the date strip's columns from
 * 450 px, the skeleton's shape and step 1's first answers (seedStep1).
 */
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { describe, expect, it } from "vitest";
import {
  SKELETON_COUNT,
  SKELETON_GRID,
  TILE_CLOSED,
  TILE_HOVER,
  TILE_PICKED,
  TILE_REST,
  dateRailCols,
  skeletonTileClass,
  tileClass,
  timeGridCols,
} from "../components/booking/bookingTiles";
import { seedStep1 } from "../utils/bookingDay";

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");
const cols = (cls, prefix) => {
  const m = cls.split(/\s+/).find((c) => c.startsWith(prefix + "grid-cols-") && !c.slice(prefix.length).includes(":"));
  return m ? Number(m.slice((prefix + "grid-cols-").length)) : null;
};

describe("tiles: quiet at rest, one hover, one calm pick, no box for a closed day", () => {
  it("rest is a gray-50 tile on a 6 % hairline, with its dark pair", () => {
    expect(TILE_REST).toContain("bg-gray-50");
    expect(TILE_REST).toContain("border-gray-900/[0.06]");
    expect(TILE_REST).toMatch(/dark:bg-/);
    expect(TILE_REST).toMatch(/dark:border-/);
    expect(TILE_REST).not.toMatch(/(^|\s)bg-white(\s|$)/);
  });
  it("one hover rule, fine pointers only, light and dark", () => {
    for (const c of TILE_HOVER.split(/\s+/)) expect(c).toMatch(/pointer-fine:hover:/);
    expect(TILE_HOVER).toContain("pointer-fine:hover:bg-gray-100");
    expect(TILE_HOVER).toMatch(/dark:pointer-fine:hover:bg-/);
  });
  it("the pick is gray-900 with a 1–2 px neutral contact shadow — never green, never a weight jump", () => {
    expect(TILE_PICKED).toContain("bg-gray-900");
    expect(TILE_PICKED).toContain("text-white");
    expect(TILE_PICKED).toMatch(/shadow-\[0_1px_2px_rgb\(16_24_40\/0\.16\)/);
    expect(TILE_PICKED).toMatch(/dark:bg-gray-100/);
    expect(TILE_PICKED).not.toMatch(/font-(semibold|bold)/);
    for (const s of [TILE_REST, TILE_HOVER, TILE_PICKED, TILE_CLOSED]) {
      expect(s).not.toMatch(/(^|[\s:])(bg|text|border|shadow)-green-/);
      expect(s).toContain(s === TILE_HOVER ? "" : "bb-tile");
    }
  });
  it("a closed day loses its box", () => {
    expect(TILE_CLOSED).toContain("border-transparent");
    expect(TILE_CLOSED).toContain("bg-transparent");
    expect(tileClass({ closed: true })).toBe(TILE_CLOSED);
    expect(tileClass({ picked: true })).toBe(TILE_PICKED);
    expect(tileClass({})).toBe(TILE_REST + " " + TILE_HOVER);
  });
  it("the shared ui/Chip keeps its outlined look (booking-local, not a global change)", () => {
    const chip = read("components/ui/Chip.jsx");
    expect(chip).toContain('"bg-white dark:bg-gray-900 "');
    expect(chip).toContain('"border-gray-200 dark:border-gray-700 "');
    expect(chip).not.toContain("bb-tile");
  });
});

describe("time columns: no time alone on its last row", () => {
  it("11 times → 6 + 5 from 450 px, 4 + 4 + 3 on a phone", () => {
    expect(timeGridCols(11)).toBe("grid-cols-4 min-[450px]:grid-cols-6");
  });
  it("9 times → 5 + 4 on a phone, 5 + 4 from 450 px", () => {
    expect(timeGridCols(9)).toBe("grid-cols-5 min-[450px]:grid-cols-5");
  });
  it("8 and 1 keep the base columns", () => {
    expect(timeGridCols(8)).toBe("grid-cols-4 min-[450px]:grid-cols-5");
    expect(timeGridCols(1)).toBe("grid-cols-4 min-[450px]:grid-cols-5");
  });
  it("for every count up to 60 the last row is never a single time", () => {
    for (let n = 2; n <= 60; n++) {
      const c = timeGridCols(n);
      const phone = cols(c, "");
      const wide = cols(c, "min-[450px]:");
      expect(n <= phone || n % phone !== 1, `phone n=${n} cols=${phone}`).toBe(true);
      expect(n <= wide || n % wide !== 1, `wide n=${n} cols=${wide}`).toBe(true);
    }
  });
  it("with a scarcity note under the digits the columns stay at their base (the note needs the width)", () => {
    expect(timeGridCols(11, { notes: true })).toBe("grid-cols-4 min-[450px]:grid-cols-5");
    expect(timeGridCols(9, { notes: true })).toBe("grid-cols-4 min-[450px]:grid-cols-5");
  });
  it("every class it can return is written out whole in the module (Tailwind must see it)", () => {
    const mod = read("components/booking/bookingTiles.js");
    for (let n = 1; n <= 61; n++) {
      for (const c of timeGridCols(n).split(" ")) expect(mod).toContain(`"${c}"`);
    }
  });
});

describe("date strip from 450 px", () => {
  it("up to 8 days sit in one row; never fewer than 5 columns; longer windows in rows of 7", () => {
    expect(dateRailCols(8)).toBe(8);
    expect(dateRailCols(7)).toBe(7);
    expect(dateRailCols(3)).toBe(5);
    expect(dateRailCols(1)).toBe(5);
    expect(dateRailCols(9)).toBe(7);
    expect(dateRailCols(14)).toBe(7);
  });
});

describe("the times skeleton is the shape of the times", () => {
  it("tile material, 12 px corners, 4 / 5 columns, three rows", () => {
    expect(SKELETON_GRID).toBe("grid grid-cols-4 min-[450px]:grid-cols-5 gap-2");
    expect(SKELETON_COUNT).toBe(15);
    const all = Array.from({ length: SKELETON_COUNT }, (_, i) => skeletonTileClass(i));
    for (const c of all) {
      expect(c).toContain("h-11");
      expect(c).toContain("rounded-xl");
      expect(c).toContain("bg-gray-50");
      expect(c).toContain("bbBreathe");
      expect(c).not.toContain("animate-pulse");
    }
    // 12 below 450 px (3 rows of 4), 15 from 450 px (3 rows of 5).
    expect(all.filter((c) => c.includes("max-[450px]:hidden"))).toHaveLength(3);
    expect(all.slice(0, 12).some((c) => c.includes("max-[450px]:hidden"))).toBe(false);
  });
});

describe("seedStep1 — step 1's first answers, set with the page data", () => {
  const TODAY = "2030-01-08";
  const PAGE = { business_type: "restaurant", max_party_size: 10, max_advance_days: 60 };
  it("today and 2 guests by default", () => {
    expect(seedStep1(PAGE, {}, TODAY)).toEqual({ day: TODAY, party: 2 });
  });
  it("a ?d= link inside the window is the day; outside or not a real date, today", () => {
    expect(seedStep1(PAGE, { d: "2030-01-20" }, TODAY).day).toBe("2030-01-20");
    expect(seedStep1(PAGE, { d: "2030-01-07" }, TODAY).day).toBe(TODAY);
    expect(seedStep1(PAGE, { d: "2030-04-01" }, TODAY).day).toBe(TODAY);
    expect(seedStep1(PAGE, { d: "2030-02-30" }, TODAY).day).toBe(TODAY);
    expect(seedStep1(PAGE, { d: "junk" }, TODAY).day).toBe(TODAY);
  });
  it("max_advance_days 0 is today only (the backend's reading, never || 60)", () => {
    expect(seedStep1({ ...PAGE, max_advance_days: 0 }, { d: "2030-01-09" }, TODAY).day).toBe(TODAY);
    expect(seedStep1({ ...PAGE, max_advance_days: null }, { d: "2030-03-01" }, TODAY).day).toBe("2030-03-01");
  });
  it("?party= is clamped to the venue's maximum; junk falls back to 2 (or the maximum when lower)", () => {
    expect(seedStep1(PAGE, { party: "4" }, TODAY).party).toBe(4);
    expect(seedStep1(PAGE, { party: "40" }, TODAY).party).toBe(10);
    expect(seedStep1(PAGE, { party: "0" }, TODAY).party).toBe(2);
    expect(seedStep1({ ...PAGE, max_party_size: 1 }, {}, TODAY).party).toBe(1);
  });
  it("a salon, a shop or a workshop is booked by one customer whatever the link says", () => {
    expect(seedStep1({ ...PAGE, business_type: "salon" }, { party: "4" }, TODAY).party).toBe(1);
  });
});
