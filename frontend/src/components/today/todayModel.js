/**
 * todayModel.js — the pure half of the "I dag" page (pages/TodayPage.jsx).
 *
 * Everything here is a plain function of the GET /api/today payload (plus the
 * MOMS foresight and the needs-you findings), so the page's honesty rules can
 * be tested without rendering:
 *
 *   • a figure is shown only when the payload carries it — null stays null,
 *     never a 0 that reads as a measurement;
 *   • the sales trend is a direction WORD (higher / lower / same) and only
 *     exists when the server found a like-for-like baseline;
 *   • "Kræver dig" lists only things the owner can act on, each with a real
 *     destination or action;
 *   • times are the VENUE's wall clock from the payload (`now_minutes`), never
 *     the browser's — an owner in Portugal looking at a Copenhagen venue sees
 *     Copenhagen time.
 *
 * No React, no i18n: functions return keys + values; the page renders words.
 */

export const LUNCH_SPLIT_MIN = 16 * 60; // a booking before 16:00 is lunch

/** The noun for a count from a one/many key pair (the dictionary has no ICU
 *  plurals): plural(t, 1, "tdWGuest", "tdWGuests") → "gæst". */
export function plural(t, n, one, many) {
  return t(n === 1 ? one : many);
}

/** "HH:MM" → minutes since midnight, or null. */
export function minutesOf(hhmm) {
  if (typeof hhmm !== "string") return null;
  const m = /^(\d{1,2}):(\d{2})/.exec(hhmm.trim());
  if (!m) return null;
  const h = Number(m[1]);
  const mm = Number(m[2]);
  if (h > 47 || mm > 59) return null;
  return h * 60 + mm;
}

/** Minutes on the BUSINESS day's clock: before the cutoff is still last night. */
export function relMinutes(min, cutoffHour = 6) {
  if (min == null) return null;
  return min < cutoffHour * 60 ? min + 1440 : min;
}

/** Greeting by the venue's clock. */
export function greetingKey(nowMin) {
  const h = Math.floor((nowMin ?? 0) / 60);
  if (h >= 5 && h < 10) return "tdGreetMorning";
  if (h >= 10 && h < 12) return "tdGreetForenoon";
  if (h >= 12 && h < 18) return "tdGreetAfternoon";
  return "tdGreetEvening";
}

/** One shift against the venue clock: "on" | "done" | "later". */
export function shiftState(shift, nowMin, cutoffHour = 6) {
  const s = relMinutes(minutesOf(shift?.start_time), cutoffHour);
  let e = relMinutes(minutesOf(shift?.end_time), cutoffHour);
  const n = relMinutes(nowMin, cutoffHour);
  if (s == null || e == null || n == null) return "later";
  if (e <= s) e += 1440; // 18:00–02:00 written as one shift
  if (n < s) return "later";
  if (n >= e) return "done";
  return "on";
}

/** Who is on, who comes next, who has not seen their shift. */
export function staffSummary(shifts, nowMin, cutoffHour = 6) {
  const list = Array.isArray(shifts) ? shifts : [];
  const people = new Set(list.map((s) => s.staff_id));
  let onNow = 0;
  let unseen = 0;
  let drafts = 0;
  const later = [];
  for (const s of list) {
    const st = shiftState(s, nowMin, cutoffHour);
    if (st === "on") onNow += 1;
    if (st === "later") later.push(relMinutes(minutesOf(s.start_time), cutoffHour));
    if (s.status === "draft") drafts += 1;
    else if (!s.confirmed_at) unseen += 1;
  }
  later.sort((a, b) => a - b);
  const next = later.length ? later[0] : null;
  const firstStart = list.length
    ? Math.min(...list.map((s) => relMinutes(minutesOf(s.start_time), cutoffHour)).filter((v) => v != null))
    : null;
  return {
    total: people.size,
    shifts: list.length,
    onNow,
    unseen,
    drafts,
    nextStart: next,
    nextCount: next == null ? 0 : later.filter((m) => m === next).length,
    firstStart: Number.isFinite(firstStart) ? firstStart : null,
  };
}

/** minutes → "HH:MM" (mod 24h). */
export function hhmm(min) {
  if (min == null) return "";
  const m = ((min % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

/** The trend word's key — never a number. */
export function trendKey(trend) {
  if (trend === "higher") return "tdTrendHigher";
  if (trend === "lower") return "tdTrendLower";
  if (trend === "same") return "tdTrendSame";
  return null;
}

/**
 * The "Salg i dag" tile. Returns { mode, amount, trend, compare }:
 *   before    — the day has not started: no amount, yesterday as the sub
 *   closed    — today is locked: the close's total, the trend word if any
 *   sofar     — Sale rows today: the amount so far + last week's measured day
 *   atclose   — a kasserapport venue with nothing rung up yet: the figure
 *               arrives with the close (never "0 kr.")
 *   none      — nothing registered and the venue does not close via kasserapport
 */
export function salesTile(sales, dayState) {
  if (!sales) return null;
  const before = dayState === "before_open" || dayState === "closed_today";
  if (sales.today_closed) {
    return { mode: "closed", amount: sales.today, trend: trendKey(sales.trend), yesterday: sales.yesterday, lastWeek: sales.last_week_same_day };
  }
  if (before && !(sales.today > 0)) {
    return { mode: "before", amount: null, trend: null, yesterday: sales.yesterday, lastWeek: sales.last_week_same_day };
  }
  if (sales.today > 0 || sales.today_sale_count > 0) {
    // A part day is never compared with a whole one — no trend word here.
    return { mode: "sofar", amount: sales.today, trend: null, yesterday: sales.yesterday, lastWeek: sales.last_week_same_day };
  }
  if (sales.uses_daily_close) {
    return { mode: "atclose", amount: null, trend: null, yesterday: sales.yesterday, lastWeek: sales.last_week_same_day };
  }
  return { mode: "none", amount: 0, trend: null, yesterday: sales.yesterday, lastWeek: sales.last_week_same_day };
}

/** Split tonight's book into lunch and dinner by the venue clock. */
export function splitService(items, cutoffHour = 6) {
  const lunch = [];
  const dinner = [];
  for (const r of Array.isArray(items) ? items : []) {
    const m = relMinutes(minutesOf(r.time), cutoffHour);
    if (m != null && m < LUNCH_SPLIT_MIN) lunch.push(r);
    else dinner.push(r);
  }
  return { lunch, dinner };
}

/**
 * The hero's guests figure, honest about WHEN: for a venue with an evening
 * service it is tonight's covers ("Gæster i aften"); with only daytime
 * bookings it is the day's ("Gæster i dag"). Requested bookings are not
 * counted — they wait for the owner's answer.
 */
export function tonightCovers(rsv, cutoffHour = 6) {
  const items = (rsv && rsv.items) || [];
  const { dinner } = splitService(items, cutoffHour);
  const held = (list) => list.filter((r) => r.status !== "requested");
  const pick = dinner.length ? held(dinner) : held(items);
  return {
    when: dinner.length ? "tonight" : "today",
    covers: pick.reduce((a, r) => a + (r.party || 0), 0),
    count: pick.length,
  };
}

/** Which service the toggle opens on: dinner from 15:00 or when lunch is empty. */
export function defaultService(split, nowMin) {
  if (!split.lunch.length) return "dinner";
  if (!split.dinner.length) return "lunch";
  return (nowMin ?? 0) >= 15 * 60 ? "dinner" : "lunch";
}

/** The four kasserapport steps, derived from today's close (never toggled). */
export function closeSteps(todayClose) {
  const s = (todayClose && todayClose.steps) || {};
  const steps = [
    { key: "photo", done: !!s.photo },
    { key: "sales", done: !!s.sales },
    { key: "payments", done: !!s.payments },
    { key: "locked", done: !!s.locked },
  ];
  return { steps, done: steps.filter((x) => x.done).length, status: todayClose?.status || "none" };
}

/**
 * The 4-week heatmap: Monday-aligned rows, the payload's days first, then the
 * rest of this week as "future". Levels 1–3 are the owner's OWN tertiles of
 * locked-day revenue — no borrowed kr. thresholds.
 */
export function heatCells(days, businessDay) {
  const list = Array.isArray(days) ? days : [];
  const revs = list
    .filter((d) => d.status === "confirmed" && typeof d.revenue === "number" && d.revenue > 0)
    .map((d) => d.revenue)
    .sort((a, b) => a - b);
  const q = (p) => revs[Math.min(revs.length - 1, Math.floor(p * revs.length))];
  const bounds = revs.length >= 3 ? [q(1 / 3), q(2 / 3)] : null;
  const level = (rev) => {
    if (!bounds) return 2;
    if (rev <= bounds[0]) return 1;
    if (rev <= bounds[1]) return 2;
    return 3;
  };
  const cells = list.map((d) => {
    let state;
    if (d.date === businessDay) state = d.status === "confirmed" ? "closed" : "today";
    else if (d.status === "confirmed") state = "closed";
    else if (d.status === "draft") state = "draft";
    else if (d.venue_closed) state = "venueClosed";
    else state = "missing";
    return { date: d.date, state, revenue: d.revenue, level: state === "closed" ? level(d.revenue || 0) : 0 };
  });
  while (cells.length % 7 !== 0 || cells.length < 28) {
    cells.push({ date: null, state: "future", revenue: null, level: 0 });
    if (cells.length >= 35) break;
  }
  return { cells, bounds };
}

/** Lønprocent line: an integer % (ex moms) or the honest reason it is absent. */
export function laborLine(labor) {
  if (!labor) return null;
  const pct = labor.labor_pct_ex_moms;
  if (typeof pct === "number" && Number.isFinite(pct)) {
    return { pct: Math.round(pct * 100), days: labor.settled_days || 0 };
  }
  if ((labor.missing_wage || 0) > 0) return { pct: null, reason: "missingWage", count: labor.missing_wage };
  return { pct: null, reason: "noSettledDay" };
}

/**
 * "Kræver dig" — only items with a real action. Returns structured items; the
 * page turns them into words. Order: the owner's own pending answers first
 * (bookings, unpublished week), then the needs-you findings, then the revisor
 * set-up.
 *
 * @param {object} today       GET /api/today payload
 * @param {Array}  findings    GET /api/diagnostics/needs-you (already filtered
 *                             for the owner's dismissals)
 * @param {{hiddenPillars?: Set<string>}} opts
 */
export function buildNeeds(today, findings, { hiddenPillars } = {}) {
  const out = [];
  const hidden = hiddenPillars instanceof Set ? hiddenPillars : new Set();
  const day = today?.business_day;

  const staffOn = !hidden.has("staff");
  const drafts = today?.schedule?.drafts || 0;
  if (staffOn && drafts > 0) {
    out.push({
      id: "publish",
      kind: "publish",
      meta: { week: today.schedule.week_number, count: drafts, weekStart: today.schedule.week_start },
    });
  }

  for (const f of Array.isArray(findings) ? findings : []) {
    if (!f || !f.code) continue;
    if (f.code === "unconfirmed_reservations") {
      if (hidden.has("reservations")) continue;
      // One request tonight → straight to that booking; otherwise the book.
      const reqToday = (today?.reservations?.items || []).filter((r) => r.status === "requested");
      const to = reqToday.length === 1 && (f.meta?.count || 0) === 1
        ? `/reservations?booking=${encodeURIComponent(reqToday[0].id)}&date=${day}`
        : (f.deep_link || "/reservations");
      out.push({ id: `nyq:${f.code}`, kind: "finding", code: f.code, meta: f.meta || {}, severity: f.severity, to,
        guest: reqToday.length === 1 && (f.meta?.count || 0) === 1 ? reqToday[0] : null });
      continue;
    }
    out.push({ id: `nyq:${f.code}:${f.meta?.date || ""}`, kind: "finding", code: f.code, meta: f.meta || {}, severity: f.severity, to: f.deep_link || "/dashboard" });
  }

  const sales = today?.sales;
  if (today?.revisor && !today.revisor.has_accountant_email && (sales?.confirmed_closes_30d || 0) >= 3) {
    out.push({ id: "revisor", kind: "revisor", to: "/bookkeeping-export" });
  }
  return out;
}

/** Sidebar / tab badges: a route gets a count only when there is something to act on. */
export function navBadges(badges) {
  const b = badges || {};
  const out = {};
  if ((b.reservations || 0) > 0) out["/reservations"] = { count: b.reservations, tone: "act" };
  if ((b.schedule || 0) > 0) out["/staff/schedule"] = { count: b.schedule, tone: "draft" };
  if ((b.daily_close || 0) > 0) out["/daily-close"] = { count: null, tone: "missing" };
  return out;
}

/**
 * Should the owner see the legacy Home instead (fresh account, nothing to
 * show yet)? The old Home carries the first-run checklist + demo seeder, which
 * the I dag page does not duplicate.
 */
export function isFreshAccount(today) {
  if (!today) return false;
  const s = today.sales || {};
  const r = today.reservations || {};
  const shifts = today.staff?.shifts || [];
  const closes = (today.close?.days || []).some((d) => d.status !== "none");
  const anyMoney = (s.today || 0) > 0 || (s.yesterday || 0) > 0 || (s.last_week_same_day || 0) > 0 || (s.today_sale_count || 0) > 0;
  const planned = (today.labor?.planned_total || 0) > 0;
  return !anyMoney && !closes && !r.has_book && shifts.length === 0 && !planned && !(s.confirmed_closes_30d > 0);
}

/** Chart window [from, to] in business-day minutes, on whole hours. */
export function chartWindow(today, cutoffHour = 6) {
  const pts = [];
  const h = today?.hours;
  if (h && !h.closed) {
    pts.push(relMinutes(minutesOf(h.open), cutoffHour));
    let c = relMinutes(minutesOf(h.close), cutoffHour);
    const o = relMinutes(minutesOf(h.open), cutoffHour);
    if (c != null && o != null && c <= o) c += 1440;
    pts.push(c);
  }
  for (const s of today?.reservations?.slots || []) {
    pts.push(s.m);
    pts.push(s.m + 30);
  }
  for (const sh of today?.staff?.shifts || []) {
    const s = relMinutes(minutesOf(sh.start_time), cutoffHour);
    let e = relMinutes(minutesOf(sh.end_time), cutoffHour);
    if (s != null && e != null && e <= s) e += 1440;
    pts.push(s, e);
  }
  const vals = pts.filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!vals.length) return null;
  const from = Math.floor(Math.min(...vals) / 60) * 60;
  let to = Math.ceil(Math.max(...vals) / 60) * 60;
  if (to - from < 4 * 60) to = from + 4 * 60;
  return { from, to };
}
