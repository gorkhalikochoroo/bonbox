import { useState, useEffect, useMemo } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import ReceiptCapture from "../components/ReceiptCapture";
import { trackEvent } from "../hooks/useEventLog";
import { exportToCsv } from "../utils/exportCsv";
import { displayCurrency, getTaxConfig } from "../utils/currency";
import { formatDate, formatDateShort } from "../utils/dateFormat";
import { getVatTerms } from "../utils/currency";
import TaxBreakdown from "../components/TaxBreakdown";

const QUICK_AMOUNTS = [500, 1000, 2500, 5000, 7500, 10000, 15000];

export default function SalesPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();
  const [sales, setSales] = useState([]);
  const [amount, setAmount] = useState("");
  const [saleDate, setSaleDate] = useState(new Date().toISOString().split("T")[0]);
  const [method, setMethod] = useState("mixed");
  const [notes, setNotes] = useState("");
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [fetchError, setFetchError] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [editId, setEditId] = useState(null);
  const [editData, setEditData] = useState({});
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [listening, setListening] = useState(false);
  const [isTaxExempt, setIsTaxExempt] = useState(false);
  const [showItemSale, setShowItemSale] = useState(false);
  const [inventoryItems, setInventoryItems] = useState([]);
  const [expandedStat, setExpandedStat] = useState(null); // "today" | "total" | "avg" | null

  const filtered = sales.filter(s => !search || s.notes?.toLowerCase().includes(search.toLowerCase()) || s.payment_method?.toLowerCase().includes(search.toLowerCase()) || String(s.amount).includes(search)).sort((a, b) => {
    const d = b.date.localeCompare(a.date);
    if (d !== 0) return d;
    return (b.created_at || "").localeCompare(a.created_at || "");
  });

  const startVoice = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { setError(t("voiceNotSupported")); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = "en-US";
    recognition.interimResults = false;
    recognition.onstart = () => setListening(true);
    recognition.onend = () => setListening(false);
    recognition.onresult = (event) => {
      const text = event.results[0][0].transcript.toLowerCase();
      // Extract number from speech
      const numMatch = text.match(/[\d,]+\.?\d*/);
      if (numMatch) {
        const val = parseFloat(numMatch[0].replace(/,/g, ""));
        if (val > 0) {
          setAmount(String(val));
          // Detect payment method
          if (text.includes("cash")) setMethod("cash");
          else if (text.includes("card")) setMethod("card");
          else if (text.includes("mobile")) setMethod("mobilepay");
          // Extract notes (everything after the number and method)
          const remaining = text.replace(numMatch[0], "").replace(/cash|card|mobilepay|mixed|dankort/g, "").trim();
          if (remaining.length > 2) setNotes(remaining);
          setSuccess(`${t("voiceParsed")}: "${text}" → ${val.toLocaleString()} ${currency}`);
          setTimeout(() => setSuccess(""), 3000);
        }
      } else {
        setError(`${t("couldntParseAmount")}: "${text}"`);
        setTimeout(() => setError(""), 3000);
      }
    };
    recognition.onerror = () => { setListening(false); setError(t("voiceRecognitionFailed")); setTimeout(() => setError(""), 3000); };
    recognition.start();
  };

  const fetchSales = async (from, to) => {
    try {
      setFetchError("");
      const params = {};
      if (from) params.from = from;
      if (to) params.to = to;
      const res = await api.get("/sales", { params });
      setSales(res.data);
    } catch (err) {
      setFetchError(err.response?.data?.detail || t("failedToLoadSales"));
    }
  };
  const fetchInventory = () => {
    api.get("/inventory").then((res) => setInventoryItems(res.data)).catch(() => {});
  };

  useEffect(() => {
    fetchSales();
    fetchInventory();
    const onDataChanged = () => { fetchSales(); fetchInventory(); };
    window.addEventListener("bonbox-data-changed", onDataChanged);
    return () => window.removeEventListener("bonbox-data-changed", onDataChanged);
  }, []);

  const submit = async (amt) => {
    const value = amt || parseFloat(amount);
    if (!value) return;
    const duplicate = sales.find(s => s.date === saleDate && parseFloat(s.amount) === value);
    if (duplicate && !confirm(`${t("aSaleOf")} ${value.toLocaleString()} ${currency} ${t("on")} ${formatDate(saleDate)} ${t("duplicateSaleConfirm")}`)) {
      return;
    }
    setError("");
    try {
      await api.post("/sales", {
        date: saleDate,
        amount: value,
        payment_method: method,
        notes: notes || null,
        is_tax_exempt: isTaxExempt,
      });
      const isBackdated = saleDate !== new Date().toISOString().split("T")[0];
      setAmount("");
      setNotes("");
      setIsTaxExempt(false);
      setSaleDate(new Date().toISOString().split("T")[0]);
      trackEvent("sale_logged", "sales", `${value} ${currency} via ${method}`);
      setSuccess(`${value.toLocaleString()} ${currency}${isBackdated ? ` (${formatDate(saleDate)})` : ""}!`);
      fetchSales(filterFrom, filterTo);
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || t("failedToAddSale"));
    }
  };

  const startEdit = (sale) => {
    setEditId(sale.id);
    setEditData({
      date: sale.date,
      amount: parseFloat(sale.amount),
      payment_method: sale.payment_method,
      notes: sale.notes || "",
      is_tax_exempt: sale.is_tax_exempt || false,
    });
  };

  const saveEdit = async () => {
    try {
      await api.put(`/sales/${editId}`, editData);
      setEditId(null);
      setEditData({});
      fetchSales(filterFrom, filterTo);
      setSuccess(t("saleUpdated"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || t("failedToUpdateSale"));
    }
  };

  const bulkDelete = async () => {
    if (!confirm(`${t("moveToTrash")} ${selected.size}?`)) return;
    try {
      await Promise.all([...selected].map(id => api.delete(`/sales/${id}`)));
      setSelected(new Set());
      fetchSales(filterFrom, filterTo);
      setSuccess(`${selected.size} ${t("movedToDeleted")}`);
      setTimeout(() => setSuccess(""), 2500);
    } catch {
      setError(t("failedToDeleteSome"));
    }
  };

  const deleteSale = async (id) => {
    try {
      await api.delete(`/sales/${id}`);
      setDeleteConfirm(null);
      fetchSales(filterFrom, filterTo);
      setSuccess(t("movedToDeleted"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || t("failedToDeleteSale"));
    }
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("salesTracker")}</h1>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowItemSale(true)}
            className="px-4 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition"
          >
            + {t("itemSale")}
          </button>
          <ReceiptCapture onSaleCreated={fetchSales} />
        </div>
      </div>

      {success && <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{error}</div>}
      {fetchError && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{fetchError}</div>}

      {/* Form + Stats side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        {/* Quick Entry - left side */}
        <div className="lg:col-span-3 bg-white dark:bg-gray-800 p-4 sm:p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
          <div className="max-w-md">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300 mb-0.5">{t("logSale")}</h2>
          <p className="text-xs text-gray-400 dark:text-gray-400 mb-3">{t("tapAmount")}</p>

          {/* One-tap amounts */}
          <div className="flex flex-wrap gap-1.5 mb-3">
            {QUICK_AMOUNTS.map((amt) => (
              <button
                key={amt}
                onClick={() => submit(amt)}
                className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:border-blue-300 dark:hover:border-blue-500 hover:text-blue-700 dark:hover:text-blue-300 transition"
              >
                {amt.toLocaleString()} {currency}
              </button>
            ))}
          </div>

          {/* Custom amount */}
          <div className="flex items-center gap-2">
            <button
              onClick={startVoice}
              className={`p-2 rounded-lg border transition flex-shrink-0 ${
                listening
                  ? "bg-red-50 dark:bg-red-900/30 border-red-300 dark:border-red-600 text-red-600 dark:text-red-400 animate-pulse"
                  : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:text-blue-600"
              }`}
              title={t("voiceInput")}
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </button>
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder={`${t("customAmount")} ${getTaxConfig(user?.currency).rate > 0 ? `(${getTaxConfig(user?.currency).label})` : ""}`}
              className="flex-1 px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              onKeyDown={(e) => e.key === "Enter" && submit()}
            />
            <button
              onClick={() => submit()}
              disabled={!amount}
              className="px-4 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-semibold text-sm disabled:opacity-40"
            >
              {t("log")}
            </button>
          </div>

          {/* Tax breakdown */}
          <TaxBreakdown amount={amount} currencyCode={user?.currency} isTaxExempt={isTaxExempt} onTaxExemptChange={setIsTaxExempt} />

          {/* Payment method */}
          <div className="flex flex-wrap gap-1.5 mt-2">
            {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
              <button
                key={m}
                onClick={() => setMethod(m)}
                className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                  method === m
                    ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-500 text-blue-700 dark:text-blue-300"
                    : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                }`}
              >
                {t(m)}
              </button>
            ))}
          </div>

          {/* Notes + Date row */}
          <div className="mt-2 flex items-center gap-2">
            <input
              type="text"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              placeholder={t("addNoteOptional")}
              className="flex-1 px-2.5 py-1 border border-gray-200 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 dark:bg-gray-700 dark:text-white"
            />
            <input
              type="date"
              value={saleDate}
              max={new Date().toISOString().split("T")[0]}
              onChange={(e) => setSaleDate(e.target.value)}
              className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          {saleDate !== new Date().toISOString().split("T")[0] && (
            <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 font-medium">{t("backdatedEntry")}</p>
          )}
          </div>
        </div>

        {/* Summary Stats - right side, Inventory Monitor style */}
        {sales.length > 0 ? (() => {
          // Derive display month from data when filters are active, otherwise use current month
          const now = new Date();
          const hasFilter = filterFrom || filterTo;
          // If filtered, use the most recent sale's month; otherwise current month
          const refDate = hasFilter && sales.length > 0
            ? new Date(sales.reduce((latest, s) => s.date > latest ? s.date : latest, sales[0].date) + "T12:00:00")
            : now;
          const monthPrefix = refDate.toISOString().slice(0, 7);
          const monthName = refDate.toLocaleString("default", { month: "long" });
          // When filtered, show all sales as "month sales" (they're already filtered by the API)
          const monthSales = hasFilter ? sales : sales.filter(s => s.date?.startsWith(monthPrefix));
          const totalRev = monthSales.reduce((s, x) => s + parseFloat(x.amount), 0);
          const todayStr = now.toISOString().split("T")[0];
          // When filtered to past dates, show the latest day in the data as "today" card
          const latestDate = hasFilter && sales.length > 0
            ? sales.reduce((latest, s) => s.date > latest ? s.date : latest, sales[0].date)
            : todayStr;
          const todaySales = sales.filter(s => s.date === latestDate);
          const todayRev = todaySales.reduce((s, x) => s + parseFloat(x.amount), 0);
          const methods = {};
          monthSales.forEach(s => { methods[s.payment_method] = (methods[s.payment_method] || 0) + parseFloat(s.amount); });
          // Group sales by date for breakdown (avg per day, not per entry)
          const byDate = {};
          monthSales.forEach(s => { byDate[s.date] = (byDate[s.date] || 0) + parseFloat(s.amount); });
          const daysWithSales = Object.keys(byDate).length;
          const avgSale = daysWithSales > 0 ? totalRev / daysWithSales : 0;
          const sortedDates = Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0]));
          // Today's methods
          const todayMethods = {};
          todaySales.forEach(s => { todayMethods[s.payment_method] = (todayMethods[s.payment_method] || 0) + parseFloat(s.amount); });
          return (
            <div className="lg:col-span-2 space-y-3">
              <div className="grid grid-cols-2 gap-3">
                <button onClick={() => setExpandedStat(expandedStat === "today" ? null : "today")} className={`text-left bg-gradient-to-br from-green-950 to-gray-800 rounded-xl p-4 border transition hover:brightness-110 active:scale-[0.98] ${expandedStat === "today" ? "border-green-400 ring-1 ring-green-400/50" : "border-green-800/50"}`}>
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] uppercase tracking-widest text-green-300/70 font-semibold">{hasFilter ? t("latestDay") : t("today")}</p>
                    <svg className={`w-3 h-3 text-green-400/60 transition-transform ${expandedStat === "today" ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                  </div>
                  <p className="text-3xl font-extrabold text-green-400 mt-1">{todayRev.toLocaleString()}</p>
                  <p className="text-[11px] text-green-300/50 mt-1 font-medium">{todaySales.length} {todaySales.length !== 1 ? t("salesCount") : t("saleCount")} {t("today").toLowerCase()}</p>
                </button>
                <button onClick={() => setExpandedStat(expandedStat === "total" ? null : "total")} className={`text-left bg-gradient-to-br from-blue-950 to-gray-800 rounded-xl p-4 border transition hover:brightness-110 active:scale-[0.98] ${expandedStat === "total" ? "border-blue-400 ring-1 ring-blue-400/50" : "border-blue-800/50"}`}>
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] uppercase tracking-widest text-blue-300/70 font-semibold">{monthName} {t("revenue")}</p>
                    <svg className={`w-3 h-3 text-blue-400/60 transition-transform ${expandedStat === "total" ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                  </div>
                  <p className="text-3xl font-extrabold text-blue-400 mt-1">{totalRev.toLocaleString()}</p>
                  <p className="text-[11px] text-blue-300/50 mt-1 font-medium">{currency} · {monthSales.length} {t("salesCount")}</p>
                </button>
                <button onClick={() => setExpandedStat(expandedStat === "avg" ? null : "avg")} className={`text-left bg-gradient-to-br from-purple-950 to-gray-800 rounded-xl p-4 border transition hover:brightness-110 active:scale-[0.98] ${expandedStat === "avg" ? "border-purple-400 ring-1 ring-purple-400/50" : "border-purple-800/50"}`}>
                  <div className="flex items-center justify-between">
                    <p className="text-[10px] uppercase tracking-widest text-purple-300/70 font-semibold">{t("avgSale")}</p>
                    <svg className={`w-3 h-3 text-purple-400/60 transition-transform ${expandedStat === "avg" ? "rotate-180" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" /></svg>
                  </div>
                  <p className="text-3xl font-extrabold text-purple-400 mt-1">{Math.round(avgSale).toLocaleString()}</p>
                  <p className="text-[11px] text-purple-300/50 mt-1 font-medium">{currency}/{t("day")} · {daysWithSales} {t("days")}</p>
                </button>
                <div className="bg-gradient-to-br from-orange-950 to-gray-800 rounded-xl p-4 border border-orange-800/50">
                  <p className="text-[10px] uppercase tracking-widest text-orange-300/70 font-semibold mb-1.5">{t("byPayment")}</p>
                  <div className="flex flex-wrap gap-1.5 mt-1.5">
                    {Object.entries(methods).sort((a, b) => b[1] - a[1]).map(([m, amt]) => (
                      <button
                        key={m}
                        onClick={() => setSearch(search === m ? "" : m)}
                        className={`px-2.5 py-1 rounded-full text-[11px] font-bold transition capitalize ${
                          search === m
                            ? "bg-orange-500 text-white shadow-lg shadow-orange-500/30"
                            : "bg-orange-900/40 text-orange-200 hover:bg-orange-800/60 border border-orange-700/40"
                        }`}
                      >
                        {t(m)} · {amt.toLocaleString()}
                      </button>
                    ))}
                  </div>
                  <p className="text-[11px] text-orange-300/50 mt-2 font-medium">{Object.keys(methods).length} {Object.keys(methods).length !== 1 ? t("methodsUsed") : t("methodUsed")}</p>
                </div>
              </div>

              {/* Expanded detail panel */}
              {expandedStat === "today" && (
                <div className="bg-gradient-to-br from-green-950/80 to-gray-800 rounded-xl p-4 border border-green-700/60 animate-in">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-semibold text-green-300">{t("todaysBreakdown")}</p>
                    <button onClick={() => setExpandedStat(null)} className="w-5 h-5 flex items-center justify-center rounded-full bg-green-900/50 text-green-400 text-xs hover:bg-green-800/60">&times;</button>
                  </div>
                  {todaySales.length > 0 ? (
                    <>
                      {Object.keys(todayMethods).length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mb-3">
                          {Object.entries(todayMethods).sort((a, b) => b[1] - a[1]).map(([m, amt]) => (
                            <span key={m} className="px-2.5 py-1 bg-green-900/40 border border-green-700/40 rounded-full text-[11px] font-bold text-green-300 capitalize">{t(m)} · {amt.toLocaleString()}</span>
                          ))}
                        </div>
                      )}
                      <div className="space-y-1 max-h-36 overflow-y-auto">
                        {todaySales.map((s, i) => (
                          <div key={i} className="flex items-center justify-between px-3 py-1.5 bg-green-900/20 rounded-lg text-xs">
                            <span className="font-bold text-green-300">{parseFloat(s.amount).toLocaleString()} {currency}</span>
                            <span className="text-green-400/50 capitalize">{s.payment_method}</span>
                            <span className="text-green-400/40 truncate max-w-[80px]">{s.notes || "—"}</span>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : <p className="text-xs text-green-400/50 text-center py-2">{t("noSalesTodayYet")}</p>}
                </div>
              )}

              {expandedStat === "total" && (
                <div className="bg-gradient-to-br from-blue-950/80 to-gray-800 rounded-xl p-4 border border-blue-700/60 animate-in">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-semibold text-blue-300">{t("revenueByDay")}</p>
                    <button onClick={() => setExpandedStat(null)} className="w-5 h-5 flex items-center justify-center rounded-full bg-blue-900/50 text-blue-400 text-xs hover:bg-blue-800/60">&times;</button>
                  </div>
                  <div className="flex flex-wrap gap-1.5 mb-3">
                    {Object.entries(methods).sort((a, b) => b[1] - a[1]).map(([m, amt]) => (
                      <span key={m} className="px-2.5 py-1 bg-blue-900/40 border border-blue-700/40 rounded-full text-[11px] font-bold text-blue-300 capitalize">{t(m)} · {amt.toLocaleString()}</span>
                    ))}
                  </div>
                  <div className="space-y-1 max-h-36 overflow-y-auto">
                    {sortedDates.slice(0, 10).map(([date, amt]) => (
                      <div key={date} className="flex items-center justify-between px-3 py-1.5 bg-blue-900/20 rounded-lg text-xs">
                        <span className="text-blue-300/70">{date}</span>
                        <span className="font-bold text-blue-300">{amt.toLocaleString()} {currency}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-blue-400/40 mt-2 text-center">{monthSales.length} {t("salesCount")} · {sortedDates.length} {t("days")} · {monthName}</p>
                </div>
              )}

              {expandedStat === "avg" && (() => {
                const amounts = monthSales.map(s => parseFloat(s.amount)).sort((a, b) => a - b);
                if (amounts.length === 0) return null;
                const min = amounts[0];
                const max = amounts[amounts.length - 1];
                const median = amounts.length % 2 === 0 ? (amounts[amounts.length / 2 - 1] + amounts[amounts.length / 2]) / 2 : amounts[Math.floor(amounts.length / 2)];
                // Distribution buckets
                const buckets = [
                  { label: `< ${Math.round(avgSale * 0.5).toLocaleString()}`, count: amounts.filter(a => a < avgSale * 0.5).length },
                  { label: `${Math.round(avgSale * 0.5).toLocaleString()} – ${Math.round(avgSale * 1.5).toLocaleString()}`, count: amounts.filter(a => a >= avgSale * 0.5 && a <= avgSale * 1.5).length },
                  { label: `> ${Math.round(avgSale * 1.5).toLocaleString()}`, count: amounts.filter(a => a > avgSale * 1.5).length },
                ];
                return (
                  <div className="bg-gradient-to-br from-purple-950/80 to-gray-800 rounded-xl p-4 border border-purple-700/60 animate-in">
                    <div className="flex items-center justify-between mb-3">
                      <p className="text-xs font-semibold text-purple-300">{monthName} {t("saleDistribution")}</p>
                      <button onClick={() => setExpandedStat(null)} className="w-5 h-5 flex items-center justify-center rounded-full bg-purple-900/50 text-purple-400 text-xs hover:bg-purple-800/60">&times;</button>
                    </div>
                    <div className="grid grid-cols-3 gap-2 mb-3">
                      <div className="text-center p-2 bg-purple-900/30 rounded-lg">
                        <p className="text-[10px] text-purple-400/60 font-semibold">{t("min")}</p>
                        <p className="text-sm font-extrabold text-purple-300">{min.toLocaleString()}</p>
                      </div>
                      <div className="text-center p-2 bg-purple-900/30 rounded-lg">
                        <p className="text-[10px] text-purple-400/60 font-semibold">{t("median")}</p>
                        <p className="text-sm font-extrabold text-purple-300">{Math.round(median).toLocaleString()}</p>
                      </div>
                      <div className="text-center p-2 bg-purple-900/30 rounded-lg">
                        <p className="text-[10px] text-purple-400/60 font-semibold">{t("max")}</p>
                        <p className="text-sm font-extrabold text-purple-300">{max.toLocaleString()}</p>
                      </div>
                    </div>
                    <div className="space-y-1.5">
                      {buckets.map((b) => (
                        <div key={b.label} className="flex items-center gap-2">
                          <span className="text-[10px] text-purple-400/60 w-24 text-right truncate">{b.label}</span>
                          <div className="flex-1 bg-purple-900/30 rounded-full h-4 overflow-hidden">
                            <div className="h-full bg-purple-500/60 rounded-full" style={{ width: `${Math.max(4, (b.count / monthSales.length) * 100)}%` }} />
                          </div>
                          <span className="text-[10px] font-bold text-purple-300 w-6">{b.count}</span>
                        </div>
                      ))}
                    </div>
                    <p className="text-[10px] text-purple-400/40 mt-2 text-center">{totalRev.toLocaleString()} ÷ {daysWithSales} {t("days")} = {Math.round(avgSale).toLocaleString()} {currency}/{t("day")}</p>
                  </div>
                );
              })()}
            </div>
          );
        })() : (
          <div className="lg:col-span-2 grid grid-cols-2 gap-3 content-start">
            <div className="bg-gradient-to-br from-green-950 to-gray-800 rounded-xl p-4 border border-green-800/50">
              <p className="text-[10px] uppercase tracking-widest text-green-300/70 font-semibold mb-1.5">{t("today")}</p>
              <p className="text-3xl font-extrabold text-green-400">0</p>
              <p className="text-[11px] text-green-300/50 mt-1 font-medium">{t("noSalesYet")}</p>
            </div>
            <div className="bg-gradient-to-br from-blue-950 to-gray-800 rounded-xl p-4 border border-blue-800/50">
              <p className="text-[10px] uppercase tracking-widest text-blue-300/70 font-semibold mb-1.5">{t("thisMonth")}</p>
              <p className="text-3xl font-extrabold text-blue-400">0</p>
              <p className="text-[11px] text-blue-300/50 mt-1 font-medium">{currency}</p>
            </div>
            <div className="bg-gradient-to-br from-purple-950 to-gray-800 rounded-xl p-4 border border-purple-800/50">
              <p className="text-[10px] uppercase tracking-widest text-purple-300/70 font-semibold mb-1.5">{t("avgSale")}</p>
              <p className="text-3xl font-extrabold text-purple-400">—</p>
              <p className="text-[11px] text-purple-300/50 mt-1 font-medium">{t("logFirstSale")}</p>
            </div>
            <div className="bg-gradient-to-br from-orange-950 to-gray-800 rounded-xl p-4 border border-orange-800/50">
              <p className="text-[10px] uppercase tracking-widest text-orange-300/70 font-semibold mb-1.5">{t("byPayment")}</p>
              <p className="text-lg font-extrabold text-orange-400 mt-1">—</p>
              <p className="text-[11px] text-orange-300/50 mt-1 font-medium">{t("noDataYet")}</p>
            </div>
          </div>
        )}
      </div>

      {/* Item Sale Modal */}
      {showItemSale && (
        <ItemSaleModal
          items={inventoryItems}
          currency={currency}
          onClose={() => setShowItemSale(false)}
          onSale={async (saleData) => {
            try {
              await api.post("/sales", saleData);
              setShowItemSale(false);
              fetchSales(filterFrom, filterTo);
              fetchInventory();
              setSuccess(`${t("itemSale")}: ${saleData.item_name || t("item")} × ${saleData.quantity_sold} = ${(saleData.quantity_sold * saleData.unit_price).toLocaleString()} ${currency}`);
              setTimeout(() => setSuccess(""), 3000);
            } catch (err) {
              setError(err.response?.data?.detail || t("failedToCreateItemSale"));
              setTimeout(() => setError(""), 4000);
            }
          }}
        />
      )}

      {/* CSV Import */}
      <CsvUpload onDone={fetchSales} />

      {/* Sales History */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-3">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("recentSales")}</h2>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => { setFilterFrom(e.target.value); fetchSales(e.target.value, filterTo); }}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <span className="text-xs text-gray-400">→</span>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => { setFilterTo(e.target.value); fetchSales(filterFrom, e.target.value); }}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchSalesPlaceholder")}
              className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
            {(filterFrom || filterTo) && (
              <button
                onClick={() => { setFilterFrom(""); setFilterTo(""); fetchSales(); }}
                className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 font-medium"
              >
                {t("clear")}
              </button>
            )}
            <button
              onClick={() => exportToCsv("sales.csv", sales, [
                { key: "date", label: t("date") },
                { key: "amount", label: t("amount") },
                { key: "payment_method", label: t("payment") },
                { key: "notes", label: t("notes") },
              ])}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium"
            >
              {t("exportCsv")}
            </button>
          </div>
        </div>
        <div className="overflow-x-auto">
        <table className="w-full text-left min-w-[500px]">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th className="px-4 sm:px-6 py-3 w-8">
                <input type="checkbox" onChange={(e) => {
                  if (e.target.checked) setSelected(new Set(filtered.map(i => i.id)));
                  else setSelected(new Set());
                }} checked={selected.size === filtered.length && filtered.length > 0} />
              </th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("amount")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("payment")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("notes")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">{t("date")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">{t("actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {filtered.slice(0, 50).map((sale) => (
              <tr key={sale.id}>
                <td className="px-4 sm:px-6 py-4">
                  <input type="checkbox" checked={selected.has(sale.id)} onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(sale.id);
                    else next.delete(sale.id);
                    setSelected(next);
                  }} />
                </td>
                {editId === sale.id ? (
                  <>
                    <td className="px-6 py-3">
                      <input
                        type="number"
                        value={editData.amount}
                        onChange={(e) => setEditData({ ...editData, amount: parseFloat(e.target.value) || 0 })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-28"
                      />
                    </td>
                    <td className="px-6 py-3">
                      <select
                        value={editData.payment_method}
                        onChange={(e) => setEditData({ ...editData, payment_method: e.target.value })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
                      >
                        {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
                          <option key={m} value={m}>{t(m)}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-6 py-3">
                      <input
                        type="text"
                        value={editData.notes || ""}
                        onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                        placeholder={t("notes")}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-32"
                      />
                    </td>
                    <td className="px-6 py-3 text-right">
                      <input
                        type="date"
                        value={editData.date}
                        onChange={(e) => setEditData({ ...editData, date: e.target.value })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-36"
                      />
                    </td>
                    <td className="px-6 py-3 text-right space-x-2">
                      <button onClick={saveEdit} className="text-green-600 dark:text-green-400 text-sm font-medium hover:underline">{t("save")}</button>
                      <button onClick={() => setEditId(null)} className="text-gray-400 dark:text-gray-500 text-sm hover:underline">{t("cancel")}</button>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-6 py-4 text-sm font-semibold text-gray-800 dark:text-white">
                      {parseFloat(sale.amount).toLocaleString()} {currency}
                      {sale.item_name && (
                        <div className="text-xs font-normal text-gray-400 mt-0.5">
                          {sale.item_name} × {sale.quantity_sold} @ {parseFloat(sale.unit_price).toLocaleString()}/{currency}
                          {sale.cost_at_sale != null && (
                            <span className="ml-1.5 text-green-600 dark:text-green-400">
                              +{Math.round((sale.unit_price - sale.cost_at_sale) * sale.quantity_sold).toLocaleString()} {t("profit")}
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400 capitalize">{sale.payment_method}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{sale.notes || "—"}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 text-right">{formatDate(sale.date)}</td>
                    <td className="px-6 py-4 text-right space-x-3">
                      <button onClick={() => startEdit(sale)} className="text-blue-500 dark:text-blue-400 text-sm hover:underline">{t("edit")}</button>
                      {deleteConfirm === sale.id ? (
                        <span className="inline-flex items-center gap-1.5 bg-red-50 dark:bg-red-900/20 px-2 py-1 rounded-lg">
                          <span className="text-xs text-red-600 dark:text-red-400">{t("delete")}?</span>
                          <button onClick={() => deleteSale(sale.id)} className="text-red-600 dark:text-red-400 text-xs font-bold hover:underline">✓</button>
                          <button onClick={() => setDeleteConfirm(null)} className="text-gray-400 text-xs font-bold hover:underline">✕</button>
                        </span>
                      ) : (
                        <button onClick={() => setDeleteConfirm(sale.id)} className="text-red-400 dark:text-red-500 text-sm hover:underline">{t("moveToTrash")}</button>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={6} className="px-6 py-8 text-center text-gray-400 dark:text-gray-500">{t("noSalesYet")}</td></tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {/* Sticky selection bar */}
      {selected.size > 0 && (() => {
        const selSales = filtered.filter(s => selected.has(s.id));
        const total = selSales.reduce((sum, s) => sum + parseFloat(s.amount), 0);
        const avg = selSales.length ? total / selSales.length : 0;
        const byMethod = {};
        selSales.forEach(s => { byMethod[s.payment_method] = (byMethod[s.payment_method] || 0) + parseFloat(s.amount); });
        return (
          <div className="fixed bottom-4 left-1/2 -translate-x-1/2 z-50 bg-blue-600 dark:bg-blue-700 text-white rounded-2xl px-5 py-3 shadow-2xl shadow-blue-600/30 max-w-lg w-[calc(100%-2rem)]">
            <div className="flex items-center gap-3 mb-1.5">
              <button onClick={() => setSelected(new Set())} className="w-6 h-6 flex items-center justify-center rounded-full bg-white/20 text-white text-xs font-bold hover:bg-white/30 transition flex-shrink-0">
                &times;
              </button>
              <p className="text-sm font-semibold flex-1">
                {selected.size} {t("selected")} &middot; {total.toLocaleString()} {currency}
              </p>
              <span className="text-xs opacity-75">{t("avg")}: {Math.round(avg).toLocaleString()}</span>
            </div>
            {Object.keys(byMethod).length > 1 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {Object.entries(byMethod).sort((a, b) => b[1] - a[1]).map(([m, amt]) => (
                  <span key={m} className="px-2 py-0.5 bg-white/15 rounded-full text-[11px] capitalize">
                    {t(m)}: {amt.toLocaleString()}
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const text = `${selected.size} sales | Total: ${total.toLocaleString()} ${currency} | Avg: ${Math.round(avg).toLocaleString()} ${currency}`;
                  navigator.clipboard?.writeText(text);
                  setSuccess(t("copiedToClipboard"));
                  setTimeout(() => setSuccess(""), 2000);
                }}
                className="px-3 py-1.5 bg-white/20 rounded-lg text-xs font-medium hover:bg-white/30 transition"
              >
                {t("copySummary")}
              </button>
              <button onClick={bulkDelete} className="px-3 py-1.5 bg-red-500/80 rounded-lg text-xs font-medium hover:bg-red-500 transition">
                {t("moveToTrash")}
              </button>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

function ItemSaleModal({ items, currency, onClose, onSale }) {
  const { t } = useLanguage();
  const [search, setSearch] = useState("");
  const [selectedItem, setSelectedItem] = useState(null);
  const [qty, setQty] = useState("");
  const [price, setPrice] = useState("");
  const [method, setMethod] = useState("cash");

  const filtered = useMemo(() => {
    if (!search) return items.filter((i) => parseFloat(i.quantity) > 0).slice(0, 20);
    return items
      .filter((i) => i.name.toLowerCase().includes(search.toLowerCase()) && parseFloat(i.quantity) > 0)
      .slice(0, 20);
  }, [items, search]);

  const cost = selectedItem ? parseFloat(selectedItem.cost_per_unit) : 0;
  const qtyNum = parseFloat(qty) || 0;
  const priceNum = parseFloat(price) || 0;
  const total = qtyNum * priceNum;
  const profit = qtyNum * (priceNum - cost);
  const available = selectedItem ? parseFloat(selectedItem.quantity) : 0;

  const handleSubmit = () => {
    if (!selectedItem || !qtyNum || !priceNum) return;
    onSale({
      date: new Date().toISOString().split("T")[0],
      inventory_item_id: selectedItem.id,
      quantity_sold: qtyNum,
      unit_price: priceNum,
      payment_method: method,
      item_name: selectedItem.name,
    });
  };

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-xl max-w-md w-full p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-lg font-bold text-gray-800 dark:text-white mb-1">{t("itemSale")}</h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t("pickItemDesc")}</p>

        {!selectedItem ? (
          <>
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchInventory")}
              className="w-full px-3 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white mb-3"
              autoFocus
            />
            <div className="max-h-64 overflow-y-auto space-y-1">
              {filtered.map((item) => (
                <button
                  key={item.id}
                  onClick={() => {
                    setSelectedItem(item);
                    if (item.sell_price) setPrice(String(parseFloat(item.sell_price)));
                  }}
                  className="w-full text-left px-3 py-2.5 rounded-lg hover:bg-blue-50 dark:hover:bg-blue-900/20 transition flex items-center justify-between"
                >
                  <div>
                    <p className="text-sm font-medium text-gray-700 dark:text-gray-200">{item.name}</p>
                    <p className="text-xs text-gray-400">{item.category} · {t("cost")}: {parseFloat(item.cost_per_unit)} {currency}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-gray-600 dark:text-gray-300">{parseFloat(item.quantity)} {item.unit}</p>
                  </div>
                </button>
              ))}
              {filtered.length === 0 && (
                <p className="text-center text-gray-400 py-4 text-sm">{t("noItemsWithStock")}</p>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="bg-blue-50 dark:bg-blue-900/20 p-3 rounded-lg mb-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="font-semibold text-gray-800 dark:text-white">{selectedItem.name}</p>
                  <p className="text-xs text-gray-500 dark:text-gray-400">
                    {t("cost")}: {cost} {currency}/{selectedItem.unit} · {t("stock")}: {available} {selectedItem.unit}
                  </p>
                </div>
                <button onClick={() => { setSelectedItem(null); setQty(""); setPrice(""); }} className="text-xs text-blue-600 hover:underline">{t("change")}</button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3 mb-3">
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">{t("quantity")} ({selectedItem.unit})</label>
                <input
                  type="number"
                  value={qty}
                  onChange={(e) => setQty(e.target.value)}
                  placeholder="0"
                  max={available}
                  className="w-full px-3 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
                  autoFocus
                />
                {qtyNum > available && (
                  <p className="text-xs text-red-500 mt-1">{available} {selectedItem.unit}</p>
                )}
              </div>
              <div>
                <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">{t("sellPrice")} ({currency}/{selectedItem.unit})</label>
                <input
                  type="number"
                  value={price}
                  onChange={(e) => setPrice(e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
                />
              </div>
            </div>

            {/* Payment method */}
            <div className="flex flex-wrap gap-1.5 mb-4">
              {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
                <button
                  key={m}
                  onClick={() => setMethod(m)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border transition ${
                    method === m
                      ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-500 text-blue-700 dark:text-blue-300"
                      : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400"
                  }`}
                >
                  {t(m)}
                </button>
              ))}
            </div>

            {/* Summary */}
            {qtyNum > 0 && priceNum > 0 && (
              <div className="bg-gray-50 dark:bg-gray-700/50 p-3 rounded-lg mb-4 space-y-1">
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t("total")}</span>
                  <span className="font-bold text-gray-800 dark:text-white">{total.toLocaleString()} {currency}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t("cost")}</span>
                  <span className="text-gray-600 dark:text-gray-300">{(qtyNum * cost).toLocaleString()} {currency}</span>
                </div>
                <div className="flex justify-between text-sm">
                  <span className="text-gray-500">{t("profit")}</span>
                  <span className={`font-bold ${profit >= 0 ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                    {profit >= 0 ? "+" : ""}{profit.toLocaleString()} {currency}
                  </span>
                </div>
                {cost > 0 && (
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-500">{t("margin")}</span>
                    <span className="text-green-600 dark:text-green-400">{Math.round(((priceNum - cost) / cost) * 100)}%</span>
                  </div>
                )}
              </div>
            )}

            <div className="flex gap-3">
              <button
                onClick={onClose}
                className="flex-1 py-2.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                {t("cancel")}
              </button>
              <button
                onClick={handleSubmit}
                disabled={!qtyNum || !priceNum || qtyNum > available}
                className="flex-1 py-2.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 transition disabled:opacity-40"
              >
                {t("sell")} {total > 0 ? `(${total.toLocaleString()} ${currency})` : ""}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

function CsvUpload({ onDone }) {
  const { t } = useLanguage();
  const [result, setResult] = useState(null);
  const [uploading, setUploading] = useState(false);

  const handleFile = async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    setUploading(true);
    const formData = new FormData();
    formData.append("file", file);
    try {
      const res = await api.post("/sales/import-csv", formData);
      setResult(res.data);
      onDone();
    } catch (err) {
      setResult({ imported: 0, errors: [err.response?.data?.detail || t("uploadFailed")] });
    }
    setUploading(false);
    e.target.value = "";
  };

  return (
    <div className="bg-white dark:bg-gray-800 p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("importCsv")}</h2>
          <p className="text-xs text-gray-400 dark:text-gray-400 mt-0.5">{t("csvColumns")}</p>
        </div>
        <label className={`px-4 py-2.5 rounded-lg text-sm font-medium cursor-pointer transition ${
          uploading ? "bg-gray-100 dark:bg-gray-700 text-gray-400 dark:text-gray-500" : "bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
        }`}>
          {uploading ? t("uploading") : t("chooseFile")}
          <input type="file" accept=".csv" onChange={handleFile} className="hidden" disabled={uploading} />
        </label>
      </div>
      {result && (
        <div className="mt-3 text-sm">
          <p className="text-green-600 dark:text-green-400 font-medium">{result.imported} {t("salesImported")}</p>
          {result.errors.length > 0 && (
            <details className="mt-1">
              <summary className="text-yellow-600 dark:text-yellow-400 cursor-pointer">{result.errors.length} {t("rowsSkipped")}</summary>
              <ul className="mt-1 text-xs text-gray-500 dark:text-gray-400 space-y-0.5">
                {result.errors.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
