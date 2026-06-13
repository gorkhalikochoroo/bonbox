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
import { useLanguage } from "../hooks/useLanguage";
import { usePillars } from "../hooks/usePillars";
import { useUndoToast } from "../hooks/useUndoToast";
import { Icon } from "./ui";
import { PILLAR_DISPLAY } from "../config/navManifest";

export default function PillarDiscovery({ variant = "sidebar", onNavigate }) {
  const { t } = useLanguage();
  const { hiddenPillars, isReady, setPillarHidden } = usePillars();
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

  // Nothing hidden (or state not settled) → no affordance at all.
  if (!isReady || offPillars.length === 0) return null;

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
      setError(e?.response?.data?.detail || t("pillarDiscoveryEnableFailed"));
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
