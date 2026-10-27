// Booking hours on the owner's cards (R8, 27 Oct 2026): one or two periods a
// day — lunch and dinner — and, for a table venue, a last booking time per
// period. Pure: no React, no clock.
//
// What the server stores per weekday (reservation_service.day_periods):
//   "closed" | "HH:MM-HH:MM" (one period, every value before R8)
//   | [{ open: "HH:MM", close: "HH:MM", last?: "HH:MM" }, …]   (1–2 periods)
// The card's state per weekday: { closed: bool, periods: [{ open, close, last }] }
// where last "" = automatic (closing time minus the table time).
//
// serializeBookingHours writes the old string whenever it says it all (one
// period, no last booking time), so a week saved without the new controls
// reads exactly as before — on this server and on an older one.
import { sittingMinutes, toMin } from "./bookingTimes";
import { weekdayName } from "./venueHours";

export const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
export const MAX_PERIODS = 2;
// The shape the hours card reads and writes; the server says the same in
// GET /reservations/settings (hours_shape) and is told it back on save.
export const HOURS_SHAPE = 2;

const HHMM = /^(\d{1,2}):(\d{2})$/;

/** "HH:MM" for minutes on the day's line (a value past midnight wraps). */
export function minToHhmm(m) {
  const x = ((Math.round(m) % 1440) + 1440) % 1440;
  return `${String(Math.floor(x / 60)).padStart(2, "0")}:${String(x % 60).padStart(2, "0")}`;
}

/** A clock value the card can store: "H:MM"/"HH:MM", 00:00–23:59. */
export function validHhmm(s) {
  const m = HHMM.exec(String(s ?? "").trim());
  return !!m && Number(m[1]) <= 23 && Number(m[2]) <= 59;
}

const period = (open, close, last = "") => ({ open, close, last });

/** The restaurant's suggestion: 11–22 every day, one period. */
export function defaultBookingHours() {
  const o = {};
  DAY_KEYS.forEach((k) => {
    o[k] = { closed: false, periods: [period("11:00", "22:00")] };
  });
  return o;
}

/** A salon's suggestion (R7): Tue–Fri 09–17, Sat 09–14, Mon + Sun closed. */
export function defaultSalonHours() {
  const o = {};
  DAY_KEYS.forEach((k) => {
    o[k] = { closed: false, periods: [period("09:00", "17:00")] };
  });
  o.sat = { closed: false, periods: [period("09:00", "14:00")] };
  o.mon = { closed: true, periods: [period("09:00", "17:00")] };
  o.sun = { closed: true, periods: [period("09:00", "17:00")] };
  return o;
}

/**
 * One stored weekday value → the card's periods, or null when it says
 * nothing readable ("closed" is handled by the caller). An old string keeps
 * its old reading: a missing half falls back to the suggestion's.
 */
export function readPeriods(v, base = period("11:00", "22:00")) {
  if (typeof v === "string" && v.includes("-")) {
    const [open, close] = v.split("-");
    return [period(open || base.open, close || base.close)];
  }
  if (Array.isArray(v)) {
    const out = v.slice(0, MAX_PERIODS).map((p) => {
      if (typeof p === "string" && p.includes("-")) {
        const [open, close] = p.split("-");
        return validHhmm(open) && validHhmm(close) ? period(open, close) : null;
      }
      if (p && typeof p === "object" && validHhmm(p.open) && validHhmm(p.close)) {
        return period(p.open, p.close, validHhmm(p.last) ? p.last : "");
      }
      return null;
    }).filter(Boolean);
    return out.length ? out : null;
  }
  return null;
}

/**
 * The stored week → the card's week. `suggest` makes the week a day falls
 * back to when nothing is saved for it (and the times a closed day reopens
 * on): the restaurant's 11–22, or a salon's week (R7).
 */
export function parseBookingHours(bh, suggest = defaultBookingHours) {
  const out = suggest();
  if (bh && typeof bh === "object") {
    DAY_KEYS.forEach((k) => {
      const v = bh[k];
      const base = out[k];
      if (v === "closed") {
        out[k] = { closed: true, periods: base.periods };
        return;
      }
      const periods = readPeriods(v, base.periods[0]);
      if (periods) out[k] = { closed: false, periods };
    });
  }
  return out;
}

/**
 * What the hours card shows on load (booking push p3): what the TABLE
 * engine books. A weekday the booking hours don't set is booked on the
 * Profile opening hours (reservation_service.restaurant_windows), and the
 * server's `open_hours` is that week — so when the venue has declared
 * hours, such a day shows its real hours (or closed) instead of the 11–22
 * suggestion the engine never books. Never for a salon: its self-chair reads
 * only the booking hours (R7). Nothing is saved until the owner presses Gem.
 */
export function cardBookingHours(bh, { openHours, hoursDeclared, isProvider } = {}) {
  if (isProvider) return parseBookingHours(bh, defaultSalonHours);
  const out = parseBookingHours(bh);
  if (hoursDeclared !== true || !openHours || typeof openHours !== "object") return out;
  if (!DAY_KEYS.some((k) => Array.isArray(openHours[k]) && openHours[k].length > 0)) return out;
  DAY_KEYS.forEach((k) => {
    if (bh && typeof bh === "object" && bh[k]) return; // the booking hours decide it
    const w = openHours[k];
    if (!Array.isArray(w)) return;
    out[k] = w.length === 0
      ? { closed: true, periods: [period("11:00", "22:00")] }
      : {
          closed: false,
          periods: w.slice(0, MAX_PERIODS).map(([a, b, l]) => period(a || "11:00", b || "22:00", l || "")),
        };
  });
  return out;
}

/**
 * The card's week → what PUT /reservations/settings stores. `withLast`
 * false (a salon: its chairs never read it) leaves every last booking time
 * out. One period without one is the old string.
 */
export function serializeBookingHours(hours, { withLast = true } = {}) {
  const out = {};
  DAY_KEYS.forEach((k) => {
    const d = hours[k];
    if (!d || d.closed) {
      out[k] = "closed";
      return;
    }
    const ps = (d.periods || []).map((p) => ({ open: p.open, close: p.close, last: withLast ? p.last || "" : "" }));
    if (ps.length === 1 && !ps[0].last) {
      out[k] = `${ps[0].open}-${ps[0].close}`;
      return;
    }
    out[k] = ps.map((p) => (p.last ? { open: p.open, close: p.close, last: p.last } : { open: p.open, close: p.close }));
  });
  return out;
}

/**
 * Has the owner SAVED booking hours (any weekday "closed", "HH:MM-HH:MM", or
 * periods)? The backend's test for the same thing (booking_hours_saved): the
 * salon first-run card then shows these hours, and keeps them unless edited.
 */
export function hasSavedBookingHours(bh) {
  return !!bh && typeof bh === "object" && Object.values(bh).some(
    (v) => v === "closed" || (typeof v === "string" && v.includes("-")) || (Array.isArray(v) && !!readPeriods(v)),
  );
}

/** A period on the day's line in minutes: close at or before open = past midnight. */
export function periodSpan(p) {
  const a = toMin(p.open);
  let b = toMin(p.close);
  if (b <= a) b += 1440;
  let last = null;
  if (p.last && validHhmm(p.last)) {
    last = toMin(p.last);
    if (last < a) last += 1440;
  }
  return { a, b, last };
}

/**
 * The first weekday the card cannot save, or null — the server's own rules
 * (reservation_service._clean_day_hours): every time filled in, at most two
 * periods, the second starting when the first ends or later, a last booking
 * time inside its period.
 * → { day: "tue", problem: "bad_time" | "too_many" | "overlap" | "last_outside" }
 */
export function hoursProblem(hours, { withLast = true } = {}) {
  for (const k of DAY_KEYS) {
    const d = hours?.[k];
    if (!d || d.closed) continue;
    const ps = d.periods || [];
    if (!ps.length) return { day: k, problem: "bad_time" };
    if (ps.length > MAX_PERIODS) return { day: k, problem: "too_many" };
    if (ps.some((p) => !validHhmm(p.open) || !validHhmm(p.close))) return { day: k, problem: "bad_time" };
    if (withLast && ps.some((p) => p.last && !validHhmm(p.last))) return { day: k, problem: "bad_time" };
    const spans = ps.map(periodSpan).sort((x, y) => x.a - y.a);
    if (withLast && spans.some((s) => s.last != null && s.last > s.b)) return { day: k, problem: "last_outside" };
    for (let i = 1; i < spans.length; i++) {
      if (spans[i - 1].b > spans[i].a) return { day: k, problem: "overlap" };
    }
  }
  return null;
}

/** Words for a problem — "Tirsdag: de to perioder overlapper …". */
export function hoursProblemWords(problem, t, lang = "da") {
  if (!problem) return "";
  const day = problem.day ? weekdayName(problem.day, lang) : "";
  switch (problem.problem) {
    case "overlap":
      return t("rsvpHoursErrOverlap", "{day}: the two periods overlap. The second has to start when the first ends, or later.", { day });
    case "bad_time":
      return t("rsvpHoursErrTime", "{day}: a time is missing.", { day });
    case "last_outside":
      return t("rsvpHoursErrLast", "{day}: the last booking has to be inside its period.", { day });
    case "too_many":
      return t("rsvpHoursErrTooMany", "{day}: two periods at most.", { day });
    default:
      return t("rsvpHoursSaveError", "Couldn't save opening hours.");
  }
}

/** The starts a period offers on a `step`-minute grid, opening to closing. */
export function gridTimes(p, step = 15) {
  if (!validHhmm(p?.open) || !validHhmm(p?.close)) return [];
  const { a, b } = periodSpan(p);
  const n = Number(step) > 0 ? Number(step) : 15;
  const out = [];
  for (let m = a; m <= b; m += n) out.push(minToHhmm(m));
  return out;
}

/**
 * The automatic last booking: the last grid start whose whole sitting ends
 * by closing (the engine's time_grid without a last booking time), or null
 * when no sitting fits the period.
 */
export function autoLast(p, step = 15, sitting = 90) {
  if (!validHhmm(p?.open) || !validHhmm(p?.close)) return null;
  const { a, b } = periodSpan(p);
  const n = Number(step) > 0 ? Number(step) : 15;
  const s = Math.max(0, Number(sitting) || 0);
  let last = null;
  for (let m = a; m + s <= b; m += n) last = m;
  return last == null ? null : minToHhmm(last);
}

/**
 * A chosen last booking time kept honest after the period or the step
 * changed: snapped down onto the period's grid, or back to automatic ("")
 * when it no longer lies inside the period.
 */
export function fitLast(p, step = 15) {
  if (!p?.last) return p;
  if (!validHhmm(p.last) || !validHhmm(p.open) || !validHhmm(p.close)) return { ...p, last: "" };
  const { a, b, last } = periodSpan(p);
  if (last == null || last > b) return { ...p, last: "" };
  const n = Number(step) > 0 ? Number(step) : 15;
  const snapped = a + Math.floor((last - a) / n) * n;
  return { ...p, last: minToHhmm(snapped) };
}

/** Every chosen last booking time of the week fitted to a new step. */
export function snapLasts(hours, step) {
  const out = {};
  DAY_KEYS.forEach((k) => {
    const d = hours[k];
    out[k] = d ? { ...d, periods: (d.periods || []).map((p) => fitLast(p, step)) } : d;
  });
  return out;
}

/**
 * "Tilføj periode": the day's second period, chosen so one tap usually gives
 * the right day. A restaurant ("meal") splits a day that spans the
 * afternoon into lunch and dinner (11–22 → 11–14.30 + 17.30–22), adds dinner
 * after a lunch, or lunch before a dinner. A salon, a shop or a workshop
 * ("day") takes a lunch break out of a day that spans midday (09–17 →
 * 09–12 + 12.30–17). The owner adjusts the times either way.
 */
export function addPeriod(periods, mode = "meal") {
  if (!Array.isArray(periods) || periods.length !== 1) return periods;
  const p = periods[0];
  if (!validHhmm(p.open) || !validHhmm(p.close)) return periods;
  const { a, b } = periodSpan(p);
  const [cutA, cutB] = mode === "day" ? [12 * 60, 12 * 60 + 30] : [14 * 60 + 30, 17 * 60 + 30];
  if (a < cutA && b > cutB) {
    return [period(p.open, minToHhmm(cutA)), period(minToHhmm(cutB), p.close, p.last)];
  }
  if (mode === "meal") {
    if (b <= 17 * 60) return [p, period("17:30", "22:00")];
    if (a >= 15 * 60) return [period("11:30", "14:30"), p];
  } else {
    if (b <= 12 * 60) return [p, period("13:00", "17:00")];
    if (a >= 13 * 60) return [period("09:00", "12:00"), p];
  }
  if (b + 120 <= 24 * 60) return [p, period(minToHhmm(b + 60), minToHhmm(Math.min(b + 240, 24 * 60 - 1)))];
  return [period(minToHhmm(Math.max(0, a - 240)), minToHhmm(Math.max(0, a - 60))), p];
}

/** The day without period `i` (an open day keeps at least one). */
export function removePeriod(periods, i) {
  if (!Array.isArray(periods) || periods.length < 2) return periods;
  return periods.filter((_, j) => j !== i);
}

/** The first open period of the week, Monday first (examples start there). */
export function firstOpenPeriod(hours) {
  for (const k of DAY_KEYS) {
    const d = hours?.[k];
    if (d && !d.closed && d.periods?.length && validHhmm(d.periods[0].open)) return d.periods[0];
  }
  return null;
}

/**
 * The first few start times a step gives — from the first open period's
 * opening when there is one — written the way the owner reads a clock
 * ("17.30" in Danish, "17:30" in English).
 */
export function exampleStarts(hours, step, lang = "da", count = 3) {
  const p = firstOpenPeriod(hours);
  const from = p ? toMin(p.open) : 10 * 60;
  const n = Number(step) > 0 ? Number(step) : 15;
  const sep = lang === "da" ? "." : ":";
  return Array.from({ length: count }, (_, i) => minToHhmm(from + i * n).replace(":", sep));
}

/** The sitting the automatic last booking is counted with: two guests at a
 *  restaurant (the guest page's default party), one person at a shop or a
 *  workshop (its page books one). */
export function lastBookingSitting(rules, { booksOne = false } = {}) {
  return sittingMinutes(booksOne ? 1 : 2, rules);
}

/** The start-time step the engine walks (reservation_service.slot_step): a
 *  stored whole number 5–120, else 15. */
export function slotStepOf(settings) {
  const raw = settings?.slot_granularity_min;
  if (typeof raw === "boolean") return 15;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 5 && n <= 120 ? n : 15;
}
