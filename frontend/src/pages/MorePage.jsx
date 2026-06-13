import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { useBranch } from "../components/BranchSelector";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { useDarkMode } from "../hooks/useDarkMode";
import { useEntitlements } from "../hooks/useEntitlements";
import { usePillars } from "../hooks/usePillars";
import { useTheme, THEMES } from "../hooks/useTheme";
import Icon from "../components/ui/Icon";
import { NAV_MANIFEST, NAV_GROUPS, filterDestinations } from "../config/navManifest";
import { isNativeApp } from "../utils/platform";

// MorePage is now MANIFEST-DRIVEN (config/navManifest.js) — the same source of
// truth the desktop sidebar (Layout.jsx) and the ⌘K palette read from. Tiles
// are the manifest entries whose `surfaces` includes 'more', grouped by the
// shared NAV_GROUPS order and filtered through filterDestinations() so the
// three visibility axes (business-type, enabled-module, tier-lock) behave
// IDENTICALLY to the sidebar. This kills the historical drift where the More
// grid was missing Events / Faktura / Khata / Customers / Features-&-modules
// and gated wine-list differently than Layout.
//
// Icon names map to the same Lucide tokens via the <Icon> registry, so an
// owner switching between phone and desktop sees the same glyph per route.

// MorePage-only extras the manifest deliberately does NOT own (they aren't
// owner SIDEBAR destinations — Profile lives in the sidebar footer, the
// Feedback page is retired from primary nav but the /feedback route still
// exists as a backstop, so the tile stays here). Appended to the Manage
// section so the mobile grid keeps these handy.
const MORE_EXTRAS = {
  manage: [
    { to: "/profile", icon: "Settings", labelKey: "profile" },
    { to: "/feedback", icon: "MessageCircle", labelKey: "feedback" },
  ],
};

export default function MorePage() {
  const { branchType, businessTypes } = useBranch();
  const { t } = useLanguage();
  const { user, logout } = useAuth();
  const { hasFeature, isReady: entReady } = useEntitlements();
  const { hiddenPillars } = usePillars();
  const [dark, toggleDark] = useDarkMode();
  const [theme, setTheme] = useTheme();
  const navigate = useNavigate();
  const activeTypes = branchType ? [branchType] : businessTypes.length ? businessTypes : ["general"];

  // Owner's enabled vertical modules — drives the wine-list / bar gating so
  // it matches the sidebar exactly. Empty Set until /api/modules resolves
  // (strict default = the gated tiles stay hidden, same as Layout).
  const [enabledModules, setEnabledModules] = useState(() => new Set());
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    import("../services/api").then(({ default: api }) => {
      api.get("/modules")
        .then((res) => {
          if (cancelled) return;
          const enabledIds = (res.data?.modules || [])
            .filter((m) => m.enabled)
            .map((m) => m.id);
          setEnabledModules(new Set(enabledIds));
        })
        .catch(() => { /* silent — strict default */ });
    });
    return () => { cancelled = true; };
  }, [user]);

  const handleLogout = () => {
    logout();
    navigate("/login");
  };

  // Build the grouped tile list from the manifest. For each NAV_GROUPS entry,
  // take the manifest items on the 'more' surface in that group, run them
  // through filterDestinations (resolves locked + hides irrelevant), then
  // append any MorePage-only extras for that group.
  const moreItems = NAV_MANIFEST.filter((d) => d.surfaces.includes("more"));
  const ctx = {
    businessTypes: activeTypes,
    enabledModules,
    hasFeature,
    featReady: entReady !== false,
    // RELEVANCE axis (C9) — OFF pillars' tiles drop from the More grid. Empty
    // Set while loading / logged-out / accountant-view (usePillars no-ops).
    hiddenPillars,
  };

  const visible = NAV_GROUPS
    .filter((g) => !g.visibleFor || g.visibleFor.some((bt) => activeTypes.includes(bt)))
    .map((g) => {
      let items = filterDestinations(moreItems.filter((d) => d.group === g.id), ctx);
      // App Store compliance: drop locked (purchase-surface) tiles on native;
      // web keeps the locked-but-visible upsell. Mirrors Layout.jsx.
      if (isNativeApp()) items = items.filter((it) => !it.locked);
      const extras = MORE_EXTRAS[g.id] || [];
      return {
        id: g.id,
        // Section header: localized group label. The 'core' group is
        // headerless in the sidebar; on the More grid we give it the
        // generic "more" header so its tiles still get a section.
        title: g.labelKey ? t(g.labelKey) : t("more"),
        items: [...items, ...extras],
      };
    })
    .filter((s) => s.items.length > 0);

  return (
    <div className="p-4 pb-24 page-enter">
      <h2 className="text-lg font-bold text-gray-800 dark:text-white mb-4">
        {t("more") || "More"}
      </h2>
      {visible.map((section) => (
        <div key={section.id} className="mb-6">
          <h3 className="text-xs text-gray-400 dark:text-gray-500 font-semibold uppercase tracking-wider mb-2 px-1">
            {section.title}
          </h3>
          <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
            {section.items.map((item) => (
              item.locked ? (
                // Tier-locked tile — visible-but-locked (the UpgradeNudge
                // funnel). Tapping routes to /subscription where the owner
                // sees what their next tier unlocks. Lock icon + dimmed,
                // matching the sidebar's locked treatment.
                <Link
                  key={item.to}
                  to="/subscription"
                  aria-label={`${t("proFeatureUpgrade") || "Pro feature — upgrade to unlock"} (${t(item.labelKey) || item.labelKey})`}
                  className="flex flex-col items-center justify-center
                    bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                    rounded-xl p-3 min-h-[72px] opacity-60 active:scale-95 transition-transform
                    hover:border-gray-300 dark:hover:border-gray-600"
                >
                  <Icon name="Lock" size={20} strokeWidth={1.75} className="text-gray-700 dark:text-gray-300 mb-1.5" />
                  <span className="text-[11px] text-gray-600 dark:text-gray-400 text-center leading-tight font-medium">
                    {t(item.labelKey) || item.labelKey}
                  </span>
                </Link>
              ) : (
                <Link
                  key={item.to}
                  to={item.to}
                  className="flex flex-col items-center justify-center
                    bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                    rounded-xl p-3 min-h-[72px] active:scale-95 transition-transform
                    hover:border-gray-300 dark:hover:border-gray-600"
                >
                  <Icon name={item.icon} size={20} strokeWidth={1.75} className="text-gray-700 dark:text-gray-300 mb-1.5" />
                  <span className="text-[11px] text-gray-600 dark:text-gray-400 text-center leading-tight font-medium">
                    {t(item.labelKey) || item.labelKey}
                  </span>
                </Link>
              )
            ))}
          </div>
        </div>
      ))}

      {/* Theme picker — accent only, doesn't change light/dark mode */}
      <div className="mt-2 mb-2">
        <h3 className="text-xs text-gray-400 dark:text-gray-500 font-semibold uppercase tracking-wider mb-2 px-1">
          {t("appearance") || "Appearance"}
        </h3>
        <div className="grid grid-cols-4 gap-2">
          {THEMES.map((th) => {
            const active = theme === th.id;
            return (
              <button
                key={th.id}
                onClick={() => setTheme(th.id)}
                aria-pressed={active}
                aria-label={`${th.name} theme — ${th.description}`}
                className={`flex flex-col items-center justify-center
                  bg-white dark:bg-gray-800 rounded-xl p-3 min-h-[72px]
                  active:scale-95 transition-transform
                  ${active
                    ? "border-2 border-blue-500 dark:border-blue-400"
                    : "border border-gray-200 dark:border-gray-700"}`}
              >
                <span
                  className="block w-6 h-6 rounded-full mb-1.5 ring-1 ring-black/5 dark:ring-white/10"
                  style={{ backgroundColor: th.swatch }}
                />
                <span className="text-[11px] text-gray-700 dark:text-gray-300 text-center leading-tight font-medium">
                  {th.name}
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Dark mode + Sign out */}
      <div className="mt-4 space-y-2">
        <button
          onClick={toggleDark}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl
            bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
            text-sm text-gray-700 dark:text-gray-300 active:scale-[0.98] transition-transform"
        >
          <Icon name={dark ? "Sun" : "Moon"} size={18} strokeWidth={1.75} className="text-gray-600 dark:text-gray-300" />
          {dark ? t("lightMode") || "Light Mode" : t("darkMode") || "Dark Mode"}
        </button>
        <button
          onClick={handleLogout}
          className="w-full flex items-center gap-3 px-4 py-3 rounded-xl
            bg-white dark:bg-gray-800 border border-red-200 dark:border-red-900/50
            text-sm text-red-500 dark:text-red-400 font-medium active:scale-[0.98] transition-transform"
        >
          <Icon name="LogOut" size={18} strokeWidth={1.75} />
          {t("signOut") || "Sign Out"}
        </button>
      </div>
    </div>
  );
}
