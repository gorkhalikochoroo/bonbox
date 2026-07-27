/**
 * Flat, top-down architectural floor plan — the one asset on this page a
 * template does not have.
 *
 * From design_handoff_bonbox_landing. Deliberately NOT isometric: the
 * handoff records that a rotated version was rejected because skewing the
 * plane distorts the labels and squashes the circular seat markers into
 * ellipses. Depth comes only from extrusion (a hard `0 Npx 0` shadow that
 * reads as the side of a solid object) and a soft cast shadow beneath it.
 *
 * Everything is positioned in PERCENTAGES inside an aspect-ratio box, so
 * the plan scales to any width with no transforms and needs no
 * breakpoint of its own.
 *
 * Colours are stock Tailwind under the handoff's names — slate-900 is its
 * "ink", green-600 its "green", slate-200 its "border". Only `paper` (the
 * warm floor, which must stay distinct from slate-50) is a custom token.
 *
 * The four 9s animations are ONE synchronised story — a booking arrives,
 * Bord 3 goes upcoming, then seated, then resets. They must stay on a
 * shared clock; staggering them breaks the narrative. All are disabled
 * under prefers-reduced-motion, and because each animated node carries
 * its resolved end state as an inline style, reduced-motion users see a
 * finished plan rather than a blank one.
 */
import { useLanguage } from "../../hooks/useLanguage";

/** left/top/width/height are % of the floor; seats are laid out per side. */
const TABLES = [
  { id: 6, shape: "rect", left: 4.5, top: 9, w: 31, h: 13, seats: 6, split: true, label: 14 },
  { id: 7, shape: "circle", left: 47, top: 8.5, w: 14.5, seats: 2 },
  { id: 8, shape: "circle", left: 71, top: 8.5, w: 14.5, seats: 2, state: "upcoming" },
  { id: 1, shape: "rect", left: 6, top: 42, w: 14, h: 15, seats: 2 },
  { id: 2, shape: "rect", left: 40, top: 42, w: 19, h: 15, seats: 2 },
  { id: 3, shape: "circle", left: 74, top: 59, w: 15, seats: 4, animated: true },
  { id: 4, shape: "rect", left: 5, top: 76, w: 27, h: 11, seats: 4, hollow: true },
  { id: 5, shape: "rect", left: 40, top: 74, w: 29, h: 13, seats: 6, split: true, label: 14 },
];

const FREE = {
  background: "#ECFDF5",
  border: "1.5px solid #22C55E",
  boxShadow: "0 3px 0 #86EFAC, 0 11px 16px -7px rgba(15,23,42,.30)",
};
const UPCOMING = {
  background: "#FEF3C7",
  border: "1.5px solid #F59E0B",
  boxShadow: "0 3px 0 #FCD34D, 0 11px 16px -7px rgba(15,23,42,.30)",
};

function Seats({ table }) {
  const n = table.seats;
  const dot = (extra) => ({
    position: "absolute",
    width: 11,
    height: 11,
    borderRadius: "50%",
    background: table.hollow ? "#FBFAF7" : table.state === "upcoming" ? "#F59E0B" : "#22C55E",
    border: table.hollow ? "2px solid #22C55E" : undefined,
    boxShadow: table.hollow
      ? undefined
      : `0 2px 0 ${table.state === "upcoming" ? "#B45309" : "#15803D"}, 0 5px 6px -3px rgba(15,23,42,.35)`,
    ...extra,
  });

  if (table.shape === "circle") {
    // Seats sit on the circumference, offset outward by 7px.
    return Array.from({ length: n }, (_, i) => {
      const a = (i / n) * 2 * Math.PI - Math.PI / 2;
      return (
        <span
          key={i}
          data-anim={table.animated ? "1" : undefined}
          className={table.animated ? "bb-seatdot" : undefined}
          style={dot({
            left: `calc(50% + ${Math.cos(a) * 54}% - 5.5px)`,
            top: `calc(50% + ${Math.sin(a) * 54}% - 5.5px)`,
          })}
        />
      );
    });
  }

  // Rectangles: split 3-and-3 along the long edges, or one per short end.
  if (table.split) {
    const per = n / 2;
    return Array.from({ length: n }, (_, i) => {
      const row = i < per ? "top" : "bottom";
      const k = i % per;
      const x = ((k + 1) / (per + 1)) * 100;
      return <span key={i} style={dot({ left: `calc(${x}% - 5.5px)`, [row]: -7 })} />;
    });
  }
  return Array.from({ length: n }, (_, i) => (
    <span
      key={i}
      style={dot(
        i % 2 === 0
          ? { left: -7, top: `calc(${((Math.floor(i / 2) + 1) / (n / 2 + 1)) * 100}% - 5.5px)` }
          : { right: -7, top: `calc(${((Math.floor(i / 2) + 1) / (n / 2 + 1)) * 100}% - 5.5px)` },
      )}
    />
  ));
}

export default function FloorPlan() {
  const { t } = useLanguage();

  return (
    <div className="w-full max-w-[600px]">
      {/* Header rail above the plan */}
      <div className="flex items-center justify-between gap-3 mb-2.5">
        <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-slate-400">
          {t("landingPlanEyebrow", "Plan · Bistro Nørrebro · stueplan")}
        </span>
        <span className="shrink-0 inline-flex items-center gap-1.5 rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-600">
          {t("landingPlanDrag", "Træk for at flytte")}
        </span>
      </div>

      {/* Frame — the slate body IS the wall poché; inset:8px leaves 8px walls */}
      <div
        className="relative w-full"
        style={{
          aspectRatio: "600 / 452",
          background: "#0F172A",
          borderRadius: 3,
          boxShadow: "0 5px 0 #020617, 0 34px 54px -26px rgba(15,23,42,.50)",
        }}
      >
        {/* Floor: warm paper + 28px drafting grid + walls casting inward */}
        <div
          className="absolute"
          style={{
            inset: 8,
            backgroundColor: "#FBFAF7",
            backgroundImage:
              "repeating-linear-gradient(0deg, rgba(15,23,42,.055) 0 1px, transparent 1px 28px)," +
              "repeating-linear-gradient(90deg, rgba(15,23,42,.055) 0 1px, transparent 1px 28px)",
            boxShadow:
              "inset 0 9px 14px -9px rgba(15,23,42,.55), inset 0 -9px 14px -9px rgba(15,23,42,.35)," +
              "inset 9px 0 14px -9px rgba(15,23,42,.35), inset -9px 0 14px -9px rgba(15,23,42,.35)",
          }}
        >
          {/* Window — standard plan symbol: a gap in the wall with two rules */}
          <div
            className="absolute"
            style={{
              left: "5%",
              top: -8,
              width: "42%",
              height: 8,
              background: "#FBFAF7",
              borderTop: "1.5px solid #0F172A",
              borderBottom: "1.5px solid #0F172A",
            }}
          />
          <span
            className="absolute text-[8.5px] font-semibold uppercase tracking-[0.18em] text-slate-500"
            style={{ left: "5%", top: 4 }}
          >
            {t("landingPlanWindow", "Vindue")}
          </span>

          {/* Entrance — opening, door leaf, and a swing arc */}
          <div className="absolute" style={{ left: "6%", bottom: -8, width: "13%", height: 8, background: "#FBFAF7" }} />
          <div className="absolute" style={{ left: "6%", bottom: 0, width: 2, height: "13%", background: "#0F172A" }} />
          <div
            className="absolute"
            style={{
              left: "6%",
              bottom: 0,
              width: "13%",
              height: "13%",
              borderRight: "1.5px solid #94A3B8",
              borderTop: "1.5px solid #94A3B8",
              borderRadius: "0 100% 0 0",
            }}
          />
          <span
            className="absolute text-[8.5px] font-semibold uppercase tracking-[0.18em] text-slate-500"
            style={{ left: "21%", bottom: 6 }}
          >
            {t("landingPlanEntrance", "Indgang")}
          </span>

          {/* Bar counter — a solid object, so it extrudes like the walls */}
          <div
            className="absolute flex items-center justify-center"
            style={{
              right: "2.5%",
              top: "7%",
              width: "6.5%",
              height: "48%",
              borderRadius: 5,
              background: "#0F172A",
              boxShadow: "0 5px 0 #020617, 0 18px 24px -10px rgba(15,23,42,.55)",
            }}
          >
            <span
              className="text-[8.5px] font-semibold uppercase text-slate-400"
              style={{ writingMode: "vertical-rl", letterSpacing: "0.26em" }}
            >
              {t("landingPlanBar", "Bar")}
            </span>
          </div>

          {/* Tables */}
          {TABLES.map((tb) => {
            const base = tb.state === "upcoming" ? UPCOMING : FREE;
            return (
              <div
                key={tb.id}
                data-anim={tb.animated ? "1" : undefined}
                className={tb.animated ? "bb-seat absolute" : "absolute"}
                style={{
                  left: `${tb.left}%`,
                  top: `${tb.top}%`,
                  width: `${tb.w}%`,
                  height: tb.shape === "circle" ? undefined : `${tb.h}%`,
                  aspectRatio: tb.shape === "circle" ? "1 / 1" : undefined,
                  borderRadius: tb.shape === "circle" ? "50%" : 9,
                  ...base,
                }}
              >
                {tb.animated && (
                  <span
                    data-anim="1"
                    className="bb-ping absolute rounded-full pointer-events-none"
                    style={{ inset: -11, border: "2px solid #22C55E" }}
                  />
                )}
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-0.5">
                  <span
                    className="font-display font-bold tracking-[-0.012em]"
                    style={{
                      fontSize: tb.label === 14 ? 14 : 13,
                      color: tb.state === "upcoming" ? "#92400E" : "#0F172A",
                    }}
                  >
                    {t("landingPlanTable", "Bord {n}", { n: tb.id })}
                  </span>
                  <span
                    className="text-[11px] font-medium"
                    style={{ color: tb.state === "upcoming" ? "#B45309" : "#16A34A" }}
                  >
                    {tb.seats}
                  </span>
                </div>
                <Seats table={tb} />
              </div>
            );
          })}
        </div>

        {/* Booking arrives — the first beat of the 9s story */}
        <div
          data-anim="1"
          className="bb-book absolute rounded-xl border border-slate-200 bg-white px-3 py-2 shadow-sm"
          style={{ right: -10, top: -16 }}
        >
          <span className="flex items-center gap-1.5 text-[12px] font-semibold text-slate-900">
            <span className="inline-block h-2 w-2 rounded-full" style={{ background: "#F59E0B" }} />
            {t("landingPlanBooking", "Bord 3 · 19:00 · 2 gæster")}
          </span>
          <span className="block text-[11px] text-slate-500">
            {t("landingPlanBookingSub", "Booket online, sat automatisk")}
          </span>
        </div>
      </div>

      {/* Legend */}
      <div className="mt-3 flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-slate-200 pt-3 text-[12px] text-slate-500">
        <span className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="flex items-center gap-1.5">
            <i className="h-2 w-2 rounded-full" style={{ background: "#22C55E" }} />
            {t("landingPlanFree", "Ledigt")}
          </span>
          <span className="flex items-center gap-1.5">
            <i className="h-2 w-2 rounded-full" style={{ background: "#F59E0B" }} />
            {t("landingPlanUpcoming", "På vej")}
          </span>
          <span className="flex items-center gap-1.5">
            <i className="h-2 w-2 rounded-full" style={{ background: "#0F172A" }} />
            {t("landingPlanSeated", "Sat")}
          </span>
          <span className="flex items-center gap-1.5">
            <i className="h-2 w-2 rounded-full border-2" style={{ borderColor: "#22C55E" }} />
            {t("landingPlanNext", "Din næste booking")}
          </span>
        </span>
        <span className="tabular-nums">{t("landingPlanCount", "28 pladser · 8 borde")}</span>
      </div>
    </div>
  );
}
