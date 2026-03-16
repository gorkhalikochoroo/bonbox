import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import ReceiptCapture from "../components/ReceiptCapture";

const QUICK_AMOUNTS = [500, 1000, 2500, 5000, 7500, 10000, 15000];

export default function SalesPage() {
  const { t } = useLanguage();
  const [sales, setSales] = useState([]);
  const [amount, setAmount] = useState("");
  const [method, setMethod] = useState("mixed");
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const fetchSales = () => api.get("/sales").then((res) => setSales(res.data));
  useEffect(() => { fetchSales(); }, []);

  const submit = async (amt) => {
    const value = amt || parseFloat(amount);
    if (!value) return;
    setError("");
    try {
      await api.post("/sales", {
        date: new Date().toISOString().split("T")[0],
        amount: value,
        payment_method: method,
      });
      setAmount("");
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

      {success && <div className="bg-green-50 text-green-700 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 text-red-600 px-4 py-3 rounded-xl text-sm">{error}</div>}

      {/* Quick Entry */}
      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
        <h2 className="text-lg font-semibold text-gray-700 mb-1">{t("logSale")}</h2>
        <p className="text-sm text-gray-400 mb-4">{t("tapAmount")}</p>

        {/* One-tap amounts */}
        <div className="flex flex-wrap gap-2 mb-4">
          {QUICK_AMOUNTS.map((amt) => (
            <button
              key={amt}
              onClick={() => submit(amt)}
              className="px-5 py-3 rounded-xl border border-gray-200 text-sm font-semibold text-gray-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 transition"
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
            className="flex-1 px-4 py-3 border border-gray-200 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
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
        <div className="flex gap-2 mt-3">
          {["cash", "card", "mobilepay", "mixed", "dankort", "kontant"].map((m) => (
            <button
              key={m}
              onClick={() => setMethod(m)}
              className={`flex-1 py-2.5 rounded-lg text-xs font-medium capitalize border transition ${
                method === m
                  ? "bg-blue-50 border-blue-300 text-blue-700"
                  : "border-gray-200 text-gray-500 hover:bg-gray-50"
              }`}
            >
              {m}
            </button>
          ))}
        </div>
      </div>

      {/* CSV Import */}
      <CsvUpload onDone={fetchSales} />

      {/* Recent Sales */}
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-700">{t("recentSales")}</h2>
        </div>
        <table className="w-full text-left">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("date")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("amount")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("payment")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {sales.slice(0, 20).map((sale) => (
              <tr key={sale.id}>
                <td className="px-6 py-4 text-sm text-gray-700">{sale.date}</td>
                <td className="px-6 py-4 text-sm font-semibold text-gray-800">{parseFloat(sale.amount).toLocaleString()} DKK</td>
                <td className="px-6 py-4 text-sm text-gray-600 capitalize">{sale.payment_method}</td>
              </tr>
            ))}
            {sales.length === 0 && (
              <tr><td colSpan={3} className="px-6 py-8 text-center text-gray-400">{t("noSalesYet")}</td></tr>
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
    <div className="bg-white p-5 rounded-xl shadow-sm border border-gray-100">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-gray-700">{t("importCsv")}</h2>
          <p className="text-xs text-gray-400 mt-0.5">{t("csvColumns")}</p>
        </div>
        <label className={`px-4 py-2.5 rounded-lg text-sm font-medium cursor-pointer transition ${
          uploading ? "bg-gray-100 text-gray-400" : "bg-gray-100 text-gray-700 hover:bg-gray-200"
        }`}>
          {uploading ? t("uploading") : t("chooseFile")}
          <input type="file" accept=".csv" onChange={handleFile} className="hidden" disabled={uploading} />
        </label>
      </div>
      {result && (
        <div className="mt-3 text-sm">
          <p className="text-green-600 font-medium">{result.imported} {t("salesImported")}</p>
          {result.errors.length > 0 && (
            <details className="mt-1">
              <summary className="text-yellow-600 cursor-pointer">{result.errors.length} {t("rowsSkipped")}</summary>
              <ul className="mt-1 text-xs text-gray-500 space-y-0.5">
                {result.errors.map((err, i) => <li key={i}>{err}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
