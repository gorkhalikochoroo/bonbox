// Tonight at a glance (reservations v2, canvas 11 Nov 2026).
//
// The numbers the owner page's "I aften" row, the phone's summary card and
// the host stand read. Pure: every one comes from the day's book, the tables
// and the waitlist already on screen — nothing is estimated, and where a
// number cannot be known it is null, never 0 (computed ≠ measured).
//
//   liveStatus     — the row's live word: at the table N min / N min late /
//                    in N min / its stored status.
//   peakSeats      — the most seats booked at one moment, as a COUNT over the
//                    venue's seats ("25/28 kl. 19.30"), never a percentage.
//   needsAction    — late parties (the 5-minute grace of serviceClock) and
//                    requests waiting for a yes.
//   firstWaiting   — the first real party on the Venteliste (server order).
//   waitlistFits   — which waiting party a table seats NOW, for their whole
//                    sitting — the stand's own seatingNow rule, so the
//                    waitlist and the drop-in row can never disagree.
//   weekStrip      — seven days for the day strip: covers booked, a bar
//                    relative to the busiest day SHOWN, closed only where
//                    the saved hours say so.

import { lateMinutes, overdueMinutes } from "./serviceClock";
import { seatingNow, stampIso } from "./hostStand";
import { windowsFor } from "./bookingTimes";
import { isHeldForCheck } from "./bookingHeld";

/** A confirmed party starting within this many minutes reads "in N min". */
export const SOON_MIN = 15;

/** Statuses a booked peak counts: the server's BOOKED_COVER_STATUSES
 *  (confirmed, seated, completed — a party that has eaten and left was still
 *  booked at 19.30, so the peak never shrinks as the night empties) plus a
 *  request nobody has answered yet, unless it is HELD (isHeldForCheck). */
const HOLDING = ["requested", "confirmed", "seated", "completed"];

const startMs = (r) => {
  const v = r?.starts_at ? new Date(r.starts_at).getTime() : NaN;
  return Number.isFinite(v) ? v : null;
};

/** Whole minutes a seated party has been at the table, from its seated_at
 *  stamp — null when the stamp is missing (never the booked time instead). */
export function minutesAtTable(r, nowMs) {
  if (!r || r.status !== "seated" || !nowMs) return null;
  const iso = stampIso(r.seated_at);
  if (!iso) return null;
  const m = Math.floor((nowMs - new Date(iso).getTime()) / 60000);
  return m >= 0 ? m : 0;
}

/**
 * The live word for one booking:
 *   { kind: "seated", min, over }  — at the table (min null = unknown)
 *   { kind: "late", min }          — confirmed, 5+ min past its start
 *   { kind: "soon", min }          — confirmed, starts within SOON_MIN (0 = now)
 *   { kind: <status> }             — everything else, as stored
 * Live words only on the day being served (`onToday`); another day is its
 * stored status.
 */
export function liveStatus(r, nowMs, onToday = true, soonMin = SOON_MIN) {
  if (!r) return { kind: "unknown" };
  if (r.status === "seated") {
    return {
      kind: "seated",
      min: onToday ? minutesAtTable(r, nowMs) : null,
      over: overdueMinutes(r, nowMs, onToday),
    };
  }
  if (r.status === "confirmed" && onToday && nowMs) {
    const late = lateMinutes(r, nowMs, onToday);
    if (late) return { kind: "late", min: late };
    const s = startMs(r);
    if (s != null) {
      const until = Math.ceil((s - nowMs) / 60000);
      if (until <= soonMin) return { kind: "soon", min: Math.max(0, until) };
    }
  }
  return { kind: r.status || "unknown" };
}

const minOfDay = (iso) => {
  const d = new Date(iso);
  return d.getHours() * 60 + d.getMinutes();
};
const pad = (n) => String(n).padStart(2, "0");

/**
 * The most seats booked at the same moment of the day, and when:
 * { peak, at: "19.30" | null }. Departures before arrivals at the same
 * minute, so back-to-back turns do not double-count. A held online booking
 * (R1) holds nothing until confirmed — `groupThreshold` is the venue's.
 */
export function peakSeats(reservations, { groupThreshold } = {}) {
  const events = [];
  for (const r of reservations || []) {
    if (!HOLDING.includes(r.status) || !r.starts_at) continue;
    if (isHeldForCheck(r, groupThreshold)) continue;
    const s = minOfDay(r.starts_at);
    let e = r.ends_at ? minOfDay(r.ends_at) : s + 90;
    if (e <= s) e += 1440;
    const size = Number(r.party_size) || 0;
    if (!size) continue;
    events.push([s, size], [e, -size]);
  }
  if (!events.length) return { peak: 0, at: null };
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let cur = 0;
  let peak = 0;
  let at = null;
  for (const [m, d] of events) {
    cur += d;
    if (cur > peak) {
      peak = cur;
      at = m;
    }
  }
  return { peak, at: at == null ? null : `${pad(Math.floor((at % 1440) / 60))}.${pad(at % 60)}` };
}

/**
 * What needs the host: { late: [{ r, min }], requested, total }. Late =
 * serviceClock's rule (confirmed, 5+ min past its start, today only), the
 * longest-waiting first; requested = bookings nobody has said yes to.
 */
export function needsAction(reservations, nowMs, onToday = true) {
  const late = [];
  let requested = 0;
  for (const r of reservations || []) {
    if (r.cancel_reason === "walk_in_removed") continue;
    if (r.status === "requested") requested += 1;
    const m = lateMinutes(r, nowMs, onToday);
    if (m) late.push({ r, min: m });
  }
  late.sort((a, b) => b.min - a.min);
  return { late, requested, total: late.length + requested };
}

const WAITING = ["waiting", "notified"];

/** The first REAL party on the Venteliste (still waiting or told), or null.
 *  The server's order is the truth (GET /reservations/waitlist): real guests
 *  first-come-first-served, then the entries it HELD (a robot's, a phone the
 *  owner marked as spam). A held entry is never named here. */
export function firstWaiting(entries) {
  return (entries || []).find((e) => e && !e.held && WAITING.includes(e.status || "waiting")) || null;
}

/** A waiting party's wished-for time, as a window in ms: [from − 15 min,
 *  to] — or ±30 min around a single "around 20.00" — or null when the party
 *  named no time (any time suits them). */
const WISH_LEAD_MS = 15 * 60000;
const WISH_AROUND_MS = 30 * 60000;
export function wishWindow(e) {
  const from = e?.desired_from ? new Date(e.desired_from).getTime() : NaN;
  if (!Number.isFinite(from)) return null;
  const to = e?.desired_to ? new Date(e.desired_to).getTime() : NaN;
  return Number.isFinite(to) && to >= from
    ? [from - WISH_LEAD_MS, to]
    : [from - WISH_AROUND_MS, from + WISH_AROUND_MS];
}

/**
 * Which waiting parties a seating fits NOW: Map(entry id → { label, tableIds,
 * seats }). Only a real party (never a HELD entry) whose wished-for time
 * holds now, or who named none (wishWindow). The drop-in row's rule (seatingNow): free for the party's whole
 * sitting, the smallest single table first, else the tables the venue joins.
 * `sittingFor(n)` is the venue's turn time; without it (rules not loaded)
 * nothing is claimed — an empty map.
 */
export function waitlistFits({ entries, reservations, resources, nowMs, sittingFor, combine = null }) {
  const out = new Map();
  if (typeof sittingFor !== "function" || !Array.isArray(resources) || !resources.length || !nowMs) return out;
  for (const e of entries || []) {
    if (!e || e.held || !WAITING.includes(e.status || "waiting")) continue;
    // A party waiting for 20.00 is not told "free now" at 17.30.
    const wish = wishWindow(e);
    if (wish && (nowMs < wish[0] || nowMs > wish[1])) continue;
    const size = Number(e.party_size) || 0;
    if (!size) continue;
    const seat = seatingNow({ reservations, resources, nowMs, size, sittingMin: sittingFor(size), combine });
    if (seat) out.set(e.id, seat);
  }
  return out;
}

/**
 * Who gets the one-tap "Seat at Bord 2" (fix round 12 Nov): Map(entry id →
 * { fit, primary, nextInLine }). waitlistFits answers each party on its own,
 * so two parties can both be told Bord 2 fits. In list order (the server's:
 * first come, first served), the first party whose tables no earlier party
 * claimed gets the primary button; a later party whose tables overlap one
 * already claimed keeps a quiet "Seat" (the host may still choose them).
 * `nextInLine` marks a primary that another party is waiting on as well.
 * `fitOf(entry)` → { tableIds, … } | null.
 */
export function seatLineup(entries, fitOf) {
  const out = new Map();
  if (typeof fitOf !== "function") return out;
  const claimedBy = new Map(); // table id → entry id of the primary
  for (const e of entries || []) {
    if (!e) continue;
    const fit = fitOf(e);
    const ids = Array.isArray(fit?.tableIds) ? fit.tableIds.map(String) : [];
    if (!ids.length) continue;
    const owners = ids.map((id) => claimedBy.get(id)).filter((x) => x != null);
    if (!owners.length) {
      ids.forEach((id) => claimedBy.set(id, e.id));
      out.set(e.id, { fit, primary: true, nextInLine: false });
    } else {
      out.set(e.id, { fit, primary: false, nextInLine: false });
      for (const o of owners) {
        const first = out.get(o);
        if (first) first.nextInLine = true;
      }
    }
  }
  return out;
}

/**
 * The time a waiting party was told ("lovet ca. 17.19"): { ms, late } — late
 * once that time has passed while they still wait — or null when nothing
 * was quoted. The server stamps UTC with a "Z"; one without a zone is read
 * as UTC too, as the row's waited-minutes are.
 */
export function quotedCue(quotedAt, nowMs) {
  if (!quotedAt) return null;
  const s = String(quotedAt);
  const ms = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s}Z`);
  if (!Number.isFinite(ms)) return null;
  return { ms, late: Number.isFinite(nowMs) && nowMs > ms };
}

const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** `iso` moved by `n` days (calendar days, local). */
export function addDays(iso, n) {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + n);
  return isoOf(d);
}

/**
 * Seven days from `start` for the day strip:
 *   { iso, weekday (0 = Sunday), day, covers (null = not known), bookings,
 *     fill 0..1, closed, isToday, selected }
 * `loads` maps an ISO day to month-load's { covers, bookings }; a day the
 * month answered for but which is absent had nothing booked (0); a month
 * that did not answer leaves its days unknown (null). The bar is relative to
 * the busiest day in the strip — "heavier than the others", not "% full".
 */
export function weekStrip({ start, loads = {}, knownMonths = [], openHours = null, today, selected }) {
  const days = [];
  for (let i = 0; i < 7; i += 1) {
    const iso = addDays(start, i);
    const known = knownMonths.includes(iso.slice(0, 7));
    const row = loads[iso];
    const covers = row ? Number(row.covers) || 0 : known ? 0 : null;
    const wins = windowsFor(iso, openHours);
    days.push({
      iso,
      weekday: new Date(`${iso}T12:00:00`).getDay(),
      day: Number(iso.slice(8, 10)),
      covers,
      bookings: row ? Number(row.bookings) || 0 : known ? 0 : null,
      // Closed only on the saved hours' word — and a day with bookings on it
      // is not drawn closed whatever the hours say.
      closed: Array.isArray(wins) && wins.length === 0 && !covers,
      isToday: iso === today,
      selected: iso === selected,
    });
  }
  const max = Math.max(0, ...days.map((d) => d.covers || 0));
  return days.map((d) => ({ ...d, fill: max > 0 && d.covers ? d.covers / max : 0 }));
}
