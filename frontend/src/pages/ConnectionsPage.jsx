/**
 * ConnectionsPage — the friction-killer hub.
 *
 * One page that surfaces ALL integrations BonBox supports with their
 * current connection status. Each card has a clear one-tap action:
 * "Connect" → wires up the relevant flow (no multi-step setup wizard,
 * no buried settings page). Owners see what's connected, what's not,
 * and can act in under 30 seconds per integration.
 *
 * Status-driven UI:
 *   • emerald dot + "Connected" → green, with a "Manage" link
 *   • amber dot + "Action needed" → mid-state (e.g. invite sent, awaiting
 *     accountant to accept)
 *   • gray dot + "Not connected" → CTA primary button
 *   • locked "Coming soon" → for features still in the spec stage
 *     (Aiia direct bank, MobilePay) so owners can see the roadmap
 *
 * No backend changes — pulls from existing endpoints:
 *   /business           — accountant_email, bank/MobilePay/IBAN fields
 *   /accountants/grants — revisor invites + their status
 *   /bank-import/...    — bank CSV upload history (existence = "connected")
 *   /email-preferences  — for the brief email toggle
 *
 * Mobile-first. Stone palette. Each card is a self-contained widget
 * so owners can scan vertically and tap whatever is most relevant.
 */
import { useState, useEffect, useMemo, useCallback } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { Button, Card, Icon } from "../components/ui";

/**
 * Single connection card primitive. Shared layout so the page reads as
 * a consistent grid no matter how many integrations land here over
 * time. Status: "connected" | "pending" | "disconnected" | "soon".
 */
function ConnectionCard({
  icon = "Link2",
  title,
  description,
  status,             // see above
  statusLabel,        // override the dot label when needed
  primaryAction,      // { label, onClick, to, disabled }
  secondaryAction,    // optional { label, onClick, to }
  badge,              // optional small badge (e.g. "Pro feature")
  comingSoonNote,     // shown for status==="soon"
}) {
  const dot = {
    connected: "bg-emerald-500",
    pending: "bg-amber-500",
    disconnected: "bg-stone-400",
    soon: "bg-stone-300",
  }[status] || "bg-stone-300";

  const label = statusLabel || (
    status === "connected" ? "Connected"
    : status === "pending" ? "Action needed"
    : status === "soon" ? "Coming soon"
    : "Not connected"
  );

  return (
    <Card className="flex flex-col h-full">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg bg-stone-100 dark:bg-stone-800 flex items-center justify-center shrink-0 text-stone-700 dark:text-stone-300">
          <Icon name={icon} size={18} strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[15px] font-semibold text-stone-900 dark:text-stone-100 tracking-tight">
              {title}
            </h3>
            {badge && (
              <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-900/30 text-indigo-700 dark:text-indigo-300 font-medium">
                {badge}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 mt-1">
            <span className={`w-1.5 h-1.5 rounded-full ${dot}`} aria-hidden="true" />
            <span className="text-[11.5px] text-stone-500 dark:text-stone-400">{label}</span>
          </div>
        </div>
      </div>
      <p className="text-[13px] text-stone-600 dark:text-stone-300 leading-relaxed mb-4">
        {description}
      </p>
      {comingSoonNote && (
        <p className="text-[11.5px] text-stone-400 dark:text-stone-500 italic mb-3">
          {comingSoonNote}
        </p>
      )}
      <div className="mt-auto flex items-center gap-2">
        {primaryAction && (
          primaryAction.to ? (
            <Link
              to={primaryAction.to}
              className={`inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-900 ${
                status === "connected"
                  ? "bg-stone-100 dark:bg-stone-800 text-stone-700 dark:text-stone-200 hover:bg-stone-200 dark:hover:bg-stone-700"
                  : "bg-stone-900 dark:bg-stone-100 text-white dark:text-stone-900 hover:bg-stone-700 dark:hover:bg-stone-200"
              }`}
            >
              {primaryAction.label}
            </Link>
          ) : (
            <Button
              size="sm"
              onClick={primaryAction.onClick}
              disabled={primaryAction.disabled}
            >
              {primaryAction.label}
            </Button>
          )
        )}
        {secondaryAction && (
          secondaryAction.to ? (
            <Link
              to={secondaryAction.to}
              className="text-[12px] text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded px-1"
            >
              {secondaryAction.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="text-[12px] text-stone-600 hover:text-stone-900 dark:text-stone-400 dark:hover:text-stone-100 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 rounded px-1"
            >
              {secondaryAction.label}
            </button>
          )
        )}
      </div>
    </Card>
  );
}

export default function ConnectionsPage() {
  const { user } = useAuth();
  const { t } = useLanguage();
  const [searchParams, setSearchParams] = useSearchParams();
  const [profile, setProfile] = useState(null);
  const [grants, setGrants] = useState([]);
  const [emailPrefs, setEmailPrefs] = useState(null);
  const [bankConnections, setBankConnections] = useState([]);
  // Task #71 — MobilePay Erhverv connection (single row per user in v1).
  // null = not loaded yet; {} or row object = loaded.
  const [mpConnection, setMpConnection] = useState(null);
  const [mpBusy, setMpBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);   // { kind: 'success'|'error', msg }
  const [busyConn, setBusyConn] = useState(null);

  // Reload bank_connections — used after Sync / Disconnect to refresh state.
  const reloadBankConnections = useCallback(async () => {
    try {
      const r = await api.get("/bank-connections");
      setBankConnections(r.data || []);
    } catch {
      // Endpoint is auth-required; non-auth shouldn't hit this page anyway.
      setBankConnections([]);
    }
  }, []);

  // Reload MobilePay connection. There's at most one per user in v1 so
  // we fetch payments-list as a proxy for "is there an active row?" —
  // GET /payments returns 404 when no connection exists, which we treat
  // as the "Not connected" state.
  const reloadMobilePayConnection = useCallback(async () => {
    try {
      const r = await api.get("/mobilepay/payments");
      // We don't use the payments list here, only the side effect of
      // updating last_synced_at. The connection state itself is
      // tracked via mpConnection — set by the callback flow.
      setMpConnection((prev) => ({
        ...(prev || {}),
        status: "active",
        last_synced_at: r.data?.last_synced_at || null,
      }));
    } catch (err) {
      const status = err?.response?.status;
      if (status === 404) {
        setMpConnection(null);
      } else if (status === 400 || status === 409) {
        // Connection exists but isn't active (pending / expired)
        setMpConnection({ status: status === 409 ? "expired" : "pending" });
      }
    }
  }, []);

  useEffect(() => {
    let alive = true;
    Promise.all([
      api.get("/business").then(r => r.data).catch(() => null),
      api.get("/accountants/grants").then(r => r.data || []).catch(() => []),
      api.get("/email/preferences").then(r => r.data).catch(() => null),
      api.get("/bank-connections").then(r => r.data || []).catch(() => []),
    ]).then(([p, g, e, bc]) => {
      if (!alive) return;
      setProfile(p);
      setGrants(g);
      setEmailPrefs(e);
      setBankConnections(bc);
      setLoading(false);
    });
    // MobilePay is a side request — failure is silent (no connection yet)
    // and shouldn't block the initial render of the rest of the page.
    reloadMobilePayConnection();
    return () => { alive = false; };
  }, [reloadMobilePayConnection]);

  // Surface the "🎉 Bank connected" toast when the OAuth callback
  // bounces us back to /connections?bank_connected=1 (Task #67).
  useEffect(() => {
    if (searchParams.get("bank_connected") === "1") {
      setToast({ kind: "success", msg: "🎉 Bank connected — first sync running now" });
      // Strip the query param so a refresh doesn't re-trigger the toast.
      const next = new URLSearchParams(searchParams);
      next.delete("bank_connected");
      setSearchParams(next, { replace: true });
    } else if (searchParams.get("bank_error") === "1") {
      setToast({ kind: "error", msg: "Bank connection cancelled — try again" });
      const next = new URLSearchParams(searchParams);
      next.delete("bank_error");
      setSearchParams(next, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  // Task #71 — MobilePay returning from MitID Business consent.
  // MobilePay redirects us back to /connections?mobilepay_returning=1
  // with state + code as additional query params. We POST those to
  // /api/mobilepay/callback to complete the activation, then strip the
  // params so a refresh doesn't re-trigger.
  useEffect(() => {
    if (searchParams.get("mobilepay_returning") !== "1") return;
    const state = searchParams.get("state");
    const code = searchParams.get("code");
    const next = new URLSearchParams(searchParams);
    next.delete("mobilepay_returning");
    next.delete("state");
    next.delete("code");
    setSearchParams(next, { replace: true });

    if (!state || !code) {
      setToast({
        kind: "error",
        msg: t("mpCallbackCancelled") || "MobilePay connection cancelled",
      });
      return;
    }
    setMpBusy(true);
    api.post("/mobilepay/callback", { state, code })
      .then(() => {
        setToast({
          kind: "success",
          msg: t("mpConnectedToast") || "🎉 MobilePay connected",
        });
        return reloadMobilePayConnection();
      })
      .catch((err) => {
        setToast({
          kind: "error",
          msg: err?.response?.data?.detail ||
               t("mpCallbackError") ||
               "Could not finish MobilePay connection",
        });
      })
      .finally(() => setMpBusy(false));
  }, [searchParams, setSearchParams, reloadMobilePayConnection, t]);

  // Auto-clear toast after 4s.
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 4000);
    return () => clearTimeout(id);
  }, [toast]);

  const syncBankConnection = async (connId) => {
    setBusyConn(connId);
    try {
      const res = await api.post(`/bank-connections/${connId}/sync`);
      const { new_sales, new_expenses, suggestions, auto_confirmed } = res.data;
      setToast({
        kind: "success",
        msg: `Synced: ${new_sales + new_expenses} new, ${suggestions} suggestions, ${auto_confirmed} auto-matched`,
      });
      await reloadBankConnections();
    } catch (err) {
      setToast({
        kind: "error",
        msg: err?.response?.data?.detail?.message ||
             err?.response?.data?.detail || "Sync failed",
      });
    }
    setBusyConn(null);
  };

  const disconnectBankConnection = async (connId) => {
    if (!window.confirm("Disconnect this bank? Daily sync will stop.")) return;
    setBusyConn(connId);
    try {
      await api.delete(`/bank-connections/${connId}`);
      setToast({ kind: "success", msg: "Bank disconnected" });
      await reloadBankConnections();
    } catch (err) {
      setToast({
        kind: "error",
        msg: err?.response?.data?.detail || "Could not disconnect",
      });
    }
    setBusyConn(null);
  };

  // Task #71 — MobilePay init: POST /api/mobilepay/init, then redirect
  // the owner to the returned consent URL. MobilePay handles MitID
  // Business + scope review, then bounces them back to /connections
  // with ?mobilepay_returning=1&state=...&code=... which the effect
  // above POSTs to /callback.
  const connectMobilePay = async () => {
    setMpBusy(true);
    try {
      const res = await api.post("/mobilepay/init", {});
      const { redirect_url } = res.data || {};
      if (redirect_url) {
        window.location.assign(redirect_url);
      } else {
        setToast({
          kind: "error",
          msg: t("mpInitError") || "Could not start MobilePay connection",
        });
      }
    } catch (err) {
      const status = err?.response?.status;
      // 402 = feature locked (Free user) -> bounce to subscription
      if (status === 402) {
        setToast({
          kind: "error",
          msg: t("mpFreeGate") ||
               "MobilePay auto-sync is a Starter+ feature.",
        });
      } else {
        setToast({
          kind: "error",
          msg: err?.response?.data?.detail ||
               t("mpInitError") ||
               "Could not start MobilePay connection",
        });
      }
    } finally {
      setMpBusy(false);
    }
  };

  const syncMobilePay = async () => {
    setMpBusy(true);
    try {
      const res = await api.get("/mobilepay/payments");
      const { new_payments, auto_matched } = res.data || {};
      setToast({
        kind: "success",
        msg: `${t("mpSyncedToast") || "MobilePay synced"}: ${new_payments || 0} new, ${auto_matched || 0} auto-matched`,
      });
      await reloadMobilePayConnection();
    } catch (err) {
      setToast({
        kind: "error",
        msg: err?.response?.data?.detail ||
             t("mpSyncError") || "Could not sync MobilePay",
      });
    } finally {
      setMpBusy(false);
    }
  };

  const disconnectMobilePay = async () => {
    if (!window.confirm(
      t("mpDisconnectConfirm") ||
      "Disconnect MobilePay? Daily sync will stop.",
    )) return;
    setMpBusy(true);
    try {
      await api.delete("/mobilepay/connection");
      setToast({
        kind: "success",
        msg: t("mpDisconnectedToast") || "MobilePay disconnected",
      });
      setMpConnection(null);
    } catch (err) {
      setToast({
        kind: "error",
        msg: err?.response?.data?.detail ||
             t("mpDisconnectError") || "Could not disconnect MobilePay",
      });
    } finally {
      setMpBusy(false);
    }
  };

  const activeBankConnections = bankConnections.filter(
    (c) => c.status === "active",
  );

  // Derive status for each integration from the data we just fetched.
  // Pure derivation — no extra requests. If a derivation needs more
  // data later, it lives next to the card definition, not inside the
  // card primitive.
  const derived = useMemo(() => {
    const accountantEmail = profile?.accountant_email || "";
    const bankInfo = profile?.bank_account_number || profile?.iban || "";
    const mobilepay = profile?.mobilepay_number || "";

    // Revisor: counts pending + active grants. Active wins display-wise.
    const activeGrants = grants.filter(g => g.status === "active");
    const pendingGrants = grants.filter(g => g.status === "pending");
    let revisorStatus = "disconnected";
    let revisorLabel = "Not invited yet";
    if (activeGrants.length > 0) {
      revisorStatus = "connected";
      revisorLabel = activeGrants.length === 1
        ? "Connected · 1 revisor"
        : `Connected · ${activeGrants.length} revisorer`;
    } else if (pendingGrants.length > 0) {
      revisorStatus = "pending";
      revisorLabel = `Invite sent · awaiting response`;
    }

    return {
      bank: {
        // We don't store "is the bank connected?" anywhere yet, so the
        // best signal is "has the owner ever uploaded a CSV?" Until we
        // add a real connections registry, surface bank account info
        // existence as the proxy.
        status: bankInfo ? "connected" : "disconnected",
        label: bankInfo ? "Bank details saved" : "Not connected",
      },
      mobilepay: {
        status: mobilepay ? "connected" : "disconnected",
        label: mobilepay ? "MobilePay number saved" : "Not connected",
      },
      revisor: { status: revisorStatus, label: revisorLabel },
      accountantEmail: {
        status: accountantEmail ? "connected" : "disconnected",
        label: accountantEmail ? `Sending to ${accountantEmail}` : "No accountant email",
      },
      briefEmail: {
        status: emailPrefs?.daily_brief_email_enabled ? "connected" : "disconnected",
        label: emailPrefs?.daily_brief_email_enabled ? "Arrives 8am Copenhagen" : "Not subscribed",
      },
    };
  }, [profile, grants, emailPrefs]);

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto p-5 sm:p-6">
        <div className="animate-pulse space-y-6">
          <div className="h-6 w-48 bg-stone-200 dark:bg-stone-700 rounded" />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className="h-44 bg-stone-100 dark:bg-stone-800 rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-5xl mx-auto p-5 sm:p-6 pb-32 md:pb-12">
      {/* Toast (Task #67 — "🎉 Bank connected" / errors) */}
      {toast && (
        <div
          className={`fixed top-5 right-5 z-50 px-4 py-3 rounded-xl shadow-lg text-sm font-medium ${
            toast.kind === "success"
              ? "bg-emerald-600 text-white"
              : "bg-red-600 text-white"
          }`}
          role="status"
        >
          {toast.msg}
        </div>
      )}

      {/* Header */}
      <div className="mb-7">
        <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight text-stone-900 dark:text-stone-100">
          {t("connectionsTitle") || "Connections"}
        </h1>
        <p className="mt-2 text-[15px] text-stone-600 dark:text-stone-400 leading-relaxed max-w-2xl">
          {t("connectionsSubtitle") ||
            "Connect once, never again. Your bank, your MobilePay, your revisor, your accountant — all in one place. Each one is one tap and under 60 seconds."}
        </p>
      </div>

      {/* Aiia bank connections panel (Task #67) — shown ABOVE the grid
          when the owner has 1+ active connections, so the most-relevant
          actionable state is the first thing they see. */}
      {activeBankConnections.length > 0 && (
        <div className="mb-7 bg-emerald-50 dark:bg-emerald-900/20 border border-emerald-200 dark:border-emerald-800 rounded-2xl p-5">
          <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
            <div>
              <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
                Bank connections
              </h2>
              <p className="text-xs text-stone-600 dark:text-stone-400 mt-0.5">
                Direct PSD2 feed via Aiia. Auto-syncs nightly.
              </p>
            </div>
            <Link
              to="/bank-import"
              className="text-xs text-emerald-700 hover:text-emerald-900 dark:text-emerald-300 dark:hover:text-emerald-100 underline"
            >
              + Connect another
            </Link>
          </div>
          <div className="space-y-2">
            {activeBankConnections.map((conn) => {
              const lastSyncedHuman = conn.last_synced_at
                ? new Date(conn.last_synced_at).toLocaleString()
                : "Never synced";
              const bankLabel = (conn.bank_slug || "bank")
                .replace(/_/g, " ")
                .replace(/\b\w/g, (c) => c.toUpperCase());
              return (
                <div
                  key={conn.id}
                  className="flex flex-wrap items-center gap-2 p-3 bg-white dark:bg-stone-900 rounded-lg border border-stone-100 dark:border-stone-800"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-stone-900 dark:text-stone-100 truncate">
                      {bankLabel}
                      {conn.sandbox_mode && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
                          Sandbox
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-stone-500 dark:text-stone-400 truncate">
                      {conn.account_label || "Bank account"} · Last sync: {lastSyncedHuman}
                    </div>
                  </div>
                  <button
                    onClick={() => syncBankConnection(conn.id)}
                    disabled={busyConn === conn.id}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900 hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-50"
                  >
                    {busyConn === conn.id ? "Syncing…" : "Sync now"}
                  </button>
                  <button
                    onClick={() => disconnectBankConnection(conn.id)}
                    disabled={busyConn === conn.id}
                    className="text-xs text-stone-600 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400 disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* MobilePay Erhverv panel (Task #71) — mirrors the bank
          connections panel above. Shown when the user has an active
          (or expired) MobilePay connection, so the most actionable
          state is surfaced before the integration grid. */}
      {mpConnection?.status === "active" && (
        <div className="mb-7 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-2xl p-5">
          <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
            <div>
              <h2 className="text-base font-semibold text-stone-900 dark:text-stone-100">
                {t("mpPanelTitle") || "MobilePay Erhverv"}
              </h2>
              <p className="text-xs text-stone-600 dark:text-stone-400 mt-0.5">
                {t("mpPanelSubtitle") ||
                  "Per-payment feed via Vipps MobilePay. Auto-syncs nightly."}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 p-3 bg-white dark:bg-stone-900 rounded-lg border border-stone-100 dark:border-stone-800">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-stone-900 dark:text-stone-100 truncate">
                {mpConnection?.merchant_name || t("mpDefaultMerchant") || "MobilePay Erhverv"}
                {/* Task #89 P3-5 — sandbox badge parity with the bank
                    rows above. The MobilePay backend client switches to
                    the live Vipps endpoint only in production builds
                    (MOBILEPAY_ENV defaults to "mock"); any non-prod
                    Vite build is therefore inherently sandbox/mock.
                    Using import.meta.env.MODE keeps this entirely
                    frontend-side per the Task #89 "no backend touches"
                    constraint, and mirrors the visual treatment of the
                    Aiia bank sandbox pill (same colours, same shape). */}
                {import.meta.env.MODE !== "production" && (
                  <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
                    Sandbox
                  </span>
                )}
              </div>
              <div className="text-xs text-stone-500 dark:text-stone-400 truncate">
                {(t("mpLastSynced") || "Last sync") + ": "}
                {mpConnection?.last_synced_at
                  ? new Date(mpConnection.last_synced_at).toLocaleString()
                  : (t("mpNeverSynced") || "Never synced")}
              </div>
            </div>
            <button
              onClick={syncMobilePay}
              disabled={mpBusy}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-stone-900 text-white dark:bg-stone-100 dark:text-stone-900 hover:bg-stone-700 dark:hover:bg-stone-200 disabled:opacity-50"
            >
              {mpBusy
                ? (t("mpSyncing") || "Syncing…")
                : (t("mpSyncNow") || "Sync now")}
            </button>
            <button
              onClick={disconnectMobilePay}
              disabled={mpBusy}
              className="text-xs text-stone-600 hover:text-red-600 dark:text-stone-400 dark:hover:text-red-400 disabled:opacity-50"
            >
              {t("mpDisconnect") || "Disconnect"}
            </button>
          </div>
        </div>
      )}

      {mpConnection?.status === "expired" && (
        <div className="mb-7 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-2xl p-4 flex items-center justify-between gap-3 flex-wrap">
          <div>
            <div className="text-sm font-semibold text-amber-900 dark:text-amber-200">
              {t("mpExpiredTitle") || "MobilePay needs re-consent"}
            </div>
            <div className="text-xs text-amber-800 dark:text-amber-300 mt-0.5">
              {t("mpExpiredBody") ||
                "Your MobilePay connection lapsed — sign in again to keep auto-sync running."}
            </div>
          </div>
          <button
            onClick={connectMobilePay}
            disabled={mpBusy}
            className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-amber-600 text-white hover:bg-amber-700 disabled:opacity-50"
          >
            {t("mpReconnect") || "Re-connect"}
          </button>
        </div>
      )}

      {/* Grid of integration cards */}
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {/* Bank */}
        <ConnectionCard
          icon="Landmark"
          title={t("connBankTitle") || "Bank reconciliation"}
          description={
            t("connBankDesc") ||
            "Upload your netbank CSV (Danske, Nordea, Jyske, Spar Nord, Lunar) — BonBox auto-matches payments to your fakturaer within ±2 kr."
          }
          status={
            activeBankConnections.length > 0
              ? "connected"
              : derived.bank.status
          }
          statusLabel={
            activeBankConnections.length > 0
              ? `Connected · ${activeBankConnections.length} account${activeBankConnections.length > 1 ? "s" : ""}`
              : derived.bank.label
          }
          primaryAction={{
            label: activeBankConnections.length > 0
              ? (t("connManage") || "Manage")
              : (t("connConnect") || "Connect bank"),
            to: "/bank-import",
          }}
          comingSoonNote={
            activeBankConnections.length === 0
              ? (t("connBankAiia") || "Aiia direct connection available on /bank-import.")
              : undefined
          }
        />

        {/* MobilePay Erhverv (Task #71) — live OAuth flow.
            Shows a different CTA depending on connection state:
              * no connection      → "Connect MobilePay Erhverv"
              * active connection  → "Sync now" + "Disconnect"
              * expired connection → "Re-connect"
            Card-only — the active connection detail (last sync timestamp,
            disconnect button) lives in the dedicated panel above the
            grid when status === 'active'. */}
        <ConnectionCard
          icon="CreditCard"
          title={t("mpConnectTitle") || "MobilePay Erhverv"}
          description={
            t("connMobilePayDesc") ||
            "Direct settlement import — 30-50% of café revenue, auto-matched daily. No more typing MobilePay totals into your daily close."
          }
          status={
            mpConnection?.status === "active"
              ? "connected"
              : mpConnection?.status === "expired"
              ? "pending"
              : "disconnected"
          }
          statusLabel={
            mpConnection?.status === "active"
              ? (t("mpStatusActive") || "Connected · auto-syncs nightly")
              : mpConnection?.status === "expired"
              ? (t("mpStatusExpired") || "Connection expired")
              : (t("mpStatusNotConnected") || "Not connected")
          }
          badge={t("connStarterBadge") || "Starter+"}
          primaryAction={{
            label: mpBusy
              ? (t("connecting") || "Connecting…")
              : mpConnection?.status === "active"
              ? (t("mpManage") || "Manage")
              : mpConnection?.status === "expired"
              ? (t("mpReconnect") || "Re-connect")
              : (t("mpConnectCta") || "Connect MobilePay Erhverv"),
            onClick: mpConnection?.status === "active" ? undefined : connectMobilePay,
            disabled: mpBusy,
          }}
        />

        {/* Revisor (accountant login) */}
        <ConnectionCard
          icon="UserCog"
          title={t("connRevisorTitle") || "Your revisor"}
          description={
            t("connRevisorDesc") ||
            "Free read-only login for your accountant. They see fakturaer, daily closes, expenses, MOMS overview — can't change a single thing. No more password sharing or GDPR risk."
          }
          status={derived.revisor.status}
          statusLabel={derived.revisor.label}
          badge={t("connStarterBadge") || "Starter+"}
          primaryAction={{
            label: derived.revisor.status === "disconnected"
              ? (t("connInviteRevisor") || "Invite revisor")
              : (t("connManage") || "Manage"),
            to: "/profile#billing",
          }}
        />

        {/* Accountant email (for kasserapport sending) */}
        <ConnectionCard
          icon="Mail"
          title={t("connAccountantEmailTitle") || "Accountant email"}
          description={
            t("connAccountantEmailDesc") ||
            "Where your daily close PDFs and MOMS filings get sent. One-tap 'Email to my revisor' on every export. Separate from the revisor login above."
          }
          status={derived.accountantEmail.status}
          statusLabel={derived.accountantEmail.label}
          primaryAction={{
            label: derived.accountantEmail.status === "disconnected"
              ? (t("connSetEmail") || "Set email")
              : (t("connEdit") || "Edit"),
            to: "/profile#billing",
          }}
        />

        {/* Brief email */}
        <ConnectionCard
          icon="Sparkles"
          title={t("connBriefEmailTitle") || "Morning brief email"}
          description={
            t("connBriefEmailDesc") ||
            "Get the 9am brief in your inbox — revenue, MOMS countdown, regulars-at-risk, weather + recurring bills. Forward to your partner with one tap."
          }
          status={derived.briefEmail.status}
          statusLabel={derived.briefEmail.label}
          primaryAction={{
            label: derived.briefEmail.status === "connected"
              ? (t("connManage") || "Manage")
              : (t("connEnable") || "Enable"),
            to: "/profile#notifications",
          }}
        />

        {/* Sales channels — multi-select */}
        <ConnectionCard
          icon="Bike"
          title={t("connSalesChannelsTitle") || "Sales channels"}
          description={
            t("connSalesChannelsDesc") ||
            "Wolt, Uber Eats, Foodora, in-store, phone, catering. Tag every sale by source so the daily breakdown shows where revenue came from."
          }
          status="connected"
          statusLabel={t("connSalesChannelsAvail") || "Available — tag in /sales"}
          primaryAction={{
            label: t("connCustomize") || "Customize channels",
            to: "/channel-settings",
          }}
        />

        {/* Accountant bookkeeping export bridge */}
        <ConnectionCard
          icon="FileSpreadsheet"
          title={t("connBookkeepingTitle") || "Bookkeeping export"}
          description={
            t("connBookkeepingDesc") ||
            "Export your books in Dinero / Billy / e-conomic / Generic CSV format. Your revisor drops it straight into their accounting tool — no copy-paste."
          }
          status="connected"
          statusLabel={t("connBookkeepingReady") || "Ready to export"}
          primaryAction={{
            label: t("connExportNow") || "Export now",
            to: "/bookkeeping-export",
          }}
          secondaryAction={{
            label: t("connSendNow") || "Send to revisor",
            to: "/bookkeeping-export",
          }}
        />

        {/* Faktura — Stripe-like "we accept fakturas, you don't have to" */}
        <ConnectionCard
          icon="FileText"
          title={t("connFakturaTitle") || "Faktura sending"}
          description={
            t("connFakturaDesc") ||
            "Direct customer email with the PDF attached. Gap-free fakturanummer, kreditnota on void, bank auto-match when the payment arrives."
          }
          status="connected"
          statusLabel={t("connFakturaReady") || "Ready"}
          badge={t("connStarterBadge") || "Starter+"}
          primaryAction={{
            label: t("connOpenFaktura") || "Open Faktura",
            to: "/faktura",
          }}
        />
      </div>

      {/* Footer — sets the right expectation about what's NOT here */}
      <p className="mt-10 text-center text-[12px] text-stone-500 dark:text-stone-400 leading-relaxed max-w-2xl mx-auto">
        {t("connectionsFooter") ||
          "We deliberately don't connect to your POS — Lightspeed, Toast, Square keep that role. BonBox sits beside them and reads your sales register via daily sync. Same with payment terminals: keep your Dankort + iZettle, BonBox imports the daily totals."}
      </p>
    </div>
  );
}
