/**
 * The room shell — walls, a drafting grid and a paper floor, drawn BEHIND the
 * tables on the 2D floor plan.
 *
 * WHY IT EXISTS. The marketing page sells a floor plan that reads as a room
 * (components/landing/FloorPlan.jsx): a solid wall body with the floor
 * recessed into it. The product drew tables floating on a flat card, so the
 * thing a visitor was sold was not the thing an owner opened. This is the same
 * plan language, in the app.
 *
 * WHY IT IS A SEPARATE, DUMB COMPONENT. It is PURELY DECORATIVE: every layer
 * is `pointer-events-none` and carries no state. Crucially, the shell does NOT
 * become the positioning context — tables stay positioned as a percentage of
 * the CANVAS, not of the floor. So the drag math, autoLayout, and every
 * pos_x/pos_y already saved in the database mean exactly what they meant
 * before. Inset the floor, not the coordinate system.
 *
 * Depth comes from extrusion, never perspective. The handoff records that a
 * rotated/isometric version was rejected because skewing the plane distorts
 * labels and squashes circular seat markers into ellipses.
 *
 * The colours live in index.css as `.bb-room-wall` / `.bb-room-floor` rather
 * than inline, because the floor needs a real `.dark` variant and the app's
 * dark theme is a class on <html>, which an inline style cannot see.
 */

/** Wall thickness in px. Matches the landing plan's 8px poché, one px thinner
 *  because the product canvas also carries a 1px border. */
const WALL_PX = 7;

export default function RoomShell({ radius = 16 }) {
  return (
    <div className="absolute inset-0 pointer-events-none" aria-hidden>
      {/* The wall poché — a solid body, the way a plan draws cut masonry. */}
      <div className="bb-room-wall absolute inset-0" />
      {/* The floor, recessed into it. Rounded a touch tighter than the canvas
          so the wall reads as a constant thickness around the corners. */}
      <div
        className="bb-room-floor absolute"
        style={{ inset: WALL_PX, borderRadius: Math.max(2, radius - WALL_PX) }}
      />
    </div>
  );
}
