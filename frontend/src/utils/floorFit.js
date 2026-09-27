/**
 * floorFit — keep a room readable at whatever size it is drawn.
 *
 * Table POSITIONS are saved as a percent of the canvas, but table SIZES are
 * pixels (a 4-top is 84px whatever the room). So a room arranged on a wide
 * screen and shown on a laptop draws the same tables closer together — and
 * tables the owner placed near each other overlapped outright: "Bord 1 ·…"
 * under "Bord 3", a 4-top's chairs inside the 8-top next to it. Nothing
 * separated them, and a host cannot tap a table they cannot see.
 *
 * fitRoom() is the view-mode fix, and it never changes what is saved:
 *   1. CROWDING. If the tables' footprints (chairs included) would cover more
 *      than ~half the floor, every table is drawn a little smaller — never
 *      below MIN_SCALE, where labels and tap targets would stop working.
 *   2. SPACING. Overlapping footprints are pushed apart along the axis where
 *      they overlap least, by the least distance that separates them, and
 *      kept inside the walls. Solid room objects (the bar counter, the
 *      entrance) are fixed obstacles: a table moves off them, they never move.
 *
 * The owner's arrangement is the starting point, so a table only moves when
 * it has to, and only as far as it has to. Arrange mode shows the saved
 * positions untouched — that is where the owner decides where things go.
 */
import { tableDims } from "../config/tableArchetypes";

export const MIN_SCALE = 0.78;       // below this, labels and tap targets suffer
const CROWDING = 0.5;                // footprint share of the floor before shrinking
const GAP = 8;                       // px of air between two tables' chairs
const WALL = 18;                     // px — the RoomShell wall + a little air
// Kinds as FloorFixtures stores them (FIXTURE_KINDS). Windows and walls are
// not obstacles: a table by the window is exactly where it belongs.
const SOLID_FIXTURES = new Set(["bar_counter", "entrance"]);

/** The px footprint of one table as TableNode draws it — body + chair ring. */
export function tableFootprint(res, pos, extraScale = 1) {
  const seats = pos.capacity != null ? pos.capacity : res.capacity_seats;
  const sizeScale = (pos.size_scale != null ? pos.size_scale : res.size_scale || 1) * extraScale;
  const base = tableDims(pos.shape, seats);
  const w = base.w * sizeScale;
  const h = base.h * sizeScale;
  // Same chair size rule as TableNode (from tableSizePx there), and
  // archetypeChairs puts a chair's far edge at body + chairW + 5.
  const sizePx = Math.round(Math.min(120, 44 + Math.max(1, Number(seats) || 2) * 10));
  const chairW = Math.max(9, Math.min(15, Math.round(sizePx * 0.17))) * sizeScale;
  let hw = w / 2 + chairW + 5;
  let hh = h / 2 + chairW + 5;
  const rot = ((pos.rotation_deg != null ? pos.rotation_deg : res.rotation_deg) || 0) * (Math.PI / 180);
  if (rot) {
    // Axis-aligned box of the rotated footprint.
    const c = Math.abs(Math.cos(rot));
    const s = Math.abs(Math.sin(rot));
    [hw, hh] = [hw * c + hh * s, hw * s + hh * c];
  }
  return { hw, hh };
}

function fixtureBox(f, W, H) {
  const rot = (f.rotation_deg || 0) * (Math.PI / 180);
  let hw = ((Number(f.w_pct) || 0) / 100) * W / 2;
  let hh = ((Number(f.h_pct) || 0) / 100) * H / 2;
  if (rot) {
    const c = Math.abs(Math.cos(rot));
    const s = Math.abs(Math.sin(rot));
    [hw, hh] = [hw * c + hh * s, hw * s + hh * c];
  }
  return { x: (Number(f.pos_x) / 100) * W, y: (Number(f.pos_y) / 100) * H, hw, hh };
}

/**
 * @param cells    FloorPlan cells [{res}]
 * @param layout   {id: {pos_x, pos_y, shape, capacity?, size_scale?, rotation_deg?}}
 * @param size     {w, h} canvas px
 * @param fixtures room objects [{kind, pos_x, pos_y, w_pct, h_pct, rotation_deg}]
 * @returns {scale, pos: {id: {pos_x, pos_y}}, moved: number}
 */
export function fitRoom(cells, layout, size, fixtures = []) {
  const W = size?.w || 0;
  const H = size?.h || 0;
  if (!W || !H || !cells?.length) return { scale: 1, pos: {}, moved: 0 };

  const ids = cells.map((c) => String(c.res.id)).filter((id) => layout[id]);
  const resById = new Map(cells.map((c) => [String(c.res.id), c.res]));

  // 1. Crowding → one scale for the whole room (tables stay comparable).
  const usable = Math.max(1, (W - 2 * WALL) * (H - 2 * WALL));
  const area = ids.reduce((sum, id) => {
    const { hw, hh } = tableFootprint(resById.get(id), layout[id]);
    return sum + 4 * hw * hh;
  }, 0);
  const scale = area > usable * CROWDING
    ? Math.max(MIN_SCALE, Math.min(1, Math.sqrt((usable * CROWDING) / area)))
    : 1;

  const walls = fixtures
    .filter((f) => SOLID_FIXTURES.has(String(f.kind || "").toLowerCase()))
    .map((f) => fixtureBox(f, W, H));

  // 2. Spacing. Two ways to clear a collision: draw the room a little
  // smaller, or move tables. Moving costs more — a host knows the room by
  // where things are — so every size step from the crowding scale down to
  // MIN_SCALE is tried and scored: pixels of table movement, plus 100 per 10%
  // of shrink. The cheapest result with nothing overlapping wins.
  let best = null;
  const score = (run, sc) =>
    run.nodes.reduce((sum, n) => sum + Math.hypot(n.x - n.x0, n.y - n.y0), 0) + (1 - sc) * 1000;
  for (let sc = scale; ; sc = Math.max(MIN_SCALE, sc - 0.04)) {
    const run = relax(ids, resById, layout, W, H, sc, walls);
    const cand = { ...run, scale: sc, score: score(run, sc) };
    if (!best || cand.left < best.left || (cand.left === best.left && cand.score < best.score)) best = cand;
    if (sc <= MIN_SCALE) break;
  }

  const pos = {};
  let movedCount = 0;
  best.nodes.forEach((n) => {
    if (Math.abs(n.x - n.x0) > 1 || Math.abs(n.y - n.y0) > 1) movedCount++;
    pos[n.id] = {
      pos_x: Math.round((n.x / W) * 1000) / 10,
      pos_y: Math.round((n.y / H) * 1000) / 10,
    };
  });
  return { scale: best.scale, pos, moved: movedCount };
}

function relax(ids, resById, layout, W, H, scale, walls) {
  const nodes = ids.map((id) => {
    const p = layout[id];
    const { hw, hh } = tableFootprint(resById.get(id), p, scale);
    const x = (p.pos_x / 100) * W;
    const y = (p.pos_y / 100) * H;
    const res = resById.get(id);
    const placedByOwner = res && res.pos_x != null && res.pos_y != null ? 1 : 0;
    return { id, x, y, hw: hw + GAP / 2, hh: hh + GAP / 2, x0: x, y0: y, placedByOwner };
  });
  const inside = (n, x, y) =>
    x - n.hw >= WALL - 0.5 && x + n.hw <= W - WALL + 0.5 && y - n.hh >= WALL - 0.5 && y + n.hh <= H - WALL + 0.5;
  const clampX = (n, x) => (W - 2 * WALL < 2 * n.hw ? W / 2 : Math.min(W - WALL - n.hw, Math.max(WALL + n.hw, x)));
  const clampY = (n, y) => (H - 2 * WALL < 2 * n.hh ? H / 2 : Math.min(H - WALL - n.hh, Math.max(WALL + n.hh, y)));
  const hits = (n, x, y, b) => n.hw + b.hw - Math.abs(b.x - x) > 0.5 && n.hh + b.hh - Math.abs(b.y - y) > 0.5;

  // 1. Every table that already sits clear — of the walls, the solid room
  //    objects and every other table — stays exactly where it was saved.
  const conflicted = new Set();
  nodes.forEach((n, i) => {
    if (!inside(n, n.x, n.y) || walls.some((f) => hits(n, n.x, n.y, f))) conflicted.add(i);
    nodes.forEach((m, j) => {
      if (j > i && hits(n, n.x, n.y, m)) {
        conflicted.add(i);
        conflicted.add(j);
      }
    });
  });
  const placed = [...walls];
  nodes.forEach((n, i) => {
    if (!conflicted.has(i)) placed.push(n);
  });

  // 2. The rest each take the NEAREST free spot to where they were put: rings
  //    of candidates around that position, closest ring first. A table moves
  //    only as far as it has to — the room keeps its shape. Tables the owner
  //    PLACED choose first (a never-placed table's spot is only an automatic
  //    grid guess), and among those the biggest first, being hardest to fit.
  const movers = [...conflicted]
    .map((i) => nodes[i])
    .sort((a, b) => (b.placedByOwner - a.placedByOwner) || (b.hw * b.hh - a.hw * a.hh));
  let left = 0;
  const reach = Math.max(W, H);
  for (const n of movers) {
    const x0 = clampX(n, n.x0);
    const y0 = clampY(n, n.y0);
    const free = (x, y) => inside(n, x, y) && !placed.some((b) => hits(n, x, y, b));
    let spot = free(x0, y0) ? [x0, y0] : null;
    for (let r = 4; !spot && r <= reach; r += r < 60 ? 4 : r < 200 ? 8 : 16) {
      const k = Math.max(12, Math.ceil((2 * Math.PI * r) / 6));
      let bestD = Infinity;
      for (let a = 0; a < k; a++) {
        const th = (a / k) * Math.PI * 2;
        const x = clampX(n, n.x0 + Math.cos(th) * r);
        const y = clampY(n, n.y0 + Math.sin(th) * r);
        if (!free(x, y)) continue;
        const d = (x - n.x0) ** 2 + (y - n.y0) ** 2;
        if (d < bestD) {
          bestD = d;
          spot = [x, y];
        }
      }
    }
    if (!spot) {
      left++;
      spot = [x0, y0];
    }
    n.x = spot[0];
    n.y = spot[1];
    placed.push(n);
  }
  return { nodes, left };
}

/**
 * How wide the room must be drawn for its tables to fit at MIN_SCALE with
 * air to spare (16:10 room, footprints ≤ ~42% of the floor). On a phone the
 * room already pans rather than squeezing (see FloorPlan) — a crowded room
 * simply pans a little further instead of stacking tables on each other.
 */
export function roomMinWidth(cells, layout, floor = 560, cap = 1400) {
  const area = cells.reduce((sum, c) => {
    const p = layout[String(c.res.id)];
    if (!p) return sum;
    const { hw, hh } = tableFootprint(c.res, p, MIN_SCALE);
    return sum + 4 * hw * hh;
  }, 0);
  const need = Math.sqrt(area / (0.625 * 0.42)) + 2 * WALL;
  return Math.round(Math.min(cap, Math.max(floor, need)));
}

/** Does any pair of footprints still overlap? (For tests and the arrange hint.) */
export function overlaps(cells, layout, size, scale = 1) {
  const W = size.w;
  const H = size.h;
  const boxes = cells.map((c) => {
    const id = String(c.res.id);
    const p = layout[id];
    const { hw, hh } = tableFootprint(c.res, p, scale);
    return { x: (p.pos_x / 100) * W, y: (p.pos_y / 100) * H, hw, hh };
  });
  let n = 0;
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      if (a.hw + b.hw - Math.abs(b.x - a.x) > 1 && a.hh + b.hh - Math.abs(b.y - a.y) > 1) n++;
    }
  }
  return n;
}
