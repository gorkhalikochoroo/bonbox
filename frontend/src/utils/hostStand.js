/**
 * Host-stand readouts, lifted out of ReservationsPage so every rule is
 * testable: the one-tap drop-in by party size (and its honest wait), the
 * covers in the stand header, the finished list, and which tables a combined
 * party joins on the floor.
 *
 * Every number here is COMPUTED from the day's bookings — never measured. So
 * each one either says how it was made ("ca." before a time worked out from
 * booked ends) or is not shown at all.
 */
import { windowsFor, toMin } from "./bookingTimes";

/** The drop-in buttons: 1–5, and 6 standing for "6 or more". */
export const WALK_IN_SIZES = [1, 2, 3, 4, 5, 6];

const HOLDING = ["requested", "confirmed", "seated"];

function msOf(iso) {
  if (!iso) return null;
  const v = new Date(iso).getTime();
  return Number.isFinite(v) ? v : null;
}

function heldIds(r) {
  return Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length
    ? r.combined_resource_ids.map(String)
    : r.resource_id
      ? [String(r.resource_id)]
      : [];
}

const seatsOf = (t) => Number(t?.capacity_seats) || 0;

/**
 * The earliest moment (ms) a table can take a new party for a whole sitting
 * of `sittingMin` minutes, from now on — `nowMs` itself when it can right now.
 *
 * Built only from what the book knows: each live booking's own window
 * (starts_at → ends_at, the end the turn-time setting gave it). Returns null
 * when that is NOT knowable: a party still seated past its booked end has no
 * end anyone can read, so the table's free time is unknown, not "now".
 * A booking whose whole window is already behind us holds nothing.
 */
export function tableFreeAt(table, reservations, nowMs, sittingMin) {
  const id = String(table.id);
  const spans = [];
  for (const r of reservations || []) {
    if (!HOLDING.includes(r.status)) continue;
    if (!heldIds(r).includes(id)) continue;
    const s = msOf(r.starts_at);
    const e = msOf(r.ends_at) ?? (s != null ? s + (Number(r.duration_min) || 90) * 60000 : null);
    if (s == null || e == null) return null;
    if (r.status === "seated") {
      if (e <= nowMs) return null;
      spans.push([Math.min(s, nowMs), e]);
    } else {
      if (e <= nowMs) continue;
      spans.push([s, e]);
    }
  }
  const need = Math.max(1, Number(sittingMin) || 90) * 60000;
  const candidates = [nowMs, ...spans.map(([, e]) => e).filter((e) => e > nowMs)].sort((a, b) => a - b);
  for (const c of candidates) {
    if (!spans.some(([s, e]) => s < c + need && c < e)) return c;
  }
  return null;
}

/**
 * Close of the day's last open window, in ms — or null when the hours are
 * unknown (never declared) or the day is closed. A wait that only ends after
 * closing is not a wait, so the drop-in buttons leave it out.
 */
export function closeMsFor(dayIso, openHours) {
  const wins = windowsFor(dayIso, openHours);
  if (!Array.isArray(wins) || wins.length === 0) return null;
  let last = null;
  for (const [a, b] of wins) {
    const start = toMin(a);
    let end = toMin(b);
    if (end <= start) end += 1440;
    if (last == null || end > last) last = end;
  }
  if (last == null || !Number.isFinite(last)) return null;
  const midnight = new Date(`${dayIso}T00:00:00`).getTime();
  return midnight + last * 60000;
}

/**
 * One entry per drop-in size:
 *   { size, freeNow, tableId, label, at }
 * freeNow — a table that seats `size` is free for their whole sitting now;
 *   tableId/label name the best one (the SMALLEST that fits, the same honest
 *   auto-pick as the seat sheet — never the six-top for a couple).
 * at — otherwise, when the first fitting table frees for a whole sitting
 *   (ms), or null when no fitting table's free time is knowable, or it falls
 *   after closing.
 */
export function walkInOptions({ reservations, resources, nowMs, sittingFor, closeMs = null, sizes = WALK_IN_SIZES }) {
  const tables = (resources || []).filter((t) => t.kind !== "provider" && t.is_active !== false);
  return sizes.map((size) => {
    const need = sittingFor(size);
    let best = null;
    let soonest = null;
    for (const t of tables) {
      if (seatsOf(t) < size) continue;
      const at = tableFreeAt(t, reservations, nowMs, need);
      if (at == null) continue;
      if (at <= nowMs) {
        if (!best || seatsOf(t) < seatsOf(best)) best = t;
      } else if (soonest == null || at < soonest) {
        soonest = at;
      }
    }
    if (best) return { size, freeNow: true, tableId: String(best.id), label: best.label, at: nowMs };
    const at = soonest != null && (closeMs == null || soonest < closeMs) ? soonest : null;
    return { size, freeNow: false, tableId: null, label: null, at };
  });
}

/**
 * The stand header's covers: guests and parties seated now, still expected
 * (confirmed, not yet arrived — late ones included until they are marked a
 * no-show), and finished. A request is not counted as expected: nobody has
 * said yes to it. A removed drop-in never was a booking.
 */
export function coverCounts(reservations) {
  const zero = () => ({ guests: 0, parties: 0 });
  const out = { seated: zero(), expected: zero(), finished: zero() };
  for (const r of reservations || []) {
    if (r.cancel_reason === "walk_in_removed") continue;
    const k =
      r.status === "seated" ? "seated" : r.status === "confirmed" ? "expected" : r.status === "completed" ? "finished" : null;
    if (!k) continue;
    out[k].guests += Number(r.party_size) || 0;
    out[k].parties += 1;
  }
  return out;
}

/** Whole minutes a finished party sat — null unless both stamps are known. */
export function stayMinutes(r) {
  const a = msOf(r?.seated_at);
  const b = msOf(r?.completed_at);
  if (a == null || b == null || b < a) return null;
  return Math.round((b - a) / 60000);
}

/** Finished list order: by the time they sat down (booked time when the
 *  seat time is unknown), earliest first. */
export function bySeatedTime(a, b) {
  const x = msOf(a.seated_at) ?? msOf(a.starts_at) ?? 0;
  const y = msOf(b.seated_at) ?? msOf(b.starts_at) ?? 0;
  return x - y;
}

/**
 * Which tables a combined party joins, as links between table centres
 * ({ id, status, edges: [[a, b], …] }, a/b = { id, x, y } in % of the room).
 * Only tables the floor already places are joined — no geometry is invented —
 * and the links are a shortest tree over those positions, so three tables in
 * a row read as one chain, never a triangle across the room.
 * `aspect` is the room's width / height, so distances compare like on screen.
 */
export function comboLinks(bookings, posById, aspect = 1.6) {
  const out = [];
  const seen = new Set();
  for (const r of bookings || []) {
    if (!r || seen.has(String(r.id))) continue;
    seen.add(String(r.id));
    const ids = Array.isArray(r.combined_resource_ids)
      ? [...new Set(r.combined_resource_ids.map(String))]
      : [];
    const pts = ids
      .filter((id) => posById[id] && Number.isFinite(posById[id].x) && Number.isFinite(posById[id].y))
      .map((id) => ({ id, x: posById[id].x, y: posById[id].y }));
    if (pts.length < 2) continue;
    const dist = (p, q) => Math.hypot((p.x - q.x) * aspect, p.y - q.y);
    const tree = [pts[0]];
    const rest = pts.slice(1);
    const edges = [];
    while (rest.length) {
      let pick = null;
      for (const a of tree) {
        for (let i = 0; i < rest.length; i += 1) {
          const d = dist(a, rest[i]);
          if (!pick || d < pick.d) pick = { a, i, d };
        }
      }
      const b = rest.splice(pick.i, 1)[0];
      edges.push([pick.a, b]);
      tree.push(b);
    }
    out.push({ id: String(r.id), status: r.status, edges });
  }
  return out;
}
