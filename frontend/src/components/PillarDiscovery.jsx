/**
 * PillarDiscovery — the DISCOVERY FLOOR (C10a, architecture_pillar_visibility.md).
 *
 * When an owner turns a pillar OFF, its destinations vanish from the sidebar,
 * the More grid, and (as enable-actions) ⌘K. This component is the always-on
 * SAFETY NET so a hidden pillar is never lost: a calm "Tilføj funktioner"
 * affordance that lists the currently-OFF pillars as muted one-tap "Slå til"
 * tiles. One tap re-enables the pillar (optimistic, via the pillar context)
 * and its nav re-appears immediately.
 *
 * TWO PLACEMENTS, ONE COMPONENT (the `variant` prop):
 *   • variant="sidebar" — pinned at the BOTTOM of the desktop/mobile sidebar
 *     nav (Layout.jsx), above the footer. A compact section: a tiny
 *     "Tilføj funktioner" header + a vertical list of muted pill rows.
 *   • variant="more"    — a section on the More page (MorePage.jsx), styled
 *     to match the other More sections (uppercase header + tile grid).
 *
 * RENDERS NOTHING when no pillar is OFF (the grandfather state for every
 * existing account, and the steady state for an owner who hides nothing) —
 * the affordance only exists to RE-FIND something hidden.
 *
 * SAFETY:
 *   • Accountant-view / logged-out yield an empty hiddenPillars Set upstream
 *     (usePillars no-ops them) → nothing to show → renders null. A revisor
 *     never sees this owner-only control.
 *   • Re-enable is optimistic with rollback (setPillarHidden in usePillars);
 *     a failed PUT restores the hidden state, and we surface a one-line error
 *     + an undo affordance via useUndoToast.
 *   • FREE + uncapped — this is the RELEVANCE axis, never a tier gate. No
 *     lock, no UpgradeNudge, no cap.
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import { usePillars } from "../hooks/usePillars";
import { useActivation } from "../hooks/useActivation";
import { useUndoToast } from "../hooks/useUndoToast";
import { useBranch } from "./BranchSelector";
import { useAuth } from "../hooks/useAuth";
import { Icon } from "./ui";
import {
  PILLAR_DISPLAY,
  relevantPillarsForArchetype,
} from "../config/navManifest";
import { archetypeIdFor } from "../config/archetypes";
import { errText } from "../utils/errText";

// The setup landing route per activation-gateable pillar — where a "Sæt op X"
// tile navigates (the feature's own setup/empty-state page). This does NOT
// toggle hidden_pillars — these pillars were never OFF, only never used.
const ACTIVATION_SETUP_ROUTE = {
  inventory: "/inventory",
  reservations: "/reservations",
  events: "/events",
  staff: "/staff/schedule",
};

export default function PillarDiscovery({ variant = "sidebar", onNavigate }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const { user } = useAuth();
  const { branchType } = useBranch();
  const { hiddenPillars, isReady, setPillarHidden } = usePillars();
  const {
    isActivated,
    isInScope,
    activationEnabled,
    isReady: activationReady,
  } = useActivation();
  const { show: showUndo, ToastUI } = useUndoToast();
  // Track which pillar id is mid-enable so we can show a busy state on its
  // tile without blocking the others.
  const [enablingId, setEnablingId] = useState(null);
  const [error, setError] = useState("");

  // The OFF pillars, in the canonical PILLAR_DISPLAY order. This is exactly
  // "available minus visible": we walk the catalog and keep the ones the
  // owner has hidden. Resilient to `available` not having loaded yet.
  const offPillars = useMemo(
    () => PILLAR_DISPLAY.filter((p) => hiddenPillars.has(p.id)),
    [hiddenPillars],
  );

  // DORMANT-RELEVANT pillars — the ACTIVATION discovery floor. A pillar is a
  // "Sæt op X" candidate when ALL of: the activation gate is live for this
  // account (enabled + in-scope), the pillar is NOT activated (no usage row),
  // it is NOT owner-hidden (that's the "Slå til" path above), and it is
  // RELEVANT to this business type (CONSERVATIVE — an irrelevant pillar never
  // becomes a setup tile). These were NEVER toggled off, so tapping NAVIGATES
  // to the feature's setup/landing; it does NOT touch hidden_pillars.
  const setupPillars = useMemo(() => {
    if (!activationEnabled || !isInScope) return [];
    const relevant = relevantPillarsForArchetype(
      archetypeIdFor(branchType || user?.business_type),
    );
    return PILLAR_DISPLAY.filter(
      (p) =>
        ACTIVATION_SETUP_ROUTE[p.id] &&   // a gateable pillar with a setup route
        relevant.has(p.id) &&             // relevant to this business type
        !hiddenPillars.has(p.id) &&       // not owner-hidden (that's "Slå til")
        !isActivated(p.id),               // dormant (no real usage row)
    );
  }, [activationEnabled, isInScope, branchType, user?.business_type, hiddenPillars, isActivated]);

  // Nothing to surface (neither hidden re-enable tiles nor dormant setup tiles,
  // or state not settled) → no affordance at all. PillarDiscovery renders only
  // when it has something genuinely re-findable to offer.
  if (!isReady || !activationReady) return null;
  if (offPillars.length === 0 && setupPillars.length === 0) return null;

  // Navigate into a dormant pillar's setup/landing. Does NOT toggle
  // hidden_pillars — the pillar was never OFF, just unused. Auto-graduation
  // (and its quiet toast) is handled by Layout when the usage row appears.
  const goSetup = (pillar) => {
    onNavigate?.();
    navigate(ACTIVATION_SETUP_ROUTE[pillar.id]);
  };

  const enable = async (pillar) => {
    setError("");
    setEnablingId(pillar.id);
    try {
      await setPillarHidden(pillar.id, false);
      // Sidebar variant: close the mobile drawer so the owner immediately
      // sees the now-visible nav entry (no-op on desktop / More variant).
      onNavigate?.();
      showUndo({
        message: t("pillarDiscoveryEnabledToast"),
        onUndo: async () => { await setPillarHidden(pillar.id, true); },
      });
    } catch (e) {
      // Coerce to a string — a raw 422 detail-array rendered as a child
      // would throw React #31 and crash the app (see utils/errText).
      setError(errText(e, t("pillarDiscoveryEnableFailed")));
    } finally {
      setEnablingId(null);
    }
  };

  // ─── More-page variant — matches the other More sections ──────────────
  if (variant === "more") {
    return (
      <div className="mb-6">
        <h3 className="text-xs text-gray-400 dark:text-gray-500 font-semibold uppercase tracking-wider mb-2 px-1">
          {t("pillarDiscoveryTitle")}
        </h3>
        <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
          {/* DORMANT-RELEVANT setup tiles — "Sæt op X". Distinct from the
              "Slå til" re-enable tiles below: these pillars were NEVER off,
              just unused, so tapping NAVIGATES to setup (no hidden_pillars
              toggle). The eyebrow makes the affordance unambiguous. */}
          {setupPillars.map((p) => (
            <button
              key={`setup-${p.id}`}
              onClick={() => goSetup(p)}
              aria-label={`${t("activationSetupEyebrow")} — ${t(p.labelKey)}`}
              className="flex flex-col items-center justify-center
                bg-white dark:bg-gray-800 border border-dashed border-gray-300 dark:border-gray-600
                rounded-xl p-3 min-h-[72px] active:scale-95 transition-transform
                hover:border-gray-400 dark:hover:border-gray-500"
            >
              <Icon
                name={p.icon}
                size={20}
                strokeWidth={1.75}
                className="text-gray-500 dark:text-gray-400 mb-1.5"
              />
              <span className="text-[10px] text-gray-400 dark:text-gray-500 leading-none mb-0.5 uppercase tracking-wide font-semibold">
                {t("activationSetupEyebrow")}
              </span>
              <span className="text-[11px] text-gray-500 dark:text-gray-400 text-center leading-tight font-medium">
                {t(p.labelKey)}
              </span>
            </button>
          ))}
          {offPillars.map((p) => (
            <button
              key={p.id}
              onClick={() => enable(p)}
              disabled={enablingId === p.id}
              aria-label={`${t("pillarDiscoveryEnableCta")} — ${t(p.labelKey)}`}
              className="flex flex-col items-center justify-center
                bg-white dark:bg-gray-800 border border-dashed border-gray-300 dark:border-gray-600
                rounded-xl p-3 min-h-[72px] active:scale-95 transition-transform
                hover:border-gray-400 dark:hover:border-gray-500 disabled:opacity-50"
            >
              <Icon
                name={enablingId === p.id ? "Loader" : p.icon}
                size={20}
                strokeWidth={1.75}
                className={`text-gray-500 dark:text-gray-400 mb-1.5 ${enablingId === p.id ? "animate-spin" : ""}`}
              />
              <span className="text-[11px] text-gray-500 dark:text-gray-400 text-center leading-tight font-medium">
                {t(p.labelKey)}
              </span>
            </button>
          ))}
        </div>
        {error && (
          <p className="mt-2 px-1 text-xs text-red-600 dark:text-red-400" role="alert">
            {error}
          </p>
        )}
        {ToastUI}
      </div>
    );
  }

  // ─── Sidebar variant — pinned at the bottom of the nav ────────────────
  // A quiet header + muted dashed-border rows so it reads as "add back",
  // visually distinct from the active nav items above it.
  return (
    <div className="mt-2 pt-2 border-t border-gray-100 dark:border-gray-700">
      <p className="px-3 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 flex items-center gap-1.5">
        <Icon name="Plus" size={12} className="shrink-0 opacity-70" />
        <span>{t("pillarDiscoveryTitle")}</span>
      </p>
      <div className="space-y-0.5">
        {/* DORMANT-RELEVANT setup rows — "Sæt op". A relevant feature the owner
            hasn't used yet; tapping NAVIGATES to its setup/landing (no
            hidden_pillars toggle). The suffix copy distinguishes it from the
            "Slå til" re-enable rows below. */}
        {setupPillars.map((p) => (
          <button
            key={`setup-${p.id}`}
            onClick={() => { goSetup(p); }}
            title={`${t("activationSetupEyebrow")} — ${t(p.labelKey)}`}
            aria-label={`${t("activationSetupEyebrow")} — ${t(p.labelKey)}`}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition
              text-gray-500 dark:text-gray-400
              hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:text-gray-700 dark:hover:text-gray-200"
          >
            <Icon name={p.icon} size={16} strokeWidth={1.75} className="shrink-0" />
            <span className="flex-1 truncate text-left">{t(p.labelKey)}</span>
            <span className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 shrink-0">
              {t("activationSetupEyebrow")}
            </span>
          </button>
        ))}
        {offPillars.map((p) => (
          <button
            key={p.id}
            onClick={() => { enable(p); }}
            disabled={enablingId === p.id}
            title={`${t("pillarDiscoveryEnableCta")} — ${t(p.labelKey)}`}
            aria-label={`${t("pillarDiscoveryEnableCta")} — ${t(p.labelKey)}`}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition
              text-gray-500 dark:text-gray-400
              hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:text-gray-700 dark:hover:text-gray-200
              disabled:opacity-50"
          >
            <Icon
              name={enablingId === p.id ? "Loader" : p.icon}
              size={16}
              strokeWidth={1.75}
              className={`shrink-0 ${enablingId === p.id ? "animate-spin" : ""}`}
            />
            <span className="flex-1 truncate text-left">{t(p.labelKey)}</span>
            <span className="text-[10px] font-semibold text-gray-400 dark:text-gray-500 shrink-0">
              {t("pillarDiscoveryEnableCta")}
            </span>
          </button>
        ))}
      </div>
      {error && (
        <p className="mt-1 px-3 text-[11px] text-red-600 dark:text-red-400" role="alert">
          {error}
        </p>
      )}
      {ToastUI}
    </div>
  );
}
