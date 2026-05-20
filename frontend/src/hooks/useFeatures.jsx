/**
 * useFeatures — public feature-flag hook (task #106).
 *
 * Fetches /api/config/features ONCE per app load and exposes the
 * booleans to any component that wants to conditionally render an
 * integration-dependent tile.  Today's flags:
 *
 *   bank_connect_enabled  — true if a real PSD2 provider (GoCardless
 *                           / Salt Edge / Aiia live) is configured on
 *                           the backend.  False until env vars set.
 *   mobilepay_enabled     — true if MobilePay sandbox/live with creds.
 *
 * Why a separate hook (not folded into useAuth):
 *   • The endpoint is public — no auth, no DB hit — so it loads
 *     before the user signs in.  Hooking it into useAuth would couple
 *     it to a logged-in session.
 *   • Lets unauthenticated routes (landing, login) honor the same
 *     flags later if we want to hide "bank-on-autopilot" pitch when
 *     it's not really wired up.
 *
 * Defaults: while the request is in flight OR if it fails, ALL flags
 * default to FALSE.  This is fail-closed — hidden is the safe
 * default for honest UX.  When the backend responds we update the
 * cached object.  No retries: the endpoint is cheap and the failure
 * mode is the same as "feature off" anyway.
 *
 * Multi-layer note: this hook ONLY drives UI render.  Every /init
 * endpoint also gates server-side, so a curious user can't bypass
 * the hidden card by hitting the API.
 */
import { createContext, useContext, useEffect, useState } from "react";
import api from "../services/api";

const FeaturesContext = createContext(null);

const DEFAULT_FLAGS = {
  bank_connect_enabled: false,
  mobilepay_enabled: false,
  // Marker so consumers can tell "we haven't heard back yet" from
  // "the backend said no".  Most callers just check the booleans.
  _loaded: false,
};

export function FeaturesProvider({ children }) {
  const [flags, setFlags] = useState(DEFAULT_FLAGS);

  useEffect(() => {
    let cancelled = false;
    // _noRetry: this is a boot-time probe.  If the backend's cold we'd
    // rather show "feature off" than block the SPA on retry storms.
    api.get("/config/features", { _noRetry: true })
      .then((res) => {
        if (cancelled) return;
        setFlags({ ...DEFAULT_FLAGS, ...res.data, _loaded: true });
      })
      .catch(() => {
        // Fail-closed: hidden UI is the honest default.  Don't surface
        // an error — this is best-effort.
        if (cancelled) return;
        setFlags({ ...DEFAULT_FLAGS, _loaded: true });
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <FeaturesContext.Provider value={flags}>
      {children}
    </FeaturesContext.Provider>
  );
}

export function useFeatures() {
  const ctx = useContext(FeaturesContext);
  // If a component renders outside the Provider (shouldn't happen, but
  // be forgiving), return the safe default.
  return ctx || DEFAULT_FLAGS;
}
