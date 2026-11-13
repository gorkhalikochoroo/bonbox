// A throw-matched settle (premium feel P4): keyframes from a tiny spring
// simulation, played by WAAPI on the compositor (transform only).
// from/to in px, v0 in px/ms (+ = toward larger values). Defaults = the kit's
// --spring-soft (k 365, ζ .72): about 3.8 % overshoot, settled within 1.2 s.
//
// Timed in ms, never in frames (phone R1, 120 Hz). The physics steps STEP_S
// (1/480 s) at a time: semi-implicit Euler at a whole 1/60 s step damps this
// spring far too much (its overshoot came out at 1 %, not --spring-soft's
// 3.8 %); 1/480 s lands at 3.5 %, as the spec's test asks (−4.5 to −3 px on a
// 100 px settle). A keyframe is kept every 1/KEY_HZ s and WAAPI plays them
// over `duration` ms on the compositor's clock, so the settle takes the same
// time and follows the same curve at 60, 90, 120 or 144 Hz; the screen only
// decides how many points of it are drawn. Keyframes used to be one per
// 60 Hz frame: on a ProMotion screen every other frame then fell on a
// straight line between two of them, about 3 px off the spring on a
// realistic release. At 240 a second no refresh rate is more than 0.2 px
// off. Cheap: at most 289 keyframes, built once per release.
export const STEP_S = 1 / 480;
export const KEY_HZ = 240;
export const SUBSTEPS = Math.round(1 / (KEY_HZ * STEP_S));   // physics steps per keyframe (2)
const MAX_KEYS = Math.round(1.2 * KEY_HZ);                  // settled within 1.2 s
export function springKeyframes(from, to, v0 = 0, { k = 365, zeta = 0.72, map = (y) => `translateY(${y}px)` } = {}) {
  const w = Math.sqrt(k);
  const h = STEP_S;
  let x = from - to;
  let v = v0 * 1000;
  let n = 0;                                   // keyframes after the first; integer, so no float drift
  const pts = [x];
  while (n < MAX_KEYS) {
    for (let i = 0; i < SUBSTEPS; i += 1) {
      v += (-k * x - 2 * zeta * w * v) * h; x += v * h;   // semi-implicit Euler
    }
    n += 1;
    pts.push(x);
    if (Math.abs(x) < 0.3 && Math.abs(v) < 20) break;
  }
  pts[pts.length - 1] = 0;
  return {
    // n keyframe gaps of exactly 1000 / KEY_HZ ms each (a fraction of a ms is fine for WAAPI).
    duration: (n * 1000) / KEY_HZ,
    keyframes: pts.map((p, i) => ({ transform: map(to + p), offset: i / (pts.length - 1) })),
  };
}
