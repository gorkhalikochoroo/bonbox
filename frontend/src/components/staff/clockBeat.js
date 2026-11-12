import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { motionAllowed } from "./sheetMotion";

// The clock beat (Nov 2026): clock-in, clock-out and a pause on the Vagtplan
// home (bonbox-lab-state/design-departments-2026-11-11/CLOCK-MOTION-SPEC.md,
// approved 11 Nov, "yea do it").
//
// Clock-in is the ONE ceremonial beat: the next-shift card fades out, the
// pine surface reshapes to the live card, the blocks below glide by their own
// distance, the faint ring draws round once with the knob as the pen (only
// for a fresh punch on a planned shift), "0:00" rises in. Clock-out is its
// quiet reverse (the live card fades as it stood; nothing unwinds). A pause
// only melts the arc's colour. A beat is made ONLY by useClock's act /
// breakAct after a 2xx answer that changed what the screen showed, and only
// where motion is welcome (motionAllowed). Never on load, a poll, resume, a
// tab switch or a refusal. The haptic is not part of the beat: it stays at
// the server's answer, exactly as before.
//
// Times in ms; vagtplan.css carries the same values as tokens.
export const LEAVE_MS = { in: 180, out: 240 };    // --dur-fast, --dur-exit
export const ARM_MS = { in: 480, out: 440 };      // swap → the new card's buttons are fully in
export const SETTLE_MS = { in: 1060, out: 480 };  // swap → rest: the last animation + 40 air
export const BREAK_MS = 680;                      // --dur-slow + 40 air
export const MOVE_MS = 360;                       // --dur-nav-back
export const MOVE_EASE = "cubic-bezier(.32, .72, 0, 1)"; // --ease-nav (a test pins it to the CSS)
export const FRESH_SEC = 120;
export const CAP = 24;                            // the card's radius: the surface's caps never scale

/**
 * The seconds sweep (Manoj, 12 Nov 2026: "like an analog watch"): where the
 * live card's seconds dot stands, in seconds into the minute (0 = 12 o'clock).
 * `sec` is the timer the card SHOWS (the shift, or the pause on a pause), in
 * whole seconds; `sinceTickMs` is how long ago that number last moved on the
 * card's 1 s tick. So the dot is at 12 exactly when the H:MM minute rolls.
 * Never a full second past the shown number (a late or sleeping tick).
 */
export const SWEEP_SEC = 60;
export function sweepPhase(sec, sinceTickMs = 0) {
  const s = Number.isFinite(sec) ? Math.floor(sec) : 0;
  const frac = Math.min(Math.max(Number(sinceTickMs) || 0, 0), 999) / 1000;
  return (((s % SWEEP_SEC) + SWEEP_SEC) % SWEEP_SEC) + frac;
}

/** What a CONFIRMED answer changed on this screen; null when it changed nothing. */
export function beatFor(action, before, after) {
  if (!after || typeof after !== "object") return null;
  if (action === "in") return !before?.clocked_in && after.clocked_in === true
    ? { kind: "in", fresh: (after.elapsed_sec ?? 0) < FRESH_SEC } : null;
  if (action === "out") return before?.clocked_in && after.clocked_in === false
    ? { kind: "out", discarded: !!after.discarded } : null;
  if (action === "break") return !!before?.on_break !== !!after.on_break
    ? { kind: "break", from: before?.on_break ? "sage" : "brass" } : null;
  return null;
}

// One read pass: the hero's height and where each later block of the home sits.
function measure(hero) {
  const root = hero?.parentElement;
  if (!root) return null;
  const top = root.getBoundingClientRect().top;
  const at = new Map();
  for (let el = hero.nextElementSibling; el; el = el.nextElementSibling) {
    const r = el.getBoundingClientRect();
    at.set(el, { y: r.top - top, view: r.top });
  }
  return { h: hero.offsetHeight, at };
}

/** beat → { phase: idle|leave|enter, kind, fresh, snap, armed, shownIn }. */
export function useHeroBeat(clockedIn, beat, heroRef) {
  const [s, setS] = useState(() => ({
    seen: beat?.n ?? 0, id: 0, phase: "idle", kind: null, fresh: false, snap: null, armed: true,
  }));
  const was = useRef(null);
  let next = s;
  if (beat && beat.n !== s.seen) {
    next = beat.kind === "in" || beat.kind === "out"
      ? { seen: beat.n, id: beat.n, phase: "leave", kind: beat.kind, fresh: !!beat.fresh, snap: beat.snap || null, armed: false }
      : { ...s, seen: beat.n };                 // a pause: the hero, its id and its effects stay put
  }
  if (next.phase !== "idle" && clockedIn !== (next.kind === "in")) next = { ...next, phase: "idle", armed: true };
  if (next !== s) setS(next);                   // "adjust state while rendering", as usePresence

  const { phase, id, kind } = s;
  useEffect(() => {
    if (phase === "idle") return undefined;
    const to = (patch) => setS((cur) => (cur.id === id && cur.phase === phase ? { ...cur, ...patch } : cur));
    const timers = phase === "leave"
      ? [setTimeout(() => { was.current = measure(heroRef.current); to({ phase: "enter" }); }, LEAVE_MS[kind])]
      : [setTimeout(() => to({ armed: true }), ARM_MS[kind]),
        setTimeout(() => to({ phase: "idle", armed: true }), SETTLE_MS[kind])];
    // Hidden mid-beat (home button, lock, app switch): end it, so it never plays on resume.
    const onVis = () => { if (document.hidden) to({ phase: "idle", armed: true }); };
    document.addEventListener("visibilitychange", onVis);
    return () => { timers.forEach(clearTimeout); document.removeEventListener("visibilitychange", onVis); };
  }, [phase, id, kind, heroRef]);

  // The measured moves, before the first enter frame is painted.
  useLayoutEffect(() => {
    if (phase !== "enter") return undefined;
    const hero = heroRef.current;
    const before = was.current;
    was.current = null;
    if (!hero || !before || !motionAllowed()) return undefined;
    const top = hero.parentElement.getBoundingClientRect().top;
    const h1 = hero.offsetHeight;
    const vh = window.innerHeight || 0;
    const opts = { duration: MOVE_MS, easing: MOVE_EASE };
    const anims = [];
    const play = (el, from) => {
      if (el && typeof el.animate === "function") anims.push(el.animate([{ transform: from }, { transform: "none" }], opts));
    };
    const dh = before.h - h1;
    if (Math.abs(dh) >= 1 && before.h > 2 * CAP && h1 > 2 * CAP) {
      play(hero.querySelector(":scope > .vp-hero-surface > .vp-hs-mid"), `scaleY(${(before.h - 2 * CAP) / (h1 - 2 * CAP)})`);
      play(hero.querySelector(":scope > .vp-hero-surface > .vp-hs-bot"), `translateY(${dh}px)`);
    }
    for (let el = hero.nextElementSibling; el; el = el.nextElementSibling) {
      const b = before.at.get(el);
      if (!b) continue;                          // new on this side of the swap: its own CSS fade
      const r = el.getBoundingClientRect();
      const dy = b.y - (r.top - top);
      if (Math.abs(dy) < 1 || (b.view >= vh && r.top >= vh)) continue; // did not move, or off screen both times
      play(el, `translateY(${dy}px)`);
    }
    return () => anims.forEach((a) => a.cancel());
  }, [phase, id, heroRef]);

  // What the home shows: the server's state, except while a leave plays the old card out.
  const shownIn = next.phase === "leave" ? next.kind === "out" : clockedIn;
  return { ...next, shownIn };
}

/** The beat while it is fresh (ms), for one kind; null otherwise. Never on mount. */
export function useBeatWindow(beat, kind, ms) {
  const [w, setW] = useState(() => ({ n: beat?.n ?? 0, on: null }));
  if (beat && beat.n !== w.n) setW({ n: beat.n, on: beat.kind === kind ? beat : null });
  useEffect(() => {
    if (!w.on) return undefined;
    const t = setTimeout(() => setW((cur) => (cur.n === w.n ? { ...cur, on: null } : cur)), ms);
    return () => clearTimeout(t);
  }, [w.on, w.n, ms]);
  return beat && beat.n !== w.n ? (beat.kind === kind ? beat : null) : w.on;
}
