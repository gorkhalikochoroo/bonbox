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

export default function PaymentImportsPage() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const [providers, setProviders] = useState([]);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);

  // Connect flow
  const [connectingProvider, setConnectingProvider] = useState(null);
  const [creds, setCreds] = useState({});
  const [connectLabel, setConnectLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const [connectError, setConnectError] = useState("");

  // Sync flow
  const [syncing, setSyncing] = useState(null);
  const [syncResult, setSyncResult] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [confirming, setConfirming] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [syncDateFrom, setSyncDateFrom] = useState("");
  const [syncDateTo, setSyncDateTo] = useState("");

  useEffect(() => {
    Promise.all([
      api.get("/payment-import/providers"),
      api.get("/payment-import/connections"),
    ]).then(([pRes, cRes]) => {
      setProviders(pRes.data);
      setConnections(cRes.data);
    }).catch(() => {}).finally(() => setLoading(false));
  }, []);

  const handleConnect = async () => {
    setSaving(true);
    setConnectError("");
    try {
      const res = await api.post("/payment-import/connect", {
        provider: connectingProvider.id,
        label: connectLabel || connectingProvider.name,
        credentials: creds,
      });
      setConnections((prev) => {
        const filtered = prev.filter((c) => c.id !== res.data.id);
        return [res.data, ...filtered];
      });
      setConnectingProvider(null);
      setCreds({});
      setConnectLabel("");
    } catch (err) {
      setConnectError(err.response?.data?.detail || "Connection failed");
    }
    setSaving(false);
  };

  const handleDisconnect = async (connId) => {
    try {
      await api.delete(`/payment-import/connections/${connId}`);
      setConnections((prev) => prev.filter((c) => c.id !== connId));
    } catch { /* ignore */ }
  };

  const handleSync = async (conn) => {
    setSyncing(conn.id);
    setSyncResult(null);
    setImportResult(null);
    setSelected(new Set());
    try {
      const params = {};
      if (syncDateFrom) params.date_from = syncDateFrom;
      if (syncDateTo) params.date_to = syncDateTo;
      const res = await api.post(`/payment-import/sync/${conn.id}`, null, { params });
      setSyncResult(res.data);
      // Auto-select all
      setSelected(new Set(res.data.transactions.map((_, i) => i)));
    } catch (err) {
      setSyncResult({ error: err.response?.data?.detail || "Sync failed" });
    }
    setSyncing(null);
  };

  const handleConfirmImport = async (conn) => {
    setConfirming(true);
    const txns = syncResult.transactions.filter((_, i) => selected.has(i));
    try {
      const res = await api.post("/payment-import/confirm", {
        connection_id: conn.id,
        transactions: txns,
      });
      setImportResult(res.data);
      setSyncResult(null);
    } catch { /* ignore */ }
    setConfirming(false);
  };

  const toggleSelect = (i) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  const fmt = (v) => Number(v).toLocaleString(undefined, { maximumFractionDigits: 2 });

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
    <div className="p-4 sm:p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white">
          {t("paymentImports") || "Payment Imports"}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          {t("paymentImportsDesc") || "Connect payment providers to auto-import transactions"}
        </p>
      </div>

      {/* Connected providers */}
      {connections.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
            {t("connectedProviders") || "Connected"}
          </h2>
          {connections.map((conn) => {
            const provider = providers.find((p) => p.id === conn.provider);
            const isSyncing = syncing === conn.id;

            return (
              <div key={conn.id} className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-5 space-y-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <span className="text-2xl">{PROVIDER_LOGOS[conn.provider] || "💳"}</span>
                    <div>
                      <p className="text-sm font-semibold text-gray-800 dark:text-white">{conn.label}</p>
                      <p className="text-xs text-gray-400">
                        {provider?.name || conn.provider}
                        {conn.last_synced_at && (
                          <span className="ml-2">
                            Last synced: {new Date(conn.last_synced_at).toLocaleDateString()}
                          </span>
                        )}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => handleDisconnect(conn.id)}
                      className="text-xs text-red-500 hover:underline"
                    >
                      {t("disconnect") || "Disconnect"}
                    </button>
                  </div>
                </div>

                {/* Sync controls */}
                <div className="flex flex-wrap items-end gap-3">
                  <div>
                    <label className="text-[10px] text-gray-400 uppercase">From</label>
                    <input
                      type="date"
                      value={syncDateFrom}
                      onChange={(e) => setSyncDateFrom(e.target.value)}
                      className="block mt-0.5 px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
                    />
                  </div>
                  <div>
                    <label className="text-[10px] text-gray-400 uppercase">To</label>
                    <input
                      type="date"
                      value={syncDateTo}
                      onChange={(e) => setSyncDateTo(e.target.value)}
                      className="block mt-0.5 px-2 py-1.5 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
                    />
                  </div>
                  <button
                    onClick={() => handleSync(conn)}
                    disabled={isSyncing}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition"
                  >
                    {isSyncing ? (t("syncing") || "Syncing...") : (t("syncNow") || "Sync Now")}
                  </button>
                </div>

                {/* Sync result */}
                {syncResult && !syncResult.error && syncing === null && !importResult && (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between">
                      <p className="text-sm text-gray-600 dark:text-gray-300">
                        {syncResult.total_count} {t("transactionsFound") || "transactions found"}
                        {syncResult.date_from && (
                          <span className="text-xs text-gray-400 ml-2">
                            ({syncResult.date_from} to {syncResult.date_to})
                          </span>
                        )}
                      </p>
                      <label className="text-xs text-blue-500 cursor-pointer">
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
                          className="mr-1"
                        />
                        {t("selectAll") || "Select all"}
                      </label>
                    </div>

                    <div className="max-h-72 overflow-y-auto rounded-lg border border-gray-100 dark:border-gray-700">
                      {syncResult.transactions.map((txn, i) => (
                        <div
                          key={i}
                          onClick={() => toggleSelect(i)}
                          className={`flex items-center gap-3 px-4 py-2.5 border-b border-gray-50 dark:border-gray-700/50 cursor-pointer transition ${selected.has(i) ? "bg-blue-50/50 dark:bg-blue-900/10" : "hover:bg-gray-50 dark:hover:bg-gray-700/30"}`}
                        >
                          <input type="checkbox" checked={selected.has(i)} readOnly className="shrink-0" />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-gray-800 dark:text-gray-200 truncate">{txn.description}</p>
                            <p className="text-xs text-gray-400">{txn.date} &middot; {txn.suggested_category}</p>
                          </div>
                          <span className={`text-sm font-semibold shrink-0 ${txn.type === "income" ? "text-green-600 dark:text-green-400" : "text-red-500"}`}>
                            {txn.type === "income" ? "+" : "-"}{fmt(Math.abs(txn.amount))}
                          </span>
                        </div>
                      ))}
                    </div>

                    <button
                      onClick={() => handleConfirmImport(conn)}
                      disabled={confirming || selected.size === 0}
                      className="w-full py-2.5 bg-green-600 text-white rounded-xl font-semibold hover:bg-green-700 disabled:opacity-40 transition"
                    >
                      {confirming
                        ? (t("importing") || "Importing...")
                        : `${t("importSelected") || "Import"} ${selected.size} ${t("transactions") || "transactions"}`}
                    </button>
                  </div>
                )}

                {/* Sync error */}
                {syncResult?.error && (
                  <p className="text-sm text-red-500 bg-red-50 dark:bg-red-900/20 px-4 py-2 rounded-lg">{syncResult.error}</p>
                )}

                {/* Import result */}
                {importResult && (
                  <div className="bg-green-50 dark:bg-green-900/20 rounded-xl p-4 text-center">
                    <p className="text-green-700 dark:text-green-400 font-semibold">
                      {importResult.imported} {t("imported") || "imported"}
                      {importResult.skipped > 0 && (
                        <span className="text-gray-500 font-normal ml-2">({importResult.skipped} {t("duplicatesSkipped") || "duplicates skipped"})</span>
                      )}
                    </p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Connect modal */}
      {connectingProvider && (
        <div className="bg-white dark:bg-gray-800 rounded-xl border-2 border-blue-200 dark:border-blue-800 p-6 space-y-4">
          <div className="flex items-center gap-3">
            <span className="text-2xl">{connectingProvider.logo_emoji}</span>
            <div>
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                {t("connect") || "Connect"} {connectingProvider.name}
              </h3>
              <p className="text-xs text-gray-400">{connectingProvider.description}</p>
            </div>
          </div>

          <div>
            <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">
              {t("connectionLabel") || "Label (optional)"}
            </label>
            <input
              type="text"
              value={connectLabel}
              onChange={(e) => setConnectLabel(e.target.value)}
              placeholder={`e.g. "Main store ${connectingProvider.name}"`}
              className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
            />
          </div>

          {connectingProvider.fields.map((field) => (
            <div key={field.key}>
              <label className="text-xs text-gray-500 dark:text-gray-400 mb-1 block">
                {field.label}
              </label>
              <input
                type={field.type}
                value={creds[field.key] || ""}
                onChange={(e) => setCreds({ ...creds, [field.key]: e.target.value })}
                placeholder={field.placeholder}
                className="w-full px-3 py-2 rounded-lg border border-gray-200 dark:border-gray-600 bg-gray-50 dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200"
              />
            </div>
          ))}

          {connectError && <p className="text-sm text-red-500">{connectError}</p>}

          <div className="flex gap-3">
            <button
              onClick={handleConnect}
              disabled={saving}
              className="flex-1 py-2.5 bg-blue-600 text-white rounded-xl font-semibold hover:bg-blue-700 disabled:opacity-50 transition"
            >
              {saving ? (t("connecting") || "Connecting...") : (t("saveConnection") || "Save Connection")}
            </button>
            <button
              onClick={() => { setConnectingProvider(null); setCreds({}); setConnectError(""); }}
              className="px-4 py-2.5 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded-xl font-medium hover:bg-gray-200 dark:hover:bg-gray-600 transition"
            >
              {t("cancel") || "Cancel"}
            </button>
          </div>
        </div>
      )}

      {/* Available providers */}
      {!connectingProvider && (
        <div className="space-y-4">
          <h2 className="text-sm font-semibold text-gray-500 dark:text-gray-400 uppercase tracking-wider">
            {t("availableProviders") || "Available Providers"}
          </h2>

          {Object.entries(providersByCountry).map(([countryCode, countryProviders]) => (
            <div key={countryCode}>
              <p className="text-xs text-gray-400 dark:text-gray-500 mb-2 font-medium">
                {COUNTRY_LABELS[countryCode] || countryCode}
              </p>
              <div className="grid gap-3">
                {countryProviders.map((p) => {
                  const isConnected = connections.some((c) => c.provider === p.id);
                  return (
                    <div
                      key={`${countryCode}-${p.id}`}
                      className="bg-white dark:bg-gray-800 rounded-xl border border-gray-100 dark:border-gray-700 p-4 flex items-center justify-between"
                    >
                      <div className="flex items-center gap-3">
                        <span className="text-2xl">{p.logo_emoji}</span>
                        <div>
                          <p className="text-sm font-semibold text-gray-800 dark:text-white">{p.name}</p>
                          <p className="text-xs text-gray-400 max-w-sm">{p.description}</p>
                        </div>
                      </div>
                      {isConnected ? (
                        <span className="text-xs font-medium text-green-600 dark:text-green-400 bg-green-50 dark:bg-green-900/30 px-2.5 py-1 rounded-full">
                          {t("connected") || "Connected"}
                        </span>
                      ) : (
                        <button
                          onClick={() => { setConnectingProvider(p); setCreds({}); setConnectLabel(""); setConnectError(""); }}
                          className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition shrink-0"
                        >
                          {t("connect") || "Connect"}
                        </button>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}

          {/* UPI note */}
          <div className="bg-amber-50 dark:bg-amber-900/10 border border-amber-200 dark:border-amber-800/50 rounded-xl p-4">
            <p className="text-sm text-amber-800 dark:text-amber-300 font-medium">
              {t("upiNote") || "UPI, Google Pay, PhonePe (India)"}
            </p>
            <p className="text-xs text-amber-600 dark:text-amber-400 mt-1">
              {t("upiNoteDesc") || "UPI transactions appear in your bank statement. Use Bank CSV Import to import them from your bank's downloaded CSV file."}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
