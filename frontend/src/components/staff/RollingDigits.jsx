import { useState } from "react";
import { motionAllowed } from "./sheetMotion";

/**
 * RollingDigits — a number (or a "1:05" clock) whose CHANGED digits roll.
 *
 * Vagtplan (Nov 2026, the Orvexlo motion kit's bb-roll): the live ring's
 * timer and the hours figures. Only a digit that changed re-mounts, so only
 * it plays the roll (vagtplan.css .vp-roll-up / .vp-roll-down); every other
 * character stays put. Nothing rolls on the first paint.
 *
 * Positions are counted from the RIGHT, so "9:59" → "10:00" keeps the
 * minutes' column the minutes' column. A value that grew rolls up, one that
 * shrank rolls down (compared on its digits, so 9 → 0 in a carry still rolls
 * up with the rest of "1:59" → "2:00").
 *
 * The text content is exactly `value` — a screen reader or a copy reads the
 * same string the old plain span held. Transform + opacity only. Where motion
 * is unwelcome (prefers-reduced-motion) or the browser cannot say (no
 * matchMedia), it renders the plain string as ONE text node, exactly like
 * the span it replaced; CSS also turns the roll off.
 */
function digitsOf(s) {
  const d = String(s || "").replace(/\D/g, "");
  return d ? Number(d) : null;
}

function nextState(prev, text) {
  const grew = (() => {
    const a = digitsOf(prev.text);
    const b = digitsOf(text);
    return a == null || b == null ? true : b >= a;
  })();
  const gens = [];
  const dirs = [];
  for (let r = 0; r < text.length; r += 1) {
    const ch = text[text.length - 1 - r];
    const old = prev.text[prev.text.length - 1 - r];
    const g = prev.gens[r] || 0;
    if (old !== ch && /\d/.test(ch)) {
      gens[r] = g + 1;
      dirs[r] = grew ? "up" : "down";
    } else {
      gens[r] = g;
      dirs[r] = prev.dirs[r];
    }
  }
  return { text, gens, dirs };
}

export default function RollingDigits({ value, className = "", ...rest }) {
  const text = value == null ? "" : String(value);
  // Previous value + per-column generation, kept in state ("adjust state
  // while rendering"): React re-renders at once with the new state, and a
  // re-render with the same value changes nothing, so a digit never replays.
  const [motion] = useState(motionAllowed);
  const [st, setSt] = useState(() => ({ text, gens: [], dirs: [] }));
  if (st.text !== text) setSt((cur) => (cur.text === text ? cur : nextState(cur, text)));
  if (!motion) {
    return <span className={`vp-roll${className ? ` ${className}` : ""}`} data-value={text} {...rest}>{text}</span>;
  }
  const shown = st.text === text ? st : { text, gens: st.gens, dirs: st.dirs };
  const chars = [...shown.text];
  return (
    <span className={`vp-roll${className ? ` ${className}` : ""}`} data-value={text} {...rest}>
      {chars.map((ch, i) => {
        const r = chars.length - 1 - i;
        if (!/\d/.test(ch)) return <span key={`s${r}`}>{ch}</span>;
        const g = shown.gens[r] || 0;
        const cls = g > 0 ? `vp-roll-digit vp-roll-${shown.dirs[r] || "up"}` : "vp-roll-digit";
        // The key carries the column AND its generation: a changed digit is a
        // new element (its animation plays), an unchanged one is the same.
        return <span key={`d${r}-${g}`} className={cls}>{ch}</span>;
      })}
    </span>
  );
}
