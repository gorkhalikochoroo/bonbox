// FloorPlan — a premium 2D "room" floor-plan for the reservation book's
// Floor view. Replaces the old responsive card-grid (FloorTile) with a real
// spatial room: a soft canvas (16:10) where tables are absolutely positioned
// shapes (round / square) sized by seat count, ringed with chair dots, tinted
// by LIVE status (free / upcoming / seated / overdue) and grouped by zone.
//
// Two modes:
//   • View   — tap a table → free opens SeatNowSheet (walk-in), occupied
//              opens ReservationDrawer (via the onSelect / onSeatNow handlers
//              FloorView already receives, so the parent's drawer/sheet are
//              reused unchanged).
//   • Edit   — "Arrange room": tables are draggable (pointer + touch) to set
//              pos_x / pos_y (% of canvas, clamped 0–100), each gets a
//              round/square toggle, and "Save layout" PUTs the new layout to
//              the backend. Exiting edit without saving reverts.
//
// Status classification reuses the page's deriveFloorState() (passed in as
// `cells`), so the room is always consistent with the List + Timeline views.
//
// Design doctrine: the book's status colours (white free, blue arriving,
// green seated, red running long); rounded shapes, soft shadows, subtle
// status glow, calm grid.
// Mobile / host-stand friendly: the canvas pans horizontally on a narrow
// screen so a big room stays usable.
//
// i18n: every user-facing string goes through t("key", "fallback") and has a
// real EN + DA entry in useLanguage.jsx (rsvpPlan* / rsvpArrange* keys).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Clock,
  Users,
  User,
  Link2,
  Pencil,
  Check,
  X,
  Move,
  RotateCcw,
  RotateCw,
  LayoutGrid,
  Plus,
  Minus,
  AlertTriangle,
} from "lucide-react";
import api from "../services/api";
import { haptic } from "../utils/haptics";
import Button from "./ui/Button";
import RoomShell from "./RoomShell";
import FloorFixtures, {
  FIXTURE_KINDS,
  FIXTURE_LABELS,
  normalizeFixtureKind,
} from "./FloorFixtures";

/** Minus / value / plus, sized for a thumb. Local to the fixture inspector. */
function FixtureStepper({ label, value, onLess, onMore }) {
  return (
    <span className="inline-flex items-center rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
      <button
        type="button"
        onClick={onLess}
        className="h-10 w-9 inline-flex items-center justify-center text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
        aria-label={`${label} −`}
      >
        <Minus className="w-4 h-4" aria-hidden />
      </button>
      <span className="px-2 text-xs tabular-nums text-gray-700 dark:text-gray-200 min-w-[64px] text-center">
        {label} {value}
      </span>
      <button
        type="button"
        onClick={onMore}
        className="h-10 w-9 inline-flex items-center justify-center text-gray-600 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800"
        aria-label={`${label} +`}
      >
        <Plus className="w-4 h-4" aria-hidden />
      </button>
    </span>
  );
}
import { venueProfile } from "../config/venueProfiles";
import {
  SHAPES,
  ARCHETYPES,
  normalizeShape,
  tableDims,
  archetypeChairs,
  bodyRadiusClass,
  chairIsStool,
  TableMark,
  ShapeGlyph,
} from "../config/tableArchetypes";
import { fitRoom, roomMinWidth } from "../utils/floorFit";
import { zoneTones } from "../utils/zoneColors";

// ── Status → visual tokens ────────────────────────────────────────────
// Mirrors deriveFloorState's status vocabulary, in the book's colours (one
// vocabulary with the list and the timeline — Manoj, 1 Oct 2026). "overdue"
// is derived here (a seated booking past its end time), so the room can flag
// a table that's running long in red.
//   free      → plain white (nothing on it — green now means "in the room")
//   upcoming  → sky blue    (booked / holding, guest due)
//   seated    → solid green (in use now — the heaviest mark in the room)
//   overdue   → solid red   (seated past end — needs turning)
//   inactive  → muted gray  (out of service)
const STATUS_STYLE = {
  free: {
    fill: "bg-white dark:bg-[rgb(var(--surface-card))]",
    ring: "ring-gray-300 dark:ring-gray-600",
    dot: "bg-gray-300 dark:bg-gray-600",
    text: "text-gray-800 dark:text-gray-100",
    chair: "bg-gray-300 dark:bg-gray-600",
    glow: "",
  },
  upcoming: {
    fill: "bg-sky-50 dark:bg-sky-950",
    ring: "ring-sky-300 dark:ring-sky-700",
    dot: "bg-sky-500",
    text: "text-sky-950 dark:text-sky-100",
    chair: "bg-sky-300 dark:bg-sky-700",
    glow: "shadow-[0_0_0_4px_rgba(14,165,233,0.12)]",
  },
  requested: {
    fill: "bg-amber-50 dark:bg-amber-950",
    ring: "ring-amber-400 dark:ring-amber-600",
    dot: "bg-amber-500",
    text: "text-amber-950 dark:text-amber-100",
    chair: "bg-amber-300 dark:bg-amber-700",
    glow: "shadow-[0_0_0_4px_rgba(245,158,11,0.12)]",
  },
  late: {
    fill: "bg-orange-50 dark:bg-orange-950",
    ring: "ring-orange-500 dark:ring-orange-500",
    dot: "bg-orange-500",
    text: "text-orange-950 dark:text-orange-100",
    chair: "bg-orange-300 dark:bg-orange-700",
    glow: "shadow-[0_0_0_4px_rgba(249,115,22,0.15)]",
  },
  seated: {
    // In use = solid green, white ink at AA (emerald-700 is 5.5:1) — the room
    // reads at a glance: green = people at it, blue = arriving, red = running
    // long, white = free.
    fill: "bg-emerald-700 dark:bg-emerald-700",
    ring: "ring-emerald-700 dark:ring-emerald-500",
    dot: "bg-white/90",
    text: "text-white",
    chair: "bg-emerald-500 dark:bg-emerald-600",
    glow: "shadow-[0_0_0_4px_rgba(4,120,87,0.15)]",
  },
  overdue: {
    // Running long → SOLID red (alarm), mirroring seated=solid-dark. The one
    // urgent state inverts to white-on-red for maximum across-room legibility.
    fill: "bg-red-600 dark:bg-red-600",
    ring: "ring-red-600 dark:ring-red-500",
    dot: "bg-white",
    text: "text-white",
    chair: "bg-red-300 dark:bg-red-800",
    glow: "shadow-[0_0_0_4px_rgba(239,68,68,0.20)]",
  },
  inactive: {
    fill: "bg-gray-100 dark:bg-gray-800/60",
    ring: "ring-gray-200 dark:ring-gray-700",
    dot: "bg-gray-300 dark:bg-gray-600",
    text: "text-gray-400 dark:text-gray-500",
    chair: "bg-gray-200 dark:bg-gray-700",
    glow: "",
  },
};

// Bar stools + high-top seats read as a RING (outline) rather than a solid
// dot — status-tinted border, keyed on the same vocabulary as STATUS_STYLE.
const STOOL_BORDER = {
  free: "border-gray-300 dark:border-gray-600",
  upcoming: "border-sky-400 dark:border-sky-600",
  requested: "border-amber-400 dark:border-amber-600",
  late: "border-orange-500 dark:border-orange-500",
  seated: "border-emerald-600 dark:border-emerald-500",
  overdue: "border-red-300 dark:border-red-700",
  inactive: "border-gray-300 dark:border-gray-600",
};

// Refine deriveFloorState's status into the room's richer vocabulary:
// a seated booking whose end time has passed becomes "overdue".
function visualStatus(cell, nowMs) {
  if (cell.status === "inactive") return "inactive";
  if (cell.status === "free") return "free";
  if (cell.status === "seated") {
    const endsAt = cell.booking?.reservation?.ends_at;
    if (endsAt) {
      const end = new Date(endsAt).getTime();
      if (Number.isFinite(end) && end < nowMs) return "overdue";
    }
    return "seated";
  }
  // The book's own words for a party that isn't in yet: a request still to
  // answer is amber, a confirmed party past its time is orange — both read
  // as sky "upcoming" here while the list said amber / orange.
  const res = cell.booking?.reservation;
  if (res?.status === "requested") return "requested";
  if (res?.status === "confirmed" && res.starts_at) {
    // Same rule as the list: whole minutes, rounded down, 5 or more.
    const start = new Date(res.starts_at).getTime();
    if (Number.isFinite(start) && Math.floor((nowMs - start) / 60000) >= 5) return "late";
  }
  return "upcoming";
}

// Table diameter (px, at the canvas's intrinsic size) scaled by seats.
// 2-top is small, 8+ is large. The canvas itself scales responsively, so
// these are nominal sizes against a ~880px-wide reference room.
function tableSizePx(seats) {
  const s = Math.max(1, Number(seats) || 2);
  // Clear visual tiers by capacity so a 2-top reads small and a 6–8-top is a
  // proper big table — ~20px per 2 seats keeps them distinguishable at a glance.
  // 1→54, 2→64, 4→84, 6→104, 8→120 (capped).
  return Math.round(Math.min(120, 44 + s * 10));
}

// Chair/stool positions now come from the shared archetype library
// (config/tableArchetypes → archetypeChairs), so a Langbord / Bås / Barplads /
// Højbord seats the same here and on the public booker map.

// Auto-layout fallback — arrange tables that have no pos_x/pos_y into a tidy
// grid, grouped by zone (each zone is a horizontal band). Returns a map of
// id → {pos_x, pos_y} percentages. Tables that already have coords keep them.
function autoLayout(cells) {
  // Group by zone, preserving first-seen order.
  const zones = [];
  const byZone = new Map();
  cells.forEach((c) => {
    const z = c.res.zone || "__none__";
    if (!byZone.has(z)) {
      byZone.set(z, []);
      zones.push(z);
    }
    byZone.get(z).push(c);
  });

  const out = {};
  const bandCount = zones.length || 1;
  const bandH = 100 / bandCount;
  zones.forEach((z, zi) => {
    const list = byZone.get(z);
    const cols = Math.ceil(Math.sqrt(list.length)) || 1;
    const rows = Math.ceil(list.length / cols) || 1;
    // Insets keep tables off the band edges (room for chairs + labels).
    const padX = 12;
    const padTop = bandH * zi + 11;
    const usableH = bandH - 20;
    list.forEach((c, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = cols > 1 ? padX + (col / (cols - 1)) * (100 - padX * 2) : 50;
      const y =
        rows > 1
          ? padTop + (row / (rows - 1)) * usableH
          : padTop + usableH / 2;
      out[String(c.res.id)] = {
        pos_x: Math.round(x * 10) / 10,
        pos_y: Math.round(Math.min(94, Math.max(6, y)) * 10) / 10,
      };
    });
  });
  return out;
}

// Build the working layout: each table's effective {pos_x, pos_y, shape}.
// Server-provided coords win; tables missing coords fall back to autoLayout.
// A resource with NO saved shape inherits its venue archetype's default —
// dining picks round (≤4) / square (≥6), a bar leans square, a salon station
// is round — so a fresh floor reads right for the business before the owner
// ever opens "Arrange". An explicit "square" / "round" from the server always
// wins over the archetype default.
function buildLayout(cells, businessType) {
  const auto = autoLayout(cells);
  const map = {};
  cells.forEach((c) => {
    const id = String(c.res.id);
    const hasX = c.res.pos_x != null && Number.isFinite(Number(c.res.pos_x));
    const hasY = c.res.pos_y != null && Number.isFinite(Number(c.res.pos_y));
    const profile = venueProfile(businessType, c.res);
    // Any saved archetype (round/square/rect/booth/bar/hightop) wins; tables
    // with no saved shape fall back to the venue archetype's default.
    const shape = SHAPES.includes(c.res.shape)
      ? c.res.shape
      : profile.defaultShape(c.res.capacity_seats);
    map[id] = {
      pos_x: hasX ? clampPct(Number(c.res.pos_x)) : auto[id]?.pos_x ?? 50,
      pos_y: hasY ? clampPct(Number(c.res.pos_y)) : auto[id]?.pos_y ?? 50,
      shape: normalizeShape(shape),
    };
  });
  return map;
}

function clampPct(n) {
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(0, n));
}

// ── A single table on the canvas ──────────────────────────────────────
function TableNode({
  cell,
  pos,
  nowMs,
  // Seats of all the tables a combined party sits at (null when single).
  comboSeats = null,
  // The table's zone ring (same hue as the list and the timeline), or null.
  zoneDot = null,
  t,
  profile,
  editing,
  selected,
  onTap,
  onPointerDownDrag,
  onToggleShape,
  // Room-fit scale (view mode only, see utils/floorFit): a crowded room draws
  // every table a little smaller rather than stacking them. 1 in Arrange mode.
  fitScale = 1,
}) {
  const { res } = cell;
  const status = visualStatus(cell, nowMs);
  const style = STATUS_STYLE[status] || STATUS_STYLE.free;
  // Effective seats: the DRAFT capacity (a live seat-stepper edit in Arrange
  // mode) when present, else the saved capacity_seats. Drives size + chairs +
  // the count so the table visibly grows/shrinks as you step seats — while
  // capacity_seats stays the sole booking-authoritative number.
  const seats = pos.capacity != null ? pos.capacity : res.capacity_seats;
  // Orientation (draft edit wins over saved; 0 = upright). Cosmetic — never
  // affects seating. The body + chairs rotate with it; the label/seat chip
  // counter-rotate to stay upright + legible.
  const rotation =
    pos.rotation_deg != null ? pos.rotation_deg : res.rotation_deg || 0;
  // Drawn-size multiplier (draft edit wins; 1 = seat-derived default). Scales the
  // whole FOOTPRINT — body + chairs — but NOT the label/seat chip (fixed font
  // below), so the seat number reads the same on a huge table as a small one.
  const sizeScale =
    (pos.size_scale != null ? pos.size_scale : res.size_scale || 1) * fitScale;
  const sizePx = tableSizePx(seats);
  // Chairs scale with the table so big tables get chunky seats, not tiny dots.
  const chairW = Math.round(
    Math.max(9, Math.min(15, Math.round(sizePx * 0.17))) * sizeScale,
  );
  const shape = pos.shape;
  // Footprint + seat layout come from the shared archetype library, so a
  // Langbord / Bås / Barplads / Højbord is drawn identically here and on the
  // public booker map. round/square keep the legacy square footprint (dims.w
  // === dims.h === sizePx) so existing rooms don't shift.
  const baseDims = tableDims(shape, seats);
  const dims = {
    w: Math.round(baseDims.w * sizeScale),
    h: Math.round(baseDims.h * sizeScale),
  };
  const isStool = chairIsStool(shape);
  // Station-like resources (salon archetype, or any kind === "provider") read
  // as a single person at a chair — one marker, not a ring of N chair dots.
  // Everything else keeps the chair ring sized by capacity.
  const stationLike = profile.stationLike;
  const chairs = useMemo(
    () => (stationLike ? [] : archetypeChairs(shape, seats, dims.w, dims.h, chairW)),
    [seats, dims.w, dims.h, shape, stationLike, chairW],
  );
  const combined = cell.combined;
  const booking = cell.booking;
  const VenueIcon = profile.icon;

  // Allergy on the table's current booking — the floor is where the kitchen
  // and runners look mid-service, so the warning must live ON the tile:
  // red badge = severe, amber = any other recorded allergy.
  const ares = booking?.reservation;
  const allergy =
    ares &&
    ((Array.isArray(ares.allergen_tags) && ares.allergen_tags.length > 0) ||
      ares.allergy_note ||
      ares.allergy_severity)
      ? ares.allergy_severity === "severe"
        ? "severe"
        : "other"
      : null;

  // Occupied/upcoming detail line, glanceable from across the room:
  //   • upcoming → ETA ("om 25 min") when the guest is due soon, else time + guest
  //   • seated   → the booking time + guest name
  //   • overdue  → how far past the table has run ("+12 min over") — the
  //                "turn this table" nudge, shown bold so it reads as urgent
  const partySize = booking?.reservation?.party_size ?? null;
  const overMin =
    status === "overdue" && booking?.reservation?.ends_at
      ? Math.max(
          0,
          Math.round((nowMs - new Date(booking.reservation.ends_at).getTime()) / 60000),
        )
      : null;
  // "+2940m over" is not a number a host can read — that is a party seated
  // two days ago that nobody cleared. Minutes up to an hour, then hours, then
  // days.
  // Compact on purpose: the red fill and the legend already say "overdue", and
  // this line has to fit a 2-top.
  const overText = (m) =>
    m < 60
      ? t("rsvpOverBy", "+{n} min", { n: m })
      : m < 1440
        ? t("rsvpOverByHours", "+{h} h {m}", { h: Math.floor(m / 60), m: String(m % 60).padStart(2, "0") })
        : t("rsvpOverByDays", "+{n} d", { n: Math.floor(m / 1440) });
  const sub =
    status === "free"
      ? null
      : status === "overdue"
        ? overText(overMin ?? 0)
        : status === "late" && booking?.reservation?.starts_at
          ? t("rsvpLateOnFloor", "+{n} m late", {
              n: Math.max(0, Math.floor((nowMs - new Date(booking.reservation.starts_at).getTime()) / 60000)),
            })
        : (status === "upcoming" || status === "requested") && booking?.eta != null
          ? t("rsvpEtaIn", "in {n}m", { n: booking.eta })
          : // Seated: lead with WHEN it frees — the host's decision number when a
            // walk-in arrives. Counts down inside 20 min, else the clock time.
            // The guest's name stays one tap away in the drawer.
            status === "seated" && booking?.freesAt
            ? booking.freesInMin != null && booking.freesInMin <= 20
              ? t("rsvpFreesInM", "free ~{n}m", { n: Math.max(0, booking.freesInMin) })
              : t("rsvpFreesAt", "free {time}", { time: booking.freesAt })
            : booking
              ? `${booking.time}${booking.name ? " · " + booking.name : ""}`
              : null;

  // ── Fit the words to the table ──────────────────────────────────────
  // The label, seat count and detail line used to render at fixed sizes into
  // whatever box the table happened to be: "Bord 3 · …" truncated, a detail
  // line spilling past a 4-top's circle into its chairs. Now the text is
  // chosen for the width the table actually has (a circle's usable chord is
  // ~¾ of its diameter), and the detail line appears only where it fits.
  const isRound = shape === "round" || shape === "hightop";
  // The body's own padding is 4px a side (px-1); a circle's usable chord for
  // the middle lines is ~0.78 of its diameter.
  const innerW = isRound
    ? dims.w * 0.78
    : shape === "rect"
      ? dims.w - 14
      : shape === "bar"
        ? dims.w - 12
        : dims.w - 8;
  const fullLabel = String(res.label || "");
  // "Bord 1 · Vindue" → "Bord 1" when the whole name cannot fit: the table's
  // own name is what a host navigates by; the rest lives in the tooltip.
  const shortLabel = fullLabel.split(/\s+[·•|–—-]\s+/)[0] || fullLabel;
  const iconW = allergy && !editing ? 17 : 0;
  const maxFs = dims.w >= 80 ? 14 : 13;
  // ~0.55em a character for Inter semibold; 10px is the last step before an
  // ellipsis — "Bord 10" must never read "Bord…".
  const fitFs = (text) => {
    for (const fs of [14, 13, 12, 11, 10]) {
      if (fs <= maxFs && text.length * fs * 0.55 + iconW <= innerW) return fs;
    }
    return null;
  };
  let labelText = fullLabel;
  let labelFs = fitFs(fullLabel);
  if (labelFs == null && shortLabel !== fullLabel) {
    labelText = shortLabel;
    labelFs = fitFs(shortLabel);
  }
  if (labelFs == null) labelFs = 10; // still too long: 10px + ellipsis
  // Room for a third line: a circle needs more diameter than a box needs height.
  // The line carries the number a host acts on (arrives 12.30, over by 13
  // min), so it shows on everything but the smallest tables — short form.
  const showSub = !!sub && innerW >= 34 && (isRound ? dims.w >= 56 : dims.h >= 44);
  // A narrow table shows when, not who ("13.00", not "13.00 · Firmafrokost"),
  // and a countdown that fits rather than an ellipsis ("13 min", not
  // "om 13 …"). At 10px most characters are ~5.5px but m and w run ~8.5px —
  // "om 13 min" is wider than its nine characters suggest.
  const subW = (s) => [...s].reduce((w, ch) => w + (/[mwMW]/.test(ch) ? 8.5 : 5.5), 0);
  let subText = sub;
  if (showSub && innerW < 96 && booking && status !== "overdue" && typeof sub === "string" && sub.includes(" · ")) {
    subText = sub.split(" · ")[0];
  }
  if (showSub && status === "upcoming" && booking?.eta != null && subW(sub) > innerW) {
    subText = t("rsvpEtaInShort", "{n}m", { n: booking.eta });
  }

  return (
    <div
      className="absolute select-none"
      style={{
        left: `${pos.pos_x}%`,
        top: `${pos.pos_y}%`,
        width: dims.w,
        height: dims.h,
        // Centering translate composed with the table's orientation.
        transform: `translate(-50%, -50%) rotate(${rotation}deg)`,
        zIndex: selected ? 30 : status === "overdue" ? 20 : 10,
        touchAction: editing ? "none" : "auto",
      }}
    >
      {/* Chairs (behind the table). Station-like resources skip the ring and
          show a single seat marker just above the body instead — one person
          at the chair, not a party around a table. */}
      {chairs.map((c, i) => (
        <span
          key={i}
          aria-hidden
          className={
            "absolute rounded-full " +
            (isStool
              ? "border-2 bg-transparent " + (STOOL_BORDER[status] || STOOL_BORDER.free)
              : style.chair)
          }
          style={{
            width: chairW,
            height: chairW,
            left: "50%",
            top: "50%",
            transform: `translate(calc(-50% + ${c.x}px), calc(-50% + ${c.y}px))`,
          }}
        />
      ))}
      {stationLike && (
        <span
          aria-hidden
          className={"absolute rounded-full " + style.chair}
          style={{
            width: 11,
            height: 11,
            left: "50%",
            top: "50%",
            transform: `translate(-50%, calc(-50% - ${dims.h / 2 + 9}px))`,
          }}
        />
      )}

      {/* The table body — a button in view mode, a drag handle in edit. */}
      <button
        type="button"
        onClick={editing ? undefined : () => onTap(cell)}
        onPointerDown={editing ? (e) => onPointerDownDrag(e, res.id) : undefined}
        aria-label={
          res.label +
          " · " +
          seats +
          (status === "overdue" ? " · " + t("rsvpPlanOverdue", "Overdue") : "") +
          (sub ? " · " + sub : "")
        }
        title={res.label + (sub ? " · " + sub : "")}
        className={
          "relative w-full h-full flex flex-col items-center justify-center gap-0.5 px-1 ring-2 transition-all duration-200 " +
          style.fill +
          " " +
          style.ring +
          " " +
          (status !== "inactive" ? style.glow : "") +
          " " +
          bodyRadiusClass(shape) +
          " " +
          (editing
            ? "cursor-grab active:cursor-grabbing shadow-lg"
            : status === "inactive"
              ? "cursor-default"
              : "cursor-pointer hover:scale-[1.04] hover:shadow-lg active:scale-[0.99] shadow-sm") +
          " " +
          (selected ? "scale-[1.05] shadow-xl ring-offset-2 ring-offset-transparent" : "")
        }
      >
        {/* Archetype mark — the booth bench / high-top tall-ring, drawn the
            same way on the public booker map (shared TableMark). */}
        <TableMark
          shape={shape}
          w={dims.w}
          h={dims.h}
          benchClass={style.chair}
          ringClass={STOOL_BORDER[status] || STOOL_BORDER.free}
        />
        {/* No corner badges. A status dot on the rim repeated what the fill
            already says, and the rim is where the chairs are — the dot, the
            allergy badge and the combined-table link all landed on a chair
            or off the table's edge. The allergy mark and the link now sit in
            the text, where they cannot collide with anything. */}
        {/* (The faint venue icon behind the label is gone: colour on the
            floor carries meaning now, and a watermark carried none.) */}
        {/* Label + seat chip + detail — counter-rotated so they stay upright and
            legible no matter how the table is turned. The seat number here is the
            honesty anchor: it never tilts, and (once free-resize lands) never
            scales — capacity reads the same on a huge angled table as a small one. */}
        <div
          className="relative flex flex-col items-center gap-0.5 max-w-full"
          style={{ transform: rotation ? `rotate(${-rotation}deg)` : undefined }}
        >
          <span className="inline-flex items-center gap-1 max-w-full" style={{ maxWidth: innerW }}>
            {/* Allergy — red = severe, amber = any other recorded allergy. In
                the label row, ringed so it reads on any table colour. */}
            {allergy && !editing && (
              <span
                className={
                  "inline-flex items-center justify-center w-3.5 h-3.5 rounded-full shrink-0 ring-1 ring-white/90 dark:ring-gray-900/80 " +
                  (allergy === "severe" ? "bg-red-500" : "bg-amber-500")
                }
                aria-label={allergy === "severe" ? t("rsvpAllergySevere", "Severe allergy") : t("rsvpAllergyFlag", "Allergy")}
                role="img"
              >
                <AlertTriangle className="w-2.5 h-2.5 text-white" aria-hidden />
              </span>
            )}
            {zoneDot && (
              <span
                className={"inline-block w-2 h-2 rounded-full border-2 shrink-0 " + zoneDot.cls}
                role="img"
                aria-label={zoneDot.zone}
                title={zoneDot.zone}
              />
            )}
            <span
              className={"font-semibold leading-none truncate min-w-0 " + style.text}
              style={{ fontSize: labelFs }}
            >
              {labelText}
            </span>
          </span>
          <span
            className={"inline-flex items-center gap-0.5 leading-none " + style.text}
          >
            {stationLike ? (
              <>
                <User className="w-3 h-3 opacity-70" aria-hidden />
                <span className="text-[10px]">{t(profile.unitKey, "per chair")}</span>
              </>
            ) : (
              <>
                <Users className="w-3 h-3 opacity-70" aria-hidden />
                <span className="text-[13px] tabular-nums">
                  {/* A party across tables counts every table's seats: 12 at
                      Bord 5 + 6 read "12/6" and "12/8", as if over-full. */}
                  {status !== "free" && partySize != null
                    ? `${partySize}/${comboSeats || seats}`
                    : seats}
                </span>
                {combined && <Link2 className="w-3 h-3 opacity-70 ml-0.5" aria-hidden />}
              </>
            )}
          </span>
          {showSub && (
            <span
              className={
                "text-[10px] leading-tight truncate tabular-nums " +
                style.text +
                " " +
                (status === "overdue" ? "font-bold" : "opacity-90")
              }
              style={{ maxWidth: innerW }}
            >
              {subText}
            </span>
          )}
        </div>
      </button>

      {/* Edit affordance: tap to cycle the table through the preset design
          library (round → square → langbord → bås → barplads → højbord). The
          glyph shows the CURRENT design so the room reads at a glance. */}
      {editing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleShape(res.id);
          }}
          title={t("rsvpPlanShapeCycle", "Skift bord-design")}
          aria-label={t("rsvpPlanShapeCycle", "Skift bord-design")}
          className="absolute left-1/2 -translate-x-1/2 -bottom-3 z-40 h-7 w-7 inline-flex items-center justify-center rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 shadow text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
        >
          <ShapeGlyph shape={shape} size={18} />
        </button>
      )}
    </div>
  );
}

// ── Legend ────────────────────────────────────────────────────────────
function LegendItem({ dotCls, label }) {
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
      <span className={"w-2.5 h-2.5 rounded-full " + dotCls} aria-hidden />
      {label}
    </span>
  );
}

// ── Main component ────────────────────────────────────────────────────
// Props (from FloorView in ReservationsPage):
//   cells        — deriveFloorState() output [{res, status, booking, combined}]
//   nowMs        — Date.now() snapshot for eta / overdue
//   t            — i18n
//   onSelect     — open ReservationDrawer for a booking
//   onSeatNow    — open SeatNowSheet for a free table
//   nextBookingId (optional) — reservation id of "your next booking" to accent
export default function FloorPlan({
  cells,
  nowMs,
  t,
  businessType = null,
  onSelect,
  onSeatNow,
  nextBookingId = null,
  // Parent refetch hook — called after this component creates a table from
  // the arrange toolbar so the page's resources state picks it up.
  onResourcesChanged = null,
  // Host stand: size the room to the screen's height (whole room in view).
  fitToScreen = false,
  // May this surface rearrange the room at all? FALSE on a PAIRED DOOR DEVICE
  // (/stand/<token>), whose requests are rewritten onto /stand/<token>/… where
  // the layout route deliberately does not exist — so arranging there ends in
  // a 404 and lost work. Defaults TRUE so every existing owner call site is
  // unchanged, and the gate lives HERE as well as at the call site: a surface
  // that forgets to pass it is the failure we are guarding against.
  canArrange = true,
  // Non-bookable room objects (bar counter, entrance, window, wall). NOT
  // resources: they carry no seats, live in their own table, and the booking
  // engine cannot see them. Never merge this into `cells`.
  fixtures = [],
}) {
  // Account-level venue archetype — drives the section vocabulary (noun,
  // icon, empty state, hints, zone presets). Per-resource provider overrides
  // are resolved separately, per cell, inside the render loop.
  const profile = useMemo(() => venueProfile(businessType), [businessType]);
  // Seats per table, for a party sitting across several.
  const seatsByRes = useMemo(
    () => Object.fromEntries((cells || []).map((c) => [String(c.res.id), Number(c.res.capacity_seats) || 0])),
    [cells],
  );

  // Layout for the live (server) data — recomputed when resources change.
  const baseLayout = useMemo(
    () => buildLayout(cells, businessType),
    [cells, businessType],
  );

  // Working copy edited in "Arrange room" mode. null = not editing.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(null); // {id: {pos_x,pos_y,shape}}
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState(0); // toast trigger
  const [saveError, setSaveError] = useState("");
  const [activeId, setActiveId] = useState(null); // table being dragged
  const [selectedId, setSelectedId] = useState(null); // table tapped in Arrange mode → Inspector
  // Layout we just PUT to the server. baseLayout is memoized on `cells`
  // identity, so until the parent hands us fresh resources it still returns
  // the PRE-drag positions — rendering from it after save makes every table
  // snap back even though the save succeeded. Prefer this override until
  // cells actually change.
  const [savedLayout, setSavedLayout] = useState(null);
  // Quick-add table (arrange mode): seats picker + busy/error state.
  const [adding, setAdding] = useState(false);
  const [addSeats, setAddSeats] = useState("4");
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState("");

  const canvasRef = useRef(null);
  const dragRef = useRef(null); // {id, pointerId}

  // THE ROOM PANS ON A PHONE. It does not scale to fit, and the history is
  // worth keeping because the obvious fix was the wrong one.
  //
  // It used to scale: below 560px the canvas got `transform: scale(w/560)`.
  // That measurement was a `useRef` read inside a `useEffect(…, [])`, and the
  // node carrying the ref renders AFTER this component's empty-state early
  // return. FloorView is gated on the parent's `loading`, which tracks the
  // /reservations/book fetch ALONE — `resources` is a separate request. So the
  // two race: when /book wins, FloorPlan's first commit is the empty state,
  // the effect reads a null ref, bails before attaching its ResizeObserver,
  // and with `[]` deps never looks again once the tables land.
  //
  // That makes the defect INTERMITTENT, not universal — an earlier version of
  // this comment claimed it "never ran in production" and that was wrong. If
  // /resources wins the race the old code worked; switching lens or changing
  // the day also remounts with tables already present. You reach the bad
  // ordering by re-entering the page on a remembered Floor lens (the default
  // is the list, so it has to have been chosen before).
  //
  // Measured on a live account at 390px when it did fire: scroller 358px,
  // canvas pinned at 560px, 202px of the room off the right edge.
  //
  // MAKING THE SCALING RUN WAS WORSE THAN LEAVING IT BROKEN. At 390px the
  // scale is 0.639 and everything inside the canvas is absolute px: table
  // labels render at 7.7px, the seats chip at 8.3px, a 2-top's tap target
  // drops to 40.9px (under the 44pt minimum), a bar counter to 19.2px tall,
  // the Arrange shape button to 17.9px. A host mid-service has to READ a table
  // and TAP it; a whole room they can do neither to is not an improvement on
  // part of a room they can.
  //
  // A 358px phone cannot show eight legible, tappable tables in a 16:10 room —
  // the information does not fit and no layout makes it fit. So the room stays
  // 1:1 and pans, and the measurement drives the AFFORDANCE instead. That is
  // what was actually missing: a canvas running off the edge with nothing but
  // a scrollbar read as broken rather than as a room that continues.
  //
  // Both measurements below are CALLBACK refs. A node behind a conditional
  // render cannot be measured by a mount-only effect — that is the bug class,
  // and a callback ref cannot have it: React invokes it whenever the node
  // attaches, and again with null when it detaches.
  const roRef = useRef(null);
  const [pan, setPan] = useState({ can: false, atEnd: true });
  const measurePan = useCallback((el) => {
    if (!el) return;
    const slack = el.scrollWidth - el.clientWidth;
    setPan({ can: slack > 4, atEnd: slack <= 4 || el.scrollLeft >= slack - 4 });
  }, []);
  // A CALLBACK ref for the same reason the old one should have been: this node
  // renders after the empty-state early return, so a mount-only effect would
  // measure null and never look again.
  const scrollerRef = useCallback((el) => {
    roRef.current?.disconnect();
    roRef.current = null;
    if (!el) return;            // detaching — the disconnect above is the work
    measurePan(el);
    const ro = new ResizeObserver(() => measurePan(el));
    ro.observe(el);
    roRef.current = ro;
  }, [measurePan]);
  // Unmount safety net: a callback ref fires with null on unmount, but not if
  // the whole tree is torn down in a way that skips it.
  useEffect(() => () => roRef.current?.disconnect(), []);

  // The canvas's drawn size, for fitRoom. A callback ref for the same reason
  // as the scroller's: the canvas renders after the empty-state early return.
  // canvasRef stays the handle the drag code reads.
  const [canvasSize, setCanvasSize] = useState({ w: 0, h: 0 });
  // Host stand: where the room starts on the page, so it can be sized to
  // the screen's height (a guessed 300px of chrome left half the room below
  // the fold at 1024×768).
  const [fitTop, setFitTop] = useState(null);
  const canvasRoRef = useRef(null);
  const setCanvasEl = useCallback((el) => {
    canvasRef.current = el;
    canvasRoRef.current?.disconnect();
    canvasRoRef.current = null;
    if (!el) return;
    const read = () => {
      setCanvasSize((prev) => {
        const w = el.clientWidth;
        const h = el.clientHeight;
        return Math.abs(prev.w - w) < 1 && Math.abs(prev.h - h) < 1 ? prev : { w, h };
      });
      const top = Math.round(el.getBoundingClientRect().top + window.scrollY);
      setFitTop((prev) => (prev != null && Math.abs(prev - top) < 2 ? prev : top));
    };
    read();
    const ro = new ResizeObserver(read);
    ro.observe(el);
    canvasRoRef.current = ro;
  }, []);
  useEffect(() => () => canvasRoRef.current?.disconnect(), []);

  // Freshest known server-truth layout (post-save override wins over the
  // memoized base until the parent re-derives cells).
  const currentLayout = savedLayout || baseLayout;

  // Effective layout: draft when editing, else the freshest known layout.
  const layout = editing && draft ? draft : currentLayout;

  // Fresh server data supersedes the post-save override (the in-place res
  // patch in saveLayout means a re-derive from the same resources already
  // carries the saved positions).
  useEffect(() => {
    setSavedLayout(null);
    setSelectedId(null); // a re-derive may drop the selected table
  }, [cells]);

  // The table open in the Inspector (Arrange mode only), and its effective
  // seats (draft edit wins over saved). Booking-authoritative capacity_seats
  // is the fallback, never overwritten until Save.
  const selectedCell =
    editing && selectedId
      ? cells.find((c) => String(c.res.id) === selectedId) || null
      : null;
  const selectedSeats = selectedCell
    ? draft?.[selectedId]?.capacity ?? selectedCell.res.capacity_seats
    : 0;
  const selectedRotation = selectedCell
    ? Math.round(draft?.[selectedId]?.rotation_deg ?? selectedCell.res.rotation_deg ?? 0)
    : 0;
  const selectedSize = selectedCell
    ? draft?.[selectedId]?.size_scale ?? selectedCell.res.size_scale ?? 1
    : 1;


  // Room capacity — how many guests fit at one seating (sum of active table
  // seats) + the table count. The "total size that fits at one time".
  const capacity = useMemo(() => {
    const active = cells.filter((c) => c.status !== "inactive");
    const seats = active.reduce(
      (s, c) => s + (Number(c.res?.capacity_seats) || 0),
      0,
    );
    return { tables: active.length, seats };
  }, [cells]);

  // ── "Next free" — the run-the-room readout ───────────────────────────
  // A walk-in venue's constant question is "can I seat this party, and if not
  // how long?". We answer it at a glance, no input: how many tables are free
  // NOW, and when the soonest-occupied one frees. Recomputes with nowMs so it
  // stays live mid-service. Overdue tables (running past their end) count as
  // freeing "now" — their negative freesInMin sorts first.
  const turn = useMemo(() => {
    let freeNow = 0;
    let occupied = 0;
    let nextAt = null;
    let nextIn = null;
    for (const c of cells) {
      const vs = visualStatus(c, nowMs);
      if (vs === "free") { freeNow += 1; continue; }
      if (vs === "seated" || vs === "overdue") {
        occupied += 1;
        const b = c.booking;
        if (b?.freesAt && b.freesInMin != null) {
          if (nextIn == null || b.freesInMin < nextIn) {
            nextIn = b.freesInMin;
            nextAt = b.freesAt;
          }
        }
      }
    }
    return { freeNow, occupied, nextAt, nextIn };
  }, [cells, nowMs]);

  // ── Edit lifecycle ───────────────────────────────────────────────────
  // ── Fixture draft ────────────────────────────────────────────────
  // Parallel to `draft` rather than merged into it: a fixture and a table
  // share a canvas and a drag gesture but nothing else — different fields,
  // different endpoint, different table. Merging them is how a decorative
  // wall ends up somewhere that counts seats.
  const [fixtureDraft, setFixtureDraft] = useState(null);
  const [selectedFixtureId, setSelectedFixtureId] = useState(null);
  const [fixtureBusy, setFixtureBusy] = useState(false);
  // Server truth after a save/add/delete, so the room renders the new state
  // before the parent's refetch lands (same trick as savedLayout).
  const [localFixtures, setLocalFixtures] = useState(null);

  const liveFixtures = localFixtures || fixtures;

  // Hand control BACK to the server whenever the parent delivers a new list —
  // but NEVER while the owner is arranging.
  //
  // Without the reset at all, `localFixtures` wins forever the moment it is
  // set once: this client would keep rendering its own post-add snapshot and
  // never see a fixture added on the owner's phone or the door tablet.
  //
  // Without the `editing` guard, the reset is worse than the bug it fixes.
  // The name field writes optimistically into `localFixtures`, so a refetch
  // landing between a keystroke and its PATCH would snap the input back to the
  // server's older value — the owner watches "Cocktailbaren" become "Bar"
  // under their cursor. Resources are not on a timer TODAY, so this cannot
  // happen yet; it is one added `fetchResources()` away from happening
  // silently, and a bug that needs someone else's future change to appear is
  // the kind that ships. While arranging, the owner's copy is the truth.
  useEffect(() => {
    if (editing) return;
    setLocalFixtures(null);
  }, [fixtures, editing]);

  /** Server error text that is safe to render. FastAPI's `detail` is a string
   *  for our HTTPExceptions but a LIST of objects for a 422 — putting that
   *  straight into JSX throws "Objects are not valid as a React child" and
   *  takes the whole floor down instead of showing the error. */
  const errText = useCallback(
    (e, fallback) => {
      const d = e?.response?.data?.detail;
      return typeof d === "string" && d ? d : fallback;
    },
    [],
  );

  /** What to draw right now: the draft while arranging, else server truth. */
  const shownFixtures = useMemo(
    () =>
      liveFixtures.map((f) =>
        fixtureDraft && fixtureDraft[String(f.id)]
          ? { ...f, ...fixtureDraft[String(f.id)] }
          : f,
      ),
    [liveFixtures, fixtureDraft],
  );

  // View mode draws the room FITTED to the size it is shown at: overlapping
  // tables nudged apart, a crowded room drawn a touch smaller (utils/floorFit).
  // Arrange mode draws exactly what is saved — that is where the owner decides.
  // The room is never drawn narrower than its tables need at the legible
  // floor scale — on a phone a crowded room pans further instead of stacking.
  const roomMinW = useMemo(() => roomMinWidth(cells, layout), [cells, layout]);

  const fitted = useMemo(
    () =>
      editing
        ? { scale: 1, pos: {}, moved: 0 }
        : fitRoom(cells, layout, canvasSize, shownFixtures),
    [editing, cells, layout, canvasSize, shownFixtures],
  );

  // Zones: a hollow ring on each zoned table + the legend — a drawn area
  // mislabelled the room (equal bands put "VINDUE" over Indendørs tables; a
  // box around a zone's tables swallowed the unzoned ones between them).
  const zoneInfo = useMemo(() => zoneTones(cells, (c) => c.res.id, (c) => c.res.zone), [cells]);

  const enterEdit = useCallback(() => {
    if (!canArrange) return;
    setDraft(JSON.parse(JSON.stringify(currentLayout)));
    setFixtureDraft({});
    setSelectedId(null);
    setSelectedFixtureId(null);
    setSaveError("");
    setEditing(true);
  }, [currentLayout, canArrange]);

  // Exit WITHOUT saving → revert (draft discarded).
  const cancelEdit = useCallback(() => {
    setDraft(null);
    // Drops fixture MOVES only. An added bar is already on the server (it
    // needed an id to be draggable at all), so Cancel does not un-add it —
    // the same asymmetry the existing Add table flow has.
    setFixtureDraft(null);
    setSelectedFixtureId(null);
    setActiveId(null);
    setSelectedId(null);
    setEditing(false);
    setSaveError("");
  }, []);

  const resetDraft = useCallback(() => {
    setDraft(JSON.parse(JSON.stringify(currentLayout)));
    setFixtureDraft({});
  }, [currentLayout]);

  // Auto-arrange — tidy every table into the zone-banded grid in one tap
  // (keeps each table's round/square shape; the owner can still nudge + Save).
  const autoArrange = useCallback(() => {
    const positions = autoLayout(cells);
    setDraft((prev) => {
      const base = prev || JSON.parse(JSON.stringify(currentLayout));
      const next = { ...base };
      Object.entries(positions).forEach(([id, pos]) => {
        next[id] = { ...(base[id] || {}), pos_x: pos.pos_x, pos_y: pos.pos_y };
      });
      return next;
    });
  }, [cells, currentLayout]);

  // ── Fixture actions ──────────────────────────────────────────────
  // Add and delete hit the server IMMEDIATELY rather than riding the Save.
  // A fixture has to exist to have an id, and an id is what the drag and the
  // bulk layout save are keyed on. Position/size changes still ride Save, so
  // Cancel reverts a drag — it does not un-add a bar. That asymmetry is the
  // same one the existing Add table flow already has.
  const addFixture = useCallback(
    async (kind) => {
      if (fixtureBusy) return;
      setFixtureBusy(true);
      setSaveError("");
      try {
        const res = await api.post("/reservations/fixtures", { kind });
        const created = res?.data?.fixture;
        if (created) {
          setLocalFixtures([...(liveFixtures || []), created]);
          setSelectedFixtureId(String(created.id));
          setSelectedId(null);
          haptic.success();
        }
        onResourcesChanged?.();
      } catch (e) {
        setSaveError(errText(e, t("rsvpFixtureAddError", "Couldn't add that. Please try again.")));
      } finally {
        setFixtureBusy(false);
      }
    },
    [fixtureBusy, liveFixtures, onResourcesChanged, errText, t],
  );

  const deleteFixture = useCallback(
    async (id) => {
      if (fixtureBusy) return;
      setFixtureBusy(true);
      setSaveError("");
      try {
        await api.delete(`/reservations/fixtures/${id}`);
        setLocalFixtures((liveFixtures || []).filter((f) => String(f.id) !== String(id)));
        setSelectedFixtureId(null);
        haptic.success();
        onResourcesChanged?.();
      } catch (e) {
        setSaveError(errText(e, t("rsvpFixtureDeleteError", "Couldn't remove that. Please try again.")));
      } finally {
        setFixtureBusy(false);
      }
    },
    [fixtureBusy, liveFixtures, onResourcesChanged, errText, t],
  );

  /** Rename a fixture — the owner's own word for their own room.
   *  Goes straight to the server rather than riding Save: a name is typed
   *  deliberately, one at a time, and losing it to a Cancel meant for a
   *  mis-drag would be surprising. Geometry rides Save; identity does not. */
  const renameFixture = useCallback(
    async (id, label) => {
      const next = (label || "").slice(0, 60);
      // Paint it immediately — a text field that lags the keystroke feels broken.
      setLocalFixtures((prev) =>
        (prev || liveFixtures).map((f) =>
          String(f.id) === String(id) ? { ...f, label: next || null } : f,
        ),
      );
      try {
        await api.patch(`/reservations/fixtures/${id}`, { label: next });
      } catch (e) {
        setSaveError(
          errText(e, t("rsvpFixtureRenameError", "Couldn't rename that. Please try again.")),
        );
      }
    },
    [liveFixtures, errText, t],
  );

  /** Resize/rotate the selected fixture into the DRAFT, so Cancel reverts it.
   *  Clamped to the same 1.5–98% band the server enforces, so the UI can never
   *  show a size the save will silently change underneath it. */
  const nudgeFixture = useCallback((id, patch) => {
    setFixtureDraft((prev) => {
      const key = String(id);
      const cur = (prev || {})[key] || {};
      const next = { ...cur, ...patch };
      if (next.w_pct != null) next.w_pct = Math.min(98, Math.max(1.5, next.w_pct));
      if (next.h_pct != null) next.h_pct = Math.min(98, Math.max(1.5, next.h_pct));
      if (next.rotation_deg != null) next.rotation_deg = ((next.rotation_deg % 360) + 360) % 360;
      return { ...(prev || {}), [key]: next };
    });
  }, []);

  // Cycle a table through the preset design library (the order in SHAPES).
  const toggleShape = useCallback((id) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const key = String(id);
      const cur = prev[key];
      if (!cur) return prev;
      const i = SHAPES.indexOf(normalizeShape(cur.shape));
      const next = SHAPES[(i + 1) % SHAPES.length];
      return { ...prev, [key]: { ...cur, shape: next } };
    });
  }, []);

  // Seat stepper (Arrange mode). Writes capacity into the DRAFT so a seat edit
  // reverts with Cancel alongside placement. Clamped 1–30 in the UI (the
  // backend re-clamps 1–100); capacity_seats stays the authoritative number.
  const setSeats = useCallback((id, nextCap) => {
    const cap = Math.max(1, Math.min(30, Math.round(nextCap)));
    setDraft((prev) => {
      if (!prev) return prev;
      const key = String(id);
      const cur = prev[key] || {};
      return { ...prev, [key]: { ...cur, capacity: cap } };
    });
  }, []);

  // Rotate stepper (Arrange mode). Writes rotation_deg into the DRAFT, normalised
  // to [0,360); cosmetic, reverts with Cancel. 0 = upright.
  const setRotation = useCallback((id, nextDeg) => {
    const deg = ((Math.round(nextDeg) % 360) + 360) % 360;
    setDraft((prev) => {
      if (!prev) return prev;
      const key = String(id);
      const cur = prev[key] || {};
      return { ...prev, [key]: { ...cur, rotation_deg: deg } };
    });
  }, []);

  // Size stepper (Arrange mode). Writes size_scale into the DRAFT; cosmetic,
  // clamped 0.5–2.5, reverts with Cancel. Scales the drawn footprint only —
  // seats stay the authoritative capacity.
  const setSize = useCallback((id, nextScale) => {
    const scale = Math.max(0.5, Math.min(2.5, Math.round(nextScale * 20) / 20));
    setDraft((prev) => {
      if (!prev) return prev;
      const key = String(id);
      const cur = prev[key] || {};
      return { ...prev, [key]: { ...cur, size_scale: scale } };
    });
  }, []);

  // ── Drag (pointer + touch via Pointer Events) ─────────────────────────
  const onPointerDownDrag = useCallback(
    (e, id, isFixture = false) => {
      if (!editing) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        id: String(id),
        // Which layer this gesture belongs to. The pointer math is identical;
        // only the destination differs.
        isFixture,
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      };
      if (!isFixture) setActiveId(String(id));
      try {
        e.currentTarget.setPointerCapture?.(e.pointerId);
      } catch {
        /* capture unsupported — move listener still works */
      }
    },
    [editing],
  );

  // Global move/up handlers while a drag is active. Bound to window so the
  // pointer can leave the table box without dropping the drag.
  useEffect(() => {
    if (!editing) return;
    const onMove = (e) => {
      const drag = dragRef.current;
      if (!drag || e.pointerId !== drag.pointerId) return;
      // Tap-vs-drag: ignore sub-threshold jitter so a TAP (which selects the
      // table) never nudges it, and only real movement counts as a drag.
      if (!drag.moved) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < 6) return;
        drag.moved = true;
      }
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const px = ((e.clientX - rect.left) / rect.width) * 100;
      const py = ((e.clientY - rect.top) / rect.height) * 100;
      if (drag.isFixture) {
        setFixtureDraft((prev) => ({
          ...(prev || {}),
          [drag.id]: {
            ...((prev || {})[drag.id] || {}),
            pos_x: clampPct(px),
            pos_y: clampPct(py),
          },
        }));
        return;
      }
      setDraft((prev) => {
        if (!prev) return prev;
        const cur = prev[drag.id];
        if (!cur) return prev;
        return {
          ...prev,
          [drag.id]: { ...cur, pos_x: clampPct(px), pos_y: clampPct(py) },
        };
      });
    };
    const onUp = (e) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (e && e.pointerId != null && e.pointerId !== drag.pointerId) return;
      // A tap that never crossed the drag threshold selects the table (opens
      // the Inspector). A real drag just drops; a pointercancel never selects.
      if (e && e.type === "pointerup" && !drag.moved) {
        if (drag.isFixture) {
          // Selecting a fixture clears any table selection and vice versa —
          // one Inspector, one subject, so the size stepper can never be
          // pointing at something other than what's outlined.
          setSelectedFixtureId(drag.id);
          setSelectedId(null);
        } else {
          setSelectedId(drag.id);
          setSelectedFixtureId(null);
        }
      }
      dragRef.current = null;
      setActiveId(null);
    };
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
    };
  }, [editing]);

  // ── Save layout → PUT /reservations/resources/layout ──────────────────
  const saveLayout = useCallback(async () => {
    if (!draft) return;
    setSaving(true);
    setSaveError("");
    const body = {
      layout: cells.map((c) => {
        const id = String(c.res.id);
        const l = draft[id] || baseLayout[id];
        return {
          id: c.res.id,
          pos_x: Math.round((l?.pos_x ?? 50) * 10) / 10,
          pos_y: Math.round((l?.pos_y ?? 50) * 10) / 10,
          shape: normalizeShape(l?.shape),
          // Only send seats/rotation when the owner actually changed them — a
          // position-only save must not re-capacity or re-orient every table.
          ...(l?.capacity != null ? { capacity: l.capacity } : {}),
          ...(l?.rotation_deg != null ? { rotation_deg: l.rotation_deg } : {}),
          ...(l?.size_scale != null ? { size_scale: l.size_scale } : {}),
        };
      }),
    };
    // The fixture half of the same Save. Sent only for fixtures the owner
    // actually moved or resized — an untouched bar must not be rewritten with
    // values this client happens to be holding.
    const movedFixtures = Object.entries(fixtureDraft || {}).map(([id, v]) => ({
      id,
      ...(v.pos_x != null ? { pos_x: Math.round(v.pos_x * 10) / 10 } : {}),
      ...(v.pos_y != null ? { pos_y: Math.round(v.pos_y * 10) / 10 } : {}),
      ...(v.w_pct != null ? { w_pct: Math.round(v.w_pct * 10) / 10 } : {}),
      ...(v.h_pct != null ? { h_pct: Math.round(v.h_pct * 10) / 10 } : {}),
      ...(v.rotation_deg != null ? { rotation_deg: v.rotation_deg } : {}),
    }));

    try {
      await api.put("/reservations/resources/layout", body);
      if (movedFixtures.length) {
        // Sequential, not Promise.all: if the fixture save fails we want the
        // error to name THAT, with the table layout already safely committed,
        // rather than one ambiguous rejection covering both.
        await api.put("/reservations/fixtures/layout", { fixtures: movedFixtures });
        setLocalFixtures(
          (liveFixtures || []).map((f) => {
            const patch = fixtureDraft?.[String(f.id)];
            return patch ? { ...f, ...patch } : f;
          }),
        );
      }
      // Patch the in-memory res objects so the NEXT parent re-derive of cells
      // (poll/refetch) rebuilds baseLayout with the saved positions. This
      // alone is not enough for the current render — baseLayout is memoized
      // on cells identity and still holds pre-drag positions — so we also
      // keep the draft as savedLayout and render from it until cells change.
      cells.forEach((c) => {
        const l = draft[String(c.res.id)];
        if (l) {
          c.res.pos_x = l.pos_x;
          c.res.pos_y = l.pos_y;
          c.res.shape = l.shape;
          if (l.capacity != null) c.res.capacity_seats = l.capacity;
          if (l.rotation_deg != null) c.res.rotation_deg = l.rotation_deg;
          if (l.size_scale != null) c.res.size_scale = l.size_scale;
        }
      });
      haptic.success();
      setSavedLayout(draft);
      setSavedAt(Date.now());
      setEditing(false);
      setDraft(null);
      setFixtureDraft(null);
      setSelectedFixtureId(null);
      setActiveId(null);
    } catch (e) {
      setSaveError(
        e?.response?.data?.detail?.error ||
          t("rsvpPlanSaveError", "Couldn't save the layout. Please try again."),
      );
    } finally {
      setSaving(false);
    }
  }, [draft, fixtureDraft, liveFixtures, cells, baseLayout, t]);

  // Auto-dismiss the saved toast.
  useEffect(() => {
    if (!savedAt) return;
    const id = setTimeout(() => setSavedAt(0), 2600);
    return () => clearTimeout(id);
  }, [savedAt]);

  // ── Quick-add table (arrange mode) → POST /reservations/resources ─────
  // Auto-labels "Bord N", drops the new table mid-room already selected so
  // the owner drags it into place and hits Save. Caps (free tier = 3 tables)
  // surface as an honest upgrade message, not a silent failure.
  const addTable = useCallback(async () => {
    setAddBusy(true);
    setAddError("");
    try {
      const nums = cells.map((c) => {
        const m = /^Bord (\d+)$/.exec((c.res.label || "").trim());
        return m ? parseInt(m[1], 10) : 0;
      });
      const label = `Bord ${Math.max(0, ...nums, cells.length) + 1}`;
      const res = await api.post("/reservations/resources", {
        kind: "table",
        label,
        capacity_seats: parseInt(addSeats, 10) || 2,
        pos_x: 50,
        pos_y: 45,
        shape: "round",
      });
      const id = String(res.data?.id ?? "");
      if (id) {
        setDraft((prev) => ({
          ...(prev || JSON.parse(JSON.stringify(currentLayout))),
          [id]: { pos_x: 50, pos_y: 45, shape: "round" },
        }));
        setActiveId(id);
      }
      setAdding(false);
      if (onResourcesChanged) await onResourcesChanged();
    } catch (e) {
      if (e?.response?.status === 402) {
        setAddError(t("rsvpTableCapMsg", "Table limit reached on your plan."));
      } else {
        setAddError(t("rsvpAddTableErr", "Couldn't add the table."));
      }
    } finally {
      setAddBusy(false);
    }
  }, [cells, addSeats, currentLayout, onResourcesChanged, t]);

  // Tap router (view mode): free → seat walk-in; occupied → open booking.
  const handleTap = useCallback(
    (cell) => {
      if (cell.status === "inactive") return;
      if (cell.status === "free") {
        onSeatNow && onSeatNow(cell.res);
      } else if (cell.booking?.reservation) {
        onSelect && onSelect(cell.booking.reservation);
      }
    },
    [onSeatNow, onSelect],
  );

  // Empty state — no tables/stations/spaces at all. Copy + icon follow the
  // venue archetype so a salon sees "No stations yet", a bar bar-wording, etc.
  if (!cells || cells.length === 0) {
    const EmptyIcon = profile.icon;
    return (
      <div className="rounded-2xl border border-dashed border-gray-300 dark:border-gray-700 bg-gradient-to-b from-gray-50 to-white dark:from-gray-900/60 dark:to-gray-900 py-14 text-center">
        <div className="mx-auto mb-3 w-14 h-14 rounded-2xl bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 flex items-center justify-center shadow-sm">
          <EmptyIcon className="w-6 h-6 text-gray-300 dark:text-gray-600" aria-hidden />
        </div>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-200">
          {t(profile.emptyTitleKey, "No tables yet")}
        </p>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-sm mx-auto">
          {t(profile.emptyBodyKey, "Add tables on the Floor tab to see your room here.")}
        </p>
      </div>
    );
  }

  // The "next free" line shows outside Arrange whenever the room has started.
  const showTurnLine = !editing && (turn.freeNow > 0 || turn.occupied > 0);

  return (
    <div className="space-y-3">
      {/* Toolbar: title + edit controls. The "next free" line is the last item
          of this wrapping row: from sm: up it takes a full line of its own
          under the controls, exactly where it always sat; on a phone it moves
          to the front and shares ONE row with the Arrange button, and the
          capacity chip (fixed facts, not service) steps aside for it. */}
      <div
        className="flex items-center justify-between gap-3 flex-wrap max-sm:items-stretch"
      >
        {/* On the door screen the room is the point: the seat count, the tap
            hint and "Indret lokale" give their space to the floor (Arrange
            still shows them while editing). The "N free now" line stays. */}
        <div
          className={
            "flex items-center gap-2.5 text-[11px] font-medium text-gray-500 dark:text-gray-400 flex-wrap" +
            (showTurnLine ? " max-sm:hidden" : "") +
            (fitToScreen && !editing ? " hidden" : "")
          }
        >
          {/* Room capacity — what fits at one seating. */}
          <span className="inline-flex items-center gap-1.5 px-2 py-1 rounded-lg bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 tabular-nums">
            <Users className="w-3.5 h-3.5 text-gray-400 dark:text-gray-500" aria-hidden />
            {t("rsvpFloorSeats", "{n} seats", { n: capacity.seats })}
            <span className="text-gray-300 dark:text-gray-600" aria-hidden>·</span>
            {t("rsvpFloorTables", "{n} tables", { n: capacity.tables })}
          </span>
          {editing ? (
            <span className="inline-flex items-center gap-1.5 text-gray-700 dark:text-gray-200">
              <Move className="w-3.5 h-3.5" aria-hidden />
              {t(profile.dragHintKey, "Drag tables to arrange. Tap the icon to switch round / square.")}
            </span>
          ) : (
            // Hidden on a phone: it is instructional, learned on the first
            // visit, and it was costing a line of the screen every service
            // thereafter. The DRAG hint above stays at every width — that one
            // appears only in Arrange mode, where it is the actual instruction.
            <span className="hidden sm:inline-flex items-center gap-1.5">
              {t(profile.tapHintKey, "Tap a table to seat or open a booking.")}
            </span>
          )}
        </div>
        <div className={"flex items-center gap-2" + (fitToScreen && !editing ? " hidden" : "")}>
          {editing ? (
            <>
              <button
                type="button"
                onClick={() => {
                  setAdding((v) => !v);
                  setAddError("");
                }}
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1"
              >
                <Plus className="w-4 h-4" aria-hidden />
                {t("rsvpAddTable", "Add table")}
              </button>
              {/* Add the room ITSELF — the bar, the door, a window, a wall.
                  Sits next to Add table because to an owner arranging their
                  room these are the same act: putting a thing where it is.
                  Plain buttons rather than a dropdown: four items, and a menu
                  would put a tap between the owner and every one of them. */}
              {FIXTURE_KINDS.map((kind) => (
                <button
                  key={kind}
                  type="button"
                  disabled={fixtureBusy}
                  onClick={() => addFixture(kind)}
                  className="inline-flex items-center gap-1.5 min-h-[40px] px-2.5 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1"
                >
                  <Plus className="w-3.5 h-3.5" aria-hidden />
                  {t(FIXTURE_LABELS[kind][0], FIXTURE_LABELS[kind][1])}
                </button>
              ))}
              <button
                type="button"
                onClick={autoArrange}
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1"
              >
                <LayoutGrid className="w-4 h-4" aria-hidden />
                {t("rsvpAutoArrange", "Auto-arrange")}
              </button>
              <button
                type="button"
                onClick={resetDraft}
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 focus-visible:ring-offset-1"
              >
                <RotateCcw className="w-4 h-4" aria-hidden />
                {t("rsvpPlanReset", "Reset")}
              </button>
              <button
                type="button"
                onClick={cancelEdit}
                disabled={saving}
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg text-sm font-medium text-gray-600 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors disabled:opacity-50"
              >
                <X className="w-4 h-4" aria-hidden />
                {t("rsvpPlanCancel", "Cancel")}
              </button>
              <Button
                variant="primary"
                size="sm"
                busy={saving}
                onClick={saveLayout}
                iconLeft={<Check className="w-4 h-4" />}
              >
                {t("rsvpPlanSave", "Save layout")}
              </Button>
            </>
          ) : canArrange ? (
            // Icon-only on a phone, beside the "next free" line; the name is
            // still its accessible name and its tooltip.
            <button
              type="button"
              onClick={enterEdit}
              aria-label={t(profile.arrangeKey, "Arrange room")}
              title={t(profile.arrangeKey, "Arrange room")}
              className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 hover:text-gray-900 hover:border-gray-300 hover:bg-gray-50 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors max-sm:min-h-0! max-sm:h-full max-sm:w-10 max-sm:px-0 max-sm:justify-center max-sm:bg-[rgb(var(--surface-card))]"
            >
              <Pencil className="w-4 h-4" aria-hidden />
              <span className="max-sm:sr-only">{t(profile.arrangeKey, "Arrange room")}</span>
            </button>
          ) : null}
        </div>

      {/* "Next free" — the one line a host reads when a walk-in comes in.
          Calm when tables are open; a firmer grey with ⚠ when the room's full and the answer
          is "wait for HH:MM". Live (ticks with nowMs). Hidden while arranging
          and on an empty/unstarted room (nothing to say). */}
      {showTurnLine && (
        <div
          className={
            "flex items-center gap-2 rounded-xl px-3.5 py-2.5 text-sm basis-full order-last " +
            "max-sm:order-first max-sm:basis-0 max-sm:flex-1 max-sm:min-w-0 max-sm:min-h-10 " +
            "max-sm:px-3 max-sm:py-2 max-sm:text-[13px] max-sm:rounded-lg " +
            (turn.freeNow > 0
              ? "bg-gray-50 dark:bg-gray-800/60 border border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-200"
              // Amber is the request colour now; a full room is a fact, said in ink.
              : "bg-gray-100 dark:bg-gray-800 border border-gray-300 dark:border-gray-600 text-gray-900 dark:text-gray-100 font-medium")
          }
          role="status"
          aria-live="polite"
        >
          {turn.freeNow > 0 ? (
            <>
              {/* The free-table mark, as on the floor: white, ringed. */}
              <span className="w-2 h-2 rounded-full bg-white ring-1 ring-gray-400 dark:bg-gray-900 dark:ring-gray-500 shrink-0" aria-hidden />
              <span className="font-medium shrink-0">
                {t("rsvpTurnFreeNow", "{n} free now", { n: turn.freeNow })}
              </span>
              {turn.nextAt && (
                <span className="text-gray-400 dark:text-gray-500 truncate min-w-0">
                  · {t("rsvpTurnNextFrees", "next frees {time}", { time: turn.nextAt })}
                </span>
              )}
            </>
          ) : (
            <>
              <Clock className="w-4 h-4 shrink-0" aria-hidden />
              <span className="font-medium shrink-0">
                {t("rsvpTurnAllBusy", "All tables occupied")}
              </span>
              {turn.nextAt && (
                <span className="truncate min-w-0">
                  · {t("rsvpTurnNextFrees", "next frees {time}", { time: turn.nextAt })}
                  {turn.nextIn != null && turn.nextIn <= 0
                    ? " " + t("rsvpTurnNow", "(now)")
                    : turn.nextIn != null && turn.nextIn <= 30
                      ? " " + t("rsvpTurnInMin", "(~{n} min)", { n: turn.nextIn })
                      : ""}
                </span>
              )}
            </>
          )}
        </div>
      )}
      </div>

      {saveError && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-2.5 rounded-xl text-sm">
          {saveError}
        </div>
      )}


      {/* Quick-add table — seats picker inline under the arrange toolbar.
          The new table lands mid-room, pre-selected, ready to drag. */}
      {editing && adding && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 px-4 py-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
            {t("rsvpSeats", "Seats")}
          </span>
          {["2", "4", "6", "8"].map((n) => (
            <button
              key={n}
              type="button"
              onClick={() => setAddSeats(n)}
              className={
                "h-10 min-w-[40px] px-3 rounded-lg border text-sm font-medium tabular-nums transition-colors " +
                (addSeats === n
                  ? "bg-gray-900 text-white border-gray-900 dark:bg-gray-100 dark:text-gray-900 dark:border-gray-100"
                  : "border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600")
              }
            >
              {n}
            </button>
          ))}
          <Button variant="primary" size="sm" busy={addBusy} onClick={addTable} iconLeft={<Plus className="w-4 h-4" />}>
            {t("rsvpAddTable", "Add table")}
          </Button>
          {addError && (
            <span className="text-sm text-red-600 dark:text-red-400">{addError}</span>
          )}
        </div>
      )}

      {/* The room. The canvas keeps its 560px min-width so tables stay legible
          and tappable, which on a phone means the room is WIDER than the
          screen and pans. The fade and the hint below exist so that reads as
          "the room continues over there" rather than "this is cut off" — the
          fade is the wall colour, so the room appears to run on past the edge.
          Both are suppressed the moment there is nothing left to pan to. */}
      <div className="relative">
      <div
        ref={scrollerRef}
        onScroll={(e) => measurePan(e.currentTarget)}
        className="overflow-x-auto rounded-2xl"
      >
        <div
          ref={setCanvasEl}
          data-floor-canvas=""
          onPointerDown={editing ? () => setSelectedId(null) : undefined}
          className={
            "relative w-full rounded-2xl border overflow-hidden " +
            // The canvas body is the WALL (see RoomShell) — so the border has
            // to be wall-coloured too, or a light hairline haloes the masonry.
            "bg-slate-900 dark:bg-slate-950 " +
            (editing
              ? "border-slate-700 ring-2 ring-white/15"
              : "border-slate-900 dark:border-black")
          }
          style={
            fitToScreen
              ? {
                  aspectRatio: "16 / 10",
                  // The whole room on the screen: as wide as the height left
                  // under the room's measured top allows, centred. No minimum
                  // width here — the room draws its tables smaller (fitRoom)
                  // rather than send the host scrolling for Bord 13.
                  width: `min(100%, calc((100dvh - ${(fitTop ?? 300) + 16}px) * 1.6))`,
                  marginInline: "auto",
                }
              : { aspectRatio: "16 / 10", minWidth: roomMinW }
          }
        >
          {/* Walls + drafting grid + paper floor. FIRST child on purpose:
              nothing here is positioned or z-indexed, so paint order is DOM
              order and the shell must precede the zone bands and the tables.
              It is decorative and pointer-events-none — table coordinates stay
              a % of THIS canvas, never of the inset floor, so no saved
              pos_x/pos_y changes meaning. */}
          <RoomShell />

          {/* The room's own objects — bar, entrance, window, wall. Painted
              ABOVE the shell and BELOW the tables: a decorative wall must
              never sit on top of a live booking a host is trying to tap. */}
          <FloorFixtures
            fixtures={shownFixtures}
            t={t}
            editing={editing}
            selectedId={selectedFixtureId}
            onPointerDownDrag={(e, id) => onPointerDownDrag(e, id, true)}
            onTap={(id) => {
              setSelectedFixtureId(String(id));
              setSelectedId(null);
            }}
          />



          {/* Tables */}
          {cells.map((c) => {
            const id = String(c.res.id);
            const savedPos = layout[id] || { pos_x: 50, pos_y: 50, shape: "round" };
            const pos = fitted.pos[id] ? { ...savedPos, ...fitted.pos[id] } : savedPos;
            const isNext =
              !editing &&
              nextBookingId != null &&
              c.booking?.reservation?.id === nextBookingId;
            // Resolve the node's archetype with the per-resource override: a
            // provider station renders salon-style (person marker) even inside
            // a dining venue, otherwise it inherits the account profile.
            const cellProfile = venueProfile(businessType, c.res);
            return (
              // NB: NO `relative` here — these children are absolutely
              // positioned with top/left as a % of the CANVAS. A `relative`
              // wrapper collapses to height:0 (its only children are absolute),
              // so `top: %` would resolve against 0 and pin every table to the
              // top edge (x worked, y didn't). Positioning against the canvas
              // (which has a real height via aspectRatio) fixes layout + drag-Y.
              <div key={id} className="contents">
                <TableNode
                  cell={c}
                  pos={pos}
                  nowMs={nowMs}
                  zoneDot={editing ? null : zoneInfo.byId[id] || null}
                  comboSeats={
                    c.combined && Array.isArray(c.booking?.reservation?.combined_resource_ids)
                      ? c.booking.reservation.combined_resource_ids.reduce((sum, rid) => sum + (seatsByRes[String(rid)] || 0), 0) || null
                      : null
                  }
                  t={t}
                  profile={cellProfile}
                  editing={editing}
                  selected={isNext || activeId === id || (editing && selectedId === id)}
                  onTap={handleTap}
                  onPointerDownDrag={onPointerDownDrag}
                  onToggleShape={toggleShape}
                  fitScale={fitted.scale}
                />
                {/* "Your next booking" accent ring — track the DRAWN footprint so
                    it keeps hugging a scaled table (same size_scale the body uses). */}
                {isNext && (() => {
                  const nextScale =
                    pos.size_scale != null ? pos.size_scale : c.res.size_scale || 1;
                  const ringPx =
                    Math.round(tableSizePx(c.res.capacity_seats) * nextScale * fitted.scale) + 6;
                  return (
                    <span
                      className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-gray-900/60 dark:ring-gray-100/60 ring-offset-2 ring-offset-transparent pointer-events-none animate-pulse"
                      style={{
                        left: `${pos.pos_x}%`,
                        top: `${pos.pos_y}%`,
                        width: ringPx,
                        height: ringPx,
                      }}
                      aria-hidden
                    />
                  );
                })()}
              </div>
            );
          })}
        </div>
      </div>
        {/* Sits OUTSIDE the scroller on purpose — inside it, the fade would
            scroll away with the room and stop marking the edge. */}
        {pan.can && !pan.atEnd && (
          <div
            className="bb-room-panfade pointer-events-none absolute inset-y-0 right-0 w-16 rounded-r-2xl"
            aria-hidden
          />
        )}
      </div>
      {pan.can && (
        <p className="text-[11px] text-gray-500 dark:text-gray-400">
          {/* "Stryg" is a touch word; with a mouse the room scrolls. */}
          {typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)")?.matches
            ? t("rsvpPlanPan", "Swipe to see the rest of the room.")
            : t("rsvpPlanPanScroll", "Scroll sideways to see the rest of the room.")}
        </p>
      )}

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-gray-500 dark:text-gray-400 pt-0.5">
        <LegendItem dotCls="bg-white ring-1 ring-gray-300 dark:bg-[rgb(var(--surface-card))] dark:ring-gray-600" label={t("rsvpTileFree", "Free")} />
        <LegendItem dotCls="bg-sky-500" label={t("rsvpLegUpcoming", "Upcoming")} />
        <LegendItem dotCls="bg-amber-500" label={t("rsvpLegRequest", "Request")} />
        <LegendItem dotCls="bg-orange-500" label={t("rsvpLegLate", "Late")} />
        {/* Zones: the same hollow rings as on the tables and in the list. */}
        {zoneInfo.zones.map((z) => (
          <LegendItem key={z.zone} dotCls={"bg-transparent border-2 " + z.cls} label={z.zone} />
        ))}
        <LegendItem dotCls="bg-emerald-600" label={t("rsvpTileSeated", "Seated")} />
        <LegendItem dotCls="bg-red-500" label={t("rsvpPlanOverdue", "Overdue")} />
        {nextBookingId != null && (
          <LegendItem dotCls="bg-transparent ring-2 ring-gray-900 dark:ring-gray-100" label={t("rsvpNextArrival", "Next arrival")} />
        )}
      </div>

      {/* Inspector — tap a table in Arrange mode to edit it. A bottom sheet
          keeps the controls under the thumb (never behind a finger on the
          canvas) and sidesteps tiny on-tile hit targets on small tables.
          .glass-static = frosted panel with NO transform (iOS-wobble-safe). */}
      {/* Fixture inspector — the same bottom sheet as the table one, so the
          controls sit under the thumb rather than behind a finger on a small
          object. Shown only while arranging and only for the selected fixture. */}
      {editing && selectedFixtureId && (() => {
        const f = shownFixtures.find((x) => String(x.id) === String(selectedFixtureId));
        if (!f) return null;
        const [lk, lf] = FIXTURE_LABELS[normalizeFixtureKind(f.kind)];
        const step = (patch) => nudgeFixture(f.id, patch);
        return (
          <div className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom)+68px)] md:pb-[calc(env(safe-area-inset-bottom)+12px)] pointer-events-none">
            <div className="pointer-events-auto w-full max-w-md glass rounded-2xl border border-gray-200/70 dark:border-gray-700/70 shadow-2xl px-4 py-3 space-y-3">
              <div className="flex items-center justify-between gap-3">
                {/* Call it what you call it. Empty falls back to the
                    translated kind name, so clearing the box is a valid
                    choice and never leaves an unnamed object. */}
                <input
                  type="text"
                  value={f.label || ""}
                  maxLength={60}
                  placeholder={t(lk, lf)}
                  onChange={(e) => renameFixture(f.id, e.target.value)}
                  aria-label={t("rsvpFixtureName", "Name")}
                  className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-gray-900 dark:text-gray-100 placeholder:font-normal placeholder:text-gray-400 dark:placeholder:text-gray-500 rounded-lg px-2 py-1.5 border border-transparent hover:border-gray-200 focus:border-gray-300 dark:hover:border-gray-700 dark:focus:border-gray-600 focus:outline-none"
                />
                <button
                  type="button"
                  onClick={() => setSelectedFixtureId(null)}
                  className="inline-flex items-center justify-center h-8 w-8 rounded-lg text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800"
                  aria-label={t("rsvpFixtureClose", "Close")}
                >
                  <X className="w-4 h-4" aria-hidden />
                </button>
              </div>
              <div className="flex items-center gap-2 flex-wrap text-sm">
                <FixtureStepper
                  label={t("rsvpFixtureWide", "Width")}
                  onLess={() => step({ w_pct: (f.w_pct || 10) - 2 })}
                  onMore={() => step({ w_pct: (f.w_pct || 10) + 2 })}
                  value={`${Math.round(f.w_pct)}%`}
                />
                <FixtureStepper
                  label={t("rsvpFixtureTall", "Height")}
                  onLess={() => step({ h_pct: (f.h_pct || 10) - 2 })}
                  onMore={() => step({ h_pct: (f.h_pct || 10) + 2 })}
                  value={`${Math.round(f.h_pct)}%`}
                />
                <button
                  type="button"
                  onClick={() => step({ rotation_deg: (f.rotation_deg || 0) + 90 })}
                  className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg border border-gray-200 dark:border-gray-700 font-medium text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800"
                >
                  <RotateCw className="w-4 h-4" aria-hidden />
                  {t("rsvpFixtureRotate", "Rotate")}
                </button>
                <button
                  type="button"
                  disabled={fixtureBusy}
                  onClick={() => deleteFixture(f.id)}
                  className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg font-medium text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-950/40 disabled:opacity-50"
                >
                  <X className="w-4 h-4" aria-hidden />
                  {t("rsvpFixtureRemove", "Remove")}
                </button>
              </div>
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                {t("rsvpFixtureHint", "Drag it where it sits in your room. Size and position save with the layout.")}
              </p>
            </div>
          </div>
        );
      })()}

      {selectedCell && (
        // Outer rail is invisible + click-through — it only CENTRES the card, so
        // the sheet hugs its content instead of slabbing across the whole viewport.
        // The card itself floats (rounded on all sides) with the frosted .glass
        // finish, so the room reads through it. .glass (not .glass-static) is the
        // house convention for FIXED bars — it carries the compositor hint.
        // z-[60] + phone clearance: the app's mobile bottom nav is fixed z-50,
        // 56px tall and md:hidden — without these the nav covers the stepper
        // row. Below md the card floats above the nav; ≥md it hugs the edge.
        <div className="fixed inset-x-0 bottom-0 z-[60] flex justify-center px-3 pb-[calc(env(safe-area-inset-bottom)+68px)] md:pb-[calc(env(safe-area-inset-bottom)+12px)] pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))] pointer-events-none">
          <div className="pointer-events-auto w-full max-w-md glass rounded-2xl border border-gray-200/70 dark:border-gray-700/70 shadow-2xl px-4 py-3 space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                  {selectedCell.res.label}
                </div>
                <div className="text-[11px] text-gray-500 dark:text-gray-400">
                  {t("rsvpPlanInspSeatsHint", "Booking capacity")}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedId(null)}
                className="h-10 px-4 inline-flex items-center rounded-full bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 text-sm font-medium active:scale-95 transition shrink-0"
              >
                {t("rsvpPlanInspDone", "Done")}
              </button>
            </div>
            <div className="flex items-center justify-between gap-3 flex-wrap">
              {/* Seats — the booking-authoritative number */}
              <div className="flex items-center gap-2">
                <span className="w-14 text-xs font-medium text-gray-500 dark:text-gray-400">
                  {t("rsvpPlanInspSeats", "Seats")}
                </span>
                <button
                  type="button"
                  onClick={() => setSeats(selectedId, selectedSeats - 1)}
                  disabled={selectedSeats <= 1}
                  aria-label={t("rsvpPlanSeatMinus", "Fewer seats")}
                  className="h-10 w-10 inline-flex items-center justify-center rounded-full border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-40 active:scale-95 transition"
                >
                  <Minus className="w-4 h-4" aria-hidden />
                </button>
                <span className="w-7 text-center text-lg font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                  {selectedSeats}
                </span>
                <button
                  type="button"
                  onClick={() => setSeats(selectedId, selectedSeats + 1)}
                  disabled={selectedSeats >= 30}
                  aria-label={t("rsvpPlanSeatPlus", "More seats")}
                  className="h-10 w-10 inline-flex items-center justify-center rounded-full border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-40 active:scale-95 transition"
                >
                  <Plus className="w-4 h-4" aria-hidden />
                </button>
              </div>
              {/* Rotate — cosmetic orientation, 15° steps */}
              <div className="flex items-center gap-2">
                <span className="w-14 text-xs font-medium text-gray-500 dark:text-gray-400">
                  {t("rsvpPlanInspRotate", "Rotate")}
                </span>
                <button
                  type="button"
                  onClick={() => setRotation(selectedId, selectedRotation - 15)}
                  aria-label={t("rsvpPlanRotateLeft", "Rotate left")}
                  className="h-10 w-10 inline-flex items-center justify-center rounded-full border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 active:scale-95 transition"
                >
                  <RotateCcw className="w-4 h-4" aria-hidden />
                </button>
                <span className="w-9 text-center text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                  {selectedRotation}°
                </span>
                <button
                  type="button"
                  onClick={() => setRotation(selectedId, selectedRotation + 15)}
                  aria-label={t("rsvpPlanRotateRight", "Rotate right")}
                  className="h-10 w-10 inline-flex items-center justify-center rounded-full border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 active:scale-95 transition"
                >
                  <RotateCw className="w-4 h-4" aria-hidden />
                </button>
              </div>
              {/* Size — cosmetic drawn-size scale (bigger / smaller) */}
              <div className="flex items-center gap-2">
                <span className="w-14 text-xs font-medium text-gray-500 dark:text-gray-400">
                  {t("rsvpPlanInspSize", "Size")}
                </span>
                <button
                  type="button"
                  onClick={() => setSize(selectedId, selectedSize - 0.25)}
                  disabled={selectedSize <= 0.5}
                  aria-label={t("rsvpPlanSizeMinus", "Smaller")}
                  className="h-10 w-10 inline-flex items-center justify-center rounded-full border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-40 active:scale-95 transition"
                >
                  <Minus className="w-4 h-4" aria-hidden />
                </button>
                <span className="w-10 text-center text-sm font-semibold tabular-nums text-gray-900 dark:text-gray-100">
                  {Math.round(selectedSize * 100)}%
                </span>
                <button
                  type="button"
                  onClick={() => setSize(selectedId, selectedSize + 0.25)}
                  disabled={selectedSize >= 2.5}
                  aria-label={t("rsvpPlanSizePlus", "Bigger")}
                  className="h-10 w-10 inline-flex items-center justify-center rounded-full border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-200 disabled:opacity-40 active:scale-95 transition"
                >
                  <Plus className="w-4 h-4" aria-hidden />
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Saved toast */}
      {savedAt > 0 && (
        <div className="fixed bottom-[calc(env(safe-area-inset-bottom)+72px)] md:bottom-5 left-1/2 -translate-x-1/2 z-[60] inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 shadow-lg text-sm font-medium">
          <Check className="w-4 h-4" aria-hidden />
          {t("rsvpPlanSaved", "Layout saved")}
        </div>
      )}
    </div>
  );
}
