import { useState, useEffect } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { getVatTerms } from "../utils/currency";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";

const currentDate = new Date();

const SECTION_DEFS = [
  { key: "sales_breakdown", labelKey: "salesBreakdown", desc: "Payment methods, daily revenue, weekday analysis", icon: "M9 19v-6a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2a2 2 0 002-2zm0 0V9a2 2 0 012-2h2a2 2 0 012 2v10m-6 0a2 2 0 002 2h2a2 2 0 002-2m0 0V5a2 2 0 012-2h2a2 2 0 012 2v14a2 2 0 01-2 2h-2a2 2 0 01-2-2z" },
  { key: "expense_breakdown", labelKey: "expenseBreakdown", desc: "Costs by category with charts", icon: "M17 9V7a2 2 0 00-2-2H5a2 2 0 00-2 2v6a2 2 0 002 2h2m2 4h10a2 2 0 002-2v-6a2 2 0 00-2-2H9a2 2 0 00-2 2v6a2 2 0 002 2zm7-5a2 2 0 11-4 0 2 2 0 014 0z" },
  { key: "inventory", labelKey: "inventoryReport", desc: "Stock levels, values, and low stock alerts", icon: "M20 7l-8-4-8 4m16 0l-8 4m8-4v10l-8 4m0-10L4 7m8 4v10M4 7v10l8 4" },
  { key: "vat_detail", labelKey: null, desc: "Full tax breakdown for tax office", icon: "M9 7h6m0 10v-3m-3 3h.01M9 17h.01M9 14h.01M12 14h.01M15 11h.01M12 11h.01M9 11h.01M7 21h10a2 2 0 002-2V5a2 2 0 00-2-2H7a2 2 0 00-2 2v14a2 2 0 002 2z" },
  { key: "khata_summary", labelKey: "khataSummary", desc: "Customer credit balances and debtors", icon: "M12 6.253v13m0-13C10.832 5.477 9.246 5 7.5 5S4.168 5.477 3 6.253v13C4.168 18.477 5.754 18 7.5 18s3.332.477 4.5 1.253" },
  { key: "cash_flow", labelKey: "cashFlow", desc: "Cash in, cash out, and net flow", icon: "M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z" },
  { key: "waste", labelKey: "wasteReport", desc: "Waste costs by reason", icon: "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" },
  { key: "staff_costs", labelKey: "staffRules", desc: "Staffing rules by revenue level", icon: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z" },
];

export default function ReportsPage() {
  const { user } = useAuth();
  const vat = getVatTerms(user?.currency);
  const { t } = useLanguage();
  const [tab, setTab] = useState("daily");
  const months = [t("january"),t("february"),t("march"),t("april"),t("may"),t("june"),t("july"),t("august"),t("september"),t("october"),t("november"),t("december")];
  const [month, setMonth] = useState(currentDate.getMonth() + 1);
  const [year, setYear] = useState(currentDate.getFullYear());
  const [overview, setOverview] = useState(null);
  const [loading, setLoading] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [error, setError] = useState(null);
  const [selected, setSelected] = useState(new Set(SECTION_DEFS.map(s => s.key)));

  const yearOptions = [];
  for (let y = currentDate.getFullYear(); y >= currentDate.getFullYear() - 5; y--) yearOptions.push(y);

  const fetchOverview = () => {
    setLoading(true);
    setError(null);
    api.get("/reports/overview", { params: { month, year } })
      .then(res => setOverview(res.data))
      .catch(() => setError("Failed to load overview"))
      .finally(() => setLoading(false));
  };

  useEffect(() => { fetchOverview(); }, [month, year]);

  const toggleSection = (key) => {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(SECTION_DEFS.map(s => s.key)));
  const selectNone = () => setSelected(new Set());

  const downloadPdf = async () => {
    setDownloading(true);
    setError(null);
    try {
      const res = await api.post("/reports/custom-pdf",
        { year, month, sections: [...selected] },
        { responseType: "blob" }
      );
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = `BonBox_Report_${months[month-1]}_${year}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      setError("Failed to generate PDF");
      setTimeout(() => setError(null), 4000);
    } finally {
      setDownloading(false);
    }
  };

  const fmt = (v) => v != null ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 0 }) : "—";
  const cur = user?.currency?.startsWith("EUR_") ? "EUR" : (user?.currency || "DKK");

  const sections = SECTION_DEFS.map(s => ({
    ...s,
    label: s.labelKey ? t(s.labelKey) : `${vat.vatName} Detail`,
  }));

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-4xl mx-auto">
      {/* Tab Switcher */}
      <div className="flex gap-2">
        <button onClick={() => setTab("daily")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${tab === "daily" ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"}`}>
          {t("dailyReport")}
        </button>
        <button onClick={() => setTab("monthly")}
          className={`px-4 py-2 rounded-lg text-sm font-medium transition ${tab === "monthly" ? "bg-blue-600 text-white" : "bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 hover:bg-gray-200 dark:hover:bg-gray-700"}`}>
          {t("monthlyReport")}
        </button>
      </div>

      {tab === "daily" && <DailyKasserapport />}

      {tab === "monthly" && <>
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("reportBuilder")}</h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            {t("buildCustomReport")}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select value={month} onChange={e => setMonth(Number(e.target.value))}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            {months.map((name, i) => <option key={i+1} value={i+1}>{name}</option>)}
          </select>
          <select value={year} onChange={e => setYear(Number(e.target.value))}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
            {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">{error}</div>
      )}

      {/* Overview Cards */}
      {loading ? (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          {[1,2,3,4].map(i => (
            <div key={i} className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700 animate-pulse">
              <div className="h-3 bg-gray-200 dark:bg-gray-700 rounded w-20 mb-3" />
              <div className="h-6 bg-gray-200 dark:bg-gray-700 rounded w-24" />
            </div>
          ))}
        </div>
      ) : overview && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <OverviewCard label={t("revenue")} value={fmt(overview.revenue)} sub={`${fmt(overview.total_sales_count)} sales`} color="blue" />
          <OverviewCard label={t("expenses")} value={fmt(overview.expenses)} sub={`${fmt(overview.total_expense_count)} entries`} color="red" />
          <OverviewCard label={t("netProfit")} value={fmt(overview.net_profit)} sub={overview.revenue > 0 ? `${Math.round((overview.net_profit/overview.revenue)*100)}% margin` : "—"} color={overview.net_profit >= 0 ? "green" : "red"} />
          <OverviewCard label={`${vat.vatName} Payable`} value={fmt(overview.vat_payable)} sub={`To ${vat.taxAuthority}`} color="purple" />
          <OverviewCard label={t("stockValue")} value={fmt(overview.inventory_value)} sub={`${overview.low_stock_count} ${t("lowStock")}`} color="amber" />
          <OverviewCard label={t("khataOutstanding")} value={fmt(overview.khata_outstanding)} sub={t("creditOwed")} color="orange" />
          <OverviewCard label={t("cashIn")} value={fmt(overview.cash_in)} color="emerald" />
          <OverviewCard label={t("cashOut")} value={fmt(overview.cash_out)} color="rose" />
        </div>
      )}

      {/* Section Selection */}
      <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-5">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-semibold text-gray-800 dark:text-white">{t("selectSections")}</h2>
            <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
              {t("overviewAlwaysIncluded")}
            </p>
          </div>
          <div className="flex gap-2">
            <button onClick={selectAll} className="text-xs text-blue-600 dark:text-blue-400 hover:underline">{t("all")}</button>
            <span className="text-gray-300 dark:text-gray-600">|</span>
            <button onClick={selectNone} className="text-xs text-gray-500 dark:text-gray-400 hover:underline">{t("noneSelect")}</button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
          {sections.map(s => {
            const on = selected.has(s.key);
            return (
              <button key={s.key} onClick={() => toggleSection(s.key)}
                className={`flex items-start gap-3 p-3 rounded-xl border text-left transition-all ${
                  on
                    ? "border-blue-500 bg-blue-50 dark:bg-blue-900/20 dark:border-blue-500/50"
                    : "border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600"
                }`}
              >
                <div className={`w-10 h-10 rounded-lg flex items-center justify-center flex-shrink-0 ${
                  on ? "bg-blue-100 dark:bg-blue-800/40" : "bg-gray-100 dark:bg-gray-700"
                }`}>
                  <svg className={`w-5 h-5 ${on ? "text-blue-600 dark:text-blue-400" : "text-gray-400 dark:text-gray-500"}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d={s.icon} />
                  </svg>
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className={`text-sm font-medium ${on ? "text-blue-700 dark:text-blue-300" : "text-gray-700 dark:text-gray-300"}`}>
                      {s.label}
                    </span>
                    {on && (
                      <svg className="w-4 h-4 text-blue-500" fill="currentColor" viewBox="0 0 20 20">
                        <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd"/>
                      </svg>
                    )}
                  </div>
                  <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">{s.desc}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* Download Button */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-5">
        <div>
          <p className="text-sm text-gray-700 dark:text-gray-300">
            <span className="font-semibold">{selected.size + 1}</span> {t("sectionsSelected")}
            <span className="text-gray-400 dark:text-gray-500 ml-1">({t("includingOverview")})</span>
          </p>
          <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
            {months[month-1]} {year} &middot; {cur}
          </p>
        </div>
        <button onClick={downloadPdf} disabled={downloading}
          className="w-full sm:w-auto px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 transition disabled:opacity-50 flex items-center justify-center gap-2 shadow-lg shadow-blue-600/20">
          {downloading ? (
            <>
              <svg className="w-5 h-5 animate-spin" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              {t("generatingPdf")}
            </>
          ) : (
            <>
              <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
              </svg>
              {t("downloadReportPdf")}
            </>
          )}
        </button>
      </div>

      {/* Disclaimer */}
      <p className="text-xs text-center text-gray-400 dark:text-gray-500">
        {t("reportsDisclaimer")}
      </p>
      </>}
    </div>
  );
}

function DailyKasserapport() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const currency = displayCurrency(user?.currency);
  const [reportDate, setReportDate] = useState(new Date().toISOString().split("T")[0]);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setLoading(true);
    api.get("/reports/daily-kasserapport", { params: { report_date: reportDate } })
      .then(res => setData(res.data))
      .catch(() => setData(null))
      .finally(() => setLoading(false));
  }, [reportDate]);

  const fmt = (v) => v != null ? Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 }) : "0";
  const METHODS = ["cash", "card", "mobilepay", "dankort", "mixed"];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("dailyKasserapport")}</h1>
        <input type="date" value={reportDate} onChange={e => setReportDate(e.target.value)}
          className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-3 py-2 text-sm" />
      </div>

      {loading ? (
        <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 text-center border border-gray-100 dark:border-gray-700">
          <div className="inline-block w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : data ? (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden print:shadow-none print:border-none">
          {/* Receipt Header */}
          <div className="text-center py-6 border-b border-dashed border-gray-200 dark:border-gray-700">
            <h2 className="text-lg font-bold text-gray-800 dark:text-white tracking-wide">{t("kasserapport")}</h2>
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-300 mt-1">{data.business_name}</p>
            <p className="text-xs text-gray-400 mt-1">{new Date(data.date).toLocaleDateString("da-DK", { weekday: "long", year: "numeric", month: "long", day: "numeric" })}</p>
          </div>

          {data.transaction_count === 0 ? (
            <div className="py-12 text-center text-gray-400 dark:text-gray-500">{t("noSalesOnDate")}</div>
          ) : (
            <div className="font-mono text-sm">
              {/* Revenue Section */}
              <div className="px-6 py-4 space-y-2">
                <Row label={t("subtotal")} value={`${fmt(data.subtotal)} ${currency}`} />
                <Row label={`${data.vat_name} ${data.vat_rate}%`} value={`${fmt(data.vat_amount)} ${currency}`} />
                <div className="border-t border-gray-200 dark:border-gray-700 pt-2">
                  <Row label={t("totalInclVat")} value={`${fmt(data.total)} ${currency}`} bold />
                </div>
              </div>

              {/* Payment Breakdown */}
              <div className="px-6 py-4 border-t border-dashed border-gray-200 dark:border-gray-700 space-y-2">
                <p className="text-xs font-bold text-gray-500 dark:text-gray-400 uppercase tracking-wider mb-3">{t("paymentBreakdown")}</p>
                {METHODS.map(m => {
                  const amt = data.payment_breakdown[m];
                  if (!amt) return null;
                  return <Row key={m} label={t(m)} value={`${fmt(amt)} ${currency}`} />;
                })}
                {Object.entries(data.payment_breakdown).filter(([k]) => !METHODS.includes(k)).map(([k, v]) => (
                  <Row key={k} label={k} value={`${fmt(v)} ${currency}`} />
                ))}
              </div>

              {/* Transactions */}
              <div className="px-6 py-4 border-t border-dashed border-gray-200 dark:border-gray-700 space-y-2">
                <Row label={t("transactionCount")} value={data.transaction_count} />
              </div>

              {/* Expenses & Net */}
              <div className="px-6 py-4 border-t border-dashed border-gray-200 dark:border-gray-700 space-y-2">
                <Row label={t("expensesTotal")} value={`${fmt(data.expenses_total)} ${currency}`} />
                <div className="border-t border-gray-200 dark:border-gray-700 pt-2">
                  <Row label={t("netCash")} value={`${fmt(data.net_cash)} ${currency}`} bold
                    color={data.net_cash >= 0 ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"} />
                </div>
              </div>

              {/* Footer */}
              <div className="text-center py-4 border-t border-dashed border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-400">***** {t("kasserapport").toUpperCase()} *****</p>
              </div>
            </div>
          )}

          {/* Print Button */}
          <div className="px-6 py-4 border-t border-gray-100 dark:border-gray-700 print:hidden">
            <button onClick={() => window.print()}
              className="w-full py-2.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-lg text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition flex items-center justify-center gap-2">
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z" />
              </svg>
              {t("printReport")}
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Row({ label, value, bold, color }) {
  return (
    <div className="flex justify-between items-center">
      <span className={`${bold ? "font-bold text-gray-800 dark:text-white" : "text-gray-600 dark:text-gray-400"}`}>{label}</span>
      <span className={`${bold ? "font-bold" : ""} ${color || "text-gray-800 dark:text-white"}`}>{value}</span>
    </div>
  );
}

function OverviewCard({ label, value, sub, color = "blue" }) {
  const colorMap = {
    blue: "text-blue-600 dark:text-blue-400",
    green: "text-green-600 dark:text-green-400",
    red: "text-red-600 dark:text-red-400",
    purple: "text-purple-600 dark:text-purple-400",
    amber: "text-amber-600 dark:text-amber-400",
    orange: "text-orange-600 dark:text-orange-400",
    emerald: "text-emerald-600 dark:text-emerald-400",
    rose: "text-rose-600 dark:text-rose-400",
  };
  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl p-4 border border-gray-100 dark:border-gray-700">
      <p className="text-xs text-gray-500 dark:text-gray-400 font-medium">{label}</p>
      <p className={`text-xl font-bold mt-1 ${colorMap[color] || colorMap.blue}`}>{value}</p>
      {sub && <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-0.5">{sub}</p>}
    </div>
  );
}
