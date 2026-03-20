import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import ReceiptCapture from "../components/ReceiptCapture";

const QUICK_AMOUNTS = [500, 1000, 2500, 5000, 7500, 10000, 15000];

export default function SalesPage() {
  const { t } = useLanguage();
  const [sales, setSales] = useState([]);
  const [amount, setAmount] = useState("");
  const [saleDate, setSaleDate] = useState(new Date().toISOString().split("T")[0]);
  const [method, setMethod] = useState("mixed");
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [fetchError, setFetchError] = useState("");

  const fetchSales = async () => {
    try {
      setFetchError("");
      const res = await api.get("/sales");
      setSales(res.data);
    } catch (err) {
      setFetchError(err.response?.data?.detail || "Failed to load sales");
    }
  };
  useEffect(() => { fetchSales(); }, []);

  const submit = async (amt) => {
    const value = amt || parseFloat(amount);
    if (!value) return;
    setError("");
    try {
      await api.post("/sales", {
        date: saleDate,
        amount: value,
        payment_method: method,
      });
      setAmount("");
      setSaleDate(new Date().toISOString().split("T")[0]);
      setSuccess(`${value.toLocaleString()} DKK!`);
      fetchSales();
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add sale");
    }
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">{t("salesTracker")}</h1>
        <ReceiptCapture onSaleCreated={fetchSales} />
      </div>

      {success && <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{error}</div>}
      {fetchError && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">{fetchError}</div>}

      {/* Quick Entry */}
      <div className="bg-white dark:bg-gray-800 p-6 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <h2 className="text-lg font-semibold text-gray-700 dark:text-gray-300 mb-1">{t("logSale")}</h2>
        <p className="text-sm text-gray-400 dark:text-gray-400 mb-4">{t("tapAmount")}</p>

        {/* One-tap amounts */}
        <div className="flex flex-wrap gap-2 mb-4">
          {QUICK_AMOUNTS.map((amt) => (
            <button
              key={amt}
              onClick={() => submit(amt)}
              className="px-5 py-3 rounded-xl border border-gray-200 dark:border-gray-600 text-sm font-semibold text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:border-blue-300 dark:hover:border-blue-500 hover:text-blue-700 dark:hover:text-blue-300 transition"
            >
              {amt.toLocaleString()} DKK
            </button>
          ))}
        </div>

        {/* Custom amount */}
        <div className="flex gap-3">
          <input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder={t("customAmount")}
            className="flex-1 px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl text-lg dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button
            onClick={() => submit()}
            disabled={!amount}
            className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition font-semibold disabled:opacity-40"
          >
            {t("log")}
          </button>
        </div>

        {/* Payment method */}
        <div className="flex flex-wrap gap-2 mt-3">
          {["cash", "card", "mobilepay", "mixed", "dankort", "kontant"].map((m) => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              className={`flex-1 min-w-[4.5rem] py-2.5 rounded-lg text-xs font-medium capitalize border transition ${
                method === m
                  ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-500 text-blue-700 dark:text-blue-300"
                  : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              }`}
            >
              {m}
            </button>
          ))}
        </div>

        {/* Date picker */}
        <div className="mt-3 flex items-center gap-3">
          <label className="text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}:</label>
          <input
            type="date"
            value={saleDate}
            max={new Date().toISOString().split("T")[0]}
            onChange={(e) => setSaleDate(e.target.value)}
            className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          {saleDate !== new Date().toISOString().split("T")[0] && (
            <span className="text-xs text-amber-600 dark:text-amber-400 font-medium">Backdated entry</span>
          )}
        </div>
      </div>

      {/* CSV Import */}
      <CsvUpload onDone={fetchSales} />

      {/* Recent Sales */}
      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700">
          <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("recentSales")}</h2>
        </div>
        <table className="w-full text-left">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("date")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("amount")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("payment")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {sales.slice(0, 20).map((sale) => (
              <tr key={sale.id}>
                <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">{sale.date}</td>
                <td className="px-6 py-4 text-sm font-semibold text-gray-800 dark:text-white">{parseFloat(sale.amount).toLocaleString()} DKK</td>
                <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400 capitalize">{sale.payment_method}</td>
              </tr>
            ))}
            {sales.length === 0 && (
              <tr><td colSpan={3} className="px-6 py-8 text-center text-gray-400 dark:text-gray-500">{t("noSalesYet")}</td></tr>
            )}
          </tbody>
        </table>
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
      setResult({ imported: 0, errors: [err.response?.data?.detail || "Upload failed"] });
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
