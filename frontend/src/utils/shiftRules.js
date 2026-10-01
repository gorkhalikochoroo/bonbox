/**
 * shiftRules.js — the Vagtplan's labour-rule checks, run in the shift sheet
 * BEFORE "Tilføj vagt" / "Opdater vagt".
 *
 * The server says the same things after the fact (GET /schedules/week-load →
 * the rule strip above the grid and the publish sheet). That was the problem:
 * an owner found out a shift broke the 11-hour rule only once it was saved,
 * and on a phone only at publish. This module answers the question while the
 * times are still being picked, from the week the page has already loaded.
 *
 * It MIRRORS the backend, it does not invent its own rules:
 *   • restShortfalls  ↔ routers/staff.py::_daily_rest_shortfalls — at least
 *     11 CONSECUTIVE hours of rest inside the 24 hours from the start of each
 *     shift. A split day (11–15 + 17–22) is legal; 22:00 → 06:00 is not.
 *   • the 48-hour ceiling and the contract cap ↔ week-load's over_dk48 /
 *     over_cap, silenced the same way (member.hour_limit_warn === false).
 *
 * What it cannot see: shifts outside the loaded week. A Sunday close before
 * a Monday open across the week boundary still surfaces — after saving — in
 * the strip, which reads ±1 day.
 */

export const DK_MIN_REST_HOURS = 11;
export const DK_MAX_WEEK_HOURS = 48;

const DAY_MIN = 24 * 60;

/** "HH:MM" → minutes after midnight, or null for anything unparseable. */
export function clockMinutes(hhmm) {
  const m = /^(\d{1,2}):(\d{2})/.exec(String(hhmm ?? ""));
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

/** A shift as absolute minutes [start, end), an end at or before the start
 *  rolled past midnight — the same overnight rule as calcHours / the server.
 *  Day numbers come from UTC so a DST change can never move a shift. */
export function shiftSpan(dateIso, start, end) {
  const s = clockMinutes(start);
  let e = clockMinutes(end);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(dateIso ?? ""));
  if (s === null || e === null || !m) return null;
  if (e < s) e += DAY_MIN;
  if (e === s) return null; // zero-length — a typo, never work
  const day = Math.round(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) / 86400000);
  return { start: day * DAY_MIN + s, end: day * DAY_MIN + e, date: dateIso.slice(0, 10) };
}

/**
 * 24-hour periods that hold no `minRestHours` of CONSECUTIVE rest.
 *
 * @param {Array<{start:number,end:number,date:string}>} spans one person's shifts
 * @returns {Array<{windowStart:number, windowEnd:number, restHours:number, date:string}>}
 *          one per start date, the shortest rest kept (a split day opens two
 *          periods that describe the same problem).
 */
export function restShortfalls(spans, minRestHours = DK_MIN_REST_HOURS) {
  const rows = (spans || []).filter(Boolean).slice().sort((a, b) => a.start - b.start);
  const worst = new Map();
  for (const opener of rows) {
    const ws = opener.start;
    const we = ws + DAY_MIN;
    const inside = rows
      .filter((r) => r.start < we && r.end > ws)
      .map((r) => [Math.max(r.start, ws), Math.min(r.end, we)])
      .sort((a, b) => a[0] - b[0]);
    let cursor = ws;
    let longest = 0;
    for (const [s, e] of inside) {
      if (s > cursor) longest = Math.max(longest, s - cursor);
      cursor = Math.max(cursor, e);
    }
    if (we > cursor) longest = Math.max(longest, we - cursor);
    const restHours = longest / 60;
    if (restHours + 1e-9 >= minRestHours) continue;
    const prev = worst.get(opener.date);
    if (!prev || restHours < prev.restHours) {
      worst.set(opener.date, { windowStart: ws, windowEnd: we, restHours, date: opener.date });
    }
  }
  return [...worst.values()].sort((a, b) => a.windowStart - b.windowStart);
}

/** Net hours of one shift — calcHours' rule (overnight rolls, break off). */
export function netHours(start, end, breakMinutes = 0) {
  const s = clockMinutes(start);
  const e = clockMinutes(end);
  if (s === null || e === null) return 0;
  let mins = e - s;
  if (mins < 0) mins += DAY_MIN;
  mins -= Number(breakMinutes) || 0;
  return Math.max(0, mins / 60);
}

/**
 * What the shift sheet should warn about for the shift being entered.
 *
 * @param {object} a
 * @param {object} a.member       the staff row (name, max_hours_week, hour_limit_warn)
 * @param {Array}  a.weekShifts   the loaded week's shifts (any staff)
 * @param {string} [a.editingId]  the shift being edited — left out of the count
 * @param {string} a.dateIso      "YYYY-MM-DD"
 * @param {string} a.start        "HH:MM"
 * @param {string} a.end          "HH:MM"
 * @param {number} [a.breakMinutes]
 * @returns {Array<
 *   {kind:"rest", restHours:number, windowStart:number} |
 *   {kind:"dk48", hours:number} |
 *   {kind:"cap", hours:number, cap:number}
 * >}
 */
export function preSaveWarnings({ member, weekShifts, editingId, dateIso, start, end, breakMinutes = 0 }) {
  if (!member) return [];
  const proposed = shiftSpan(dateIso, start, end);
  if (!proposed) return [];
  const mine = (weekShifts || []).filter(
    (s) => s && s.id !== editingId && (s.staff_id === member.id || s.staff_member_id === member.id),
  );
  const out = [];

  // 11-timersreglen — only the periods THIS shift takes part in. A problem
  // elsewhere in the week is already on the strip above the grid; repeating
  // it here would blame the shift being typed for something it did not do.
  const spans = mine.map((s) => shiftSpan(s.date, s.start_time, s.end_time)).filter(Boolean);
  for (const w of restShortfalls([...spans, proposed])) {
    if (w.windowStart < proposed.end && proposed.start < w.windowEnd) {
      out.push({ kind: "rest", restHours: w.restHours, windowStart: w.windowStart });
    }
  }

  // Hour limits — silenced per person exactly like the server's chips.
  if (member.hour_limit_warn !== false) {
    const hours =
      mine.reduce((sum, s) => sum + netHours(s.start_time, s.end_time, s.break_minutes || 0), 0) +
      netHours(start, end, breakMinutes);
    const cap = Number(member.max_hours_week) || null;
    if (hours > DK_MAX_WEEK_HOURS + 0.01) out.push({ kind: "dk48", hours });
    else if (cap && hours > cap + 0.01) out.push({ kind: "cap", hours, cap });
  }
  return out;
}

/** Absolute minutes (from shiftSpan) → { dateIso, hhmm } for display. */
export function minutesToDayTime(abs) {
  const day = Math.floor(abs / DAY_MIN);
  const mins = abs - day * DAY_MIN;
  const d = new Date(day * 86400000);
  const iso = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}-${String(d.getUTCDate()).padStart(2, "0")}`;
  const hhmm = `${String(Math.floor(mins / 60)).padStart(2, "0")}:${String(mins % 60).padStart(2, "0")}`;
  return { dateIso: iso, hhmm };
}
