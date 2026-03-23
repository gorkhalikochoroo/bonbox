import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { getVatTerms } from "../utils/currency";

const currentDate = new Date();

export default function VatReportPage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const vat = getVatTerms(user?.currency);
  const [mode, setMode] = useState("monthly"); // "monthly" or "quarterly"
  const [month, setMonth] = useState(currentDate.getMonth() + 1);
  const [quarter, setQuarter] = useState(Math.ceil((currentDate.getMonth() + 1) / 3));
  const [year, setYear] = useState(currentDate.getFullYear());
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [downloading, setDownloading] = useState(false);

  const fetchReport = () => {
    setLoading(true);
    setError(null);
    const params = { year };
    if (mode === "quarterly") {
      params.quarter = quarter;
    } else {
      params.month = month;
    }
    api
      .get("/reports/vat-export", { params })
      .then((res) => setReport(res.data))
      .catch(() => setError(t("vatError")))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchReport();
  }, [month, quarter, year, mode]);

  const downloadPdf = async () => {
    setDownloading(true);
    try {
      const params = { year };
      if (mode === "quarterly") {
        params.quarter = quarter;
      } else {
        params.month = month;
      }
      const res = await api.get("/reports/vat-export/pdf", {
        params,
        responseType: "blob",
      });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const a = document.createElement("a");
      a.href = url;
      a.download = mode === "quarterly"
        ? `${vat.vatName}_Q${quarter}_${year}.pdf`
        : `${vat.vatName}_${months[month - 1]}_${year}.pdf`;
      a.click();
      window.URL.revokeObjectURL(url);
    } catch {
      setError("Failed to download PDF");
      setTimeout(() => setError(null), 3000);
    } finally {
      setDownloading(false);
    }
  };

  const fmt = (val) =>
    val != null ? val.toLocaleString(vat.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";

  const months = [
    "Januar", "Februar", "Marts", "April", "Maj", "Juni",
    "Juli", "August", "September", "Oktober", "November", "December",
  ];

  const quarters = [
    { value: 1, label: "Q1 (Jan-Mar)" },
    { value: 2, label: "Q2 (Apr-Jun)" },
    { value: 3, label: "Q3 (Jul-Sep)" },
    { value: 4, label: "Q4 (Oct-Dec)" },
  ];

  const yearOptions = [];
  for (let y = currentDate.getFullYear(); y >= currentDate.getFullYear() - 5; y--) {
    yearOptions.push(y);
  }

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-2xl mx-auto">
      {/* Mode toggle + selectors */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
          <button
            onClick={() => setMode("monthly")}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition ${
              mode === "monthly"
                ? "bg-white dark:bg-gray-600 text-gray-800 dark:text-white shadow-sm"
                : "text-gray-500 dark:text-gray-400"
            }`}
          >
            Monthly
          </button>
          <button
            onClick={() => setMode("quarterly")}
            className={`px-3 py-1.5 rounded-md text-sm font-medium transition ${
              mode === "quarterly"
                ? "bg-white dark:bg-gray-600 text-gray-800 dark:text-white shadow-sm"
                : "text-gray-500 dark:text-gray-400"
            }`}
          >
            Quarterly
          </button>
        </div>

        {mode === "monthly" ? (
          <select
            value={month}
            onChange={(e) => setMonth(Number(e.target.value))}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {months.map((name, i) => (
              <option key={i + 1} value={i + 1}>{name}</option>
            ))}
          </select>
        ) : (
          <select
            value={quarter}
            onChange={(e) => setQuarter(Number(e.target.value))}
            className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {quarters.map((q) => (
              <option key={q.value} value={q.value}>{q.label}</option>
            ))}
          </select>
        )}

        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {yearOptions.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>

        <button
          onClick={downloadPdf}
          disabled={downloading || !report}
          className="ml-auto px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium hover:bg-purple-700 transition disabled:opacity-50 inline-flex items-center gap-2"
        >
          <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
          </svg>
          {downloading ? "Downloading..." : "Download PDF"}
        </button>
      </div>

      {loading && <div className="p-8 text-center text-gray-500 dark:text-gray-400">{t("loadingVat")}</div>}
      {error && <div className="p-4 bg-red-50 dark:bg-red-900/20 text-red-600 dark:text-red-400 rounded-lg text-sm">{error}</div>}

      {report && !loading && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <div className="text-center mb-6">
            <p className="text-sm text-gray-400 dark:text-gray-500 uppercase tracking-wide">{vat.reportTitle}</p>
            <h1 className="text-xl font-bold text-gray-800 dark:text-white mt-1">
              {report.business_name || "My Business"}
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{report.period}</p>
            {report.vat_rate_pct !== undefined && (
              <p className="text-xs text-gray-400 dark:text-gray-500 mt-1">{vat.vatName} Rate: {report.vat_rate_pct}%</p>
            )}
          </div>

          <div className="space-y-3 mb-6">
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{vat.salesSection}</h2>
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">{vat.salesInclVat}</span>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{fmt(report.sales_incl_vat)} {report.currency}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">{vat.salesExclVat}</span>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{fmt(report.sales_excl_vat)} {report.currency}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">{vat.outputVat}</span>
              <span className="text-sm font-semibold text-blue-600 dark:text-blue-400">{fmt(report.output_vat)} {report.currency}</span>
            </div>
          </div>

          <div className="space-y-3 mb-6">
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{vat.expensesSection}</h2>
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">{vat.expensesInclVat}</span>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{fmt(report.expenses_incl_vat)} {report.currency}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">{vat.expensesExclVat}</span>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{fmt(report.expenses_excl_vat)} {report.currency}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">{vat.inputVat}</span>
              <span className="text-sm font-semibold text-blue-600 dark:text-blue-400">{fmt(report.input_vat)} {report.currency}</span>
            </div>
          </div>

          {/* Expense breakdown */}
          {report.expense_breakdown?.length > 0 && (
            <div className="mb-6">
              <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide mb-3">{vat.expensesSection} {vat.vatName} Breakdown</h2>
              <div className="space-y-2">
                {report.expense_breakdown.map(([name, total]) => {
                  const catVat = report.vat_rate > 0 ? total * report.vat_rate / (1 + report.vat_rate) : 0;
                  return (
                    <div key={name} className="flex justify-between py-1.5 text-sm">
                      <span className="text-gray-600 dark:text-gray-300">{name}</span>
                      <span className="text-gray-500 dark:text-gray-400">
                        {fmt(total)} ({vat.inputVat}: {fmt(catVat)}) {report.currency}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="bg-slate-50 dark:bg-gray-700/50 rounded-xl p-4">
            <div className="flex justify-between items-center">
              <span className="text-base font-bold text-gray-800 dark:text-white">{vat.vatPayable}</span>
              <span className={`text-2xl font-extrabold ${report.vat_payable >= 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}>
                {fmt(report.vat_payable)} {report.currency}
              </span>
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
              {report.vat_payable >= 0 ? vat.payableTo : vat.refundFrom}
            </p>
          </div>

          <p className="text-xs text-gray-400 dark:text-gray-500 mt-4 text-center">
            ⚠️ This is an estimate for reference only. Consult your accountant before submitting to {vat.taxAuthority}.
          </p>
        </div>
      )}
    </div>
  );
}
