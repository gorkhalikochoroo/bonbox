/**
 * The book's Timeline lens (Tidslinje): one row per table, the day's bookings
 * as bars along the hours. Moved unchanged from pages/ReservationsPage.jsx
 * (fix round 12 Nov 2026) so the door screen's own build can load it the
 * first time the lens opens (stand/standTimelineView.jsx) — the door screen
 * opens on the list, as it does for the Plan lens; the owner app keeps it in
 * its page bundle as before.
 */
import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Armchair, CalendarCheck, Link2 } from "lucide-react";
import { AllergyIcon } from "./AllergyWords";
import { ZoneDot, statusLabels, minOfDay } from "./bookParts";
import { WEEKDAY_KEY, toMin } from "../../utils/bookingTimes";
import { fmtTime } from "../../utils/floorState";
import { guestText } from "../../utils/guestText";
import { lateMinutes, overdueMinutes, overByText } from "../../utils/serviceClock";
import { serviceDayIso } from "../../utils/serviceDay";
import { zoneTones } from "../../utils/zoneColors";

// Phase-3 lens lands here. Honest placeholder until then.
function ComingSoonView({ icon, title, body }) {
  return (
    <div className="rounded-xl border border-dashed border-gray-300 dark:border-gray-700 bg-white dark:bg-[rgb(var(--surface-card))] py-12 text-center">
      <div className="text-gray-300 dark:text-gray-600 mb-2 flex justify-center">{icon}</div>
      <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{title}</p>
      <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-sm mx-auto">{body}</p>
    </div>
  );
}

// ─── Tidslinje (service timeline grid) ────────────────────────────────

// Allergy signal for a reservation: "severe" | "other" | null. Severity
// drives color everywhere a booking renders (red = severe, amber = any
// other recorded allergy/intolerance) — staff must never have to open a
// booking to learn it carries an allergy.
function allergyLevel(r) {
  const has =
    (Array.isArray(r.allergen_tags) && r.allergen_tags.length > 0) ||
    !!r.allergy_note ||
    !!r.allergy_severity;
  if (!has) return null;
  return r.allergy_severity === "severe" ? "severe" : "other";
}

// Hover tooltip for a timeline block — includes the allergy detail so the
// host can read tags/notes without opening the drawer.
function blockTitle(r, labels, t, late = 0, over = 0) {
  const word = over
    ? t("rsvpOverduePill", "Over time · {txt}", { txt: overByText(t, over) })
    : late ? t("rsvpLatePillText", "Late · {txt}", { txt: overByText(t, late) }) : labels[r.status] || r.status;
  const base = `${fmtTime(r.starts_at)} ${guestText(r.guest_name) || ""} (${r.party_size}) · ${word}`;
  if (!allergyLevel(r)) return base;
  const detail = [
    (r.allergen_tags || []).map((k) => t(`allergen_${k}`, k)).join(", "),
    guestText(r.allergy_note),
  ]
    .filter(Boolean)
    .join(" · ");
  const label =
    r.allergy_severity === "severe"
      ? t("rsvpSevSevere", "Severe allergy")
      : t("rsvpAllergyFlag", "Allergy");
  return `${base}\n⚠ ${label}${detail ? ": " + detail : ""}`;
}

// Width of the chair control on a timeline bar (see TimelineView).
const SEAT_W = 32;

// A bar's top line is "HH.MM · N" (+ a link icon for a combined table).
// Estimated, not measured: 11px semibold tabular digits run ~6.3px a
// character, which is all the chair's placement needs — it only has to
// know whether the line leaves room beside it.
function timelineTopLineWidth(r, combined) {
  const text = `${fmtTime(r.starts_at)} · ${r.party_size}`;
  return Math.ceil(text.length * 6.3) + (combined ? 14 : 0);
}

// A bar's time + name, kept in view. A booking that started before the
// scrolled-to hour used to slide its label under the sticky table column —
// "amilien Berg". The label now sticks just right of that column and rides
// along inside its own bar. (The bar clips with overflow:clip, not hidden:
// hidden would make the bar a scroll container and pin the label to it.)
function TimelineBarLabel({ stickyLeft, children }) {
  return (
    <span className="sticky self-start flex flex-col min-w-0 max-w-full" style={{ left: stickyLeft }}>
      {children}
    </span>
  );
}

// `checkedInWords`: a shop or a workshop — its customer is checked in at a
// place ("Tjekket ind", "Tjek {name} ind"), never seated at a table.
export default function TimelineView({ reservations, resources, day, t, onSelect, onStatus, openHours = null, checkedInWords = false }) {
  // One-tap seat from a booking bar. `justSeatedId` drives THE single ceremonial
  // beat (the ~500ms scale settle below); it self-clears so the bar returns to
  // stillness and never re-fires on a later render. The colour flip to the
  // inverted seated fill is the same optimistic status update the drawer uses.
  const [justSeatedId, setJustSeatedId] = useState(null);
  const seatFromBar = useCallback(
    (r) => {
      setJustSeatedId(r.id);
      onStatus?.(r, "seated");
      window.setTimeout(
        () => setJustSeatedId((id) => (id === r.id ? null : id)),
        550,
      );
    },
    [onStatus],
  );
  const tables = useMemo(
    () =>
      resources
        .filter((r) => r.kind !== "provider")
        .slice()
        .sort((a, b) =>
          (a.zone || "") === (b.zone || "")
            ? (a.sort_order || 0) - (b.sort_order || 0)
            : (a.zone || "").localeCompare(b.zone || ""),
        ),
    [resources],
  );
  const holding = useMemo(
    () => reservations.filter((r) => ["requested", "confirmed", "seated"].includes(r.status)),
    [reservations],
  );
  const zoneByTable = useMemo(() => zoneTones(resources).byId, [resources]);

  // Bookings with NO table yet (requested/confirmed) — without this lane
  // they'd be invisible on the timeline, which is how overbookings hide.
  // Greedy interval-packing into sub-lanes so overlapping blocks never
  // cover each other.
  const unassigned = useMemo(() => {
    const blocks = holding
      .filter(
        (r) =>
          !r.resource_id &&
          !(Array.isArray(r.combined_resource_ids) && r.combined_resource_ids.length) &&
          // Seated without a table too — a party of 12 "booked without a
          // table" vanished from the timeline the moment it was seated.
          ["requested", "confirmed", "seated"].includes(r.status) &&
          r.starts_at,
      )
      .map((r) => {
        let s = minOfDay(r.starts_at);
        let e = r.ends_at ? minOfDay(r.ends_at) : s + 90;
        if (e <= s) e += 1440;
        return { r, s, e, lane: 0 };
      })
      .sort((a, b) => a.s - b.s || a.e - b.e);
    const laneEnds = [];
    blocks.forEach((b) => {
      let li = laneEnds.findIndex((end) => end <= b.s);
      if (li === -1) {
        laneEnds.push(b.e);
        li = laneEnds.length - 1;
      } else {
        laneEnds[li] = b.e;
      }
      b.lane = li;
    });
    return { blocks, laneCount: Math.max(1, laneEnds.length) };
  }, [holding]);

  // The day's opening hours, widened by any booking outside them (min start
  // → max end), hour-aligned and at least 4h. Bookings alone made a quiet
  // lunch read 12–16 with the evening missing; neither → 16–23.
  const { startMin, endMin } = useMemo(() => {
    let lo = Infinity;
    let hi = -Infinity;
    const wins = openHours?.[WEEKDAY_KEY[new Date(`${day}T12:00:00`).getDay()]];
    (Array.isArray(wins) ? wins : []).forEach(([a, b]) => {
      const s = toMin(a);
      let e = toMin(b);
      if (e <= s) e += 1440;
      lo = Math.min(lo, s);
      hi = Math.max(hi, e);
    });
    holding.forEach((r) => {
      if (!r.starts_at || !r.ends_at) return;
      let s = minOfDay(r.starts_at);
      let e = minOfDay(r.ends_at);
      if (e <= s) e += 1440;
      lo = Math.min(lo, s);
      hi = Math.max(hi, e);
    });
    if (!isFinite(lo)) {
      lo = 16 * 60;
      hi = 23 * 60;
    }
    lo = Math.floor(lo / 60) * 60;
    hi = Math.ceil(hi / 60) * 60;
    if (hi - lo < 240) hi = lo + 240;
    return { startMin: lo, endMin: hi };
  }, [holding, openHours, day]);

  const ROW_H = 52;
  const RAIL_W = 116;
  const hours = [];
  for (let m = startMin; m <= endMin; m += 60) hours.push(m);
  const labels = statusLabels(t, checkedInWords);

  const todayIso = serviceDayIso();

  // Live "now" playhead tick. A 30s cadence advances nowX by 0.6px (PX × 0.5min)
  // — visibly creeps once the CSS glide smooths it — without a 60fps loop that
  // would drain an always-on host-stand tablet. Today-only (a past/future plan
  // has no live line, so don't schedule a needless timer); re-syncs the instant
  // the screen wakes / tab refocuses. Hooks live AFTER todayIso so the
  // [day, todayIso] dep array never reads a TDZ const (the Layout regression
  // lesson) and stay before the tables.length early return below.
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (day !== todayIso) return undefined;
    const sync = () => setNowTick(Date.now());
    const id = setInterval(sync, 30000);
    const onVis = () => {
      if (document.visibilityState === "visible") sync();
    };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [day, todayIso]);

  // The grid fills the box whenever the whole day fits at 1 px/min or more —
  // at a fixed 1.2, 1440 left ~240px of empty grid after closing and 960 hid
  // 23px of it behind a scrollbar. Narrower than that (phone, tablet
  // portrait) it stays at 1.2, where a 90-minute bar still has room for a
  // name, and scrolls. A callback ref: the box mounts once tables load.
  const [boxW, setBoxW] = useState(0);
  const boxRef = useRef(null);
  const measureRef = useCallback((el) => {
    boxRef.current = el;
    if (!el || typeof ResizeObserver === "undefined") return undefined;
    const ro = new ResizeObserver(([entry]) => setBoxW(Math.round(entry.contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const span = endMin - startMin;
  const fitPx = boxW > RAIL_W ? (boxW - RAIL_W - 2) / span : 0;
  const PX = fitPx >= 1 ? fitPx : 1.2; // px per minute
  const bodyW = span * PX;

  const nowD = new Date(nowTick);
  const nowMin = nowD.getHours() * 60 + nowD.getMinutes();
  const nowX =
    day === todayIso && nowMin >= startMin && nowMin <= endMin ? (nowMin - startMin) * PX : null;

  // Where the grid opens when it is wider than the screen (phone, tablet
  // portrait): at now on today, else at the first booking — it opened at
  // the day's first hour, with tonight's bookings off to the right.
  const firstStart = useMemo(() => {
    const ms = holding.filter((r) => r.starts_at).map((r) => minOfDay(r.starts_at));
    return ms.length ? Math.min(...ms) : null;
  }, [holding]);
  const scrolledFor = useRef("");
  useEffect(() => {
    const el = boxRef.current;
    if (!el || !boxW || el.scrollWidth <= el.clientWidth + 4 || scrolledFor.current === day) return;
    const at = day === todayIso && nowMin >= startMin && nowMin <= endMin ? nowMin : firstStart;
    if (at == null) return;
    scrolledFor.current = day;
    // Only when that point is off-screen — the day's first hour stays in
    // view whenever it can.
    if (RAIL_W + (at - startMin + 60) * PX > el.clientWidth) {
      el.scrollLeft = Math.max(0, (at - 30 - startMin) * PX);
    }
  }, [day, todayIso, nowMin, startMin, endMin, firstStart, PX, boxW]);

  if (tables.length === 0) {
    return (
      <ComingSoonView
        icon={<CalendarCheck className="w-8 h-8" />}
        title={checkedInWords ? t("rsvpFloorEmptyTitleAppt", "No spaces yet") : t("rsvpFloorEmptyTitle", "No tables yet")}
        body={checkedInWords
          ? t("rsvpFloorEmptyBodyAppt", "Add spaces on the Spaces tab to see them here.")
          : t("rsvpFloorEmptyBody", "Add tables on the Floor tab to see your room here.")}
      />
    );
  }

  // Status carried by fill weight (not hue): seated = inverted gray-900,
  // requested = dashed/provisional, confirmed = solid bordered.
  // The book's colours, on the bars (one vocabulary with the list and the
  // floor): green in the room, blue booked and coming, amber a request to
  // answer (dashed — not yet a promise), orange a confirmed party running
  // late. Opaque fills in both themes, so the seat control can share them.
  const BLOCK = {
    seated: "bg-emerald-100 text-emerald-950 border-emerald-300 dark:bg-emerald-950 dark:text-emerald-100 dark:border-emerald-700",
    requested: "bg-amber-50 text-amber-950 border-dashed border-amber-400 dark:bg-amber-950 dark:text-amber-100 dark:border-amber-600",
    late: "bg-orange-50 text-orange-950 border-orange-400 dark:bg-orange-950 dark:text-orange-100 dark:border-orange-600",
    confirmed: "bg-sky-50 text-sky-950 border-sky-300 dark:bg-sky-950 dark:text-sky-100 dark:border-sky-700",
    // Seated and still there past the booked end: the bar runs on to now.
    overdue: "bg-red-50 text-red-950 border-red-400 dark:bg-red-950 dark:text-red-100 dark:border-red-600",
  };
  const SEAT_FACE = {
    confirmed: "bg-sky-50 text-sky-700 hover:bg-sky-100 dark:bg-sky-950 dark:text-sky-300 dark:hover:bg-sky-900",
    late: "bg-orange-50 text-orange-700 hover:bg-orange-100 dark:bg-orange-950 dark:text-orange-300 dark:hover:bg-orange-900",
  };
  const overOf = (r) => overdueMinutes(r, nowTick, day === todayIso);
  const blockKind = (r) => (overOf(r) ? "overdue" : lateMinutes(r, nowTick, day === todayIso) ? "late" : r.status);

  return (
    <div ref={measureRef} className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] overflow-x-auto">
      {/* THE ONE ceremonial beat for seating — a single ~500ms scale settle,
          then stillness. The global prefers-reduced-motion rule (index.css)
          already collapses this animation to ~0.01ms, so no local guard. */}
      <style>{`@keyframes bbSeatSettle{from{transform:scale(1.015)}to{transform:scale(1)}}.bb-seat-settle{animation:bbSeatSettle 500ms cubic-bezier(0.22,1,0.36,1)}`}</style>
      <div className="relative" style={{ minWidth: RAIL_W + bodyW }}>
        {/* Time axis */}
        <div className="flex h-8 border-b border-gray-200 dark:border-gray-800 sticky top-0 bg-gray-50 dark:bg-gray-900/80 z-20">
          <div
            style={{ width: RAIL_W }}
            className="shrink-0 sticky left-0 z-20 bg-gray-50 dark:bg-gray-900/80 border-r border-gray-200 dark:border-gray-800"
          />
          <div style={{ width: bodyW }} className="relative">
            {hours.map((m) => (
              <span
                key={m}
                style={{ left: (m - startMin) * PX }}
                // Centred on its tick, except the two ends: the first label sat
                // half under the table rail ("7:00"), the last half off-canvas.
                className={"absolute top-1.5 text-[11px] tabular-nums text-gray-500 dark:text-gray-400 " +
                  (m === startMin ? "pl-1" : m === endMin ? "-translate-x-full pr-1" : "-translate-x-1/2")}
              >
                {String(Math.floor((m % 1440) / 60)).padStart(2, "0")}.00
              </span>
            ))}
            {/* The "now" indicator is now ONE continuous .bb-playhead overlay,
                mounted once at the bottom of the grid (a 7px dot rides here in
                the axis). No per-row pill/line — see the overlay below. */}
          </div>
        </div>

        {/* Unassigned lane — bookings still without a table, ABOVE the room
            so the host can't miss them. Amber = needs attention. Click a
            block → same detail drawer (where the Assign-table control is). */}
        {unassigned.blocks.length > 0 && (
          <div
            className="flex border-b border-gray-200 dark:border-gray-800"
            style={{ height: unassigned.laneCount * 44 }}
          >
            <div
              style={{ width: RAIL_W }}
              className="shrink-0 sticky left-0 z-10 bg-gray-50 dark:bg-[rgb(var(--surface-card))] border-r border-gray-200 dark:border-[rgb(var(--surface-line))] px-2 flex flex-col justify-center"
            >
              <span className="text-sm font-semibold text-gray-800 dark:text-gray-100 truncate leading-tight inline-flex items-center gap-1">
                {checkedInWords ? t("rsvpUnassignedLaneAppt", "No space") : t("rsvpUnassignedLane", "Unassigned")}
              </span>
              <span className="text-[11px] text-gray-500 dark:text-gray-400 tabular-nums">
                {unassigned.blocks.length}
              </span>
            </div>
            <div style={{ width: bodyW }} className="relative bg-gray-50/70 dark:bg-gray-800/30">
              {hours.map((m) => (
                <span
                  key={m}
                  style={{ left: (m - startMin) * PX }}
                  className="absolute top-0 bottom-0 border-l border-gray-100 dark:border-gray-800"
                  aria-hidden
                />
              ))}
              {/* per-row now-line removed → single .bb-playhead overlay below */}
              {unassigned.blocks.map(({ r, s, e, lane }) => {
                const left = Math.max(0, (s - startMin) * PX);
                const width = Math.max(30, (Math.min(e, endMin) - Math.max(s, startMin)) * PX - 2);
                const allergy = allergyLevel(r);
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => onSelect(r)}
                    title={blockTitle(r, labels, t, lateMinutes(r, nowTick, day === todayIso), overOf(r))}
                    style={{ left, width, top: lane * 44 + 5, height: 34 }}
                    // The booking's own colour — the lane already says "no
                    // table"; amber-dashed for every bar read as "request".
                    className={
                      "absolute rounded-md border px-1.5 overflow-clip text-left flex flex-col justify-center " +
                      (BLOCK[blockKind(r)] || BLOCK.confirmed)
                    }
                  >
                    <TimelineBarLabel stickyLeft={RAIL_W + 6}>
                      <span className="text-[11px] font-semibold leading-none truncate">
                        {fmtTime(r.starts_at)} · {r.party_size}
                      </span>
                      {/* Was text-[10px] opacity-90 — the guest name, the one
                          string a host scans the timeline FOR, rendered under
                          the 11px floor and faded. 11px + 11px still clears the
                          34px lane (11 + 2 + ~14). */}
                      <span className="text-[11px] leading-tight truncate mt-0.5 flex items-center gap-0.5">
                        {allergy && (
                          <AllergyIcon
                            level={allergy === "severe" ? "severe" : "allergy"}
                            className={"w-3 h-3 shrink-0 " + (allergy === "severe" ? "text-red-500" : "text-amber-600 dark:text-amber-400")}
                            aria-hidden
                          />
                        )}
                        {guestText(r.guest_name) || t("rsvpGuest", "Guest")}
                      </span>
                    </TimelineBarLabel>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Table rows */}
        {tables.map((tbl) => {
          const id = String(tbl.id);
          const blocks = holding.filter(
            (r) =>
              String(r.resource_id) === id ||
              (r.combined_resource_ids || []).map(String).includes(id),
          );
          return (
            <div
              key={tbl.id}
              className="flex border-b border-gray-100 dark:border-gray-800 last:border-0"
              style={{ height: ROW_H }}
            >
              <div
                style={{ width: RAIL_W }}
                className="shrink-0 sticky left-0 z-10 bg-white dark:bg-[rgb(var(--surface-card))] border-r border-gray-200 dark:border-[rgb(var(--surface-line))] px-2 flex flex-col justify-center"
              >
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate leading-tight">
                  {tbl.label}
                </span>
                <span className="inline-flex items-center gap-1 text-[11px] text-gray-500 dark:text-gray-400 min-w-0">
                  <ZoneDot dot={zoneByTable[id]} />
                  <span className="truncate">{[tbl.zone, tbl.capacity_seats + "p"].filter(Boolean).join(" · ")}</span>
                </span>
              </div>
              <div style={{ width: bodyW }} className="relative">
                {hours.map((m) => (
                  <span
                    key={m}
                    style={{ left: (m - startMin) * PX }}
                    className="absolute top-0 bottom-0 border-l border-gray-100 dark:border-gray-800"
                    aria-hidden
                  />
                ))}
                {/* per-row now-line removed → single .bb-playhead overlay below */}
                {blocks.map((r) => {
                  let s = minOfDay(r.starts_at);
                  let e = minOfDay(r.ends_at);
                  if (e <= s) e += 1440;
                  // A party still seated past its end holds the table until
                  // now — the bar stopped at the booked end and the table
                  // looked free while they were still eating.
                  if (overOf(r)) e = Math.max(e, nowMin < s ? nowMin + 1440 : nowMin);
                  const left = Math.max(0, (s - startMin) * PX);
                  const width = Math.max(30, (Math.min(e, endMin) - Math.max(s, startMin)) * PX - 2);
                  const combined = (r.combined_resource_ids || []).length > 1;
                  const allergy = allergyLevel(r);
                  // One-tap seat: only a CONFIRMED bar (a 'requested' booking is
                  // acknowledged via the drawer's Confirm first — mirrors the
                  // drawer state machine), and only when the bar is wide enough
                  // that the 44px seat control still leaves ≥44px of body tap zone
                  // for the drawer (88 − 44 = 44). Narrow bars keep drawer-only
                  // seating — a graceful fallback, never a hidden dead-end.
                  // One-tap seat. The chair used to sit over the right end of
                  // the bar at full height — on top of the guest NAME, so
                  // "Sofie Holm" read "Sofie Hol🪑" and a long party name lost
                  // its last word. It now sits on the TOP line, beside the
                  // short "12.00 · 2", and the name keeps the bar's whole
                  // width. It only appears where that line has room for it
                  // (estimated from the line's own characters); a bar too
                  // short keeps drawer-only seating, as before. Only a
                  // CONFIRMED bar — a 'requested' booking is confirmed in the
                  // drawer first, mirroring the drawer's state machine.
                  const topLineW = timelineTopLineWidth(r, combined);
                  const showSeat =
                    !!onStatus &&
                    day === todayIso &&
                    r.status === "confirmed" &&
                    width >= 6 + topLineW + 4 + SEAT_W;
                  return (
                    <Fragment key={r.id + id}>
                    <button
                      type="button"
                      onClick={() => onSelect(r)}
                      title={blockTitle(r, labels, t, lateMinutes(r, nowTick, day === todayIso), overOf(r))}
                      style={{ left, width, top: 5, height: ROW_H - 12 }}
                      className={
                        "absolute rounded-md border px-1.5 overflow-clip text-left flex flex-col justify-center transition-colors duration-500 " +
                        (BLOCK[blockKind(r)] || BLOCK.confirmed) +
                        // No allergy ring round the bar: red/amber outlines
                        // read as "running long" / "request". The triangle in
                        // the label carries it.
                        (justSeatedId === r.id ? " bb-seat-settle" : "")
                      }
                    >
                      <TimelineBarLabel stickyLeft={RAIL_W + 6}>
                        <span className="text-[11px] font-semibold leading-none truncate flex items-center gap-0.5">
                          {fmtTime(r.starts_at)} · {r.party_size}
                          {combined && <Link2 className="w-3 h-3 shrink-0" aria-hidden />}
                        </span>
                        {/* Same as the unassigned lane: the name was 10px and
                            faded. Bar height is ROW_H − 12 = 40px, so two 11px
                            lines fit with room to spare. */}
                        <span className="text-[11px] leading-tight truncate flex items-center gap-0.5 mt-0.5">
                          {allergy && (
                            <AllergyIcon
                              level={allergy === "severe" ? "severe" : "allergy"}
                              className={"w-3 h-3 shrink-0 " + (allergy === "severe" ? "text-red-500" : "text-amber-600 dark:text-amber-400")}
                              aria-hidden
                            />
                          )}
                          {guestText(r.guest_name) || t("rsvpGuest", "Guest")}
                        </span>
                      </TimelineBarLabel>
                    </button>
                    {showSeat && (
                      <button
                        type="button"
                        onClick={(ev) => {
                          ev.stopPropagation();
                          seatFromBar(r);
                        }}
                        title={checkedInWords ? t("rsvpSeatActionAppt", "Check in") : t("rsvpSeatAction", "Seat")}
                        aria-label={checkedInWords
                          ? t("rsvpSeatNowAriaAppt", "Check {name} in", {
                              name: guestText(r.guest_name) || t("rsvpColGuestAppt", "Customer"),
                            })
                          : t("rsvpSeatNowAria", "Seat {name}", {
                              name: guestText(r.guest_name) || t("rsvpGuest", "Guest"),
                            })}
                        // Top half of the bar's right end — the time line's
                        // free space. Its own surface, so a name scrolled
                        // under it (the sticky label) is cut, not overprinted.
                        style={{ left: left + width - SEAT_W - 1, width: SEAT_W, top: 6, height: (ROW_H - 14) / 2 }}
                        className={"absolute z-10 flex items-center justify-center rounded-tr-md transition-colors " + (SEAT_FACE[blockKind(r)] || SEAT_FACE.confirmed)}
                      >
                        <Armchair className="w-4 h-4 shrink-0" aria-hidden />
                      </button>
                    )}
                    </Fragment>
                  );
                })}
              </div>
            </div>
          );
        })}

        {/* Live "now" playhead — ONE continuous element over the whole grid so
            it's seamless top-to-bottom (no per-row seams). GPU-composited via
            translateX; glides on the 30s tick (.bb-playhead transition). Sits
            above blocks (z-5) but below the sticky rail/axis (z-20), which mask
            it where it scrolls under the 116px name column. pointer-events-none
            so it never steals a tap from the booking happening right now. Keyed
            on the time window so a bounds recompute remounts (no streak across
            the grid) and re-plays the single arrival beat. */}
        {nowX != null && (
          <div
            key={`ph-${startMin}-${endMin}`}
            aria-hidden="true"
            className="bb-playhead absolute top-0 bottom-0 z-[5] pointer-events-none"
            style={{
              left: 0,
              transform: `translateX(${RAIL_W + nowX}px)`,
              width: 0,
              willChange: "transform",
            }}
          >
            <div
              className="bb-playhead-line absolute top-8 bottom-0 bg-gray-900 dark:bg-gray-100"
              style={{ left: -0.75, width: 1.5 }}
            />
            <div
              className="bb-playhead-dot absolute top-4 -translate-x-1/2 -translate-y-1/2 rounded-full bg-gray-900 dark:bg-gray-100"
              style={{ width: 7, height: 7 }}
            />
          </div>
        )}
      </div>
    </div>
  );
}
