/**
 * useFounderRateStatus — shared fetch hook for the public, rate-limited
 * /api/public/founder-rate-status endpoint.
 *
 * Three consumer sites today (Task #89 P2-2, P3-9):
 *   • LandingPage hero — FounderRatePill component
 *   • LandingPage pricing card — small "29 / 100 seats taken" stripe
 *   • SubscriptionPage hero — "X spots left" chip
 *
 * Centralising the fetch keeps the three sites in lockstep so the
 * count on the marketing page and the count on the in-app pricing
 * page can never drift, and means the defensive fetch semantics live
 * in one place:
 *
 *   • Status starts as `null` (loading) and stays `null` on fetch
 *     failure. Consumers should hide the count entirely on `null` —
 *     a stale fallback ("First 100 customers — 38 spots left" when
 *     reality is "sold out") would damage trust harder than
 *     rendering nothing at all.
 *   • The endpoint is public + rate-limited so this is safe to call
 *     even for unauthenticated visitors landing on /subscription
 *     directly.
 *   • Unmount safety: the in-flight promise checks `alive` before
 *     setting state.
 *
 * The hook returns whatever the backend returns, so consumers can
 * read `claimed / max_slots / available / locked` without an extra
 * shape-bridging layer. A second derived value `valid` answers the
 * single question every consumer asks: "is this safe to render?".
 */
import { useEffect, useState } from "react";
import api from "../services/api";

export function useFounderRateStatus() {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    let alive = true;
    api
      .get("/public/founder-rate-status")
      .then((r) => alive && setStatus(r?.data || null))
      .catch(() => alive && setStatus(null));
    return () => {
      alive = false;
    };
  }, []);

  // Coherent-response guard. The backend contract is:
  //   { claimed: number, max_slots: number, available: number, locked: boolean }
  // Reject anything that doesn't have the three numeric fields so a
  // partial / future-shape response can't crash a card.
  const valid =
    !!status &&
    typeof status.claimed === "number" &&
    typeof status.max_slots === "number" &&
    typeof status.available === "number";

  return { status, valid };
}

export default useFounderRateStatus;
