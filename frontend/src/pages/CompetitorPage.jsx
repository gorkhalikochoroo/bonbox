import { useState, useEffect, useMemo } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn } from "../components/AnimationKit";

function fmt(n) { return n != null ? Math.round(n).toLocaleString() : "\u2014"; }

const PRICE_LABELS = ["", "$", "$$", "$$$", "$$$$"];

export default function CompetitorPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

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

  useEffect(() => { fetchData(); }, []);

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
    if (!confirm("Stop tracking this competitor?")) return;
    try {
      await api.delete(`/competitors/${id}`);
      fetchData();
    } catch { /* silent */ }
  };

  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">🔍</div>
          <p className="text-gray-500 dark:text-gray-400">Loading competitors...</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="p-4 md:p-8 max-w-lg mx-auto text-center">
        <div className="text-4xl mb-4">🔍</div>
        <p className="text-red-500">{error}</p>
        <button onClick={fetchData} className="mt-4 text-sm text-green-600 hover:underline">Try again</button>
      </div>
    );
  }

  const {
    total_competitors, total_price_checks, price_position,
    cheaper_count, pricier_count, competitors, overpriced_items,
    underpriced_items, alerts,
  } = data;

  const positionLabel = { premium: "👑 Premium", budget: "🏷️ Budget", balanced: "⚖️ Balanced" };

  const tabs = [
    { key: "discover", label: "Discover Nearby", icon: "📍" },
    { key: "overview", label: "Overview", icon: "📊" },
    { key: "competitors", label: `Tracked (${total_competitors})`, icon: "🎯" },
  ];

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      <FadeIn>
        <div className="flex items-center justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-2xl font-bold text-gray-800 dark:text-white">
              🔍 {t("competitorScan") || "Competitor Scan"}
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5">
              Discover nearby businesses, track competitors & compare prices
            </p>
          </div>
          <button onClick={() => setShowManual(!showManual)}
            className="px-4 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-200 rounded-xl text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition">
            + Add Manually
          </button>
        </div>
      </FadeIn>

      {/* ─── MANUAL ADD (collapsible) ─── */}
      {showManual && (
        <form onSubmit={handleAddManual} className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm space-y-3 border border-gray-100 dark:border-gray-700">
          <h3 className="font-bold text-gray-700 dark:text-gray-200 text-sm">Add Competitor Manually</h3>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
            <input value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="Business name *"
              className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" required />
            <input value={newAddress} onChange={(e) => setNewAddress(e.target.value)} placeholder="Address (optional)"
              className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
            <input value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="Type (cafe, restaurant...)"
              className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
          </div>
          <div className="flex gap-2">
            <button type="submit" className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium">Save</button>
            <button type="button" onClick={() => setShowManual(false)} className="px-4 py-2 bg-gray-200 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm">Cancel</button>
          </div>
        </form>
      )}

      {/* ─── ALERTS ─── */}
      {alerts?.length > 0 && tab !== "discover" && (
        <div className="space-y-3">
          {alerts.map((alert, i) => (
            <div key={i} className={`p-4 rounded-2xl border-l-4 ${
              alert.severity === "warning" ? "border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20" :
              alert.severity === "positive" ? "border-green-500 bg-green-50 dark:bg-green-900/20" :
              "border-blue-500 bg-blue-50 dark:bg-blue-900/20"
            }`}>
              <div className="flex items-start gap-3">
                <span className="text-2xl">{alert.icon}</span>
                <div className="flex-1">
                  <p className="text-sm font-bold text-gray-800 dark:text-gray-200">{alert.title}</p>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{alert.detail}</p>
                  {alert.action && (
                    <p className="text-xs text-green-700 dark:text-green-400 mt-2 font-medium">💡 {alert.action}</p>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ─── KEY METRICS ─── */}
      {total_competitors > 0 && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <MetricCard label="Tracked" value={total_competitors} color="text-blue-600" />
          <MetricCard label="Price Checks" value={total_price_checks} color="text-purple-600" />
          <MetricCard label="Position" value={positionLabel[price_position] || "—"} color="text-gray-700 dark:text-gray-200" />
          <MetricCard label="We're Cheaper" value={cheaper_count} sub={`Higher: ${pricier_count}`} color="text-green-600" />
        </div>
      )}

      {/* ─── TABS ─── */}
      <div className="flex gap-1 bg-gray-100 dark:bg-gray-800 rounded-xl p-1">
        {tabs.map((tb) => (
          <button key={tb.key} onClick={() => setTab(tb.key)}
            className={`flex-1 py-2.5 rounded-lg text-sm font-medium transition ${
              tab === tb.key ? "bg-white dark:bg-gray-700 shadow text-gray-900 dark:text-white"
                : "text-gray-500 dark:text-gray-400 hover:text-gray-700"
            }`}>
            {tb.icon} {tb.label}
          </button>
        ))}
      </div>

      {/* ═══ DISCOVER TAB ═══ */}
      {tab === "discover" && (
        <div className="space-y-4">
          {/* Search bar */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border border-gray-100 dark:border-gray-700">
            <h3 className="font-bold text-gray-800 dark:text-white mb-3 flex items-center gap-2">
              📍 Find Nearby Competitors
            </h3>
            <div className="flex flex-wrap gap-3 items-end">
              <div className="flex-1 min-w-[200px]">
                <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">Search keyword (optional)</label>
                <input type="text" value={searchKeyword} onChange={e => setSearchKeyword(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && handleDiscover()}
                  placeholder="e.g. pizza, sushi, coffee..."
                  className="w-full px-3 py-2.5 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-xl text-sm" />
              </div>
              <div className="w-32">
                <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">Radius</label>
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
                className="px-6 py-2.5 bg-green-600 text-white rounded-xl text-sm font-bold hover:bg-green-700 transition disabled:opacity-50 flex items-center gap-1.5">
                {discoverLoading ? (
                  <><span className="animate-spin inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full" /> Scanning...</>
                ) : (
                  <>🔍 Discover</>
                )}
              </button>
            </div>
            {!user?.latitude && (
              <p className="text-xs text-amber-600 dark:text-amber-400 mt-3">
                ⚠️ Set your business location in <a href="/profile" className="underline font-medium">Profile</a> to discover nearby competitors.
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
                  Found <span className="font-bold text-gray-700 dark:text-gray-200">{places.length}</span> businesses nearby
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
              <p className="text-lg font-medium">Discover your competitors</p>
              <p className="text-sm mt-1">Click "Discover" to scan for businesses near your location.</p>
            </div>
          )}
        </div>
      )}

      {/* ═══ OVERVIEW TAB ═══ */}
      {tab === "overview" && (
        <div className="space-y-6">
          {overpriced_items?.length > 0 && (
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border-l-4 border-yellow-500">
              <h2 className="font-bold text-gray-800 dark:text-white mb-3">📈 We're Priced Higher</h2>
              <div className="space-y-2">
                {overpriced_items.map((p, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 bg-yellow-50 dark:bg-yellow-900/10 rounded-xl px-3 sm:px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{p.item}</p>
                      <p className="text-xs text-gray-500">vs {p.competitor}</p>
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
            <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border-l-4 border-green-500">
              <h2 className="font-bold text-gray-800 dark:text-white mb-3">💡 Room to Raise Prices</h2>
              <div className="space-y-2">
                {underpriced_items.map((p, i) => (
                  <div key={i} className="flex items-center justify-between gap-3 bg-green-50 dark:bg-green-900/10 rounded-xl px-3 sm:px-4 py-3">
                    <div className="min-w-0">
                      <p className="text-sm font-medium text-gray-800 dark:text-gray-200 truncate">{p.item}</p>
                      <p className="text-xs text-gray-500">vs {p.competitor}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-green-600">{p.diff_pct}%</p>
                      <p className="text-[10px] sm:text-xs text-gray-400">{fmt(p.our_price)} vs {fmt(p.their_price)}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Price check form */}
          {competitors?.length > 0 && (
            <form onSubmit={handlePriceCheck} className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm space-y-3 border border-gray-100 dark:border-gray-700">
              <h2 className="font-bold text-gray-800 dark:text-white">📋 Log Price Check</h2>
              <p className="text-xs text-gray-500 dark:text-gray-400">Visit a competitor, check their menu, and log prices here.</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <select value={priceCompId} onChange={(e) => setPriceCompId(e.target.value)}
                  className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" required>
                  <option value="">Select competitor</option>
                  {competitors.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
                <input value={priceItem} onChange={(e) => setPriceItem(e.target.value)} placeholder="Item name (e.g. Latte, Burger)"
                  className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" required />
                <input type="number" step="0.01" value={theirPrice} onChange={(e) => setTheirPrice(e.target.value)}
                  placeholder={`Their price (${currency})`} className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" required />
                <input type="number" step="0.01" value={ourPrice} onChange={(e) => setOurPrice(e.target.value)}
                  placeholder={`Our price (${currency}, optional)`} className="px-3 py-2 rounded-lg border dark:border-gray-600 dark:bg-gray-700 dark:text-white text-sm" />
              </div>
              <button type="submit" className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700">Log Price Check</button>
            </form>
          )}

          {total_competitors === 0 && (
            <div className="text-center py-12 text-gray-400">
              <p className="text-4xl mb-3">📊</p>
              <p className="text-lg font-medium">No data yet</p>
              <p className="text-sm mt-1">
                Go to <button onClick={() => setTab("discover")} className="text-green-600 underline font-medium">Discover</button> to find and track competitors first.
              </p>
            </div>
          )}
        </div>
      )}

      {/* ═══ TRACKED COMPETITORS TAB ═══ */}
      {tab === "competitors" && (
        <div className="space-y-4">
          {competitors?.length > 0 ? competitors.map((comp) => (
            <div key={comp.id} className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm border border-gray-100 dark:border-gray-700">
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
                      <span className="text-xs bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-2 py-0.5 rounded-full">
                        {PRICE_LABELS[comp.price_level] || ""}
                      </span>
                    )}
                  </div>
                  {comp.address && <p className="text-xs text-gray-500 mt-1">📍 {comp.address}</p>}
                </div>
                <button onClick={() => handleDelete(comp.id)} className="text-xs text-red-500 hover:underline flex-shrink-0 ml-2">Remove</button>
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
                            p.position === "we_are_lower" ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" :
                            p.position === "we_are_higher" ? "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300" :
                            "bg-gray-100 text-gray-500"
                          }`}>
                            {p.position === "we_are_lower" ? `${p.diff_pct}%` : p.position === "we_are_higher" ? `+${p.diff_pct}%` : "Same"}
                          </span>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-gray-400 italic">No price checks yet — visit their menu and log prices in Overview tab.</p>
              )}
            </div>
          )) : (
            <div className="text-center py-12 text-gray-400">
              <p className="text-5xl mb-3">🎯</p>
              <p className="text-lg font-medium">No competitors tracked</p>
              <p className="text-sm mt-1">
                Go to <button onClick={() => setTab("discover")} className="text-green-600 underline font-medium">Discover</button> to find businesses near you.
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   PLACE CARD — discovered nearby business
   ═══════════════════════════════════════════════════════════ */
function PlaceCard({ place, onTrack, isAdding }) {
  const p = place;
  const distLabel = p.distance_m != null
    ? p.distance_m < 1000 ? `${p.distance_m}m` : `${(p.distance_m / 1000).toFixed(1)}km`
    : null;

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm border border-gray-100 dark:border-gray-700 flex flex-col">
      <div className="flex items-start gap-3 flex-1">
        {/* Icon / Category */}
        <div className="w-10 h-10 rounded-xl bg-green-50 dark:bg-green-900/30 flex items-center justify-center flex-shrink-0 text-lg">
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
                p.open_now ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300" : "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300"
              }`}>
                {p.open_now ? "Open" : "Closed"}
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
          <span className="text-xs text-green-600 dark:text-green-400 font-medium flex items-center gap-1">
            ✅ Already tracking
          </span>
        ) : (
          <button onClick={onTrack} disabled={isAdding}
            className="w-full py-2 bg-green-600 text-white rounded-lg text-xs font-bold hover:bg-green-700 transition disabled:opacity-50">
            {isAdding ? "Adding..." : "🎯 Track Competitor"}
          </button>
        )}
      </div>
    </div>
  );
}


/* ═══════════════════════════════════════════════════════════
   METRIC CARD
   ═══════════════════════════════════════════════════════════ */
function MetricCard({ label, value, sub, color }) {
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl p-4 shadow-sm text-center border border-gray-100 dark:border-gray-700">
      <p className="text-xs text-gray-500 dark:text-gray-400">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${color}`}>{value}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  );
}
