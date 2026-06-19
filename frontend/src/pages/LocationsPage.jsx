/**
 * LocationsPage — C12 Bucket B (Locations tab-merge).
 *
 * Before this, the Settings group carried THREE sidebar rows for the same
 * multi-location job: Filialer (/branches), Filialsammenligning (/outlets) and
 * Samlet lukning (/consolidated-close). This thin wrapper collapses them into a
 * SINGLE destination (/branches) with a TabPills switcher (Filialer ·
 * Sammenligning · Konsolideret). The three underlying pages are UNCHANGED and
 * still mounted — we just render the chosen one beneath the tab row.
 *
 * The legacy /outlets and /consolidated-close routes stay registered (App.jsx)
 * but now <Navigate replace> here with the matching ?tab, so old bookmarks,
 * deep links, and ⌘K all land correctly.
 *
 * SINGLE-LOCATION EMPTY STATE (mandatory): the Sammenligning + Konsolideret
 * tabs only make sense with 2+ branches. An owner with 0/1 branch who taps
 * those tabs gets a calm, design-system-compliant "this is for multiple
 * locations" message instead of a broken/empty grid. Branch count comes from
 * the shared BranchProvider (useBranch), which the whole authenticated app is
 * wrapped in — no extra fetch, no flicker once the provider has loaded.
 *
 * Layout note: mirrors ImportsPage exactly — every child page brings its own
 * gutters / PageHeader, so this wrapper adds no PageShell (would double the
 * gutters). The tab row renders in a matching-gutter strip above the child;
 * only one child mounts at a time.
 *
 * The active tab is reflected in the URL (?tab=branches|compare|consolidated).
 */
import { useSearchParams } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import { useBranch } from "../components/BranchSelector";
import { TabPills, Icon } from "../components/ui";
import BranchPage from "./BranchPage";
import OutletPage from "./OutletPage";
import ConsolidatedClosePage from "./ConsolidatedClosePage";

const VALID_TABS = ["branches", "compare", "consolidated"];

/**
 * MultiLocationEmptyState — the friendly "you only have one location" panel
 * shown on the Sammenligning / Konsolideret tabs when the owner has 0/1 branch.
 * gray-900 primary, rounded-xl, Lucide outline icon, no rainbow — matches the
 * locked design system. Points the owner back to the Filialer tab to add one.
 */
function MultiLocationEmptyState({ onAddLocation }) {
  const { t } = useLanguage();
  return (
    <div className="px-4 sm:px-6 py-10">
      <div className="max-w-md mx-auto text-center">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-xl bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 mb-4">
          <Icon name="Building2" size={22} />
        </div>
        <h2 className="text-base font-semibold text-gray-900 dark:text-white">
          {t("locMultiOnlyTitle")}
        </h2>
        <p className="mt-2 text-sm text-gray-500 dark:text-gray-400 leading-relaxed">
          {t("locMultiOnlyBody")}
        </p>
        <button
          type="button"
          onClick={onAddLocation}
          className="mt-5 inline-flex items-center gap-2 rounded-xl bg-gray-900 dark:bg-white px-4 py-2.5 text-sm font-medium text-white dark:text-gray-900 hover:bg-gray-800 dark:hover:bg-gray-100 transition-colors"
        >
          <Icon name="Building2" size={16} />
          {t("locMultiOnlyCta")}
        </button>
      </div>
    </div>
  );
}

export default function LocationsPage() {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const { branches } = useBranch();

  const raw = searchParams.get("tab");
  const activeTab = VALID_TABS.includes(raw) ? raw : "branches";

  // 0 or 1 location = single-location owner. The compare / consolidated views
  // need 2+ branches to have anything to say, so they get the empty state.
  const isSingleLocation = (branches?.length || 0) <= 1;

  const setTab = (id) => {
    // Replace (not push) so the tab switch doesn't pile up history entries —
    // the back button should leave Locations, not step through its tabs.
    setSearchParams({ tab: id }, { replace: true });
  };

  const tabs = [
    { id: "branches", label: t("branches") },         // Filialer
    { id: "compare", label: t("crossOutlet") },       // Sammenligning
    { id: "consolidated", label: t("consolidatedClose") }, // Konsolideret
  ];

  // For the multi-location tabs on a single-location account, route the CTA
  // back to the Filialer tab (where adding a branch lives).
  const goToBranches = () => setTab("branches");

  const renderBody = () => {
    if (activeTab === "branches") return <BranchPage />;
    if (isSingleLocation) {
      return <MultiLocationEmptyState onAddLocation={goToBranches} />;
    }
    if (activeTab === "compare") return <OutletPage />;
    return <ConsolidatedClosePage />;
  };

  return (
    <div>
      {/* Tab row — matches the child pages' top gutters (px-4 sm:px-6). */}
      <div className="px-4 sm:px-6 pt-4 sm:pt-6">
        <div className="max-w-5xl mx-auto">
          <TabPills
            tabs={tabs}
            activeId={activeTab}
            onChange={setTab}
            ariaLabel={t("locations")}
          />
        </div>
      </div>
      {renderBody()}
    </div>
  );
}
