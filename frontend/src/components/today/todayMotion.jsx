/* eslint-disable react-refresh/only-export-components -- one small kit: the
   intro hook, the roll and their constants travel together (as BusyLabel). */
/**
 * I dag's motion (Nov 2026): Vagtplan's feel on the owner's today page.
 * Source of truth: bonbox-lab-state/design-departments-2026-11-11/
 * PREMIUM-FEEL-SPEC.md (approved A–G) and CLOCK-MOTION-SPEC.md, built from
 * the Vagtplan code that already draws it (components/staff: RollingDigits,
 * sheetMotion's motionAllowed, feel, pressFeel).
 *
 * ONE beat per visit. The first time the owner sees today's page in this
 * browser session (sessionStorage, keyed by account + business day), the page
 * carries `td-intro` for INTRO_MS: the cards rise, the figures roll up from 0
 * once, the bars grow, the MOMS meter fills, the now-line fades in
 * (today.css). Then the class goes and the page is still. A poll, a refresh
 * on the freshness bus, a return to the tab or to the route never plays it
 * again; a new business day plays it once. Where motion is unwelcome
 * (prefers-reduced-motion) or the browser cannot say (no matchMedia), nothing
 * plays and every figure is its final value from the first paint.
 */
import { useCallback, useEffect, useState } from "react";
import RollingDigits from "../staff/RollingDigits";
import { motionAllowed } from "../staff/sheetMotion";

/** The intro window. The last entrance (the chart's bars, the week's
    columns) ends by ~1.35 s; the class goes at 1.6 s, after it. */
export const INTRO_MS = 1600;
/** sessionStorage: the stamp the intro last played for. */
export const INTRO_KEY = "bonbox.today.intro";

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

/**
 * useTodayIntro(stamp) → true while the visit's one intro plays.
 * Decided once, on the first stamp this mount sees (data arrived): motion
 * welcome AND not yet played for that stamp in this session. A later stamp
 * on the same mount (the day rolled over under a poll) never plays; it is
 * only remembered, so coming back to the page does not play it either.
 */
export function useTodayIntro(stamp) {
  const [st, setSt] = useState({ stamp: null, on: false });
  if (stamp && st.stamp !== stamp) {
    // "Adjust state while rendering" (as usePresence): React re-renders at
    // once, so no child ever renders with the undecided value.
    setSt({ stamp, on: st.stamp == null && motionAllowed() && !playedFor(stamp) });
  }
  useEffect(() => {
    if (!st.stamp) return undefined;
    remember(st.stamp);                 // at the START: leaving mid-intro never replays it
    if (!st.on) return undefined;
    const id = setTimeout(() => setSt((cur) => (cur.stamp === st.stamp ? { ...cur, on: false } : cur)), INTRO_MS);
    return () => clearTimeout(id);
  }, [st.stamp, st.on]);
  return st.stamp === stamp && st.on;
}

/**
 * RollIn — a figure that rolls up once, from 0, during the intro.
 *
 * `value` is the exact text the page shows (Danish format, "9.840 kr.");
 * `from` is the same figure at 0 in the same format ("0 kr.", "0 af 5").
 * Vagtplan's RollingDigits draws the roll: it is handed `from` for one
 * commit that is never painted (the ref callback below swaps in the real
 * value before the browser draws), so it rolls the changed digits from 0 to
 * the value: every separator and unit stands still at its final place, no
 * digit in between is ever shown, and it ends on exactly `value`.
 *
 * Screen readers get `value` only: while `play` is on, the drawn figure is
 * aria-hidden and a visually hidden copy carries the final text. With `play`
 * off (after the intro, reduced motion, a poll) it is the plain text, so a
 * refresh never rolls. A value that changes DURING the intro rolls from the
 * previous real value (RollingDigits' own rule).
 */
export function RollIn({ value, from = null, play = false }) {
  const text = value == null ? "" : String(value);
  const [first] = useState(() => {
    const f = from == null ? null : String(from);
    return play && f != null && f !== text && /\d/.test(text) ? f : null;
  });
  const [armed, setArmed] = useState(first == null);
  // The swap: a ref callback runs in the commit that mounted the 0, and an
  // update made in a commit is rendered synchronously before the browser
  // paints (React's discrete priority), so the 0 is never drawn at rest.
  const arm = useCallback((node) => { if (node) setArmed(true); }, []);
  if (!play) return text;
  return (
    <>
      <span className="sr-only" ref={armed ? undefined : arm}>{text}</span>
      <RollingDigits value={armed ? text : first} aria-hidden="true" />
    </>
  );
}
