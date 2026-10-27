// useDelayedFlag — true only once `flag` has stayed true for `delayMs`.
//
// The public booking page's time grid used to dim the instant a new day or
// party was asked for. Most answers land in about 100 ms, so every tap made
// the grid blink, even when the times that came back were the same (judge
// 24 Oct, frame f95). With this the grid dims only for a slow answer; the
// caller still blocks taps at once (pointer-events) from the raw flag.
//
// It goes false the moment `flag` does — never late in that direction.
import { useEffect, useState } from "react";

export function useDelayedFlag(flag, delayMs = 180) {
  const [late, setLate] = useState(false);
  useEffect(() => {
    if (!flag) return undefined;
    const id = setTimeout(() => setLate(true), delayMs);
    return () => {
      clearTimeout(id);
      setLate(false);
    };
  }, [flag, delayMs]);
  return !!flag && late;
}

export default useDelayedFlag;
