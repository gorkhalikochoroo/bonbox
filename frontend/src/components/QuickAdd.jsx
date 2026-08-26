import { useState, useEffect, lazy, Suspense } from "react";
import { ScanLine, ArrowRight, QrCode } from "lucide-react";
import { useNavigate } from "react-router-dom";
import Modal from "./Modal";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { resolveMode } from "../lib/appMode";
import { useEntitlements } from "../hooks/useEntitlements";
import { localIso, formatDateShort } from "../utils/dateFormat";
import { trackEvent } from "../hooks/useEventLog";
import Chip from "./ui/Chip";
import { useStickyMethod } from "../hooks/useStickyMethod";
import { parseMoneyInput, moneyLocale, formatOwnerMoney } from "../utils/currency";
// Lazy-load Smart Scan modal — only fetched when the owner taps the
// "Smart skan" entry below. Keeps QuickAdd's bundle lean for owners
// who use the keypad path 99% of the time.
const SmartScanModal = lazy(() => import("./SmartScanModal"));

/* Echo what we understood, under the field.
 *
 * This is the guard rail that REPLACES type="number". The browser used to
 * refuse anything it could not represent — badly, by silently deleting the
 * Danish decimal comma and turning 347,50 into 34750 — but it did at least
 * refuse. A text field accepts everything, so the app now has to SHOW its
 * reading: an owner who typed 1.234,56 and sees "= 1.234,56 kr." knows it
 * landed, and one who mistyped sees an error instead of a green button.
 *
 * ReceiptCapture already works this way ("the figure on screen is
 * byte-for-byte the figure we post"); this mirrors it. No new primitive —
 * it is one <p> in the two states Input already models.
 */
function AmountEcho({ raw, value, currency, invalidLabel }) {
  const typed = String(raw ?? "").trim();
  if (!typed) return null;
  const unreadable = !Number.isFinite(value);
  return (
    <p
      className={
        "mt-1.5 text-xs tabular-nums " +
        (unreadable
          ? "text-red-600 dark:text-red-400"
          : "text-gray-500 dark:text-gray-400")
      }
      aria-live="polite"
    >
      {unreadable
        ? invalidLabel
        : "= " + formatOwnerMoney(value, currency || "DKK", { decimals: 2 })}
    </p>
  );
}

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
  const navigate = useNavigate();
  const { hasFeature, isReady } = useEntitlements();
  const [open, setOpen] = useState(false);
  // Smart Scan handoff — opening the smart-scan modal from inside
  // QuickAdd closes the quick-add Modal so the two don't stack. The
  // Smart Scan modal is mounted at the same component level so its
  // onClose can re-focus the FAB and the body-scroll lock stays sane.
  const [smartScanOpen, setSmartScanOpen] = useState(false);
  // Same rule as the sidebar (lib/appMode.js). This used to read the raw
  // localStorage key while Layout also consulted business_type, so the two
  // could disagree: a personal account with no key got a personal sidebar
  // beside a BUSINESS sheet, and forcing the sidebar to business would have
  // left a PERSONAL sheet here — no Sale tab, no Expense tab, i.e. the
  // owner's only money-entry path silently gone. One resolver, no drift.
  const { user } = useAuth();
  const mode = resolveMode(user);
  const [tab, setTab] = useState(mode === "personal" ? "personal_income" : "sale");
  const [categories, setCategories] = useState([]);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const [saleAmount, setSaleAmount] = useState("");
  // Sticky payment method — remembers the owner's last choice (DK default:
  // card). commitSaleMethod persists card/MobilePay/etc; cash never sticks
  // (see useStickyMethod — it's the only method that posts to the cashbook).
  const { method: saleMethod, commitMethod: commitSaleMethod, reread: rereadSaleMethod } = useStickyMethod("sale");
  const [saleDate, setSaleDate] = useState(localIso());

  const [expAmount, setExpAmount] = useState("");
  const [expCatId, setExpCatId] = useState("");
  const [expDesc, setExpDesc] = useState("");
  const [expDate, setExpDate] = useState(localIso());
  // Payment method on the expense tab. Deliberately NOT sticky and NOT
  // pre-selected, unlike the sale tab above.
  //
  // This tab had no picker at all, so every quick expense posted without a
  // method and the server's old "card" default filled one in. Since
  // sync_cash_out_for_expense only fires on "cash", a cash purchase added
  // here never left the drawer in the books — kassebeholdning drifted up by
  // the amount of every cash purchase ever quick-added. Same class of bug
  // the single scan (#139) and the pile (#146) already refuse to have.
  //
  // A remembered default would reintroduce it: the owner would be
  // confirming a value the app picked, which is the thing that goes wrong.
  // So: no default, and Tilføj stays disabled until one is tapped.
  const [expMethod, setExpMethod] = useState(null);
  // One lock for both non-idempotent submitters. Neither had any, and
  // both clear their fields only after the await.
  const [posting, setPosting] = useState(false);

  // Personal mode
  const [pAmount, setPAmount] = useState("");
  const [pCatId, setPCatId] = useState("");
  const [pNotes, setPNotes] = useState("");
  const [pDate, setPDate] = useState(localIso());
  // Personal entries hardcoded payment_method:"cash" with no UI. Personal
  // rows are excluded from the cashbook sync (`not expense.is_personal`),
  // so this never moved kassebeholdning — but it still wrote a method
  // nobody chose into a column PersonalPage displays. Offered here, not
  // required: with no cashbook consequence, a mandatory tap on a 3-tap
  // flow buys nothing. Unpicked stays NULL (renders "—") rather than
  // becoming a fabricated "cash".
  const [pMethod, setPMethod] = useState(null);

  const salePresets = [500, 1000, 2500, 5000, 10000];
  const expPresets = [100, 500, 1000, 2500];
  const personalPresets = [100, 500, 1000, 5000, 10000];

  // Same set the full expense form and the receipt review offer, so a
  // method picked here reads identically everywhere it's shown later.
  const expMethods = ["cash", "card", "mobilepay", "online", "mixed", "dankort"];
  // Personal mirrors PersonalPage's picker — cash / card / bank transfer.
  const personalMethods = ["cash", "card", "bankTransfer"];
  const methodValue = (m) => (m === "bankTransfer" ? "bank_transfer" : m);

  useEffect(() => {
    if (open) {
      // Pick up a method the owner changed elsewhere this session — the FAB is
      // mounted once, so its sticky value would otherwise stay stale until reload.
      rereadSaleMethod();
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

  // The parse locale comes from the account CURRENCY, never the UI language:
  // a DKK café can switch the interface to English mid-service, and "1.234"
  // must not change meaning when they do.
  const moneyLoc = moneyLocale(user?.currency);
  const saleAmountNum = parseMoneyInput(saleAmount, moneyLoc);
  const expAmountNum = parseMoneyInput(expAmount, moneyLoc);
  const pAmountNum = parseMoneyInput(pAmount, moneyLoc);

  // Closing the sheet clears what was typed into it.
  //
  // It did not, so cancelling and reopening left the previous amount in the
  // field and the next entry APPENDED to it — measured on the device: two
  // visits typing "347,50" left "34750347.5034750" sitting there with no
  // error. An owner who cancels and comes back should get a clean sheet.
  //
  // Deliberately NOT reset: the payment method (sticky by design) and the
  // category, which the owner picks far less often than the amount.
  useEffect(() => {
    if (open) return;
    setSaleAmount("");
    setExpAmount("");
    setPAmount("");
    setExpDesc("");
    setPNotes("");
  }, [open]);

  const submitSale = async () => {
    // Gate on the PARSED number, not on the raw string being non-empty.
    // `if (!saleAmount)` let "abc" through to parseFloat -> NaN -> the API.
    if (!Number.isFinite(saleAmountNum) || saleAmountNum <= 0) return;
    try {
      await api.post("/sales", {
        date: saleDate,
        amount: saleAmountNum,
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
    // expMethod is part of the guard, not an optional extra — a business
    // expense posted without one is exactly the cash-drift bug.
    if (!Number.isFinite(expAmountNum) || expAmountNum <= 0) return;
    if (!expCatId || !expDesc || !expMethod) return;
    // In-flight lock. There was none: the fields are cleared only AFTER
    // the await, so a second tap during a slow save posted the same
    // expense again — one of the two mechanisms behind the duplicate
    // pairs measured in production.
    if (posting) return;
    setPosting(true);
    try {
      await api.post("/expenses", {
        category_id: expCatId,
        date: expDate,
        amount: expAmountNum,
        description: expDesc,
        is_recurring: false,
        payment_method: expMethod,
      });
      setExpAmount("");
      setExpDesc("");
      setExpCatId("");
      setExpMethod(null);
      setExpDate(localIso());
      showSuccess(t("expenseAdded"));
      window.dispatchEvent(new Event("bonbox-data-changed"));
    } catch (err) {
      showError(err.response?.data?.detail || t("failedToAddExpense"));
    } finally {
      setPosting(false);
    }
  };

  const submitPersonal = async () => {
    if (!Number.isFinite(pAmountNum) || pAmountNum <= 0) return;
    if (!pCatId) return;
    if (posting) return;
    setPosting(true);
    const cat = categories.find((c) => c.id === pCatId);
    try {
      await api.post("/expenses", {
        category_id: pCatId,
        date: pDate,
        amount: pAmountNum,
        description: cat?.name || t("entry"),
        is_recurring: false,
        // Omitted entirely when unpicked — the server stores NULL rather
        // than inventing a method (ExpenseCreate.payment_method has no
        // default). Sending null explicitly would also store NULL, but
        // omitting keeps the field out of `model_fields_set` so vendor
        // memory can't read a non-answer as one.
        ...(pMethod ? { payment_method: pMethod } : {}),
        notes: pNotes || null,
        is_personal: true,
      });
      setPAmount("");
      setPCatId("");
      setPNotes("");
      setPMethod(null);
      setPDate(localIso());
      showSuccess(INCOME_CATS.includes(cat?.name) ? t("incomeLogged") : t("expenseLogged"));
      window.dispatchEvent(new Event("bonbox-data-changed"));
    } catch (err) {
      showError(err.response?.data?.detail || t("failedToAddEntry"));
    } finally {
      setPosting(false);
    }
  };

  const incomeCats = categories.filter((c) => INCOME_CATS.includes(c.name));
  const spendCats = categories.filter((c) => !INCOME_CATS.includes(c.name));

  // Both personal tabs post through submitPersonal, so they share one picker.
  // A plain render helper, not a nested component — a component declared in
  // the body gets a new identity every render and would remount its chips.
  const renderPersonalMethods = () => (
    <div>
      <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">
        {t("paymentMethod")} <span className="text-gray-400 dark:text-gray-500">({t("optional", "optional")})</span>
      </p>
      <div className="flex flex-wrap gap-1.5">
        {personalMethods.map((m) => (
          <Chip
            key={m}
            size="sm"
            selected={pMethod === methodValue(m)}
            onClick={() => setPMethod(pMethod === methodValue(m) ? null : methodValue(m))}
          >
            {t(m)}
          </Chip>
        ))}
      </div>
    </div>
  );

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
        className={`hidden md:flex fixed md:bottom-6 left-6 z-40 w-10 h-10 bg-gray-900 hover:bg-gray-700 dark:bg-gray-100 dark:text-gray-900 dark:hover:bg-white text-white rounded-full shadow-sm hover:scale-105 transition-all items-center justify-center text-xl font-light`}
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
            className="w-full mb-2 sm:mb-4 flex items-center gap-3 px-3 py-2 sm:py-3 rounded-xl border border-gray-100 dark:border-gray-800/40 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800/50 transition group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-gray-900 text-white flex items-center justify-center shrink-0 group-hover:scale-105 transition">
              <ScanLine size={18} strokeWidth={2} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1 text-left">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-200">
                {t("smartScan.title", "Smart skan")}
              </p>
              <p className="hidden sm:block text-[11px] text-gray-700/80 dark:text-gray-300/80">
                {t("smartScan.subtitle", "Tag ét billede — vi finder ud af resten")}
              </p>
            </div>
            <ArrowRight className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
          </button>
        )}

        {/* Indløs gavekort — jump to the door scanner in gavekort mode. Only
            for owners entitled to gavekort (Starter+), so it's never a
            dead-end; business mode only. Reuses existing i18n keys. */}
        {mode !== "personal" && isReady && hasFeature("gavekort") && (
          <button
            onClick={() => {
              trackEvent("gavekort_scan_quickadd_opened", "gavekort");
              setOpen(false);
              navigate("/scan?mode=gavekort");
            }}
            className="w-full mb-2 sm:mb-4 flex items-center gap-3 px-3 py-2 sm:py-3 rounded-xl border border-gray-100 dark:border-gray-800/40 bg-gray-50 dark:bg-gray-800/50 hover:bg-gray-100 dark:hover:bg-gray-800/50 transition group focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
          >
            <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-gray-900 text-white flex items-center justify-center shrink-0 group-hover:scale-105 transition">
              <QrCode size={18} strokeWidth={2} aria-hidden="true" />
            </div>
            <div className="min-w-0 flex-1 text-left">
              <p className="text-sm font-semibold text-gray-900 dark:text-gray-200">
                {t("gkScanEyebrow", "Indløs gavekort")}
              </p>
              <p className="hidden sm:block text-[11px] text-gray-700/80 dark:text-gray-300/80">
                {t("scanGavekortTileSub", "Scan et gavekort-QR")}
              </p>
            </div>
            <ArrowRight className="w-4 h-4 text-gray-400 shrink-0" aria-hidden="true" />
          </button>
        )}

        <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1 mb-5">
          {mode === "personal" ? (
            <>
              <button onClick={() => setTab("personal_income")}
                className={`flex-1 py-2.5 rounded-md text-sm font-medium transition ${
                  tab === "personal_income" ? "bg-white dark:bg-gray-600 shadow text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400"
                }`}>
                {t("income")}
              </button>
              <button onClick={() => setTab("personal_expense")}
                className={`flex-1 py-2.5 rounded-md text-sm font-medium transition ${
                  tab === "personal_expense" ? "bg-white dark:bg-gray-600 shadow text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400"
                }`}>
                {t("expense")}
              </button>
            </>
          ) : (
            <>
              <button onClick={() => setTab("sale")}
                className={`flex-1 py-2.5 rounded-md text-sm font-medium transition ${
                  tab === "sale" ? "bg-white dark:bg-gray-600 shadow text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400"
                }`}>
                {t("logSaleTab")}
              </button>
              <button onClick={() => setTab("expense")}
                className={`flex-1 py-2.5 rounded-md text-sm font-medium transition ${
                  tab === "expense" ? "bg-white dark:bg-gray-600 shadow text-gray-900 dark:text-white" : "text-gray-500 dark:text-gray-400"
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
              {/* toLocaleString() with NO argument formats with the DEVICE
                  locale, so a Danish owner on an English-locale phone read
                  "1,000" here while the Sales Tracker two taps away showed
                  "1.000 kr." — two money formats in one app, for the same
                  amount. Same class as the date bug: using the device instead
                  of the account. moneyLoc comes from the account currency. */}
              <div className="flex flex-wrap gap-2">
                {salePresets.map((amt) => (
                  <Chip
                    key={amt}
                    size="md"
                    selected={saleAmount === String(amt)}
                    onClick={() => setSaleAmount(String(amt))}
                  >
                    {amt.toLocaleString(moneyLoc)}
                  </Chip>
                ))}
              </div>
            </div>

            <input
              type="text"
              inputMode="decimal"
              value={saleAmount}
              onChange={(e) => setSaleAmount(e.target.value)}
              placeholder={t("orTypeAmount")}
              className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl text-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-900"
              autoFocus
            />

            <AmountEcho
              raw={saleAmount}
              value={saleAmountNum}
              currency={user?.currency}
              invalidLabel={t("amountUnreadable")}
            />

            <div className="flex flex-wrap gap-1.5">
              {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
                <Chip
                  key={m}
                  size="sm"
                  selected={saleMethod === m}
                  onClick={() => commitSaleMethod(m)}
                >
                  {t(m)}
                </Chip>
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
              disabled={!(saleAmountNum > 0)}
              className="w-full bg-gray-900 text-white py-3.5 rounded-xl hover:bg-gray-700 transition font-semibold text-base disabled:opacity-40 dark:disabled:opacity-30"
            >
              {/* The label has to match the date actually being posted. It said
                  "Log Today's Sale" ("Registrer dagens salg") no matter what,
                  so backdating a sale to the 20th still told the owner it was
                  today's — the button lying about what it does, on the money
                  path. Verified on device before the fix. */}
              {saleDate === localIso()
                ? t("logSale")
                : t("logSaleForDate").replace("{date}", formatDateShort(saleDate))}
            </button>
          </div>
        )}

        {tab === "expense" && (
          <div className="space-y-3">
            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t("category")}</p>
              <div className="flex flex-wrap gap-1.5 max-h-32 overflow-y-auto p-1 -m-1 rounded-lg">
                {categories.map((c) => (
                  <Chip
                    key={c.id}
                    size="sm"
                    selected={expCatId === c.id}
                    onClick={() => setExpCatId(c.id)}
                  >
                    {c.name}
                  </Chip>
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
                  <Chip
                    key={amt}
                    size="md"
                    selected={expAmount === String(amt)}
                    onClick={() => setExpAmount(String(amt))}
                  >
                    {amt.toLocaleString(moneyLoc)}
                  </Chip>
                ))}
              </div>
            </div>

            <input
              type="text"
              inputMode="decimal"
              value={expAmount}
              onChange={(e) => setExpAmount(e.target.value)}
              placeholder={t("orTypeAmount")}
              className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl text-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-900"
            />

            <AmountEcho
              raw={expAmount}
              value={expAmountNum}
              currency={user?.currency}
              invalidLabel={t("amountUnreadable")}
            />

            <input
              type="text"
              value={expDesc}
              onChange={(e) => setExpDesc(e.target.value)}
              placeholder={t("whatForExpense")}
              className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-900"
            />

            <div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">{t("paymentMethod")}</p>
              <div className="flex flex-wrap gap-1.5">
                {expMethods.map((m) => (
                  <Chip
                    key={m}
                    size="sm"
                    selected={expMethod === m}
                    onClick={() => setExpMethod(m)}
                  >
                    {t(m)}
                  </Chip>
                ))}
              </div>
            </div>

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
              aria-busy={posting}
              disabled={posting || !(expAmountNum > 0) || !expCatId || !expDesc || !expMethod}
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
                  <Chip
                    key={c.id}
                    size="md"
                    selected={pCatId === c.id}
                    onClick={() => setPCatId(c.id)}
                  >
                    {c.name}
                  </Chip>
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
                  <Chip
                    key={amt}
                    size="md"
                    selected={pAmount === String(amt)}
                    onClick={() => setPAmount(String(amt))}
                  >
                    {amt.toLocaleString(moneyLoc)}
                  </Chip>
                ))}
              </div>
            </div>

            <input
              type="text"
              inputMode="decimal"
              value={pAmount}
              onChange={(e) => setPAmount(e.target.value)}
              placeholder={t("amountReceived")}
              className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl text-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-400"
              autoFocus
            />

            <AmountEcho
              raw={pAmount}
              value={pAmountNum}
              currency={user?.currency}
              invalidLabel={t("amountUnreadable")}
            />

            <input
              type="text"
              value={pNotes}
              onChange={(e) => setPNotes(e.target.value)}
              placeholder={t("notesOptional")}
              className="w-full px-4 py-3 border border-gray-200 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-400"
            />

            {renderPersonalMethods()}

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
              aria-busy={posting}
              disabled={posting || !(pAmountNum > 0) || !pCatId}
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
                  <Chip
                    key={c.id}
                    size="sm"
                    selected={pCatId === c.id}
                    onClick={() => setPCatId(c.id)}
                  >
                    {c.name}
                  </Chip>
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
                  <Chip
                    key={amt}
                    size="sm"
                    selected={pAmount === String(amt)}
                    onClick={() => setPAmount(String(amt))}
                  >
                    {amt.toLocaleString(moneyLoc)}
                  </Chip>
                ))}
              </div>
            </div>

            <input
              type="text"
              inputMode="decimal"
              value={pAmount}
              onChange={(e) => setPAmount(e.target.value)}
              placeholder={t("amountSpent")}
              className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 rounded-xl text-base bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-400"
              autoFocus
            />

            <AmountEcho
              raw={pAmount}
              value={pAmountNum}
              currency={user?.currency}
              invalidLabel={t("amountUnreadable")}
            />

            <input
              type="text"
              value={pNotes}
              onChange={(e) => setPNotes(e.target.value)}
              placeholder={t("notesOptional")}
              className="w-full px-4 py-2.5 border border-gray-200 dark:border-gray-600 rounded-xl bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-gray-400"
            />

            {renderPersonalMethods()}

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
              aria-busy={posting}
              disabled={posting || !(pAmountNum > 0) || !pCatId}
              className="w-full bg-gray-900 text-white py-3 rounded-xl hover:bg-gray-700 transition font-semibold text-base disabled:opacity-40 dark:disabled:opacity-30"
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
