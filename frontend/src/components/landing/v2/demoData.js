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
 *   - Bistro Nørrebro, a small owner-run bistro open every evening (the
 *     booking card, floor plan, phones and gavekort already named it).
 *   - The rota (below): five people, a cook and a server on every evening and
 *     the manager behind the bar on Saturday — 15 shifts, 82 hours, ~14.650
 *     kr. of estimated wages (hours x rate, weekend supplement), 29 % of the
 *     week's revenue ex MOMS against a 30 % target. Every shift has the same
 *     30-minute break, and each contract is the hours that person is rostered.
 *   - Last month: 268.400 kr. through the till (incl. MOMS). MOMS, goods,
 *     wages and rent/running costs come off it and 28.650 kr. is left — 13 %
 *     of the revenue ex MOMS. The month's wages ARE the rota's estimate over
 *     a month (x 52/12), so the profit bar and the rota cannot disagree. That
 *     is a believable result for a place where the owner draws no salary from
 *     the staff budget.
 *   - Last week: 62.480 kr., 6 % up on the week before — the SAME week the AI
 *     panel answers about.
 *   - Yesterday: 9.360 kr. booked; 8.860 kr. in payments — the 500 kr. gap is
 *     the "kasserapport doesn't tie out" alert.
 *   - MOMS (half-yearly, the DK small-business cadence the countdown shows):
 *     about 31.000 kr. a month net (output MOMS less the MOMS on goods and
 *     running costs), so ~185.700 kr. for a half-year. The weekly amount to
 *     put aside is worked out from the days left, the way the product's own
 *     MOMS card does it (demoMomsWeekly).
 *
 * Figures are kroner, whole numbers. Format with formatKr() so Danish and
 * English readers both get "268.400" (the page is Danish-first; the demo is a
 * Danish business, so the amounts stay in Danish notation in both languages,
 * as the rest of the demo copy already did).
 */

export const DEMO_WEEK = { last: 62480, before: 58940 };
export const DEMO_WEEK_DELTA_PCT = Math.round((DEMO_WEEK.last / DEMO_WEEK.before - 1) * 100);

export const DEMO_YESTERDAY = { revenue: 9360, payments: 8860, sales: 34 };

/**
 * The demo rota: the same five people on the grid, the phones and the hero's
 * "on shift" row. Day index 0 = Monday. A cook and a server every evening,
 * the manager on the bar on Saturday. Every shift carries a 30-minute break
 * (span - 0.5 h = hours). Wages are the product's own estimate shape — hours
 * x the person's rate, +40 kr./h on Saturday and Sunday — rounded:
 *   server 145 kr./h (Agnes), 148 kr./h (Alma); kitchen 180 kr./h;
 *   manager 175 kr./h.
 */
export const DEMO_ROTA = [
  {
    name: "Agnes Kristensen",
    role: "server",
    contract: 15,
    shifts: {
      0: { from: "17:00", to: "22:30", hours: 5, dept: "floor", wage: 725 },
      4: { from: "17:00", to: "22:30", hours: 5, dept: "floor", wage: 725 },
      6: { from: "17:00", to: "22:30", hours: 5, dept: "floor", wage: 925 },
    },
  },
  {
    name: "Aksel Olsen",
    role: "manager",
    contract: null,
    shifts: {
      5: { from: "18:00", to: "23:30", hours: 5, dept: "bar", wage: 1075 },
    },
  },
  {
    name: "Alma Rasmussen",
    role: "server",
    contract: 20,
    shifts: {
      1: { from: "17:00", to: "22:30", hours: 5, dept: "floor", wage: 740 },
      2: { from: "17:00", to: "22:30", hours: 5, dept: "floor", wage: 740 },
      3: { from: "17:00", to: "22:30", hours: 5, dept: "floor", wage: 740 },
      5: { from: "17:00", to: "22:30", hours: 5, dept: "floor", wage: 940 },
    },
  },
  {
    name: "Clara Larsen",
    role: "kitchen",
    contract: 24,
    shifts: {
      1: { from: "16:00", to: "22:30", hours: 6, dept: "kitchen", wage: 1080 },
      2: { from: "16:00", to: "22:30", hours: 6, dept: "kitchen", wage: 1080 },
      3: { from: "16:00", to: "22:30", hours: 6, dept: "kitchen", wage: 1080 },
      4: { from: "16:00", to: "22:30", hours: 6, dept: "kitchen", wage: 1080 },
    },
  },
  {
    name: "Emil Nielsen",
    role: "kitchen",
    contract: 18,
    shifts: {
      0: { from: "16:00", to: "22:30", hours: 6, dept: "kitchen", wage: 1080 },
      5: { from: "16:00", to: "22:30", hours: 6, dept: "kitchen", wage: 1320 },
      6: { from: "16:00", to: "22:30", hours: 6, dept: "kitchen", wage: 1320 },
    },
  },
];

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

/** Last month. Wages are the rota's weekly estimate over a month (x 52/12);
    running costs are what is left once the rest is taken off. */
const MONTH_REVENUE = 268400; // through the till, incl. MOMS
const MONTH_MOMS = 53680; // 20 % of the incl. figure (25 % on the ex figure)
const MONTH_GOODS = 64420; // food and drink bought, ex MOMS (30 % of net)
const MONTH_WAGES = Math.round((rotaTotals().wage * 52) / 12); // 63.483 (30 % of net)
const MONTH_PROFIT = 28650;
export const DEMO_MONTH = {
  revenue: MONTH_REVENUE,
  moms: MONTH_MOMS,
  goods: MONTH_GOODS,
  wages: MONTH_WAGES,
  // rent, power, insurance, card fees, ex MOMS (58.167, 27 % of net)
  running: MONTH_REVENUE - MONTH_MOMS - MONTH_GOODS - MONTH_WAGES - MONTH_PROFIT,
  profit: MONTH_PROFIT,
};

/** Net revenue (ex MOMS) and the margin on it, derived — never typed. */
export const DEMO_NET = DEMO_MONTH.revenue - DEMO_MONTH.moms;
export const DEMO_MARGIN_PCT = Math.round((DEMO_MONTH.profit / DEMO_NET) * 100);

/** MOMS for one half-year (the amount the countdown is about). */
export const DEMO_MOMS = { halfYear: 185700 };

/**
 * The weekly MOMS set-aside for `daysUntil` days to the frist — the SAME
 * arithmetic as the product's MOMS card (components/dashboard/
 * ComplianceCountdownCard.jsx): whole weeks left (at least 1), rounded UP to
 * a clean 100 kr. so it never under-funds. Inside the last week the product
 * stops quoting a weekly rate and says the amount is due; this returns null
 * then, and the hero card does the same.
 */
export function demoMomsWeekly(daysUntil, total = DEMO_MOMS.halfYear) {
  if (!(daysUntil >= 7)) return null;
  const weeks = Math.max(1, Math.round(daysUntil / 7));
  return Math.ceil(total / weeks / 100) * 100;
}

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

/** The person whose phone the staff section shows. */
export const DEMO_PHONE_PERSON = "Alma Rasmussen";

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
