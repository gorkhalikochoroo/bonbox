// PublicFloorMap — the read-only 2D dining-room map a GUEST sees on the public
// booking page (/r/<slug>). Mirrors the owner FloorPlan visual language exactly
// — soft 16:10 room, tables drawn from the SHARED archetype library (round,
// square, langbord, bås, barplads, højbord) with chairs/stools + status tint
// (emerald = open, gray-900 = the guest's pick, muted gray = taken). Purely a
// SELECTOR: no drag, no edit, no guest data. Tapping an open table requests it;
// the server re-checks and honors it if still free (else auto-assigns).
//
// All geometry comes from config/tableArchetypes so a Langbord/Bås here is
// byte-identical to the one the owner arranged — owner + booker never drift.
import { useMemo } from "react";
import { Users, Check } from "lucide-react";
import {
  tableDims,
  archetypeChairs,
  bodyRadiusClass,
  chairIsStool,
  normalizeShape,
  TableMark,
} from "../config/tableArchetypes";

function clampPct(n) {
  if (!Number.isFinite(n)) return 50;
  return Math.min(100, Math.max(0, n));
}

// Auto-grid for tables without saved coords, grouped by zone (one band each).
// Mirrors FloorPlan.autoLayout so a partly-arranged room still looks tidy.
function autoLayout(tables) {
  const zones = [];
  const byZone = new Map();
  tables.forEach((tb) => {
    const z = tb.zone || "__none__";
    if (!byZone.has(z)) { byZone.set(z, []); zones.push(z); }
    byZone.get(z).push(tb);
  });
  const out = {};
  const bandH = 100 / (zones.length || 1);
  zones.forEach((z, zi) => {
    const list = byZone.get(z);
    const cols = Math.ceil(Math.sqrt(list.length)) || 1;
    const rows = Math.ceil(list.length / cols) || 1;
    const padX = 12;
    const padTop = bandH * zi + 11;
    const usableH = bandH - 20;
    list.forEach((tb, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = cols > 1 ? padX + (col / (cols - 1)) * (100 - padX * 2) : 50;
      const y = rows > 1 ? padTop + (row / (rows - 1)) * usableH : padTop + usableH / 2;
      out[String(tb.id)] = {
        pos_x: Math.round(x * 10) / 10,
        pos_y: Math.round(Math.min(94, Math.max(6, y)) * 10) / 10,
      };
    });
  });
  return out;
}

function buildLayout(tables) {
  const auto = autoLayout(tables);
  const map = {};
  tables.forEach((tb) => {
    const id = String(tb.id);
    const hasX = tb.pos_x != null && Number.isFinite(Number(tb.pos_x));
    const hasY = tb.pos_y != null && Number.isFinite(Number(tb.pos_y));
    map[id] = {
      pos_x: hasX ? clampPct(Number(tb.pos_x)) : auto[id]?.pos_x ?? 50,
      pos_y: hasY ? clampPct(Number(tb.pos_y)) : auto[id]?.pos_y ?? 50,
      shape: normalizeShape(tb.shape),
    };
  });
  return map;
}

// Status → Tailwind tokens. Same vocabulary as the owner FloorPlan STATUS_STYLE
// (free = emerald, the pick = solid gray-900, taken/too-small = muted gray).
// `chair` = solid dot bg; `stool` = ring border (bar / high-top seats).
const TOKENS = {
  free: {
    box: "bg-emerald-50 dark:bg-emerald-950/40 ring-emerald-300 dark:ring-emerald-700 text-emerald-900 dark:text-emerald-100",
    chair: "bg-emerald-300/80 dark:bg-emerald-700/70",
    stool: "border-emerald-400 dark:border-emerald-600",
  },
  selected: {
    box: "bg-gray-900 dark:bg-gray-100 ring-gray-900 dark:ring-gray-100 text-white dark:text-gray-900",
    chair: "bg-gray-700 dark:bg-gray-300",
    stool: "border-gray-500 dark:border-gray-500",
  },
  off: {
    box: "bg-gray-100 dark:bg-gray-800/60 ring-gray-200 dark:ring-gray-700 text-gray-400 dark:text-gray-500",
    chair: "bg-gray-200 dark:bg-gray-700",
    stool: "border-gray-300 dark:border-gray-600",
  },
};

export default function PublicFloorMap({ tables = [], selectedId = null, onSelect, t, bookingMode = "table" }) {
  const tr = t || ((_k, fb) => fb);
  const layout = useMemo(() => buildLayout(tables), [tables]);

  // Honesty gate #1 — the 2D floor map is a TABLE-booking affordance only.
  // A provider (salon) or no-floor (bakery/retail) venue must NEVER render it,
  // gated on the venue TYPE (bookingMode), not on tables.length. Defensive:
  // even if a caller forgets to gate, the map self-suppresses off "table".
  if (bookingMode !== "table") return null;

  if (!tables.length) return null;

  return (
    <div>
      <div className="overflow-x-auto -mx-1 px-1">
        <div
          className="relative mx-auto w-full min-w-[520px] rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50/70 dark:bg-gray-900/40"
          style={{ aspectRatio: "16 / 10" }}
        >
          {tables.map((tb) => {
            const id = String(tb.id);
            const lay = layout[id] || { pos_x: 50, pos_y: 50, shape: "round" };
            const isSelected = selectedId != null && id === String(selectedId);
            const isFree = tb.status === "free";
            const token = isSelected ? TOKENS.selected : isFree ? TOKENS.free : TOKENS.off;
            const dims = tableDims(lay.shape, tb.capacity_seats);
            const chairs = archetypeChairs(lay.shape, tb.capacity_seats, dims.w, dims.h);
            const stool = chairIsStool(lay.shape);
            const clickable = isFree || isSelected;
            // Orientation only. Drawn SIZE is deliberately NOT sent to guests —
            // the body is sized from capacity_seats (tableDims above), so a guest
            // can never read capacity off how big the owner drew a table.
            const rot = Number(tb.rotation_deg) || 0;
            return (
              <div
                key={id}
                className="absolute"
                style={{ left: `${lay.pos_x}%`, top: `${lay.pos_y}%`, transform: `translate(-50%, -50%) rotate(${rot}deg)` }}
              >
                <div className="relative" style={{ width: dims.w, height: dims.h }}>
                  {chairs.map((c, i) => (
                    <span
                      key={i}
                      aria-hidden="true"
                      className={`absolute rounded-full ${stool ? `border-2 bg-transparent ${token.stool}` : token.chair}`}
                      style={{
                        width: 9, height: 9, left: "50%", top: "50%",
                        transform: `translate(calc(-50% + ${c.x}px), calc(-50% + ${c.y}px))`,
                      }}
                    />
                  ))}
                  <button
                    type="button"
                    onClick={clickable ? () => onSelect?.(isSelected ? null : id) : undefined}
                    disabled={!clickable}
                    aria-pressed={isSelected}
                    aria-label={`${tb.label} · ${tb.capacity_seats} ${tr("rsvpFloorSeatsUnit", "seats")}${
                      isFree ? ` · ${tr("rsvpFloorOpen", "open")}` : isSelected ? ` · ${tr("rsvpFloorYourPick", "your pick")}` : ` · ${tr("rsvpFloorTaken", "taken")}`
                    }`}
                    className={`absolute inset-0 flex flex-col items-center justify-center ring-2 transition ${bodyRadiusClass(lay.shape)} ${token.box} ${
                      clickable ? "cursor-pointer hover:ring-[3px]" : "cursor-not-allowed"
                    } ${isSelected ? "ring-[3px]" : ""}`}
                  >
                    <TableMark shape={lay.shape} w={dims.w} h={dims.h} benchClass={token.chair} ringClass={token.stool} />
                    {/* Counter-rotated so the label + seat count read upright on a
                        turned table. The seat number is the guest's only capacity
                        signal and never tilts. */}
                    <div
                      className="relative flex flex-col items-center max-w-full"
                      style={{ transform: rot ? `rotate(${-rot}deg)` : undefined }}
                    >
                      <span className="px-1 text-[10px] font-semibold leading-none truncate max-w-full">
                        {tb.label}
                      </span>
                      <span className="mt-0.5 inline-flex items-center gap-0.5 text-[10px] leading-none opacity-90">
                        <Users size={9} strokeWidth={2} aria-hidden="true" />
                        {tb.capacity_seats}
                      </span>
                    </div>
                  </button>
                  {isSelected && (
                    <span className="absolute -top-1 -right-1 z-10 flex h-4 w-4 items-center justify-center rounded-full bg-gray-900 text-white ring-2 ring-white dark:ring-gray-900">
                      <Check size={10} strokeWidth={3} aria-hidden="true" />
                    </span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Legend — mirrors the owner floor legend vocabulary. */}
      <div className="mt-2.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-gray-500 dark:text-gray-400">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-emerald-50 ring-1 ring-emerald-300 dark:bg-emerald-950/40 dark:ring-emerald-700" />
          {tr("rsvpFloorLegOpen", "Open")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-gray-900 dark:bg-gray-100" />
          {tr("rsvpFloorLegPick", "Your table")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-2.5 w-2.5 rounded-full bg-gray-100 ring-1 ring-gray-200 dark:bg-gray-800 dark:ring-gray-700" />
          {tr("rsvpFloorLegTaken", "Taken")}
        </span>
      </div>
    </div>
  );
}
