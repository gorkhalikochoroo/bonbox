/**
 * The non-bookable things in a room: the bar, the entrance, a window, a wall.
 *
 * These are the symbols that make the marketing floor plan read as a ROOM
 * rather than circles on a card (components/landing/FloorPlan.jsx), drawn here
 * from real owner-placed data instead of a hard-coded illustration.
 *
 * WHAT THESE ARE NOT. A fixture is not a resource. It has no seats, it is in a
 * different database table, and the booking engine cannot see it — see
 * backend/app/models/floor_fixture.py for why that separation is structural
 * rather than a filter someone has to remember. Nothing in this file should
 * ever grow a capacity, a booking, or a tap-to-seat handler.
 *
 * Note `bar_counter`, not `bar`: "bar" is already a BOOKABLE table archetype
 * (a counter with stools that guests reserve, see config/tableArchetypes.jsx).
 * This is the solid slab you walk up to. Two different objects.
 *
 * GEOMETRY. pos_x/pos_y are the CENTRE as a percent of the canvas, w_pct/h_pct
 * the footprint as a percent — the same resolution-independent scheme the
 * tables use, so a room looks identical on a phone, a door tablet and a
 * desktop with no re-pixel-mapping and no breakpoint of its own.
 */
export const FIXTURE_KINDS = ["bar_counter", "entrance", "window", "wall"];

/** Label key + fallback per kind. Every one of these has a real en AND da
 *  entry in useLanguage — the second argument is a developer breadcrumb, not
 *  a translation strategy (a missing key would otherwise ship English to a
 *  Danish owner and no guard would notice). */
export const FIXTURE_LABELS = {
  bar_counter: ["rsvpFixtureBar", "Bar"],
  entrance: ["rsvpFixtureEntrance", "Entrance"],
  window: ["rsvpFixtureWindow", "Window"],
  wall: ["rsvpFixtureWall", "Wall"],
};

export function normalizeFixtureKind(k) {
  return FIXTURE_KINDS.includes(k) ? k : "wall";
}

/**
 * Type size note: these labels were 8.5px, copied from the marketing floor
 * plan. There it is a decorative illustration nobody reads; here it is the
 * owner's own room and "Bar" / "Indgang" are words they have to recognise at a
 * glance, mid-service, on a phone. 11px is the floor the rest of the app uses
 * for meaningful small text.
 *
 * One fixture. `editing` only changes the affordance (a dashed grab outline);
 * the symbol itself is identical in both modes, so the owner arranges the room
 * they will actually look at during service.
 */
function Fixture({ f, t, editing, selected, onPointerDownDrag, onTap }) {
  const kind = normalizeFixtureKind(f.kind);
  const [key, fallback] = FIXTURE_LABELS[kind];
  const name = f.label || t(key, fallback);
  const rot = f.rotation_deg || 0;

  const box = {
    left: `${f.pos_x}%`,
    top: `${f.pos_y}%`,
    width: `${f.w_pct}%`,
    height: `${f.h_pct}%`,
    transform: `translate(-50%, -50%) rotate(${rot}deg)`,
  };

  // A bar counter is a SOLID object, so it extrudes like the walls do — the
  // hard `0 Npx 0` shadow reads as the side of a body, not a blur.
  if (kind === "bar_counter") {
    return (
      <div
        className={"absolute flex items-center justify-center rounded-[5px] " + (editing ? "cursor-grab" : "")}
        style={{
          ...box,
          background: "#0F172A",
          boxShadow: "0 5px 0 #020617, 0 18px 24px -10px rgb(15 23 42 / 0.55)",
          outline: selected ? "2px dashed rgb(255 255 255 / 0.7)" : undefined,
          outlineOffset: 3,
        }}
        onPointerDown={editing ? (e) => onPointerDownDrag(e, f.id) : undefined}
        onClick={editing ? () => onTap(f.id) : undefined}
      >
        <span
          className="text-[11px] font-semibold uppercase text-slate-400 select-none"
          // Vertical when the slab is taller than it is wide, which is how a
          // bar usually runs — otherwise the label clips to nothing.
          style={
            f.h_pct > f.w_pct
              ? { writingMode: "vertical-rl", letterSpacing: "0.16em" }
              : { letterSpacing: "0.18em" }
          }
        >
          {name}
        </span>
      </div>
    );
  }

  // A window is the standard plan symbol: a gap in the wall drawn as two
  // parallel rules, so it reads as an opening rather than a solid.
  if (kind === "window") {
    return (
      <div
        className={"absolute flex items-center justify-center " + (editing ? "cursor-grab" : "")}
        style={{
          ...box,
          background: "var(--bb-room-paper, #FBFAF7)",
          borderTop: "1.5px solid #0F172A",
          borderBottom: "1.5px solid #0F172A",
          outline: selected ? "2px dashed rgb(15 23 42 / 0.45)" : undefined,
          outlineOffset: 3,
        }}
        onPointerDown={editing ? (e) => onPointerDownDrag(e, f.id) : undefined}
        onClick={editing ? () => onTap(f.id) : undefined}
      >
        <span className="absolute -top-3.5 left-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 select-none whitespace-nowrap">
          {name}
        </span>
      </div>
    );
  }

  // An entrance: the opening, the door leaf, and the quarter-circle swing arc
  // that tells a host which way the door opens into the room.
  if (kind === "entrance") {
    return (
      <div
        className={"absolute " + (editing ? "cursor-grab" : "")}
        style={{
          ...box,
          outline: selected ? "2px dashed rgb(15 23 42 / 0.45)" : undefined,
          outlineOffset: 3,
        }}
        onPointerDown={editing ? (e) => onPointerDownDrag(e, f.id) : undefined}
        onClick={editing ? () => onTap(f.id) : undefined}
      >
        {/* the opening — a clean break in the wall run */}
        <div className="absolute inset-x-0 bottom-0 h-full" style={{ background: "var(--bb-room-paper, #FBFAF7)" }} />
        {/* the door leaf */}
        <div className="absolute left-0 bottom-0 w-0.5" style={{ height: "260%", background: "#0F172A" }} />
        {/* the swing */}
        <div
          className="absolute left-0 bottom-0"
          style={{
            width: "100%",
            height: "260%",
            borderRight: "1.5px solid #94A3B8",
            borderTop: "1.5px solid #94A3B8",
            borderRadius: "0 100% 0 0",
          }}
        />
        <span className="absolute -top-3.5 left-0 text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-500 select-none whitespace-nowrap">
          {name}
        </span>
      </div>
    );
  }

  // A dividing wall — solid poché, same ink as the room's outer walls.
  return (
    <div
      className={"absolute rounded-[2px] " + (editing ? "cursor-grab" : "")}
      style={{
        ...box,
        background: "#0F172A",
        boxShadow: "0 3px 0 #020617",
        outline: selected ? "2px dashed rgb(255 255 255 / 0.7)" : undefined,
        outlineOffset: 3,
      }}
      onPointerDown={editing ? (e) => onPointerDownDrag(e, f.id) : undefined}
      onClick={editing ? () => onTap(f.id) : undefined}
      title={name}
    />
  );
}

/**
 * The fixture layer. Renders BELOW the tables (the caller places it between
 * the room shell and the table nodes) because a table is the thing a host
 * taps — a decorative wall must never sit on top of a live booking.
 *
 * pointer-events are off entirely outside Arrange mode, so a fixture can never
 * swallow a tap meant for a table during service.
 */
export default function FloorFixtures({
  fixtures = [],
  // `t` is a PROP, not a useLanguage() call. FloorPlan and every node under it
  // already take their translator this way, and reaching for the context here
  // made the whole floor throw "useLanguage must be used within
  // LanguageProvider" for any consumer that renders it outside the provider —
  // including this repo's own floor-plan test, which is how it was caught. A
  // shared render component should not impose a provider its parent does not.
  t = (_k, fb) => fb,
  editing = false,
  selectedId = null,
  onPointerDownDrag = null,
  onTap = null,
}) {
  if (!fixtures.length) return null;
  return (
    <div className={"absolute inset-0 " + (editing ? "" : "pointer-events-none")} aria-hidden>
      {fixtures.map((f) => (
        <Fixture
          key={f.id}
          f={f}
          t={t}
          editing={editing}
          selected={editing && String(selectedId) === String(f.id)}
          onPointerDownDrag={onPointerDownDrag}
          onTap={onTap}
        />
      ))}
    </div>
  );
}
