/* eslint-disable react-refresh/only-export-components -- one small kit: the
   label and the two hooks that drive it (useLate, useDoneFlash) belong together. */
import { useEffect, useState } from "react";
import { Check } from "lucide-react";

// Busy → done inside the button (premium feel P6 / 1.7). The button stays the
// same object: same size, same colour, full opacity. After 300 ms of waiting
// the label fades and a small ring turns; on a yes a check pops in and holds
// 900 ms. Styles: .vp-busy* and .vp-ring in vagtplan.css.
export const BUSY_WAIT_MS = 300;   // most answers land sooner and never show a ring
export const DONE_HOLD_MS = 900;

/** True only after `on` has been true for `ms`. While `hold` it keeps what it showed and
    starts no timer: nothing new appears on a card that is fading out (the clock's leave). */
export function useLate(on, ms = BUSY_WAIT_MS, hold = false) {
  const [st, setSt] = useState({ on, late: false });
  if (!hold && st.on !== on) setSt({ on, late: false });   // adjust while rendering, as usePresence
  useEffect(() => {
    if (hold || !st.on || st.late) return undefined;
    const id = setTimeout(() => setSt((c) => (c.on ? { ...c, late: true } : c)), ms);
    return () => clearTimeout(id);
  }, [hold, st.on, st.late, ms]);
  return st.on && st.late;
}

/** [done, flash]: flash() shows the check for DONE_HOLD_MS. */
export function useDoneFlash() {
  const [n, setN] = useState(0);
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (!n) return undefined;
    const id = setTimeout(() => setShown(n), DONE_HOLD_MS);
    return () => clearTimeout(id);
  }, [n]);
  return [n !== shown, () => setN((x) => x + 1)];
}

/** Label, ring and check share ONE grid cell: the button never changes size or colour.
    The button itself carries disabled and aria-busy; the label stays in the DOM, so the
    accessible name never changes. */
export default function BusyLabel({ busy = false, done = false, hold = false, children }) {
  const late = useLate(busy, BUSY_WAIT_MS, hold);
  const state = done ? "done" : late ? "busy" : "idle";
  return (
    <span className="vp-busy" data-state={state}>
      <span className="vp-busy-label">{children}</span>
      <span className="vp-busy-spin vp-ring" aria-hidden />
      <Check className="vp-busy-check" size={18} strokeWidth={2.5} aria-hidden />
    </span>
  );
}
