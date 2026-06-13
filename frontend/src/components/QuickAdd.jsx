import { useState, useEffect, lazy, Suspense } from "react";
import { ScanLine } from "lucide-react";
import Modal from "./Modal";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { localIso } from "../utils/dateFormat";
import { trackEvent } from "../hooks/useEventLog";
// Lazy-load Smart Scan modal — only fetched when the owner taps the
// "Smart skan" entry below. Keeps QuickAdd's bundle lean for owners
// who use the keypad path 99% of the time.
const SmartScanModal = lazy(() => import("./SmartScanModal"));

const INCOME_CATS = ["Salary", "Freelance", "Side Income", "Gift Received", "Borrowed"];
const PERSONAL_CATEGORIES = [
  "Salary", "Freelance", "Side Income", "Gift Received",
  "Groceries", "Rent", "Transport", "Loan Payment", "EMI",
  "Borrowed", "Lent Out", "Utilities", "Food & Dining",
  "Shopping", "Entertainment", "Health", "Gym & Fitness",
  "Education", "Subscriptions", "Insurance", "Phone & Internet",
  "Clothing", "Personal Care", "Family", "Savings", "Investment", "Other",
];

export default function QuickAdd() {
  const { t } = useLanguage();
  const [open, setOpen] = useState(false);
  // Smart Scan handoff — opening the smart-scan modal from inside
  // QuickAdd closes the quick-add Modal so the two don't stack. The
  // Smart Scan modal is mounted at the same component level so its
  // onClose can re-focus the FAB and the body-scroll lock stays sane.
  const [smartScanOpen, setSmartScanOpen] = useState(false);
  const mode = localStorage.getItem("bonbox_mode") || "business";
  const [tab, setTab] = useState(mode === "personal" ? "personal_income" : "sale");
  const [categories, setCategories] = useState([]);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const [saleAmount, setSaleAmount] = useState("");
  const [saleMethod, setSaleMethod] = useState("mixed");
  const [saleDate, setSaleDate] = useState(localIso());

  const [expAmount, setExpAmount] = useState("");
  const [expCatId, setExpCatId] = useState("");
  const [expDesc, setExpDesc] = useState("");
  const [expDate, setExpDate] = useState(localIso());

  // Personal mode
  const [pAmount, setPAmount] = useState("");
  const [pCatId, setPCatId] = useState("");
  const [pNotes, setPNotes] = useState("");
  const [pDate, setPDate] = useState(localIso());

  const salePresets = [500, 1000, 2500, 5000, 10000];
  const expPresets = [100, 500, 1000, 2500];
  const personalPresets = [100, 500, 1000, 5000, 10000];

  useEffect(() => {
    if (open) {
      api.get("/expenses/categories").then(async (res) => {
        setCategories(res.data);
        // Auto-create personal categories if in personal mode and none exist
        if (mode === "personal") {
          const existing = res.data.map((c) => c.name);
          const missing = PERSONAL_CATEGORIES.filter((n) => !existing.includes(n));
          if (missing.length > 0) {
            for (const name of missing) {
              try { await api.post("/expenses/categories", { name }); } catch {}
            }
            const updated = await api.get("/expenses/categories");
            setCategories(updated.data);
          }
        }
      }).catch(() => {});
    }
  }, [open]);

  const showSuccess = (msg) => {
    setError("");
    setSuccess(msg);
    setTimeout(() => setSuccess(""), 2000);
  };

  const showError = (msg) => {
    setSuccess("");
    setError(msg);
    setTimeout(() => setError(""), 3000);
  };

  const submitSale = async () => {
    if (!saleAmount) return;
    try {
      await api.post("/sales", {
        date: saleDate,
        amount: parseFloat(saleAmount),
        payment_method: saleMethod,
      });
      setSaleAmount("");
      setSaleDate(localIso());
      showSuccess(t("saleLogged"));
      window.dispatchEvent(new Event("bonbox-data-changed"));
    } catch (err) {
      showError(err.response?.data?.detail || t("failedToLogSale"));
    }
  };

  const submitExpense = async () => {
    if (!expAmount || !expCatId || !expDesc) return;
    try {
      await api.post("/expenses", {
        category_id: expCatId,
        date: expDate,
        amount: parseFloat(expAmount),
        description: expDesc,
        is_recurring: false,
      });
      setExpAmount("");
      setExpDesc("");
      setExpCatId("");
      setExpDate(localIso());
      showSuccess(t("expenseAdded"));
      window.dispatchEvent(new Event("bonbox-data-changed"));
    } catch (err) {
      showError(err.response?.data?.detail || t("failedToAddExpense"));
    }
  };

  const submitPersonal = async () => {
    if (!pAmount || !pCatId) return;
    const cat = categories.find((c) => c.id === pCatId);
    try {
      await api.post("/expenses", {
        category_id: pCatId,
        date: pDate,
        amount: parseFloat(pAmount),
        description: cat?.name || t("entry"),
        is_recurring: false,
        payment_method: "cash",
        notes: pNotes || null,
        is_personal: true,
      });
      setPAmount("");
      setPCatId("");
      setPNotes("");
      setPDate(localIso());
      showSuccess(INCOME_CATS.includes(cat?.name) ? t("incomeLogged") : t("expenseLogged"));
      window.dispatchEvent(new Event("bonbox-data-changed"));
    } catch (err) {
      showError(err.response?.data?.detail || t("failedToAddEntry"));
    }
  };

  const incomeCats = categories.filter((c) => INCOME_CATS.includes(c.name));
  const spendCats = categories.filter((c) => !INCOME_CATS.includes(c.name));

  // Open the QuickAdd sheet, resetting to the default tab for the mode. Shared
  // by the visible desktop FAB AND the hidden external trigger below (the
  // mobile bottom-tab center "+" dispatches a click to that trigger so phones
  // have a single "+" affordance — the tab bar — instead of a floating FAB).
  const openSheet = () => {
    setOpen(true);
    setTab(mode === "personal" ? "personal_income" : "sale");
  };

  return (
    <>
      {/* Hidden external trigger — always in the DOM so MobileBottomNav's
          center "+" tab can open QuickAdd without QuickAdd needing to render
          its own mobile FAB. Mirrors BonBoxAgent's data-*-toggle pattern. */}
      <button
        data-quickadd-toggle
        onClick={openSheet}
        aria-hidden="true"
        tabIndex={-1}
        className="hidden"
      />

      {/* Visible floating FAB — DESKTOP ONLY (md:flex). On phones the bottom
          tab bar's center "+" is the single add affordance, so we no longer
          stack a floating "+" over the tab bar there (C4 FAB merge). */}
      <button
        onClick={openSheet}
        aria-label={t("quickEntry")}
        className={`hidden md:flex fixed md:bottom-6 left-6 z-40 w-10 h-10 ${mode === "personal" ? "bg-purple-600 hover:bg-purple-700" : "bg-gray-900 hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white"} text-white rounded-full shadow-sm hover:scale-105 transition-all items-center justify-center text-xl font-light`}
      >
        +
      </button>

      <Modal open={open} onClose={() => setOpen(false)} title={mode === "personal" ? t("personalEntry") : t("quickEntry")}>
        {success && (
          <div className="bg-gray-50 dark:bg-gray-800 text-gray-700 dark:text-gray-300 px-4 py-2.5 rounded-lg mb-4 text-sm font-medium text-center">
            {success}
          </div>
        )}
        {error && (
          <div className="bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-400 px-4 py-2.5 rounded-lg mb-4 text-sm font-medium text-center">
            {error}
          </div>
        )}

        {/* Smart skan — first option in the QuickAdd menu. Only shown
            in business mode (smart-scan documents are kvittering /
            kasserapport / faktura — all jurisdiction-business concepts).
            Tapping opens the same SmartScanModal as the mobile FAB; we
            close the quick-add modal first so the two don't stack. */}
        {mode !== "personal" && (
          <button
            onClick={() => {
              trackEvent("smart_scan_quickadd_opened", "smart_scan");
              setOpen(false);
              setSmartScanOpen(true);
            }}
            className="w-full mb-4 flex items-center gap-3 px-3 py-3 rounded-xl border border-gray-100 dark:border-gray-800/40 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800/50 transition group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            <div className="w-9 h-9 rounded-full bg-gray-900 text-white flex items-center justify-center shrink-0 group-hover:scale-105 transition">
              <ScanLine size={18} strokeWidth={2} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1 text-left">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-200">
                {t("smartScan.title", "Smart skan")}
              </p>
              <p className="text-[11px] text-gray-700/80 dark:text-gray-300/80">
                {t("smartScan.subtitle", "Tag ét billede — vi finder ud af resten")}
              </p>
            </div>
            <svg className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M5 12h14M13 5l7 7-7 7" />
            </svg>
          </button>
        )}

        <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1 mb-5">
          {mode === "personal" ? (
            <>
              <button onClick={() => setTab("personal_income")}
                className={`flex-1 py-2.5 rounded-md text-sm font-medium transition ${
                  tab === "personal_income" ? "bg-white dark:bg-gray-600 shadow text-gray-700 dark:text-gray-300" : "text-gray-500 dark:text-gray-400"
                }`}>
                {t("income")}
              </button>
              <button onClick={() => setTab("personal_expense")}
                className={`flex-1 py-2.5 rounded-md text-sm font-medium transition ${
                  tab === "personal_expense" ? "bg-white dark:bg-gray-600 shadow text-red-600 dark:text-red-400" : "text-gray-500 dark:text-gray-400"
                }`}>
                {t("expense")}
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setTab("sale")}
                className={`flex-1 py-2.5 rounded-md text-sm font-medium transition ${
                  tab === "sale" ? "bg-white dark:bg-gray-600 shadow text-blue-700 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"
                }`}>
                {t("logSaleTab")}
              </button>
              <button onClick={() => setTab("expense")}
                className={`flex-1 py-2.5 rounded-md text-sm font-medium transition ${
                  tab === "expense" ? "bg-white dark:bg-gray-600 shadow text-blue-700 dark:text-blue-400" : "text-gray-500 dark:text-gray-400"
                }`}>
                {t("addExpenseTab")}
              </button>
            </>
          )}
        </div>

        {tab === "sale" && (
          <div className="space-y-4">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t("quickAmount")}</p>
              <div className="flex flex-wrap gap-2">
                {salePresets.map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setSaleAmount(String(amt))}
                    className={`px-4 py-2.5 rounded-lg text-sm font-medium border transition ${
                      saleAmount === String(amt)
                        ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-400"
                        : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
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
              className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl text-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-900"
              autoFocus
            />

            <div className="flex flex-wrap gap-1.5">
              {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
                <button
                  key={m}
                  onClick={() => setSaleMethod(m)}
                  className={`px-3 py-2 rounded-lg text-xs font-medium border transition ${
                    saleMethod === m
                      ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-400"
                      : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700"
                  }`}
                >
                  {t(m)}
                </button>
              ))}
            </div>

            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-500 dark:text-gray-400">{t("date")}:</label>
              <input
                type="date"
                value={saleDate}
                max={localIso()}
                onChange={(e) => setSaleDate(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>

            <button
              onClick={submitSale}
              disabled={!saleAmount}
              className="w-full bg-gray-900 text-white py-3.5 rounded-xl hover:bg-gray-700 transition font-semibold text-base disabled:opacity-40 dark:disabled:opacity-30"
            >
              {t("logSale")}
            </button>
          </div>
        )}

        {tab === "expense" && (
          <div className="space-y-3">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t("category")}</p>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1 -m-1 rounded-lg">
                {categories.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setExpCatId(c.id)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition whitespace-nowrap ${
                      expCatId === c.id
                        ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-400"
                        : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
                {categories.length === 0 && (
                  <p className="text-sm text-gray-400 dark:text-gray-500">{t("addCategoriesFirst")}</p>
                )}
              </div>
            </div>

            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t("quickAmount")}</p>
              <div className="flex flex-wrap gap-2">
                {expPresets.map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setExpAmount(String(amt))}
                    className={`px-4 py-2.5 rounded-lg text-sm font-medium border transition ${
                      expAmount === String(amt)
                        ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-400"
                        : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
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
              className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl text-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-900"
            />

            <input
              type="text"
              value={expDesc}
              onChange={(e) => setExpDesc(e.target.value)}
              placeholder={t("whatForExpense")}
              className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-900"
            />

            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-500 dark:text-gray-400">{t("date")}:</label>
              <input
                type="date"
                value={expDate}
                max={localIso()}
                onChange={(e) => setExpDate(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-900"
              />
            </div>

            <button
              onClick={submitExpense}
              disabled={!expAmount || !expCatId || !expDesc}
              className="w-full bg-gray-900 text-white py-3.5 rounded-xl hover:bg-gray-700 transition font-semibold text-base disabled:opacity-40 dark:disabled:opacity-30"
            >
              {t("addExpense")}
            </button>
          </div>
        )}

        {tab === "personal_income" && (
          <div className="space-y-4">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t("incomeSource")}</p>
              <div className="flex flex-wrap gap-2">
                {incomeCats.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setPCatId(c.id)}
                    className={`px-4 py-2.5 rounded-lg text-sm font-medium border transition ${
                      pCatId === c.id
                        ? "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-900 text-gray-700 dark:text-gray-300"
                        : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
                {incomeCats.length === 0 && (
                  <p className="text-sm text-gray-400 dark:text-gray-500">{t("noIncomeCatsYet")}</p>
                )}
              </div>
            </div>

            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-2">{t("quickAmount")}</p>
              <div className="flex flex-wrap gap-2">
                {personalPresets.map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setPAmount(String(amt))}
                    className={`px-4 py-2.5 rounded-lg text-sm font-medium border transition ${
                      pAmount === String(amt)
                        ? "bg-gray-50 dark:bg-gray-800 border-gray-200 dark:border-gray-900 text-gray-700 dark:text-gray-300"
                        : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                    }`}
                  >
                    {amt.toLocaleString()}
                  </button>
                ))}
              </div>
            </div>

            <input
              type="number"
              value={pAmount}
              onChange={(e) => setPAmount(e.target.value)}
              placeholder={t("amountReceived")}
              className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl text-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-400"
              autoFocus
            />

            <input
              type="text"
              value={pNotes}
              onChange={(e) => setPNotes(e.target.value)}
              placeholder={t("notesOptional")}
              className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-400"
            />

            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-500 dark:text-gray-400">{t("date")}:</label>
              <input
                type="date"
                value={pDate}
                max={localIso()}
                onChange={(e) => setPDate(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
              />
            </div>

            <button
              onClick={submitPersonal}
              disabled={!pAmount || !pCatId}
              className="w-full bg-gray-900 text-white py-3.5 rounded-xl hover:bg-gray-700 transition font-semibold text-base disabled:opacity-40 dark:disabled:opacity-30"
            >
              {t("logIncome")}
            </button>
          </div>
        )}

        {tab === "personal_expense" && (
          <div className="space-y-3">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t("spendingCategory")}</p>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1 -m-1 rounded-lg">
                {spendCats.map((c) => (
                  <button
                    key={c.id}
                    onClick={() => setPCatId(c.id)}
                    className={`px-2.5 py-1.5 rounded-lg text-xs font-medium border transition whitespace-nowrap ${
                      pCatId === c.id
                        ? "bg-purple-50 dark:bg-purple-900/30 border-purple-300 dark:border-purple-600 text-purple-700 dark:text-purple-400"
                        : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                    }`}
                  >
                    {c.name}
                  </button>
                ))}
                {spendCats.length === 0 && (
                  <p className="text-sm text-gray-400 dark:text-gray-500">{t("noSpendCatsYet")}</p>
                )}
              </div>
            </div>

            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t("quickAmount")}</p>
              <div className="flex flex-wrap gap-1.5">
                {personalPresets.map((amt) => (
                  <button
                    key={amt}
                    onClick={() => setPAmount(String(amt))}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                      pAmount === String(amt)
                        ? "bg-purple-50 dark:bg-purple-900/30 border-purple-300 dark:border-purple-600 text-purple-700 dark:text-purple-400"
                        : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700"
                    }`}
                  >
                    {amt.toLocaleString()}
                  </button>
                ))}
              </div>
            </div>

            <input
              type="number"
              value={pAmount}
              onChange={(e) => setPAmount(e.target.value)}
              placeholder={t("amountSpent")}
              className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 rounded-xl text-base bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
              autoFocus
            />

            <input
              type="text"
              value={pNotes}
              onChange={(e) => setPNotes(e.target.value)}
              placeholder={t("notesOptional")}
              className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-purple-500"
            />

            <div className="flex items-center gap-3">
              <label className="text-xs text-gray-500 dark:text-gray-400">{t("date")}:</label>
              <input
                type="date"
                value={pDate}
                max={localIso()}
                onChange={(e) => setPDate(e.target.value)}
                className="flex-1 px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-purple-500"
              />
            </div>

            <button
              onClick={submitPersonal}
              disabled={!pAmount || !pCatId}
              className="w-full bg-purple-600 text-white py-3 rounded-xl hover:bg-purple-700 transition font-semibold text-base disabled:opacity-40 dark:disabled:opacity-30"
            >
              {t("logExpense")}
            </button>
          </div>
        )}
      </Modal>

      {/* Smart Scan modal — mounted at the same level as the QuickAdd
          Modal so we can hand off without nesting. SmartScanModal owns
          its own body-scroll lock + escape-to-close behavior, and its
          navigation closes itself before pushing the prefilled route. */}
      <Suspense fallback={null}>
        {smartScanOpen && (
          <SmartScanModal open={smartScanOpen} onClose={() => setSmartScanOpen(false)} />
        )}
      </Suspense>
    </>
  );
}
