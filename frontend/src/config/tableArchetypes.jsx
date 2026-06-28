// Table/seat archetypes — the SINGLE source of truth for the 2D floor plan,
// shared by BOTH the owner FloorPlan editor and the public booking map so a
// "Langbord" or "Bås" is drawn identically wherever it renders (the whole
// point of the preset design library: owner and booker never drift).
//
// A `shape` string is persisted on BookableResource.shape. Each archetype maps
// it to: a body footprint (w×h px), a chair/stool layout, body rounding, and an
// optional decorative mark (the booth bench, the high-top's tall ring). Seat
// COUNT still comes from the resource capacity; archetypes only decide how it's
// drawn + how many seats the picker seeds when adding one.
//
// Keep this in sync with backend _SHAPES (routers/reservations.py) — anything
// the backend doesn't accept normalises to "round" there, so the lists must
// match or an owner's pick silently reverts.

// ── Vocabulary ──────────────────────────────────────────────────────────
export const SHAPES = ["round", "square", "rect", "booth", "bar", "hightop"];

// Picker order + seed capacity + i18n label key (the "vælg design" palette).
export const ARCHETYPES = [
  { shape: "round",   labelKey: "rsvpShapeRound",   defaultSeats: 2 },
  { shape: "square",  labelKey: "rsvpShapeSquare",  defaultSeats: 4 },
  { shape: "rect",    labelKey: "rsvpShapeRect",    defaultSeats: 6 },
  { shape: "booth",   labelKey: "rsvpShapeBooth",   defaultSeats: 4 },
  { shape: "bar",     labelKey: "rsvpShapeBar",     defaultSeats: 4 },
  { shape: "hightop", labelKey: "rsvpShapeHightop", defaultSeats: 2 },
];

export function normalizeShape(s) {
  return SHAPES.includes(s) ? s : "round";
}

export function defaultSeatsFor(shape) {
  return (ARCHETYPES.find((a) => a.shape === shape) || ARCHETYPES[0]).defaultSeats;
}

// ── Geometry ────────────────────────────────────────────────────────────
// Base diameter for square-ish tables, scaled by seats. Matches the legacy
// tableSizePx tiers (2→64, 4→84, 6→104, 8→120) so existing rooms don't jump.
function baseSize(seats) {
  const s = Math.max(1, Number(seats) || 2);
  return Math.round(Math.min(120, 44 + s * 10));
}

// Footprint {w, h} in px for a table of this shape + seat count.
export function tableDims(shape, seats) {
  const b = baseSize(seats);
  const n = Number(seats) || defaultSeatsFor(shape);
  switch (shape) {
    case "rect": // long banquette — wide + shallow, grows with seats
      return { w: Math.round(Math.min(224, 64 + n * 22)), h: 54 };
    case "bar": // counter — long + thin
      return { w: Math.round(Math.min(244, 78 + n * 26)), h: 30 };
    case "booth": // booth — a slightly wide box (bench on one side)
      return { w: Math.round(b * 1.15), h: Math.round(b * 0.94) };
    case "hightop": // high-top — small square footprint
      return { w: Math.max(52, Math.round(b * 0.7)), h: Math.max(52, Math.round(b * 0.7)) };
    case "square":
    case "round":
    default:
      return { w: b, h: b };
  }
}

export function bodyRadiusClass(shape) {
  if (shape === "round" || shape === "hightop") return "rounded-full";
  if (shape === "bar") return "rounded-lg";
  return "rounded-2xl"; // square, rect, booth
}

// Bar + high-top seats read as STOOLS (a ring outline); dining tables as
// chairs (solid dots). Lets the renderer style them differently.
export function chairIsStool(shape) {
  return shape === "bar" || shape === "hightop";
}

// Decorative overlay for an archetype, or null. "bench" = booth bench bar on
// the top edge; "ring" = the high-top's dashed inner ring (reads as "tall").
export function archetypeMark(shape) {
  if (shape === "booth") return "bench";
  if (shape === "hightop") return "ring";
  return null;
}

// Seat positions — {x,y} px offsets from the table CENTER — for a shape +
// count, given the footprint w×h. `pad` pushes seats just outside the edge.
export function archetypeChairs(shape, count, w, h, chairW = 9) {
  const n = Math.max(0, Math.min(14, Number(count) || 0));
  if (n === 0) return [];
  const pad = chairW / 2 + 5;
  const out = [];

  if (shape === "round" || shape === "hightop") {
    const r = w / 2 + pad;
    const m = shape === "hightop" ? Math.min(n, 4) : n; // high-tops seat ≤4
    for (let i = 0; i < m; i++) {
      const a = -Math.PI / 2 + (i / m) * Math.PI * 2;
      out.push({ x: Math.cos(a) * r, y: Math.sin(a) * r });
    }
    return out;
  }

  if (shape === "rect" || shape === "bar") {
    const halfH = h / 2 + pad;
    const span = w * 0.84;
    const place = (k, total) => (total > 1 ? -span / 2 + (k / (total - 1)) * span : 0);
    if (shape === "bar") {
      // Stools on the FRONT (bottom) edge only — they face the counter.
      for (let k = 0; k < n; k++) out.push({ x: place(k, n), y: halfH });
      return out;
    }
    const top = Math.ceil(n / 2);
    const bot = n - top;
    for (let k = 0; k < top; k++) out.push({ x: place(k, top), y: -halfH });
    for (let k = 0; k < bot; k++) out.push({ x: place(k, bot), y: halfH });
    return out;
  }

  if (shape === "booth") {
    // Bench on the top edge (drawn as a mark — no chairs there); the open side
    // gets chairs for ~half the party.
    const halfH = h / 2 + pad;
    const span = w * 0.7;
    const m = Math.max(1, Math.ceil(n / 2));
    const place = (k, total) => (total > 1 ? -span / 2 + (k / (total - 1)) * span : 0);
    for (let k = 0; k < m; k++) out.push({ x: place(k, m), y: halfH });
    return out;
  }

  // square — distribute across the 4 edges.
  const halfW = w / 2 + pad;
  const halfH = h / 2 + pad;
  const perEdge = [0, 0, 0, 0];
  for (let i = 0; i < n; i++) perEdge[i % 4]++;
  const place = (k, total, dim) => {
    const span = dim * 0.82;
    return total > 1 ? -span / 2 + (k / (total - 1)) * span : 0;
  };
  for (let k = 0; k < perEdge[0]; k++) out.push({ x: place(k, perEdge[0], w), y: -halfH });
  for (let k = 0; k < perEdge[1]; k++) out.push({ x: place(k, perEdge[1], w), y: halfH });
  for (let k = 0; k < perEdge[2]; k++) out.push({ x: -halfW, y: place(k, perEdge[2], h) });
  for (let k = 0; k < perEdge[3]; k++) out.push({ x: halfW, y: place(k, perEdge[3], h) });
  return out;
}

// ── Shared render bits ──────────────────────────────────────────────────
// The decorative mark (booth bench / high-top ring), drawn identically in
// both views. `colorClass` carries the status tint (a bg class for the bench,
// a border class for the ring) so the mark matches the table.
export function TableMark({ shape, w, h, benchClass = "", ringClass = "" }) {
  const mark = archetypeMark(shape);
  if (mark === "bench") {
    return (
      <span
        aria-hidden
        className={"absolute left-1/2 -translate-x-1/2 rounded-full " + benchClass}
        style={{ top: -3, width: Math.round(w * 0.78), height: 6 }}
      />
    );
  }
  if (mark === "ring") {
    return (
      <span
        aria-hidden
        className={"absolute left-1/2 top-1/2 rounded-full border border-dashed " + ringClass}
        style={{
          width: Math.round(w * 0.5),
          height: Math.round(h * 0.5),
          transform: "translate(-50%, -50%)",
        }}
      />
    );
  }
  return null;
}

// A tiny outline glyph of an archetype for the "vælg design" picker tiles.
// Inherits `currentColor`, so the caller controls the stroke colour.
export function ShapeGlyph({ shape, size = 34 }) {
  const vb = "0 0 34 26";
  const common = { width: size, height: Math.round(size * 26 / 34), viewBox: vb, "aria-hidden": true };
  const stroke = { fill: "none", stroke: "currentColor", strokeWidth: 1.5 };
  const dot = (cx, cy, r = 1.6) => <circle key={`${cx}-${cy}`} cx={cx} cy={cy} r={r} fill="currentColor" />;
  switch (shape) {
    case "round":
      return (<svg {...common}><circle cx="17" cy="13" r="8" {...stroke} />{dot(17, 2.5)}{dot(17, 23.5)}</svg>);
    case "square":
      return (<svg {...common}><rect x="9" y="5" width="16" height="16" rx="3" {...stroke} />{dot(17, 1.6)}{dot(17, 24.4)}{dot(5.6, 13)}{dot(28.4, 13)}</svg>);
    case "rect":
      return (<svg {...common}><rect x="3" y="8" width="28" height="10" rx="3" {...stroke} />{dot(9, 4, 1.5)}{dot(17, 4, 1.5)}{dot(25, 4, 1.5)}{dot(9, 22, 1.5)}{dot(17, 22, 1.5)}{dot(25, 22, 1.5)}</svg>);
    case "booth":
      return (<svg {...common}><path d="M6 8 q11 -5 22 0" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /><rect x="6" y="9" width="22" height="11" rx="4" {...stroke} />{dot(12, 24, 1.5)}{dot(22, 24, 1.5)}</svg>);
    case "bar":
      return (<svg {...common}><rect x="4" y="10" width="26" height="7" rx="3" {...stroke} /><circle cx="10" cy="22" r="2" {...stroke} strokeWidth="1.3" /><circle cx="17" cy="22" r="2" {...stroke} strokeWidth="1.3" /><circle cx="24" cy="22" r="2" {...stroke} strokeWidth="1.3" /></svg>);
    case "hightop":
      return (<svg {...common}><circle cx="17" cy="13" r="8" {...stroke} /><circle cx="17" cy="13" r="4" fill="none" stroke="currentColor" strokeWidth="0.8" strokeDasharray="1.5 2" /><circle cx="17" cy="2.5" r="2" {...stroke} strokeWidth="1.2" /><circle cx="17" cy="23.5" r="2" {...stroke} strokeWidth="1.2" /></svg>);
    default:
      return (<svg {...common}><circle cx="17" cy="13" r="8" {...stroke} /></svg>);
  }
}
