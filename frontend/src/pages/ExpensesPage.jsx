import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";

const QUICK_AMOUNTS = [100, 250, 500, 1000, 2500, 5000];
const DEFAULT_CATEGORIES = ["Ingredients", "Rent", "Wages", "Utilities", "Supplies", "Other"];

export default function ExpensesPage() {
  const { t } = useLanguage();
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [catId, setCatId] = useState("");
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [showSetup, setShowSetup] = useState(false);

  const fetchData = () => {
    api.get("/expenses").then((res) => setExpenses(res.data));
    api.get("/expenses/categories").then((res) => {
      setCategories(res.data);
      if (res.data.length === 0) setShowSetup(true);
    });
  };

  useEffect(() => { fetchData(); }, []);

  const quickSetup = async () => {
    for (const name of DEFAULT_CATEGORIES) {
      await api.post("/expenses/categories", { name });
    }
    setShowSetup(false);
    fetchData();
  };

  const submit = async (quickAmt) => {
    const value = quickAmt || parseFloat(amount);
    if (!value || !catId || !desc) return;
    setError("");
    try {
      await api.post("/expenses", {
        category_id: catId,
        date: new Date().toISOString().split("T")[0],
        amount: value,
        description: desc,
        is_recurring: false,
      });
      setAmount("");
      setDesc("");
      setSuccess(`${value.toLocaleString()} DKK!`);
      fetchData();
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to add expense");
    }
  };

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold text-gray-800">{t("expenseTracker")}</h1>

      {success && <div className="bg-green-50 text-green-700 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 text-red-600 px-4 py-3 rounded-xl text-sm">{error}</div>}

      {showSetup && (
        <div className="bg-blue-50 border border-blue-200 p-5 rounded-xl">
          <p className="text-blue-800 font-medium mb-2">{t("firstTimeSetup")}</p>
          <p className="text-blue-600 text-sm mb-3">{DEFAULT_CATEGORIES.join(", ")}</p>
          <button onClick={quickSetup}
            className="bg-blue-600 text-white px-5 py-2.5 rounded-lg hover:bg-blue-700 transition font-medium text-sm">
            {t("setupCategories")}
          </button>
        </div>
      )}

      <div className="bg-white p-6 rounded-xl shadow-sm border border-gray-100">
        <h2 className="text-lg font-semibold text-gray-700 mb-1">{t("addExpense")}</h2>
        <p className="text-sm text-gray-400 mb-4">{t("pickCategory")}</p>

        <div className="flex flex-wrap gap-2 mb-4">
          {categories.map((c) => (
            <button
              key={c.id}
              onClick={() => setCatId(c.id)}
              className={`px-4 py-2.5 rounded-xl text-sm font-medium border transition ${
                catId === c.id
                  ? "bg-blue-50 border-blue-300 text-blue-700"
                  : "border-gray-200 text-gray-600 hover:bg-gray-50"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>

        <input
          type="text"
          value={desc}
          onChange={(e) => setDesc(e.target.value)}
          placeholder={t("whatWasIt")}
          className="w-full px-4 py-3 border border-gray-200 rounded-xl mb-4 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />

        <div className="flex flex-wrap gap-2 mb-4">
          {QUICK_AMOUNTS.map((amt) => (
            <button
              key={amt}
              onClick={() => submit(amt)}
              disabled={!catId || !desc}
              className="px-5 py-3 rounded-xl border border-gray-200 text-sm font-semibold text-gray-700 hover:bg-blue-50 hover:border-blue-300 hover:text-blue-700 transition disabled:opacity-30"
            >
              {amt.toLocaleString()} DKK
            </button>
          ))}
        </div>

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
            disabled={!amount || !catId || !desc}
            className="px-6 py-3 bg-blue-600 text-white rounded-xl hover:bg-blue-700 transition font-semibold disabled:opacity-40"
          >
            {t("add")}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100">
          <h2 className="text-base font-semibold text-gray-700">{t("recentExpenses")}</h2>
        </div>
        <table className="w-full text-left">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("date")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("description")}</th>
              <th className="px-6 py-3 text-sm font-medium text-gray-500">{t("amount")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {expenses.slice(0, 20).map((exp) => (
              <tr key={exp.id}>
                <td className="px-6 py-4 text-sm text-gray-700">{exp.date}</td>
                <td className="px-6 py-4 text-sm text-gray-700">{exp.description}</td>
                <td className="px-6 py-4 text-sm font-semibold text-gray-800">{parseFloat(exp.amount).toLocaleString()} DKK</td>
              </tr>
            ))}
            {expenses.length === 0 && (
              <tr><td colSpan={3} className="px-6 py-8 text-center text-gray-400">{t("noExpensesYet")}</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
