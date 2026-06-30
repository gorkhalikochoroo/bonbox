// Tier 4 Phase D — ExpensesPage restructure (2026-05-25).
//
// Changes from previous iteration (Task #118 / #119):
//   • Wrap in <PageShell width="default"> — drop manual gutter classes,
//     let PageShell own the chrome (matches SalesPage Phase C).
//   • InboxBanner becomes the hero when messages_this_month > 0; when
//     0 it falls back to the existing slim collapsible row.
//   • Merge top-level Quick / Detailed <TabPills> into ONE EntryCard
//     with a "More fields ↓" disclosure. Sticky per-user via
//     localStorage so a power-user (Maria) opens once and the form
//     remembers. Default = collapsed (quick mode) for the 95% case.
//   • Unify quickAmount/quickMethod/quickNotes/quickDate state hooks
//     into a single set (amount/method/notes/expDate). The old quick
//     submit branched on `quickMode`; now it's one submit handler that
//     defaults category to "Other" when detailedOpen=false and the
//     owner hasn't picked one.
//   • Delete the period KPI right-rail (TODAY / MAY SPENT / AVG / BY
//     CATEGORY). Replace with a single muted line below the form:
//       "This month: X DKK across N expenses · View breakdown in /reports →"
//     Full breakdown lives in /reports — kept the data, moved its
//     home (per the Tier-4 doctrine §5).
//   • Migrate Recent Expenses table from raw <table> + hand-rolled
//     mobile cards to <DataTable> primitive (handles desktop + mobile
//     in one). Migrate the filter row to <FilterBar>.
//   • One-time / Recurring TabPills stay at the top — they switch
//     between two distinct data sources (expenses vs recurring
//     schedules), per the Tier-4 doctrine §5.
//
// Doctrine compliance:
//   • <Button intent="primary"> for the primary CTA, no raw bg-green.
//   • rounded-xl surfaces (PageShell + EntryCard handle this), rounded-lg
//     inputs (FilterBar handles this), rounded-full pills (Chip inside
//     EntryCard handles this).
//   • All icons are Lucide; no emoji in JSX chrome.
//   • DK terminology lock — MOMS, revisor, faktura stay Danish even in
//     EN UI (the existing FX / smart-scan strings already honour this).
//   • All strings via t(key, "fallback") with new keys in useLanguage.
import { useState, useEffect, useRef, useMemo } from "react";
import { useLocation, useNavigate, Link } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useStickyMethod } from "../hooks/useStickyMethod";
import { trackEvent } from "../hooks/useEventLog";
import { exportToCsv } from "../utils/exportCsv";
import { displayCurrency, getTaxConfig } from "../utils/currency";
import { formatDate, localIso } from "../utils/dateFormat";
import TaxBreakdown from "../components/TaxBreakdown";
import { FadeIn } from "../components/AnimationKit";
import ReceiptCapture from "../components/ReceiptCapture";
import GodkendKo from "../components/GodkendKo";
import ReceiptViewer from "../components/ReceiptViewer";
import DismissibleTip from "../components/DismissibleTip";
import InboxBanner from "../components/InboxBanner";
import { safeImageUrl } from "../utils/safeUrl";
import { resizeImageIfLarge } from "../utils/resizeImage";
import { errText } from "../utils/errText";
import RecurringExpensesPanel from "../components/RecurringExpensesPanel";
import { PageHeader, TabPills, Button, Empty } from "../components/ui";
import EntryCard from "../components/ui/EntryCard";
import PageShell from "../components/ui/PageShell";
import DataTable from "../components/ui/DataTable";
import FilterBar from "../components/ui/FilterBar";
import { Mic, Camera, Pencil, Trash2, ChevronDown, ChevronUp, Receipt, ChevronRight, Layers } from "lucide-react";

const QUICK_AMOUNTS = [100, 500, 1000];
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
  const { t, lang } = useLanguage();
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
  // Receipt review modal — opens when user clicks the receipt thumb on
  // an expense row that has receipt_photo set.
  const [receiptViewing, setReceiptViewing] = useState(null);
  const [editData, setEditData] = useState({});
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  // Sticky payment method (expense scope, own key — seeds from the owner's
  // last expense choice, default card). setMethod is in-memory (voice + Smart
  // Scan prefill use it, so neither sticks); commitMethod persists a
  // deliberate picker tap. See useStickyMethod.
  const { method, setMethod, commitMethod } = useStickyMethod("expense");
  const [notes, setNotes] = useState("");
  const [search, setSearch] = useState("");
  const [customCat, setCustomCat] = useState("");
  const customCatRef = useRef(null);
  const [listening, setListening] = useState(false);
  // Top-level tab strip — One-time (existing flow) vs Recurring
  // (Task #47, Starter+ feature). Stays as <TabPills> per Tier-4 spec
  // — these switch between two distinct data sources.
  const [expensesTab, setExpensesTab] = useState("one_time");
  const [isPersonal, setIsPersonal] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  // Per-row "snap to attach a bilag" (the Mangler-bilag loop). Hidden file
  // input + which row it targets. No OCR, no scan-credit — just stores the
  // image + links it via POST /expenses/{id}/attach-receipt.
  const attachInputRef = useRef(null);
  const [attachTargetId, setAttachTargetId] = useState(null);
  const [attaching, setAttaching] = useState(false);
  // "Scan bunke" — burst-capture a pile of receipts into the Godkend-kø as
  // drafts in one ceremony (the OCR/queue creator).
  const burstInputRef = useRef(null);
  const [bursting, setBursting] = useState(false);
  const [isTaxExempt, setIsTaxExempt] = useState(false);
  // Recent-expenses filter — was a tri-state "all/business/personal"
  // chip row in the legacy table header. We collapse it into the
  // <FilterBar> as a select so the row stays consistent with Sales.
  const [showFilter, setShowFilter] = useState("business");
  const [suggestion, setSuggestion] = useState(null);
  const suggestTimer = useRef(null);
  // Category filter for the Recent-Expenses FilterBar.
  const [categoryFilter, setCategoryFilter] = useState("all");

  // Detailed disclosure inside EntryCard. Default CLOSED every session —
  // the 95% quick path stays one-screen. (Previously localStorage-sticky,
  // which silently rendered the full ~7-field form forever after one
  // curious tap; design critique flagged that as the opposite of one-tap.)
  // Smart-Scan verify still auto-opens it transiently to the fields that
  // need confirmation.
  const [detailedOpen, setDetailedOpen] = useState(false);

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
  const [fxRate, setFxRate] = useState("");
  const [fxLiveRate, setFxLiveRate] = useState(null);
  const [fxLoading, setFxLoading] = useState(false);
  const [fxError, setFxError] = useState("");
  const FX_CURRENCIES = ["DKK", "USD", "EUR", "NPR", "GBP", "SEK", "NOK", "PLN"];
  const FX_FALLBACK_TO_DKK = {
    DKK: 1, USD: 6.85, EUR: 7.46, NPR: 0.052, GBP: 8.60,
    SEK: 0.65, NOK: 0.62, PLN: 1.72,
  };

  // Live ECB rate lookup — same as before; non-fatal on failure.
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
          setFxRate(String(rate));
        } else {
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

  // When the FX panel is open and a foreign amount has been typed, push
  // the converted DKK figure into the main amount field. This keeps
  // EntryCard's submit-gate happy (it requires amount > 0) AND it gives
  // the user a single source of truth — the amount they see in the big
  // input matches the amount we'll POST. Only fires while FX is open,
  // so closing the panel reverts to the user's manually-typed amount.
  useEffect(() => {
    if (!fxOpen) return;
    if (fxCurrency.toUpperCase() === accountCcy) return;
    if (fxConvertedAccount != null && fxConvertedAccount > 0) {
      setAmount(fxConvertedAccount.toFixed(2));
    }
    // We intentionally depend on the derived value — when the user
    // edits the FX original amount OR the rate, the main amount
    // re-syncs automatically.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fxOpen, fxCurrency, fxConvertedAccount]);

  // Filtered + sorted list — drives both the DataTable AND the
  // one-line "this month" summary below the form. Memoized so the
  // filter + sort only re-runs when its inputs actually change
  // (expenses / search / showFilter / categoryFilter) — not on every
  // keystroke in the edit panel or every focus-refetch re-render.
  const filtered = useMemo(() => expenses.filter(e => {
    if (search) {
      const needle = search.toLowerCase();
      const haystack = [
        e.description, e.notes, e.payment_method, String(e.amount), e.date,
      ].filter(Boolean).map(s => String(s).toLowerCase()).join(" | ");
      if (!haystack.includes(needle)) return false;
    }
    if (showFilter === "personal" && !e.is_personal) return false;
    if (showFilter === "business" && e.is_personal) return false;
    if (categoryFilter && categoryFilter !== "all" && e.category_id !== categoryFilter) {
      return false;
    }
    return true;
  }).sort((a, b) => {
    const d = b.date.localeCompare(a.date);
    if (d !== 0) return d;
    return (b.created_at || "").localeCompare(a.created_at || "");
  }), [expenses, search, showFilter, categoryFilter]);

  // This-month summary — replaces the 4-tile period KPI right-rail.
  // We scope to month of today (or latest expense when a date filter
  // is active, matching the previous behaviour).
  const monthSummary = useMemo(() => {
    if (expenses.length === 0) {
      return { total: 0, count: 0 };
    }
    const now = new Date();
    const hasFilter = filterFrom || filterTo;
    const refDate = hasFilter
      ? new Date(expenses.reduce((latest, e) => e.date > latest ? e.date : latest, expenses[0].date) + "T12:00:00")
      : now;
    const monthPrefix = localIso(refDate).slice(0, 7);
    const monthExpenses = hasFilter ? expenses : expenses.filter(e => e.date?.startsWith(monthPrefix));
    const total = monthExpenses.reduce((s, x) => s + parseFloat(x.amount), 0);
    return { total, count: monthExpenses.length };
  }, [expenses, filterFrom, filterTo]);

  // The edit form renders as a card BELOW the table (see ~line 1213). On a
  // long expense list, clicking Edit on a row near the top would open that
  // form off-screen below the fold — it looked like "the edit button does
  // nothing". Scroll the form into view whenever it opens. Mirrors the same
  // fix on the Sales page.
  const editPanelRef = useRef(null);
  useEffect(() => {
    if (editId && editPanelRef.current) {
      editPanelRef.current.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, [editId]);

  const startVoice = () => {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) { setError(t("voiceNotSupported")); return; }
    const recognition = new SpeechRecognition();
    recognition.lang = lang === "da" ? "da-DK" : "en-US";
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
          if (text.includes("cash") || text.includes("kontant")) setMethod("cash");
          else if (text.includes("card") || text.includes("kort")) setMethod("card");
          else if (text.includes("mobile")) setMethod("mobilepay");
          const catMatch = categories.find(c => text.includes(c.name.toLowerCase()));
          if (catMatch) { setCatId(catMatch.id); setCustomCat(""); }
          const remaining = text.replace(numMatch[0], "").replace(/cash|kontant|card|kort|mobilepay|mobil|mixed|dankort/g, "").trim();
          if (remaining.length > 2) setDesc(remaining);
          setSuccess(`${t("voiceParsed")}: "${text}" → ${val.toLocaleString()} ${currency}`);
          setTimeout(() => setSuccess(""), 3000);
        }
      } else {
        setError(`${t("couldntParseAmount")}: "${text}"`);
        setTimeout(() => setError(""), 3000);
      }
    };
    recognition.onerror = () => { setListening(false); setError(t("voiceRecognitionFailed")); setTimeout(() => setError(""), 3000); };
    recognition.start();
  };

  // Auto-suggest category from description (Detailed mode only)
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
    }, 400);
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
      .catch((err) => setError(errText(err, t("failedToLoadExpenses"))));
    api.get("/expenses/categories")
      .then((res) => {
        setCategories(res.data);
        if (res.data.length === 0) setShowSetup(true);
      })
      .catch((err) => setError(errText(err, t("failedToLoadCategories"))));
  };

  // Mount fetch gated on user?.id so we don't fire a GET before auth has
  // hydrated. ProtectedRoute already waits for the /auth/me probe, but
  // threading user.id through here also handles hot account switches
  // (impersonation / accountant view) without an extra full reload.
  useEffect(() => {
    if (!user?.id) return;
    fetchData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Cross-page sync (Smart Scan, ReceiptCapture, recurring runner, etc.)
  // Filter values are read via a ref so we always pull the current range
  // without re-binding the listener on every keystroke.
  const filterRef = useRef({ from: "", to: "" });
  filterRef.current = { from: filterFrom, to: filterTo };
  useEffect(() => {
    const onDataChanged = () => fetchData(filterRef.current.from, filterRef.current.to);
    window.addEventListener("bonbox-data-changed", onDataChanged);
    return () => window.removeEventListener("bonbox-data-changed", onDataChanged);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Snap-refresh on tab focus. The "stale after login" case happens when
  // the owner logs in on another tab / completes magic-link and comes
  // back — the page instance is still mounted but its data is from
  // before the trip. visibilitychange covers iOS Safari where focus/blur
  // don't fire reliably (matches the LiveKpisToday pattern).
  useEffect(() => {
    if (!user?.id) return;
    const onVisible = () => {
      if (typeof document !== "undefined" && !document.hidden) {
        fetchData(filterRef.current.from, filterRef.current.to);
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", onVisible);
    }
    return () => {
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", onVisible);
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // ─── Smart Scan prefill consumer ─────────────────────────────────
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
      if (prefill.suggested_amount != null) setAmount(String(prefill.suggested_amount));
      if (prefill.amount != null && !prefill.suggested_amount) setAmount(String(prefill.amount));
      if (prefill.suggested_vendor) setDesc(prefill.suggested_vendor);
      if (!prefill.suggested_vendor && prefill.vendor) setDesc(prefill.vendor);
      if (prefill.suggested_date) setExpDate(prefill.suggested_date);
      if (!prefill.suggested_date && prefill.date) setExpDate(prefill.date);
      if (prefill.payment_method) setMethod(prefill.payment_method);
      const cat = prefill.suggested_category?.category_id || prefill.category_id;
      if (cat) setCatId(cat);
      // Smart Scan prefill carries vendor / amount / date / total verify
      // hints — open the disclosure so the owner sees the fields that
      // need confirmation. Without this, the chips would be hidden.
      if (hints.length > 0) setDetailedOpen(true);
      setSuccess(
        st.source === "smart_scan_manual"
          ? t("smartScan.openedManual", "Åbnet manuelt — udfyld felterne")
          : t("smartScan.prefilled", "Felter pre-udfyldt fra billedet — bekræft venligst"),
      );
      setTimeout(() => setSuccess(""), 4000);
    }
    navigate(location.pathname, { replace: true, state: null });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state]);

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
      setError(errText(err, t("failedToSetupCategories")));
    }
  };

  // Unified submit — replaces the old submit() + submitQuick() pair.
  // When detailedOpen=false, the owner only typed an amount: we default
  // to the "Other" category (auto-create if missing) and use a generic
  // description. When detailedOpen=true, the existing detailed flow
  // runs (category required, smart-scan verify, FX, etc.).
  const submit = async () => {
    const isForeign =
      detailedOpen
      && fxOpen
      && fxCurrency
      && fxCurrency.toUpperCase() !== accountCcy
      && !isNaN(parseFloat(fxOriginalAmount))
      && parseFloat(fxOriginalAmount) > 0
      && typeof fxEffectiveRate === "number"
      && fxEffectiveRate > 0;
    const value = isForeign
      ? Number(fxConvertedAccount.toFixed(2))
      : parseFloat(amount);
    if (!value || value <= 0) return;

    let finalCatId = catId;
    setError("");
    try {
      // Quick path — no category picked, no custom category typed.
      // Default to "Other" (create if missing) so the expense lands
      // with a real category_id and the rest of the app's filters /
      // reports keep working.
      if (!finalCatId && !customCat.trim()) {
        // AI-propose a category from the description (zero extra taps); the
        // owner sees the result on the row and can change it. Only when
        // there's a description to read — never guess from an amount alone.
        if (desc && desc.trim().length >= 2) {
          try {
            const sg = await api.get("/expenses/suggest-category", { params: { q: desc.trim() } });
            if (sg.data?.suggestion?.category_id) finalCatId = sg.data.suggestion.category_id;
          } catch { /* fall through to the honest bucket */ }
        }
        // No category + no signal → land honestly as "Ukategoriseret", never
        // mislabel an uncategorized expense as a fake-clean "Other" (that
        // silent default was the root cause of the junk-category ledger).
        if (!finalCatId) {
          let uncat = categories.find(c => c.name === "Ukategoriseret");
          if (!uncat) {
            const res = await api.post("/expenses/categories", { name: "Ukategoriseret" });
            uncat = res.data;
            setCategories(prev => prev.find(c => c.id === res.data.id) ? prev : [...prev, res.data]);
          }
          finalCatId = uncat.id;
        }
      } else if (!finalCatId && customCat.trim()) {
        // Detailed path — owner typed a custom category. Create it.
        const catRes = await api.post("/expenses/categories", { name: customCat.trim() });
        finalCatId = catRes.data.id;
        setCategories((prev) => {
          if (prev.find((c) => c.id === catRes.data.id)) return prev;
          return [...prev, catRes.data];
        });
        setCatId(catRes.data.id);
        setCustomCat("");
      }

      const finalDesc = desc
        || customCat.trim()
        || categories.find(c => c.id === finalCatId)?.name
        || (notes && notes.trim())
        || t("expense", "Expense");

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
      // Optimistic insert so the new row appears at the top of the
      // table instantly, even on a slow POST (Render cold-start can be
      // 2-15s). The temp row carries _pending=true and gets replaced by
      // the canonical server response on success / rolled back on
      // failure.
      const tempId = `temp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      const optimisticRow = {
        id: tempId,
        ...payload,
        created_at: new Date().toISOString(),
        _pending: true,
      };
      setExpenses(prev => [optimisticRow, ...prev]);
      const submittedSnapshot = {
        amount, desc, method, notes, customCat, isPersonal, isTaxExempt, expDate,
      };
      setAmount("");
      setDesc("");
      // Keep the chosen method (sticky) — don't reset to card after each add.
      setNotes("");
      setCustomCat("");
      setIsPersonal(false);
      setIsTaxExempt(false);
      setExpDate(localIso());
      setFxOpen(false);
      setFxOriginalAmount("");
      setFxRate("");
      setFxLiveRate(null);
      setFxError("");
      try {
        const res = await api.post("/expenses", payload);
        if (res?.data && res.data.id) {
          setExpenses(prev => prev.map(e => e.id === tempId ? res.data : e));
        } else {
          fetchData(filterFrom, filterTo);
        }
      } catch (postErr) {
        // Roll back optimistic insert + restore the form values so the
        // owner can retry without retyping.
        setExpenses(prev => prev.filter(e => e.id !== tempId));
        setAmount(submittedSnapshot.amount);
        setDesc(submittedSnapshot.desc);
        setMethod(submittedSnapshot.method);
        setNotes(submittedSnapshot.notes);
        setCustomCat(submittedSnapshot.customCat);
        setIsPersonal(submittedSnapshot.isPersonal);
        setIsTaxExempt(submittedSnapshot.isTaxExempt);
        setExpDate(submittedSnapshot.expDate);
        throw postErr;
      }
      const isBackdated = submittedSnapshot.expDate !== localIso();
      trackEvent(
        isForeign ? "expense_logged_fx" : "expense_logged",
        "expenses",
        isForeign
          ? `${parseFloat(fxOriginalAmount)} ${fxCurrency} → ${value} ${currency}`
          : `${value} ${currency}`,
      );
      setSuccess(`${value.toLocaleString()} ${currency}${isBackdated ? ` (${formatDate(submittedSnapshot.expDate)})` : ""}!`);
      window.dispatchEvent(new Event("bonbox-data-changed"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(errText(err, t("failedToAddExpense")));
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
      // Keep the Dashboard's expense total / profit / margin in sync — the
      // add path fires this; edit + delete must too, or a mounted Dashboard
      // goes stale until manual reload.
      window.dispatchEvent(new Event("bonbox-data-changed"));
      setSuccess(t("expenseUpdated"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(errText(err, t("failedToUpdateExpense")));
    }
  };

  const deleteExpense = async (id) => {
    try {
      await api.delete(`/expenses/${id}`);
      setDeleteConfirm(null);
      fetchData(filterFrom, filterTo);
      window.dispatchEvent(new Event("bonbox-data-changed"));
      setSuccess(t("movedToRecentlyDeleted"));
      setTimeout(() => setSuccess(""), 2500);
    } catch (err) {
      setError(errText(err, t("failedToDeleteExpense")));
    }
  };

  const getCatName = (catId) => {
    const cat = categories.find((c) => c.id === catId);
    return cat ? cat.name : "";
  };

  // ── FilterBar values + reset gate ───────────────────────────────
  const categoryOptions = [
    { value: "all", label: t("allCategoriesFilter", "All categories") },
    ...categories.map((c) => ({ value: c.id, label: c.name })),
  ];
  const hasActiveFilter = !!(
    filterFrom
    || filterTo
    || search
    || (categoryFilter && categoryFilter !== "all")
  );
  const clearAllFilters = () => {
    setFilterFrom("");
    setFilterTo("");
    setSearch("");
    setCategoryFilter("all");
    fetchData();
  };

  // Detailed-disclosure extras — the contents of the "More fields"
  // section inside EntryCard.extras. Lives here so the JSX inside the
  // EntryCard call stays readable.
  const detailedExtras = (
    <div className="space-y-2.5">
      {/* Category chips (Business-only — Personal categories hidden) */}
      <div>
        <p className="text-xs text-gray-500 dark:text-gray-400 mb-1.5">
          {t("pickCategory")}
        </p>
        <div className="flex flex-wrap gap-1.5">
          {categories
            .filter((c) => !PERSONAL_ONLY_CATS.has(c.name))
            .map((c) => (
              <button
                key={c.id}
                type="button"
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
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition ${
                  catId === c.id
                    ? "bg-gray-900 dark:bg-gray-50 border-gray-900 dark:border-gray-50 text-white dark:text-gray-900"
                    : "bg-white dark:bg-gray-900 border-gray-200 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:border-gray-300 dark:hover:border-gray-600 hover:bg-gray-50 dark:hover:bg-gray-800/60"
                }`}
              >
                {c.name}
              </button>
            ))}
        </div>
      </div>

      {/* Custom-category input + matching suggestions dropdown */}
      <div className="flex items-center gap-2 relative">
        <span className="text-xs text-gray-400 dark:text-gray-500">{t("or")}</span>
        <div className="flex-1 relative">
          <input
            ref={customCatRef}
            type="text"
            value={customCat}
            onChange={(e) => { setCustomCat(e.target.value); if (e.target.value) setCatId(""); }}
            placeholder={t("customCategoryPlaceholder")}
            className="w-full px-2.5 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 bg-white dark:bg-gray-900 dark:text-white"
          />
          {customCat.length >= 1 && (() => {
            const matches = categories.filter(c =>
              c.name.toLowerCase().includes(customCat.toLowerCase())
              && c.name.toLowerCase() !== customCat.toLowerCase(),
            );
            if (matches.length === 0) return null;
            return (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg shadow-sm z-20 max-h-32 overflow-y-auto">
                {matches.slice(0, 5).map(c => (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => { setCatId(c.id); setCustomCat(""); setDesc(c.name); }}
                    className="w-full text-left px-3 py-1.5 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-50 dark:hover:bg-gray-700/50 transition"
                  >
                    {c.name}
                  </button>
                ))}
              </div>
            );
          })()}
        </div>
      </div>

      {/* Vendor verify chip (Smart Scan) */}
      {showVerifyChip("vendor") && (
        <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300 flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />
          {t("smartScan.verifyHint", "Bekræft venligst")} — {t("vendor", "Vendor")}
        </p>
      )}

      {/* Description / vendor input + auto-suggest */}
      <div className="relative">
        <input
          type="text"
          value={desc}
          onChange={(e) => { setDesc(e.target.value); fetchSuggestion(e.target.value); markTouched("vendor"); }}
          placeholder={t("whatWasIt")}
          className={`w-full px-2.5 py-1.5 border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-gray-400 bg-white dark:bg-gray-900 dark:text-white ${
            showVerifyChip("vendor")
              ? "border-amber-300 dark:border-amber-600 bg-amber-50/50 dark:bg-amber-900/10"
              : "border-gray-200 dark:border-gray-700"
          }`}
        />
        {suggestion && !catId && (
          <Button
            variant="ghost"
            size="sm"
            onClick={applySuggestion}
            className="absolute right-1 top-1/2 -translate-y-1/2"
          >
            {suggestion.category_name}
          </Button>
        )}
      </div>

      {/* Amount verify chip (Smart Scan) */}
      {(showVerifyChip("amount") || showVerifyChip("total")) && (
        <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300 flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />
          {t("smartScan.verifyHint", "Bekræft venligst")} — {t("amount", "Amount")}
        </p>
      )}

      {/* Foreign-currency capture (Bogføringsloven §10 cross-border) */}
      <div>
        <button
          type="button"
          onClick={() => setFxOpen(!fxOpen)}
          className={`text-xs font-medium inline-flex items-center gap-1 ${
            fxOpen
              ? "text-amber-700 dark:text-amber-300"
              : "text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200"
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
                className="flex-1 px-2.5 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
              />
              <select
                value={fxCurrency}
                onChange={(e) => setFxCurrency(e.target.value.toUpperCase())}
                className="px-2 py-1.5 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
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
                className="w-28 px-2 py-1 border border-gray-200 dark:border-gray-700 rounded-lg bg-white dark:bg-gray-900 dark:text-white text-xs"
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

      {/* Tax breakdown (MOMS / VAT) */}
      <TaxBreakdown
        amount={amount}
        currencyCode={user?.currency}
        type="expenses"
        isTaxExempt={isTaxExempt}
        onTaxExemptChange={setIsTaxExempt}
      />

      {/* Date verify chip (Smart Scan) */}
      {showVerifyChip("date") && (
        <p className="text-[11px] font-medium text-amber-700 dark:text-amber-300 flex items-center gap-1">
          <span className="inline-block w-2 h-2 rounded-full bg-amber-500" aria-hidden="true" />
          {t("smartScan.verifyHint", "Bekræft venligst")} — {t("date", "Date")}
        </p>
      )}

      {expDate !== localIso() && (
        <p className="text-xs text-amber-600 dark:text-amber-400 font-medium">{t("backdatedEntry")}</p>
      )}

      {/* Business / Personal toggle — only meaningful when the owner is
          on the detailed path (quick mode always logs as business). */}
      <div className="flex items-center gap-3 pt-1">
        <button
          type="button"
          onClick={() => setIsPersonal(!isPersonal)}
          className={`relative inline-flex h-6 w-11 items-center rounded-full transition ${
            isPersonal ? "bg-gray-700 dark:bg-gray-200" : "bg-gray-200 dark:bg-gray-700"
          }`}
        >
          <span className={`inline-block h-4 w-4 rounded-full bg-white dark:bg-gray-900 transition transform ${isPersonal ? "translate-x-6" : "translate-x-1"}`} />
        </button>
        <span className="text-sm font-medium text-gray-700 dark:text-gray-300">
          {isPersonal ? t("personalExpense") : t("businessExpense")}
        </span>
        {isPersonal && (
          <span className="text-xs text-gray-500 dark:text-gray-400">{t("excludedFromReports")}</span>
        )}
      </div>
    </div>
  );

  // Snap a bilag onto an EXISTING expense (the "Mangler bilag" loop).
  // Opens the device camera / file picker; on pick we resize, store + link
  // the image with no OCR and no scan-credit spent.
  const triggerAttachReceipt = (rowId) => {
    setAttachTargetId(rowId);
    // Reset so re-picking the same file still fires onChange.
    if (attachInputRef.current) attachInputRef.current.value = "";
    attachInputRef.current?.click();
  };

  const onAttachFileChange = async (e) => {
    const rawFile = e.target.files?.[0];
    const rowId = attachTargetId;
    if (!rawFile || !rowId) return;
    setAttaching(true);
    try {
      const file = await resizeImageIfLarge(rawFile);
      const formData = new FormData();
      formData.append("file", file);
      await api.post(`/expenses/${rowId}/attach-receipt`, formData, { timeout: 60000 });
      await fetchData(filterFrom, filterTo);
      setSuccess(t("expBilagAttached", "Receipt attached"));
      setTimeout(() => setSuccess(""), 2000);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : t("expBilagAttachFailed", "Could not attach receipt"));
      setTimeout(() => setError(""), 3000);
    } finally {
      setAttaching(false);
      setAttachTargetId(null);
    }
  };

  // Burst-capture: shoot a pile of receipts → each lands in the Godkend-kø as
  // a draft (server OCRs + creates pending rows). setSuccess bumps GodkendKo's
  // refreshToken so the queue refetches and the drafts appear.
  const triggerBurst = () => {
    if (burstInputRef.current) burstInputRef.current.value = "";
    burstInputRef.current?.click();
  };

  const onBurstFiles = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setBursting(true);
    try {
      const fd = new FormData();
      for (const f of files) {
        const img = await resizeImageIfLarge(f);
        fd.append("files", img);
      }
      const res = await api.post("/expenses/burst-scan", fd, { timeout: 120000 });
      const n = res?.data?.created ?? 0;
      const capMsg = res?.data?.cap_reached ? ` · ${t("koBurstCapReached", "scan limit reached")}` : "";
      setSuccess(`${t("koBurstDone", "{n} added to the queue").replace("{n}", String(n))}${capMsg}`);
      setTimeout(() => setSuccess(""), 3500);
      fetchData(filterFrom, filterTo);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      setError(typeof detail === "string" ? detail : t("koBurstFailed", "Could not scan the pile"));
      setTimeout(() => setError(""), 3000);
    } finally {
      setBursting(false);
    }
  };

  // ── DataTable columns + rowActions ──────────────────────────────
  const tableColumns = [
    {
      id: "description",
      label: t("description", "Description"),
      render: (r) => {
        const thumbUrl = r.receipt_photo ? safeImageUrl(r.receipt_photo) : null;
        return (
          <span className="inline-flex items-center gap-2">
            {r.receipt_photo ? (
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); setReceiptViewing(r); }}
                title={t("receiptViewerOpen") || "View receipt"}
                aria-label={t("receiptViewerOpen") || "View receipt"}
                className="inline-flex items-center justify-center w-9 h-9 rounded-lg overflow-hidden border border-gray-200 dark:border-gray-700 hover:border-gray-300 dark:hover:border-gray-600 text-gray-500 transition"
              >
                {thumbUrl ? (
                  <img
                    src={thumbUrl}
                    alt={t("receiptViewerImageAlt") || "Receipt"}
                    loading="lazy"
                    className="w-full h-full object-cover"
                    onError={(e) => {
                      e.currentTarget.style.display = "none";
                    }}
                  />
                ) : (
                  <Receipt size={14} strokeWidth={1.75} aria-hidden="true" />
                )}
              </button>
            ) : (!r.is_personal && !r.is_tax_exempt) ? (
              // Missing bilag on a business expense → one-tap snap-to-attach
              // (dashed amber = "evidence missing"). Completes the Mangler-
              // bilag loop: tap → camera → stored + linked, no OCR/credit.
              <button
                type="button"
                onClick={(e) => { e.stopPropagation(); triggerAttachReceipt(r.id); }}
                disabled={attaching}
                title={t("expAttachBilag", "Snap a receipt")}
                aria-label={t("expAttachBilag", "Snap a receipt")}
                className="inline-flex items-center justify-center w-9 h-9 rounded-lg border border-dashed border-amber-300 dark:border-amber-800 text-amber-600 dark:text-amber-400 hover:border-amber-400 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition disabled:opacity-40"
              >
                <Camera size={14} strokeWidth={1.75} aria-hidden="true" />
              </button>
            ) : null}
            <span className="truncate">
              {r.description || getCatName(r.category_id)}
            </span>
            {r.is_personal && (
              <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                {t("personalMode")}
              </span>
            )}
          </span>
        );
      },
    },
    {
      id: "category",
      label: t("category", "Category"),
      render: (r) => getCatName(r.category_id),
    },
    {
      id: "amount",
      label: t("amount", "Amount"),
      align: "right",
      render: (r) => `${parseFloat(r.amount).toLocaleString()} ${currency}`,
    },
    {
      id: "payment",
      label: t("payment", "Payment"),
      render: (r) => r.payment_method
        ? <span className="capitalize">{t(r.payment_method)}</span>
        : "—",
    },
    {
      id: "date",
      label: t("date", "Date"),
      width: "w-28",
      render: (r) => formatDate(r.date),
    },
  ];

  const rowActions = (row) => [
    {
      label: t("edit", "Edit"),
      icon: <Pencil size={14} strokeWidth={1.75} />,
      onClick: () => startEdit(row),
    },
    {
      label: t("delete", "Move to trash"),
      icon: <Trash2 size={14} strokeWidth={1.75} />,
      onClick: () => {
        // Two-step confirm — keep the existing safety net.
        if (deleteConfirm === row.id) {
          deleteExpense(row.id);
        } else {
          setDeleteConfirm(row.id);
          // Auto-clear the confirm after 5s so a stray click doesn't
          // arm the next delete-button accidentally.
          setTimeout(() => setDeleteConfirm((cur) => cur === row.id ? null : cur), 5000);
        }
      },
      variant: "danger",
    },
  ];

  return (
    <PageShell width="default">
      <FadeIn>
        <PageHeader
          eyebrow="MONEY"
          title={t("expenseTracker")}
        />
      </FadeIn>

      {success && (
        <div className="bg-gray-50 dark:bg-gray-800/50 text-gray-800 dark:text-gray-200 border border-gray-100 dark:border-gray-700 px-4 py-3 rounded-xl text-sm font-medium">
          {success}
        </div>
      )}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-300 border border-red-200 dark:border-red-800/40 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* Godkend-kø — AI-drafted expenses awaiting approval. Self-hides when
          empty; drafts are excluded from MOMS/Foresight until the owner taps
          Godkend. Sits at the top: when there's a pile to clear, it's the job. */}
      <GodkendKo
        getCatName={getCatName}
        currency={currency}
        onApproved={() => fetchData(filterFrom, filterTo)}
        onEdit={startEdit}
        refreshToken={success}
      />

      {/* InboxBanner — hero when there are unread receipts, slim row
          when 0. The hero CTA scrolls to #bonbox-recent-expenses. */}
      <InboxBanner hero />

      {showSetup && (
        <div className="bg-gray-50 dark:bg-gray-800/50 border border-gray-200 dark:border-gray-700 p-5 rounded-xl">
          <p className="text-gray-900 dark:text-gray-100 font-medium mb-2">{t("firstTimeSetup")}</p>
          <p className="text-gray-600 dark:text-gray-400 text-sm mb-3">{DEFAULT_CATEGORIES.join(", ")}</p>
          <Button variant="primary" size="md" onClick={quickSetup}>
            {t("setupCategories")}
          </Button>
        </div>
      )}

      {/* One-time / Recurring tab strip — kept as <TabPills> per
          Tier-4 spec §6: two distinct data sources, not a progressive
          disclosure. */}
      <TabPills
        ariaLabel={t("expTypeAria", "Expense type")}
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
          {/* GROUP A — "Add an expense": snap (primary, the headline) + scan-
              a-pile INLINE on desktop, an "or" divider, then the manual keypad.
              One grouped section so the locked page rhythm (space-y-6) falls
              between logical groups, not between every capture block — this is
              what kills the "floating cards" gaps. */}
          <div className="space-y-3">
            <div className="flex flex-col sm:flex-row gap-2.5 sm:gap-3 sm:items-stretch">
              <button
                type="button"
                onClick={() => setReceiptOpen(true)}
                className="flex-1 flex items-center gap-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-3.5 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition text-left"
              >
                <span className="shrink-0 inline-flex items-center justify-center w-10 h-10 rounded-full bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900">
                  <Camera size={20} strokeWidth={1.75} aria-hidden="true" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[15px] font-semibold text-gray-900 dark:text-gray-100">
                    {t("expSnapHeroTitle", "Snap a receipt")}
                  </span>
                  <span className="block text-sm text-gray-500 dark:text-gray-400 mt-0">
                    {t("expSnapHeroSub", "We read the amount, date and MOMS — you just confirm")}
                  </span>
                </span>
                <ChevronRight size={18} strokeWidth={2} className="shrink-0 text-gray-300 dark:text-gray-600" aria-hidden="true" />
              </button>
              {/* Scan bunke — inline next to snap on desktop, full-width below it
                  on mobile; each receipt lands as a draft in the Godkend-kø above. */}
              <button
                type="button"
                onClick={triggerBurst}
                disabled={bursting}
                className="sm:w-44 shrink-0 min-h-11 flex items-center justify-center gap-2 rounded-xl border border-dashed border-gray-300 dark:border-gray-700 py-2.5 px-3 text-sm font-medium text-gray-600 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800/60 transition disabled:opacity-50"
              >
                <Layers size={16} strokeWidth={1.75} aria-hidden="true" />
                {bursting ? t("expScanning", "Scanning…") : t("expScanPile", "Scan a pile")}
              </button>
            </div>
            {/* "or enter it manually" — a real hairline divider, not orphan text. */}
            <div className="flex items-center gap-3">
              <div className="flex-1 border-t border-gray-200 dark:border-gray-800" aria-hidden="true" />
              <span className="text-xs text-gray-400 dark:text-gray-500 shrink-0">{t("expOrTypeManually", "or enter it manually")}</span>
              <div className="flex-1 border-t border-gray-200 dark:border-gray-800" aria-hidden="true" />
            </div>

          {/* EntryCard — the manual fallback (secondary to the snap tile).
              The detailed disclosure lives inside `extras`. */}
          <EntryCard
            density="compact"
            title={t("addExpense")}
            hint={t("quickAmountAndGo")}
            amountPresets={QUICK_AMOUNTS}
            amount={amount}
            onAmountChange={(v) => { setAmount(v); markTouched("amount"); markTouched("total"); }}
            amountPlaceholder={
              detailedOpen
                ? `${t("customAmount")} ${getTaxConfig(user?.currency).rate > 0 ? `(${getTaxConfig(user?.currency).label})` : ""}`
                : t("customAmount")
            }
            amountSuffix={currency}
            paymentMethods={["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => ({ id: m, label: t(m) }))}
            paymentMethod={method}
            onPaymentChange={commitMethod}
            voiceInput={true}
            onVoiceClick={startVoice}
            voiceIcon={<Mic className={`w-4 h-4 ${listening ? "text-red-600 dark:text-red-400 animate-pulse" : ""}`} />}
            notes={notes}
            onNotesChange={setNotes}
            notesPlaceholder={t("notesOptional")}
            date={expDate}
            onDateChange={(v) => { setExpDate(v); markTouched("date"); }}
            submitLabel={t("add")}
            onSubmit={submit}
            extras={
              <>
                {detailedOpen && detailedExtras}

                {/* Toggle for the disclosure. Doctrine: this is a
                    text-style link, not a primary button — primary action
                    on this card is the Add submit. Sticky preference
                    means the button effectively only gets pressed when
                    the owner wants to change their default flow. */}
                <button
                  type="button"
                  onClick={() => setDetailedOpen(!detailedOpen)}
                  className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 inline-flex items-center gap-1.5 mt-2"
                  aria-expanded={detailedOpen}
                >
                  {detailedOpen
                    ? <><ChevronUp size={14} strokeWidth={1.75} aria-hidden="true" /> {t("fewerFields", "Fewer fields")}</>
                    : <><ChevronDown size={14} strokeWidth={1.75} aria-hidden="true" /> {t("moreFields", "More fields")}</>}
                </button>
              </>
            }
          />
          </div>

          {/* GROUP B — month status pair: the one-line "this month" summary
              and the missing-bilag nudge read as one block (tight space-y),
              with the locked page rhythm before the group and before the
              Recent table below — not orphaned between each line. */}
          <div className="space-y-2.5">
          {/* One-line "this month" summary — replaces the deleted
              4-tile period KPI right-rail. Full breakdown lives in
              /reports (per Tier-4 doctrine §1: ExpenseBreakdownCard
              demoted to /reports). */}
          <p className="text-xs text-gray-500 dark:text-gray-400 px-1">
            {t("thisMonthSummary", "This month: {total} across {count} expenses · ", {
              total: `${monthSummary.total.toLocaleString()} ${currency}`,
              count: monthSummary.count,
            })}
            <Link
              to="/reports?tab=expenses"
              className="text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 underline"
            >
              {t("viewBreakdown", "View breakdown in /reports →")}
            </Link>
          </p>

          {/* Mangler bilag — fradrag at risk. Surfacing the gap IS the
              compliance value: a live count of business expenses with no
              receipt_photo, whose MOMS-fradrag the revisor can't defend
              under Bogføringsloven. Pull-only + page-local (no nagging);
              self-hides at zero. Personal / tax-exempt rows are excluded
              (they carry no fradrag). */}
          {(() => {
            const missing = expenses.filter(
              (e) => !e.receipt_photo && !e.is_personal && !e.is_tax_exempt,
            );
            if (!missing.length) return null;
            const missTotal = missing.reduce(
              (s, e) => s + (parseFloat(e.amount) || 0),
              0,
            );
            return (
              <button
                type="button"
                onClick={() =>
                  document
                    .getElementById("bonbox-recent-expenses")
                    ?.scrollIntoView({ behavior: "smooth" })
                }
                className="w-full text-left flex items-center gap-3 rounded-xl border border-amber-200 dark:border-amber-900/40 bg-amber-50/60 dark:bg-amber-900/10 px-4 py-3 hover:bg-amber-50 dark:hover:bg-amber-900/20 transition"
              >
                <Receipt
                  className="w-5 h-5 shrink-0 text-amber-600 dark:text-amber-400"
                  strokeWidth={1.75}
                  aria-hidden="true"
                />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm font-semibold text-gray-900 dark:text-gray-100">
                    {t("expMissingBilagTitle", "{n} expenses missing a receipt").replace("{n}", String(missing.length))}
                  </span>
                  <span className="block text-xs text-gray-600 dark:text-gray-400 mt-0.5 tabular-nums">
                    {t("expMissingBilagSub", "{amt} in expenses with no bilag — snap it to keep the fradrag").replace("{amt}", `${missTotal.toLocaleString()} ${currency}`)}
                  </span>
                </span>
                <ChevronRight
                  className="w-4 h-4 shrink-0 text-amber-500"
                  strokeWidth={2}
                  aria-hidden="true"
                />
              </button>
            );
          })()}
          </div>

          {/* Recent expenses — DataTable + FilterBar (Tier-4 doctrine
              §5). The id anchor matches the InboxBanner hero CTA's
              `href="#bonbox-recent-expenses"` so "Review N receipts"
              scrolls here. */}
          <section
            id="bonbox-recent-expenses"
            className="space-y-3 scroll-mt-4"
            aria-label={t("recentExpensesHeading", "Recent expenses")}
          >
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {t("recentExpensesHeading", "Recent expenses")}
              </h2>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => exportToCsv("expenses.csv", expenses.map(exp => ({
                  ...exp,
                  category_name: getCatName(exp.category_id),
                })), [
                  { key: "date", label: t("date") },
                  { key: "description", label: t("description") },
                  { key: "category_name", label: t("category") },
                  { key: "amount", label: t("amount") },
                ])}
              >
                {t("exportCsv")}
              </Button>
            </div>

            <FilterBar>
              <FilterBar.Select
                label={t("category", "Category")}
                value={categoryFilter}
                onChange={setCategoryFilter}
                options={categoryOptions}
              />
              <FilterBar.Date
                label={t("fromDate", "From")}
                value={filterFrom}
                onChange={(v) => { setFilterFrom(v); fetchData(v, filterTo); }}
              />
              <FilterBar.Date
                label={t("toDate", "To")}
                value={filterTo}
                onChange={(v) => { setFilterTo(v); fetchData(filterFrom, v); }}
              />
              <FilterBar.Search
                value={search}
                onChange={setSearch}
                placeholder={t("searchExpensesPh", "Description, amount, notes...")}
              />
              {hasActiveFilter && <FilterBar.Reset onClick={clearAllFilters} />}
            </FilterBar>

            <DataTable
              columns={tableColumns}
              rows={filtered.slice(0, 50)}
              rowKey="id"
              empty={
                <Empty
                  icon={<Receipt size={28} strokeWidth={1.5} className="text-gray-400 dark:text-gray-500" aria-hidden="true" />}
                  title={t("noExpensesYet", "No expenses yet")}
                  body={t("noExpensesBody", "Add one above or forward a receipt to your inbox.")}
                />
              }
              rowActions={rowActions}
            />
          </section>

          {/* Inline edit — when the owner clicks "Edit" the DataTable
              row stays put; we surface the edit form as a separate
              compact card below the table. This keeps DataTable
              concerned only with display and works on mobile too
              (the table renders as stacked cards there). */}
          {editId && (
            <div ref={editPanelRef} className="rounded-xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-900 p-4 sm:p-5 space-y-3 scroll-mt-24">
              <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
                {t("edit", "Edit")} · {editData.description || ""}
              </h3>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <input
                  type="text"
                  value={editData.description || ""}
                  onChange={(e) => setEditData({ ...editData, description: e.target.value })}
                  placeholder={t("description")}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
                />
                <select
                  value={editData.category_id || ""}
                  onChange={(e) => setEditData({ ...editData, category_id: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
                >
                  {categories.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <input
                  type="number"
                  value={editData.amount ?? ""}
                  onChange={(e) => setEditData({ ...editData, amount: e.target.value === "" ? "" : parseFloat(e.target.value) || 0 })}
                  placeholder={t("amount")}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
                />
                <select
                  value={editData.payment_method || "card"}
                  onChange={(e) => setEditData({ ...editData, payment_method: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
                >
                  {["cash", "card", "mobilepay", "online", "mixed", "dankort"].map((m) => (
                    <option key={m} value={m}>{t(m)}</option>
                  ))}
                </select>
                <input
                  type="date"
                  value={editData.date || ""}
                  onChange={(e) => setEditData({ ...editData, date: e.target.value })}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
                />
                <input
                  type="text"
                  value={editData.notes || ""}
                  onChange={(e) => setEditData({ ...editData, notes: e.target.value })}
                  placeholder={t("notes")}
                  className="w-full px-3 py-2 border border-gray-200 dark:border-gray-700 rounded-lg text-sm bg-white dark:bg-gray-900 dark:text-white focus:outline-none focus:ring-2 focus:ring-gray-400"
                />
              </div>
              <div className="flex gap-2">
                <Button variant="ghost" size="md" onClick={() => { setEditId(null); setEditData({}); }}>
                  {t("cancel")}
                </Button>
                <Button variant="primary" size="md" onClick={saveEdit}>
                  {t("save")}
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Hidden input backing the per-row "snap to attach a bilag" flow. */}
      <input
        ref={attachInputRef}
        type="file"
        accept="image/*"
        capture="environment"
        className="hidden"
        onChange={onAttachFileChange}
      />

      {/* Hidden multi-file input backing "Scan bunke" (the burst creator). */}
      <input
        ref={burstInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={onBurstFiles}
      />

      {/* Receipt capture modal for expenses */}
      {receiptOpen && (
        <ReceiptCapture
          mode="expense"
          onClose={() => setReceiptOpen(false)}
          onSaved={() => {
            setReceiptOpen(false);
            fetchData(filterFrom, filterTo);
            setSuccess(t("expenseAddedFromReceipt", "Expense added from receipt"));
            setTimeout(() => setSuccess(""), 2000);
          }}
        />
      )}

      {/* Post-save receipt review — shared instance across rows. */}
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
    </PageShell>
  );
}
