import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";

const WEATHER_ICONS = {
  clear: "☀️", cloudy: "⛅", rain: "🌧️", drizzle: "🌦️",
  snow: "❄️", storm: "⛈️", fog: "🌫️", unknown: "🌡️",
};

function formatTemp(t) {
  return t != null ? `${Math.round(t)}°C` : "—";
}

export default function WeatherPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);

  const [forecast, setForecast] = useState(null);
  const [insights, setInsights] = useState([]);
  const [impact, setImpact] = useState(null);
  const [seasonal, setSeasonal] = useState(null);
  const [sickCalls, setSickCalls] = useState([]);
  const [sickStats, setSickStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [locationLoading, setLocationLoading] = useState(false);
  const [error, setError] = useState("");
  const [hasLocation, setHasLocation] = useState(false);

  // Sick call form
  const [sickForm, setSickForm] = useState({ staff_name: "", date: new Date().toISOString().split("T")[0], weather_condition: "", notes: "" });
  const [sickSuccess, setSickSuccess] = useState("");

  useEffect(() => {
    // Try fetching forecast — if it fails with 400 "Set your location", we know no location is set
    checkAndFetch();
  }, []);

  const checkAndFetch = async () => {
    setLoading(true);
    try {
      const res = await api.get("/weather/forecast");
      setHasLocation(true);
      setForecast(res.data);
      // Fetch rest in parallel
      const [insightsRes, impactRes, seasonalRes, sickRes, sickStatsRes] = await Promise.allSettled([
        api.get("/weather/insights"),
        api.get("/weather/impact-profile"),
        api.get("/weather/seasonal"),
        api.get("/weather/sick-calls"),
        api.get("/weather/sick-calls/stats"),
      ]);
      if (insightsRes.status === "fulfilled") setInsights(insightsRes.value.data.insights || []);
      if (impactRes.status === "fulfilled") setImpact(impactRes.value.data);
      if (seasonalRes.status === "fulfilled") setSeasonal(seasonalRes.value.data);
      if (sickRes.status === "fulfilled") setSickCalls(sickRes.value.data);
      if (sickStatsRes.status === "fulfilled") setSickStats(sickStatsRes.value.data);
    } catch (e) {
      if (e.response?.status === 400) {
        setHasLocation(false);
      } else {
        setError("Could not load weather data");
      }
    }
    setLoading(false);
  };

  const fetchAll = () => checkAndFetch();

  const saveLocation = async (lat, lon) => {
    setLocationLoading(true);
    try {
      await api.post("/weather/location", { latitude: lat, longitude: lon });
      setHasLocation(true);
      await checkAndFetch();
    } catch (e) {
      setError("Could not save location");
    }
    setLocationLoading(false);
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) { setError("Geolocation not supported"); return; }
    setLocationLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => saveLocation(pos.coords.latitude, pos.coords.longitude),
      () => { setError("Location access denied. Try entering your city."); setLocationLoading(false); }
    );
  };

  const logSickCall = async (e) => {
    e.preventDefault();
    if (!sickForm.staff_name) return;
    try {
      await api.post("/weather/sick-calls", {
        staff_name: sickForm.staff_name,
        date: sickForm.date,
        weather_condition: sickForm.weather_condition || null,
        notes: sickForm.notes || null,
      });
      setSickForm({ staff_name: "", date: new Date().toISOString().split("T")[0], weather_condition: "", notes: "" });
      setSickSuccess("Sick call logged");
      setTimeout(() => setSickSuccess(""), 2000);
      const [res, statsRes] = await Promise.all([api.get("/weather/sick-calls"), api.get("/weather/sick-calls/stats")]);
      setSickCalls(res.data);
      setSickStats(statsRes.data);
    } catch { setError("Could not log sick call"); }
  };

  // ─── LOADING ───
  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">🌤️</div>
          <p className="text-gray-500 dark:text-gray-400">Loading weather insights...</p>
        </div>
      </div>
    );
  }

  // ─── LOCATION SETUP ───
  if (!hasLocation) {
    return (
      <div className="p-4 md:p-8 max-w-lg mx-auto">
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 shadow-lg text-center">
          <div className="text-6xl mb-4">🌦️</div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white mb-2">Weather Smart</h1>
          <p className="text-gray-500 dark:text-gray-400 mb-6">
            Set your business location to get weather-powered insights — know when rain will slow business, plan staff smarter, spot seasonal patterns.
          </p>
          {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
          <button
            onClick={useMyLocation}
            disabled={locationLoading}
            className="w-full bg-green-600 text-white py-3 rounded-xl hover:bg-green-700 transition font-semibold mb-3 disabled:opacity-50"
          >
            {locationLoading ? "Detecting..." : "📍 Use My Current Location"}
          </button>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            We only use your location for weather data. It's stored securely and never shared.
          </p>
        </div>
      </div>
    );
  }

  // ─── MAIN VIEW ───
  const days = forecast?.days || [];
  const current = forecast?.current || null;
  const todayForecast = days[0] || null;

  // Build conditions array from impact object
  const conditionsObj = impact?.conditions || {};
  const conditions = Object.entries(conditionsObj).map(([cond, data]) => ({
    condition: cond,
    average_revenue: data.average_revenue,
    sample_days: data.sample_days,
    multiplier: data.multiplier,
  })).sort((a, b) => b.multiplier - a.multiplier);
  const avgDaily = impact?.average_daily || 0;

  // Build months array from seasonal object
  const monthsObj = seasonal?.months || {};
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    average: monthsObj[i + 1]?.average || 0,
    transactions: monthsObj[i + 1]?.transactions || 0,
  }));
  const hasSeasonalData = months.some(m => m.average > 0);

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">🌦️ Weather Smart</h1>
        <button onClick={fetchAll} className="text-sm text-green-600 dark:text-green-400 hover:underline">Refresh</button>
      </div>

      {/* ─── TODAY'S WEATHER ─── */}
      {(current || todayForecast) && (
        <div className="bg-gradient-to-r from-slate-800 to-slate-900 rounded-2xl p-6 text-white">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-300">Right Now</p>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-5xl">{WEATHER_ICONS[current?.condition || todayForecast?.condition] || "🌡️"}</span>
                <div>
                  <p className="text-3xl font-bold">{current ? formatTemp(current.temperature) : formatTemp(todayForecast?.temp_max)}</p>
                  {current?.feels_like != null && (
                    <p className="text-sm text-gray-400">Feels like {formatTemp(current.feels_like)}</p>
                  )}
                  <p className="text-gray-400 capitalize">{current?.condition || todayForecast?.condition}</p>
                </div>
              </div>
            </div>
            <div className="text-right space-y-1">
              {current?.humidity != null && (
                <>
                  <p className="text-sm text-gray-400">Humidity</p>
                  <p className="text-lg font-semibold">{current.humidity}%</p>
                </>
              )}
              <p className="text-sm text-gray-400">Wind</p>
              <p className="text-lg">{(current?.wind_speed || todayForecast?.wind_speed)?.toFixed(0) || 0} km/h</p>
              {todayForecast && (
                <>
                  <p className="text-sm text-gray-400">High / Low</p>
                  <p className="text-sm">{formatTemp(todayForecast.temp_max)} / {formatTemp(todayForecast.temp_min)}</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ─── 7-DAY FORECAST ─── */}
      {days.length > 1 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">📅 7-Day Outlook</h2>
          <div className="grid grid-cols-7 gap-2 text-center">
            {days.slice(0, 7).map((d, i) => {
              const dayName = new Date(d.date + "T12:00:00").toLocaleDateString("en", { weekday: "short" });
              return (
                <div key={i} className="py-3 rounded-xl bg-gray-50 dark:bg-gray-700/50">
                  <p className="text-xs text-gray-500 dark:text-gray-400">{i === 0 ? "Today" : dayName}</p>
                  <p className="text-2xl my-1">{WEATHER_ICONS[d.condition] || "🌡️"}</p>
                  <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">{formatTemp(d.temp_max)}</p>
                  <p className="text-xs text-gray-400">{formatTemp(d.temp_min)}</p>
                  {d.precipitation > 0 && (
                    <p className="text-[10px] text-blue-500 mt-0.5">{d.precipitation.toFixed(1)}mm</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── SMART INSIGHTS ─── */}
      {insights.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">💡 Smart Insights</h2>
          <div className="space-y-3">
            {insights.map((ins, i) => (
              <div key={i} className={`p-4 rounded-xl border-l-4 ${
                ins.severity === "low" ? "border-green-500 bg-green-50 dark:bg-green-900/20" :
                ins.severity === "medium" ? "border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20" :
                ins.severity === "high" ? "border-red-500 bg-red-50 dark:bg-red-900/20" :
                "border-gray-300 bg-gray-50 dark:bg-gray-700/30"
              }`}>
                <p className="text-sm font-semibold text-gray-800 dark:text-gray-200">{ins.title}</p>
                <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{ins.detail}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ─── WEATHER IMPACT PROFILE ─── */}
      {conditions.length > 0 && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-1">📊 Your Weather Impact Profile</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">How weather affects your revenue based on your sales history</p>
          <div className="space-y-3">
            {conditions.map((c, i) => {
              const pct = Math.round((c.multiplier - 1) * 100);
              const barWidth = Math.min(100, Math.max(10, c.multiplier * 100));
              const color = pct >= 0 ? "bg-green-500" : pct > -15 ? "bg-yellow-500" : "bg-red-500";
              return (
                <div key={i} className="flex items-center gap-3">
                  <span className="text-2xl w-8">{WEATHER_ICONS[c.condition] || "🌡️"}</span>
                  <div className="flex-1">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-sm font-medium capitalize text-gray-700 dark:text-gray-300">{c.condition}</span>
                      <span className={`text-sm font-bold ${pct >= 0 ? "text-green-600" : pct > -15 ? "text-yellow-600" : "text-red-600"}`}>
                        {pct >= 0 ? "+" : ""}{pct}%
                      </span>
                    </div>
                    <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                      <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${barWidth}%` }} />
                    </div>
                    <p className="text-xs text-gray-400 mt-0.5">
                      Avg: {Math.round(c.average_revenue)} {currency} / day  •  {c.sample_days} days analyzed
                    </p>
                  </div>
                </div>
              );
            })}
            {avgDaily > 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400 pt-2 border-t border-gray-100 dark:border-gray-700">
                Overall average: {Math.round(avgDaily)} {currency} / day
              </p>
            )}
          </div>
        </div>
      )}

      {/* ─── SEASONAL PATTERNS ─── */}
      {hasSeasonalData && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">📈 Seasonal Patterns</h2>
          <div className="grid grid-cols-6 md:grid-cols-12 gap-1 text-center">
            {months.map((m, i) => {
              const maxRev = Math.max(...months.map(x => x.average));
              const height = maxRev > 0 ? Math.max(8, (m.average / maxRev) * 80) : 8;
              return (
                <div key={i} className="flex flex-col items-center justify-end" style={{ minHeight: 100 }}>
                  <div
                    className="w-full bg-green-500/80 rounded-t transition-all"
                    style={{ height }}
                    title={`${Math.round(m.average)} ${currency} avg (${m.transactions} sales)`}
                  />
                  <p className="text-[10px] text-gray-500 dark:text-gray-400 mt-1">{MONTH_NAMES[i]}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── SICK CALL TRACKER ─── */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
        <h2 className="font-bold text-gray-800 dark:text-white mb-4">🤒 Sick Call Tracker</h2>

        {/* Stats */}
        {sickStats && (
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-xl text-center">
              <p className="text-2xl font-bold text-red-600">{sickStats.this_month}</p>
              <p className="text-xs text-gray-500">This Month</p>
            </div>
            <div className="bg-yellow-50 dark:bg-yellow-900/20 p-3 rounded-xl text-center">
              <p className="text-2xl font-bold text-yellow-600">{sickStats.last_month}</p>
              <p className="text-xs text-gray-500">Last Month</p>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-xl text-center">
              <p className="text-2xl font-bold text-blue-600">{sickStats.weather_related || 0}</p>
              <p className="text-xs text-gray-500">Weather Days</p>
            </div>
          </div>
        )}

        {/* Add form */}
        <form onSubmit={logSickCall} className="flex flex-wrap gap-2 mb-4">
          <input
            placeholder="Staff name"
            value={sickForm.staff_name}
            onChange={e => setSickForm(f => ({ ...f, staff_name: e.target.value }))}
            className="flex-1 min-w-[120px] px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:text-white"
          />
          <input
            type="date"
            value={sickForm.date}
            onChange={e => setSickForm(f => ({ ...f, date: e.target.value }))}
            className="px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:text-white"
          />
          <select
            value={sickForm.weather_condition}
            onChange={e => setSickForm(f => ({ ...f, weather_condition: e.target.value }))}
            className="px-3 py-2 bg-gray-50 dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:text-white"
          >
            <option value="">Reason...</option>
            <option value="rain">Rain/Weather</option>
            <option value="snow">Snow</option>
            <option value="storm">Storm</option>
            <option value="clear">Sick (good weather)</option>
            <option value="cloudy">Sick (bad weather)</option>
          </select>
          <button type="submit" className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition">
            Log
          </button>
        </form>
        {sickSuccess && <p className="text-green-500 text-sm mb-2">{sickSuccess}</p>}

        {/* Recent list */}
        {sickCalls.length > 0 ? (
          <div className="space-y-2">
            {sickCalls.slice(0, 10).map((sc, i) => (
              <div key={i} className="flex items-center justify-between py-2 border-b border-gray-100 dark:border-gray-700 last:border-0">
                <div>
                  <p className="text-sm font-medium text-gray-700 dark:text-gray-300">{sc.staff_name}</p>
                  <p className="text-xs text-gray-500">{sc.weather_condition || "—"} • {new Date(sc.date).toLocaleDateString()}</p>
                </div>
                {sc.weather_condition && (
                  <span className="text-lg">{WEATHER_ICONS[sc.weather_condition] || ""}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-400 text-center py-4">No sick calls logged yet</p>
        )}
      </div>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 text-red-600 text-sm p-3 rounded-xl text-center">
          {error}
        </div>
      )}
    </div>
  );
}
