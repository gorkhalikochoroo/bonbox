/**
 * ONE demo business behind every picture on the landing page (push 9, B4).
 *
 * The landing review (15 Oct 2026) found the demos telling four different
 * stories: the hero claimed an 82 % margin (revenue minus "expenses", no wages,
 * no MOMS), "this week" was +12 % while the AI panel said +6 % for the same
 * week, and the rota, the phones and the alert were frozen in July. A Danish
 * owner reads an 82 % café margin as either a lie or a product that does not
 * understand their business.
 *
 * So every widget reads its figures from here, and every date is worked out
 * from today:
 *   - Bistro Nørrebro, a small owner-run bistro (the booking card, floor plan,
 *     phones and gavekort already named it).
 *   - Last month: 268.400 kr. through the till (incl. MOMS). MOMS, goods,
 *     wages and rent/running costs come off it and 28.650 kr. is left — 13 %
 *     of the revenue ex MOMS. That is a believable result for a place where the
 *     owner draws no salary from the staff budget.
 *   - Last week: 62.480 kr., 6 % up on the week before — the SAME week the AI
 *     panel answers about.
 *   - Yesterday: 9.360 kr. booked; 8.860 kr. in payments — the 500 kr. gap is
 *     the "kasserapport doesn't tie out" alert.
 *   - MOMS (half-yearly, the DK small-business cadence the countdown shows):
 *     about 31.000 kr. a month net, so ~185.700 kr. for a half-year and ~7.100
 *     kr. a week to put aside.
 *   - The rota: the same four people everywhere (grid, phones, "on shift").
 *
 * Figures are kroner, whole numbers. Format with formatKr() so Danish and
 * English readers both get "268.400" (the page is Danish-first; the demo is a
 * Danish business, so the amounts stay in Danish notation in both languages,
 * as the rest of the demo copy already did).
 */

export const DEMO_MONTH = {
  revenue: 268400, // through the till, incl. MOMS
  moms: 53680, // 20 % of the incl. figure (25 % on the ex figure)
  goods: 64420, // food and drink bought, ex MOMS (30 % of net)
  wages: 68710, // staff wages (32 % of net)
  running: 52940, // rent, power, insurance, card fees, ex MOMS
  profit: 28650,
};

/** Net revenue (ex MOMS) and the margin on it, derived — never typed. */
export const DEMO_NET = DEMO_MONTH.revenue - DEMO_MONTH.moms;
export const DEMO_MARGIN_PCT = Math.round((DEMO_MONTH.profit / DEMO_NET) * 100);

export const DEMO_WEEK = { last: 62480, before: 58940 };
export const DEMO_WEEK_DELTA_PCT = Math.round((DEMO_WEEK.last / DEMO_WEEK.before - 1) * 100);

export const DEMO_YESTERDAY = { revenue: 9360, payments: 8860, sales: 34 };

/** MOMS for one half-year and the weekly amount that covers it. */
export const DEMO_MOMS = { halfYear: 185700, weekly: 7100 };

/** The bar under "profit last month": each slice as a share of the till. */
export function demoMonthSlices() {
  const m = DEMO_MONTH;
  return [
    // Costs in quiet slates, darkest first; only what is left is coloured.
    { key: "moms", kr: m.moms, cls: "bg-slate-500" },
    { key: "goods", kr: m.goods, cls: "bg-slate-400" },
    { key: "wages", kr: m.wages, cls: "bg-slate-300" },
    { key: "running", kr: m.running, cls: "bg-slate-200" },
    { key: "profit", kr: m.profit, cls: "bg-bb-green" },
  ].map((s) => ({ ...s, pct: (s.kr / m.revenue) * 100 }));
}

/** 268400 -> "268.400" (Danish grouping in both languages, see above). */
export function formatKr(n) {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

/**
 * The demo rota: the same four people on the grid, the phones and the hero's
 * "on shift" row. Day index 0 = Monday. Wage figures are the product's own
 * estimate shape (hours x rate, weekend supplement), rounded.
 */
export const DEMO_ROTA = [
  {
    name: "Agnes Kristensen",
    role: "server",
    contract: 18.75,
    shifts: {
      0: { from: "16:00", to: "23:00", hours: 6.25, dept: "floor", wage: 906 },
      4: { from: "16:00", to: "23:00", hours: 6.25, dept: "floor", wage: 906 },
      6: { from: "16:00", to: "23:00", hours: 6.25, dept: "floor", wage: 1156 },
    },
  },
  {
    name: "Aksel Olsen",
    role: "manager",
    contract: null,
    shifts: {
      5: { from: "18:00", to: "00:30", hours: 6.5, dept: "bar", wage: 1235 },
    },
  },
  {
    name: "Alma Rasmussen",
    role: "server",
    contract: 12.5,
    shifts: {
      1: { from: "16:00", to: "23:00", hours: 6.25, dept: "floor", wage: 925 },
      5: { from: "16:00", to: "23:00", hours: 6.25, dept: "floor", wage: 1175 },
    },
  },
  {
    name: "Clara Larsen",
    role: "kitchen",
    contract: 25,
    shifts: {
      2: { from: "15:00", to: "23:00", hours: 7.5, dept: "kitchen", wage: 1410 },
      3: { from: "15:00", to: "23:00", hours: 7.5, dept: "kitchen", wage: 1410 },
    },
  },
];

/** The person whose phone the staff section shows. */
export const DEMO_PHONE_PERSON = "Alma Rasmussen";

export function rotaTotals(rota = DEMO_ROTA) {
  let hours = 0;
  let wage = 0;
  let shifts = 0;
  for (const p of rota) {
    for (const s of Object.values(p.shifts)) {
      hours += s.hours;
      wage += s.wage;
      shifts += 1;
    }
  }
  return { hours, wage, shifts };
}

/** Wage cost as a share of the week's expected revenue ex MOMS. */
export function rotaLabourPct(rota = DEMO_ROTA) {
  const net = DEMO_WEEK.last / 1.25;
  return Math.round((rotaTotals(rota).wage / net) * 100);
}

/** Monday 00:00 of the week `now` is in. */
export function mondayOf(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return d;
}

/** The seven dates of the current week, Monday first. */
export function weekDates(now = new Date()) {
  const mon = mondayOf(now);
  return Array.from({ length: 7 }, (_, i) => {
    const d = new Date(mon);
    d.setDate(mon.getDate() + i);
    return d;
  });
}

/** ISO-8601 week number. */
export function isoWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
}

/** Today's weekday as a rota index (0 = Monday). */
export function todayIndex(now = new Date()) {
  return (now.getDay() + 6) % 7;
}

/** Who is on today, per the rota (every day has someone). */
export function onShiftToday(now = new Date(), rota = DEMO_ROTA) {
  const i = todayIndex(now);
  const p = rota.find((r) => r.shifts[i]);
  return p ? { person: p, shift: p.shifts[i] } : null;
}

/**
 * The phone person's next shift on or after today: this week if one is left,
 * else the same weekday next week. Returns the date and the shift.
 */
export function nextShiftFor(name = DEMO_PHONE_PERSON, now = new Date(), rota = DEMO_ROTA) {
  const p = rota.find((r) => r.name === name);
  if (!p) return null;
  const days = Object.keys(p.shifts).map(Number).sort((a, b) => a - b);
  const t = todayIndex(now);
  const mon = mondayOf(now);
  const idx = days.find((d) => d >= t);
  const offset = idx !== undefined ? idx : days[0] + 7;
  const date = new Date(mon);
  date.setDate(mon.getDate() + offset);
  return { date, shift: p.shifts[offset % 7], dayIndex: offset % 7 };
}

/** Yesterday's date (for the kasserapport alert). */
export function yesterday(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  d.setDate(d.getDate() - 1);
  return d;
}

/** The calendar month before `now` (the one "last month" covers). */
export function lastMonth(now = new Date()) {
  return new Date(now.getFullYear(), now.getMonth() - 1, 1);
}
