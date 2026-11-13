/**
 * The I dag page's honesty rules, tested on the pure model
 * (components/today/todayModel.js):
 *   • the sales trend is a WORD, only like-for-like, never a %;
 *   • "Kræver dig" lists only actionable items, each with a real target;
 *   • badges only for actionable counts;
 *   • the venue clock (not the browser's) decides who is on shift, including
 *     a shift that runs past midnight;
 *   • the heatmap's levels are the owner's own tertiles.
 */
import { describe, it, expect } from "vitest";
import {
  buildNeeds, closeSteps, defaultService, expectedLateRows, greetingKey, heatCells, isFreshAccount,
  laborLine, navBadges, plural, salesTile, shiftState, splitService, staffSummary, trendKey,
} from "../components/today/todayModel";

const day = "2026-11-12";

describe("the sales trend is a word, never a number", () => {
  it("maps the server's word to a key and nothing else", () => {
    expect(trendKey("higher")).toBe("tdTrendHigher");
    expect(trendKey("lower")).toBe("tdTrendLower");
    expect(trendKey("same")).toBe("tdTrendSame");
    expect(trendKey(null)).toBeNull();
    expect(trendKey("+12 %")).toBeNull();
  });

  it("shows a word only for a locked day; a part day gets last week's measured figure", () => {
    const sofar = salesTile({ today: 9840, today_closed: false, today_sale_count: 12, trend: "higher", yesterday: 16200, last_week_same_day: 15100 }, "open");
    expect(sofar.mode).toBe("sofar");
    expect(sofar.trend).toBeNull(); // a part day is never compared with a whole one
    expect(sofar.lastWeek).toBe(15100);

    const closed = salesTile({ today: 18000, today_closed: true, today_sale_count: 0, trend: "higher", yesterday: 16200, last_week_same_day: 15100 }, "after_close");
    expect(closed.mode).toBe("closed");
    expect(closed.trend).toBe("tdTrendHigher");
  });

  it("before opening shows no amount; a kasserapport venue never reads 0 kr. mid-day", () => {
    const before = salesTile({ today: 0, today_closed: false, today_sale_count: 0, trend: null, yesterday: 16200 }, "before_open");
    expect(before.mode).toBe("before");
    expect(before.amount).toBeNull();
    expect(before.yesterday).toBe(16200);

    const atClose = salesTile({ today: 0, today_closed: false, today_sale_count: 0, uses_daily_close: true }, "open");
    expect(atClose.mode).toBe("atclose");
    expect(atClose.amount).toBeNull();

    const none = salesTile({ today: 0, today_closed: false, today_sale_count: 0, uses_daily_close: false }, "open");
    expect(none.mode).toBe("none");
  });
});

describe("the venue clock decides who is on", () => {
  const shifts = [
    { id: "a", staff_id: "s1", start_time: "09:00", end_time: "17:00", status: "published", confirmed_at: "x" },
    { id: "b", staff_id: "s2", start_time: "16:00", end_time: "23:00", status: "published", confirmed_at: null },
    { id: "c", staff_id: "s3", start_time: "18:00", end_time: "02:00", status: "draft", confirmed_at: null },
  ];

  it("on / later / done, and a shift past midnight is still on at 01:30", () => {
    expect(shiftState(shifts[0], 14 * 60 + 32)).toBe("on");
    expect(shiftState(shifts[1], 14 * 60 + 32)).toBe("later");
    expect(shiftState(shifts[0], 18 * 60)).toBe("done");
    expect(shiftState(shifts[2], 90, 6)).toBe("on"); // 01:30, before the 06:00 cutoff
  });

  it("summarises counts, the next start, drafts and unseen shifts", () => {
    const s = staffSummary(shifts, 14 * 60 + 32);
    expect(s.total).toBe(3);
    expect(s.onNow).toBe(1);
    expect(s.nextStart).toBe(16 * 60);
    expect(s.nextCount).toBe(1);
    expect(s.drafts).toBe(1);
    expect(s.unseen).toBe(1); // a draft is not "unseen" — staff cannot see drafts
  });

  it("greets by the venue's hour", () => {
    expect(greetingKey(8 * 60 + 15)).toBe("tdGreetMorning");
    expect(greetingKey(14 * 60 + 32)).toBe("tdGreetAfternoon");
    expect(greetingKey(21 * 60)).toBe("tdGreetEvening");
  });
});

describe("Kræver dig — only what the owner can act on", () => {
  const base = {
    business_day: day,
    schedule: { drafts: 6, week_number: 46, week_start: "2026-11-09" },
    reservations: { items: [{ id: "r1", status: "requested", time: "18:00", party: 2, name: "Petersen" }] },
    sales: { confirmed_closes_30d: 10 },
    revisor: { has_accountant_email: false },
  };

  it("lists the unpublished week, the one waiting booking (deep-linked) and the revisor set-up", () => {
    const needs = buildNeeds(base, [{ code: "unconfirmed_reservations", severity: "info", deep_link: "/reservations", meta: { count: 1 } }]);
    expect(needs.map((n) => n.kind)).toEqual(["publish", "finding", "revisor"]);
    expect(needs[0].meta).toEqual({ week: 46, count: 6, weekStart: "2026-11-09" });
    expect(needs[1].to).toBe(`/reservations?booking=r1&date=${day}`);
    expect(needs[1].guest.name).toBe("Petersen");
    // The revisor's e-mail field lives on Profile (Betaling & revisor), not on
    // the export page, which only says "add it on Profile".
    expect(needs[2].to).toBe("/profile#billing");
    // Udgiv opens Vagtplan's own publish sheet for that week — never a blind
    // publish from I dag.
    expect(needs[0].to).toBe("/staff/schedule?week=2026-11-09&publish=1");
  });

  it("a closed day is not a missing kasserapport (the hero agrees)", () => {
    const missing = { code: "close_missing", meta: { date: "2026-11-11" }, deep_link: "/daily-close?date=2026-11-11" };
    const quiet = { ...base, schedule: { drafts: 0 }, revisor: { has_accountant_email: true } };
    const shut = { ...quiet, close: { days: [{ date: "2026-11-11", status: "none", venue_closed: true }] } };
    expect(buildNeeds(shut, [missing])).toEqual([]);
    const open = { ...quiet, close: { days: [{ date: "2026-11-11", status: "none", venue_closed: false }] } };
    expect(buildNeeds(open, [missing]).map((n) => n.code)).toEqual(["close_missing"]);
  });

  it("findings not known yet (null) add no rows — never a guessed list", () => {
    const needs = buildNeeds({ ...base, revisor: { has_accountant_email: true } }, null);
    expect(needs.map((n) => n.kind)).toEqual(["publish"]);
  });

  it("drops what is not actionable: no drafts, a hidden pillar, a saved revisor e-mail, too few closes", () => {
    const quiet = buildNeeds(
      { ...base, schedule: { drafts: 0 }, revisor: { has_accountant_email: true } },
      [{ code: "unconfirmed_reservations", meta: { count: 3 }, deep_link: "/reservations" }],
      { hiddenPillars: new Set(["reservations"]) },
    );
    expect(quiet).toEqual([]);
    const fewCloses = buildNeeds({ ...base, schedule: { drafts: 0 }, sales: { confirmed_closes_30d: 2 } }, []);
    expect(fewCloses).toEqual([]);
    const staffOff = buildNeeds({ ...base, revisor: { has_accountant_email: true } }, [], { hiddenPillars: new Set(["staff"]) });
    expect(staffOff).toEqual([]);
  });

  it("several waiting bookings go to the book, not to one of them", () => {
    const needs = buildNeeds({ ...base, schedule: { drafts: 0 }, revisor: { has_accountant_email: true } },
      [{ code: "unconfirmed_reservations", meta: { count: 3 }, deep_link: "/reservations" }]);
    expect(needs).toHaveLength(1);
    expect(needs[0].to).toBe("/reservations");
    expect(needs[0].guest).toBeNull();
  });

  it("Egenkontrol's finding (egenkontrol_due) is a Kræver-dig row like the others, into /egenkontrol", () => {
    // The server's _detect_egenkontrol_due — the same finding the old Home's
    // NeedsYouQueue shows. Its words come from the shared needs-you renderers.
    const ek = { code: "egenkontrol_due", severity: "warn", deep_link: "/egenkontrol", meta: { date: day, missing: 1, deviations: 0, count: 1 } };
    const needs = buildNeeds({ ...base, schedule: { drafts: 0 }, revisor: { has_accountant_email: true } }, [ek]);
    expect(needs).toEqual([{ id: `nyq:egenkontrol_due:${day}`, kind: "finding", code: "egenkontrol_due", meta: ek.meta, severity: "warn", to: "/egenkontrol" }]);
    // No row when the server has none (no active checks, nothing missing).
    expect(buildNeeds({ ...base, schedule: { drafts: 0 }, revisor: { has_accountant_email: true } }, [])).toEqual([]);
  });

  it("every item has somewhere to go or something to do", () => {
    const needs = buildNeeds(base, [
      { code: "close_missing", meta: { date: "2026-11-11" }, deep_link: "/daily-close?date=2026-11-11" },
      { code: "stale_bank_feed", meta: { days: 4 }, deep_link: "/connections" },
    ]);
    for (const n of needs) expect(typeof n.to).toBe("string");
  });
});

describe("the needs-you rows held for, from /today's own badges (sizing only)", () => {
  const today = (badges, over = {}) => ({ business_day: day, badges, close: { days: [] }, ...over });
  const keyOf = (f) => `${f.code}|${f.meta?.date ?? f.meta?.count ?? ""}`;

  it("a waiting booking request and yesterday's missing kasserapport are each one row", () => {
    expect(expectedLateRows(today({ reservations: 0, schedule: 4, daily_close: 0 }))).toBe(0);
    expect(expectedLateRows(today({ reservations: 3, schedule: 0, daily_close: 0 }))).toBe(1);
    expect(expectedLateRows(today({ reservations: 1, schedule: 0, daily_close: 1 }))).toBe(2);
    // the unpublished week is not late: /today already carries it
    expect(expectedLateRows(today({ reservations: 0, schedule: 6, daily_close: 1 }))).toBe(1);
  });

  it("never holds for what will not come: hidden bookings, a dismissed finding, a shut day", () => {
    expect(expectedLateRows(today({ reservations: 2, daily_close: 0 }), { hiddenPillars: new Set(["reservations"]) })).toBe(0);
    const gone = new Set(["unconfirmed_reservations|2", "close_missing|2026-11-11"]);
    const isDismissed = (f) => gone.has(keyOf(f));
    expect(expectedLateRows(today({ reservations: 2, daily_close: 1 }), { isDismissed })).toBe(0);
    // a changed count re-surfaces the request row (the needs-you key carries the count)
    expect(expectedLateRows(today({ reservations: 3, daily_close: 0 }), { isDismissed })).toBe(1);
    const shut = today({ reservations: 0, daily_close: 1 }, { close: { days: [{ date: "2026-11-11", status: "none", venue_closed: true }] } });
    expect(expectedLateRows(shut)).toBe(0);
  });

  it("no badges (an older payload) holds nothing", () => {
    expect(expectedLateRows({ business_day: day })).toBe(0);
    expect(expectedLateRows(null)).toBe(0);
  });
});

describe("badges only for actionable counts", () => {
  it("maps counts to routes and leaves zeros out", () => {
    expect(navBadges({ reservations: 2, schedule: 6, daily_close: 1 })).toEqual({
      "/reservations": { count: 2, tone: "act" },
      "/staff/schedule": { count: 6, tone: "draft" },
      "/daily-close": { count: null, tone: "missing" },
    });
    expect(navBadges({ reservations: 0, schedule: 0, daily_close: 0 })).toEqual({});
    expect(navBadges(null)).toEqual({});
  });
});

describe("kasserapport card", () => {
  it("derives the four steps from today's close, never from taps", () => {
    expect(closeSteps({ status: "none", steps: {} }).done).toBe(0);
    const draft = closeSteps({ status: "draft", steps: { photo: true, sales: true, payments: false, locked: false } });
    expect(draft.done).toBe(2);
    expect(closeSteps({ status: "confirmed", steps: { photo: true, sales: true, payments: true, locked: true } }).done).toBe(4);
  });

  it("levels are the owner's own tertiles; the grid pads the rest of the week as future", () => {
    const days = [];
    for (let i = 0; i < 25; i++) {
      const d = new Date(Date.UTC(2026, 9, 19 + i)).toISOString().slice(0, 10);
      days.push({ date: d, status: i % 7 === 0 ? "none" : "confirmed", revenue: i % 7 === 0 ? null : 10000 + i * 1000, venue_closed: i % 7 === 0 });
    }
    const { cells, bounds } = heatCells(days, days[days.length - 1].date);
    expect(cells.length % 7).toBe(0);
    expect(cells.length).toBe(28);
    expect(cells.slice(25).every((c) => c.state === "future")).toBe(true);
    expect(bounds[0]).toBeLessThan(bounds[1]);
    expect(cells[0].state).toBe("venueClosed");
    expect(new Set(cells.filter((c) => c.state === "closed").map((c) => c.level))).toEqual(new Set([1, 2, 3]));
  });
});

describe("lønprocent line", () => {
  it("an integer % from the ex-moms figure, or the honest reason it is absent", () => {
    expect(laborLine({ labor_pct_ex_moms: 0.3125, settled_days: 3 })).toEqual({ pct: 31, days: 3 });
    expect(laborLine({ labor_pct_ex_moms: null, missing_wage: 2 })).toEqual({ pct: null, reason: "missingWage", count: 2 });
    expect(laborLine({ labor_pct_ex_moms: null, missing_wage: 0 })).toEqual({ pct: null, reason: "noSettledDay" });
  });
});

describe("services and plurals", () => {
  it("splits lunch and dinner at 16:00 on the venue clock", () => {
    const split = splitService([{ time: "12:00" }, { time: "13:30" }, { time: "18:00" }, { time: "00:30" }]);
    expect(split.lunch).toHaveLength(2);
    expect(split.dinner).toHaveLength(2); // 00:30 is tonight's service
    expect(defaultService(split, 11 * 60)).toBe("lunch");
    expect(defaultService(split, 15 * 60)).toBe("dinner");
    expect(defaultService({ lunch: [], dinner: [{}] }, 11 * 60)).toBe("dinner");
  });

  it("picks the one/many noun", () => {
    const t = (k) => k;
    expect(plural(t, 1, "one", "many")).toBe("one");
    expect(plural(t, 0, "one", "many")).toBe("many");
    expect(plural(t, 4, "one", "many")).toBe("many");
  });
});

describe("a fresh account keeps the old Home (first-run + demo seeder)", () => {
  it("is fresh only when there is nothing at all to show", () => {
    const empty = { sales: { today: 0 }, reservations: { has_book: false }, staff: { shifts: [] }, close: { days: [] }, labor: { planned_total: 0 } };
    expect(isFreshAccount(empty)).toBe(true);
    expect(isFreshAccount({ ...empty, reservations: { has_book: true } })).toBe(false);
    expect(isFreshAccount({ ...empty, sales: { today: 0, yesterday: 4000 } })).toBe(false);
    expect(isFreshAccount({ ...empty, staff: { shifts: [{}] } })).toBe(false);
    expect(isFreshAccount(null)).toBe(false);
  });
});
