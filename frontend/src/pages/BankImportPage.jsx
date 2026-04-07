import { useState, useEffect, useRef, useCallback } from "react";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { displayCurrency } from "../utils/currency";
import { FadeIn, StaggerGrid, StaggerGridItem } from "../components/AnimationKit";

const BANK_LABELS = {
  danske_bank: { label: "Danske Bank", icon: "🏦" },
  nordea: { label: "Nordea", icon: "🏦" },
  jyske_bank: { label: "Jyske Bank", icon: "🏦" },
  lunar: { label: "Lunar", icon: "🌙" },
  revolut: { label: "Revolut", icon: "💳" },
};

export default function BankImportPage() {
  const { user } = useAuth();
  const currency = displayCurrency(user?.currency);
  const { t } = useLanguage();

  // States: upload → preview → done
  const [step, setStep] = useState("upload"); // upload | preview | done
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
         STEP 1: UPLOAD
         ═══════════════════════════════════════════ */}
      {step === "upload" && (
        <FadeIn>
          <div className="bg-white dark:bg-gray-800 rounded-2xl p-6 border border-gray-100 dark:border-gray-700 shadow-sm space-y-5">
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
    </div>
  );
}
