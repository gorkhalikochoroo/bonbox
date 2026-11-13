/**
 * "Hvem målte?" — the 2-minute round.
 *
 * NOTHING is pre-selected: not on the first reading, not after a reload, not
 * after the round ends — never staff[0], never a remembered last name. A name
 * on a food-safety record has to be chosen by the person who measured.
 *
 * After a successful save the chosen name is HELD for 2 minutes from that
 * save (each save restarts the 2 minutes), so a cook going fridge → freezer
 * → hot holding picks once. "Skift" clears it at once. Memory only: a reload
 * starts with no name.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { NAME_ROUND_MS } from "./ekLogic";

export default function useNameRound(ms = NAME_ROUND_MS) {
  const [held, setHeld] = useState(null);
  const timer = useRef(null);

  const stop = () => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const hold = useCallback(
    (who) => {
      stop();
      if (!who) {
        setHeld(null);
        return;
      }
      setHeld(who);
      timer.current = setTimeout(() => {
        timer.current = null;
        setHeld(null);
      }, ms);
    },
    [ms],
  );

  const clear = useCallback(() => {
    stop();
    setHeld(null);
  }, []);

  useEffect(() => () => stop(), []);

  return { held, hold, clear };
}

/** The label a held/chosen name shows: "Ali K." or the typed name. */
export function whoLabel(who) {
  if (!who) return "";
  return who.kind === "typed" ? String(who.name || "").trim() : who.label || "";
}
