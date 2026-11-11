// A throw-matched settle (premium feel P4): keyframes from a tiny spring
// simulation, played by WAAPI on the compositor (transform only).
// from/to in px, v0 in px/ms (+ = toward larger values). Defaults = the kit's
// --spring-soft (k 365, ζ .72): about 3.8 % overshoot, settled within 1.2 s.
//
// One keyframe per 60 Hz frame, but each frame is integrated in SUBSTEPS
// smaller steps. Semi-implicit Euler at a whole 1/60 s step damps this spring
// far too much (its overshoot came out at 1 %, not --spring-soft's 3.8 %);
// eight steps per frame land at 3.5 %, as the spec's test asks (−4.5 to −3 px
// on a 100 px settle). Cheap: under 30 frames × 8 steps, once per release.
export const SUBSTEPS = 8;
export function springKeyframes(from, to, v0 = 0, { k = 365, zeta = 0.72, map = (y) => `translateY(${y}px)` } = {}) {
  const w = Math.sqrt(k);
  const dt = 1 / 60;
  const h = dt / SUBSTEPS;
  let x = from - to;
  let v = v0 * 1000;
  let t = 0;
  const pts = [x];
  while (t < 1.2) {
    for (let i = 0; i < SUBSTEPS; i += 1) {
      v += (-k * x - 2 * zeta * w * v) * h; x += v * h;   // semi-implicit Euler
    }
    t += dt;
    pts.push(x);
    if (Math.abs(x) < 0.3 && Math.abs(v) < 20) break;
  }
  pts[pts.length - 1] = 0;
  return {
    duration: Math.round(t * 1000),
    keyframes: pts.map((p, i) => ({ transform: map(to + p), offset: i / (pts.length - 1) })),
  };
}
