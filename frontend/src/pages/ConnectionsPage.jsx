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
import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Link, useSearchParams } from "react-router-dom";
import api from "../services/api";
import { useAuth } from "../hooks/useAuth";
import { useLanguage } from "../hooks/useLanguage";
import { useFeatures } from "../hooks/useFeatures";
// Task #120 polish (Agent E): migrated H1 → PageHeader, KPI cards →
// StatCard, info banners → SectionBanner, tabs → TabPills.  Behavior
// + i18n + a11y unchanged.
import { Button, Card, Icon, PageHeader } from "../components/ui";

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
    disconnected: "bg-gray-400",
    soon: "bg-gray-300",
  }[status] || "bg-gray-300";

  const label = statusLabel || (
    status === "connected" ? "Connected"
    : status === "pending" ? "Action needed"
    : status === "soon" ? "Coming soon"
    : "Not connected"
  );

  return (
    <Card className="flex flex-col h-full">
      <div className="flex items-start gap-3 mb-3">
        <div className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0 text-gray-700 dark:text-gray-300">
          <Icon name={icon} size={18} strokeWidth={1.75} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <h3 className="text-[15px] font-semibold text-gray-900 dark:text-gray-100 tracking-tight">
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
            <span className="text-[11.5px] text-gray-500 dark:text-gray-400">{label}</span>
          </div>
        </div>
      </div>
      <p className="text-[13px] text-gray-600 dark:text-gray-300 leading-relaxed mb-4">
        {description}
      </p>
      {comingSoonNote && (
        <p className="text-[11.5px] text-gray-400 dark:text-gray-500 italic mb-3">
          {comingSoonNote}
        </p>
      )}
      <div className="mt-auto flex items-center gap-2">
        {primaryAction && (
          primaryAction.to ? (
            <Link
              to={primaryAction.to}
              className={`inline-flex items-center justify-center px-3 py-1.5 rounded-lg text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 focus-visible:ring-offset-2 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-900 ${
                status === "connected"
                  ? "bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-gray-200 dark:hover:bg-gray-700"
                  : "bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-200"
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
              className="text-[12px] text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 rounded px-1"
            >
              {secondaryAction.label}
            </Link>
          ) : (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className="text-[12px] text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 rounded px-1"
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
  // Task #106 — hide bank / MobilePay tiles in prod when no real
  // provider is configured. Backend /init endpoints also 503 so a
  // direct API hit still surfaces a "coming soon" message.
  const {
    bank_connect_enabled: bankConnectEnabled,
    mobilepay_enabled: mobilepayEnabled,
  } = useFeatures();
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
  // Receipt-forwarding inbox state (v0.1) — fetched from /api/inbox/me.
  // Shape: { alias, enabled, messages_this_month, cap, infra_enabled }.
  // null = still loading; {} = transport error (we render the card in
  // an honest "coming soon" / disabled state in that case). Owner-only
  // test-email button gates locally + backend re-checks.
  const [inboxState, setInboxState] = useState(null);
  const [inboxTesting, setInboxTesting] = useState(false);
  const [inboxCopied, setInboxCopied] = useState(false);

  // Task #238 — Terminals section (POS-acquirer override). Owner sees
  // one row per Terminal with a Change ▾ dropdown that lets them pick
  // any of the 18 catalog providers manually. Catalog is lazy-loaded
  // the first time the dropdown opens (cached for the session).
  //
  // State shape:
  //   terminals          — list of Terminal rows from GET /terminals
  //                        (null until first fetch resolves)
  //   branches           — list of Branch rows (null = not loaded;
  //                        [] = loaded but empty / single-branch user)
  //   providerCatalog    — list of TerminalProvider rows (null until
  //                        first dropdown open)
  //   catalogLoading     — true while /terminal-providers is in flight
  //   openTerminalId     — terminal_id whose dropdown is open (null = none)
  //   busyTerminalId     — terminal_id with a POST in flight (disables
  //                        the row's controls + shows a spinner)
  const [terminals, setTerminals] = useState(null);
  const [branches, setBranches] = useState(null);
  const [providerCatalog, setProviderCatalog] = useState(null);
  const [catalogLoading, setCatalogLoading] = useState(false);
  const [openTerminalId, setOpenTerminalId] = useState(null);
  const [busyTerminalId, setBusyTerminalId] = useState(null);

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
    // Receipt-forwarding inbox (v0.1) — also a side request. If the
    // endpoint isn't deployed yet (404/501) we fall back to a "Coming
    // soon" card; on any other transport error we render an honest
    // disconnected card (no fake alias).
    api.get("/inbox/me")
      .then((r) => { if (alive) setInboxState(r.data || {}); })
      .catch((err) => {
        if (!alive) return;
        const status = err?.response?.status;
        if (status === 404 || status === 501) {
          setInboxState({ infra_enabled: false, alias: null });
        } else {
          setInboxState({ _error: true });
        }
      });
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
  //
  // IDEMPOTENCY (Task #101 follow-up): the effect's dep array includes
  // `t` from useLanguage, which changes reference when the i18n
  // dictionary loads async after first paint.  That second `t` change
  // re-fired the effect with the SAME state token still in the
  // closure of the FIRST render — backend then returned 400
  // "state already consumed" because mock + real-world callback
  // exchanges are one-shot.  Track which (state) values we've already
  // POSTed in this mount via a ref so the second fire bails out.
  const mpSubmittedStates = useRef(new Set());
  useEffect(() => {
    if (searchParams.get("mobilepay_returning") !== "1") return;
    const state = searchParams.get("state");
    const code = searchParams.get("code");
    // De-dupe: same state already submitted in this mount → no-op.
    // Still clear the params so the URL doesn't keep them around.
    if (state && mpSubmittedStates.current.has(state)) {
      const next = new URLSearchParams(searchParams);
      next.delete("mobilepay_returning");
      next.delete("state");
      next.delete("code");
      setSearchParams(next, { replace: true });
      return;
    }
    if (state) mpSubmittedStates.current.add(state);

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

  // Task #238 — fetch terminals + branches on mount. Both endpoints are
  // owner-scoped + tolerant of missing rows (single-branch users get an
  // empty branches list, which is fine — we just skip the branch name
  // sub-line). Catalog stays lazy (only fetched when the owner first
  // taps Change ▾) to keep this page's first-paint as light as possible.
  const reloadTerminals = useCallback(async () => {
    try {
      const r = await api.get("/terminals");
      setTerminals(Array.isArray(r.data) ? r.data : []);
    } catch {
      setTerminals([]);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    api.get("/terminals")
      .then((r) => { if (alive) setTerminals(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setTerminals([]); });
    api.get("/branches")
      .then((r) => { if (alive) setBranches(Array.isArray(r.data) ? r.data : []); })
      .catch(() => { if (alive) setBranches([]); });
    return () => { alive = false; };
  }, []);

  // Lazy-load the 18-provider catalog the first time the owner taps
  // Change ▾ on any row. Cached for the rest of the session — repeated
  // dropdown opens are zero-cost.
  const ensureProviderCatalog = useCallback(async () => {
    if (providerCatalog || catalogLoading) return providerCatalog;
    setCatalogLoading(true);
    try {
      const r = await api.get("/terminals/terminal-providers");
      const list = Array.isArray(r.data?.providers) ? r.data.providers : [];
      setProviderCatalog(list);
      return list;
    } catch {
      setToast({
        kind: "error",
        msg: t("connTerminalsSaveError") || "Could not save. Try again.",
      });
      setProviderCatalog([]);
      return [];
    } finally {
      setCatalogLoading(false);
    }
  }, [providerCatalog, catalogLoading, t]);

  const openTerminalDropdown = async (terminalId) => {
    setOpenTerminalId(terminalId);
    await ensureProviderCatalog();
  };

  const linkTerminalProvider = async (terminalId, providerId) => {
    setBusyTerminalId(terminalId);
    try {
      if (providerId) {
        await api.post(`/terminals/${terminalId}/link-provider`, {
          provider_id: providerId,
          confidence: 1.0,
        });
      } else {
        await api.post(`/terminals/${terminalId}/unlink-provider`, {});
      }
      await reloadTerminals();
      setOpenTerminalId(null);
    } catch (err) {
      setToast({
        kind: "error",
        msg: err?.response?.data?.detail ||
             t("connTerminalsSaveError") || "Could not save. Try again.",
      });
    } finally {
      setBusyTerminalId(null);
    }
  };

  const unlinkTerminalProvider = async (terminalId) => {
    if (!window.confirm(
      t("connTerminalsUnlinkConfirm") ||
      "Unlink this terminal? You'll be able to relink it later.",
    )) return;
    setBusyTerminalId(terminalId);
    try {
      await api.post(`/terminals/${terminalId}/unlink-provider`, {});
      await reloadTerminals();
    } catch (err) {
      setToast({
        kind: "error",
        msg: err?.response?.data?.detail ||
             t("connTerminalsUnlinkError") || "Could not unlink. Try again.",
      });
    } finally {
      setBusyTerminalId(null);
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

  // ── Receipt-forwarding inbox (v0.1) handlers ───────────────────────
  //
  // Copy alias to clipboard with the legacy textarea fallback for
  // embedded webviews (same trick DailyBriefCard uses). The "Copied!"
  // pill is local UI feedback — no toast required since the button
  // itself transforms.
  const copyInboxAlias = async () => {
    const alias = inboxState?.alias;
    if (!alias) return;
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(alias);
      } else {
        const ta = document.createElement("textarea");
        ta.value = alias;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      setInboxCopied(true);
      setTimeout(() => setInboxCopied(false), 2200);
    } catch {
      setToast({
        kind: "error",
        msg: t("inboxCopyFailed", "Couldn't copy — long-press the address to select."),
      });
    }
  };

  // Send-test goes through the same toast tray as Bank/MobilePay so
  // owners get one consistent place to read success/error feedback.
  // Backend rate-limits to 5/day per owner; we don't bother enforcing
  // that here (defense in depth = backend wins).
  const sendInboxTest = async () => {
    if (inboxTesting) return;
    setInboxTesting(true);
    try {
      const r = await api.post("/inbox/test");
      const ok = r?.data?.ok !== false;
      if (ok) {
        setToast({
          kind: "success",
          msg: t(
            "inboxTestSent",
            "Test receipt queued — it'll appear as a draft in a moment.",
          ),
        });
      } else {
        setToast({
          kind: "error",
          msg: r?.data?.reason || t("inboxTestFailedGeneric", "Couldn't send a test receipt."),
        });
      }
    } catch (err) {
      const detail = err?.response?.data?.detail || err?.response?.data?.reason;
      setToast({
        kind: "error",
        msg: detail || t("inboxTestFailedGeneric", "Couldn't send a test receipt."),
      });
    } finally {
      setInboxTesting(false);
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
    const referenceIban = profile?.bank_account_number || profile?.iban || "";
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

    // Task #204 P2.10 — honest bank connection signal.  The previous
    // derivation flipped to "connected" whenever the owner had typed an
    // IBAN into Profile — which is a TRUST violation: the IBAN string
    // doesn't grant us PSD2 access to that account, and the green dot
    // suggested otherwise.  Truth: bank.status = "connected" ONLY when
    // there's an active BankConnection row gated by the feature flag.
    // The IBAN string remains a useful reference for the faktura footer
    // (Momsbekendtgørelsen §57) but is NOT a connection signal.
    const hasActiveBank =
      activeBankConnections.length > 0 && !!bankConnectEnabled;

    return {
      bank: {
        status: hasActiveBank ? "connected" : "disconnected",
        label: hasActiveBank ? "Connected · auto-syncs nightly" : "Not connected",
      },
      // Reference-only IBAN signal — fed into the IBAN hint copy below.
      referenceIban,
      hasActiveBank,
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
  }, [profile, grants, emailPrefs, activeBankConnections.length, bankConnectEnabled]);

  if (loading) {
    return (
      <div className="max-w-5xl mx-auto p-5 sm:p-6">
        <div className="animate-pulse space-y-6">
          <div className="h-6 w-48 bg-gray-200 dark:bg-gray-700 rounded" />
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {[1, 2, 3, 4, 5, 6].map(i => (
              <div key={i} className="h-44 bg-gray-100 dark:bg-gray-800 rounded-xl" />
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
          className={`fixed top-5 right-5 z-50 px-4 py-3 rounded-xl shadow-sm text-sm font-medium ${
            toast.kind === "success"
              ? "bg-gray-900 text-white"
              : "bg-red-600 text-white"
          }`}
          role="status"
        >
          {toast.msg}
        </div>
      )}

      {/* Header — eyebrow is a sidebar-group identifier, not translated
          (matches the REPORTS / STOCK / MANAGE pattern across the app).
          The `t() || fallback` form was broken: t() returns the literal
          key when no translation exists, which is truthy, so the
          fallback never fired and "CONNECTIONSEYEBROW" rendered raw to
          the user. Found via live walkthrough #130. */}
      <PageHeader
        eyebrow="MANAGE"
        title={t("connectionsTitle") || "Connections"}
        subtitle={t("connectionsSubtitle") ||
          "Connect once, never again. Your bank, your MobilePay, your revisor, your accountant — all in one place. Each one is one tap and under 60 seconds."}
      />

      {/* Aiia bank connections panel (Task #67) — shown ABOVE the grid
          when the owner has 1+ active connections, so the most-relevant
          actionable state is the first thing they see. */}
      {activeBankConnections.length > 0 && (
        <div className="mb-7 bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800 rounded-xl p-5">
          <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                Bank connections
              </h2>
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
                Direct PSD2 feed via Aiia. Auto-syncs nightly.
              </p>
            </div>
            <Link
              to="/bank-import"
              className="text-xs text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 underline"
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
                  className="flex flex-wrap items-center gap-2 p-3 bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800"
                >
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                      {bankLabel}
                      {conn.sandbox_mode && (
                        <span className="ml-2 text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300">
                          Sandbox
                        </span>
                      )}
                    </div>
                    <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                      {conn.account_label || "Bank account"} · Last sync: {lastSyncedHuman}
                    </div>
                  </div>
                  <button
                    onClick={() => syncBankConnection(conn.id)}
                    disabled={busyConn === conn.id}
                    className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-50"
                  >
                    {busyConn === conn.id ? "Syncing…" : "Sync now"}
                  </button>
                  <button
                    onClick={() => disconnectBankConnection(conn.id)}
                    disabled={busyConn === conn.id}
                    className="text-xs text-gray-600 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 disabled:opacity-50"
                  >
                    Disconnect
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Terminals section (Task #238) — manual override surface for
          the POS auto-detect loop that ships via the Daily Close chip
          (Commit 2 + 3). Owners who want to fix a wrong provider link
          WITHOUT scanning a fresh kasserapport land here. One row per
          Terminal; Change ▾ exposes the 18-provider catalog; Unlink
          clears the link. Always rendered (even for single-terminal
          Free / Starter owners) — the section is informational.
          Brand names render verbatim per the DK terminology lock. */}
      {terminals !== null && (
        <div className="mb-7 bg-gray-50 dark:bg-gray-800/50 border border-gray-100 dark:border-gray-800 rounded-xl p-5">
          <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
            <div className="flex items-start gap-3">
              <div className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-800 flex items-center justify-center shrink-0 text-gray-700 dark:text-gray-300">
                <Icon name="Cpu" size={18} strokeWidth={1.75} />
              </div>
              <div>
                <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                  {t("connTerminalsTitle") || "Terminals"}
                </h2>
                <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5 max-w-xl">
                  {t("connTerminalsSubtitle") ||
                    "Link each physical POS station to its acquirer (Nets, Worldline, MobilePay, ...). BonBox auto-detects from your Z-report scan; tap Change to override."}
                </p>
              </div>
            </div>
            <Link
              to="/terminals"
              className="text-xs text-gray-700 hover:text-gray-900 dark:text-gray-300 dark:hover:text-gray-100 underline"
            >
              {t("connManage") || "Manage"}
            </Link>
          </div>

          {terminals.length === 0 ? (
            <div className="p-4 bg-white dark:bg-gray-900 rounded-lg border border-dashed border-gray-200 dark:border-gray-700 text-center">
              <p className="text-sm text-gray-600 dark:text-gray-400">
                {t("connTerminalsEmpty") ||
                  "No terminals yet. Add one in Settings → Terminals to get started."}
              </p>
            </div>
          ) : (
            <div className="space-y-2">
              {terminals.map((term) => {
                const isLinked = !!term.provider_id;
                const isOpen = openTerminalId === term.id;
                const isBusy = busyTerminalId === term.id;
                const branchName = (branches || []).find(
                  (b) => b.id === term.branch_id,
                )?.name || null;
                const isAutoDetected = isLinked && !term.provider_locked_by_owner;
                return (
                  <div
                    key={term.id}
                    className="p-3 bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800"
                  >
                    <div className="flex flex-wrap items-start gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                            {term.name || "—"}
                          </span>
                          {/* Provider chip — gray when linked (brand
                              name verbatim), amber when unlinked. The
                              "Auto-detected" hint sits next to the
                              chip so the owner sees the provenance
                              without opening the dropdown. */}
                          {isLinked ? (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-gray-100 dark:bg-gray-800 text-gray-700 dark:text-gray-300">
                              {term.provider_display_name || term.provider_slug || "—"}
                            </span>
                          ) : (
                            <span className="text-[10px] px-1.5 py-0.5 rounded font-semibold bg-amber-100 dark:bg-amber-900/40 text-amber-700 dark:text-amber-300">
                              {t("connTerminalsNotLinked") || "Not linked"}
                            </span>
                          )}
                          {isAutoDetected && (
                            <span className="text-[10px] text-gray-500 dark:text-gray-400 italic">
                              {t("connTerminalsAutoDetected") || "Auto-detected"}
                            </span>
                          )}
                          {isLinked && term.provider_locked_by_owner && (
                            <span className="text-[10px] text-emerald-700 dark:text-emerald-400">
                              {t("connTerminalsLockedByOwner") || "Confirmed"}
                            </span>
                          )}
                        </div>
                        {(term.receipt_label || branchName) && (
                          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 truncate">
                            {term.receipt_label && (
                              <>{t("connTerminalsReceiptLabel") || "Receipt label"}: {term.receipt_label}</>
                            )}
                            {term.receipt_label && branchName && " · "}
                            {branchName && (
                              <>{t("connTerminalsBranchLabel") || "Branch"}: {branchName}</>
                            )}
                          </div>
                        )}
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          onClick={() => isOpen ? setOpenTerminalId(null) : openTerminalDropdown(term.id)}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-50"
                        >
                          {isBusy
                            ? (t("connTerminalsSaving") || "Saving…")
                            : (t("connTerminalsChange") || "Change")}
                          <Icon name="ChevronDown" size={12} strokeWidth={2} />
                        </button>
                        {isLinked && (
                          <button
                            type="button"
                            onClick={() => unlinkTerminalProvider(term.id)}
                            disabled={isBusy}
                            className="text-xs text-gray-600 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 disabled:opacity-50"
                          >
                            {isBusy
                              ? (t("connTerminalsUnlinking") || "Unlinking…")
                              : (t("connTerminalsUnlink") || "Unlink")}
                          </button>
                        )}
                      </div>
                    </div>
                    {/* Dropdown — rendered inline below the row so the
                        18-provider list doesn't need a portal. Lazy-
                        loads catalog on first open per #238 spec. */}
                    {isOpen && (
                      <div className="mt-3 pt-3 border-t border-gray-100 dark:border-gray-800">
                        {catalogLoading && providerCatalog === null ? (
                          <div className="text-xs text-gray-500 dark:text-gray-400">
                            {t("connTerminalsSaving") || "Saving…"}
                          </div>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            <select
                              value={term.provider_id || ""}
                              onChange={(e) =>
                                linkTerminalProvider(term.id, e.target.value || null)
                              }
                              disabled={isBusy}
                              className="flex-1 min-w-0 text-xs px-2 py-1.5 rounded-lg bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-700 text-gray-900 dark:text-gray-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400 disabled:opacity-50"
                              aria-label={t("connTerminalsSelectPlaceholder") || "— Select provider —"}
                            >
                              <option value="">
                                {t("connTerminalsUnsetOption") || "(unset — clear link)"}
                              </option>
                              {(providerCatalog || []).map((p) => (
                                <option key={p.id} value={p.id}>
                                  {p.display_name}
                                </option>
                              ))}
                            </select>
                            <button
                              type="button"
                              onClick={() => setOpenTerminalId(null)}
                              className="text-xs text-gray-600 hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
                            >
                              {t("connTerminalsCancel") || "Cancel"}
                            </button>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* MobilePay Erhverv panel (Task #71) — mirrors the bank
          connections panel above. Shown when the user has an active
          (or expired) MobilePay connection, so the most actionable
          state is surfaced before the integration grid. */}
      {mpConnection?.status === "active" && (
        <div className="mb-7 bg-indigo-50 dark:bg-indigo-900/20 border border-indigo-200 dark:border-indigo-800 rounded-xl p-5">
          <div className="flex items-start justify-between mb-3 flex-wrap gap-2">
            <div>
              <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">
                {t("mpPanelTitle") || "MobilePay Erhverv"}
              </h2>
              <p className="text-xs text-gray-600 dark:text-gray-400 mt-0.5">
                {t("mpPanelSubtitle") ||
                  "Per-payment feed via Vipps MobilePay. Auto-syncs nightly."}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 p-3 bg-white dark:bg-gray-900 rounded-lg border border-gray-100 dark:border-gray-800">
            <div className="flex-1 min-w-0">
              <div className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
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
              <div className="text-xs text-gray-500 dark:text-gray-400 truncate">
                {(t("mpLastSynced") || "Last sync") + ": "}
                {mpConnection?.last_synced_at
                  ? new Date(mpConnection.last_synced_at).toLocaleString()
                  : (t("mpNeverSynced") || "Never synced")}
              </div>
            </div>
            <button
              onClick={syncMobilePay}
              disabled={mpBusy}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900 hover:bg-gray-700 dark:hover:bg-gray-200 disabled:opacity-50"
            >
              {mpBusy
                ? (t("mpSyncing") || "Syncing…")
                : (t("mpSyncNow") || "Sync now")}
            </button>
            <button
              onClick={disconnectMobilePay}
              disabled={mpBusy}
              className="text-xs text-gray-600 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400 disabled:opacity-50"
            >
              {t("mpDisconnect") || "Disconnect"}
            </button>
          </div>
        </div>
      )}

      {mpConnection?.status === "expired" && (
        <div className="mb-7 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-xl p-4 flex items-center justify-between gap-3 flex-wrap">
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
        {/* Bank reconciliation tile — Task #106: hide in prod when
            no real PSD2 provider configured. CSV import still works
            via /bank-import (we always show that page; just no
            "automatic connect" claim). Existing active connections
            stay visible even when the feature flag is off, so users
            who DID connect a real bank in the past still see it. */}
        {(bankConnectEnabled || activeBankConnections.length > 0) && (
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
              // Task #204 P2.10 — show the IBAN-honesty hint when the
              // owner has typed an IBAN into Profile but has NO active
              // BankConnection.  That's the case the old derivation
              // misrepresented as "Connected".  When a real connection
              // exists OR the IBAN field is empty, no hint is needed.
              !derived.hasActiveBank && derived.referenceIban
                ? (t("connBankIbanHint") ||
                    "We don't yet have direct access to this account.")
                : activeBankConnections.length === 0
                  ? (t("connBankAiia") || "Aiia direct connection available on /bank-import.")
                  : undefined
            }
          />
        )}

        {/* MobilePay Erhverv tile — Task #106: hide in prod when no
            real Vipps partnership is configured. Existing active
            connections stay visible (defensive — if you ever flip
            the feature back off, owners still see their already-
            linked MobilePay) but no new connect CTA is shown. */}
        {(mobilepayEnabled || mpConnection?.status === "active") && (
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
        )}

        {/* Receipt-forwarding inbox (v0.1) — custom card body because
            it shows the user's `<short>-<rnd>@in.bonbox.dk` alias as a
            monospace block with [Copy] + [Send test email] inline. Uses
            the `Card` primitive directly so it matches the visual
            rhythm (border, radius, padding) of the ConnectionCard tiles
            around it. Owner-only test button; non-owner sees a tooltip
            saying so. Backend re-checks ownership anyway. */}
        {inboxState && !inboxState._error && (
          (() => {
            const infraEnabled = !!inboxState.infra_enabled;
            const alias = inboxState.alias || "";
            const count = Number(inboxState.messages_this_month || 0);
            const cap = Number(inboxState.cap);
            const isUnlimited = cap < 0;
            const isOwner = (user?.role || "owner").toLowerCase() === "owner";
            // Status maps to the same dot palette as ConnectionCard.
            const statusDot = !infraEnabled
              ? "bg-amber-500"   // pending setup
              : alias
              ? "bg-emerald-500" // active
              : "bg-gray-400";  // active backend but no alias yet (fresh user)
            const statusLabel = !infraEnabled
              ? t("inboxStatusPending", "Pending setup · estimated <2 weeks")
              : isUnlimited
              ? t("inboxStatusActiveUnlimited", "Active · unlimited")
              : t("inboxStatusActiveOfCap", "Active · {n} of {cap} this month", { n: count, cap });
            return (
              <Card className="flex flex-col h-full">
                <div className="flex items-start gap-3 mb-3">
                  <div className="w-9 h-9 rounded-lg bg-gray-100 dark:bg-gray-800
                                  flex items-center justify-center shrink-0
                                  text-gray-700 dark:text-gray-300">
                    <Icon name="Mail" size={18} strokeWidth={1.75} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h3 className="text-[15px] font-semibold text-gray-900 dark:text-gray-100 tracking-tight">
                        {t("inboxCardTitle", "Receipt forwarding")}
                      </h3>
                    </div>
                    <div className="flex items-center gap-1.5 mt-1">
                      <span className={`w-1.5 h-1.5 rounded-full ${statusDot}`} aria-hidden="true" />
                      <span className="text-[11.5px] text-gray-500 dark:text-gray-400">
                        {statusLabel}
                      </span>
                    </div>
                  </div>
                </div>
                <p className="text-[13px] text-gray-600 dark:text-gray-300 leading-relaxed mb-3">
                  {infraEnabled
                    ? t(
                        "inboxCardDesc",
                        "Forward any receipt to your personal BonBox address. We OCR it, draft an Expense, and notify you — stored 5 years per Bogføringsloven §10 so your revisor has a complete audit trail.",
                      )
                    : t(
                        "inboxCardDescSoon",
                        "We're wiring up our inbound email provider. Forward any receipt to your personal address and BonBox drafts the Expense for you — stored 5 years per Bogføringsloven §10.",
                      )}
                </p>

                {/* Alias / preview block */}
                {infraEnabled && alias ? (
                  <div className="flex items-stretch gap-2 mb-3">
                    <code className="flex-1 min-w-0 truncate font-mono text-[12.5px]
                                     px-2.5 py-2 rounded-lg bg-gray-100 dark:bg-gray-800
                                     border border-gray-200 dark:border-gray-700
                                     text-gray-900 dark:text-gray-100 select-all">
                      {alias}
                    </code>
                    <button
                      type="button"
                      onClick={copyInboxAlias}
                      aria-label={inboxCopied
                        ? t("inboxCopied", "Copied!")
                        : t("inboxCopyAria", "Copy receipt inbox address")}
                      className="inline-flex items-center justify-center gap-1 min-h-[40px] px-3
                                 rounded-lg text-[12px] font-semibold
                                 bg-gray-900 text-white dark:bg-gray-100 dark:text-gray-900
                                 hover:bg-gray-700 dark:hover:bg-gray-200 transition
                                 focus-visible:outline-none focus-visible:ring-2
                                 focus-visible:ring-gray-400"
                    >
                      {inboxCopied
                        ? <><Icon name="Check" size={14} /> {t("inboxCopied", "Copied!")}</>
                        : <><Icon name="Copy" size={14} /> {t("inboxCopy", "Copy")}</>}
                    </button>
                  </div>
                ) : (
                  <div className="mb-3">
                    <code className="inline-block font-mono text-[12.5px] px-2.5 py-1.5
                                     rounded-lg bg-gray-100/70 dark:bg-gray-800/60
                                     border border-dashed border-gray-300 dark:border-gray-700
                                     text-gray-500 dark:text-gray-400 italic">
                      {t("inboxAliasPreview", "sudip-xyz@in.bonbox.dk")}
                    </code>
                  </div>
                )}

                <div className="mt-auto flex items-center gap-2">
                  {infraEnabled ? (
                    <button
                      type="button"
                      onClick={sendInboxTest}
                      disabled={!isOwner || inboxTesting}
                      title={!isOwner
                        ? t("inboxTestOwnerOnly", "Owner-only — ask the account owner to send a test.")
                        : undefined}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold
                                 bg-gray-900 dark:bg-gray-100 text-white dark:text-gray-900
                                 hover:bg-gray-700 dark:hover:bg-gray-200
                                 disabled:opacity-50 disabled:cursor-not-allowed
                                 transition focus-visible:outline-none focus-visible:ring-2
                                 focus-visible:ring-gray-400 focus-visible:ring-offset-2
                                 focus-visible:ring-offset-white dark:focus-visible:ring-offset-stone-900"
                    >
                      {inboxTesting
                        ? <><Icon name="Loader" className="w-3.5 h-3.5 animate-spin" /> {t("inboxSendingTest", "Sending…")}</>
                        : <><Icon name="Send" size={14} /> {t("inboxSendTest", "Send test email")}</>}
                    </button>
                  ) : (
                    <span className="text-[11.5px] text-gray-500 dark:text-gray-400 italic">
                      {t("inboxComingSoonNote", "We'll email you the day your inbox goes live.")}
                    </span>
                  )}
                </div>
              </Card>
            );
          })()
        )}

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
      <p className="mt-10 text-center text-[12px] text-gray-500 dark:text-gray-400 leading-relaxed max-w-2xl mx-auto">
        {t("connectionsFooter") ||
          "We deliberately don't connect to your POS — Lightspeed, Toast, Square keep that role. BonBox sits beside them and reads your sales register via daily sync. Same with payment terminals: keep your Dankort + iZettle, BonBox imports the daily totals."}
      </p>
    </div>
  );
}
