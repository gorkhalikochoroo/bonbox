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
import { parseServerTime } from "./serverTime";

/** The drop-in buttons: 1–5, and 6 standing for "6 or more". */
export const WALK_IN_SIZES = [1, 2, 3, 4, 5, 6];

const HOLDING = ["requested", "confirmed", "seated"];

// A booking's own times (starts_at, ends_at): naive Europe/Copenhagen wall
// clock, which new Date() reads right (utils/serverTime.js says why).
function msOf(iso) {
  if (!iso) return null;
  const v = new Date(iso).getTime();
  return Number.isFinite(v) ? v : null;
}

// A stamp the server writes with utc_now() (seated_at, completed_at): UTC,
// sent as "2026-10-12T17:20:03.123456Z". Read through parseServerTime, the one
// reader for such stamps — UTC whether or not the "Z" is there.
function stampMs(v) {
  const d = parseServerTime(v);
  return d ? d.getTime() : null;
}

/** A seated_at / completed_at stamp as an ISO instant for the clock helpers
 *  (fmtTime) — "" when there is none. */
export function stampIso(v) {
  const d = parseServerTime(v);
  return d ? d.toISOString() : "";
}

function heldIds(r) {
  return Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length
    ? r.combined_resource_ids.map(String)
    : r.resource_id
      ? [String(r.resource_id)]
      : [];
}

const seatsOf = (t) => Number(t?.capacity_seats) || 0;
// A missing zone is its own group, as in the engine (getattr(r, "zone", None)).
const zoneOf = (t) => (t?.zone === undefined ? null : t.zone);
// The order the floor and the book name tables in: "2" before "10".
const byLabel = (a, b) =>
  String(a?.label || "").localeCompare(String(b?.label || ""), "da", { numeric: true, sensitivity: "base" });
const minutes = (m) => Math.max(1, Number(m) || 90) * 60000;

/**
 * A table's live holds from now on, as [start, end) spans in ms — or null
 * when its free time cannot be known: a party still seated past its booked
 * end has no end anyone can read, and a hold without a readable window is no
 * better. A booking whose whole window is already behind us holds nothing.
 */
function holdsOn(table, reservations, nowMs) {
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
  return spans;
}

// Free for a whole sitting [c, c + need) — touching ends do not overlap.
const clearFor = (spans, c, need) => !spans.some(([s, e]) => s < c + need && c < e);

/**
 * The earliest moment (ms) a table can take a new party for a whole sitting
 * of `sittingMin` minutes, from now on — `nowMs` itself when it can right now.
 *
 * Built only from what the book knows: each live booking's own window
 * (starts_at → ends_at, the end the turn-time setting gave it). Returns null
 * when that is NOT knowable (see holdsOn) — unknown, not "now".
 */
export function tableFreeAt(table, reservations, nowMs, sittingMin) {
  const spans = holdsOn(table, reservations, nowMs);
  if (spans == null) return null;
  const need = minutes(sittingMin);
  const candidates = [nowMs, ...spans.map(([, e]) => e).filter((e) => e > nowMs)].sort((a, b) => a - b);
  for (const c of candidates) {
    if (clearFor(spans, c, need)) return c;
  }
  return null;
}

// ── Joining tables: the booking engine's own rule ───────────────────────
// A port of availability_engine.find_combo, NOT a second opinion: the door
// may only call a set of tables "free" when the engine would seat a party
// there itself. backend/tests/test_find_combo_parity.py runs the same cases
// (src/__tests__/fixtures/findComboCases.json) through the Python original,
// so the two cannot drift apart silently.

/** Max combinable tables considered per zone (the engine's _COMBO_POOL_CAP). */
export const COMBO_POOL_CAP = 24;

function* combinations(pool, k, start = 0, picked = []) {
  if (picked.length === k) {
    yield picked;
    return;
  }
  for (let i = start; i <= pool.length - (k - picked.length); i += 1) {
    yield* combinations(pool, k, i + 1, [...picked, pool[i]]);
  }
}

// Python orders str by code point; ids are ASCII, so < on strings agrees.
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
function keyLess(a, b) {
  if (a[0] !== b[0]) return a[0] < b[0];
  if (a[1] !== b[1]) return a[1] < b[1];
  for (let i = 0; i < Math.min(a[2].length, b[2].length); i += 1) {
    const c = cmpStr(a[2][i], b[2][i]);
    if (c) return c < 0;
  }
  return a[2].length < b[2].length;
}

/**
 * The engine's combination for a party, from tables already known to be free
 * for the whole sitting: only tables flagged `combinable`, one zone at a time
 * (an indoor table never joins a terrace one), at most `maxComboSize` tables;
 * fewest tables, then fewest empty seats, then id order. Table ids (≥ 2), or
 * null when no combination seats the party.
 */
export function findCombo(partySize, freeTables, maxComboSize) {
  const max = Number.parseInt(maxComboSize, 10) || 0;
  if (max < 2) return null;
  const free = (freeTables || []).filter((t) => t && t.combinable);
  if (free.length < 2) return null;
  const zones = new Map();
  for (const t of free) {
    const z = zoneOf(t);
    if (!zones.has(z)) zones.set(z, []);
    zones.get(z).push(t);
  }
  let bestKey = null;
  let bestIds = null;
  for (const group of zones.values()) {
    let pool = [...group].sort((a, b) => seatsOf(a) - seatsOf(b) || cmpStr(String(a.id), String(b.id)));
    if (pool.length > COMBO_POOL_CAP) pool = pool.slice(0, COMBO_POOL_CAP);
    const biggestFirst = pool.map(seatsOf).sort((a, b) => b - a);
    const upper = Math.min(max, pool.length);
    for (let size = 2; size <= upper; size += 1) {
      // Not a rule, only a shortcut (the answer is the engine's either way):
      // when the `size` biggest tables of the zone fall short, every set of
      // that size does — this runs on the stand's minute tick, in the browser.
      if (biggestFirst.slice(0, size).reduce((s, n) => s + n, 0) < partySize) continue;
      let found = false;
      for (const combo of combinations(pool, size)) {
        const total = combo.reduce((s, t) => s + seatsOf(t), 0);
        if (total < partySize) continue;
        found = true;
        const key = [size, total - partySize, combo.map((t) => String(t.id))];
        if (!bestKey || keyLess(key, bestKey)) {
          bestKey = key;
          bestIds = key[2];
        }
      }
      // Fewer tables always wins, so a zone that seats them at this size has
      // nothing better further up.
      if (found) break;
    }
  }
  return bestIds;
}

/**
 * The venue's joining rules, read from its booking settings the way
 * reservation_service.build_config reads them (on unless switched off; at
 * most 3 tables unless set). null when the settings are not known.
 */
export function comboRules(settings) {
  if (!settings) return null;
  return {
    enabled: settings.combine_enabled == null ? true : Boolean(settings.combine_enabled),
    maxSize: Number.parseInt(settings.max_combo_size, 10) || 3,
  };
}

// Could this table take part in seating `size` at all — alone, or in some
// combination the engine would allow (same zone, combinable, ≤ maxSize)?
function couldSeat(t, size, tables, maxSize) {
  if (seatsOf(t) >= size) return true;
  if (!(maxSize >= 2) || !t.combinable) return false;
  const z = zoneOf(t);
  const others = tables
    .filter((o) => o !== t && o.combinable && zoneOf(o) === z)
    .map(seatsOf)
    .sort((a, b) => b - a)
    .slice(0, maxSize - 1);
  return seatsOf(t) + others.reduce((s, n) => s + n, 0) >= size;
}

// The engine's seating at moment `c` (assign_seats): the smallest single
// table that seats the party, else — when joining is on — its combination,
// both only from tables free for the whole sitting.
function seatingAt({ tables, holds, size, c, need, combine }) {
  const free = tables.filter((t) => {
    const sp = holds.get(String(t.id));
    return sp != null && clearFor(sp, c, need);
  });
  let best = null;
  for (const t of free) {
    if (seatsOf(t) >= size && (!best || seatsOf(t) < seatsOf(best))) best = t;
  }
  if (best) return [best];
  if (!combine?.enabled) return null;
  const ids = findCombo(size, free, combine.maxSize);
  return ids ? free.filter((t) => ids.includes(String(t.id))).sort(byLabel) : null;
}

function seatingOf(picked) {
  const ids = picked.map((t) => String(t.id));
  return {
    tableId: picked.length === 1 ? ids[0] : null,
    tableIds: ids,
    label: picked.map((t) => t.label).join(" + "),
    seats: picked.reduce((s, t) => s + seatsOf(t), 0),
  };
}

const activeTables = (resources) =>
  (resources || []).filter((t) => t.kind !== "provider" && t.is_active !== false);

const holdsByTable = (tables, reservations, nowMs) =>
  new Map(tables.map((t) => [String(t.id), holdsOn(t, reservations, nowMs)]));

// The joining rule in force: null (single tables only) unless joining is on
// and allows two tables or more.
const joinRule = (combine) => (combine?.enabled && combine.maxSize >= 2 ? combine : null);

/**
 * Where the booking engine would seat `size` guests sitting down NOW, free
 * for their whole sitting of `sittingMin` minutes — { tableId, tableIds,
 * label, seats }, or null: the smallest single table that fits, else (joining
 * on, `combine`) the engine's own combination.
 *
 * THE rule behind both the drop-in row's "Free now" (walkInOptions, the same
 * seatingAt from the same holds) and what the seat sheet pre-picks. The sheet
 * used its own — any table with no booking in the next two hours — and so
 * pre-picked a six-top booked at 21.10 for a 150-minute sitting (the server
 * refused it) where the row had counted two joined tables, and two joined
 * tables where the row had counted a six-top free for the whole sitting.
 */
export function seatingNow({ reservations, resources, nowMs, size, sittingMin, combine = null }) {
  const tables = activeTables(resources);
  const picked = seatingAt({
    tables,
    holds: holdsByTable(tables, reservations, nowMs),
    size,
    c: nowMs,
    need: minutes(sittingMin),
    combine: joinRule(combine),
  });
  return picked ? seatingOf(picked) : null;
}

/** The tables the server actually holds a booking at — its own answer
 *  (combined_resource_ids, else resource_id), as string ids. */
export function tablesOf(row) {
  return row ? heldIds(row) : [];
}

/** The same tables, in any order. */
export function sameTables(a, b) {
  const x = new Set((a || []).map(String));
  const y = new Set((b || []).map(String));
  return x.size === y.size && [...x].every((id) => y.has(id));
}

/**
 * The tables the engine would join for `size` guests sitting down now, free
 * for their whole sitting — { tableIds, label, seats }, or null. Only the
 * joined case, whether or not a single table is free too; the stand itself
 * reads seatingNow (a single table first, as the engine seats).
 */
export function joinedSeatingNow({ reservations, resources, nowMs, size, sittingMin, combine }) {
  if (!combine?.enabled) return null;
  const tables = activeTables(resources);
  const holds = new Map(tables.map((t) => [String(t.id), holdsOn(t, reservations, nowMs)]));
  const free = tables.filter((t) => {
    const sp = holds.get(String(t.id));
    return sp != null && clearFor(sp, nowMs, minutes(sittingMin));
  });
  const ids = findCombo(size, free, combine.maxSize);
  if (!ids) return null;
  const { tableIds, label, seats } = seatingOf(free.filter((t) => ids.includes(String(t.id))).sort(byLabel));
  return { tableIds, label, seats };
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
 *   { size, freeNow, tableId, tableIds, label, at }
 * freeNow — the party can sit down now for their whole sitting, where the
 *   booking engine itself would seat them: the SMALLEST single table that
 *   fits (the seat sheet's honest auto-pick — never the six-top for a
 *   couple), else the tables the engine joins (`combine`, its own rule —
 *   findCombo). tableIds name them (one, or the joined set in table order),
 *   tableId only for a single table, label reads "22" or "6 + 7 + 8".
 * at — otherwise the first moment such a seating opens (ms). null when that
 *   cannot be known — any table that could take part has a party sitting past
 *   its booked end, which could free it any minute, so a later time from
 *   another table would be a worst case dressed as the wait — or when no
 *   table could ever seat them, or it falls after closing.
 * `combine` is comboRules(settings): null or disabled = single tables only.
 */
export function walkInOptions({ reservations, resources, nowMs, sittingFor, closeMs = null, sizes = WALK_IN_SIZES, combine = null }) {
  const tables = activeTables(resources);
  const holds = holdsByTable(tables, reservations, nowMs);
  const join = joinRule(combine);
  return sizes.map((size) => {
    const need = minutes(sittingFor(size));
    const now = seatingAt({ tables, holds, size, c: nowMs, need, combine: join });
    if (now) return { size, freeNow: true, ...seatingOf(now), at: nowMs };
    const none = { size, freeNow: false, tableId: null, tableIds: null, label: null, at: null };
    const could = tables.filter((t) => couldSeat(t, size, tables, join ? join.maxSize : 1));
    if (could.length === 0 || could.some((t) => holds.get(String(t.id)) == null)) return none;
    // A seating can only open where a hold ends.
    const ends = [...new Set(could.flatMap((t) => holds.get(String(t.id)).map(([, e]) => e)))]
      .filter((e) => e > nowMs)
      .sort((a, b) => a - b);
    const at = ends.find((c) => seatingAt({ tables, holds, size, c, need, combine: join }));
    return at != null && (closeMs == null || at < closeMs) ? { ...none, at } : none;
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
  const a = stampMs(r?.seated_at);
  const b = stampMs(r?.completed_at);
  if (a == null || b == null || b < a) return null;
  return Math.round((b - a) / 60000);
}

/** Finished list order: by the time they sat down (booked time when the
 *  seat time is unknown), earliest first. */
export function bySeatedTime(a, b) {
  const x = stampMs(a.seated_at) ?? msOf(a.starts_at) ?? 0;
  const y = stampMs(b.seated_at) ?? msOf(b.starts_at) ?? 0;
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
