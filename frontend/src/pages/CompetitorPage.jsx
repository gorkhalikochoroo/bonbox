// Task #120 polish (Agent E): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { useState, useEffect, useMemo } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useConfirm } from "../hooks/useConfirm";
import { displayCurrency } from "../utils/currency";
import { errText } from "../utils/errText";
import { FadeIn } from "../components/AnimationKit";
import { UpgradeNudge, PageHeader, StatCard, SectionBanner, TabPills, Button } from "../components/ui";

function fmt(n) { return n != null ? Math.round(n).toLocaleString() : "\u2014"; }

const PRICE_LABELS = ["", "$", "$$", "$$$", "$$$$"];

// `embedded` (C6 InsightsHub) — when true this page renders as a TAB BODY
// inside InsightsHubPage (the "Priser & marked" tab): it drops its own
// page chrome (outer gutters + PageHeader) and surfaces the header's
// "+ Add Manually" action as a compact inline button instead, so the hub
// owns the shell without losing the action.
export default function CompetitorPage({ embedded = false }) {
  const { user } = useAuth();
  const { t } = useLanguage();
  const confirm = useConfirm();
  const currency = displayCurrency(user?.currency);
  const wrapCls = embedded ? "space-y-6" : "p-4 md:p-8 space-y-6 max-w-5xl mx-auto";

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [tab, setTab] = useState("discover"); // discover | overview | competitors

  // Discover state
  const [places, setPlaces] = useState([]);
  const [discoverLoading, setDiscoverLoading] = useState(false);
  const [discoverSource, setDiscoverSource] = useState("");
  const [discoverError, setDiscoverError] = useState("");
  const [searchKeyword, setSearchKeyword] = useState("");
  const [radius, setRadius] = useState(1500);
  const [addingId, setAddingId] = useState(null);

  // Manual add
  const [showManual, setShowManual] = useState(false);
  const [newName, setNewName] = useState("");
  const [newAddress, setNewAddress] = useState("");
  const [newCategory, setNewCategory] = useState("");

  // Price check form
  const [priceCompId, setPriceCompId] = useState("");
  const [priceItem, setPriceItem] = useState("");
  const [theirPrice, setTheirPrice] = useState("");
  const [ourPrice, setOurPrice] = useState("");

  // Suggested items — chips above the price form. Pulled from the user's
  // own inventory (with prices for autofill) + vertical defaults so a
  // brand-new tenant isn't staring at an empty form.
  const [suggestedItems, setSuggestedItems] = useState([]);

  // Same-cuisine market — "how many other Nepali restaurants are near me"
  // Auto-loads on mount; falls back gracefully if user hasn't set cuisine
  // or hasn't shared location yet (the card shows a CTA instead).
  const [cuisineMarket, setCuisineMarket] = useState(null);
  const [cuisineLoading, setCuisineLoading] = useState(false);

  useEffect(() => { fetchData(); }, []);
  useEffect(() => {
    // Load suggestions in parallel; failure is silent (empty array
    // → form just shows manual entry, which is the old behavior).
    api.get("/competitors/suggested-items")
      .then(r => setSuggestedItems(r.data?.items || []))
      .catch(() => setSuggestedItems([]));
    // Same-cuisine market — parallel fetch, silent failure
    setCuisineLoading(true);
    api.get("/competitors/cuisine-market", { params: { radius: 3000 } })
      .then(r => setCuisineMarket(r.data))
      .catch(() => setCuisineMarket(null))
      .finally(() => setCuisineLoading(false));
  }, []);

  const fetchData = async () => {
    setLoading(true);
    try {
      const res = await api.get("/competitors/insights");
      setData(res.data);
      // If user has competitors, default to overview tab
      if (res.data.total_competitors > 0 && tab === "discover") setTab("overview");
    } catch { setError("Could not load competitor data"); }
    setLoading(false);
  };

  const handleDiscover = async () => {
    setDiscoverLoading(true);
    setDiscoverError("");
    try {
      const params = { radius };
      if (searchKeyword.trim()) params.keyword = searchKeyword.trim();
      const res = await api.get("/competitors/discover", { params });
      setPlaces(res.data.places || []);
      setDiscoverSource(res.data.source || "");
      if (res.data.error) setDiscoverError(res.data.error);
    } catch {
      setDiscoverError("Failed to discover nearby businesses");
    }
    setDiscoverLoading(false);
  };

  const handleTrackPlace = async (place) => {
    setAddingId(place.place_id);
    try {
      await api.post("/competitors/add-from-place", {
        place_id: place.place_id,
        name: place.name,
        address: place.address,
        category: place.category,
        google_rating: place.google_rating,
        price_level: place.price_level,
        latitude: place.latitude,
        longitude: place.longitude,
        photo_ref: place.photo_ref,
        total_ratings: place.total_ratings,
      });
      // Update tracked status in discover list
      setPlaces(prev => prev.map(p =>
        p.place_id === place.place_id ? { ...p, already_tracked: true } : p
      ));
      fetchData();
    } catch (err) {
      const msg = err.response?.data?.detail || err.response?.data?.error || err.message || "Failed to track";
      alert(`Could not track: ${msg}`);
    }
    setAddingId(null);
  };

  const handleAddManual = async (e) => {
    e.preventDefault();
    if (!newName.trim()) return;
    try {
      await api.post("/competitors/add", { name: newName.trim(), address: newAddress.trim() || null, category: newCategory.trim() || null });
      setNewName(""); setNewAddress(""); setNewCategory(""); setShowManual(false);
      fetchData();
    } catch { /* silent */ }
  };

  const handlePriceCheck = async (e) => {
    e.preventDefault();
    if (!priceCompId || !priceItem.trim() || !theirPrice) return;
    try {
      await api.post("/competitors/price-check", {
        competitor_id: priceCompId,
        item_name: priceItem.trim(),
        their_price: parseFloat(theirPrice),
        our_price: ourPrice ? parseFloat(ourPrice) : null,
      });
      setPriceItem(""); setTheirPrice(""); setOurPrice("");
      fetchData();
    } catch { /* silent */ }
  };

  const handleDelete = async (id) => {
    if (!(await confirm({ message: "Stop tracking this competitor?", destructive: true }))) return;
    try {
      await api.delete(`/competitors/${id}`);
      fetchData();
    } catch { /* silent */ }
  };

  // ═════ Menu-scan modal state ══════════════════════════════════════
  // The user clicks "📷 Scan menu" on a competitor card → modal opens
  // with two options: pick from Google photos (if available) or upload
  // a fresh phone snap. Either way → Claude vision extracts items →
  // user reviews extracted rows → bulk-import to price checks.
  const [scanCompId, setScanCompId] = useState(null);
  // UpgradeNudge state — AI menu scan is Pro+. Free/Starter users
  // tapping the scan button get the modal closed + the Pro nudge.
  const [upgradeNudge, setUpgradeNudge] = useState(null);
  const [scanStep, setScanStep] = useState("choose"); // choose | extracting | review
  const [googlePhotos, setGooglePhotos] = useState([]);
  const [googlePhotosLoading, setGooglePhotosLoading] = useState(false);
  const [extractedItems, setExtractedItems] = useState([]);
  const [scanConfidence, setScanConfidence] = useState(null);
  const [scanNote, setScanNote] = useState(null);
  const [scanError, setScanError] = useState("");
  const [bulkSaving, setBulkSaving] = useState(false);

  const openScanModal = async (competitorId) => {
    setScanCompId(competitorId);
    setScanStep("choose");
    setExtractedItems([]);
    setScanError("");
    setScanConfidence(null);
    setScanNote(null);
    setGooglePhotosLoading(true);
    try {
      const r = await api.get(`/competitors/${competitorId}/photos`);
      setGooglePhotos(r.data?.photos || []);
    } catch {
      setGooglePhotos([]);
    }
    setGooglePhotosLoading(false);
  };

  const closeScanModal = () => {
    setScanCompId(null);
    setScanStep("choose");
    setExtractedItems([]);
    setGooglePhotos([]);
    setScanError("");
  };

  const scanFromUpload = async (file) => {
    if (!file || !scanCompId) return;
    setScanStep("extracting");
    setScanError("");
    const form = new FormData();
    form.append("photo", file);
    try {
      const r = await api.post(
        `/competitors/${scanCompId}/scan-menu`,
        form,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      const items = (r.data?.items || []).map((it) => ({
        ...it,
        include: true, // pre-checked so user just hits "Add all"
        our_price: it.our_price ?? "",
      }));
      setExtractedItems(items);
      setScanConfidence(r.data?.confidence || null);
      setScanNote(r.data?.note || null);
      if (items.length === 0) {
        setScanError(r.data?.error || "No menu items found. Try a clearer photo.");
      }
      setScanStep("review");
    } catch (e) {
      // 402 plan_required → close the scan modal entirely and surface
      // the UpgradeNudge dialog. Free/Starter user trying Pro feature.
      if (e?.response?.status === 402 &&
          e.response?.data?.detail?.code === "plan_required" &&
          e.response?.data?.detail?.feature === "ai_menu_scan") {
        closeScanModal();
        setUpgradeNudge({
          tier: e.response.data.detail.required_plan || "pro",
          benefit: t("nudgeMenuScan", "Read competitor prices from a photo — 30 items in 10 seconds"),
          icon: "📷",
        });
        return;
      }
      const detail = e.response?.data?.detail;
      setScanError(detail?.message || (typeof detail === "string" ? detail : "Extraction failed. Try again."));
      setScanStep("choose");
    }
  };

  const scanFromGooglePhoto = async (photoRef) => {
    if (!scanCompId) return;
    setScanStep("extracting");
    setScanError("");
    try {
      const r = await api.post(
        `/competitors/${scanCompId}/scan-menu-from-ref`,
        { photo_reference: photoRef },
      );
      const items = (r.data?.items || []).map((it) => ({
        ...it,
        include: true,
        our_price: it.our_price ?? "",
      }));
      setExtractedItems(items);
      setScanConfidence(r.data?.confidence || null);
      setScanNote(r.data?.note || null);
      if (items.length === 0) {
        setScanError(r.data?.error || "No menu items found in this photo.");
      }
      setScanStep("review");
    } catch (e) {
      if (e?.response?.status === 402 &&
          e.response?.data?.detail?.code === "plan_required" &&
          e.response?.data?.detail?.feature === "ai_menu_scan") {
        closeScanModal();
        setUpgradeNudge({
          tier: e.response.data.detail.required_plan || "pro",
          benefit: t("nudgeMenuScan", "Read competitor prices from a photo — 30 items in 10 seconds"),
          icon: "📷",
        });
        return;
      }
      const detail = e.response?.data?.detail;
      setScanError(detail?.message || (typeof detail === "string" ? detail : "Extraction failed."));
      setScanStep("choose");
    }
  };

  const importExtractedItems = async () => {
    const toImport = extractedItems.filter((it) => it.include && it.name && it.price > 0);
    if (toImport.length === 0) return;
    setBulkSaving(true);
    try {
      const r = await api.post("/competitors/price-check/bulk", {
        competitor_id: scanCompId,
        items: toImport.map((it) => ({
          item_name: it.name,
          their_price: parseFloat(it.price),
          our_price: it.our_price !== "" && it.our_price != null ? parseFloat(it.our_price) : null,
        })),
      });
      const inserted = r.data?.inserted || 0;
      closeScanModal();
      await fetchData();
      // Use a non-blocking toast-style message via window.alert for now
      alert(`✓ ${inserted} price check${inserted === 1 ? "" : "s"} added.`);
    } catch (e) {
      setScanError(errText(e, "Couldn't import. Try again."));
    }
    setBulkSaving(false);
  };

  if (loading) {
    return (
      <div className={`${embedded ? "" : "p-4 md:p-8"} flex items-center justify-center min-h-[400px]`}>
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">🔍</div>
          <p className="text-gray-500 dark:text-gray-400">{t("cpLoadingCompetitors", "Loading competitors...")}</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className={`${embedded ? "" : "p-4 md:p-8"} max-w-lg mx-auto text-center`}>
        <div className="text-4xl mb-4">🔍</div>
        <p className="text-red-500">{error}</p>
        <Button variant="secondary" onClick={fetchData} className="mt-4">
          {t("tryAgain")}
        </Button>
      </div>
    );
  }

  const {
    total_competitors, total_price_checks, price_position,
    cheaper_count, pricier_count, competitors, overpriced_items,
    underpriced_items, alerts,
  } = data;

  const positionLabel = {
    premium: `👑 ${t("cpPositionPremium", "Premium")}`,
    budget: `🏷️ ${t("cpPositionBudget", "Budget")}`,
    balanced: `⚖️ ${t("cpPositionBalanced", "Balanced")}`,
  };

  const tabs = [
    { key: "discover", label: t("cpTabDiscoverNearby", "Discover Nearby"), icon: "📍" },
    { key: "overview", label: t("cpTabOverview", "Overview"), icon: "📊" },
    { key: "competitors", label: `${t("cpTabTracked", "Tracked")} (${total_competitors})`, icon: "🎯" },
  ];

  return (
    <div className={wrapCls}>
      {/* Header — suppressed when embedded; the hub tab owns the chrome.
          The "+ Add Manually" action is re-surfaced inline below so it
          isn't lost when the PageHeader's actions slot goes away. */}
      {embedded ? (
        <div className="flex justify-end">
          <Button variant="secondary" onClick={() => setShowManual(!showManual)}>
            {t("cpAddManually", "+ Add Manually")}
          </Button>
        </div>
      ) : (
        <FadeIn>
          <PageHeader
            eyebrow={t("cpEyebrowIntel", "INTEL")}
            title={t("competitorScan") || "Competitor Scan"}
            subtitle={t("competitorSubtitle") || "Discover nearby businesses, track competitors & compare prices."}
            actions={
              <Button variant="secondary" onClick={() => setShowManual(!showManual)}>
                {t("cpAddManually", "+ Add Manually")}
              </Button>
            }
          />
        </FadeIn>
      )}

      {/* ─── MANUAL ADD (collapsible) ─── */}
      {showManual && (
        <form onSubmit={handleAddManual} className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm space-y-3 border border-gray-100 dark:border-gray-700">
          <h3 className="font-bold text-gray-700 dark:text-gray-200 text-sm">{t("addCompetitorManually")}</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={t("businessNameRequired")}
              className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" required />
            <input value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder={t("addressOptionalPlaceholder")}
              className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
            <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder={t("competitorTypePlaceholder")}
              className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium">{t("save")}</button>
            <button type="button" onClick={() => setShowManual(false)} className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm">{t("cancel")}</button>
          </div>
        </form>
      )}

      {/* ─── ALERTS ─── */}
      {alerts?.length > 0 && tab !== "discover" && (
        <div className="space-y-3">
          {alerts.map((alert, i) => {
            const severity = alert.severity === "warning" ? "warn"
              : alert.severity === "positive" ? "success"
              : "info";
            return (
              <SectionBanner
                key={i}
                severity={severity}
                title={alert.title}
              >
                <p>{alert.detail}</p>
                {alert.action && (
                  <p className="text-xs mt-2 font-medium">{alert.action}</p>
                )}
              </SectionBanner>
            );
          })}
        </div>
      )}

      {/* ─── KEY METRICS ─── */}
      {total_competitors > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <StatCard label={t("cpStatTracked", "Tracked")} value={total_competitors} />
          <StatCard label={t("cpStatPriceChecks", "Price Checks")} value={total_price_checks} />
          <StatCard label={t("cpStatPosition", "Position")} value={positionLabel[price_position] || "—"} />
          <StatCard
            label={t("cpStatWereCheaper", "We're Cheaper")}
            value={cheaper_count}
            helper={`${t("cpStatHigher", "Higher")}: ${pricier_count}`}
            accent={cheaper_count > pricier_count ? "success" : "neutral"}
          />
        </div>
      )}

      {/* ─── TABS ─── */}
      <TabPills
        tabs={tabs.map(tb => ({
          id: tb.key,
          label: tb.label.replace(/\s*\(\d+\)$/, ""),
          count: tb.key === "competitors" ? total_competitors : undefined,
        }))}
        activeId={tab}
        onChange={setTab}
        wrap={false}
      />

      {/* ═══ DISCOVER TAB ═══ */}
      {tab === "discover" && (
        <div className="space-y-4">
          {/* Same-cuisine market — actionable competitive intel before
              the user even searches. Surfaces three states:
                1. needs_setup → CTA to set cuisine in Profile
                2. needs_location → CTA to set lat/lon
                3. has data → big number + scrollable competitor list
                              with one-click "Track" per row */}
          {cuisineLoading ? (
            <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-100 dark:border-gray-700">
              <p className="text-sm text-gray-400 animate-pulse">🔍 {t("cuisineMarketLoading", "Scanning your local market…")}</p>
            </div>
          ) : cuisineMarket?.needs_setup ? (
            <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-5 border border-gray-100 dark:border-gray-800">
              <h3 className="font-bold text-gray-900 dark:text-gray-100 mb-1">
                🍽️ {t("cuisineMarketSetupTitle", "Tell us what you serve")}
              </h3>
              <p className="text-sm text-gray-700 dark:text-gray-300 mb-3">
                {cuisineMarket.message || t("cuisineMarketSetupBody",
                  "Set your cuisine in Profile and we'll show you how many places nearby serve the same thing — and let you track them in one click.")}
              </p>
              <a
                href="/profile"
                className="inline-block px-4 py-2 bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white text-sm font-semibold rounded-lg"
              >
                {t("setCuisineCTA", "Set my cuisine →")}
              </a>
            </div>
          ) : cuisineMarket?.needs_location ? (
            <div className="bg-amber-50 dark:bg-amber-900/20 rounded-xl p-5 border border-amber-200 dark:border-amber-800">
              <h3 className="font-bold text-amber-900 dark:text-amber-100 mb-1">
                📍 {t("locationNeededTitle", "Set your location first")}
              </h3>
              <p className="text-sm text-amber-700 dark:text-amber-300 mb-2">
                {cuisineMarket.message}
              </p>
              <a href="/profile" className="text-sm font-semibold text-amber-800 underline">{t("openProfile", "Open Profile →")}</a>
            </div>
          ) : cuisineMarket && cuisineMarket.cuisine ? (
            <div className="bg-gray-50 dark:bg-gray-800/50 rounded-xl p-5 border border-gray-100/60 dark:border-gray-800/60">
              <div className="flex items-start justify-between gap-3 mb-3 flex-wrap">
                <div>
                  <p className="text-xs uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold">
                    {t("cuisineMarketLabel", "Same cuisine within {km} km").replace("{km}", String((cuisineMarket.radius_m || 3000) / 1000))}
                  </p>
                  <h3 className="font-bold text-xl text-gray-800 dark:text-white mt-0.5">
                    <span className="text-emerald-600 dark:text-emerald-400">{cuisineMarket.count}</span>{" "}
                    {cuisineMarket.count === 1
                      ? t("placeServes", "place serves")
                      : t("placesServe", "places serve")}{" "}
                    <span className="capitalize">{cuisineMarket.cuisine}</span>
                  </h3>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                    {cuisineMarket.count === 0
                      ? t("youreTheOnlyOne", "You're the only one. That's a moat — own it.")
                      : cuisineMarket.count <= 3
                        ? t("lowCompetition", "Low competition. Lots of room to grow.")
                        : cuisineMarket.count <= 8
                          ? t("healthyMarket", "Healthy market — differentiation matters.")
                          : t("crowdedMarket", "Crowded — your niche, pricing, and quality have to be sharp.")}
                  </p>
                </div>
                <a
                  href="/profile"
                  className="text-xs text-gray-700 dark:text-gray-300 underline whitespace-nowrap"
                  title={t("changeCuisine", "Change cuisine")}
                >
                  {t("changeCuisine", "Change cuisine")}
                </a>
              </div>

              {cuisineMarket.places?.length > 0 && (
                <div className="space-y-1.5">
                  {cuisineMarket.places.slice(0, 5).map((p) => (
                    <div
                      key={p.place_id}
                      className="flex items-center gap-2 bg-white/70 dark:bg-gray-800/40 rounded-lg px-3 py-2"
                    >
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="font-semibold text-sm text-gray-800 dark:text-gray-100 truncate">{p.name}</span>
                          {p.google_rating && (
                            <span className="text-[10px] bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 px-1.5 py-0.5 rounded">
                              ⭐ {p.google_rating}
                            </span>
                          )}
                          {p.already_tracked && (
                            <span className="text-[10px] bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-1.5 py-0.5 rounded font-medium">
                              ✓ {t("tracked", "Tracked")}
                            </span>
                          )}
                        </div>
                        {p.address && <p className="text-[11px] text-gray-500 truncate">{p.address}</p>}
                      </div>
                      {p.distance_m != null && (
                        <span className="text-[11px] text-gray-500 whitespace-nowrap">
                          {p.distance_m < 1000 ? `${p.distance_m}m` : `${(p.distance_m / 1000).toFixed(1)}km`}
                        </span>
                      )}
                      {!p.already_tracked && (
                        <button
                          onClick={() => handleTrackPlace(p)}
                          disabled={addingId === p.place_id}
                          className="text-[11px] px-2 py-1 bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white rounded-md font-medium disabled:opacity-50"
                        >
                          {addingId === p.place_id ? "…" : "+ " + t("track", "Track")}
                        </button>
                      )}
                    </div>
                  ))}
                  {cuisineMarket.places.length > 5 && (
                    <p className="text-[11px] text-gray-500 text-center pt-1">
                      {t("andMore", "and {n} more").replace("{n}", String(cuisineMarket.places.length - 5))}
                    </p>
                  )}
                </div>
              )}
            </div>
          ) : null}

          {/* Search bar */}
          <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-100 dark:border-gray-700">
            <h3 className="font-bold text-gray-800 dark:text-white mb-3 flex items-center gap-2">
              📍 {t("cpFindNearbyCompetitors", "Find Nearby Competitors")}
            </h3>
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">{t("cpSearchKeywordOptional", "Search keyword (optional)")}</label>
                <input type="text" value={searchKeyword} onChange={e => setSearchKeyword(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleDiscover()}
                  placeholder={t("cpSearchKeywordPlaceholder", "e.g. pizza, sushi, coffee...")}
                  className="w-full px-3 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl text-sm" />
              </div>
              <div className="w-32">
                <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">{t("radius")}</label>
                <select value={radius} onChange={e => setRadius(Number(e.target.value))}
                  className="w-full px-3 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl text-sm">
                  <option value={500}>500m</option>
                  <option value={1000}>1 km</option>
                  <option value={1500}>1.5 km</option>
                  <option value={3000}>3 km</option>
                  <option value={5000}>5 km</option>
                </select>
              </div>
              <button onClick={handleDiscover} disabled={discoverLoading}
                className="px-6 py-2.5 bg-gray-900 text-white rounded-xl text-sm font-bold hover:bg-gray-700 transition disabled:opacity-50 flex items-center gap-1.5">
                {discoverLoading ? (
                  <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> {t("cpScanning", "Scanning...")}</>
                ) : (
                  <>🔍 {t("cpDiscover", "Discover")}</>
                )}
              </button>
            </div>
            {!user?.latitude && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-3">
                ⚠️ {t("cpSetLocationBefore", "Set your business location in")} <a href="/profile" className="underline font-medium">{t("cpProfileLink", "Profile")}</a> {t("cpSetLocationAfter", "to discover nearby competitors.")}
              </p>
            )}
          </div>

          {/* Error */}
          {discoverError && (
            <div className="bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
              {discoverError}
            </div>
          )}

          {/* Results */}
          {places.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <p className="text-sm text-gray-500 dark:text-gray-400">
                  {t("cpFoundPrefix", "Found")} <span className="font-bold text-gray-700 dark:text-gray-200">{places.length}</span> {t("cpBusinessesNearby", "businesses nearby")}
                  {discoverSource === "google" && <span className="ml-1 text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-600 dark:text-blue-300 px-1.5 py-0.5 rounded">Google Places</span>}
                  {discoverSource === "osm" && <span className="ml-1 text-xs bg-gray-100 dark:bg-gray-700 text-gray-500 px-1.5 py-0.5 rounded">OpenStreetMap</span>}
                </p>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {places.map((place) => (
                  <PlaceCard
                    key={place.place_id}
                    place={place}
                    onTrack={() => handleTrackPlace(place)}
                    isAdding={addingId === place.place_id}
                  />
                ))}
              </div>
            </>
          )}

          {places.length === 0 && !discoverLoading && !discoverError && (
            <div className="text-center py-12 text-gray-400">
              <p className="text-5xl mb-3">📍</p>
              <p className="text-lg font-medium">{t("discoverYourCompetitors")}</p>
              <p className="text-sm mt-1">{t("cpClickDiscoverHint", "Click \"Discover\" to scan for businesses near your location.")}</p>
            </div>
          )}
        </div>
      )}

      {/* ═══ OVERVIEW TAB ═══ */}
      {tab === "overview" && (
        <div className="space-y-6">
          {overpriced_items?.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border-l-4 border-yellow-500">
              <h2 className="font-bold text-gray-800 dark:text-white mb-3">📈 {t("cpWerePricedHigher", "We're Priced Higher")}</h2>
              <div className="space-y-2">
                {overpriced_items.map((p, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 bg-yellow-50 dark:bg-yellow-900/10 rounded-xl px-3 sm:px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{p.item}</p>
                      <p className="text-xs text-gray-500">{t("cpVs", "vs")} {p.competitor}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-red-600">+{p.diff_pct}%</p>
                      <p className="text-[10px] sm:text-xs text-gray-400">{fmt(p.our_price)} vs {fmt(p.their_price)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {underpriced_items?.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border-l-4 border-gray-300">
              <h2 className="font-bold text-gray-800 dark:text-white mb-3">💡 {t("cpRoomToRaisePrices", "Room to Raise Prices")}</h2>
              <div className="space-y-2">
                {underpriced_items.map((p, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 bg-gray-50 dark:bg-gray-800/50 rounded-xl px-3 sm:px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{p.item}</p>
                      <p className="text-xs text-gray-500">{t("cpVs", "vs")} {p.competitor}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-emerald-600">{p.diff_pct}%</p>
                      <p className="text-[10px] sm:text-xs text-gray-400">{fmt(p.our_price)} vs {fmt(p.their_price)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Price check form */}
          {competitors?.length > 0 && (
            <form onSubmit={handlePriceCheck} className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm space-y-3 border border-gray-100 dark:border-gray-700">
              <h2 className="font-bold text-gray-800 dark:text-white">📋 {t("logPriceCheck", "Log Price Check")}</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                {t(
                  "logPriceCheckHint",
                  "Pick a competitor and one of your menu items. We've pre-filled your own price from inventory — just enter what the competitor charges."
                )}
              </p>

              {/* Suggested-item chips — one click to pick what to track */}
              {suggestedItems.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-[11px] uppercase tracking-wide text-gray-500 dark:text-gray-400 font-semibold">
                    {t("suggestedItems", "Suggested items")}
                  </p>
                  <div className="flex flex-wrap gap-1.5">
                    {suggestedItems.map((it) => {
                      const selected = priceItem.trim().toLowerCase() === it.name.toLowerCase();
                      const fromInventory = it.source === "inventory";
                      return (
                        <button
                          key={`${it.source}:${it.name}`}
                          type="button"
                          onClick={() => {
                            setPriceItem(it.name);
                            if (it.our_price != null) setOurPrice(String(it.our_price));
                          }}
                          className={
                            "px-2.5 py-1 rounded-full text-xs font-medium border transition " +
                            (selected
                              ? "bg-gray-900 text-white border-gray-900"
                              : fromInventory
                                ? "bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border-gray-100 dark:border-gray-800 hover:bg-gray-100"
                                : "bg-gray-50 dark:bg-gray-700 text-gray-700 dark:text-gray-200 border-gray-200 dark:border-gray-600 hover:bg-gray-100 dark:hover:bg-gray-600")
                          }
                          title={
                            fromInventory
                              ? (it.our_price != null
                                  ? `${t("yourPrice", "Your price")}: ${it.our_price} ${currency}`
                                  : t("fromYourInventory", "From your inventory"))
                              : t("commonItemForYourType", "Common item for your business type")
                          }
                        >
                          {fromInventory ? "📦 " : ""}{it.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <select value={priceCompId} onChange={(e) => setPriceCompId(e.target.value)}
                  className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" required>
                  <option value="">{t("selectCompetitor")}</option>
                  {competitors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <input value={priceItem} onChange={(e) => setPriceItem(e.target.value)} placeholder={t("itemNamePlaceholder", "Item name (e.g. Latte, Burger)")}
                  className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" required />
                <input type="number" step="0.01" value={theirPrice} onChange={(e) => setTheirPrice(e.target.value)}
                  placeholder={`${t("theirPrice", "Their price")} (${currency})`} className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" required />
                <input type="number" step="0.01" value={ourPrice} onChange={(e) => setOurPrice(e.target.value)}
                  placeholder={`${t("ourPrice", "Our price")} (${currency})`} className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
              </div>
              <button type="submit" className="px-4 py-2 bg-gray-900 text-white rounded-lg text-sm font-medium hover:bg-gray-700">{t("logPriceCheck", "Log Price Check")}</button>
            </form>
          )}

          {total_competitors === 0 && (
            <div className="text-center py-12 text-gray-400">
              <p className="text-4xl mb-3">📊</p>
              <p className="text-lg font-medium">{t("noDataYet")}</p>
              <p className="text-sm mt-1">
                {t("cpGoToPrefix", "Go to")} <button onClick={() => setTab("discover")} className="text-emerald-600 underline font-medium">{t("cpDiscover", "Discover")}</button> {t("cpFindTrackFirst", "to find and track competitors first.")}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ═══ TRACKED COMPETITORS TAB ═══ */}
      {tab === "competitors" && (
        <div className="space-y-4">
          {competitors?.length > 0 ? competitors.map((comp) => (
            <div key={comp.id} className="bg-white dark:bg-gray-800 rounded-xl p-5 shadow-sm border border-gray-100 dark:border-gray-700">
              <div className="flex items-start justify-between mb-3">
                <div className="flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <p className="text-lg font-bold text-gray-800 dark:text-white">{comp.name}</p>
                    {comp.category && <span className="text-xs bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300 px-2 py-0.5 rounded-full">{comp.category}</span>}
                    {comp.google_rating && (
                      <span className="text-xs bg-yellow-100 dark:bg-yellow-900/30 text-yellow-700 dark:text-yellow-300 px-2 py-0.5 rounded-full flex items-center gap-0.5">
                        ⭐ {comp.google_rating}
                        {comp.total_ratings ? <span className="text-gray-400 ml-0.5">({comp.total_ratings})</span> : null}
                      </span>
                    )}
                    {comp.price_level != null && (
                      <span className="text-xs bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-2 py-0.5 rounded-full">
                        {PRICE_LABELS[comp.price_level] || ""}
                      </span>
                    )}
                  </div>
                  {comp.address && <p className="text-xs text-gray-500 mt-1">📍 {comp.address}</p>}
                </div>
                <div className="flex flex-col gap-1 items-end flex-shrink-0 ml-2">
                  <button
                    onClick={() => openScanModal(comp.id)}
                    className="text-xs px-2.5 py-1 rounded-full bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 border border-gray-100 dark:border-gray-800 hover:bg-gray-100 dark:hover:bg-gray-800/50 font-medium"
                    title={t("scanMenuTitle", "Scan their menu — extract items + prices with AI")}
                  >
                    📷 {t("scanMenu", "Scan menu")}
                  </button>
                  <button
                    onClick={() => handleDelete(comp.id)}
                    className="text-xs text-red-500 hover:underline"
                  >
                    {t("remove")}
                  </button>
                </div>
              </div>
              {comp.recent_prices?.length > 0 ? (
                <div className="space-y-1">
                  {comp.recent_prices.map((p, i) => (
                    <div key={i} className="flex items-center justify-between text-sm py-1.5 border-t dark:border-gray-700/50">
                      <span className="text-gray-700 dark:text-gray-300">{p.item}</span>
                      <div className="flex items-center gap-3">
                        <span className="text-gray-500">{fmt(p.their_price)} {currency}</span>
                        {p.our_price && (
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            p.position === "we_are_lower" ? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" :
                            p.position === "we_are_higher" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" :
                            "bg-gray-100 text-gray-500"
                          }`}>
                            {p.position === "we_are_lower" ? `${p.diff_pct}%` : p.position === "we_are_higher" ? `+${p.diff_pct}%` : t("cpSame", "Same")}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-400 italic">{t("cpNoPriceChecksYet", "No price checks yet — visit their menu and log prices in Overview tab.")}</p>
              )}
            </div>
          )) : (
            <div className="text-center py-12 text-gray-400">
              <p className="text-5xl mb-3">🎯</p>
              <p className="text-lg font-medium">{t("noCompetitorsTracked")}</p>
              <p className="text-sm mt-1">
                {t("cpGoToPrefix", "Go to")} <button onClick={() => setTab("discover")} className="text-emerald-600 underline font-medium">{t("cpDiscover", "Discover")}</button> {t("cpFindBusinessesNearYou", "to find businesses near you.")}
              </p>
            </div>
          )}
        </div>
      )}

      {/* ═══ SCAN MENU MODAL ═══ */}
      {scanCompId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50">
          <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm max-w-2xl w-full max-h-[90vh] flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-5 py-4 border-b dark:border-gray-700">
              <div>
                <h3 className="font-bold text-gray-800 dark:text-white">📷 {t("scanMenuTitle2", "Scan competitor menu")}</h3>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {scanStep === "choose" && t("scanMenuStepChoose", "Pick a Google Maps photo or upload your own. AI will extract items + prices.")}
                  {scanStep === "extracting" && t("scanMenuStepExtracting", "Reading the menu…")}
                  {scanStep === "review" && t("scanMenuStepReview", "Review extracted items, then import.")}
                </p>
              </div>
              <button onClick={closeScanModal} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200 text-xl leading-none">×</button>
            </div>

            <div className="flex-1 overflow-y-auto px-5 py-4">
              {scanStep === "choose" && (
                <div className="space-y-4">
                  {googlePhotosLoading ? (
                    <p className="text-sm text-gray-400 text-center py-4">{t("scanMenuLoadingPhotos", "Loading photos from Google Maps…")}</p>
                  ) : googlePhotos.length > 0 ? (
                    <div>
                      <p className="text-xs uppercase tracking-wide text-gray-500 font-semibold mb-2">
                        {t("scanMenuFromGoogle", "From Google Maps")}
                      </p>
                      <div className="grid grid-cols-3 sm:grid-cols-4 gap-2">
                        {googlePhotos.map((p) => (
                          <button
                            key={p.photo_reference}
                            onClick={() => scanFromGooglePhoto(p.photo_reference)}
                            className="aspect-square rounded-lg overflow-hidden border-2 border-transparent hover:border-gray-300 focus:border-gray-300 transition group relative"
                            title={t("scanMenuTapToScan", "Tap to scan this photo")}
                          >
                            <img src={p.view_url} alt="" className="w-full h-full object-cover" loading="lazy" />
                            <div className="absolute inset-0 bg-black/0 group-hover:bg-black/40 transition flex items-center justify-center opacity-0 group-hover:opacity-100">
                              <span className="text-white text-xs font-semibold">📷 {t("scanMenuScan", "Scan")}</span>
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-gray-400 italic text-center py-2">
                      {t("scanMenuNoGooglePhotos", "No Google Maps photos available for this competitor.")}
                    </p>
                  )}

                  <div className="flex items-center gap-2 my-3">
                    <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                    <span className="text-xs text-gray-400 uppercase tracking-wide">{t("or", "or")}</span>
                    <div className="flex-1 h-px bg-gray-200 dark:bg-gray-700" />
                  </div>

                  <label className="block">
                    <span className="block text-xs uppercase tracking-wide text-gray-500 font-semibold mb-2">
                      {t("scanMenuUpload", "Upload your own photo")}
                    </span>
                    <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-6 text-center cursor-pointer hover:border-gray-300 transition">
                      <p className="text-3xl mb-1">📤</p>
                      <p className="text-sm text-gray-600 dark:text-gray-300 font-medium">
                        {t("scanMenuTapToUpload", "Tap to take a photo or pick from gallery")}
                      </p>
                      <p className="text-[11px] text-gray-400 mt-1">{t("scanMenuMaxSize", "Max 10 MB · JPEG, PNG, HEIC")}</p>
                      <input
                        type="file"
                        accept="image/*"
                        capture="environment"
                        className="hidden"
                        onChange={(e) => e.target.files?.[0] && scanFromUpload(e.target.files[0])}
                      />
                    </div>
                  </label>

                  {scanError && (
                    <p className="text-sm text-red-500 text-center mt-2">{scanError}</p>
                  )}
                </div>
              )}

              {scanStep === "extracting" && (
                <div className="text-center py-10">
                  <div className="text-4xl mb-3 animate-pulse">🤖</div>
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{t("scanMenuExtracting", "AI is reading the menu…")}</p>
                  <p className="text-xs text-gray-400 mt-1">{t("scanMenuExtractingHint", "Usually 5–15 seconds")}</p>
                </div>
              )}

              {scanStep === "review" && (
                <div className="space-y-3">
                  {extractedItems.length === 0 ? (
                    <div className="text-center py-8">
                      <p className="text-3xl mb-2">🤔</p>
                      <p className="text-sm text-gray-600 dark:text-gray-300 font-medium">
                        {scanError || t("scanMenuNothingFound", "No menu items found. Try a clearer photo.")}
                      </p>
                      {scanNote && <p className="text-xs text-gray-400 mt-1">{scanNote}</p>}
                      <button onClick={() => setScanStep("choose")} className="mt-4 text-sm text-emerald-600 underline">
                        {t("scanMenuTryAnother", "Try another photo")}
                      </button>
                    </div>
                  ) : (
                    <>
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-gray-500">
                          {t("scanMenuFoundCount", "Found")} <strong>{extractedItems.length}</strong> {t("scanMenuItems", "items")}
                          {scanConfidence && (
                            <span className={
                              "ml-2 px-1.5 py-0.5 rounded text-[10px] font-semibold " +
                              (scanConfidence === "high" ? "bg-gray-100 text-gray-700"
                                : scanConfidence === "medium" ? "bg-amber-100 text-amber-700"
                                : "bg-red-100 text-red-700")
                            }>
                              {scanConfidence}
                            </span>
                          )}
                        </span>
                        <div className="flex gap-2">
                          <button onClick={() => setExtractedItems(items => items.map(i => ({ ...i, include: true })))}
                            className="text-xs text-emerald-600 hover:underline">{t("scanMenuSelectAll", "Select all")}</button>
                          <button onClick={() => setExtractedItems(items => items.map(i => ({ ...i, include: false })))}
                            className="text-xs text-gray-500 hover:underline">{t("scanMenuClear", "Clear")}</button>
                        </div>
                      </div>
                      <div className="border dark:border-gray-700 rounded-lg max-h-[44vh] overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700">
                        {extractedItems.map((it, idx) => (
                          <label key={idx} className="flex items-center gap-2 px-3 py-2 hover:bg-gray-50 dark:hover:bg-gray-700/50 cursor-pointer">
                            <input
                              type="checkbox"
                              checked={it.include}
                              onChange={(e) => setExtractedItems(items => items.map((x, i) => i === idx ? { ...x, include: e.target.checked } : x))}
                              className="accent-emerald-600"
                            />
                            <input
                              type="text"
                              value={it.name}
                              onChange={(e) => setExtractedItems(items => items.map((x, i) => i === idx ? { ...x, name: e.target.value } : x))}
                              className="flex-1 text-sm bg-transparent border-none focus:outline-none focus:ring-0 dark:text-gray-100"
                            />
                            <input
                              type="number"
                              step="0.01"
                              value={it.price}
                              onChange={(e) => setExtractedItems(items => items.map((x, i) => i === idx ? { ...x, price: e.target.value } : x))}
                              className="w-20 text-sm text-right bg-gray-50 dark:bg-gray-900/40 rounded px-2 py-0.5 border border-gray-200 dark:border-gray-600"
                            />
                            <span className="text-xs text-gray-400 w-10">{(it.currency || currency).slice(0, 3)}</span>
                          </label>
                        ))}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>

            {scanStep === "review" && extractedItems.length > 0 && (
              <div className="px-5 py-3 border-t dark:border-gray-700 flex items-center justify-between">
                <button onClick={() => setScanStep("choose")} className="text-sm text-gray-500 hover:underline">
                  ← {t("scanMenuBack", "Back")}
                </button>
                <button
                  onClick={importExtractedItems}
                  disabled={bulkSaving || extractedItems.every((i) => !i.include)}
                  className="px-4 py-2 bg-gray-900 hover:bg-gray-700 text-white dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white rounded-lg text-sm font-semibold disabled:opacity-50"
                >
                  {bulkSaving
                    ? t("scanMenuSaving", "Saving…")
                    : t("scanMenuImport", "Import") + " " + extractedItems.filter((i) => i.include).length + " " + t("scanMenuItems", "items")}
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Upgrade nudge — Free/Starter user tried AI menu scan (Pro+).
          They can still manually log price checks via the form below
          the competitor cards. */}
      {upgradeNudge && (
        <UpgradeNudge
          intent="dialog"
          tier={upgradeNudge.tier}
          benefit={upgradeNudge.benefit}
          icon={upgradeNudge.icon}
          ctaLabel={t("nudgeSeePlans", "See plans")}
          onTry={() => setUpgradeNudge(null)}
        />
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   PLACE CARD — discovered nearby business
   ═══════════════════════════════════════════════════════════ */
function PlaceCard({ place, onTrack, isAdding }) {
  const { t } = useLanguage();
  const p = place;
  const distLabel = p.distance_m != null
    ? p.distance_m < 1000 ? `${p.distance_m}m` : `${(p.distance_m / 1000).toFixed(1)}km`
    : null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-4 shadow-sm border border-gray-100 dark:border-gray-700 flex flex-col">
      <div className="flex items-start gap-3 flex-1">
        {/* Icon / Category */}
        <div className="w-10 h-10 rounded-xl bg-gray-50 dark:bg-gray-800 flex items-center justify-center flex-shrink-0 text-lg">
          {p.category === "Restaurant" ? "🍽️" :
           p.category === "Cafe" ? "☕" :
           p.category === "Bar" ? "🍺" :
           p.category === "Bakery" ? "🥐" :
           p.category === "Takeaway" ? "🥡" :
           "🏪"}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-baseline gap-2">
            <h3 className="font-bold text-gray-800 dark:text-white text-sm truncate">{p.name}</h3>
            {p.open_now != null && (
              <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                p.open_now ? "bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
              }`}>
                {p.open_now ? t("cpOpen", "Open") : t("cpClosed", "Closed")}
              </span>
            )}
          </div>

          <div className="flex flex-wrap gap-2 mt-1 text-xs text-gray-500 dark:text-gray-400">
            {p.category && <span className="bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 rounded">{p.category}</span>}
            {p.google_rating && (
              <span className="flex items-center gap-0.5">
                ⭐ {p.google_rating}
                {p.total_ratings ? <span className="text-gray-400">({p.total_ratings})</span> : null}
              </span>
            )}
            {p.price_level != null && <span>{PRICE_LABELS[p.price_level]}</span>}
            {distLabel && <span>📍 {distLabel}</span>}
          </div>

          {p.address && (
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-1 truncate">{p.address}</p>
          )}
        </div>
      </div>

      <div className="mt-3 pt-2 border-t dark:border-gray-700">
        {p.already_tracked ? (
          <span className="text-xs text-emerald-600 dark:text-gray-300 font-medium flex items-center gap-1">
            ✅ {t("cpAlreadyTracking", "Already tracking")}
          </span>
        ) : (
          <button onClick={onTrack} disabled={isAdding}
            className="w-full py-2 bg-gray-900 text-white rounded-lg text-xs font-bold hover:bg-gray-700 transition disabled:opacity-50">
            {isAdding ? t("cpAdding", "Adding...") : "🎯 " + t("cpTrackCompetitor", "Track Competitor")}
          </button>
        )}
      </div>
    </div>
  );
}


