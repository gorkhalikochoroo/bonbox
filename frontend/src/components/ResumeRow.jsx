/**
 * ResumeRow — the "Fortsæt" / Resume affordance.
 *
 * A quiet, one-tap "pick up where you left off" cluster pinned to the TOP of
 * the desktop sidebar (under the brand/search, ABOVE the nav groups). It shows
 * up to 2 of the owner's genuinely-recent OTHER destinations — resolved to
 * their manifest icon + label — each a one-tap link straight back into the
 * page they were on. This is zero-friction, auto-computed value: nothing to
 * pin, nothing to configure.
 *
 * HONESTY INVARIANTS (a violation FAILS the feature — see useRouteHistory):
 *   • REAL visits only. The candidate list comes purely from route history
 *     (useRouteHistory); nothing is predicted or "suggested".
 *   • NO qualifying history → render NOTHING. New owners, or an owner whose
 *     only history is the current page, see no eyebrow, no placeholder, no
 *     fake suggestion. The component returns null.
 *   • Chronological recency ONLY. Order is exactly the history order (newest
 *     first); we never rerank.
 *   • VISIBILITY/TIER respect. Candidates are resolved against the SAME
 *     filterDestinations the sidebar uses (business-type, module, pillar
 *     relevance, tier) for THIS owner — so we never deep-link into a page the
 *     owner can't currently reach. A tier-locked entry (kept visible-but-locked
 *     in the sidebar) is deliberately EXCLUDED from Resume: resuming should
 *     drop the owner back into a working page, not an upsell wall.
 *
 * DESIGN
 *   Mirrors PillarDiscovery's quiet register: a tiny muted "Fortsæt" eyebrow +
 *   compact rows in the sidebar nav-item visual language, but clearly its own
 *   cluster (a hairline divider below it separates it from the nav groups).
 *   gray-900 primary, Lucide outline icons, rounded-lg, no color, no gradient.
 */
import { useMemo } from "react";
import { NavLink } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import { usePillars } from "../hooks/usePillars";
import { useBranch } from "./BranchSelector";
import { useRouteHistory } from "../hooks/useRouteHistory";
import { NAV_MANIFEST, filterDestinations } from "../config/navManifest";
import { archetypeIdFor } from "../config/archetypes";
import { useAuth } from "../hooks/useAuth";
import { Icon } from "./ui";

// How many recent destinations to surface. Intentionally small — this is an
// ambient affordance, not a second nav.
const SHOW = 2;

export default function ResumeRow({ enabledModules, onNavigate }) {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { history } = useRouteHistory();
  const { branchType, businessTypes } = useBranch();
  const { hasFeature, isReady: entReady } = useEntitlements();
  // RELEVANCE axis — an OFF pillar's destinations must NOT be resumable (they
  // aren't reachable from the sidebar), so we DO pass hiddenPillars here (the
  // opposite of ⌘K, which keeps OFF pillars findable as enable-actions).
  const { hiddenPillars } = usePillars();

  // Accountant-view never participates: a revisor gets the read-only nav and an
  // empty hiddenPillars/entitlements shape upstream. Resume is an owner-only
  // convenience, so hide it for accountant sessions entirely.
  const isAccountant = (user?.role || "").toLowerCase() === "accountant";

  // The owner's CURRENTLY-REACHABLE destinations, resolved exactly like the
  // sidebar: same three visibility axes + tier. We then look up each history
  // path in this map, which guarantees we only ever resume to a page the owner
  // can reach right now. Locked (tier) entries are dropped (see below).
  const reachableByPath = useMemo(() => {
    const activeTypes = branchType ? [branchType] : (businessTypes || []);
    // Resume can resume to ANY owner destination, not just sidebar ones, so we
    // resolve against the full manifest (a page reached via ⌘K / More is still
    // a legitimate "pick up where you left off" target). Visibility still
    // applies — filterDestinations enforces business-type / module / pillar.
    const resolved = filterDestinations(NAV_MANIFEST, {
      businessTypes: activeTypes,
      enabledModules: enabledModules instanceof Set ? enabledModules : new Set(),
      hasFeature,
      featReady: entReady !== false,
      hiddenPillars: hiddenPillars instanceof Set ? hiddenPillars : new Set(),
      archetypeId: archetypeIdFor(branchType || user?.business_type),
    });
    const map = new Map();
    for (const d of resolved) {
      // Tier-locked entries stay visible-but-locked in the sidebar, but
      // resuming into a locked page would dump the owner on an upgrade wall —
      // not "where they left off". Exclude them from Resume.
      if (d.locked) continue;
      map.set(d.to, d);
    }
    return map;
  }, [branchType, businessTypes, enabledModules, hasFeature, entReady, hiddenPillars, user?.business_type]);

  // Resolve the recency-ordered history into displayable destinations, keeping
  // only currently-reachable ones, preserving history order, capped at SHOW.
  const items = useMemo(() => {
    if (isAccountant) return [];
    const out = [];
    for (const path of history) {
      const dest = reachableByPath.get(path);
      if (!dest) continue; // not reachable for this owner right now → skip
      out.push(dest);
      if (out.length >= SHOW) break;
    }
    return out;
  }, [history, reachableByPath, isAccountant]);

  // HONESTY: no qualifying history → render NOTHING. No empty state.
  if (items.length === 0) return null;

  return (
    <div className="px-3 pt-1 pb-2 mb-1 border-b border-gray-100 dark:border-gray-700">
      <p className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 flex items-center gap-1.5">
        <Icon name="Clock" size={12} className="shrink-0 opacity-70" />
        <span>{t("resumeEyebrow")}</span>
      </p>
      <div className="space-y-0.5">
        {items.map((d) => (
          <NavLink
            key={d.to}
            to={d.to}
            onClick={onNavigate}
            title={`${t("resumeEyebrow")} — ${t(d.labelKey)}`}
            className="w-full flex items-center gap-2.5 px-3 py-1.5 rounded-lg text-[13px] font-medium transition
              text-gray-600 dark:text-gray-300
              hover:bg-gray-50 dark:hover:bg-gray-700/50 hover:text-gray-900 dark:hover:text-white"
          >
            <Icon name={d.icon} size={16} strokeWidth={1.75} className="shrink-0" />
            <span className="flex-1 truncate text-left">{t(d.labelKey)}</span>
          </NavLink>
        ))}
      </div>
    </div>
  );
}
