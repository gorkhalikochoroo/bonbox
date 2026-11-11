import { useEffect, useState } from "react";
import { motionAllowed } from "./sheetMotion";

/**
 * RollingDigits — a number (or a "1:05" clock) whose CHANGED digits roll.
 *
 * Vagtplan (Nov 2026, the Orvexlo motion kit's bb-roll, as BeloBag's
 * PriceTicker draws it): the live ring's timer and the hours figures. When
 * the value changes, each digit that changed is a cell — the old digit slides
 * out and fades while the new one rises into its place (vagtplan.css
 * .vp-roll-*). Every other character stays put. Nothing rolls on the first
 * paint, and a re-render with the same value replays nothing.
 *
 * Positions are counted from the RIGHT, so "9:59" → "10:00" keeps the
 * minutes' column the minutes' column. A value that grew rolls up, one that
 * shrank rolls down (compared on its digits, so 9 → 0 in a carry still rolls
 * up with the rest of "1:59" → "2:00").
 *
 * Screen readers: at rest the number is ONE plain text node, exactly like the
 * span it replaced. While a roll plays (ROLL_MS) the moving cells are
 * aria-hidden and a visually hidden copy carries the value, so VoiceOver
 * never stops on a lone "1", ":" or "5". Where motion is unwelcome
 * (prefers-reduced-motion) or the browser cannot say (no matchMedia), it
 * never rolls; CSS also turns the roll off. Transform + opacity only.
 */
// 80 ms behind + 460 ms on the spring for the new digit (the old one is gone
// after 300), and a little air before the plain text comes back.
export const ROLL_MS = 600;

function digitsOf(s) {
  const d = String(s || "").replace(/\D/g, "");
  return d ? Number(d) : null;
}

function dirOf(from, to) {
  const a = digitsOf(from);
  const b = digitsOf(to);
  return a == null || b == null || b >= a ? "up" : "down";
}

/** The live copy: plain runs for what stayed, a cell for each changed digit. */
function cells({ from, to, dir }) {
  const out = [];
  let run = "";
  const chars = [...to];
  const old = [...from];
  chars.forEach((ch, i) => {
    const r = chars.length - 1 - i;            // column, counted from the right
    const was = old[old.length - 1 - r];
    if (was === ch || !/\d/.test(ch)) {
      run += ch;
      return;
    }
    if (run) out.push(run);
    run = "";
    out.push(
      <span key={`c${r}`} className={`vp-roll-cell vp-roll-${dir}`}>
        {was != null && <span className="vp-roll-out">{was}</span>}
        <span className="vp-roll-in">{ch}</span>
      </span>,
    );
  });
  if (run) out.push(run);
  return out;
}

export default function RollingDigits({ value, className = "", ...rest }) {
  const text = value == null ? "" : String(value);
  const [motion] = useState(motionAllowed);
  // The value last drawn, and the roll playing (if any), kept in state
  // ("adjust state while rendering"): React re-renders at once with the new
  // state, so a change is drawn as a roll in the same commit, and a re-render
  // with the same value changes nothing.
  const [st, setSt] = useState(() => ({ text, n: 0, roll: null }));
  if (st.text !== text) {
    setSt((cur) => (cur.text === text ? cur : {
      text,
      n: cur.n + 1,
      roll: motion ? { from: cur.text, to: text, dir: dirOf(cur.text, text) } : null,
    }));
  }
  const rolling = !!st.roll;
  useEffect(() => {
    if (!rolling) return undefined;
    const n = st.n;
    const id = setTimeout(() => setSt((cur) => (cur.n === n ? { ...cur, roll: null } : cur)), ROLL_MS);
    return () => clearTimeout(id);
  }, [rolling, st.n]);

  const cls = `vp-roll${className ? ` ${className}` : ""}`;
  if (!st.roll || st.text !== text) {
    return <span className={cls} data-value={text} {...rest}>{text}</span>;
  }
  return (
    <span className={cls} data-value={text} {...rest}>
      <span className="sr-only">{text}</span>
      {/* Keyed per change: a new change is a new roll, from the value shown. */}
      <span key={st.n} className="vp-roll-live" aria-hidden="true">{cells(st.roll)}</span>
    </span>
  );
}
