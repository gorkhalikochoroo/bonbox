/* The v6 landing's stepping, as pure functions (PORT_PLAN 1.4 item 10): the beats of the pinned day, the seven scenes the
 * counter counts, where "Næste" / "Forrige" go, and the v6.3 step queue. engine.js drives the page with these; the unit test
 * (landingV6Nav.test.js) steps through them without a browser.
 *
 * From the v6.3 prototype script (final/site/tools/src.html, sha256 852247b0…), logic unchanged: SCN, NAV, build(), seg(),
 * scnOf(), curScn(), stepFrom() / stepTo() (STQ) and goNext() / goPrev().
 * Added by the port (iOS Safari, Simulator 22 Oct ~07:50; decisions_2026-10-21_evening.md item 1):
 *   - tapGate: a stepper tap that lands < 250 ms after the previous accepted one is ignored (the two count as one), so a
 *     machine-speed double tap can never start a second jump while iOS still applies the first;
 *   - jumpCheck: after a jump, if Safari has put the page back where it was (± 2 px) while no finger is down, the engine
 *     re-asserts the target once (checked on the next frame, at 150 ms and when the touch ends, within 400 ms). */

/** The seven scenes the counter counts: 10.00 plan · 12.30 the guest books · 16.40 the staff · 19.45 seated · 22.50 the stand ·
 *  00.10 the photo · 00.10 MOMS. A is the passage where night rises: 3 before the room hands over (t < roomIn), else 4. */
export const NSC = 7;
export const SCN = Object.freeze({ h: 1, "1a": 1, "2a": 2, "1b": 3, A: 3, S: 4, B: 4, "2b": 5, C: 5, "3a": 6, "3b": 7, end: 7 });
/** Each counted scene's resting point: [beat, progress through it]. */
export const NAV = Object.freeze([["1a", 0.5], ["2a", 0.45], ["1b", 0.5], ["S", 0.74], ["2b", 0.6], ["3a", 0.5], ["3b", 0.62]].map(Object.freeze));
export const NAVF = Object.freeze(Object.fromEntries(NAV));

/** Runway per beat, in svh. Desktop starts with the hero beat h (30). */
const RUNWAY = [["1a", 36], ["2a", 42], ["1b", 38], ["A", 76], ["S", 48], ["B", 34], ["2b", 44], ["C", 28], ["3a", 40], ["3b", 48], ["end", 100]];

/** The track: SEG = [beat, runway], ACC = each beat's start (svh), TOT = the sum, AI = the index of A. The track is TOT + 100 svh tall. */
export function buildTrack(desk) {
  const SEG = RUNWAY.map((x) => [x[0], x[1]]);
  if (desk) SEG.unshift(["h", 30]);
  const ACC = [];
  let a = 0, AI = -1;
  SEG.forEach((x, i) => { ACC.push(a); a += x[1]; if (x[0] === "A") AI = i; });
  return { SEG, ACC, TOT: a, AI };
}

const clamp = (a, v, b) => Math.max(a, Math.min(b, v));

/** [beat, progress 0..1, index] at u svh into the track (before it: the first beat at 0). */
export function seg(tr, u) {
  const { SEG, ACC } = tr;
  if (u < 0) return [SEG[0][0], 0, 0];
  for (let i = 0; i < SEG.length; i++) if (u < ACC[i] + SEG[i][1] || i === SEG.length - 1) return [SEG[i][0], clamp(0, (u - ACC[i]) / SEG[i][1], 1), i];
  return [SEG[0][0], 0, 0];
}

/** u (svh into the track) of progress f through beat id; null if the track has no such beat. */
export function beatU(tr, id, f) {
  for (let i = 0; i < tr.SEG.length; i++) if (tr.SEG[i][0] === id) return tr.ACC[i] + tr.SEG[i][1] * (f == null ? 0.5 : f);
  return null;
}

/** The counted scene of beat id at progress t. */
export function scnOf(id, t, roomIn) {
  return id === "A" ? (t < roomIn ? 3 : 4) : SCN[id];
}

/** The scene the page is in at scroll y: before the stage pins, 1 on a phone / tablet and 0 (the hero) on desktop. */
export function curScn(y, { pin, svh, desk, track, roomIn }) {
  if (y < pin - 4) return desk ? 0 : 1;
  const sg = seg(track, ((y - pin) / svh) * 100);
  return sg[0] === "h" ? 0 : scnOf(sg[0], sg[1], roomIn);
}

/** "Næste": the next counted scene at its resting point; after 7 it is the page after the day (k = NSC + 1, id null). */
export function nextTarget(c) {
  for (let i = 0; i < NAV.length; i++) if (SCN[NAV[i][0]] > c) return { k: SCN[NAV[i][0]], id: NAV[i][0], f: NAV[i][1] };
  return { k: NSC + 1, id: null, f: null };
}

/** "Forrige": the previous counted scene at the same resting point "Næste" uses; null at 1 / 7 (and before it). */
export function prevTarget(c) {
  for (let i = NAV.length - 1; i >= 0; i--) if (SCN[NAV[i][0]] < c) return { k: SCN[NAV[i][0]], id: NAV[i][0], f: NAV[i][1] };
  return null;
}

/** v6.3 step queue: a tap within 600 ms of the last jump, or before the page has arrived there (at most 1.5 s), steps on from
 *  that jump's scene, not from where the page happens to be. Once the page has arrived, any scroll away (by hand) drops it. */
export const STQ_HOLD = 600;
export const STQ_ARRIVE = 1500;
/** Port: stepper taps closer than this to the previous accepted tap count as one. */
export const TAP_MERGE = 250;
/** Port: how long after a jump a snap-back to the pre-jump place is watched for. */
export const JUMP_WATCH = 400;

/** The per-page stepping state (one per mount): the queue (STQ) and the tap gate. now is performance.now(). */
export function createStepper() {
  let q = null, lastTap = -Infinity;
  return {
    /** The current queue entry ({k, y, at, hit}) or null. */
    get queue() { return q; },
    set queue(v) { q = v; },
    /** The tap gate: true for a tap that counts, false for one merged into the previous accepted tap. */
    tap(now) {
      if (now - lastTap < TAP_MERGE) return false;
      lastTap = now;
      return true;
    },
    /** stepFrom(): the scene a tap steps from. cur() is the scene at the current scroll position. */
    from(now, cur) {
      if (q) {
        const dt = now - q.at;
        if (dt < STQ_HOLD || (!q.hit && dt < STQ_ARRIVE)) return q.k;
      }
      return cur();
    },
    /** stepTo() bookkeeping: remember the jump (k, target y) before the page moves. */
    to(k, y, now) {
      q = { k, y, at: now, hit: false };
      return q;
    },
    /** The scroll listener's half: arrived (within 2 px) → hit; after arriving, a scroll away drops the queue. */
    scrolled(y) {
      if (!q) return;
      if (!q.hit) { if (Math.abs(y - q.y) < 2) q.hit = true; }
      else if (Math.abs(y - q.y) >= 2) q = null;
    },
  };
}

/** goNext(): {k, y} of the jump "Næste" makes. ctx: cur() → scene now, beatY(id, f) → page y, endY() → y of the page after the day. */
export function goNext(st, now, ctx) {
  const n = nextTarget(st.from(now, ctx.cur));
  return { k: n.k, y: n.id ? ctx.beatY(n.id, n.f) : ctx.endY() };
}

/** goPrev(): {k, y} of the jump "Forrige" makes, or null at 1 / 7. */
export function goPrev(st, now, ctx) {
  const p = prevTarget(st.from(now, ctx.cur));
  return p ? { k: p.k, y: ctx.beatY(p.id, p.f) } : null;
}

/** After a jump p = {y0 (before), y (target), at}: "reassert" when the page is back at y0 (± 2 px) and not at the target while no
 *  touch is active; "wait" while a touch is down or nothing is wrong yet; "expired" after JUMP_WATCH; "none" without a jump. */
export function jumpCheck(p, y, now, touching) {
  if (!p) return "none";
  if (now - p.at > JUMP_WATCH) return "expired";
  if (touching) return "wait";
  if (Math.abs(y - p.y0) < 2 && Math.abs(y - p.y) >= 2) return "reassert";
  return "wait";
}
