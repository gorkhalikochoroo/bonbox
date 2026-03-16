import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";

const currentDate = new Date();

export default function VatReportPage() {
  const { t } = useLanguage();
  const [month, setMonth] = useState(currentDate.getMonth() + 1);
  const [year, setYear] = useState(currentDate.getFullYear());
  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const fetchReport = () => {
    setLoading(true);
    setError(null);
    api
      .get("/reports/vat-export", { params: { month, year } })
      .then((res) => setReport(res.data))
      .catch(() => setError(t("vatError")))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    fetchReport();
  }, [month, year]);

  const fmt = (val) =>
    val != null ? val.toLocaleString("da-DK", { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : "—";

  const months = [
    "Januar", "Februar", "Marts", "April", "Maj", "Juni",
    "Juli", "August", "September", "Oktober", "November", "December",
  ];

  const yearOptions = [];
  for (let y = currentDate.getFullYear(); y >= currentDate.getFullYear() - 5; y--) {
    yearOptions.push(y);
  }

  return (
    <div className="p-6 space-y-6 max-w-2xl mx-auto">
      <div className="flex flex-wrap items-center gap-3">
        <select
          value={month}
          onChange={(e) => setMonth(Number(e.target.value))}
          className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {months.map((name, i) => (
            <option key={i + 1} value={i + 1}>{name}</option>
          ))}
        </select>
        <select
          value={year}
          onChange={(e) => setYear(Number(e.target.value))}
          className="rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-800 dark:text-gray-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          {yearOptions.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      {loading && <div className="p-8 text-center text-gray-500 dark:text-gray-400">{t("loadingVat")}</div>}
      {error && <div className="p-8 text-center text-red-500">{error}</div>}

      {report && !loading && (
        <div className="bg-white dark:bg-gray-800 rounded-2xl shadow-sm border border-gray-100 dark:border-gray-700 p-6">
          <div className="text-center mb-6">
            <p className="text-sm text-gray-400 dark:text-gray-500 uppercase tracking-wide">{t("vatReport")}</p>
            <h1 className="text-xl font-bold text-gray-800 dark:text-white mt-1">
              {report.business_name || "My Business"}
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">{months[month - 1]} {year}</p>
          </div>

          <div className="space-y-3 mb-6">
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{t("salesSection")}</h2>
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">{t("salesInclVat")}</span>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{fmt(report.sales_incl_vat)} {report.currency}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">{t("salesExclVat")}</span>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{fmt(report.sales_excl_vat)} {report.currency}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">{t("outputVat")}</span>
              <span className="text-sm font-semibold text-blue-600 dark:text-blue-400">{fmt(report.output_vat)} {report.currency}</span>
            </div>
          </div>

          <div className="space-y-3 mb-6">
            <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wide">{t("expensesSection")}</h2>
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">{t("expensesInclVat")}</span>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{fmt(report.expenses_incl_vat)} {report.currency}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">{t("expensesExclVat")}</span>
              <span className="text-sm font-medium text-gray-800 dark:text-gray-200">{fmt(report.expenses_excl_vat)} {report.currency}</span>
            </div>
            <div className="flex justify-between py-2 border-b border-gray-100 dark:border-gray-700">
              <span className="text-sm text-gray-600 dark:text-gray-300">{t("inputVat")}</span>
              <span className="text-sm font-semibold text-blue-600 dark:text-blue-400">{fmt(report.input_vat)} {report.currency}</span>
            </div>
          </div>

          <div className="bg-slate-50 dark:bg-gray-700/50 rounded-xl p-4">
            <div className="flex justify-between items-center">
              <span className="text-base font-bold text-gray-800 dark:text-white">{t("vatPayable")}</span>
              <span className={`text-2xl font-extrabold ${report.vat_payable >= 0 ? "text-red-600 dark:text-red-400" : "text-green-600 dark:text-green-400"}`}>
                {fmt(report.vat_payable)} {report.currency}
              </span>
            </div>
            <p className="text-xs text-gray-400 dark:text-gray-500 mt-2">
              {report.vat_payable >= 0 ? t("payableToSkat") : t("refundFromSkat")}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
