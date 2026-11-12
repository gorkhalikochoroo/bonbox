import { useEffect, useState } from "react";
import { navBadges } from "../components/today/todayModel";
import { loadDismissed, skipParamFor, DISMISS_EVENT } from "../components/needsYouRenderers";
import { onWrite } from "../lib/swrCache";

/**
 * useNavBadges(enabled) — the I dag rail's and tab bar's ACTIONABLE counts:
 * bookings waiting for the owner's answer, draft shifts this week nobody can
 * see, a missing kasserapport. One small owner-only read (GET
 * /api/today?part=badges, with the owner's dismissed days as `skip`, the same
 * CSV /diagnostics/needs-you takes). Anything else — a non-owner, an older
 * backend, a failed read — means no badges, never a guessed one.
 *
 * Re-read:
 *   • after ANY answered write (lib/swrCache onWrite) — answering a booking or
 *     publishing the week clears its badge at once, whichever page did it;
 *   • when the owner dismisses a finding ("Skjul" on I dag or the old Home);
 *   • on the freshness bus, on return to the tab, and every five minutes
 *     (a guest's new request arrives without a write from this device).
 * Bursts collapse into one read (a drag on the rota is several writes).
 *
 * Returns { [route]: { count, tone } }.
 */
const EVERY_MS = 5 * 60 * 1000;
const SETTLE_MS = 800;

export function useNavBadges(enabled) {
  const [badges, setBadges] = useState({});
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    let timer = null;
    const load = () => {
      const skip = skipParamFor(loadDismissed());
      const params = skip ? { part: "badges", skip } : { part: "badges" };
      import("../services/api").then(({ default: api }) =>
        api.get("/today", { params })
          .then((res) => { if (!cancelled) setBadges(navBadges(res?.data?.badges)); })
          // A failed read is "could not check", not "nothing to do": keep the
          // last answer (none on a first failure) rather than invent zeros.
          .catch(() => {}),
      );
    };
    const soon = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; if (!cancelled) load(); }, SETTLE_MS);
    };
    load();
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("bonbox-data-changed", soon);
    window.addEventListener(DISMISS_EVENT, soon);
    document.addEventListener("visibilitychange", onVis);
    const off = onWrite(soon);
    const every = setInterval(() => { if (document.visibilityState === "visible") load(); }, EVERY_MS);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      off();
      window.removeEventListener("bonbox-data-changed", soon);
      window.removeEventListener(DISMISS_EVENT, soon);
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(every);
    };
  }, [enabled]);
  return enabled ? badges : NONE;
}
const NONE = Object.freeze({});
