/**
 * The venue's weekly opening hours on the guest booking page (booking push
 * p3), as pure words: utils/venueHours.js.
 *
 * The server sends the booking engine's own week, one entry per weekday
 * (null = no claim for that day); these helpers only group and word it.
 * Weekday names come from Intl pinned to UTC on both sides, so a guest west
 * or east of UTC never sees the names shifted by a day.
 */
import { afterEach, describe, expect, it } from "vitest";
import {
  WEEK_KEYS,
  dayRangeLabel,
  emptyWord,
  groupWeek,
  todayKey,
  weekdayName,
  windowsLabel,
} from "../utils/venueHours";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const D = (windows, by = "opening") => ({ windows, by });
const DINNER = [["17:00", "22:00"]];
const LATE = [["17:00", "23:00"]];

describe("groupWeek", () => {
  it("merges consecutive days with equal windows, a null day breaks the run, Sunday never wraps into Monday", () => {
    const days = {
      mon: D(DINNER), tue: D(DINNER), wed: null, thu: D(DINNER),
      fri: D(LATE), sat: D([["12:00", "23:00"]], "booking"), sun: D(DINNER),
    };
    const g = groupWeek(days);
    expect(g.map((x) => [x.from, x.to])).toEqual([
      ["mon", "tue"], ["thu", "thu"], ["fri", "fri"], ["sat", "sat"], ["sun", "sun"],
    ]);
    expect(g[0].day).toEqual(D(DINNER));
    // Sunday equals Monday, but the week starts on Monday: no wrap.
    expect(g.at(-1).from).toBe("sun");
  });

  it("an all-equal week is one group; nothing declared is no group", () => {
    const all = Object.fromEntries(WEEK_KEYS.map((k) => [k, D(DINNER)]));
    expect(groupWeek(all)).toEqual([{ from: "mon", to: "sun", day: D(DINNER) }]);
    expect(groupWeek(Object.fromEntries(WEEK_KEYS.map((k) => [k, null])))).toEqual([]);
    expect(groupWeek(null)).toEqual([]);
  });

  it("open days with equal windows merge whatever their source (a partial booking-hours card)", () => {
    const g = groupWeek({
      mon: D(DINNER, "opening"), tue: D(DINNER, "booking"), wed: D(DINNER, "opening"),
      thu: D(DINNER, "opening"), fri: null, sat: null, sun: null,
    });
    expect(g.map((x) => [x.from, x.to])).toEqual([["mon", "thu"]]);
    const t = (k, fb) => da[k] ?? fb;
    expect(g.map((x) => `${dayRangeLabel(x, "da")} ${windowsLabel(x.day.windows) || emptyWord(x.day.by, false, t)}`))
      .toEqual(["Mandag–torsdag 17:00–22:00"]);
    expect(dayRangeLabel(g[0], "en")).toBe("Monday–Thursday");
  });

  it("closed days merge only with closed days of the same source", () => {
    const g = groupWeek({ mon: null, tue: null, wed: null, thu: null, fri: null, sat: D([], "opening"), sun: D([], "booking") });
    expect(g.map((x) => [x.from, x.to, x.day.by])).toEqual([["sat", "sat", "opening"], ["sun", "sun", "booking"]]);
  });
});

describe("dayRangeLabel", () => {
  it("is Monday-first and capitalised", () => {
    expect(dayRangeLabel({ from: "mon", to: "thu" }, "da")).toBe("Mandag–torsdag");
    expect(dayRangeLabel({ from: "mon", to: "thu" }, "en")).toBe("Monday–Thursday");
    expect(dayRangeLabel({ from: "sun", to: "sun" }, "da")).toBe("Søndag");
    expect(dayRangeLabel({ from: "fri", to: "sat" }, "en")).toBe("Friday–Saturday");
  });
});

describe("windowsLabel", () => {
  it("formats past-midnight windows and returns null for a closed day", () => {
    expect(windowsLabel([["17:00", "22:00"]])).toBe("17:00–22:00");
    expect(windowsLabel([["18:00", "02:00"]])).toBe("18:00–02:00");
    expect(windowsLabel([["11:30", "14:00"], ["17:00", "22:00"]])).toBe("11:30–14:00, 17:00–22:00");
    expect(windowsLabel([])).toBeNull();
    expect(windowsLabel(null)).toBeNull();
  });
});

describe("emptyWord", () => {
  const t = (k, fb) => da[k] ?? fb;
  it("follows the source that closed the day", () => {
    expect(emptyWord("opening", false, t)).toBe("Lukket");
    expect(emptyWord("opening", true, t)).toBe("Lukket");
    expect(emptyWord("booking", false, t)).toBe("Ingen bordbestilling");
    expect(emptyWord("booking", true, t)).toBe("Ingen tidsbestilling");
  });
});

describe("weekday names do not shift west or east of UTC", () => {
  const env = globalThis.process.env;
  const saved = env.TZ;
  afterEach(() => {
    if (saved === undefined) delete env.TZ;
    else env.TZ = saved;
  });
  it.each(["America/New_York", "Pacific/Kiritimati", "UTC"])("in %s", (tz) => {
    env.TZ = tz;
    expect(weekdayName("mon", "da")).toBe("Mandag");
    expect(weekdayName("sun", "en")).toBe("Sunday");
    expect(weekdayName("sun", "da")).toBe("Søndag");
    expect(WEEK_KEYS.map((k) => weekdayName(k, "en"))).toEqual(
      ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]);
  });
});

describe("todayKey", () => {
  it("maps the local iso date to its weekday", () => {
    expect(todayKey("2026-10-23")).toBe("fri");
    expect(todayKey("2026-10-25")).toBe("sun");
    expect(todayKey("2026-10-26")).toBe("mon");
    expect(todayKey("")).toBeNull();
  });
});

describe("the words exist in both languages", () => {
  it("every hours key is real DA and EN text", () => {
    for (const k of ["rsvpVenueHoursOpening", "rsvpVenueHoursTodayLabel", "rsvpVenueHoursTodayTag", "rsvpVenueHoursClosed",
      "rsvpVenueHoursNoBooking", "rsvpVenueHoursNoBookingAppt", "rsvpVenueHoursShowAll"]) {
      expect(typeof da[k], k).toBe("string");
      expect(typeof en[k], k).toBe("string");
      expect(da[k]).not.toBe(en[k]);
    }
  });
});
