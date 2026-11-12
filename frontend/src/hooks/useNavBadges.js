import { useEffect, useState } from "react";
import { navBadges } from "../components/today/todayModel";

/**
 * useNavBadges(enabled) — the I dag rail's and tab bar's ACTIONABLE counts:
 * bookings waiting for the owner's answer, draft shifts this week nobody can
 * see, a missing kasserapport. One small owner-only read (GET
 * /api/today?part=badges), refreshed on the freshness bus, on return to the
 * tab and every five minutes. Anything else — a non-owner, an older backend,
 * a failed read — means no badges, never a guessed one.
 *
 * Returns { [route]: { count, tone } }.
 */
const EVERY_MS = 5 * 60 * 1000;

export function useNavBadges(enabled) {
  const [badges, setBadges] = useState({});
  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    const load = () => {
      import("../services/api").then(({ default: api }) =>
        api.get("/today", { params: { part: "badges" } })
          .then((res) => { if (!cancelled) setBadges(navBadges(res?.data?.badges)); })
          // A failed read is "could not check", not "nothing to do": keep the
          // last answer (none on a first failure) rather than invent zeros.
          .catch(() => {}),
      );
    };
    load();
    const onData = () => load();
    const onVis = () => { if (document.visibilityState === "visible") load(); };
    window.addEventListener("bonbox-data-changed", onData);
    document.addEventListener("visibilitychange", onVis);
    const timer = setInterval(() => { if (document.visibilityState === "visible") load(); }, EVERY_MS);
    return () => {
      cancelled = true;
      window.removeEventListener("bonbox-data-changed", onData);
      document.removeEventListener("visibilitychange", onVis);
      clearInterval(timer);
    };
  }, [enabled]);
  return enabled ? badges : NONE;
}
const NONE = Object.freeze({});
