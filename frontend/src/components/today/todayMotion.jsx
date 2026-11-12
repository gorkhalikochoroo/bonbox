/**
 * I dag's motion (Nov 2026): Vagtplan's feel on the owner's today page.
 * Source of truth: bonbox-lab-state/design-departments-2026-11-11/
 * PREMIUM-FEEL-SPEC.md (approved A–G) and CLOCK-MOTION-SPEC.md, built from
 * the Vagtplan code that already draws it (components/staff: sheetMotion's
 * motionAllowed, feel, pressFeel, and the clock-in figure's rise).
 *
 * ONE beat per visit. The first time the owner sees today's page in this
 * browser session (sessionStorage, keyed by account + business day), the page
 * carries `td-intro`: the hero stands still while its figures rise into
 * place (the beat), the cards below settle, the bars grow, the MOMS meter
 * fills, the now-line fades in (today.css). Then the class goes and the page
 * is still. A poll, a refresh on the freshness bus, a return to the tab or to
 * the route never plays it again; a new business day plays it once. Where
 * motion is unwelcome (prefers-reduced-motion) or the browser cannot say (no
 * matchMedia), nothing plays: every figure is its final value from the first
 * paint.
 *
 * A figure rises as ONE piece, the final text from its first frame (the
 * clock-in figure's rise, CLOCK-MOTION-SPEC 2.2) — never a 0, a digit in
 * between or a lone separator, so a screen reader and the eye get the same
 * exact value throughout.
 *
 * The class is the DOM's, not React's: it goes on in the layout effect of
 * the commit that first draws the page (before the paint) and comes off by
 * itself, so the end of the intro re-renders nothing. It comes off at
 * INTRO_MS — or, when a card whose data came late (MOMS waits for
 * /cashflow/forecast) is still entering then, as soon as that entrance has
 * finished, so nothing is cut mid-move — and never later than INTRO_CAP_MS.
 */
import { useLayoutEffect, useRef } from "react";
import { motionAllowed } from "../staff/sheetMotion";

/** The intro window. The last entrance of a page drawn at once (the chart's
    bars, the week's columns, the cards' figures) ends by ~1.35 s. */
export const INTRO_MS = 1600;
/** However late a card arrived, the intro is over by then. */
export const INTRO_CAP_MS = 3200;
/** sessionStorage: the stamp the intro last played for. */
export const INTRO_KEY = "bonbox.today.intro";
/** The class the intro's entrances hang on (today.css). */
export const INTRO_CLASS = "td-intro";

/** Who + which business day: the intro plays once per stamp per session. */
export function introStamp(userId, day) {
  return day ? `${userId ?? ""}|${day}` : null;
}

function playedFor(stamp) {
  try { return window.sessionStorage.getItem(INTRO_KEY) === stamp; } catch { return false; }
}
function remember(stamp) {
  try { window.sessionStorage.setItem(INTRO_KEY, stamp); } catch { /* private mode: plays again next mount */ }
}

/** The intro's own entrances still running inside `el`: today.css's td*
    keyframes only — never a loader's loop or a press transition. */
function entering(el) {
  if (typeof el.getAnimations !== "function") return [];
  try {
    return el.getAnimations({ subtree: true }).filter((a) => (
      typeof a.animationName === "string" && a.animationName.startsWith("td")
      && a.playState === "running"
      && a.effect?.getTiming?.().iterations !== Infinity
    ));
  } catch {
    return [];
  }
}

/**
 * useTodayIntro(stamp, pageRef): the visit's one intro on the page element.
 * Decided once, on the first stamp this mount sees (data arrived): motion
 * welcome AND not yet played for that stamp in this session. It is
 * remembered at the START, so leaving mid-intro never replays it. A later
 * stamp on the same mount (the day rolled over under a poll) never plays; it
 * is only remembered, so coming back to the page does not play it either.
 */
export function useTodayIntro(stamp, pageRef) {
  const decided = useRef(null);
  useLayoutEffect(() => {
    if (!stamp) return undefined;
    if (!decided.current) decided.current = { stamp, on: motionAllowed() && !playedFor(stamp) };
    remember(stamp);
    const el = pageRef.current;
    if (!el || !decided.current.on || decided.current.stamp !== stamp) return undefined;

    el.classList.add(INTRO_CLASS);
    let over = false;
    const timers = new Set();
    const later = (fn, ms) => { timers.add(setTimeout(fn, ms)); };
    const end = () => {
      if (over) return;
      over = true;
      timers.forEach(clearTimeout);
      el.classList.remove(INTRO_CLASS);
    };
    // At INTRO_MS, and again each time what was still entering has finished
    // (through a timer, so a check can never spin on resolved promises).
    const settle = () => {
      if (over) return;
      const still = entering(el);
      if (!still.length) { end(); return; }
      Promise.all(still.map((a) => Promise.resolve(a.finished).catch(() => null)))
        .then(() => { if (!over) later(settle, 0); });
    };
    later(settle, INTRO_MS);
    later(end, INTRO_CAP_MS);
    return end;
  }, [stamp, pageRef]);
}
