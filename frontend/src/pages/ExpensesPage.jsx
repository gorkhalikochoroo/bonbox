// Task #118 polish (Agent C): migrated H1 → PageHeader, one-time/recurring
// segmented control → TabPills, dropped DismissibleTip emoji prop so it
// uses the new Lucide default. Behavior + i18n + a11y unchanged.
//
// Task #119 Phase 3 polish: replaced dark-gradient rainbow KPI panels
// with neutral clickable StatCards.  Click-to-expand affordance
// preserved via onClick + ChevronDown indicator.  Selected state
// uses gray-900 ring (no tech-glow per sidebar rule).
import { useState, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { trackEvent } from "../hooks/useEventLog";
import { exportToCsv } from "../utils/exportCsv";
import { displayCurrency, getTaxConfig } from "../utils/currency";
import { formatDate, formatDateShort, localIso } from "../utils/dateFormat";
import TaxBreakdown from "../components/TaxBreakdown";
import { FadeIn, StaggerGrid, StaggerGridItem } from "../components/AnimationKit";
import ReceiptCapture from "../components/ReceiptCapture";
import ReceiptViewer from "../components/ReceiptViewer";
import DismissibleTip from "../components/DismissibleTip";
import InboxBanner from "../components/InboxBanner";
import { safeImageUrl } from "../utils/safeUrl";
import RecurringExpensesPanel from "../components/RecurringExpensesPanel";
import { PageHeader, TabPills, StatCard } from "../components/ui";

const QUICK_AMOUNTS = [100, 250, 500, 1000, 2500, 5000];
const DEFAULT_CATEGORIES = ["Ingredients", "Rent", "Wages", "Utilities", "Supplies", "Other"];

// Categories that only belong in Personal mode — hide from Business expense buttons
const PERSONAL_ONLY_CATS = new Set([
  "Salary", "Freelance", "Side Income", "Gift Received",
  "Groceries", "Transport", "Loan Payment", "EMI",
  "Borrowed", "Lent Out", "Food & Dining",
  "Shopping", "Entertainment", "Health", "Gym & Fitness",
  "Education", "Subscriptions", "Insurance", "Phone & Internet",
  "Clothing", "Personal Care", "Family", "Savings", "Investment",
]);

export default function ExpensesPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();
  const [expenses, setExpenses] = useState([]);
  const [categories, setCategories] = useState([]);
  const [catId, setCatId] = useState("");
  const [amount, setAmount] = useState("");
  const [desc, setDesc] = useState("");
  const [expDate, setExpDate] = useState(localIso());
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");
  const [showSetup, setShowSetup] = useState(false);
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [editId, setEditId] = useState(null);
  // Receipt review modal — opens when user clicks the 🧾 chip on an
  // expense row that has receipt_photo set. (Only Snap-Receipt-created
  // expenses carry a photo today; manually-typed expenses won't show
  // the chip and don't need it.)
  const [receiptViewing, setReceiptViewing] = useState(null);
  const [editData, setEditData] = useState({});
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [method, setMethod] = useState("card");
  const [notes, setNotes] = useState("");
  const [search, setSearch] = useState("");
  const [customCat, setCustomCat] = useState("");
  const customCatRef = useRef(null);
  const [listening, setListening] = useState(false);
  // Top-level tab strip — One-time (existing flow) vs Recurring
  // (Task #47, Starter+ feature). Lifted above the existing
  // Detailed/Quick toggle so owners see the high-level distinction
  // first. Backend enforces the tier on every recurring mutation.
  const [expensesTab, setExpensesTab] = useState("one_time"); // "one_time" | "recurring"
  const [isPersonal, setIsPersonal] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [isTaxExempt, setIsTaxExempt] = useState(false);
  const [showFilter, setShowFilter] = useState("business"); // "all", "business", "personal"
  const [suggestion, setSuggestion] = useState(null);
  const suggestTimer = useRef(null);
  const [expandedStat, setExpandedStat] = useState(null); // "today" | "total" | "avg" | null

  // ── Foreign-currency capture (Bogføringsloven §10 cross-border) ─────
  // Sudip Sam (Nepali-DK event organizer) pays his Nepali film
  // distributor in USD/EUR/NPR. The receipt is in the foreign currency
  // but the bookkeeping voucher MUST also record the DKK equivalent so
  // the revisor can reconcile. This block lets the owner type the
  // raw foreign amount + pick the currency + live-fetch the ECB rate
  // (via frankfurter.app — free, no key) and shows the computed DKK
  // figure before save. POST sends both numbers so the audit trail is
  // complete.
  const accountCcy = (user?.currency || "DKK").toUpperCase();
  const [fxOpen, setFxOpen] = useState(false);
  const [fxCurrency, setFxCurrency] = useState("USD");
  const [fxOriginalAmount, setFxOriginalAmount] = useState("");
  const [fxRate, setFxRate] = useState("");            // manual override / fallback
  const [fxLiveRate, setFxLiveRate] = useState(null);  // last fetched ECB rate
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState("");
  // Common ISO 4217 codes Sudip + other DK SMBs are likely to touch.
  // Kept short on purpose — owners with niche currencies can type their
  // own three letters via the editable input (we accept any uppercase
  // 3-letter token).
  const FX_CURRENCIES = ["DKK", "USD", "EUR", "NPR", "GBP", "SEK", "NOK", "PLN"];
  // ECB-published rates (via frankfurter.app) cover ~30 currencies.
  // Hardcoded fallback table for when the API is down or the chosen
  // currency isn't in ECB's list (NPR is the relevant one for Sudip —
  // ECB doesn't publish NPR, so frankfurter returns nothing and we
  // must fall back to a sane recent value or the user's manual rate).
  // L4 fail-soft — better an approximate rate than blocking the save.
  // These are 2026-Q2 anchors; owners can override via the manual
  // input.
  const FX_FALLBACK_TO_DKK = {
    DKK: 1, USD: 6.85, EUR: 7.46, NPR: 0.052, GBP: 8.60,
    SEK: 0.65, NOK: 0.62, PLN: 1.72,
  };

  // Live ECB rate lookup (debounced by the toggle/input itself — only
  // runs when the owner opens the panel or changes currency). Network
  // failures are non-fatal: we surface a yellow note and fall back to
  // the table above so the owner can still save the expense.
  useEffect(() => {
    if (!fxOpen) return;
    if (fxCurrency === accountCcy) { setFxLiveRate(1); setFxError(""); return; }
    setFxLoading(true);
    setFxError("");
    const ctrl = new AbortController();
    fetch(
      `https://api.frankfurter.app/latest?from=${encodeURIComponent(fxCurrency)}&to=${encodeURIComponent(accountCcy)}`,
      { signal: ctrl.signal },
    )
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((data) => {
        const rate = data?.rates?.[accountCcy];
        if (typeof rate === "number" && rate > 0) {
          setFxLiveRate(rate);
          // Pre-fill the manual override field so the displayed math
          // matches the rate that will actually get POSTed. The owner
          // can still type their own override on top.
          setFxRate(String(rate));
        } else {
          // Frankfurter doesn't publish this currency (e.g. NPR) —
          // fall back to the local table without surfacing a red error.
          const fb = FX_FALLBACK_TO_DKK[fxCurrency];
          if (fb) {
            setFxLiveRate(fb);
            setFxRate(String(fb));
            setFxError(t("fx.fallbackInUse", "Using built-in rate (ECB has no live rate for this currency)"));
          } else {
            setFxError(t("fx.rateMissing", "No live rate available — type one manually below."));
          }
        }
      })
      .catch((e) => {
        if (e.name === "AbortError") return;
        // L4 fail-soft — ECB API hiccup. Use fallback table.
        const fb = FX_FALLBACK_TO_DKK[fxCurrency];
        if (fb) {
          setFxLiveRate(fb);
          setFxRate(String(fb));
          setFxError(t("fx.apiDown", "FX API unreachable — using built-in rate. You can edit below."));
        } else {
          setFxError(t("fx.apiDownNoFallback", "FX API unreachable — type a rate manually."));
        }
      })
      .finally(() => setFxLoading(false));
    return () => ctrl.abort();
  }, [fxOpen, fxCurrency, accountCcy]);

  // Effective rate used for math/POST — manual override wins over
  // the live/fallback figure so an owner who knows their bank's
  // actual posted rate can type it instead. Empty manual input
  // falls back to live, then to the table.
  const fxEffectiveRate = (() => {
    const manual = parseFloat(fxRate);
    if (!isNaN(manual) && manual > 0) return manual;
    if (typeof fxLiveRate === "number" && fxLiveRate > 0) return fxLiveRate;
    return FX_FALLBACK_TO_DKK[fxCurrency] || null;
  })();
  const fxConvertedAccount = (() => {
    const orig = parseFloat(fxOriginalAmount);
    if (isNaN(orig) || !fxEffectiveRate) return null;
    return orig * fxEffectiveRate;
  })();

  const filtered = expenses.filter(e => {
    if (search) {
      // Searchable surface: vendor (stored as description), notes,
      // payment method, amount, AND the ISO date string so owners can
      // type "2026-05" to filter to a month without using the date
      // range inputs above.
      const needle = search.toLowerCase();
      const haystack = [
        e.description, e.notes, e.payment_method, String(e.amount), e.date,
      ].filter(Boolean).map(s => String(s).toLowerCase()).join(" | ");
      if (!haystack.includes(needle)) return false;
    }
    if (showFilter === "personal" && !e.is_personal) return false;
    if (showFilter === "business" && e.is_personal) return false;
    return true;
  }).sort((a, b) => {
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
      const numMatch = text.match(/[\d,]+\.?\d*/);
      if (numMatch) {
        const val = parseFloat(numMatch[0].replace(/,/g, ""));
        if (val > 0) {
          setAmount(String(val));
          if (text.includes("cash")) setMethod("cash");
          else if (text.includes("card")) setMethod("card");
          // Try to match a category
          const catMatch = categories.find(c => text.includes(c.name.toLowerCase()));
          if (catMatch) { setCatId(catMatch.id); setCustomCat(""); }
          // Use remaining text as description
          const remaining = text.replace(numMatch[0], "").replace(/cash|card|mobilepay|mixed|dankort/g, "").trim();
          if (remaining.length > 2) setDesc(remaining);
          setSuccess(`Voice: "${text}" → ${val.toLocaleString()} ${currency}`);
          setTimeout(() => setSuccess(""), 3000);
        }
      } else {
        setError(`Couldn't parse amount from: "${text}"`);
        setTimeout(() => setError(""), 3000);
      }
    };
    recognition.onerror = () => { setListening(false); setError(t("voiceRecognitionFailed")); setTimeout(() => setError(""), 3000); };
    recognition.start();
  };

  // Auto-suggest category from description
  const fetchSuggestion = (text) => {
    if (suggestTimer.current) clearTimeout(suggestTimer.current);
    if (!text || text.length < 2) { setSuggestion(null); return; }
    suggestTimer.current = setTimeout(() => {
      api.get("/expenses/suggest-category", { params: { q: text } })
        .then((res) => {
          if (res.data.suggestion) {
            setSuggestion(res.data.suggestion);
          } else {
            setSuggestion(null);
          }
        })
        .catch(() => {});
    }, 400); // debounce 400ms
  };

  const applySuggestion = () => {
    if (!suggestion) return;
    setCatId(suggestion.category_id);
    setCustomCat("");
    setSuggestion(null);
  };

  const fetchData = (from, to) => {
    const params = { is_personal: false };
    if (from) params.from = from;
    if (to) params.to = to;
    api.get("/expenses", { params })
      .then((res) => setExpenses(res.data))
      .catch((err) => setError(err.response?.data?.detail || t("failedToLoadExpenses")));
    api.get("/expenses/categories")
      .then((res) => {
        setCategories(res.data);
        if (res.data.length === 0) setShowSetup(true);
      })
      .catch((err) => setError(err.response?.data?.detail || t("failedToLoadCategories")));
  };

  useEffect(() => {
    fetchData();
    const onDataChanged = () => fetchData();
    window.addEventListener("bonbox-data-changed", onDataChanged);
    return () => window.removeEventListener("bonbox-data-changed", onDataChanged);
  }, []);

  // ─── Smart Scan prefill consumer ─────────────────────────────────
  // SmartScanModal navigates here with extracted_data in location.state
  // when the classifier recognizes a receipt / invoice that belongs in
  // Expenses. We pre-fill the new-expense form fields and remember
  // which fields the AI was uncertain about so we can mark them with
  // a "Bekræft venligst" chip until the owner touches them.
  //
  // We tag the prefill in component state instead of consuming
  // location.state directly on every render — otherwise pressing
  // Submit (which fetchData → setExpenses) would re-trigger the
  // prefill loop. We also clear router state via navigate(..., {
  // replace: true, state: null }) once consumed so a refresh of the
  // page after saving doesn't re-apply old prefill values.
  const location = useLocation();
  const navigate = useNavigate();
  const [verifyHints, setVerifyHints] = useState([]);
  const [touchedHints, setTouchedHints] = useState(new Set());
  useEffect(() => {
    const st = location.state;
    if (!st || (st.source !== "smart_scan" && st.source !== "smart_scan_manual")) return;
    const prefill = st.prefill || null;
    const hints = Array.isArray(st.verify_hints) ? st.verify_hints : [];
    setVerifyHints(hints);
    setTouchedHints(new Set());
    if (prefill) {
      // Field mapping — backend extracted_data shape mirrors the
      // /expenses/upload-receipt response, so we reuse the same keys.
      // Missing keys fall back to the existing form defaults.
      if (prefill.suggested_amount != null) setAmount(String(prefill.suggested_amount));
      if (prefill.amount != null && !prefill.suggested_amount) setAmount(String(prefill.amount));
      if (prefill.suggested_vendor) setDesc(prefill.suggested_vendor);
      if (!prefill.suggested_vendor && prefill.vendor) setDesc(prefill.vendor);
      if (prefill.suggested_date) setExpDate(prefill.suggested_date);
      if (!prefill.suggested_date && prefill.date) setExpDate(prefill.date);
      if (prefill.payment_method) setMethod(prefill.payment_method);
      // Category — backend might send either suggested_category.category_id
      // (matched against existing) or category_id directly. We rely on
      // categories being already loaded by the fetchData() above; if
      // it's not yet loaded, the catId setter still works once the user
      // sees the picker (categories state will populate from the fetch).
      const catId = prefill.suggested_category?.category_id || prefill.category_id;
      if (catId) setCatId(catId);
      setSuccess(
        st.source === "smart_scan_manual"
          ? t("smartScan.openedManual", "Åbnet manuelt — udfyld felterne")
          : t("smartScan.prefilled", "Felter pre-udfyldt fra billedet — bekræft venligst"),
      );
      setTimeout(() => setSuccess(""), 4000);
    }
    // Clear router state so a refresh / back-nav doesn't re-apply
    // prefill values after the owner has saved or modified them.
    navigate(location.pathname, { replace: true, state: null });
    // We intentionally ignore navigate / location.pathname in deps;
    // re-running on those would loop. We only respond to a new
    // location.state arriving (treated as a one-shot side effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

  // Render-helper: does a given field name still need the
  // "Bekræft venligst" chip? Yes when the field is in verifyHints AND
  // the owner hasn't touched it yet.
  const showVerifyChip = (field) => {
    return verifyHints.includes(field) && !touchedHints.has(field);
  };
  const markTouched = (field) => {
    if (!verifyHints.includes(field)) return;
    setTouchedHints((prev) => {
      if (prev.has(field)) return prev;
      const next = new Set(prev);
      next.add(field);
      return next;
    });
  };

  const quickSetup = async () => {
    try {
      for (const name of DEFAULT_CATEGORIES) {
        await api.post("/expenses/categories", { name });
      }
      setShowSetup(false);
      fetchData();
    } catch (err) {
      setError(err.response?.data?.detail || t("failedToSetupCategories"));
    }
  };

  // Quick expense (no category required)
  const [quickMode, setQuickMode] = useState(false);
  const [quickAmount, setQuickAmount] = useState("");
  const [quickMethod, setQuickMethod] = useState("card");
  const [quickNotes, setQuickNotes] = useState("");
  const [quickDate, setQuickDate] = useState(localIso());

  const submitQuick = async (amt) => {
    const value = amt || parseFloat(quickAmount);
    if (!value) return;
    setError("");
    try {
      // Find or create "Other" category
      let otherCat = categories.find(c => c.name === "Other");
      if (!otherCat) {
        const res = await api.post("/expenses/categories", { name: "Other" });
        otherCat = res.data;
        setCategories(prev => [...prev, res.data]);
      }
      await api.post("/expenses", {
        category_id: otherCat.id,
        date: quickDate,
        amount: value,
        description: quickNotes || t("quickExpense"),
        is_recurring: false,
        payment_method: quickMethod,
        notes: quickNotes || null,
        is_personal: false,
      });
      const isBackdated = quickDate !== localIso();
      setQuickAmount("");
      setQuickNotes("");
      setQuickMethod("card");
      setQuickDate(localIso());
      trackEvent("quick_expense_logged", "expenses", `${value} ${currency}`);
      setSuccess(`${value.toLocaleString()} ${currency}${isBackdated ? ` (${quickDate})` : ""}!`);
      fetchData(filterFrom, filterTo);
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || t("failedToAddExpense"));
    }
  };

  const submit = async (quickAmt) => {
    // ── Foreign-currency branch ──────────────────────────────────────
    // When the FX panel is open AND the chosen currency differs from
    // the account currency AND the owner typed a foreign amount, the
    // DKK figure POSTed as `amount` is derived from the conversion —
    // the `amount` input field is ignored. This matches the math the
    // owner sees below the FX inputs ("≈ X kr"). Otherwise we use the
    // existing path.
    const isForeign =
      fxOpen
      && fxCurrency
      && fxCurrency.toUpperCase() !== accountCcy
      && !isNaN(parseFloat(fxOriginalAmount))
      && parseFloat(fxOriginalAmount) > 0
      && typeof fxEffectiveRate === "number"
      && fxEffectiveRate > 0;
    const value = isForeign
      ? Number(fxConvertedAccount.toFixed(2))
      : (quickAmt || parseFloat(amount));
    if (!value) return;
    // Need either a selected category or a custom one typed
    let finalCatId = catId;
    if (!finalCatId && !customCat.trim()) return;
    // Auto-fill description from category if empty
    const finalDesc = desc || customCat.trim() || categories.find(c => c.id === finalCatId)?.name || "Expense";
    setError("");
    try {
      // If custom category typed, create it first
      if (!finalCatId && customCat.trim()) {
        const catRes = await api.post("/expenses/categories", { name: customCat.trim() });
        finalCatId = catRes.data.id;
        setCategories((prev) => {
          if (prev.find((c) => c.id === catRes.data.id)) return prev;
          return [...prev, catRes.data];
        });
        setCatId(catRes.data.id);
        setCustomCat("");
      }
      const payload = {
        category_id: finalCatId,
        date: expDate,
        amount: value,
        description: finalDesc,
        is_recurring: false,
        payment_method: method,
        notes: notes || null,
        is_personal: isPersonal,
        is_tax_exempt: isTaxExempt,
      };
      if (isForeign) {
        payload.currency = fxCurrency.toUpperCase();
        payload.fx_rate = Number(fxEffectiveRate.toFixed(6));
        payload.original_amount = parseFloat(fxOriginalAmount);
      }
      await api.post("/expenses", payload);
      const isBackdated = expDate !== localIso();
      setAmount("");
      setDesc("");
      setMethod("card");
      setNotes("");
      setCustomCat("");
      setIsPersonal(false);
      setIsTaxExempt(false);
      setExpDate(localIso());
      // Reset FX section state after a successful save so the next
      // entry starts in the default (single-currency) mode.
      setFxOpen(false);
      setFxOriginalAmount("");
      setFxRate("");
      setFxLiveRate(null);
      setFxError("");
      trackEvent(
        isForeign ? "expense_logged_fx" : "expense_logged",
        "expenses",
        isForeign
          ? `${parseFloat(fxOriginalAmount)} ${fxCurrency} → ${value} ${currency}`
          : `${value} ${currency}`,
      );
      setSuccess(`${value.toLocaleString()} ${currency}${isBackdated ? ` (${formatDate(expDate)})` : ""}!`);
      fetchData(filterFrom, filterTo);
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || t("failedToAddExpense"));
    }
  };

  const startEdit = (exp) => {
    setEditId(exp.id);
    setEditData({
      date: exp.date,
      amount: parseFloat(exp.amount),
      description: exp.description,
      category_id: exp.category_id,
      payment_method: exp.payment_method || "card",
      notes: exp.notes || "",
      is_personal: exp.is_personal || false,
      is_tax_exempt: exp.is_tax_exempt || false,
    });
  };

  const saveEdit = async () => {
    try {
      const payload = { ...editData };
      if (payload.amount === "") payload.amount = 0;
      await api.put(`/expenses/${editId}`, payload);
      setEditId(null);
      setEditData({});
      fetchData(filterFrom, filterTo);
      setSuccess(t("expenseUpdated"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || t("failedToUpdateExpense"));
    }
  };

  const bulkDelete = async () => {
    if (!confirm(`${t("moveToTrash")} ${selected.size}?`)) return;
    try {
      await Promise.all([...selected].map(id => api.delete(`/expenses/${id}`)));
      setSelected(new Set());
      fetchData(filterFrom, filterTo);
      setSuccess(t("movedToRecentlyDeleted"));
      setTimeout(() => setSuccess(""), 2500);
    } catch {
      setError(t("failedToDeleteSome"));
    }
  };

  const deleteExpense = async (id) => {
    try {
      await api.delete(`/expenses/${id}`);
      setDeleteConfirm(null);
      fetchData(filterFrom, filterTo);
      setSuccess(t("movedToRecentlyDeleted"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(err.response?.data?.detail || t("failedToDeleteExpense"));
    }
  };

  const getCatName = (catId) => {
    const cat = categories.find((c) => c.id === catId);
    return cat ? cat.name : "";
  };

  return (
    <div className="p-4 sm:p-6 space-y-6">
      <FadeIn>
        <PageHeader eyebrow="MONEY" title={t("expenseTracker")} />
      </FadeIn>

      {success && <div className="bg-green-50 dark:bg-green-900/30 text-green-700 dark:text-green-300 px-4 py-3 rounded-xl text-sm font-medium">{success}</div>}
      {error && <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-300 px-4 py-3 rounded-xl text-sm">{error}</div>}

      <DismissibleTip
        id="expenses-intro-v1"
        title="Snap, log, claim back"
      >
        <p>
          Tap a quick amount, pick a category, done. Or hit <strong>Snap receipt</strong> to capture
          a supplier invoice — the OCR pulls out the total, you confirm, and BonBox calculates the
          input Moms you can deduct on your next filing. Each expense gets a sequential bilagsnummer.
        </p>
      </DismissibleTip>

      {/* Receipt-forwarding inbox (v0.1) — surfaces the user's
          unique `<short>-<rnd>@in.bonbox.dk` alias so Sudip-style owners
          keep their phone-mail muscle memory: receipt lands in inbox →
          tap Forward → done. Inbox-sourced expenses appear as drafts in
          the list below with source='inbox', so the rest of the page is
          unchanged. Hides itself if dismissed or on transport error. */}
      <InboxBanner />

      {showSetup && (
        <div className="bg-green-50 dark:bg-green-900/30 border border-green-200 dark:border-green-700 p-5 rounded-xl">
          <p className="text-green-800 dark:text-green-300 font-medium mb-2">{t("firstTimeSetup")}</p>
          <p className="text-green-600 dark:text-green-400 text-sm mb-3">{DEFAULT_CATEGORIES.join(", ")}</p>
          <button onClick={quickSetup}
            className="bg-green-600 text-white px-5 py-2.5 rounded-lg hover:bg-green-700 transition font-medium text-sm">
            {t("setupCategories")}
          </button>
        </div>
      )}

      {/* One-time / Recurring tab strip — lifted ABOVE the Detailed/Quick
          toggle so the high-level distinction is the first decision the
          owner makes. Recurring tab content is server-gated to Starter+. */}
      <TabPills
        ariaLabel="Expense type"
        tabs={[
          { id: "one_time", label: t("oneTimeTab", "One-time") },
          { id: "recurring", label: t("recurringTab", "Recurring") },
        ]}
        activeId={expensesTab}
        onChange={setExpensesTab}
      />

      {expensesTab === "recurring" && (
        <RecurringExpensesPanel
          categories={categories}
          currency={currency}
        />
      )}

      {expensesTab === "one_time" && (
      <>
      {/* Form + Stats side by side */}
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
      <div className="lg:col-span-3 bg-white dark:bg-gray-800 p-4 sm:p-5 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700">
        <div className="max-w-md">
        <div className="flex items-center justify-between mb-2">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("addExpense")}</h2>
            <button onClick={() => setReceiptOpen(true)} className="px-2.5 py-1 bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-400 rounded-lg text-xs font-medium hover:bg-purple-200 dark:hover:bg-purple-800/40 transition" title="Scan receipt">
              📷 Scan
            </button>
          </div>
          <div className="flex gap-1 bg-gray-100 dark:bg-gray-700 rounded-lg p-0.5">
            <button
              onClick={() => setQuickMode(false)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition ${!quickMode ? "bg-white dark:bg-gray-600 text-gray-800 dark:text-white shadow-sm" : "text-gray-500 dark:text-gray-400"}`}
            >
              {t("detailed")}
            </button>
            <button
              onClick={() => setQuickMode(true)}
              className={`px-3 py-1 rounded-md text-xs font-medium transition ${quickMode ? "bg-white dark:bg-gray-600 text-gray-800 dark:text-white shadow-sm" : "text-gray-500 dark:text-gray-400"}`}
            >
              {t("quickMode")}
            </button>
          </div>
        </div>

        {quickMode ? (
          <div>
            <p className="text-xs text-gray-400 dark:text-gray-400 mb-3">{t("quickAmountAndGo")}</p>
            <div className="flex flex-wrap gap-1.5 mb-3">
              {QUICK_AMOUNTS.map((amt) => (
                <button
                  key={amt}
                  onClick={() => submitQuick(amt)}
                  className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-green-50 dark:hover:bg-green-900/30 hover:border-green-300 dark:hover:border-green-500 hover:text-green-700 dark:hover:text-green-300 transition"
                >
                  {amt.toLocaleString()} {currency}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 mb-2">
              <input
                type="number"
                value={quickAmount}
                onChange={(e) => setQuickAmount(e.target.value)}
                placeholder={t("customAmount")}
                className="flex-1 px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500"
                onKeyDown={(e) => e.key === "Enter" && submitQuick()}
              />
              <button
                onClick={() => submitQuick()}
                disabled={!quickAmount}
                className="px-4 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-semibold text-sm disabled:opacity-40"
              >
                {t("add")}
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5 mb-2">
              {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
                <button key={m} type="button" onClick={() => setQuickMethod(m)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                    quickMethod === m ? "bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-500 text-green-700 dark:text-green-300" : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
                  }`}>{t(m)}</button>
              ))}
            </div>
            <div className="flex items-center gap-2">
              <input type="text" value={quickNotes} onChange={(e) => setQuickNotes(e.target.value)}
                placeholder={t("notesOptional")} className="flex-1 px-2.5 py-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
              <input
                type="date"
                value={quickDate}
                max={localIso()}
                onChange={(e) => setQuickDate(e.target.value)}
                className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-green-500"
              />
            </div>
            {quickDate !== localIso() && (
              <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 font-medium">{t("backdated")}</p>
            )}
          </div>
        ) : (
          <div>
        <p className="text-xs text-gray-400 dark:text-gray-400 mb-3">{t("pickCategory")}</p>

        <div className="flex flex-wrap gap-1.5 mb-2">
          {categories
            .filter((c) => !PERSONAL_ONLY_CATS.has(c.name))
            .map((c) => (
            <button
              key={c.id}
              onClick={() => {
                if (c.name === "Other") {
                  setCatId("");
                  setCustomCat("");
                  setDesc("");
                  setTimeout(() => customCatRef.current?.focus(), 0);
                } else {
                  setCatId(c.id);
                  setCustomCat("");
                  setDesc(c.name);
                }
              }}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition ${
                catId === c.id
                  ? "bg-blue-50 dark:bg-blue-900/30 border-blue-300 dark:border-blue-600 text-blue-700 dark:text-blue-300"
                  : "border-gray-200 dark:border-gray-600 text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              }`}
            >
              {c.name}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-2 mb-2 relative">
          <span className="text-xs text-gray-400 dark:text-gray-500">{t("or")}</span>
          <div className="flex-1 relative">
            <input
              ref={customCatRef}
              type="text"
              value={customCat}
              onChange={(e) => { setCustomCat(e.target.value); if (e.target.value) setCatId(""); }}
              placeholder={t("customCategoryPlaceholder")}
              className="w-full px-2.5 py-1 border border-gray-200 dark:border-gray-600 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 dark:bg-gray-700 dark:text-white"
            />
            {customCat.length >= 1 && (() => {
              const matches = categories.filter(c => c.name.toLowerCase().includes(customCat.toLowerCase()) && c.name.toLowerCase() !== customCat.toLowerCase());
              if (matches.length === 0) return null;
              return (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-700 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg z-20 max-h-32 overflow-y-auto">
                  {matches.slice(0, 5).map(c => (
                    <button
                      key={c.id}
                      type="button"
                      onClick={() => { setCatId(c.id); setCustomCat(""); setDesc(c.name); }}
                      className="w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-blue-50 dark:hover:bg-blue-900/30 transition"
                    >
                      {c.name}
                    </button>
                  ))}
                </div>
              );
            })()}
          </div>
        </div>

        {/* Smart Scan verify chip — shown above the field when the
            classifier flagged this field as needing double-check. Hides
            itself once the owner edits the field. */}
        {showVerifyChip("vendor") && (
          <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300 mb-1 flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />
            {t("smartScan.verifyHint", "Bekræft venligst")} — {t("vendor", "Vendor")}
          </p>
        )}
        <div className="relative mb-2">
          <input
            type="text"
            value={desc}
            onChange={(e) => { setDesc(e.target.value); fetchSuggestion(e.target.value); markTouched("vendor"); }}
            placeholder={t("whatWasIt")}
            className={`w-full px-2.5 py-1 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 dark:bg-gray-700 dark:text-white ${
              showVerifyChip("vendor")
                ? "border-amber-300 dark:border-amber-600 bg-amber-50/50 dark:bg-amber-900/10"
                : "border-gray-200 dark:border-gray-600"
            }`}
          />
          {suggestion && !catId && (
            <button
              onClick={applySuggestion}
              className="absolute right-2 top-1/2 -translate-y-1/2 inline-flex items-center gap-1 px-2.5 py-1 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-700 rounded-lg text-xs font-medium text-blue-700 dark:text-blue-300 hover:bg-blue-100 dark:hover:bg-blue-900/50 transition"
            >
              <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" /></svg>
              {suggestion.category_name}
            </button>
          )}
        </div>

        <div className="flex flex-wrap gap-1.5 mb-2">
          {QUICK_AMOUNTS.map((amt) => (
            <button
              key={amt}
              onClick={() => submit(amt)}
              disabled={!catId && !customCat.trim()}
              className="px-3 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 text-xs font-semibold text-gray-700 dark:text-gray-300 hover:bg-blue-50 dark:hover:bg-blue-900/30 hover:border-blue-300 dark:hover:border-blue-600 hover:text-blue-700 dark:hover:text-blue-300 transition disabled:opacity-30"
            >
              {amt.toLocaleString()} {currency}
            </button>
          ))}
        </div>

        {(showVerifyChip("amount") || showVerifyChip("total")) && (
          <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300 mb-1 flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />
            {t("smartScan.verifyHint", "Bekræft venligst")} — {t("amount", "Amount")}
          </p>
        )}
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
            onChange={(e) => { setAmount(e.target.value); markTouched("amount"); markTouched("total"); }}
            placeholder={`${t("customAmount")} ${getTaxConfig(user?.currency).rate > 0 ? `(${getTaxConfig(user?.currency).label})` : ""}`}
            className={`flex-1 px-3 py-1.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-900 dark:bg-gray-700 dark:text-white ${
              (showVerifyChip("amount") || showVerifyChip("total"))
                ? "border-amber-300 dark:border-amber-600 bg-amber-50/50 dark:bg-amber-900/10"
                : "border-gray-200 dark:border-gray-600"
            }`}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <button
            onClick={() => submit()}
            disabled={
              (!amount && !(fxOpen && fxConvertedAccount != null && fxConvertedAccount > 0))
              || (!catId && !customCat.trim())
            }
            className="px-4 py-1.5 bg-green-600 text-white rounded-lg hover:bg-green-700 transition font-semibold text-sm disabled:opacity-40"
          >
            {t("add")}
          </button>
        </div>

        {/* ── Foreign-currency capture ─────────────────────────────────
            Sudip Sam (Nepali-DK event organizer) pays his Nepali film
            distributor in NPR/USD. Bogføringsloven §10 requires the
            original-currency record alongside the DKK conversion.
            Hidden by default to keep the form lean for the 95%
            single-currency case. */}
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setFxOpen(!fxOpen)}
            className={`text-xs font-medium inline-flex items-center gap-1 ${
              fxOpen
                ? "text-amber-700 dark:text-amber-300"
                : "text-gray-500 dark:text-gray-400 hover:text-blue-600"
            }`}
          >
            <span className="inline-block w-1.5 h-1.5 rounded-full bg-current" aria-hidden="true" />
            {fxOpen
              ? t("fx.hide", "Hide foreign currency")
              : t("fx.show", "Foreign currency")}
          </button>
          {fxOpen && (
            <div className="mt-2 p-3 rounded-lg border border-amber-200 dark:border-amber-700/40 bg-amber-50/40 dark:bg-amber-900/10 space-y-2">
              <div className="flex items-center gap-2">
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={fxOriginalAmount}
                  onChange={(e) => setFxOriginalAmount(e.target.value)}
                  placeholder={t("fx.originalAmountPlaceholder", "Original amount")}
                  className="flex-1 px-2.5 py-1 border border-gray-200 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-900"
                />
                <select
                  value={fxCurrency}
                  onChange={(e) => setFxCurrency(e.target.value.toUpperCase())}
                  className="px-2 py-1 border border-gray-200 dark:border-gray-600 rounded-lg text-sm bg-white dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-900"
                >
                  {FX_CURRENCIES.map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div className="flex items-center gap-2 text-xs">
                <label className="text-gray-500 dark:text-gray-400 flex-shrink-0">
                  {t("fx.rateLabel", "Rate")} 1 {fxCurrency} =
                </label>
                <input
                  type="number"
                  step="0.000001"
                  min="0"
                  value={fxRate}
                  onChange={(e) => setFxRate(e.target.value)}
                  placeholder={fxLoading ? "…" : (fxLiveRate || "—")}
                  className="w-28 px-2 py-1 border border-gray-200 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 dark:text-white text-xs"
                />
                <span className="text-gray-500 dark:text-gray-400">{accountCcy}</span>
                {fxLoading && (
                  <span className="text-gray-400 dark:text-gray-500 italic">
                    {t("fx.fetching", "fetching ECB…")}
                  </span>
                )}
              </div>
              {fxError && (
                <p className="text-[11px] text-amber-700 dark:text-amber-300">{fxError}</p>
              )}
              {fxConvertedAccount != null && (
                <p className="text-sm font-semibold text-gray-900 dark:text-white">
                  ≈ {fxConvertedAccount.toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
                  {currency}
                  <span className="ml-1 text-xs font-normal text-gray-500 dark:text-gray-400">
                    ({parseFloat(fxOriginalAmount || 0)} {fxCurrency} ×{" "}
                    {typeof fxEffectiveRate === "number"
                      ? fxEffectiveRate.toLocaleString(undefined, { maximumFractionDigits: 6 })
                      : "—"})
                  </span>
                </p>
              )}
              <p className="text-[11px] text-gray-500 dark:text-gray-400">
                {t(
                  "fx.bogforingNote",
                  "Original amount + rate are saved alongside the DKK figure for revisor reconciliation (Bogføringsloven §10).",
                )}
              </p>
            </div>
          )}
        </div>

        {/* Tax breakdown */}
        <TaxBreakdown amount={amount} currencyCode={user?.currency} type="expenses" isTaxExempt={isTaxExempt} onTaxExemptChange={setIsTaxExempt} />

        {/* Payment method */}
        <div className="flex flex-wrap gap-1.5 mt-2">
          {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
            <button key={m} type="button" onClick={() => setMethod(m)}
              className={`px-2.5 py-1 rounded-lg text-xs font-medium border transition ${
                method === m ? "bg-green-50 dark:bg-green-900/30 border-green-300 dark:border-green-500 text-green-700 dark:text-green-300" : "border-gray-200 dark:border-gray-600 text-gray-500 dark:text-gray-400 hover:bg-gray-50 dark:hover:bg-gray-700/50"
              }`}>{t(m)}</button>
          ))}
        </div>

        {/* Notes + Date row */}
        {showVerifyChip("date") && (
          <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300 mt-2 flex items-center gap-1">
            <span className="inline-block w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />
            {t("smartScan.verifyHint", "Bekræft venligst")} — {t("date", "Date")}
          </p>
        )}
        <div className="mt-2 flex items-center gap-2">
          <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)}
            placeholder={t("notesOptional")} className="flex-1 px-2.5 py-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm" />
          <input
            type="date"
            value={expDate}
            max={localIso()}
            onChange={(e) => { setExpDate(e.target.value); markTouched("date"); }}
            className={`px-2 py-1 border rounded-lg text-sm dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-900 ${
              showVerifyChip("date")
                ? "border-amber-300 dark:border-amber-600 bg-amber-50/50 dark:bg-amber-900/10"
                : "border-gray-200 dark:border-gray-600"
            }`}
          />
        </div>
        {expDate !== localIso() && (
          <p className="mt-1 text-xs text-amber-600 dark:text-amber-400 font-medium">{t("backdatedEntry")}</p>
        )}

        {/* Personal toggle */}
        <div className="mt-2 flex items-center gap-3">
          <button
            type="button"
            onClick={() => setIsPersonal(!isPersonal)}
            className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
              isPersonal ? "bg-purple-600" : "bg-gray-200 dark:bg-gray-600"
            }`}
          >
            <span className={`inline-block h-4 w-4 rounded-full bg-white transition transform ${isPersonal ? "translate-x-6" : "translate-x-1"}`} />
          </button>
          <span className={`text-sm font-medium ${isPersonal ? "text-purple-600 dark:text-purple-400" : "text-gray-500 dark:text-gray-400"}`}>
            {isPersonal ? t("personalExpense") : t("businessExpense")}
          </span>
          {isPersonal && (
            <span className="text-xs text-purple-500 dark:text-purple-400">{t("excludedFromReports")}</span>
          )}
        </div>
          </div>
        )}
        </div>
      </div>

      {/* Summary Stats - right side, Inventory Monitor style */}
      {expenses.length > 0 ? (() => {
        const now = new Date();
        const hasFilter = filterFrom || filterTo;
        const refDate = hasFilter && expenses.length > 0
          ? new Date(expenses.reduce((latest, e) => e.date > latest ? e.date : latest, expenses[0].date) + "T12:00:00")
          : now;
        const monthPrefix = localIso(refDate).slice(0, 7);
        const monthName = refDate.toLocaleString("default", { month: "long" });
        const monthExpenses = hasFilter ? expenses : expenses.filter(e => e.date?.startsWith(monthPrefix));
        const totalExp = monthExpenses.reduce((s, x) => s + parseFloat(x.amount), 0);
        const todayStr = localIso(now);
        const latestDate = hasFilter && expenses.length > 0
          ? expenses.reduce((latest, e) => e.date > latest ? e.date : latest, expenses[0].date)
          : todayStr;
        const todayExp = expenses.filter(e => e.date === latestDate);
        const todayTotal = todayExp.reduce((s, x) => s + parseFloat(x.amount), 0);
        const cats = {};
        monthExpenses.forEach(e => { cats[e.category_name || "Other"] = (cats[e.category_name || "Other"] || 0) + parseFloat(e.amount); });
        // Group by date (avg per day, not per entry)
        const byDate = {};
        monthExpenses.forEach(e => { byDate[e.date] = (byDate[e.date] || 0) + parseFloat(e.amount); });
        const daysWithExpenses = Object.keys(byDate).length;
        const avgExp = daysWithExpenses > 0 ? totalExp / daysWithExpenses : 0;
        const sortedDates = Object.entries(byDate).sort((a, b) => b[0].localeCompare(a[0]));
        // Today's categories
        const todayCats = {};
        todayExp.forEach(e => { todayCats[e.category_name || "Other"] = (todayCats[e.category_name || "Other"] || 0) + parseFloat(e.amount); });
        return (
          <div className="lg:col-span-2 space-y-3">
            {/* KPI strip — Task #119 Phase 3: dark-gradient rainbow
                panels replaced with neutral clickable StatCards. All
                values render in neutral gray-900; no per-card
                red/blue/purple/orange. The "by category" tile shows
                inline category chips (gray pills) below — same neutral
                treatment as Sales' "by payment" tile. */}
            <div className="grid grid-cols-2 gap-3">
              <StatCard
                label={hasFilter ? t("latestDay") : t("today")}
                value={todayTotal.toLocaleString()}
                helper={`${todayExp.length} ${t("expenses")} ${t("today").toLowerCase()}`}
                onClick={() => setExpandedStat(expandedStat === "today" ? null : "today")}
                selected={expandedStat === "today"}
                expandable
                ariaControls="expenses-stat-panel"
              />
              <StatCard
                label={`${monthName} ${t("spent")}`}
                value={totalExp.toLocaleString()}
                helper={`${currency} · ${monthExpenses.length} ${t("expenses")}`}
                onClick={() => setExpandedStat(expandedStat === "total" ? null : "total")}
                selected={expandedStat === "total"}
                expandable
                ariaControls="expenses-stat-panel"
              />
              <StatCard
                label={t("avgExpense")}
                value={Math.round(avgExp).toLocaleString()}
                helper={`${currency}/${t("day").toLowerCase()} · ${daysWithExpenses} ${t("days")}`}
                onClick={() => setExpandedStat(expandedStat === "avg" ? null : "avg")}
                selected={expandedStat === "avg"}
                expandable
                ariaControls="expenses-stat-panel"
              />
              {/* "By category" — special: shows breakdown chips, not a
                  single number. Mirrors the StatCard chrome
                  (rounded-xl, gray-200 border, white bg). Chips are
                  neutral gray pills; the active filter chip uses the
                  gray-900 fill that matches the StatCard selected
                  treatment. */}
              <div className="rounded-xl border border-gray-200 bg-white dark:bg-gray-900 dark:border-gray-800 px-4 py-3.5">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">{t("byCategory")}</p>
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([cat, amt]) => (
                    <button
                      key={cat}
                      onClick={() => setSearch(search === cat ? "" : cat)}
                      className={`px-2.5 py-1 rounded-full text-[11px] font-medium transition ${
                        search === cat
                          ? "bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900"
                          : "bg-gray-100 text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-300 dark:hover:bg-gray-700"
                      }`}
                    >
                      {cat} · {amt.toLocaleString()}
                    </button>
                  ))}
                </div>
                <p className="text-[11.5px] text-gray-500 dark:text-gray-400 mt-2 leading-snug">{Object.keys(cats).length} {t("categories")}</p>
              </div>
            </div>

            {/* Expanded detail panel */}
            {expandedStat === "today" && (
              <div id="expenses-stat-panel" className="bg-gradient-to-br from-red-950/80 to-gray-800 rounded-xl p-4 border border-red-700/60 animate-in">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold text-red-300">{t("todaysBreakdown")}</p>
                  <button onClick={() => setExpandedStat(null)} className="w-5 h-5 flex items-center justify-center rounded-full bg-red-900/50 text-red-400 text-xs hover:bg-red-800/60">&times;</button>
                </div>
                {todayExp.length > 0 ? (
                  <>
                    {Object.keys(todayCats).length > 0 && (
                      <div className="flex flex-wrap gap-1.5 mb-3">
                        {Object.entries(todayCats).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
                          <span key={cat} className="px-2.5 py-1 bg-red-900/40 border border-red-700/40 rounded-full text-[11px] font-bold text-red-300">{cat} · {amt.toLocaleString()}</span>
                        ))}
                      </div>
                    )}
                    <div className="space-y-1 max-h-36 overflow-y-auto">
                      {todayExp.map((e, i) => (
                        <div key={i} className="flex items-center justify-between px-3 py-1.5 bg-red-900/20 rounded-lg text-xs">
                          <span className="font-bold text-red-300">{parseFloat(e.amount).toLocaleString()} {currency}</span>
                          <span className="text-red-400/50">{e.category_name || "Other"}</span>
                          <span className="text-red-400/40 truncate max-w-[80px]">{e.description || "—"}</span>
                        </div>
                      ))}
                    </div>
                  </>
                ) : <p className="text-xs text-red-400/50 text-center py-2">{t("noExpensesToday")}</p>}
              </div>
            )}

            {expandedStat === "total" && (
              <div id="expenses-stat-panel" className="bg-gradient-to-br from-blue-950/80 to-gray-800 rounded-xl p-4 border border-blue-700/60 animate-in">
                <div className="flex items-center justify-between mb-3">
                  <p className="text-xs font-semibold text-blue-300">{monthName} {t("expenses")}</p>
                  <button onClick={() => setExpandedStat(null)} className="w-5 h-5 flex items-center justify-center rounded-full bg-blue-900/50 text-blue-400 text-xs hover:bg-blue-800/60">&times;</button>
                </div>
                <div className="flex flex-wrap gap-1.5 mb-3">
                  {Object.entries(cats).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([cat, amt]) => (
                    <span key={cat} className="px-2.5 py-1 bg-blue-900/40 border border-blue-700/40 rounded-full text-[11px] font-bold text-blue-300">{cat} · {amt.toLocaleString()}</span>
                  ))}
                </div>
                <div className="space-y-1 max-h-48 overflow-y-auto">
                  {[...monthExpenses].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 20).map((e, i) => (
                    <div key={i} className="flex items-center gap-2 px-3 py-1.5 bg-blue-900/20 rounded-lg text-xs">
                      <span className="text-blue-300/50 flex-shrink-0">{formatDateShort(e.date)}</span>
                      <span className="font-bold text-blue-300 flex-shrink-0">{parseFloat(e.amount).toLocaleString()}</span>
                      <span className="text-blue-200 truncate">{e.description || e.category_name || "—"}</span>
                      <span className="text-blue-400/40 ml-auto flex-shrink-0 capitalize">{e.payment_method || ""}</span>
                    </div>
                  ))}
                </div>
                <p className="text-[10px] text-blue-400/40 mt-2 text-center">{monthExpenses.length} {t("expenses")} · {sortedDates.length} {t("days")} · {Object.keys(cats).length} {t("categories")}</p>
              </div>
            )}

            {expandedStat === "avg" && (() => {
              const amounts = monthExpenses.map(e => parseFloat(e.amount)).sort((a, b) => a - b);
              if (amounts.length === 0) return null;
              const min = amounts[0];
              const max = amounts[amounts.length - 1];
              const median = amounts.length % 2 === 0 ? (amounts[amounts.length / 2 - 1] + amounts[amounts.length / 2]) / 2 : amounts[Math.floor(amounts.length / 2)];
              const buckets = [
                { label: `< ${Math.round(avgExp * 0.5).toLocaleString()}`, count: amounts.filter(a => a < avgExp * 0.5).length },
                { label: `${Math.round(avgExp * 0.5).toLocaleString()} – ${Math.round(avgExp * 1.5).toLocaleString()}`, count: amounts.filter(a => a >= avgExp * 0.5 && a <= avgExp * 1.5).length },
                { label: `> ${Math.round(avgExp * 1.5).toLocaleString()}`, count: amounts.filter(a => a > avgExp * 1.5).length },
              ];
              return (
                <div id="expenses-stat-panel" className="bg-gradient-to-br from-purple-950/80 to-gray-800 rounded-xl p-4 border border-purple-700/60 animate-in">
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-xs font-semibold text-purple-300">{monthName} {t("expenseDistribution")}</p>
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
                          <div className="h-full bg-purple-500/60 rounded-full" style={{ width: `${Math.max(4, (b.count / monthExpenses.length) * 100)}%` }} />
                        </div>
                        <span className="text-[10px] font-bold text-purple-300 w-6">{b.count}</span>
                      </div>
                    ))}
                  </div>
                  <p className="text-[10px] text-purple-400/40 mt-2 text-center">{totalExp.toLocaleString()} ÷ {daysWithExpenses} {t("days")} = {Math.round(avgExp).toLocaleString()} {currency}/{t("day").toLowerCase()}</p>
                </div>
              );
            })()}
          </div>
        );
      })() : (
        // Empty-state KPI strip — Task #119 Phase 3: matches the
        // populated state's StatCard chrome so the page is consistent
        // before the owner has logged anything.
        <div className="lg:col-span-2 grid grid-cols-2 gap-3 content-start">
          <StatCard label={t("today")} value="0" helper={t("noExpensesYet")} />
          <StatCard label={t("thisMonth")} value="0" helper={currency} />
          <StatCard label={t("avgExpense")} value="—" helper={t("logFirstExpense")} />
          <StatCard label={t("byCategory")} value="—" helper={t("noDataYet")} />
        </div>
      )}
      </div>

      <div className="bg-white dark:bg-gray-800 rounded-xl shadow-sm border border-gray-100 dark:border-gray-700 overflow-hidden">
        <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-base font-semibold text-gray-700 dark:text-gray-300">{t("recentExpenses")}</h2>
            <div className="flex gap-1 ml-2">
              {["all", "business", "personal"].map((f) => (
                <button key={f} onClick={() => setShowFilter(f)}
                  className={`px-2 py-0.5 rounded text-xs font-medium transition ${
                    showFilter === f ? "bg-green-600 text-white" : "bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400"
                  }`}>{f === "all" ? t("all") : f === "business" ? t("businessMode") : t("personalMode")}</button>
              ))}
            </div>
          </div>
          <div className="flex items-center gap-2 flex-wrap">
            <input
              type="date"
              value={filterFrom}
              onChange={(e) => { setFilterFrom(e.target.value); fetchData(e.target.value, filterTo); }}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <span className="text-xs text-gray-400">→</span>
            <input
              type="date"
              value={filterTo}
              onChange={(e) => { setFilterTo(e.target.value); fetchData(filterFrom, e.target.value); }}
              className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            <input
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={t("searchExpensesPlaceholder")}
              className="px-3 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-xs dark:bg-gray-700 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-900"
            />
            {(filterFrom || filterTo) && (
              <button
                onClick={() => { setFilterFrom(""); setFilterTo(""); fetchData(); }}
                className="text-xs text-red-500 hover:text-red-700 dark:text-red-400 font-medium"
              >
                {t("clear")}
              </button>
            )}
            <button
              onClick={() => exportToCsv("expenses.csv", expenses.map(exp => ({
                ...exp,
                category_name: getCatName(exp.category_id),
              })), [
                { key: "date", label: t("date") },
                { key: "description", label: t("description") },
                { key: "category_name", label: t("category") },
                { key: "amount", label: t("amount") },
              ])}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium"
            >
              {t("exportCsv")}
            </button>
          </div>
        </div>
        {/* Desktop / tablet table — hidden on phones where the card list
            below takes over. md+ stays identical to prior version. */}
        <div className="hidden md:block overflow-x-auto -mx-4 sm:mx-0 px-4 sm:px-0">
        <table className="w-full text-left min-w-[600px]">
          <thead className="bg-gray-50 dark:bg-gray-700/50">
            <tr>
              <th className="px-4 sm:px-6 py-3 w-8">
                <input type="checkbox" onChange={(e) => {
                  if (e.target.checked) setSelected(new Set(filtered.map(i => i.id)));
                  else setSelected(new Set());
                }} checked={selected.size === filtered.length && filtered.length > 0} />
              </th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("description")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("category")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("amount")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("payment")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400">{t("notes")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">{t("date")}</th>
              <th className="px-4 sm:px-6 py-3 text-sm font-medium text-gray-500 dark:text-gray-400 text-right">{t("actions")}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
            {filtered.slice(0, 50).map((exp) => (
              <tr key={exp.id}>
                <td className="px-4 sm:px-6 py-4">
                  <input type="checkbox" checked={selected.has(exp.id)} onChange={(e) => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(exp.id);
                    else next.delete(exp.id);
                    setSelected(next);
                  }} />
                </td>
                {editId === exp.id ? (
                  <>
                    <td className="px-6 py-3">
                      <input
                        type="text"
                        value={editData.description}
                        onChange={(e) => setEditData({ ...editData, description: e.target.value })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-32"
                      />
                    </td>
                    <td className="px-6 py-3">
                      <select
                        value={editData.category_id}
                        onChange={(e) => setEditData({ ...editData, category_id: e.target.value })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white"
                      >
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                    </td>
                    <td className="px-6 py-3">
                      <input
                        type="number"
                        value={editData.amount}
                        onChange={(e) => setEditData({ ...editData, amount: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 })}
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
                        value={editData.notes}
                        onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                        className="px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded-lg text-sm dark:bg-gray-700 dark:text-white w-28"
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
                    <td className="px-6 py-4 text-sm text-gray-700 dark:text-gray-300">
                      <span className="inline-flex items-center gap-1.5">
                        {exp.description}
                        {exp.is_personal && <span className="px-1.5 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 text-xs rounded font-medium">{t("personalMode")}</span>}
                        {/* Receipt-photo thumbnail — visible only on rows
                            created via Snap Receipt OCR (which now
                            persists receipt_photo since the schema
                            change). Click → ReceiptViewer modal so the
                            owner can verify the saved amount against the
                            photo at full size.
                            Renders a real 40×40 thumbnail when we can
                            sign the URL; falls back to the legacy 🧾
                            chip when the signed URL is missing (e.g.
                            local dev / signing failure). Lazy-load + onError
                            fallback to chip so a 404 doesn't show a
                            broken-image icon mid-row. */}
                        {exp.receipt_photo && (() => {
                          const thumbUrl = safeImageUrl(exp.receipt_photo);
                          return (
                            <button
                              type="button"
                              onClick={() => setReceiptViewing(exp)}
                              title={t("receiptViewerOpen") || "View receipt"}
                              aria-label={t("receiptViewerOpen") || "View receipt"}
                              className="inline-flex items-center justify-center w-10 h-10 rounded-lg bg-amber-50 dark:bg-amber-900/20 hover:bg-amber-100 dark:hover:bg-amber-800/30 text-amber-600 dark:text-amber-300 text-sm transition overflow-hidden border border-amber-200 dark:border-amber-800/40"
                            >
                              {thumbUrl ? (
                                <img
                                  src={thumbUrl}
                                  alt={t("receiptViewerImageAlt") || "Receipt"}
                                  loading="lazy"
                                  className="w-full h-full object-cover"
                                  onError={(e) => {
                                    // Signed URL expired or broken — swap
                                    // to the emoji fallback so the row
                                    // doesn't render a broken-image icon.
                                    e.currentTarget.style.display = "none";
                                    e.currentTarget.parentNode.textContent = "🧾";
                                  }}
                                />
                              ) : (
                                "🧾"
                              )}
                            </button>
                          );
                        })()}
                      </span>
                    </td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{getCatName(exp.category_id)}</td>
                    <td className="px-6 py-4 text-sm font-semibold text-gray-800 dark:text-white">{parseFloat(exp.amount).toLocaleString()} {currency}</td>
                    <td className="px-6 py-4 text-sm text-gray-600 dark:text-gray-400 capitalize">{exp.payment_method || "-"}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400">{exp.notes || "-"}</td>
                    <td className="px-6 py-4 text-sm text-gray-500 dark:text-gray-400 text-right">{formatDate(exp.date)}</td>
                    <td className="px-6 py-4 text-right space-x-3">
                      <button onClick={() => startEdit(exp)} className="text-blue-500 dark:text-blue-400 text-sm hover:underline">{t("edit")}</button>
                      {deleteConfirm === exp.id ? (
                        <>
                          <button onClick={() => deleteExpense(exp.id)} className="text-red-600 dark:text-red-400 text-sm font-medium hover:underline">{t("yesMove")}</button>
                          <button onClick={() => setDeleteConfirm(null)} className="text-gray-400 text-sm hover:underline">{t("cancel")}</button>
                        </>
                      ) : (
                        <button onClick={() => setDeleteConfirm(exp.id)} className="text-red-400 dark:text-red-500 text-sm hover:underline">{t("moveToTrash")}</button>
                      )}
                    </td>
                  </>
                )}
              </tr>
            ))}
            {filtered.length === 0 && (
              <tr><td colSpan={8} className="px-6 py-8 text-center text-gray-400 dark:text-gray-500">{t("noExpensesYet")}</td></tr>
            )}
          </tbody>
        </table>
        </div>

        {/* Mobile card list — vertical layout, no horizontal scrolling,
            all actions reachable as 44px tap targets. Same data as the
            desktop table; edit drops into a stacked form on the card. */}
        <div className="md:hidden p-3 space-y-2">
          {filtered.length === 0 && (
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 p-6 text-center text-[13px] text-gray-400 dark:text-gray-500">
              {t("noExpensesYet")}
            </div>
          )}
          {filtered.slice(0, 50).map((exp) => {
            const isEditing = editId === exp.id;
            const confirming = deleteConfirm === exp.id;
            const isSelected = selected.has(exp.id);

            return (
              <div
                key={exp.id}
                className={`rounded-xl border bg-white dark:bg-gray-800 p-3 ${
                  isSelected
                    ? "border-gray-900 dark:border-white ring-1 ring-gray-900 dark:ring-white bg-gray-50 dark:bg-gray-700/40"
                    : "border-gray-200 dark:border-gray-700"
                }`}
              >
                {isEditing ? (
                  /* Inline edit form — stacked */
                  <div className="space-y-2">
                    <input
                      type="text"
                      value={editData.description}
                      onChange={(e) => setEditData({ ...editData, description: e.target.value })}
                      placeholder={t("description")}
                      className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] dark:bg-gray-700 dark:text-white"
                    />
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={editData.category_id}
                        onChange={(e) => setEditData({ ...editData, category_id: e.target.value })}
                        className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] dark:bg-gray-700 dark:text-white"
                      >
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>{c.name}</option>
                        ))}
                      </select>
                      <input
                        type="number"
                        value={editData.amount}
                        onChange={(e) => setEditData({ ...editData, amount: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 })}
                        placeholder={t("amount")}
                        className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] tabular-nums dark:bg-gray-700 dark:text-white"
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={editData.payment_method}
                        onChange={(e) => setEditData({ ...editData, payment_method: e.target.value })}
                        className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] dark:bg-gray-700 dark:text-white"
                      >
                        {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
                          <option key={m} value={m}>{t(m)}</option>
                        ))}
                      </select>
                      <input
                        type="date"
                        value={editData.date}
                        onChange={(e) => setEditData({ ...editData, date: e.target.value })}
                        className="px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] dark:bg-gray-700 dark:text-white"
                      />
                    </div>
                    <input
                      type="text"
                      value={editData.notes || ""}
                      onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                      placeholder={t("notes")}
                      className="w-full px-3 py-2 border border-gray-200 dark:border-gray-600 rounded-lg text-[14px] dark:bg-gray-700 dark:text-white"
                    />
                    <div className="flex gap-2 pt-1">
                      <button
                        onClick={() => setEditId(null)}
                        className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 text-[13px] font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
                      >
                        {t("cancel")}
                      </button>
                      <button
                        onClick={saveEdit}
                        className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg border border-emerald-600 bg-emerald-600 text-white text-[13px] font-semibold hover:bg-emerald-700"
                      >
                        {t("save")}
                      </button>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Header: description + category | amount */}
                    <div className="flex items-start justify-between gap-2 mb-2">
                      <div className="min-w-0 flex-1">
                        <div className="font-semibold text-gray-900 dark:text-white truncate flex items-center gap-1.5">
                          {exp.description}
                          {exp.is_personal && (
                            <span className="px-1.5 py-0.5 bg-purple-100 dark:bg-purple-900/30 text-purple-600 dark:text-purple-400 text-[10px] font-semibold rounded">
                              {t("personalMode")}
                            </span>
                          )}
                        </div>
                        <div className="text-[12px] text-gray-500 dark:text-gray-400 mt-0.5">
                          {getCatName(exp.category_id)}
                        </div>
                      </div>
                      <div className="text-right shrink-0">
                        <div className="font-semibold tabular-nums text-gray-900 dark:text-white">
                          {parseFloat(exp.amount).toLocaleString()} {currency}
                        </div>
                      </div>
                    </div>

                    {/* Stat grid: date / payment, with notes/receipt below */}
                    <div className="grid grid-cols-2 gap-2 text-[12px] pt-2 border-t border-gray-100 dark:border-gray-700">
                      <div>
                        <div className="text-gray-500 dark:text-gray-400">{t("date")}</div>
                        <div className="font-semibold tabular-nums text-gray-900 dark:text-white mt-0.5">
                          {formatDate(exp.date)}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="text-gray-500 dark:text-gray-400">{t("payment")}</div>
                        <div className="font-semibold capitalize text-gray-900 dark:text-white mt-0.5">
                          {exp.payment_method ? t(exp.payment_method) : "—"}
                        </div>
                      </div>
                    </div>

                    {(exp.notes || exp.receipt_photo) && (
                      <div className="text-[12px] pt-2 mt-2 border-t border-gray-100 dark:border-gray-700 space-y-2">
                        {exp.notes && (
                          <div className="text-gray-500 dark:text-gray-400">{exp.notes}</div>
                        )}
                        {exp.receipt_photo && (() => {
                          const thumbUrl = safeImageUrl(exp.receipt_photo);
                          return (
                            <button
                              type="button"
                              onClick={() => setReceiptViewing(exp)}
                              className="inline-flex items-center gap-2 text-amber-600 dark:text-amber-400 hover:underline text-[12px]"
                              aria-label={t("receiptViewerOpen") || "View receipt"}
                            >
                              {thumbUrl ? (
                                <img
                                  src={thumbUrl}
                                  alt={t("receiptViewerImageAlt") || "Receipt"}
                                  loading="lazy"
                                  className="w-10 h-10 rounded-lg object-cover border border-amber-200 dark:border-amber-800/40"
                                  onError={(e) => {
                                    e.currentTarget.style.display = "none";
                                  }}
                                />
                              ) : (
                                <span className="text-base" aria-hidden="true">🧾</span>
                              )}
                              {t("receiptViewerOpen") || "View receipt"}
                            </button>
                          );
                        })()}
                      </div>
                    )}

                    {/* Action row */}
                    <div className="flex items-center gap-2 pt-3 mt-3 border-t border-gray-100 dark:border-gray-700">
                      <button
                        onClick={() => startEdit(exp)}
                        className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-700 active:bg-gray-100 text-[13px] font-medium transition"
                      >
                        {t("edit")}
                      </button>
                      {confirming ? (
                        <button
                          onClick={() => deleteExpense(exp.id)}
                          className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg bg-red-600 text-white text-[13px] font-semibold hover:bg-red-700 transition"
                        >
                          {t("yesMove") || t("confirm") || "Confirm"}
                        </button>
                      ) : (
                        <button
                          onClick={() => setDeleteConfirm(exp.id)}
                          className="flex-1 min-h-[44px] inline-flex items-center justify-center rounded-lg border border-gray-200 dark:border-gray-600 text-gray-700 dark:text-gray-300 hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-900/30 dark:hover:text-red-400 active:bg-red-100 text-[13px] font-medium transition"
                        >
                          {t("delete") || t("moveToTrash")}
                        </button>
                      )}
                    </div>
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Sticky selection bar */}
      {selected.size > 0 && (() => {
        const selExp = filtered.filter(e => selected.has(e.id));
        const total = selExp.reduce((sum, e) => sum + parseFloat(e.amount), 0);
        const avg = selExp.length ? total / selExp.length : 0;
        const byCat = {};
        selExp.forEach(e => { byCat[e.category_name || "Other"] = (byCat[e.category_name || "Other"] || 0) + parseFloat(e.amount); });
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
            {Object.keys(byCat).length > 0 && (
              <div className="flex flex-wrap gap-1.5 mb-2">
                {Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([cat, amt]) => (
                  <span key={cat} className="px-2 py-0.5 bg-white/15 rounded-full text-[11px]">
                    {cat}: {amt.toLocaleString()}
                  </span>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <button
                onClick={() => {
                  const text = `${selected.size} expenses | Total: ${total.toLocaleString()} ${currency} | Avg: ${Math.round(avg).toLocaleString()} ${currency}`;
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
      </>
      )}

      {/* Receipt capture modal for expenses */}
      {receiptOpen && (
        <ReceiptCapture
          mode="expense"
          onClose={() => setReceiptOpen(false)}
          onSaved={() => { setReceiptOpen(false); fetchData(filterFrom, filterTo); setSuccess("Expense added from receipt"); setTimeout(() => setSuccess(""), 2000); }}
        />
      )}

      {/* Post-save receipt review — shared instance across rows. Opens
          when an expense row's 🧾 chip is clicked. No OCR text shown
          (we don't persist it on save) — just the photo + recorded
          metadata, which is enough for the spot-check use case. */}
      <ReceiptViewer
        open={!!receiptViewing}
        onClose={() => setReceiptViewing(null)}
        imageUrl={receiptViewing?.receipt_photo}
        amount={receiptViewing ? parseFloat(receiptViewing.amount) : null}
        currency={currency}
        date={receiptViewing?.date}
        paymentMethod={receiptViewing?.payment_method}
        description={receiptViewing?.description}
        kind="expense"
      />
    </div>
  );
}
