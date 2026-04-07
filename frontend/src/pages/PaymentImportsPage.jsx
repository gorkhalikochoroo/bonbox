import { useState, useEffect } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";

const PROVIDER_LOGOS = {
  vipps_mobilepay: "📱",
  esewa: "💚",
  khalti: "💜",
};

const COUNTRY_LABELS = {
  DK: "Denmark", NO: "Norway", NP: "Nepal", IN: "India", GB: "UK", SE: "Sweden",
};

/* ─── Setup Wizard ───────────────────────────────────────── */
function SetupWizard({ provider, onDone, onCancel, t }) {
  const [step, setStep] = useState(0); // 0 = intro, 1 = fields, 2 = testing
  const [creds, setCreds] = useState({});
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const totalSteps = (provider.setup_steps || []).length;
  const allFieldsFilled = provider.fields.every(
    (f) => (creds[f.key] || "").trim().length > 0
  );

  const handleSave = async () => {
    setSaving(true);
    setError("");
    setStep(2);
    try {
      const res = await api.post("/payment-import/connect", {
        provider: provider.id,
        label: label || provider.name,
        credentials: creds,
      });
      onDone(res.data);
    } catch (err) {
      setError(err.response?.data?.detail || "Connection failed. Double-check your keys and try again.");
      setStep(1);
    }
    setSaving(false);
  };

  // Step 0: Introduction — what you'll need
  if (step === 0) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
        {/* Header */}
        <div className="bg-gradient-to-r from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 px-6 py-5 border-b border-gray-100 dark:border-gray-700">
          <div className="flex items-center gap-3">
            <span className="text-3xl">{provider.logo_emoji}</span>
            <div>
              <h3 className="text-lg font-bold text-gray-900 dark:text-white">
                {t("connect") || "Connect"} {provider.name}
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400">
                {provider.setup_time && `Takes about ${provider.setup_time}`}
              </p>
            </div>
          </div>
        </div>

        <div className="p-6 space-y-5">
          {/* What you'll need */}
          <div>
            <h4 className="text-sm font-semibold text-gray-700 dark:text-gray-300 mb-3">
              Here's what you'll do:
            </h4>
            <div className="space-y-2.5">
              {(provider.setup_steps || []).map((step, i) => (
                <div key={i} className="flex gap-3">
                  <div className="shrink-0 w-6 h-6 rounded-full bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 flex items-center justify-center text-xs font-bold">
                    {i + 1}
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-300 pt-0.5">{step}</p>
                </div>
              ))}
            </div>
          </div>

          {/* Portal link */}
          {provider.portal_url && (
            <a
              href={provider.portal_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-3 px-4 py-3 bg-gray-50 dark:bg-gray-700/50 rounded-xl hover:bg-gray-100 dark:hover:bg-gray-700 transition group"
            >
              <div className="w-8 h-8 rounded-lg bg-blue-100 dark:bg-blue-900/40 text-blue-600 dark:text-blue-400 flex items-center justify-center shrink-0">
                <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                </svg>
              </div>
              <div className="flex-1">
                <p className="text-sm font-medium text-gray-800 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition">
                  Open {provider.portal_name || provider.name}
                </p>
                <p className="text-xs text-gray-400">{provider.portal_url.replace("https://", "")}</p>
              </div>
              <svg className="w-4 h-4 text-gray-300 dark:text-gray-500 group-hover:text-blue-500 transition" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
              </svg>
            </a>
          )}

          <p className="text-xs text-gray-400 dark:text-gray-500">
            Your keys are stored securely and only used to fetch your transactions.
            BonBox never stores your customers' payment details.
          </p>

          {/* Actions */}
          <div className="flex gap-3 pt-1">
            <button
              onClick={() => setStep(1)}
              className="flex-1 py-3 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 transition text-sm"
            >
              I have my keys — let's go
            </button>
            <button
              onClick={onCancel}
              className="px-5 py-3 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 transition text-sm font-medium"
            >
              {t("cancel") || "Cancel"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Step 2: Testing connection
  if (step === 2) {
    return (
      <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 p-8 text-center">
        <div className="w-12 h-12 mx-auto mb-4 rounded-full bg-blue-50 dark:bg-blue-900/30 flex items-center justify-center">
          <svg className="w-6 h-6 text-blue-600 dark:text-blue-400 animate-spin" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        </div>
        <p className="text-sm font-medium text-gray-700 dark:text-gray-300">
          Connecting to {provider.name}...
        </p>
        <p className="text-xs text-gray-400 mt-1">Verifying your keys</p>
      </div>
    );
  }

  // Step 1: Enter credentials
  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-200 dark:border-gray-700 overflow-hidden">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-100 dark:border-gray-700 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={() => setStep(0)}
            className="w-8 h-8 rounded-lg hover:bg-gray-100 dark:hover:bg-gray-700 flex items-center justify-center text-gray-400 transition"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
            </svg>
          </button>
          <div>
            <h3 className="text-sm font-bold text-gray-900 dark:text-white">
              {provider.logo_emoji} Enter your {provider.name} keys
            </h3>
            <p className="text-xs text-gray-400">Paste them from the {provider.portal_name || "portal"}</p>
          </div>
        </div>
        {provider.portal_url && (
          <a
            href={provider.portal_url}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs text-blue-500 hover:text-blue-600 font-medium flex items-center gap-1"
          >
            Open portal
            <svg className="w-3 h-3" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
            </svg>
          </a>
        )}
      </div>

      <div className="p-6 space-y-4">
        {/* Optional label */}
        <div>
          <label className="text-xs font-medium text-gray-500 dark:text-gray-400 mb-1.5 block">
            Name this connection (optional)
          </label>
          <input
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder={`e.g. "My café" or "Main store"`}
            className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200 focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700 outline-none transition"
          />
        </div>

        {/* Credential fields */}
        {provider.fields.map((field, idx) => (
          <div key={field.key}>
            <label className="text-xs font-medium text-gray-700 dark:text-gray-300 mb-1.5 flex items-center gap-1.5">
              <span className="w-5 h-5 rounded-md bg-blue-50 dark:bg-blue-900/30 text-blue-600 dark:text-blue-400 flex items-center justify-center text-[10px] font-bold shrink-0">
                {idx + 1}
              </span>
              {field.label}
            </label>
            <input
              type={field.type}
              value={creds[field.key] || ""}
              onChange={(e) => setCreds({ ...creds, [field.key]: e.target.value })}
              placeholder={field.placeholder}
              className="w-full px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200 font-mono focus:ring-2 focus:ring-blue-300 dark:focus:ring-blue-700 outline-none transition"
            />
            {field.help && (
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-1 ml-0.5">
                {field.help}
              </p>
            )}
          </div>
        ))}

        {/* Error */}
        {error && (
          <div className="flex items-start gap-2 px-4 py-3 bg-red-50 dark:bg-red-900/20 rounded-xl">
            <svg className="w-4 h-4 text-red-500 shrink-0 mt-0.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <div>
              <p className="text-sm text-red-600 dark:text-red-400 font-medium">{error}</p>
              <p className="text-xs text-red-400 dark:text-red-500 mt-0.5">
                Make sure you copied the full value with no extra spaces.
              </p>
            </div>
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-3 pt-2">
          <button
            onClick={handleSave}
            disabled={!allFieldsFilled || saving}
            className="flex-1 py-3 bg-green-600 text-white rounded-xl font-semibold hover:bg-green-700 disabled:opacity-40 disabled:cursor-not-allowed transition text-sm flex items-center justify-center gap-2"
          >
            <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            Test & Connect
          </button>
          <button
            onClick={onCancel}
            className="px-5 py-3 text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 font-medium text-sm transition"
          >
            {t("cancel") || "Cancel"}
          </button>
        </div>
      </div>
    </div>
  );
}


/* ─── Connected Provider Card ────────────────────────────── */
function ConnectedCard({ conn, provider, onDisconnect, onSync, onToggleAutoSync, syncing, syncResult, onConfirmImport, confirming, importResult, t }) {
  const [dateFrom, setDateFrom] = useState("");
  const [dateTo, setDateTo] = useState("");
  const [selected, setSelected] = useState(new Set());
  const [showManual, setShowManual] = useState(false);
  const fmt = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });

  const isSyncing = syncing === conn.id;

  const handleSync = () => {
    setSelected(new Set());
    onSync(conn, dateFrom, dateTo, (txns) => {
      setSelected(new Set(txns.map((_, i) => i)));
    });
  };

  const toggleSelect = (i) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  return (
    <div className="bg-white dark:bg-gray-800 rounded-2xl border border-gray-100 dark:border-gray-700 overflow-hidden">
      {/* Header */}
      <div className="px-5 py-4 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-green-50 dark:bg-green-900/20 flex items-center justify-center text-xl">
            {PROVIDER_LOGOS[conn.provider] || "💳"}
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-800 dark:text-white">{conn.label}</p>
            <p className="text-xs text-gray-400 flex items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full inline-block ${conn.auto_sync ? "bg-green-400" : "bg-gray-300"}`} />
              {provider?.name || conn.provider}
              {conn.last_synced_at && (
                <span className="ml-1">
                  &middot; Synced {new Date(conn.last_synced_at).toLocaleDateString()}
                </span>
              )}
            </p>
          </div>
        </div>
        <button
          onClick={() => onDisconnect(conn.id)}
          className="text-xs text-gray-400 hover:text-red-500 transition font-medium"
        >
          {t("disconnect") || "Disconnect"}
        </button>
      </div>

      {/* Auto-sync status */}
      <div className="px-5 pb-3">
        <div className="flex items-center justify-between py-2.5 px-4 rounded-xl bg-gray-50 dark:bg-gray-700/40">
          <div className="flex items-center gap-2.5">
            <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${conn.auto_sync ? "bg-green-100 dark:bg-green-900/30" : "bg-gray-200 dark:bg-gray-600"}`}>
              {conn.auto_sync ? (
                <svg className="w-3.5 h-3.5 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                </svg>
              ) : (
                <svg className="w-3.5 h-3.5 text-gray-400" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
                </svg>
              )}
            </div>
            <div>
              <p className="text-xs font-medium text-gray-700 dark:text-gray-300">
                {conn.auto_sync ? "Auto-importing new transactions" : "Auto-import paused"}
              </p>
              <p className="text-[11px] text-gray-400">
                {conn.auto_sync
                  ? conn.last_auto_imported > 0
                    ? `${conn.last_auto_imported} new last sync`
                    : "Checks every 6 hours"
                  : "Turn on to import automatically"}
              </p>
            </div>
          </div>
          <button
            onClick={() => onToggleAutoSync(conn.id, !conn.auto_sync)}
            className={`relative w-10 h-5.5 rounded-full transition-colors ${conn.auto_sync ? "bg-green-500" : "bg-gray-300 dark:bg-gray-600"}`}
            style={{ minWidth: "40px", height: "22px" }}
          >
            <span
              className={`absolute top-[2px] w-[18px] h-[18px] rounded-full bg-white shadow-sm transition-transform ${conn.auto_sync ? "left-[20px]" : "left-[2px]"}`}
            />
          </button>
        </div>
      </div>

      {/* Manual sync (collapsible) */}
      <div className="px-5 pb-4">
        <button
          onClick={() => setShowManual(!showManual)}
          className="text-xs text-blue-500 hover:text-blue-600 font-medium flex items-center gap-1 mb-2"
        >
          <svg className={`w-3 h-3 transition-transform ${showManual ? "rotate-90" : ""}`} fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
          </svg>
          Manual fetch for specific dates
        </button>
        {showManual && (
          <div className="flex flex-wrap items-end gap-2.5">
          <div className="flex-1 min-w-[120px]">
            <label className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">From</label>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="block w-full mt-0.5 px-2.5 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
            />
          </div>
          <div className="flex-1 min-w-[120px]">
            <label className="text-[10px] text-gray-400 uppercase tracking-wider font-medium">To</label>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="block w-full mt-0.5 px-2.5 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
            />
          </div>
          <button
            onClick={handleSync}
            disabled={isSyncing}
            className="px-5 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition whitespace-nowrap"
          >
            {isSyncing ? (
              <span className="flex items-center gap-2">
                <svg className="w-3.5 h-3.5 animate-spin" fill="none" viewBox="0 0 24 24"><circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" /><path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" /></svg>
                Fetching...
              </span>
            ) : (t("syncNow") || "Fetch Transactions")}
          </button>
        </div>
        )}
      </div>

      {/* Sync result — transaction list */}
      {syncResult && !syncResult.error && !importResult && (
        <div className="border-t border-gray-100 dark:border-gray-700">
          <div className="px-5 py-3 flex items-center justify-between bg-gray-50/50 dark:bg-gray-700/30">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              <span className="font-semibold">{syncResult.total_count}</span> {t("transactionsFound") || "transactions found"}
              {syncResult.date_from && (
                <span className="text-xs text-gray-400 ml-2">
                  {syncResult.date_from} — {syncResult.date_to}
                </span>
              )}
            </p>
            <label className="text-xs text-blue-500 cursor-pointer flex items-center gap-1">
              <input
                type="checkbox"
                checked={selected.size === syncResult.transactions.length}
                onChange={() => {
                  if (selected.size === syncResult.transactions.length) {
                    setSelected(new Set());
                  } else {
                    setSelected(new Set(syncResult.transactions.map((_, i) => i)));
                  }
                }}
              />
              {t("selectAll") || "Select all"}
            </label>
          </div>

          <div className="max-h-72 overflow-y-auto">
            {syncResult.transactions.map((txn, i) => (
              <div
                key={i}
                onClick={() => toggleSelect(i)}
                className={`flex items-center gap-3 px-5 py-2.5 border-b border-gray-50 dark:border-gray-700/50 cursor-pointer transition ${
                  selected.has(i) ? "bg-blue-50/50 dark:bg-blue-900/10" : "hover:bg-gray-50 dark:hover:bg-gray-700/30"
                }`}
              >
                <input type="checkbox" checked={selected.has(i)} readOnly className="shrink-0 rounded" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm text-gray-800 dark:text-gray-200 truncate">{txn.description}</p>
                  <p className="text-xs text-gray-400">{txn.date}{txn.suggested_category && ` · ${txn.suggested_category}`}</p>
                </div>
                <span className={`text-sm font-semibold shrink-0 ${
                  txn.type === "income" ? "text-green-600 dark:text-green-400" : "text-red-500"
                }`}>
                  {txn.type === "income" ? "+" : "-"}{fmt(Math.abs(txn.amount))}
                </span>
              </div>
            ))}
          </div>

          <div className="px-5 py-3 bg-gray-50/50 dark:bg-gray-700/30">
            <button
              onClick={() => onConfirmImport(conn, syncResult.transactions.filter((_, i) => selected.has(i)))}
              disabled={confirming || selected.size === 0}
              className="w-full py-2.5 bg-green-600 text-white rounded-xl font-semibold hover:bg-green-700 disabled:opacity-40 transition text-sm"
            >
              {confirming
                ? (t("importing") || "Importing...")
                : `${t("importSelected") || "Import"} ${selected.size} ${t("transactions") || "transactions"}`}
            </button>
          </div>
        </div>
      )}

      {/* Error */}
      {syncResult?.error && (
        <div className="px-5 pb-4">
          <p className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 px-4 py-2.5 rounded-xl">{syncResult.error}</p>
        </div>
      )}

      {/* Import success */}
      {importResult && (
        <div className="px-5 pb-4">
          <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-4 text-center">
            <div className="text-2xl mb-1">🎉</div>
            <p className="text-green-700 dark:text-green-400 font-semibold text-sm">
              {importResult.imported} {t("imported") || "imported"}
              {importResult.skipped > 0 && (
                <span className="text-gray-500 font-normal ml-1">({importResult.skipped} duplicates skipped)</span>
              )}
            </p>
            <p className="text-xs text-green-600/60 dark:text-green-400/60 mt-1">Added to your cash book</p>
          </div>
        </div>
      )}
    </div>
  );
}


/* ─── Main Page ──────────────────────────────────────────── */
export default function PaymentImportsPage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const [providers, setProviders] = useState([]);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);

  // Wizard
  const [connectingProvider, setConnectingProvider] = useState(null);

  // Sync state per connection
  const [syncing, setSyncing] = useState(null);
  const [syncResults, setSyncResults] = useState({});
  const [importResults, setImportResults] = useState({});
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    Promise.all([
      api.get("/payment-import/providers"),
      api.get("/payment-import/connections"),
    ]).then(([pRes, cRes]) => {
      setProviders(pRes.data);
      setConnections(cRes.data);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const handleConnected = (newConn) => {
    setConnections((prev) => {
      const filtered = prev.filter((c) => c.id !== newConn.id);
      return [newConn, ...filtered];
    });
    setConnectingProvider(null);
  };

  const handleDisconnect = async (connId) => {
    if (!confirm(t("confirmDisconnect") || "Remove this connection?")) return;
    try {
      await api.delete(`/payment-import/connections/${connId}`);
      setConnections((prev) => prev.filter((c) => c.id !== connId));
    } catch { /* ignore */ }
  };

  const handleSync = async (conn, dateFrom, dateTo, onSelected) => {
    setSyncing(conn.id);
    setSyncResults((prev) => ({ ...prev, [conn.id]: null }));
    setImportResults((prev) => ({ ...prev, [conn.id]: null }));
    try {
      const params = {};
      if (dateFrom) params.date_from = dateFrom;
      if (dateTo) params.date_to = dateTo;
      const res = await api.post(`/payment-import/sync/${conn.id}`, null, { params });
      setSyncResults((prev) => ({ ...prev, [conn.id]: res.data }));
      onSelected(res.data.transactions);
    } catch (err) {
      setSyncResults((prev) => ({ ...prev, [conn.id]: { error: err.response?.data?.detail || "Sync failed" } }));
    }
    setSyncing(null);
  };

  const handleConfirmImport = async (conn, txns) => {
    setConfirming(true);
    try {
      const res = await api.post("/payment-import/confirm", {
        connection_id: conn.id,
        transactions: txns,
      });
      setImportResults((prev) => ({ ...prev, [conn.id]: res.data }));
      setSyncResults((prev) => ({ ...prev, [conn.id]: null }));
    } catch { /* ignore */ }
    setConfirming(false);
  };

  const handleToggleAutoSync = async (connId, enabled) => {
    try {
      await api.patch(`/payment-import/connections/${connId}/auto-sync?enabled=${enabled}`);
      setConnections((prev) =>
        prev.map((c) => (c.id === connId ? { ...c, auto_sync: enabled } : c))
      );
    } catch { /* ignore */ }
  };

  if (loading) {
    return (
      <div className="p-6 flex justify-center">
        <div className="w-8 h-8 border-3 border-blue-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Group providers by country
  const providersByCountry = {};
  for (const p of providers) {
    for (const c of p.countries) {
      if (!providersByCountry[c]) providersByCountry[c] = [];
      providersByCountry[c].push(p);
    }
  }

  return (
    <div className="p-4 sm:p-6 max-w-2xl mx-auto space-y-6">
      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {t("paymentImports") || "Payment Imports"}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Automatically fetch your sales from MobilePay, eSewa, and Khalti
        </p>
      </div>

      {/* Setup Wizard (if connecting) */}
      {connectingProvider && (
        <SetupWizard
          provider={connectingProvider}
          onDone={handleConnected}
          onCancel={() => setConnectingProvider(null)}
          t={t}
        />
      )}

      {/* Connected providers */}
      {connections.length > 0 && !connectingProvider && (
        <div className="space-y-3">
          <h2 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            Your connections
          </h2>
          {connections.map((conn) => (
            <ConnectedCard
              key={conn.id}
              conn={conn}
              provider={providers.find((p) => p.id === conn.provider)}
              onDisconnect={handleDisconnect}
              onSync={handleSync}
              onToggleAutoSync={handleToggleAutoSync}
              syncing={syncing}
              syncResult={syncResults[conn.id]}
              onConfirmImport={handleConfirmImport}
              confirming={confirming}
              importResult={importResults[conn.id]}
              t={t}
            />
          ))}
        </div>
      )}

      {/* Available providers */}
      {!connectingProvider && (
        <div className="space-y-4">
          <h2 className="text-xs font-semibold text-gray-400 dark:text-gray-500 uppercase tracking-wider">
            {connections.length > 0 ? "Add another provider" : "Connect a payment provider"}
          </h2>

          {Object.entries(providersByCountry).map(([countryCode, countryProviders]) => (
            <div key={countryCode}>
              <p className="text-[11px] text-gray-400 dark:text-gray-500 mb-2 font-medium uppercase tracking-wider">
                {COUNTRY_LABELS[countryCode] || countryCode}
              </p>
              <div className="space-y-2.5">
                {countryProviders.map((p) => {
                  const isConnected = connections.some((c) => c.provider === p.id);
                  return (
                    <div
                      key={`${countryCode}-${p.id}`}
                      className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-4 flex items-center gap-4"
                    >
                      <div className="w-11 h-11 rounded-xl bg-gray-50 dark:bg-gray-700 flex items-center justify-center text-2xl shrink-0">
                        {p.logo_emoji}
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold text-gray-800 dark:text-white">{p.name}</p>
                        <p className="text-xs text-gray-400 truncate">{p.description}</p>
                      </div>
                      {isConnected ? (
                        <span className="text-xs font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30 px-3 py-1.5 rounded-full flex items-center gap-1 shrink-0">
                          <span className="w-1.5 h-1.5 rounded-full bg-green-500 inline-block" />
                          {t("connected") || "Connected"}
                        </span>
                      ) : (
                        <button
                          onClick={() => setConnectingProvider(p)}
                          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition shrink-0 flex items-center gap-1.5"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M13 10V3L4 14h7v7l9-11h-7z" />
                          </svg>
                          {t("connect") || "Connect"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* UPI note for India */}
          <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200/60 dark:border-amber-800/50 rounded-xl p-4">
            <p className="text-sm text-amber-800 dark:text-amber-300 font-medium">
              {t("upiNote") || "UPI, Google Pay, PhonePe (India)"}
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              {t("upiNoteDesc") || "UPI transactions appear in your bank statement. Use Bank CSV Import to import them."}
            </p>
          </div>

          {/* Help CTA */}
          <div className="text-center py-3">
            <p className="text-xs text-gray-400 dark:text-gray-500">
              Need help connecting? <a href="/contact" className="text-blue-500 hover:underline">Contact us</a> and we'll walk you through it.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
