import { useEffect, useState } from "react";

/**
 * Date.now(), refreshed every minute ON the wall clock's minute (reservations
 * v2 fix round, 12 Nov 2026). A plain 60 s interval ticks from whenever the
 * page opened, so the door screen's clock and the rows' "late" words could
 * run up to 59 s behind the host's own watch.
 *
 * The minute interval starts at once, as it always did (the stand's tests
 * drive it), and at the next start of a minute it is replaced by one lined
 * up with the clock. When the screen wakes (an iPad that slept through a few
 * minutes) the time is read at once and lined up again.
 */
export default function useMinuteNow() {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const tick = () => setNow(Date.now());
    let iv = setInterval(tick, 60000);
    let to = null;
    const align = () => {
      clearTimeout(to);
      // A hair past the minute, so the tick lands inside the new one.
      to = setTimeout(() => {
        clearInterval(iv);
        tick();
        iv = setInterval(tick, 60000);
      }, 60000 - (Date.now() % 60000) + 25);
    };
    align();
    const onVisible = () => {
      if (document.visibilityState !== "visible") return;
      tick();
      align();
    };
    const doc = typeof document !== "undefined" ? document : null;
    doc?.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(iv);
      clearTimeout(to);
      doc?.removeEventListener("visibilitychange", onVisible);
    };
  }, []);
  return now;
}
