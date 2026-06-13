/**
 * InsightsHubPage — /insights (C6 Intelligence collapse).
 *
 * The IA declutter (architecture_pillar_visibility.md) merged the six
 * separate Intelligence sidebar entries into ONE "Insights" destination.
 * This hub is the landing page: a single PageHeader + a TabPills switcher
 * that mounts the EXISTING intelligence pages as embedded tab bodies.
 *
 * Tabs (each body lazy-loaded so a visit only downloads the active tab):
 *   • "AI Insights"      → InsightsPage   (the pattern inbox, /patterns)
 *   • "Priser & marked"  → PricingPage + CompetitorPage (price + market)
 *   • "Gæster"           → RetentionPage  (customer churn / loyalty)
 *
 * The tab bodies are the same page components used at their legacy routes —
 * we pass `embedded` so they drop their own page chrome (outer gutters +
 * PageHeader) and let this hub own the shell. No page LOGIC is rewritten;
 * the smallest honest refactor is the `embedded` prop on each.
 *
 * The active tab is reflected in ?tab= so the C7 redirects (/pricing,
 * /retention, /competitors → /insights?tab=…) deep-link straight to the
 * right tab and the tab is shareable / bookmarkable.
 *
 * NOTE: this hub replaces the bare InsightsPage that used to sit at
 * /insights. The Dashboard daily brief is untouched (separate surface).
 */
import { Suspense, lazy, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import { useLanguage } from "../hooks/useLanguage";
import { FadeIn } from "../components/AnimationKit";
import { PageHeader, TabPills } from "../components/ui";

// Lazy tab bodies — only the active tab's chunk downloads. Mirrors App.jsx's
// per-page code-splitting so the hub doesn't pull all four pages up-front.
const InsightsPage = lazy(() => import("./InsightsPage"));
const PricingPage = lazy(() => import("./PricingPage"));
const CompetitorPage = lazy(() => import("./CompetitorPage"));
const RetentionPage = lazy(() => import("./RetentionPage"));

const VALID_TABS = ["ai", "pricing", "guests"];

function TabFallback() {
  return (
    <div className="flex items-center justify-center min-h-[300px]">
      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-gray-900 dark:border-gray-100" />
    </div>
  );
}

export default function InsightsHubPage() {
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();

  // Resolve the active tab from ?tab= (defaults to AI Insights). Anything
  // unrecognized falls back to "ai" so a stale/garbage param can't blank it.
  const raw = searchParams.get("tab");
  const activeTab = VALID_TABS.includes(raw) ? raw : "ai";

  const setTab = (id) => {
    // replace:true — switching tabs shouldn't pile history entries; the
    // browser back button should leave /insights, not cycle tabs.
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", id);
      return next;
    }, { replace: true });
  };

  const tabs = useMemo(
    () => [
      { id: "ai", label: t("insightsTabAi") || "AI Insights" },
      { id: "pricing", label: t("insightsTabPricing") || "Priser & marked" },
      { id: "guests", label: t("insightsTabGuests") || "Gæster" },
    ],
    [t]
  );

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <FadeIn>
        <PageHeader
          eyebrow="INTEL"
          title={t("insightsHubTitle") || "Insights"}
          subtitle={
            t("insightsHubSubtitle") ||
            "AI patterns, pricing & market intelligence, and guest retention — in one place."
          }
        />
      </FadeIn>

      <TabPills tabs={tabs} activeId={activeTab} onChange={setTab} wrap={false} ariaLabel={t("insightsHubTitle") || "Insights"} />

      <Suspense fallback={<TabFallback />}>
        {activeTab === "ai" && <InsightsPage embedded />}
        {activeTab === "pricing" && (
          <div className="space-y-6">
            <PricingPage embedded />
            <CompetitorPage embedded />
          </div>
        )}
        {activeTab === "guests" && <RetentionPage embedded />}
      </Suspense>
    </div>
  );
}
