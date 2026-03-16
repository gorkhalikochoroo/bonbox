import { useState, useEffect } from "react";
import Modal from "./Modal";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";

export default function QuickAdd() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState("sale");
  const [categories, setCategories] = useState([]);
  const [success, setSuccess] = useState("");

  const [saleAmount, setSaleAmount] = useState("");
  const [saleMethod, setSaleMethod] = useState("mixed");

  const [expAmount, setExpAmount] = useState("");
  const [expCatId, setExpCatId] = useState("");
  const [expDesc, setExpDesc] = useState("");

  const salePresets = [500, 1000, 2500, 5000, 10000];
  const expPresets = [100, 500, 1000, 2500];

  useEffect(() => {
    if (open) {
      api.get("/expenses/categories").then((res) => setCategories(res.data));
    }
  }, [open]);

  const showSuccess = (msg) => {
    setSuccess(msg);
    setTimeout(() => setSuccess(""), 2000);
  };

  const submitSale = async () => {
    if (!saleAmount) return;
    await api.post("/sales", {
      date: new Date().toISOString().split("T")[0],
      amount: parseFloat(saleAmount),
      payment_method: saleMethod,
    });
    setSaleAmount("");
    showSuccess(t("saleLogged"));
  };

  const submitExpense = async () => {
    if (!expAmount || !expCatId || !expDesc) return;
    await api.post("/expenses", {
      category_id: expCatId,
      date: new Date().toISOString().split("T")[0],
      amount: parseFloat(expAmount),
      description: expDesc,
      is_recurring: false,
    });
    setExpAmount("");
    setExpDesc("");
    showSuccess(t("expenseAdded"));
  };

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-6 right-6 z-40 w-14 h-14 bg-blue-600 text-white rounded-full shadow-lg hover:bg-blue-700 hover:scale-105 transition-all flex items-center justify-center text-3xl font-light"
      >
        +
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={t("quickEntry")}>
        {success && (
          <div className="bg-green-50 text-green-700 px-4 py-2.5 rounded-lg mb-4 text-sm font-medium text-center">
            {success}
          </div>
        )}

        <div className="flex bg-gray-100 rounded-lg p-1 mb-5">
          <button
            onClick={() => setTab("sale")}
            className={`flex-1 py-2.5 rounded-md text-sm font-medium transition ${
              tab === "sale" ? "bg-white shadow text-blue-700" : "text-gray-500"
            }`}
          >
            {t("logSaleTab")}
          </button>
          <button
            onClick={() => setTab("expense")}
            className={`flex-1 py-2.5 rounded-md text-sm font-medium transition ${
              tab === "expense" ? "bg-white shadow text-blue-700" : "text-gray-500"
            }`}
          >
            {t("addExpenseTab")}
          </button>
        </div>

        {tab === "sale" ? (
          <div className="space-y-4">
            <div>
              <p className="text-xs text-gray-500 mb-2">{t("quickAmount")}</p>
              <div className="flex flex-wrap gap-2">
                {salePresets.map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setSaleAmount(String(amt))}
                    className={`px-4 py-2.5 rounded-lg text-sm font-medium border transition ${
                      saleAmount === String(amt)
                        ? "bg-blue-50 border-blue-300 text-blue-700"
                        : "border-gray-200 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {amt.toLocaleString()}
                  </button>
                ))}
              </div>
            </div>

            <input
              type="number"
              value={saleAmount}
              onChange={(e) => setSaleAmount(e.target.value)}
              placeholder={t("orTypeAmount")}
              className="w-full px-4 py-3 border border-gray-200 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              autoFocus
            />

            <div className="flex gap-2">
              {["cash", "card", "mobilepay", "mixed", "dankort", "kontant"].map((m) => (
                <button
                  key={m}
                  onClick={() => setSaleMethod(m)}
                  className={`flex-1 py-2.5 rounded-lg text-xs font-medium capitalize border transition ${
                    saleMethod === m
                      ? "bg-blue-50 border-blue-300 text-blue-700"
                      : "border-gray-200 text-gray-500 hover:bg-gray-50"
                  }`}
                >
                  {m}
                </button>
              ))}
            </div>

            <button
              onClick={submitSale}
              disabled={!saleAmount}
              className="w-full bg-blue-600 text-white py-3.5 rounded-xl hover:bg-blue-700 transition font-semibold text-base disabled:opacity-40"
            >
              {t("logSale")}
            </button>
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <p className="text-xs text-gray-500 mb-2">{t("category")}</p>
              <div className="flex flex-wrap gap-2">
                {categories.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setExpCatId(c.id)}
                    className={`px-4 py-2.5 rounded-lg text-sm font-medium border transition ${
                      expCatId === c.id
                        ? "bg-blue-50 border-blue-300 text-blue-700"
                        : "border-gray-200 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
                {categories.length === 0 && (
                  <p className="text-sm text-gray-400">{t("addCategoriesFirst")}</p>
                )}
              </div>
            </div>

            <div>
              <p className="text-xs text-gray-500 mb-2">{t("quickAmount")}</p>
              <div className="flex flex-wrap gap-2">
                {expPresets.map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setExpAmount(String(amt))}
                    className={`px-4 py-2.5 rounded-lg text-sm font-medium border transition ${
                      expAmount === String(amt)
                        ? "bg-blue-50 border-blue-300 text-blue-700"
                        : "border-gray-200 text-gray-600 hover:bg-gray-50"
                    }`}
                  >
                    {amt.toLocaleString()}
                  </button>
                ))}
              </div>
            </div>

            <input
              type="number"
              value={expAmount}
              onChange={(e) => setExpAmount(e.target.value)}
              placeholder={t("orTypeAmount")}
              className="w-full px-4 py-3 border border-gray-200 rounded-xl text-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />

            <input
              type="text"
              value={expDesc}
              onChange={(e) => setExpDesc(e.target.value)}
              placeholder={t("whatForExpense")}
              className="w-full px-4 py-3 border border-gray-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            />

            <button
              onClick={submitExpense}
              disabled={!expAmount || !expCatId || !expDesc}
              className="w-full bg-blue-600 text-white py-3.5 rounded-xl hover:bg-blue-700 transition font-semibold text-base disabled:opacity-40"
            >
              {t("addExpense")}
            </button>
          </div>
        )}
      </Modal>
    </>
  );
}
