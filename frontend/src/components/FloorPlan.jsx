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
  Circle,
  Square,
  Move,
  RotateCcw,
} from "lucide-react";
import api from "../services/api";
import Button from "./ui/Button";
import { venueProfile } from "../config/venueProfiles";

// ── Status → visual tokens ────────────────────────────────────────────
// Mirrors deriveFloorState's status vocabulary, mapped onto the brand
// palette. "overdue" is derived here (a seated booking past its end time),
// so the room can flag a table that's running long in red.
//   free      → emerald  (open, invite to seat)
//   upcoming  → amber     (booked / holding, guest due)
//   seated    → blue      (occupied now)
//   overdue   → red       (seated past end — needs turning)
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
    fill: "bg-blue-50 dark:bg-blue-950/40",
    ring: "ring-blue-300/80 dark:ring-blue-600/60",
    dot: "bg-blue-500",
    text: "text-blue-900 dark:text-blue-100",
    chair: "bg-blue-300/80 dark:bg-blue-700/70",
    glow: "shadow-[0_0_0_4px_rgba(59,130,246,0.12)]",
  },
  overdue: {
    fill: "bg-red-50 dark:bg-red-950/40",
    ring: "ring-red-300/80 dark:ring-red-600/60",
    dot: "bg-red-500",
    text: "text-red-900 dark:text-red-100",
    chair: "bg-red-300/80 dark:bg-red-700/70",
    glow: "shadow-[0_0_0_4px_rgba(239,68,68,0.14)]",
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
  // 2p → 58, 4p → 72, 6p → 86, 8p → 100, capped.
  return Math.round(Math.min(116, 50 + s * 7));
}

// Chair-dot positions around the table perimeter. For a circle we spread
// evenly on the ring; for a square we distribute across the four edges so
// it reads like seats pulled up to a table. Returns [{x,y}] in px offsets
// from the table's center (the table box is sizePx square).
function chairPositions(count, sizePx, shape) {
  const n = Math.max(0, Math.min(12, Number(count) || 0));
  if (n === 0) return [];
  const out = [];
  const r = sizePx / 2 + 9; // ring radius: just outside the table edge
  if (shape === "square") {
    // Distribute across 4 edges as evenly as possible.
    const perEdge = [0, 0, 0, 0];
    for (let i = 0; i < n; i++) perEdge[i % 4]++;
    const half = sizePx / 2 + 9;
    // k-th seat of `total` along one edge, centered across the table width.
    const place = (k, total) => {
      const span = sizePx * 0.82;
      const step = total > 1 ? span / (total - 1) : 0;
      return total > 1 ? -span / 2 + k * step : 0;
    };
    // top edge (y = -half), bottom (y = +half), left (x = -half), right (x = +half)
    for (let k = 0; k < perEdge[0]; k++) out.push({ x: place(k, perEdge[0]), y: -half });
    for (let k = 0; k < perEdge[1]; k++) out.push({ x: place(k, perEdge[1]), y: half });
    for (let k = 0; k < perEdge[2]; k++) out.push({ x: -half, y: place(k, perEdge[2]) });
    for (let k = 0; k < perEdge[3]; k++) out.push({ x: half, y: place(k, perEdge[3]) });
    return out;
  }
  // Round: even spread on the ring, starting at top.
  for (let i = 0; i < n; i++) {
    const a = -Math.PI / 2 + (i / n) * Math.PI * 2;
    out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
  }
  return out;
}

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
    const shape =
      c.res.shape === "square" || c.res.shape === "round"
        ? c.res.shape
        : profile.defaultShape(c.res.capacity_seats);
    map[id] = {
      pos_x: hasX ? clampPct(Number(c.res.pos_x)) : auto[id]?.pos_x ?? 50,
      pos_y: hasY ? clampPct(Number(c.res.pos_y)) : auto[id]?.pos_y ?? 50,
      shape: shape === "square" ? "square" : "round",
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
  const sizePx = tableSizePx(res.capacity_seats);
  const shape = pos.shape;
  // Station-like resources (salon archetype, or any kind === "provider") read
  // as a single person at a chair — one marker, not a ring of N chair dots.
  // Everything else keeps the chair ring sized by capacity.
  const stationLike = profile.stationLike;
  const chairs = useMemo(
    () => (stationLike ? [] : chairPositions(res.capacity_seats, sizePx, shape)),
    [res.capacity_seats, sizePx, shape, stationLike],
  );
  const combined = cell.combined;
  const booking = cell.booking;
  const VenueIcon = profile.icon;

  // Label line under the seat count: time + guest for an occupied table.
  const sub =
    status === "free"
      ? null
      : booking
        ? `${booking.time}${booking.name ? " · " + booking.name : ""}`
        : null;

  return (
    <div
      className="absolute -translate-x-1/2 -translate-y-1/2 select-none"
      style={{
        left: `${pos.pos_x}%`,
        top: `${pos.pos_y}%`,
        width: sizePx,
        height: sizePx,
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
          className={"absolute rounded-full " + style.chair}
          style={{
            width: 9,
            height: 9,
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
            transform: `translate(-50%, calc(-50% - ${sizePx / 2 + 9}px))`,
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
          res.capacity_seats +
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
          (shape === "square" ? "rounded-2xl" : "rounded-full") +
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
        {/* Status dot — top-right corner of the table */}
        <span
          className={"absolute top-1 right-1 w-2.5 h-2.5 rounded-full " + style.dot}
          aria-hidden
        />
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
        <span
          className={
            "relative font-semibold leading-none truncate max-w-full " +
            style.text +
            " " +
            (sizePx >= 80 ? "text-sm" : "text-xs")
          }
        >
          {res.label}
        </span>
        <span
          className={"relative inline-flex items-center gap-0.5 leading-none " + style.text}
        >
          {stationLike ? (
            <>
              <User className="w-3 h-3 opacity-70" aria-hidden />
              <span className="text-[10px]">{t(profile.unitKey, "per chair")}</span>
            </>
          ) : (
            <>
              <Users className="w-3 h-3 opacity-70" aria-hidden />
              <span className="text-[11px] tabular-nums">{res.capacity_seats}</span>
            </>
          )}
        </span>
        {sub && sizePx >= 72 && (
          <span
            className={"text-[10px] leading-tight truncate max-w-full opacity-90 " + style.text}
          >
            {sub}
          </span>
        )}
      </button>

      {/* Edit affordances: round/square toggle pinned just below the table. */}
      {editing && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onToggleShape(res.id);
          }}
          title={t("rsvpPlanToggleShape", "Round / square")}
          aria-label={t("rsvpPlanToggleShape", "Round / square")}
          className="absolute left-1/2 -translate-x-1/2 -bottom-3 z-40 h-7 w-7 inline-flex items-center justify-center rounded-full bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 shadow text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
        >
          {shape === "square" ? (
            <Circle className="w-3.5 h-3.5" aria-hidden />
          ) : (
            <Square className="w-3.5 h-3.5" aria-hidden />
          )}
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

  const canvasRef = useRef(null);
  const dragRef = useRef(null); // {id, pointerId}

  // Effective layout: draft when editing, else the server-derived base.
  const layout = editing && draft ? draft : baseLayout;

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

  // ── Edit lifecycle ───────────────────────────────────────────────────
  const enterEdit = useCallback(() => {
    setDraft(JSON.parse(JSON.stringify(baseLayout)));
    setSaveError("");
    setEditing(true);
  }, [baseLayout]);

  // Exit WITHOUT saving → revert (draft discarded).
  const cancelEdit = useCallback(() => {
    setDraft(null);
    setActiveId(null);
    setEditing(false);
    setSaveError("");
  }, []);

  const resetDraft = useCallback(() => {
    setDraft(JSON.parse(JSON.stringify(baseLayout)));
  }, [baseLayout]);

  const toggleShape = useCallback((id) => {
    setDraft((prev) => {
      if (!prev) return prev;
      const key = String(id);
      const cur = prev[key];
      if (!cur) return prev;
      return {
        ...prev,
        [key]: { ...cur, shape: cur.shape === "square" ? "round" : "square" },
      };
    });
  }, []);

  // ── Drag (pointer + touch via Pointer Events) ─────────────────────────
  const onPointerDownDrag = useCallback(
    (e, id) => {
      if (!editing) return;
      e.preventDefault();
      e.stopPropagation();
      dragRef.current = { id: String(id), pointerId: e.pointerId };
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
      if (!drag) return;
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
    const onUp = () => {
      if (dragRef.current) {
        dragRef.current = null;
        setActiveId(null);
      }
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
          shape: l?.shape === "square" ? "square" : "round",
        };
      }),
    };
    try {
      await api.put("/reservations/resources/layout", body);
      // Mutate the in-memory resources so the saved layout sticks without a
      // refetch (the parent passes resources by reference into deriveFloorState;
      // we patch res objects so the base layout recomputes to match the draft).
      cells.forEach((c) => {
        const l = draft[String(c.res.id)];
        if (l) {
          c.res.pos_x = l.pos_x;
          c.res.pos_y = l.pos_y;
          c.res.shape = l.shape;
        }
      });
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
        <div className="flex items-center gap-2 text-[11px] font-medium text-gray-500 dark:text-gray-400">
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
                onClick={resetDraft}
                className="inline-flex items-center gap-1.5 min-h-[40px] px-3 rounded-lg text-sm font-medium text-gray-500 hover:text-gray-900 hover:bg-gray-100 dark:text-gray-400 dark:hover:text-gray-100 dark:hover:bg-gray-800 transition-colors"
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

      {/* The room. Horizontal scroll on narrow screens keeps a big room
          usable on a phone / host stand (min-width floor → pan). */}
      <div className="overflow-x-auto rounded-2xl">
        <div
          ref={canvasRef}
          className={
            "relative w-full min-w-[560px] rounded-2xl border overflow-hidden " +
            "bg-[radial-gradient(circle_at_1px_1px,rgba(0,0,0,0.05)_1px,transparent_0)] [background-size:22px_22px] " +
            "bg-gray-50 dark:bg-gray-900 " +
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
                  selected={isNext || activeId === id}
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
        <LegendItem dotCls="bg-blue-500" label={t("rsvpTileSeated", "Seated")} />
        <LegendItem dotCls="bg-red-500" label={t("rsvpPlanOverdue", "Overdue")} />
        {nextBookingId != null && (
          <LegendItem dotCls="bg-gray-900 dark:bg-gray-100" label={t("rsvpPlanNext", "Your next booking")} />
        )}
      </div>

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
