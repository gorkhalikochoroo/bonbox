/**
 * BankConsentExpiryBanner — task #104/PSD2.
 *
 * DK PSD2 / SCA mandates that a bank-account-data consent expires every
 * 180 days (we conservatively use 90d per current SCA window — re-negotiated
 * upstream as the consent agreement TTL).  When a connection is within
 * 14 days of expiry, this banner appears at the top of /dashboard with a
 * single "Reconnect" action that walks the owner through MitID again
 * WITHOUT losing the connection row's history (the /reconnect endpoint
 * reuses the same bank_connections.id).
 *
 * Behavior:
 *   • Polls /bank-connections once on mount (no auto-refresh — Dashboard
 *     reloads remount the component so we get a fresh read on navigation)
 *   • Shows ONE banner per expiring connection — the soonest first
 *   • Dismissible per-connection-id + per-day in localStorage so the
 *     owner isn't nagged every minute, but it WILL come back tomorrow
 *     until they reconnect
 *   • Mobile-first: stacks the action button under the message below 640px
 *
 * Multi-barrier hygiene:
 *   • Fail-soft: if /bank-connections 5xxs we render nothing (the owner
 *     gets nagged by the connections page itself, not the dashboard)
 *   • Tier-aware: Free users never see this — bank_auto_reconcile is
 *     Starter+, and the only way a Free user has a connection row is
 *     post-downgrade (they keep it for cleanup but the banner would be
 *     confusing)
 *   • No secrets ever fetched — list endpoint already scrubs tokens
 *
 * Doctrine compliance:
 *   • <Button variant="primary"> (gray-900) — no rainbow gradients
 *   • Lucide Icon (Clock + AlertTriangle) — no emoji
 *   • rounded-xl surface — matches other top-of-dashboard banners
 *
 * Mobile: tested at iPhone SE 375px width — action button drops below
 * the message on narrow screens.
 */
import { useEffect, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { Button, Icon } from "./ui";

const DISMISS_PREFIX = "bonbox_bank_expiry_dismissed_";
const WARNING_WINDOW_DAYS = 14;

function daysUntil(iso) {
  if (!iso) return null;
  const expiry = new Date(iso);
  if (isNaN(expiry.getTime())) return null;
  const ms = expiry.getTime() - Date.now();
  return Math.ceil(ms / 86400000);
}

function todayKey() {
  // YYYY-MM-DD in user's locale — used for per-day dismiss key.  We
  // intentionally use local rather than UTC: a user dismissing at
  // 23:50 then seeing the banner at 00:10 would be confusing.
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export default function BankConsentExpiryBanner() {
  const { t } = useLanguage();
  const [connection, setConnection] = useState(null);
  const [dismissed, setDismissed] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    let alive = true;
    // _noRetry: this is a soft signal — don't block the dashboard on it.
    api.get("/bank-connections", { _noRetry: true })
      .then((res) => {
        if (!alive) return;
        const rows = Array.isArray(res?.data) ? res.data : [];
        // Find the most urgent active row that's expiring inside the
        // warning window.  Status must be 'active' — already-expired
        // rows surface via a different (more urgent) banner.
        let soonest = null;
        let soonestDays = Infinity;
        for (const r of rows) {
          if (r.status !== "active") continue;
          const d = daysUntil(r.consent_expires_at);
          if (d === null) continue;
          if (d <= WARNING_WINDOW_DAYS && d >= 0 && d < soonestDays) {
            soonest = r;
            soonestDays = d;
          }
        }
        if (soonest) {
          // Check per-conn per-day dismissed flag
          try {
            const key = `${DISMISS_PREFIX}${soonest.id}_${todayKey()}`;
            if (localStorage.getItem(key) === "1") {
              setDismissed(true);
              return;
            }
          } catch {
            // localStorage unavailable — show the banner anyway
          }
          setConnection({ ...soonest, _days_until: soonestDays });
        }
      })
      .catch(() => {
        // Fail-soft.  /bank-connections 5xx → nothing surfaces here.
        if (alive) setConnection(null);
      });
    return () => { alive = false; };
  }, []);

  const onDismiss = () => {
    if (!connection) return;
    try {
      localStorage.setItem(
        `${DISMISS_PREFIX}${connection.id}_${todayKey()}`,
        "1",
      );
    } catch {
      // ignore — best-effort dismiss
    }
    setDismissed(true);
  };

  const onReconnect = async () => {
    if (!connection || reconnecting) return;
    setReconnecting(true);
    setError("");
    try {
      const res = await api.post(`/bank-connections/${connection.id}/reconnect`);
      const consentUrl = res?.data?.consent_url;
      if (!consentUrl) throw new Error("Backend did not return a consent_url");
      // Full top-level redirect — the bank's SCA flow doesn't accept
      // an XHR follow (matches the existing /bank-connect/init pattern
      // in BankImportPage.jsx).
      window.location.assign(consentUrl);
    } catch (err) {
      setError(
        err?.response?.data?.detail?.message
        || err?.response?.data?.detail
        || err?.message
        || "Couldn't start reconnect — please try again from /connections",
      );
      setReconnecting(false);
    }
  };

  if (!connection || dismissed) return null;

  const days = connection._days_until;
  const bankLabel = connection.account_label
    || connection.bank_slug
    || "your bank";

  // Visual urgency: <=3 days is red, otherwise amber.  Doctrine-safe
  // single-accent palette — no rainbow.
  const urgent = days <= 3;
  const surface = urgent
    ? "bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800/60"
    : "bg-amber-50 dark:bg-amber-900/20 border-amber-200 dark:border-amber-800/60";
  const iconColor = urgent
    ? "text-red-600 dark:text-red-400"
    : "text-amber-600 dark:text-amber-400";

  const message = days === 0
    ? (t("bankExpiryToday") || `Your bank connection to ${bankLabel} expires today. Reconnect to keep syncing.`)
    : days === 1
    ? (t("bankExpiryTomorrow") || `Your bank connection to ${bankLabel} expires tomorrow. Reconnect now to avoid a gap.`)
    : (t("bankExpiryDays") || `Your bank connection to ${bankLabel} expires in ${days} days. Reconnect to keep auto-sync running.`);

  return (
    <div
      className={`rounded-xl border px-4 py-3 ${surface}`}
      role="alert"
      aria-live="polite"
    >
      <div className="flex flex-col sm:flex-row sm:items-center gap-3">
        <div className="flex items-start gap-3 flex-1 min-w-0">
          <Icon
            name={urgent ? "AlertTriangle" : "Clock"}
            size={20}
            className={`${iconColor} shrink-0 mt-0.5`}
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-gray-900 dark:text-gray-100">
              {message}
            </p>
            {error && (
              <p className="text-xs text-red-600 dark:text-red-400 mt-1">
                {error}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="primary"
            size="sm"
            onClick={onReconnect}
            busy={reconnecting}
            iconLeft={<Icon name="RotateCw" size={14} className="text-white dark:text-gray-900" />}
          >
            {reconnecting
              ? (t("bankExpiryReconnecting") || "Opening bank…")
              : (t("bankExpiryReconnect") || "Reconnect")}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onDismiss}
            aria-label="Dismiss for today"
          >
            {t("notNow") || "Not now"}
          </Button>
        </div>
      </div>
    </div>
  );
}
