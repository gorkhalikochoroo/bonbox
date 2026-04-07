import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { formatDate, formatDateShort } from "../utils/dateFormat";
import { FadeIn } from "../components/AnimationKit";

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

  // Intelligence state
  const [intelStatus, setIntelStatus] = useState(null);
  const [prediction, setPrediction] = useState(null);
  const [correlation, setCorrelation] = useState(null);
  const [alerts, setAlerts] = useState([]);
  const [syncing, setSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  // Sick call form
  const [sickForm, setSickForm] = useState({ staff_name: "", date: new Date().toISOString().split("T")[0], weather_condition: "", notes: "" });
  const [sickSuccess, setSickSuccess] = useState("");

  // Active tab for intelligence section
  const [intelTab, setIntelTab] = useState("predictions");

  useEffect(() => {
    checkAndFetch();
  }, []);

  const checkAndFetch = async () => {
    setLoading(true);
    setError("");
    const [forecastRes, insightsRes, impactRes, seasonalRes, sickRes, sickStatsRes, statusRes, predRes, corrRes, alertsRes] = await Promise.allSettled([
      api.get("/weather/forecast"),
      api.get("/weather/insights"),
      api.get("/weather/impact-profile"),
      api.get("/weather/seasonal"),
      api.get("/weather/sick-calls"),
      api.get("/weather/sick-calls/stats"),
      api.get("/weather/intelligence-status"),
      api.get("/weather/prediction"),
      api.get("/weather/correlation"),
      api.get("/weather/alerts"),
    ]);

    if (forecastRes.status === "rejected" && forecastRes.reason?.response?.status === 400) {
      setHasLocation(false);
      setLoading(false);
      return;
    }

    setHasLocation(true);

    if (forecastRes.status === "fulfilled") setForecast(forecastRes.value.data);
    else setError(t("weatherForecastUnavailable"));

    if (insightsRes.status === "fulfilled") setInsights(insightsRes.value.data.insights || []);
    if (impactRes.status === "fulfilled") setImpact(impactRes.value.data);
    if (seasonalRes.status === "fulfilled") setSeasonal(seasonalRes.value.data);
    if (sickRes.status === "fulfilled") setSickCalls(sickRes.value.data);
    if (sickStatsRes.status === "fulfilled") setSickStats(sickStatsRes.value.data);

    // Intelligence endpoints
    if (statusRes.status === "fulfilled") setIntelStatus(statusRes.value.data);
    if (predRes.status === "fulfilled") setPrediction(predRes.value.data);
    if (corrRes.status === "fulfilled") setCorrelation(corrRes.value.data);
    if (alertsRes.status === "fulfilled") setAlerts(alertsRes.value.data.alerts || []);

    setLoading(false);
  };

  const fetchAll = () => checkAndFetch();

  const syncWeather = async () => {
    setSyncing(true);
    setSyncResult(null);
    try {
      const res = await api.post("/weather/sync");
      setSyncResult(res.data);
      // Refresh intelligence data
      const [predRes, corrRes, alertsRes, statusRes] = await Promise.allSettled([
        api.get("/weather/prediction"),
        api.get("/weather/correlation"),
        api.get("/weather/alerts"),
        api.get("/weather/intelligence-status"),
      ]);
      if (predRes.status === "fulfilled") setPrediction(predRes.value.data);
      if (corrRes.status === "fulfilled") setCorrelation(corrRes.value.data);
      if (alertsRes.status === "fulfilled") setAlerts(alertsRes.value.data.alerts || []);
      if (statusRes.status === "fulfilled") setIntelStatus(statusRes.value.data);
    } catch (e) {
      setSyncResult({ error: "Sync failed" });
    }
    setSyncing(false);
  };

  const saveLocation = async (lat, lon) => {
    setLocationLoading(true);
    try {
      await api.post("/weather/location", { latitude: lat, longitude: lon });
      setHasLocation(true);
      await checkAndFetch();
    } catch (e) {
      setError(t("couldNotSaveLocation"));
    }
    setLocationLoading(false);
  };

  const useMyLocation = () => {
    if (!navigator.geolocation) { setError(t("geolocationNotSupported")); return; }
    setLocationLoading(true);
    navigator.geolocation.getCurrentPosition(
      (pos) => saveLocation(pos.coords.latitude, pos.coords.longitude),
      () => { setError(t("locationAccessDenied")); setLocationLoading(false); }
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
      setSickSuccess(t("sickCallLogged"));
      setTimeout(() => setSickSuccess(""), 2000);
      const [res, statsRes] = await Promise.all([api.get("/weather/sick-calls"), api.get("/weather/sick-calls/stats")]);
      setSickCalls(res.data);
      setSickStats(statsRes.data);
    } catch { setError(t("couldNotLogSickCall")); }
  };

  // ─── LOADING ───
  if (loading) {
    return (
      <div className="p-4 md:p-8 flex items-center justify-center min-h-[400px]">
        <div className="text-center">
          <div className="text-4xl mb-3 animate-pulse">🌤️</div>
          <p className="text-gray-500 dark:text-gray-400">{t("loadingWeather")}</p>
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
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white mb-2">{t("weatherSmart")}</h1>
          <p className="text-gray-500 dark:text-gray-400 mb-6">
            {t("weatherLocationDesc")}
          </p>
          {error && <p className="text-red-500 text-sm mb-4">{error}</p>}
          <button
            onClick={useMyLocation}
            disabled={locationLoading}
            className="w-full bg-green-600 text-white py-3 rounded-xl hover:bg-green-700 transition font-semibold mb-3 disabled:opacity-50"
          >
            {locationLoading ? t("detecting") : t("useMyLocation")}
          </button>
          <p className="text-xs text-gray-400 dark:text-gray-500">
            {t("weatherLocationPrivacy")}
          </p>
        </div>
      </div>
    );
  }

  // ─── MAIN VIEW ───
  const days = forecast?.days || [];
  const current = forecast?.current || null;
  const todayForecast = days[0] || null;

  const conditionsObj = impact?.conditions || {};
  const conditions = Object.entries(conditionsObj).map(([cond, data]) => ({
    condition: cond,
    average_revenue: data.average_revenue,
    sample_days: data.sample_days,
    multiplier: data.multiplier,
  })).sort((a, b) => b.multiplier - a.multiplier);
  const avgDaily = impact?.average_daily || 0;

  const monthsObj = seasonal?.months || {};
  const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const months = Array.from({ length: 12 }, (_, i) => ({
    month: i + 1,
    average: monthsObj[i + 1]?.average || 0,
    transactions: monthsObj[i + 1]?.transactions || 0,
  }));
  const hasSeasonalData = months.some(m => m.average > 0);

  // Intelligence data
  const preds = prediction?.predictions || [];
  const corrConditions = correlation?.conditions || {};
  const corrReady = correlation?.ready || false;
  const progressPct = intelStatus?.progress_pct || 0;

  return (
    <div className="p-4 md:p-8 space-y-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <FadeIn><h1 className="text-2xl font-bold text-gray-800 dark:text-white">🧠 {t("weatherSmart")}</h1></FadeIn>
        <button onClick={fetchAll} className="text-sm text-green-600 dark:text-green-400 hover:underline">{t("refresh")}</button>
      </div>

      {/* ─── INTELLIGENCE ALERTS (Top Priority) ─── */}
      {alerts.length > 0 && (
        <div className="space-y-3">
          {alerts.map((alert, i) => (
            <div key={i} className={`p-4 rounded-2xl border-l-4 ${
              alert.severity === "high" ? "border-red-500 bg-red-50 dark:bg-red-900/20" :
              alert.severity === "medium" ? "border-yellow-500 bg-yellow-50 dark:bg-yellow-900/20" :
              alert.severity === "positive" ? "border-green-500 bg-green-50 dark:bg-green-900/20" :
              alert.severity === "info" ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20" :
              "border-gray-300 bg-gray-50 dark:bg-gray-700/30"
            }`}>
              <div className="flex items-start gap-3">
                <span className="text-2xl">{alert.icon || "💡"}</span>
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

      {/* ─── REVENUE PREDICTIONS (Hero Card) ─── */}
      {preds.length > 0 && prediction?.available && (
        <div className="bg-gradient-to-br from-green-600 to-emerald-700 rounded-2xl p-6 text-white shadow-lg">
          <h2 className="font-bold text-lg mb-4 flex items-center gap-2">
            <span>🔮</span> Revenue Predictions
          </h2>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {preds.map((p, i) => {
              const isUp = p.impact_pct >= 0;
              return (
                <div key={i} className="bg-white/15 backdrop-blur-sm rounded-xl p-4">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-sm font-medium opacity-90">{p.day_label}</span>
                    <span className="text-2xl">{p.emoji}</span>
                  </div>
                  <p className="text-3xl font-bold">{Math.round(p.predicted_revenue)} <span className="text-lg opacity-80">{currency}</span></p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className={`text-sm font-semibold px-2 py-0.5 rounded-full ${isUp ? "bg-green-400/30" : "bg-red-400/30"}`}>
                      {isUp ? "▲" : "▼"} {Math.abs(p.impact_pct)}%
                    </span>
                    <span className="text-xs opacity-70">vs avg {Math.round(p.overall_average)} {currency}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-2 text-xs opacity-70">
                    <span className="capitalize">{p.condition}</span>
                    <span>•</span>
                    <span>{formatTemp(p.temp_max)}</span>
                    {p.rain_mm > 0 && <><span>•</span><span>{p.rain_mm}mm</span></>}
                  </div>
                  <div className="mt-2">
                    <span className={`text-[10px] px-2 py-0.5 rounded-full ${
                      p.confidence === "high" ? "bg-green-400/30" :
                      p.confidence === "medium" ? "bg-yellow-400/30" : "bg-gray-400/30"
                    }`}>
                      {p.confidence === "high" ? "🎯" : p.confidence === "medium" ? "📊" : "🔄"} {p.confidence} confidence ({p.sample_days} days)
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* ─── INTELLIGENCE SYNC & PROGRESS ─── */}
      {intelStatus && !intelStatus.correlation_ready && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-bold text-gray-800 dark:text-white flex items-center gap-2">
              <span>📊</span> Intelligence Progress
            </h2>
            <button
              onClick={syncWeather}
              disabled={syncing}
              className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition disabled:opacity-50"
            >
              {syncing ? "Syncing..." : "⚡ Sync Weather Data"}
            </button>
          </div>
          <div className="mb-2">
            <div className="flex justify-between text-sm mb-1">
              <span className="text-gray-600 dark:text-gray-400">
                {intelStatus.paired_days || 0} / 30 days paired
              </span>
              <span className="text-green-600 font-medium">{progressPct}%</span>
            </div>
            <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
              <div
                className="h-full bg-gradient-to-r from-green-500 to-emerald-400 rounded-full transition-all duration-500"
                style={{ width: `${progressPct}%` }}
              />
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {intelStatus.sales_days || 0} sales days logged • {intelStatus.weather_days || 0} weather days stored
          </p>
          {syncResult && (
            <div className={`mt-3 p-3 rounded-lg text-sm ${syncResult.error ? "bg-red-50 dark:bg-red-900/20 text-red-600" : "bg-green-50 dark:bg-green-900/20 text-green-600"}`}>
              {syncResult.error || `✅ Synced ${syncResult.synced} new days! (${syncResult.skipped} already existed)`}
            </div>
          )}
        </div>
      )}

      {/* Sync button even when ready (for refreshing) */}
      {intelStatus && intelStatus.correlation_ready && (
        <div className="flex items-center justify-between bg-green-50 dark:bg-green-900/20 rounded-xl p-3">
          <div className="flex items-center gap-2 text-sm text-green-700 dark:text-green-400">
            <span>✅</span>
            <span>Intelligence active — {intelStatus.paired_days} days of data</span>
          </div>
          <button
            onClick={syncWeather}
            disabled={syncing}
            className="px-3 py-1.5 text-xs bg-green-600 text-white rounded-lg hover:bg-green-700 transition disabled:opacity-50"
          >
            {syncing ? "..." : "↻ Sync"}
          </button>
        </div>
      )}

      {/* ─── TODAY'S WEATHER ─── */}
      {(current || todayForecast) && (
        <div className="bg-gradient-to-r from-slate-800 to-slate-900 rounded-2xl p-6 text-white">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm text-gray-300">{t("rightNow")}</p>
              <div className="flex items-center gap-3 mt-1">
                <span className="text-5xl">{WEATHER_ICONS[current?.condition || todayForecast?.condition] || "🌡️"}</span>
                <div>
                  <p className="text-3xl font-bold">{current ? formatTemp(current.temperature) : formatTemp(todayForecast?.temp_max)}</p>
                  {current?.feels_like != null && (
                    <p className="text-sm text-gray-400">{t("feelsLike")} {formatTemp(current.feels_like)}</p>
                  )}
                  <p className="text-gray-400 capitalize">{current?.condition || todayForecast?.condition}</p>
                </div>
              </div>
            </div>
            <div className="text-right space-y-1">
              {current?.humidity != null && (
                <>
                  <p className="text-sm text-gray-400">{t("humidity")}</p>
                  <p className="text-lg font-semibold">{current.humidity}%</p>
                </>
              )}
              <p className="text-sm text-gray-400">{t("wind")}</p>
              <p className="text-lg">{(current?.wind_speed || todayForecast?.wind_speed)?.toFixed(0) || 0} km/h</p>
              {todayForecast && (
                <>
                  <p className="text-sm text-gray-400">{t("highLow")}</p>
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
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">{t("sevenDayOutlook")}</h2>
          <div className="grid grid-cols-7 gap-2 text-center">
            {days.slice(0, 7).map((d, i) => {
              const dayName = new Date(d.date + "T12:00:00").toLocaleDateString("en", { weekday: "short" });
              return (
                <div key={i} className="py-3 rounded-xl bg-gray-50 dark:bg-gray-700/50">
                  <p className="text-xs text-gray-500 dark:text-gray-400">{i === 0 ? t("today") : dayName}</p>
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

      {/* ─── WEATHER × REVENUE CORRELATION (Intelligence Tab) ─── */}
      {corrReady && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-lg">🧠</span>
            <h2 className="font-bold text-gray-800 dark:text-white">Weather × Revenue Intelligence</h2>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">
            Based on {correlation.days_collected} days of weather + sales data
          </p>

          {/* Tab switcher */}
          <div className="flex gap-2 mb-4">
            {["conditions", "temperature", "rain"].map(tab => (
              <button
                key={tab}
                onClick={() => setIntelTab(tab)}
                className={`px-3 py-1.5 text-xs font-medium rounded-lg transition ${
                  intelTab === tab
                    ? "bg-green-600 text-white"
                    : "bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-600"
                }`}
              >
                {tab === "conditions" ? "☁️ By Condition" : tab === "temperature" ? "🌡️ By Temperature" : "💧 By Rainfall"}
              </button>
            ))}
          </div>

          {/* By Condition */}
          {intelTab === "conditions" && (
            <div className="space-y-3">
              {Object.entries(corrConditions)
                .sort(([,a], [,b]) => b.multiplier - a.multiplier)
                .map(([cond, data], i) => {
                  const pct = data.impact_pct;
                  const barWidth = Math.min(100, Math.max(10, data.multiplier * 100));
                  const color = pct >= 0 ? "bg-green-500" : pct > -15 ? "bg-yellow-500" : "bg-red-500";
                  return (
                    <div key={i} className="flex items-center gap-3">
                      <span className="text-2xl w-8">{WEATHER_ICONS[cond] || "🌡️"}</span>
                      <div className="flex-1">
                        <div className="flex items-center justify-between mb-1">
                          <span className="text-sm font-medium capitalize text-gray-700 dark:text-gray-300">{cond}</span>
                          <span className={`text-sm font-bold ${pct >= 0 ? "text-green-600" : pct > -15 ? "text-yellow-600" : "text-red-600"}`}>
                            {pct >= 0 ? "+" : ""}{pct}%
                          </span>
                        </div>
                        <div className="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden">
                          <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${barWidth}%` }} />
                        </div>
                        <div className="flex items-center justify-between text-xs text-gray-400 mt-0.5">
                          <span>{t("avg")}: {Math.round(data.average_revenue)} {currency} / {t("day")}</span>
                          <span>{data.sample_days} days • Best: {Math.round(data.best_day)} {currency}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              {correlation.overall_average > 0 && (
                <p className="text-xs text-gray-500 dark:text-gray-400 pt-2 border-t border-gray-100 dark:border-gray-700">
                  Overall average: {Math.round(correlation.overall_average)} {currency} / day
                </p>
              )}
            </div>
          )}

          {/* By Temperature */}
          {intelTab === "temperature" && correlation.temperature_analysis && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[
                { key: "cold_below_5", label: "Cold (<5°C)", icon: "🥶", bg: "bg-blue-50 dark:bg-blue-900/20" },
                { key: "mild_5_to_20", label: "Mild (5-20°C)", icon: "😊", bg: "bg-yellow-50 dark:bg-yellow-900/20" },
                { key: "warm_20plus", label: "Warm (>20°C)", icon: "🔥", bg: "bg-red-50 dark:bg-red-900/20" },
              ].map(({ key, label, icon, bg }) => {
                const d = correlation.temperature_analysis[key];
                if (!d) return null;
                const avg = correlation.overall_average;
                const pct = avg ? Math.round((d.avg_revenue / avg - 1) * 100) : 0;
                return (
                  <div key={key} className={`p-4 rounded-xl ${bg} text-center`}>
                    <span className="text-3xl">{icon}</span>
                    <p className="text-sm font-medium mt-2 text-gray-700 dark:text-gray-300">{label}</p>
                    <p className="text-2xl font-bold text-gray-800 dark:text-white mt-1">{Math.round(d.avg_revenue)} {currency}</p>
                    <p className={`text-sm font-semibold mt-1 ${pct >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {pct >= 0 ? "+" : ""}{pct}% vs avg
                    </p>
                    <p className="text-xs text-gray-400 mt-1">{d.days} days analyzed</p>
                  </div>
                );
              })}
            </div>
          )}
          {intelTab === "temperature" && !correlation.temperature_analysis && (
            <p className="text-sm text-gray-500 text-center py-4">Not enough temperature data yet</p>
          )}

          {/* By Rainfall */}
          {intelTab === "rain" && correlation.rain_analysis && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[
                { key: "dry", label: "Dry (<1mm)", icon: "☀️", bg: "bg-green-50 dark:bg-green-900/20" },
                { key: "light_rain", label: "Light (1-5mm)", icon: "🌦️", bg: "bg-yellow-50 dark:bg-yellow-900/20" },
                { key: "heavy_rain", label: "Heavy (>5mm)", icon: "🌧️", bg: "bg-red-50 dark:bg-red-900/20" },
              ].map(({ key, label, icon, bg }) => {
                const d = correlation.rain_analysis[key];
                if (!d) return null;
                const avg = correlation.overall_average;
                const pct = avg ? Math.round((d.avg_revenue / avg - 1) * 100) : 0;
                return (
                  <div key={key} className={`p-4 rounded-xl ${bg} text-center`}>
                    <span className="text-3xl">{icon}</span>
                    <p className="text-sm font-medium mt-2 text-gray-700 dark:text-gray-300">{label}</p>
                    <p className="text-2xl font-bold text-gray-800 dark:text-white mt-1">{Math.round(d.avg_revenue)} {currency}</p>
                    <p className={`text-sm font-semibold mt-1 ${pct >= 0 ? "text-green-600" : "text-red-600"}`}>
                      {pct >= 0 ? "+" : ""}{pct}% vs avg
                    </p>
                    <p className="text-xs text-gray-400 mt-1">{d.days} days analyzed</p>
                  </div>
                );
              })}
            </div>
          )}
          {intelTab === "rain" && !correlation.rain_analysis && (
            <p className="text-sm text-gray-500 text-center py-4">Not enough rainfall data yet</p>
          )}
        </div>
      )}

      {/* ─── SMART INSIGHTS (Legacy — still useful when no intelligence) ─── */}
      {insights.length > 0 && !corrReady && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">{t("smartInsights")}</h2>
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

      {/* ─── WEATHER IMPACT PROFILE (Legacy fallback) ─── */}
      {conditions.length > 0 && !corrReady && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-1">{t("weatherImpactProfile")}</h2>
          <p className="text-xs text-gray-500 dark:text-gray-400 mb-4">{t("weatherImpactDesc")}</p>
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
                      {t("avg")}: {Math.round(c.average_revenue)} {currency} / {t("day")}  •  {c.sample_days} {t("daysAnalyzed")}
                    </p>
                  </div>
                </div>
              );
            })}
            {avgDaily > 0 && (
              <p className="text-xs text-gray-500 dark:text-gray-400 pt-2 border-t border-gray-100 dark:border-gray-700">
                {t("overallAverage")}: {Math.round(avgDaily)} {currency} / {t("day")}
              </p>
            )}
          </div>
        </div>
      )}

      {/* ─── SEASONAL PATTERNS ─── */}
      {hasSeasonalData && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 shadow-sm">
          <h2 className="font-bold text-gray-800 dark:text-white mb-4">{t("seasonalPatterns")}</h2>
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
        <h2 className="font-bold text-gray-800 dark:text-white mb-4">{t("sickCallTracker")}</h2>

        {/* Stats */}
        {sickStats && (
          <div className="grid grid-cols-3 gap-3 mb-4">
            <div className="bg-red-50 dark:bg-red-900/20 p-3 rounded-xl text-center">
              <p className="text-2xl font-bold text-red-600">{sickStats.this_month}</p>
              <p className="text-xs text-gray-500">{t("thisMonth")}</p>
            </div>
            <div className="bg-yellow-50 dark:bg-yellow-900/20 p-3 rounded-xl text-center">
              <p className="text-2xl font-bold text-yellow-600">{sickStats.last_month}</p>
              <p className="text-xs text-gray-500">{t("lastMonth")}</p>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-xl text-center">
              <p className="text-2xl font-bold text-blue-600">{sickStats.weather_related || 0}</p>
              <p className="text-xs text-gray-500">{t("weatherDays")}</p>
            </div>
          </div>
        )}

        {/* Add form */}
        <form onSubmit={logSickCall} className="flex flex-wrap gap-2 mb-4">
          <input
            placeholder={t("staffName")}
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
            <option value="">{t("reason")}</option>
            <option value="rain">{t("rainWeather")}</option>
            <option value="snow">{t("snowOption")}</option>
            <option value="storm">{t("stormOption")}</option>
            <option value="clear">{t("sickGoodWeather")}</option>
            <option value="cloudy">{t("sickBadWeather")}</option>
          </select>
          <button type="submit" className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition">
            {t("log")}
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
                  <p className="text-xs text-gray-500">{sc.weather_condition || "—"} • {formatDate(sc.date)}</p>
                </div>
                {sc.weather_condition && (
                  <span className="text-lg">{WEATHER_ICONS[sc.weather_condition] || ""}</span>
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-sm text-gray-400 text-center py-4">{t("noSickCalls")}</p>
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
