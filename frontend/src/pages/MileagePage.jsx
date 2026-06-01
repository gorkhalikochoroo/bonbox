import { useState, useEffect } from "react";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import api from "../services/api";
import HowItWorksCard from "../components/HowItWorksCard";
import { localIso } from "../utils/dateFormat";
import { canPurchaseInApp, isNativeApp } from "../utils/platform";

/**
 * MileagePage — kørselsgodtgørelse log.
 *
 * Skattestyrelsen 2026:
 *   0–20.000 km/year: 3.79 kr/km
 *   20.000+ km/year: 2.23 kr/km
 *
 * Rate is frozen at entry creation time (backend handles it). Annual
 * deduction total is the big sell — most owners don't realize they're
 * leaving 10-15k kr/year on the table by not tracking trips.
 */
export default function MileagePage() {
  const { user } = useAuth();
  const { t } = useLanguage();

  const [entries, setEntries] = useState([]);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState(null);

  // Trial users get Pro-tier access during the 14-day window.
  const plan = (user?.plan || "free").toLowerCase();
  const hasAccess = ["starter", "pro", "business", "trial"].includes(plan);
  const currentYear = new Date().getFullYear();

  useEffect(() => {
    if (!hasAccess) {
      setLoading(false);
      return;
    }
    fetchAll();
  }, [hasAccess]);

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [list, sum] = await Promise.all([
        api.get("/mileage"),
        api.get(`/mileage/summary/${currentYear}`),
      ]);
      setEntries(list.data);
      setSummary(sum.data);
    } catch (e) {
      setError(e?.response?.data?.detail || "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  const fmtKr = (v) =>
    new Intl.NumberFormat("da-DK", { style: "currency", currency: "DKK" }).format(v);

  if (!hasAccess) {
    return (
      <div className="p-4 md:p-8 max-w-2xl mx-auto">
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-6 text-center">
          <div className="text-4xl mb-3">🔒</div>
          {/* App Store compliance (Apple 3.1.1): no tier name on native. */}
          <h1 className="text-xl font-bold mb-2 text-amber-900 dark:text-amber-200">
            {isNativeApp()
              ? (t("featureNotOnPlanTitle") || "Not available on this plan")
              : (t("mileageStarterRequired") || "Mileage tracker — Starter plan required")}
          </h1>
          <p className="text-sm text-amber-800 dark:text-amber-300 mb-4">
            {t("mileageStarterDesc") ||
              "Track business trips for kørselsgodtgørelse. Most owners miss 10-15k kr in deductions per year."}
          </p>
          {canPurchaseInApp() && (
            <a href="/subscription" className="inline-block px-4 py-2 bg-amber-600 text-white rounded-xl text-sm font-semibold hover:bg-amber-700 transition">
              {t("upgrade") || "Upgrade"}
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 md:p-8 max-w-6xl mx-auto space-y-6">
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white flex items-center gap-2">
            <span>🚗</span> {t("mileage") || "Mileage"}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t("mileageDesc") || "Track business trips · kørselsgodtgørelse · auto-calculated deduction"}
          </p>
        </div>
        <button
          onClick={() => {
            setEditingId(null);
            setShowForm(true);
          }}
          className="px-4 py-2 bg-gray-900 text-white rounded-xl text-sm font-semibold hover:bg-gray-700 transition"
        >
          + {t("newTrip") || "New trip"}
        </button>
      </div>

      <HowItWorksCard
        storageKey="mileage"
        icon="🚗"
        tone="green"
        title={t("mileageHowTitle") || "How Mileage works"}
        steps={[
          {
            title: t("mileageStep1Title") || "1. Log every business trip — same day",
            body:
              t("mileageStep1Body") ||
              "Date, km, purpose (e.g. \"supplier pickup — Grossisten\"), and your vehicle's registration. Skattestyrelsen requires contemporaneous logs — don't reconstruct trips at year-end.",
          },
          {
            title: t("mileageStep2Title") || "2. Rate is auto-applied (2026)",
            body:
              t("mileageStep2Body") ||
              "First 20.000 km/year: 3,79 kr/km. Above 20.000 km: 2,23 kr/km. We freeze the rate on each entry, so even if Skattestyrelsen updates rates next year, your old entries stay accurate.",
          },
          {
            title: t("mileageStep3Title") || "3. Watch the YTD card",
            body:
              t("mileageStep3Body") ||
              "Top card shows total km logged this year, your tax-deductible kroner, and which rate tier you're currently in. Most owners miss 10-15k kr/year by not tracking — this card makes it real.",
          },
          {
            title: t("mileageStep4Title") || "4. Save your fuel receipts separately",
            body:
              t("mileageStep4Body") ||
              "Kørselsgodtgørelse replaces actual fuel/maintenance costs — you can't claim both. Keep receipts as documentation, but the deduction is calculated from the km log, not the receipts.",
          },
        ]}
        footer={
          t("mileageHowFooter") ||
          "Sats jf. Skattestyrelsens befordringsgodtgørelse 2026. Loggen skal være ført løbende (Bogføringsloven §11) — den kan kræves dokumenteret ved kontrol."
        }
      />

      {/* Year summary card */}
      {summary && (
        <div className="bg-gray-50 dark:bg-gray-800/50 text-white rounded-xl p-6 shadow-sm">
          <p className="text-sm opacity-90 mb-1">
            {t("yearToDate") || "Year to date"} · {summary.year}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mt-3">
            <div>
              <p className="text-xs opacity-80 mb-0.5">{t("totalKm") || "Total km"}</p>
              <p className="text-3xl font-bold">{Number(summary.total_km).toLocaleString("da-DK")} km</p>
              <p className="text-xs opacity-70 mt-0.5">
                {summary.entries_count} {t("trips") || "trips"}
              </p>
            </div>
            <div>
              <p className="text-xs opacity-80 mb-0.5">{t("totalDeduction") || "Total deduction"}</p>
              <p className="text-3xl font-bold">{fmtKr(summary.total_deduction)}</p>
              <p className="text-xs opacity-70 mt-0.5">
                {t("taxDeductible") || "Tax-deductible"}
              </p>
            </div>
            <div>
              <p className="text-xs opacity-80 mb-0.5">{t("currentRate") || "Current rate"}</p>
              <p className="text-3xl font-bold">
                {summary.rate_tier === "high" ? "2,23" : "3,79"} kr/km
              </p>
              <p className="text-xs opacity-70 mt-0.5">
                {summary.rate_tier === "high"
                  ? (t("over20kKm") || "20.000+ km this year")
                  : (t("under20kKm") || "First 20.000 km this year")}
              </p>
            </div>
          </div>
        </div>
      )}

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {loading ? (
        <div className="text-center py-12 text-gray-500">{t("loading") || "Loading…"}</div>
      ) : entries.length === 0 ? (
        <div className="bg-white dark:bg-gray-800 rounded-xl p-12 text-center border border-gray-100 dark:border-gray-700">
          <p className="text-4xl mb-3">🚗</p>
          <p className="text-gray-600 dark:text-gray-300 font-medium mb-2">
            {t("noTripsYet") || "No trips logged this year."}
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            {t("logTripHint") || "Skattestyrelsen requires same-day logging. Add today's trips before midnight."}
          </p>
        </div>
      ) : (
        <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-900/40 text-gray-500 dark:text-gray-400 uppercase text-xs">
              <tr>
                <th className="text-left px-5 py-3">{t("date") || "Date"}</th>
                <th className="text-left px-5 py-3">{t("fromTo") || "From → To"}</th>
                <th className="text-left px-5 py-3">{t("purpose") || "Purpose"}</th>
                <th className="text-right px-5 py-3">{t("kmShort") || "km"}</th>
                <th className="text-right px-5 py-3">{t("rate") || "Rate"}</th>
                <th className="text-right px-5 py-3">{t("deduction") || "Deduction"}</th>
                <th className="text-right px-5 py-3"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {entries.map((e) => (
                <tr key={e.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30 transition">
                  <td className="px-5 py-3 text-gray-700 dark:text-gray-200">{e.trip_date}</td>
                  <td className="px-5 py-3 text-gray-600 dark:text-gray-300 max-w-[260px] truncate">
                    {e.from_address} → {e.to_address}
                  </td>
                  <td className="px-5 py-3 text-gray-600 dark:text-gray-400 truncate max-w-[180px]">{e.purpose}</td>
                  <td className="px-5 py-3 text-right font-mono text-gray-700 dark:text-gray-200">
                    {Number(e.km).toLocaleString("da-DK")}
                  </td>
                  <td className="px-5 py-3 text-right text-gray-600 dark:text-gray-400 text-xs">
                    {Number(e.rate_per_km).toFixed(2).replace(".", ",")} kr/km
                  </td>
                  <td className="px-5 py-3 text-right font-semibold text-gray-700 dark:text-gray-300">
                    {fmtKr(e.deduction_amount)}
                  </td>
                  <td className="px-5 py-3 text-right whitespace-nowrap">
                    {!e.locked && (
                      <>
                        <button
                          onClick={() => {
                            setEditingId(e.id);
                            setShowForm(true);
                          }}
                          className="text-xs text-blue-600 hover:underline mr-2"
                        >
                          {t("edit") || "Edit"}
                        </button>
                        <button
                          onClick={async () => {
                            if (!confirm(t("deleteTripConfirm") || "Delete this trip?")) return;
                            try {
                              await api.delete(`/mileage/${e.id}`);
                              fetchAll();
                            } catch (err) {
                              alert(err?.response?.data?.detail || "Delete failed");
                            }
                          }}
                          className="text-xs text-red-600 hover:underline"
                        >
                          {t("delete") || "Delete"}
                        </button>
                      </>
                    )}
                    {e.locked && (
                      <span className="text-xs text-gray-400">🔒</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {showForm && (
        <MileageFormModal
          entryId={editingId}
          entries={entries}
          onClose={() => setShowForm(false)}
          onSaved={() => {
            setShowForm(false);
            fetchAll();
          }}
          t={t}
        />
      )}
    </div>
  );
}

function MileageFormModal({ entryId, entries, onClose, onSaved, t }) {
  const isEdit = !!entryId;
  const existing = entries.find((e) => e.id === entryId);
  const [form, setForm] = useState({
    trip_date: existing?.trip_date || localIso(),
    from_address: existing?.from_address || "",
    to_address: existing?.to_address || "",
    km: existing?.km || "",
    purpose: existing?.purpose || "",
    vehicle_reg: existing?.vehicle_reg || "",
    notes: existing?.notes || "",
  });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const update = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const payload = { ...form, km: parseFloat(form.km) };
      Object.keys(payload).forEach((k) => {
        if (payload[k] === "") delete payload[k];
      });
      if (isEdit) {
        await api.patch(`/mileage/${entryId}`, payload);
      } else {
        await api.post("/mileage", payload);
      }
      onSaved();
    } catch (err) {
      setError(err?.response?.data?.detail || "Save failed");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4">
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm max-w-lg w-full">
        <div className="p-5 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-800 dark:text-white">
            {isEdit ? (t("editTrip") || "Edit trip") : (t("newTrip") || "New trip")}
          </h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">&times;</button>
        </div>
        <form onSubmit={handleSubmit} className="p-5 space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
              {t("tripDate") || "Trip date"} *
            </label>
            <input
              type="date"
              value={form.trip_date}
              onChange={update("trip_date")}
              required
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
              {t("from") || "From"} *
            </label>
            <input
              type="text"
              value={form.from_address}
              onChange={update("from_address")}
              required
              placeholder={t("fromPlaceholder") || "Hjem, Amager"}
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
              {t("to") || "To"} *
            </label>
            <input
              type="text"
              value={form.to_address}
              onChange={update("to_address")}
              required
              placeholder={t("toPlaceholder") || "Vesterbro Bryghus"}
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
              {t("kmShort") || "Km"} *
            </label>
            <input
              type="number"
              step="0.1"
              min="0.1"
              value={form.km}
              onChange={update("km")}
              required
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
            />
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
              {t("purpose") || "Purpose"} *
            </label>
            <input
              type="text"
              value={form.purpose}
              onChange={update("purpose")}
              required
              placeholder={t("purposePlaceholder") || "Tihar event setup"}
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm"
            />
            <p className="text-[10px] text-gray-400 mt-1">
              {t("purposeRequired") || "Required by Skattestyrelsen for audit compliance."}
            </p>
          </div>

          <div>
            <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1 block">
              {t("vehicleReg") || "Vehicle reg (license plate)"}
            </label>
            <input
              type="text"
              value={form.vehicle_reg}
              onChange={update("vehicle_reg")}
              placeholder="AB 12 345"
              className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 dark:bg-gray-700 dark:text-white rounded-lg text-sm font-mono uppercase"
            />
          </div>

          {error && (
            <div className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300 px-3 py-2 rounded-lg text-sm">
              {error}
            </div>
          )}

          <div className="flex gap-3 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-xl text-sm"
            >
              {t("cancel") || "Cancel"}
            </button>
            <button
              type="submit"
              disabled={saving}
              className="px-4 py-2 bg-gray-900 text-white rounded-xl text-sm font-semibold hover:bg-gray-700 transition disabled:opacity-50"
            >
              {saving ? (t("saving") || "Saving…") : (t("save") || "Save trip")}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
