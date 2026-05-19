import { useState, useEffect, useRef, useCallback } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import { displayCurrency } from "../utils/currency";
import { FadeIn, StaggerGrid, StaggerGridItem } from "../components/AnimationKit";
import { Button, Card, Icon, UpgradeNudge } from "../components/ui";
import { useToast } from "../components/BonBoxPolishKit";

const BANK_LABELS = {
  danske_bank: { label: "Danske Bank", icon: "🏦" },
  nordea: { label: "Nordea", icon: "🏦" },
  jyske_bank: { label: "Jyske Bank", icon: "🏦" },
  lunar: { label: "Lunar", icon: "🌙" },
  revolut: { label: "Revolut", icon: "💳" },
};

// Banks that support direct Aiia connection (Task #67). Matches the
// SUPPORTED_BANKS allowlist on the backend Pydantic schema.
const AIIA_BANKS = [
  { slug: "danske_bank", label: "Danske Bank" },
  { slug: "nordea", label: "Nordea" },
  { slug: "jyske_bank", label: "Jyske Bank" },
  { slug: "spar_nord", label: "Spar Nord" },
  { slug: "lunar", label: "Lunar" },
  { slug: "sydbank", label: "Sydbank" },
  { slug: "arbejdernes_landsbank", label: "Arbejdernes Landsbank" },
];

export default function BankImportPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();
  const { hasFeature } = useEntitlements();
  const canAutoReconcile = hasFeature("bank_auto_reconcile");
  const { showToast, ToastContainer } = useToast();

  // States: upload → preview → done → reconcile
  // Reconcile is reachable from either preview (after manual import)
  // or directly from done (Match against open invoices button).
  const [step, setStep] = useState("upload"); // upload | preview | done | reconcile
  const [file, setFile] = useState(null);
  const [bankOverride, setBankOverride] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  // Preview data
  const [preview, setPreview] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [categories, setCategories] = useState({}); // ref_hash → category_name
  const [userCategories, setUserCategories] = useState([]);

  // Result
  const [result, setResult] = useState(null);

  // Aiia direct connect (Task #67). Stays at the top of the page —
  // primary CTA — so owners discover it before scrolling to CSV upload.
  const [aiiaBank, setAiiaBank] = useState("danske_bank");
  const [aiiaLoading, setAiiaLoading] = useState(false);

  const startAiiaConnect = async () => {
    if (!canAutoReconcile) return;
    setAiiaLoading(true);
    setError("");
    try {
      const res = await api.post("/bank-connect/init", { bank_slug: aiiaBank });
      const consentUrl = res?.data?.consent_url;
      if (!consentUrl) throw new Error("Backend did not return a consent_url");
      // Full redirect — the bank's SCA page expects a top-level navigation,
      // not an XHR follow. The bank then bounces back to our /api/bank-
      // connect/callback which redirects to /connections?bank_connected=1.
      window.location.assign(consentUrl);
    } catch (err) {
      setError(
        err?.response?.data?.detail?.message ||
          err?.response?.data?.detail ||
          err?.message ||
          "Couldn't start bank connection — try again",
      );
      setAiiaLoading(false);
    }
  };

  // Reconciliation data
  // suggestions: server response { transactions: [...], counts: {...} }
  // chosen: txn_id → suggestion (the one selected for this row, default
  //         = the top suggestion if any). Owner can flip between the
  //         top-3 via the row's dropdown.
  // skipped: Set<txn_id> for rows the owner explicitly skipped this pass.
  const [suggestions, setSuggestions] = useState(null);
  const [chosen, setChosen] = useState({});
  const [skipped, setSkipped] = useState(new Set());
  const [reconcileResult, setReconcileResult] = useState(null);

  const fileRef = useRef(null);
  const dropRef = useRef(null);

  // Fetch user's expense categories
  useEffect(() => {
    api.get("/expenses/categories").then((r) => {
      setUserCategories(r.data.map((c) => c.name));
    }).catch(() => {});
  }, []);

  // ── File handling ──
  const handleFile = (f) => {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".csv")) {
      setError("Please select a .csv file");
      return;
    }
    if (f.size > 5 * 1024 * 1024) {
      setError("File too large (max 5 MB)");
      return;
    }
    setFile(f);
    setError("");
  };

  const onDrop = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    dropRef.current?.classList.remove("ring-2", "ring-blue-400");
    const f = e.dataTransfer?.files?.[0];
    if (f) handleFile(f);
  }, []);

  const onDragOver = useCallback((e) => {
    e.preventDefault();
    dropRef.current?.classList.add("ring-2", "ring-blue-400");
  }, []);

  const onDragLeave = useCallback(() => {
    dropRef.current?.classList.remove("ring-2", "ring-blue-400");
  }, []);

  // ── Upload & Preview ──
  const uploadAndPreview = async () => {
    if (!file) return;
    setLoading(true);
    setError("");
    try {
      const formData = new FormData();
      formData.append("file", file);
      const params = bankOverride ? `?bank=${bankOverride}` : "";
      const res = await api.post(`/bank-import/preview${params}`, formData);
      const data = res.data;

      if (!data.transactions || data.transactions.length === 0) {
        setError("No transactions found in file. Check the file format.");
        setLoading(false);
        return;
      }

      setPreview(data);
      // Select all by default
      setSelected(new Set(data.transactions.map((t) => t.ref_hash)));
      // Set categories from suggestions
      const cats = {};
      data.transactions.forEach((t) => {
        cats[t.ref_hash] = t.suggested_category || (t.type === "income" ? "Sales" : "Other");
      });
      setCategories(cats);
      setStep("preview");
    } catch (err) {
      setError(err.response?.data?.detail || "Failed to parse CSV. Try selecting your bank manually.");
    }
    setLoading(false);
  };

  // ── Confirm Import ──
  const confirmImport = async () => {
    if (!preview) return;
    setLoading(true);
    setError("");

    const txns = preview.transactions
      .filter((t) => selected.has(t.ref_hash))
      .map((t) => ({
        date: t.date,
        description: t.description,
        amount: t.amount,
        type: t.type,
        category_name: categories[t.ref_hash] || (t.type === "income" ? "Sales" : "Other"),
        ref_hash: t.ref_hash,
        payment_method: "bank_transfer",
      }));

    try {
      const res = await api.post("/bank-import/confirm", {
        bank: preview.bank,
        transactions: txns,
      });
      setResult(res.data);
      setStep("done");
    } catch (err) {
      setError(err.response?.data?.detail || "Import failed");
    }
    setLoading(false);
  };

  // ── Reconciliation ──
  // Fetch suggestions for the bank import we just confirmed (or the
  // latest). Gated server-side, but we also short-circuit on Free for
  // a snappier UX (the UpgradeNudge handles the gate visually).
  const loadSuggestions = async (importId = "latest") => {
    if (!canAutoReconcile) return;
    setLoading(true);
    setError("");
    try {
      const res = await api.get(
        `/bank-import/${encodeURIComponent(importId)}/suggestions`,
      );
      setSuggestions(res.data);
      // Default-chosen = top suggestion per txn (if any)
      const defaults = {};
      (res.data.transactions || []).forEach((t) => {
        if (t.suggestions && t.suggestions.length > 0) {
          defaults[t.txn_id] = t.suggestions[0];
        }
      });
      setChosen(defaults);
      setSkipped(new Set());
      setStep("reconcile");
    } catch (err) {
      const detail = err.response?.data?.detail;
      if (err.response?.status === 402) {
        // Defensive — should be caught by canAutoReconcile, but
        // if entitlements cache is stale, the server tells us the truth.
        setError("Auto-reconcile is a Starter+ feature.");
      } else {
        setError(detail?.message || detail || "Could not load suggestions");
      }
    }
    setLoading(false);
  };

  const toggleChosen = (txnId, suggestion) => {
    setChosen((prev) => ({ ...prev, [txnId]: suggestion }));
    // Choosing a candidate implicitly un-skips the row
    setSkipped((prev) => {
      if (!prev.has(txnId)) return prev;
      const next = new Set(prev);
      next.delete(txnId);
      return next;
    });
  };

  const toggleSkipped = (txnId) => {
    setSkipped((prev) => {
      const next = new Set(prev);
      next.has(txnId) ? next.delete(txnId) : next.add(txnId);
      return next;
    });
  };

  // Bulk-confirm all rows whose currently-chosen candidate is HIGH
  // confidence and not skipped. Most owners will accept this in one tap.
  const confirmAllHighConfidence = () => {
    if (!suggestions) return;
    const next = { ...chosen };
    let count = 0;
    suggestions.transactions.forEach((t) => {
      if (skipped.has(t.txn_id)) return;
      const top = t.suggestions?.[0];
      if (top && top.confidence === "high") {
        next[t.txn_id] = top;
        count += 1;
      }
    });
    setChosen(next);
    return count;
  };

  // Submit all currently-chosen (and not-skipped) suggestions.
  const confirmReconcile = async () => {
    if (!suggestions) return;
    const matches = [];
    suggestions.transactions.forEach((t) => {
      if (skipped.has(t.txn_id)) return;
      const c = chosen[t.txn_id];
      if (!c) return;
      matches.push({
        txn_id: t.txn_id,
        target_type: c.target_type,
        target_id: c.target_id,
        action: c.target_type === "invoice" ? "mark_paid" : "link",
      });
    });
    if (matches.length === 0) {
      setError("Nothing selected. Choose at least one match or skip the row.");
      return;
    }
    setLoading(true);
    setError("");
    try {
      const importId = suggestions.import_id || "latest";
      const res = await api.post(
        `/bank-import/${encodeURIComponent(importId)}/confirm-matches`,
        { matches },
      );
      setReconcileResult(res.data);
      const inv = matches.filter((m) => m.target_type === "invoice").length;
      const exp = matches.filter((m) => m.target_type === "expense").length;
      showToast(
        `${res.data.confirmed} confirmed (${inv} invoices marked paid, ${exp} expenses linked)`,
        res.data.errors?.length ? "warning" : "success",
        4000,
      );
      // Refresh suggestions — confirmed rows drop out of the list.
      await loadSuggestions(importId);
    } catch (err) {
      setError(err.response?.data?.detail?.message || err.response?.data?.detail || "Confirm failed");
    }
    setLoading(false);
  };

  // ── Toggle helpers ──
  const toggleAll = () => {
    if (selected.size === preview?.transactions?.length) {
      setSelected(new Set());
    } else {
      setSelected(new Set(preview.transactions.map((t) => t.ref_hash)));
    }
  };

  const toggleOne = (hash) => {
    const next = new Set(selected);
    next.has(hash) ? next.delete(hash) : next.add(hash);
    setSelected(next);
  };

  // ── All category names (user's + suggested) ──
  const allCategories = [...new Set([
    ...userCategories,
    ...Object.values(categories),
    "Other", "Sales", "Ingredients", "Rent", "Wages", "Utilities", "Supplies",
    "Transport", "Insurance", "Subscriptions", "Equipment", "Marketing",
  ])].sort();

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-[1200px] mx-auto">
      <FadeIn>
        <h1 className="text-2xl font-bold text-gray-800 dark:text-white">Bank Import</h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Upload your bank CSV to auto-import transactions into BonBox
        </p>
      </FadeIn>

      {error && (
        <div className="bg-red-50 dark:bg-red-900/30 text-red-600 dark:text-red-400 px-4 py-3 rounded-xl text-sm">
          {error}
        </div>
      )}

      {/* ═══════════════════════════════════════════
         AIIA DIRECT CONNECT (Task #67) — primary path
         ═══════════════════════════════════════════ */}
      {step === "upload" && (
        <FadeIn>
          <div className="bg-gradient-to-br from-emerald-50 to-blue-50 dark:from-emerald-900/20 dark:to-blue-900/20 rounded-2xl p-6 border border-emerald-200 dark:border-emerald-800 shadow-sm space-y-4 mb-6">
            <div className="flex items-start gap-3">
              <div className="text-3xl">🔗</div>
              <div className="flex-1">
                <h2 className="text-lg font-bold text-gray-800 dark:text-white mb-1">
                  Connect bank automatically
                </h2>
                <p className="text-sm text-gray-600 dark:text-gray-300">
                  One-time MitID login at your bank — no more CSV uploads. BonBox auto-pulls transactions nightly and matches them to your fakturaer.
                </p>
              </div>
              {!canAutoReconcile && (
                <span className="px-2 py-0.5 rounded text-[10px] font-medium uppercase tracking-wider bg-indigo-100 dark:bg-indigo-900/40 text-indigo-700 dark:text-indigo-300">
                  Starter+
                </span>
              )}
            </div>

            {canAutoReconcile ? (
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex-1 min-w-[180px]">
                  <label className="block text-xs text-gray-500 dark:text-gray-400 mb-1">Choose your bank</label>
                  <select
                    value={aiiaBank}
                    onChange={(e) => setAiiaBank(e.target.value)}
                    className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-800 text-sm text-gray-700 dark:text-gray-200"
                  >
                    {AIIA_BANKS.map((b) => (
                      <option key={b.slug} value={b.slug}>{b.label}</option>
                    ))}
                  </select>
                </div>
                <button
                  onClick={startAiiaConnect}
                  disabled={aiiaLoading}
                  className="px-5 py-2.5 bg-emerald-600 hover:bg-emerald-700 text-white text-sm font-semibold rounded-lg disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  {aiiaLoading ? "Opening bank…" : "Connect bank"}
                </button>
              </div>
            ) : (
              <UpgradeNudge
                feature="bank_auto_reconcile"
                title="Auto-connect your bank with Starter"
                description="Skip CSV upload — direct PSD2 connection to Danish banks. Nightly auto-sync + reconciliation."
              />
            )}

            <p className="text-xs text-gray-400 dark:text-gray-500 italic">
              Read-only access via Mastercard Open Banking (Aiia). Renews every 90 days under DK SCA rules.
            </p>
          </div>
        </FadeIn>
      )}

      {/* ═══════════════════════════════════════════
         STEP 1: UPLOAD (CSV fallback)
         ═══════════════════════════════════════════ */}
      {step === "upload" && (
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-2xl p-6 border border-gray-100 dark:border-gray-700 shadow-sm space-y-5">
            <div className="flex items-baseline justify-between">
              <h3 className="text-sm font-semibold text-gray-700 dark:text-gray-300">Or upload CSV manually</h3>
              <span className="text-xs text-gray-400">Free tier &amp; unsupported banks</span>
            </div>
            {/* Drop zone */}
            <div
              ref={dropRef}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onClick={() => fileRef.current?.click()}
              className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-xl p-10 text-center cursor-pointer hover:border-blue-400 dark:hover:border-blue-500 transition-colors"
            >
              <input
                ref={fileRef}
                type="file"
                accept=".csv"
                className="hidden"
                onChange={(e) => handleFile(e.target.files?.[0])}
              />
              <div className="text-4xl mb-3">📄</div>
              {file ? (
                <div>
                  <p className="text-base font-semibold text-gray-800 dark:text-white">{file.name}</p>
                  <p className="text-sm text-gray-400 mt-1">{(file.size / 1024).toFixed(0)} KB — Click to change</p>
                </div>
              ) : (
                <div>
                  <p className="text-base font-medium text-gray-600 dark:text-gray-300">
                    Drop your bank CSV here or click to browse
                  </p>
                  <p className="text-sm text-gray-400 mt-1">Supports Danske Bank, Nordea, Jyske Bank, Lunar, Revolut</p>
                </div>
              )}
            </div>

            {/* Bank override (optional) */}
            <div className="flex flex-wrap items-center gap-3">
              <label className="text-sm text-gray-500 dark:text-gray-400">Bank (auto-detect):</label>
              <select
                value={bankOverride}
                onChange={(e) => setBankOverride(e.target.value)}
                className="px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-700 dark:text-gray-200"
              >
                <option value="">Auto-detect</option>
                {Object.entries(BANK_LABELS).map(([id, { label }]) => (
                  <option key={id} value={id}>{label}</option>
                ))}
              </select>
            </div>

            <button
              onClick={uploadAndPreview}
              disabled={!file || loading}
              className="w-full sm:w-auto px-6 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {loading ? (
                <span className="flex items-center gap-2">
                  <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none" />
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                  </svg>
                  Parsing...
                </span>
              ) : "Upload & Preview"}
            </button>
          </div>

          {/* Supported banks */}
          <div className="mt-4">
            <p className="text-xs text-gray-400 dark:text-gray-500 mb-2 font-medium uppercase tracking-wider">Supported banks</p>
            <div className="flex flex-wrap gap-2">
              {Object.entries(BANK_LABELS).map(([id, { label, icon }]) => (
                <span key={id} className="px-3 py-1.5 bg-gray-100 dark:bg-gray-800 text-gray-600 dark:text-gray-400 rounded-lg text-xs font-medium">
                  {icon} {label}
                </span>
              ))}
            </div>
          </div>
        </FadeIn>
      )}

      {/* ═══════════════════════════════════════════
         STEP 2: PREVIEW
         ═══════════════════════════════════════════ */}
      {step === "preview" && preview && (
        <FadeIn>
          {/* Summary bar */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl p-5 border border-gray-100 dark:border-gray-700 shadow-sm">
            <div className="flex flex-wrap items-center gap-3 mb-4">
              <span className="text-lg">{BANK_LABELS[preview.bank]?.icon || "🏦"}</span>
              <span className="font-semibold text-gray-800 dark:text-white">{preview.bank_label}</span>
              <span className="text-sm text-gray-400">
                {preview.summary.date_from} — {preview.summary.date_to}
              </span>
            </div>
            <StaggerGrid className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <StaggerGridItem>
                <div className="bg-gray-50 dark:bg-gray-700/50 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-gray-800 dark:text-white">{preview.summary.total_rows}</p>
                  <p className="text-xs text-gray-400">Transactions</p>
                </div>
              </StaggerGridItem>
              <StaggerGridItem>
                <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-green-600 dark:text-green-400">+{preview.summary.income_total?.toLocaleString()}</p>
                  <p className="text-xs text-gray-400">{preview.summary.income_count} income</p>
                </div>
              </StaggerGridItem>
              <StaggerGridItem>
                <div className="bg-red-50 dark:bg-red-900/20 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-red-600 dark:text-red-400">{preview.summary.expense_total?.toLocaleString()}</p>
                  <p className="text-xs text-gray-400">{preview.summary.expense_count} expenses</p>
                </div>
              </StaggerGridItem>
              <StaggerGridItem>
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-xl p-3 text-center">
                  <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">{selected.size}</p>
                  <p className="text-xs text-gray-400">Selected</p>
                </div>
              </StaggerGridItem>
            </StaggerGrid>
          </div>

          {/* Transaction table */}
          <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 dark:bg-gray-700/50 text-gray-600 dark:text-gray-400">
                  <tr>
                    <th className="px-3 py-3 text-left w-10">
                      <input
                        type="checkbox"
                        checked={selected.size === preview.transactions.length}
                        onChange={toggleAll}
                        className="rounded border-gray-300 dark:border-gray-600"
                      />
                    </th>
                    <th className="px-3 py-3 text-left">Date</th>
                    <th className="px-3 py-3 text-left">Description</th>
                    <th className="px-3 py-3 text-right">Amount</th>
                    <th className="px-3 py-3 text-left">Type</th>
                    <th className="px-3 py-3 text-left">Category</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.transactions.map((txn) => {
                    const isSelected = selected.has(txn.ref_hash);
                    const isIncome = txn.type === "income";
                    return (
                      <tr
                        key={txn.ref_hash}
                        className={`border-b border-gray-50 dark:border-gray-700/50 transition-colors ${
                          isSelected ? "" : "opacity-40"
                        }`}
                      >
                        <td className="px-3 py-2.5">
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleOne(txn.ref_hash)}
                            className="rounded border-gray-300 dark:border-gray-600"
                          />
                        </td>
                        <td className="px-3 py-2.5 text-gray-600 dark:text-gray-400 whitespace-nowrap">{txn.date}</td>
                        <td className="px-3 py-2.5 text-gray-800 dark:text-gray-200 max-w-[250px] truncate" title={txn.description}>
                          {txn.description}
                        </td>
                        <td className={`px-3 py-2.5 text-right font-semibold whitespace-nowrap ${
                          isIncome ? "text-green-600 dark:text-green-400" : "text-red-600 dark:text-red-400"
                        }`}>
                          {isIncome ? "+" : ""}{txn.amount.toLocaleString()} {currency}
                        </td>
                        <td className="px-3 py-2.5">
                          <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${
                            isIncome
                              ? "bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400"
                              : "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400"
                          }`}>
                            {isIncome ? "Income" : "Expense"}
                          </span>
                        </td>
                        <td className="px-3 py-2.5">
                          <select
                            value={categories[txn.ref_hash] || "Other"}
                            onChange={(e) => setCategories((prev) => ({ ...prev, [txn.ref_hash]: e.target.value }))}
                            className="px-2 py-1 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-xs text-gray-700 dark:text-gray-300 max-w-[140px]"
                          >
                            {allCategories.map((c) => (
                              <option key={c} value={c}>{c}</option>
                            ))}
                          </select>
                          {txn.confidence > 0 && txn.confidence < 1 && (
                            <span className="ml-1 text-[10px] text-gray-400">{Math.round(txn.confidence * 100)}%</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* Actions */}
            <div className="px-4 py-4 bg-gray-50 dark:bg-gray-700/30 flex flex-wrap items-center justify-between gap-3">
              <button
                onClick={() => { setStep("upload"); setPreview(null); setFile(null); }}
                className="px-4 py-2 text-sm text-gray-600 dark:text-gray-400 hover:text-gray-800 dark:hover:text-white transition"
              >
                &larr; Back
              </button>
              <div className="flex items-center gap-3">
                <span className="text-sm text-gray-500 dark:text-gray-400">
                  {selected.size} of {preview.transactions.length} selected
                </span>
                <button
                  onClick={confirmImport}
                  disabled={selected.size === 0 || loading}
                  className="px-6 py-2.5 bg-green-600 text-white rounded-xl font-semibold hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {loading ? "Importing..." : `Import ${selected.size} transactions`}
                </button>
              </div>
            </div>
          </div>
        </FadeIn>
      )}

      {/* ═══════════════════════════════════════════
         STEP 3: DONE
         ═══════════════════════════════════════════ */}
      {step === "done" && result && (
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-2xl p-8 border border-gray-100 dark:border-gray-700 shadow-sm text-center space-y-4">
            <div className="text-5xl">✅</div>
            <h2 className="text-xl font-bold text-gray-800 dark:text-white">
              Imported {result.imported} transactions
            </h2>
            {result.skipped > 0 && (
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {result.skipped} duplicates skipped
              </p>
            )}
            {result.errors.length > 0 && (
              <p className="text-sm text-red-500">{result.errors.length} errors</p>
            )}

            {/* Starter killer feature: match against open invoices.
                Free users see the UpgradeNudge inline. Paid users get
                an accent button that loads ranked match candidates. */}
            <div className="pt-2">
              {canAutoReconcile ? (
                <Button
                  variant="accent"
                  size="lg"
                  onClick={() => loadSuggestions(preview?.bank || "latest")}
                  busy={loading}
                  iconLeft={<Icon name="Wallet" size={16} className="text-white" />}
                >
                  Match against open invoices
                </Button>
              ) : (
                <div className="flex justify-center">
                  <UpgradeNudge
                    intent="card"
                    tier="starter"
                    benefit="Auto-match bank lines to open fakturaer + expenses, then bulk-confirm in one tap."
                    icon={<Icon name="Wallet" size={20} />}
                    ctaLabel="See Starter"
                  />
                </div>
              )}
            </div>

            <div className="flex flex-wrap justify-center gap-3 pt-4">
              <a href="/expenses" className="px-5 py-2.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition">
                View Expenses
              </a>
              <a href="/sales" className="px-5 py-2.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition">
                View Sales
              </a>
              <a href="/cashbook" className="px-5 py-2.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl text-sm font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition">
                View Cashbook
              </a>
              <button
                onClick={() => { setStep("upload"); setPreview(null); setFile(null); setResult(null); }}
                className="px-5 py-2.5 bg-blue-600 text-white rounded-xl text-sm font-semibold hover:bg-blue-700 transition"
              >
                Import Another
              </button>
            </div>
          </div>
        </FadeIn>
      )}

      {/* ═══════════════════════════════════════════
         STEP 4: RECONCILE
         Mobile-first table — owner reviewing matches on phone at 22:00.
         ═══════════════════════════════════════════ */}
      {step === "reconcile" && suggestions && (
        <FadeIn>
          <Card variant="default" className="space-y-4">
            <Card.Header
              icon={<Icon name="Wallet" size={18} />}
              title="Reconcile bank lines"
              subtitle={`${suggestions.transactions.length} transactions · ${suggestions.counts.high} high · ${suggestions.counts.medium} medium · ${suggestions.counts.low} low · ${suggestions.counts.none} unmatched`}
              action={
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => { setStep("done"); setSuggestions(null); }}
                >
                  Back
                </Button>
              }
            />

            {/* Bulk action: confirm all high-confidence in one tap */}
            <div className="flex flex-wrap items-center justify-between gap-2 px-1">
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  const n = confirmAllHighConfidence();
                  showToast(`${n || 0} high-confidence matches selected`, "info", 2000);
                }}
                iconLeft={<Icon name="Sparkles" size={14} className="text-white dark:text-stone-900" />}
              >
                Select all high-confidence
              </Button>
              <Button
                variant="accent"
                size="md"
                onClick={confirmReconcile}
                busy={loading}
                iconLeft={<Icon name="Send" size={14} className="text-white" />}
              >
                Confirm {Object.keys(chosen).filter((id) => !skipped.has(id) && chosen[id]).length} matches
              </Button>
            </div>

            {/* Mobile-friendly table — collapses to a card list under sm: */}
            <div className="space-y-2">
              {suggestions.transactions.length === 0 && (
                <div className="text-center text-sm text-stone-500 dark:text-stone-400 py-10">
                  Nothing to reconcile — all bank lines are already matched or no candidates were found.
                </div>
              )}
              {suggestions.transactions.map((t) => {
                const c = chosen[t.txn_id];
                const isSkipped = skipped.has(t.txn_id);
                const isIncome = t.txn_type === "income";
                return (
                  <div
                    key={t.txn_id}
                    className={
                      "rounded-lg border p-3 sm:p-4 transition-colors " +
                      (isSkipped
                        ? "border-stone-200 dark:border-stone-800 bg-stone-50/60 dark:bg-stone-900/40 opacity-60"
                        : c
                        ? "border-emerald-200 dark:border-emerald-800/60 bg-emerald-50/40 dark:bg-emerald-900/10"
                        : "border-stone-200 dark:border-stone-800 bg-white dark:bg-stone-900")
                    }
                  >
                    {/* Row header */}
                    <div className="flex items-start justify-between gap-3 mb-2">
                      <div className="min-w-0">
                        <div className="flex items-center gap-2 text-xs text-stone-500 dark:text-stone-400">
                          <span>{t.date}</span>
                          <span className={
                            "px-1.5 py-0.5 rounded text-[10px] font-medium " +
                            (isIncome
                              ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300"
                              : "bg-red-100 dark:bg-red-900/30 text-red-700 dark:text-red-400")
                          }>
                            {isIncome ? "income" : "expense"}
                          </span>
                        </div>
                        <p className="text-sm text-stone-800 dark:text-stone-100 mt-1 truncate" title={t.description}>
                          {t.description || <span className="text-stone-400">No description</span>}
                        </p>
                      </div>
                      <div className={
                        "text-right font-semibold whitespace-nowrap shrink-0 " +
                        (isIncome ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400")
                      }>
                        {isIncome ? "+" : ""}{Number(t.amount).toLocaleString()} {currency}
                      </div>
                    </div>

                    {/* Suggestions + action */}
                    {t.suggestions.length === 0 ? (
                      <div className="text-xs text-stone-500 dark:text-stone-400 italic">
                        No matching invoice/expense found within ±2 DKK / ±7 days.
                      </div>
                    ) : (
                      <div className="flex flex-wrap items-center gap-2">
                        <select
                          value={c?.target_id || ""}
                          onChange={(e) => {
                            const sel = t.suggestions.find((s) => s.target_id === e.target.value);
                            if (sel) toggleChosen(t.txn_id, sel);
                          }}
                          disabled={isSkipped}
                          className="flex-1 min-w-0 px-2.5 py-1.5 text-xs sm:text-sm rounded-md border border-stone-200 dark:border-stone-700 bg-white dark:bg-stone-900 text-stone-800 dark:text-stone-200 disabled:opacity-50"
                        >
                          {t.suggestions.map((s) => (
                            <option key={s.target_id} value={s.target_id}>
                              {s.target_label} · {s.confidence}
                            </option>
                          ))}
                        </select>
                        {c && (
                          <span
                            className={
                              "text-[10px] font-medium px-2 py-1 rounded-full uppercase tracking-wide " +
                              (c.confidence === "high"
                                ? "bg-emerald-100 dark:bg-emerald-900/40 text-emerald-800 dark:text-emerald-300"
                                : c.confidence === "medium"
                                ? "bg-amber-100 dark:bg-amber-900/40 text-amber-800 dark:text-amber-300"
                                : "bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-300")
                            }
                            title={c.reason}
                          >
                            {c.confidence}
                          </span>
                        )}
                        <Button
                          variant={isSkipped ? "secondary" : "ghost"}
                          size="sm"
                          onClick={() => toggleSkipped(t.txn_id)}
                        >
                          {isSkipped ? "Undo skip" : "Skip"}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>

            {reconcileResult && reconcileResult.errors?.length > 0 && (
              <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/60 rounded-lg px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
                <strong>{reconcileResult.errors.length}</strong> issues:
                <ul className="list-disc list-inside mt-1">
                  {reconcileResult.errors.slice(0, 5).map((e, i) => (
                    <li key={i}>{e}</li>
                  ))}
                </ul>
              </div>
            )}
          </Card>
        </FadeIn>
      )}

      <ToastContainer />
    </div>
  );
}
