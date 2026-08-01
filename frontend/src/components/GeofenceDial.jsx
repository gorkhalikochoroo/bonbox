/**
 * GeofenceDial — "am I close enough to clock in?", answered before you tap.
 *
 * NOT a street map, deliberately, for three reasons:
 *
 *  1. CSP. vercel.json ships `default-src 'self'` with no external image host,
 *     so Mapbox/OSM/Google tiles are blocked outright in production. Allowing a
 *     tile CDN is a real security loosening for a cosmetic gain.
 *  2. It reads differently. A street map with your dot on it looks like
 *     tracking; a radius dial looks like a door check. Same information, and
 *     the staffer already knows what street they are on.
 *  3. It costs nothing and works with no signal — no vendor, no per-load fee,
 *     no network request at all.
 *
 * PRIVACY: everything here is computed on-device from the venue centre and the
 * device's own fix. Nothing is sent. The staffer's coordinates still leave the
 * phone only attached to an actual punch, and are still never stored — which is
 * the property that makes the geofence defensible in the first place.
 *
 * HONESTY: the dial shows GPS accuracy as a halo, because "inside" is a claim
 * with error bars. The server applies accuracy as a grace radius (a real worker
 * at the door with a poor fix is not locked out), so the UI must not draw a
 * harder line than the server enforces.
 */
import { useLanguage } from "../hooks/useLanguage";

const SIZE = 132;          // px, the drawn square
const C = SIZE / 2;        // centre
const R = 52;              // px radius of the fence ring

/** Metres between two WGS84 points — equirectangular is plenty at fence scale. */
export function metresBetween(a, b) {
  const toRad = (d) => (d * Math.PI) / 180;
  const x = toRad(b.lng - a.lng) * Math.cos(toRad((a.lat + b.lat) / 2));
  const y = toRad(b.lat - a.lat);
  return Math.sqrt(x * x + y * y) * 6371000;
}

/** Where to draw the staffer, in px from centre. Clamped so a far-away dot
 *  still renders at the rim instead of flying off the canvas — the dial answers
 *  "inside or outside", not "exactly how far" (the sentence below does that). */
function plot(venue, me, radiusM) {
  const toRad = (d) => (d * Math.PI) / 180;
  const east = toRad(me.lng - venue.lng) * Math.cos(toRad((venue.lat + me.lat) / 2)) * 6371000;
  const north = toRad(me.lat - venue.lat) * 6371000;
  const dist = Math.sqrt(east * east + north * north);
  if (dist < 0.5) return { x: C, y: C, dist };
  const scale = R / radiusM;                     // px per metre
  const drawn = Math.min(dist * scale, R + 14);  // rim + a little, never off-canvas
  const k = drawn / dist;
  return { x: C + east * k, y: C - north * k, dist };
}

export default function GeofenceDial({ venue, me, radiusM, accuracyM }) {
  const { t } = useLanguage();
  if (!venue?.lat || !venue?.lng || !radiusM) return null;

  const pos = me?.lat && me?.lng ? plot(venue, me, radiusM) : null;
  // Mirror the server's rule exactly: accuracy is a grace radius, capped at
  // 200m and floored at 0 (staff_portal.py). Drawing a stricter line than the
  // server enforces would tell someone they cannot clock in when they can.
  const grace = Math.max(0, Math.min(accuracyM || 0, 200));
  const inside = pos ? pos.dist - grace <= radiusM : null;
  const accR = pos && accuracyM ? Math.min((accuracyM * R) / radiusM, R * 1.6) : 0;

  const ink = inside === null ? "#94a3b8" : inside ? "#16a34a" : "#b91c1c";

  return (
    <div className="flex items-center gap-3">
      <svg
        width={SIZE}
        height={SIZE}
        viewBox={`0 0 ${SIZE} ${SIZE}`}
        className="shrink-0"
        role="img"
        aria-label={
          inside === null
            ? t("portalFenceUnknownA11y", "Your position is unknown")
            : inside
              ? t("portalFenceInsideA11y", "You are inside the clock-in area")
              : t("portalFenceOutsideA11y", "You are outside the clock-in area")
        }
      >
        {/* fence */}
        <circle cx={C} cy={C} r={R} fill={inside ? "rgba(22,163,74,.10)" : "rgba(255,255,255,.04)"} />
        <circle
          cx={C} cy={C} r={R}
          fill="none"
          stroke={inside === null ? "rgba(255,255,255,.22)" : inside ? "rgba(34,197,94,.55)" : "rgba(239,68,68,.45)"}
          strokeWidth="1.5"
          strokeDasharray={inside === null ? "4 4" : undefined}
        />
        {/* venue centre */}
        <circle cx={C} cy={C} r="3.5" fill="rgba(255,255,255,.75)" />

        {pos && (
          <>
            {/* accuracy halo — "inside" is a claim with error bars */}
            {accR > 0 && <circle cx={pos.x} cy={pos.y} r={accR} fill={`${ink}22`} />}
            <circle cx={pos.x} cy={pos.y} r="5" fill={ink} stroke="#0f172a" strokeWidth="2" />
          </>
        )}
      </svg>

      <div className="min-w-0">
        <div className="text-[13px] font-semibold" style={{ color: inside === null ? "#cbd5e1" : inside ? "#4ade80" : "#fca5a5" }}>
          {inside === null
            ? t("portalFenceUnknown", "Can't see your location")
            : inside
              ? t("portalFenceInside", "You're at the venue")
              : t("portalFenceOutside", "Too far to clock in")}
        </div>
        {pos && (
          <div className="mt-0.5 text-[11.5px] text-gray-400 tabular-nums">
            {t("portalFenceDistance", "{d} m away · must be within {r} m", {
              d: Math.round(pos.dist),
              r: radiusM,
            })}
          </div>
        )}
        {inside === null && (
          <div className="mt-0.5 text-[11.5px] text-gray-400">
            {/* Never a dead end: the server lets a no-fix punch through and
                flags it unverified, so say so rather than implying refusal. */}
            {t("portalFenceUnknownHint", "You can still clock in — it'll be marked unverified.")}
          </div>
        )}
      </div>
    </div>
  );
}
