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
// Design doctrine: gray-* palette; emerald only for the live/"free" + money
// moments; rounded shapes, soft shadows, subtle status glow, calm grid.
// Mobile / host-stand friendly: the canvas pans horizontally on a narrow
// screen so a big room stays usable.
//
// i18n: every user-facing string goes through t("key", "fallback") and has a
// real EN + DA entry in useLanguage.jsx (rsvpPlan* / rsvpArrange* keys).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
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
import Button from "./ui/Button";
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

// ── Status → visual tokens ────────────────────────────────────────────
// Mirrors deriveFloorState's status vocabulary, mapped onto the brand
// palette. "overdue" is derived here (a seated booking past its end time),
// so the room can flag a table that's running long in red.
//   free      → emerald   (open, invite to seat)
//   upcoming  → amber      (booked / holding, guest due)
//   seated    → gray-900   (occupied now — solid, committed)
//   overdue   → solid red  (seated past end — needs turning)
//   inactive  → muted gray (out of service)
const STATUS_STYLE = {
  free: {
    fill: "bg-emerald-50 dark:bg-emerald-950/40",
    ring: "ring-emerald-300/70 dark:ring-emerald-700/60",
    dot: "bg-emerald-500",
    text: "text-emerald-900 dark:text-emerald-100",
    chair: "bg-emerald-300/80 dark:bg-emerald-700/70",
    glow: "shadow-[0_0_0_4px_rgba(16,185,129,0.10)]",
  },
  upcoming: {
    fill: "bg-amber-50 dark:bg-amber-950/40",
    ring: "ring-amber-300/80 dark:ring-amber-600/60",
    dot: "bg-amber-500",
    text: "text-amber-900 dark:text-amber-100",
    chair: "bg-amber-300/80 dark:bg-amber-700/70",
    glow: "shadow-[0_0_0_4px_rgba(245,158,11,0.12)]",
  },
  seated: {
    // Occupied = solid gray-900 (committed — "this table is in use"), so the
    // room reads by contrast: dark = seated, emerald = open, amber = arriving,
    // red = running long. (Blue was off the locked palette.)
    fill: "bg-gray-900 dark:bg-gray-100",
    ring: "ring-gray-900 dark:ring-gray-100",
    dot: "bg-emerald-400",
    text: "text-white dark:text-gray-900",
    chair: "bg-gray-700 dark:bg-gray-300",
    glow: "shadow-[0_0_0_4px_rgba(17,24,39,0.12)]",
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
  free: "border-emerald-400 dark:border-emerald-600",
  upcoming: "border-amber-400 dark:border-amber-600",
  seated: "border-gray-500 dark:border-gray-400",
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
  // requested / confirmed holding a future slot
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
  t,
  profile,
  editing,
  selected,
  onTap,
  onPointerDownDrag,
  onToggleShape,
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
  const sizePx = tableSizePx(seats);
  // Chairs scale with the table so big tables get chunky seats, not tiny dots.
  const chairW = Math.max(9, Math.min(15, Math.round(sizePx * 0.17)));
  const shape = pos.shape;
  // Footprint + seat layout come from the shared archetype library, so a
  // Langbord / Bås / Barplads / Højbord is drawn identically here and on the
  // public booker map. round/square keep the legacy square footprint (dims.w
  // === dims.h === sizePx) so existing rooms don't shift.
  const dims = tableDims(shape, seats);
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
  const sub =
    status === "free"
      ? null
      : status === "overdue"
        ? t("rsvpOverBy", "+{n}m over", { n: overMin ?? 0 })
        : status === "upcoming" && booking?.eta != null
          ? t("rsvpEtaIn", "in {n}m", { n: booking.eta })
          : booking
            ? `${booking.time}${booking.name ? " · " + booking.name : ""}`
            : null;

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
          (sub ? " · " + sub : "")
        }
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
        {/* Status dot — top-right corner of the table */}
        <span
          className={"absolute top-1 right-1 w-2.5 h-2.5 rounded-full " + style.dot}
          aria-hidden
        />
        {/* Allergy badge — hangs off the tile edge so it reads from across
            the room. Red = severe, amber = any other recorded allergy. */}
        {allergy && !editing && (
          <span
            className={
              "absolute -top-2 -left-2 w-5 h-5 rounded-full flex items-center justify-center shadow-sm ring-2 ring-white dark:ring-gray-900 pointer-events-none " +
              (allergy === "severe" ? "bg-red-500" : "bg-amber-500")
            }
            aria-label={allergy === "severe" ? t("rsvpAllergySevere", "Severe allergy") : t("rsvpAllergyFlag", "Allergy")}
            role="img"
          >
            <AlertTriangle className="w-3 h-3 text-white" aria-hidden />
          </span>
        )}
        {combined && (
          <Link2
            className="absolute top-1 left-1 w-3 h-3 opacity-70"
            aria-hidden
          />
        )}
        {/* Faint venue icon centred behind the label — the per-business
            signature (chair / beer / scissors). Decorative only: very low
            opacity so the label + count stay the focus, no brand color. */}
        <VenueIcon
          className={"absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-1/2 h-1/2 opacity-[0.06] pointer-events-none " + style.text}
          aria-hidden
        />
        {/* Label + seat chip + detail — counter-rotated so they stay upright and
            legible no matter how the table is turned. The seat number here is the
            honesty anchor: it never tilts, and (once free-resize lands) never
            scales — capacity reads the same on a huge angled table as a small one. */}
        <div
          className="relative flex flex-col items-center gap-0.5 max-w-full"
          style={{ transform: rotation ? `rotate(${-rotation}deg)` : undefined }}
        >
          <span
            className={
              "font-semibold leading-none truncate max-w-full " +
              style.text +
              " " +
              (sizePx >= 80 ? "text-sm" : "text-xs")
            }
          >
            {res.label}
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
                <span className="text-[11px] tabular-nums">
                  {status !== "free" && partySize != null
                    ? `${partySize}/${seats}`
                    : seats}
                </span>
              </>
            )}
          </span>
          {sub && sizePx >= 72 && (
            <span
              className={
                "text-[10px] leading-tight truncate max-w-full tabular-nums " +
                style.text +
                " " +
                (status === "overdue" ? "font-bold" : "opacity-90")
              }
            >
              {sub}
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
}) {
  // Account-level venue archetype — drives the section vocabulary (noun,
  // icon, empty state, hints, zone presets). Per-resource provider overrides
  // are resolved separately, per cell, inside the render loop.
  const profile = useMemo(() => venueProfile(businessType), [businessType]);

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

  // Zone bands — soft labels behind the room so tables read as clusters.
  const zoneBands = useMemo(() => {
    const zones = [];
    const seen = new Set();
    cells.forEach((c) => {
      const z = c.res.zone;
      if (z && !seen.has(z)) {
        seen.add(z);
        zones.push(z);
      }
    });
    return zones;
  }, [cells]);

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

  // ── Edit lifecycle ───────────────────────────────────────────────────
  const enterEdit = useCallback(() => {
    setDraft(JSON.parse(JSON.stringify(currentLayout)));
    setSelectedId(null);
    setSaveError("");
    setEditing(true);
  }, [currentLayout]);

  // Exit WITHOUT saving → revert (draft discarded).
  const cancelEdit = useCallback(() => {
    setDraft(null);
    setActiveId(null);
    setSelectedId(null);
    setEditing(false);
    setSaveError("");
  }, []);

  const resetDraft = useCallback(() => {
    setDraft(JSON.parse(JSON.stringify(currentLayout)));
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

  // ── Drag (pointer + touch via Pointer Events) ─────────────────────────
  const onPointerDownDrag = useCallback(
    (e, id) => {
      if (!editing) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = {
        id: String(id),
        pointerId: e.pointerId,
        startX: e.clientX,
        startY: e.clientY,
        moved: false,
      };
      setActiveId(String(id));
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
        setSelectedId(drag.id);
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
        };
      }),
    };
    try {
      await api.put("/reservations/resources/layout", body);
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
        }
      });
      setSavedLayout(draft);
      setSavedAt(Date.now());
      setEditing(false);
      setDraft(null);
      setActiveId(null);
    } catch (e) {
      setSaveError(
        e?.response?.data?.detail?.error ||
          t("rsvpPlanSaveError", "Couldn't save the layout. Please try again."),
      );
    } finally {
      setSaving(false);
    }
  }, [draft, cells, baseLayout, t]);

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

  return (
    <div className="space-y-3">
      {/* Toolbar: title + edit controls */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-2.5 text-[11px] font-medium text-gray-500 dark:text-gray-400 flex-wrap">
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
            <span className="inline-flex items-center gap-1.5">
              {t(profile.tapHintKey, "Tap a table to seat or open a booking.")}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
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
          ) : (
            <button
              type="button"
              onClick={enterEdit}
              className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg border border-gray-200 dark:border-gray-700 text-sm font-medium text-gray-700 hover:text-gray-900 hover:border-gray-300 hover:bg-gray-50 dark:text-gray-300 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors"
            >
              <Pencil className="w-4 h-4" aria-hidden />
              {t(profile.arrangeKey, "Arrange room")}
            </button>
          )}
        </div>
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

      {/* The room. Horizontal scroll on narrow screens keeps a big room
          usable on a phone / host stand (min-width floor → pan). */}
      <div className="overflow-x-auto rounded-2xl">
        <div
          ref={canvasRef}
          onPointerDown={editing ? () => setSelectedId(null) : undefined}
          className={
            "relative w-full min-w-[560px] rounded-2xl border overflow-hidden " +
            // Calm, near-flat surface so the status-coloured tables pop — a
            // premium room reads by the tables, not a loud wireframe dot-grid.
            "bg-gradient-to-b from-gray-50 to-white dark:from-gray-900 dark:to-gray-950 " +
            (editing
              ? "border-gray-300 dark:border-gray-600 ring-2 ring-gray-900/5 dark:ring-gray-100/5"
              : "border-gray-200 dark:border-gray-800")
          }
          style={{ aspectRatio: "16 / 10" }}
        >
          {/* Soft zone bands + labels behind the tables */}
          {zoneBands.length > 1 &&
            zoneBands.map((z, i) => {
              const h = 100 / zoneBands.length;
              return (
                <div
                  key={z}
                  className="absolute inset-x-0 pointer-events-none"
                  style={{ top: `${h * i}%`, height: `${h}%` }}
                >
                  {i > 0 && (
                    <div className="absolute inset-x-4 top-0 border-t border-dashed border-gray-200 dark:border-gray-700/60" />
                  )}
                  <span className="absolute left-3 top-2 text-[10px] font-semibold uppercase tracking-wider text-gray-400/80 dark:text-gray-500/80">
                    {z}
                  </span>
                </div>
              );
            })}

          {/* Tables */}
          {cells.map((c) => {
            const id = String(c.res.id);
            const pos = layout[id] || { pos_x: 50, pos_y: 50, shape: "round" };
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
                  t={t}
                  profile={cellProfile}
                  editing={editing}
                  selected={isNext || activeId === id || (editing && selectedId === id)}
                  onTap={handleTap}
                  onPointerDownDrag={onPointerDownDrag}
                  onToggleShape={toggleShape}
                />
                {/* "Your next booking" accent ring */}
                {isNext && (
                  <span
                    className="absolute -translate-x-1/2 -translate-y-1/2 rounded-full ring-2 ring-gray-900/60 dark:ring-gray-100/60 ring-offset-2 ring-offset-transparent pointer-events-none animate-pulse"
                    style={{
                      left: `${pos.pos_x}%`,
                      top: `${pos.pos_y}%`,
                      width: tableSizePx(c.res.capacity_seats) + 6,
                      height: tableSizePx(c.res.capacity_seats) + 6,
                    }}
                    aria-hidden
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5 text-[11px] text-gray-500 dark:text-gray-400 pt-0.5">
        <LegendItem dotCls="bg-emerald-500" label={t("rsvpTileFree", "Free")} />
        <LegendItem dotCls="bg-amber-500" label={t("rsvpLegUpcoming", "Upcoming")} />
        <LegendItem dotCls="bg-gray-900 dark:bg-gray-100" label={t("rsvpTileSeated", "Seated")} />
        <LegendItem dotCls="bg-red-500" label={t("rsvpPlanOverdue", "Overdue")} />
        {nextBookingId != null && (
          <LegendItem dotCls="bg-transparent ring-2 ring-gray-900 dark:ring-gray-100" label={t("rsvpPlanNext", "Your next booking")} />
        )}
      </div>

      {/* Inspector — tap a table in Arrange mode to edit it. A bottom sheet
          keeps the controls under the thumb (never behind a finger on the
          canvas) and sidesteps tiny on-tile hit targets on small tables.
          .glass-static = frosted panel with NO transform (iOS-wobble-safe). */}
      {selectedCell && (
        <div className="fixed inset-x-0 bottom-0 z-50 glass-static border-t border-gray-200 dark:border-gray-700 rounded-t-2xl shadow-2xl px-4 pt-3 pb-[calc(env(safe-area-inset-bottom)+14px)]">
          <div className="mx-auto max-w-md space-y-3">
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
            </div>
          </div>
        </div>
      )}

      {/* Saved toast */}
      {savedAt > 0 && (
        <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-50 inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 shadow-lg text-sm font-medium">
          <Check className="w-4 h-4" aria-hidden />
          {t("rsvpPlanSaved", "Layout saved")}
        </div>
      )}
    </div>
  );
}
