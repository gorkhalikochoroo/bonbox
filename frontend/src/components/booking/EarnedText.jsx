// EarnedText — text that moves only when it has earned it.
//
// The booking page's bottom bar repeats the guest's choice ("Lør 31 · 19:30",
// "2 gæster") and its button says what comes next. When that text actually
// CHANGES, the new words fade up 3 px over 260 ms, so the eye catches that the
// choice registered. On first paint nothing moves, and an answer that did not
// change never moves (the judge's "no motion on an unchanged answer").
//
// How: each text is its own keyed element. The element remembers, from the
// moment it mounted, whether it should arrive — false for the very first
// text, true for every text after it. A class added later to a node that is
// already on screen would start the animation on it, so the choice is fixed
// at mount and never flips.
import { useEffect, useState } from "react";

export const EARNED_ANIM = "motion-safe:animate-[bbLabel_260ms_cubic-bezier(0.22,1,0.36,1)]";

function Words({ as, arrive, className, children, ...rest }) {
  const Tag = as;
  const [anim] = useState(arrive);
  return (
    <Tag className={(className || "") + (anim ? " " + EARNED_ANIM : "")} data-earned={anim ? "arrive" : "still"} {...rest}>
      {children}
    </Tag>
  );
}

export default function EarnedText({ as = "span", text, className = "", children, ...rest }) {
  // Armed one frame after the first text has painted.
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setArmed(true));
    return () => cancelAnimationFrame(raf);
  }, []);
  const content = children ?? text;
  const key = typeof text === "string" || typeof text === "number" ? String(text) : String(content ?? "");
  return (
    <Words key={key} as={as} arrive={armed} className={className} {...rest}>
      {content}
    </Words>
  );
}
