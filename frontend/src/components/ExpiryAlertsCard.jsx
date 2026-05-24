/**
 * ExpiryAlertsCard — Dashboard interrupt card for items expiring soon.
 *
 * Tier-gate: Starter+ only. Self-hides when:
 *   • The user lacks the `expiry_alerts` entitlement (Free tier).
 *   • The API responds with no items in the ≤3-day window.
 *   • The API errors (silent fail per Dashboard interrupt-card doctrine).
 *
 * Defense:
 *   • Backend strips waste-cost server-side for Free users, but this
 *     card never renders on Free anyway (the hasFeature gate).
 *   • Numbers run through Number() with a safe fallback.
 *   • Self-hides on 404 / 503 / network — owner sees nothing rather
 *     than a broken card (same pattern as MomsCountdownCard).
 */
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { Icon } from "./ui";
import { useEntitlements } from "../hooks/useEntitlements";
import { useLanguage } from "../hooks/useLanguage";

function fmtAmount(n, currency = "DKK") {
  if (n == null || Number.isNaN(Number(n))) return "—";
  return `${Number(n).toLocaleString("da-DK", { maximumFractionDigits: 0 })} ${currency}`;
}

export default function ExpiryAlertsCard() {
  const { t } = useLanguage();
  const { hasFeature } = useEntitlements();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);

  // L2 — pre-flight feature check. If the user doesn't have the
  // entitlement we don't even fetch.
  const featureAvailable = hasFeature("expiry_alerts");

  useEffect(() => {
    if (!featureAvailable) {
      setLoading(false);
      return;
    }
    let alive = true;
    api
      .get("/expiry/upcoming", { params: { days: 3 } })
      .then((r) => { if (alive) setData(r.data); })
      .catch(() => { if (alive) setData(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [featureAvailable]);

  // Loading + locked + no-data — all self-hide. The Dashboard pattern
  // is "the card is invisible unless it has something urgent to say".
  if (loading || !featureAvailable) return null;
  const items = data?.items || [];
  if (!items.length) return null;

  // Bucket into "today" + "soon"
  const today = items.filter((i) => (i?.days_left ?? 99) <= 0);
  const soon = items.filter((i) => (i?.days_left ?? 99) > 0);
  const cost = Number(data?.total_at_risk_dkk || 0);

  // Tier-true urgency tones (mirrors MomsCountdownCard palette so the
  // dashboard feels coherent).
  const hasToday = today.length > 0;
  const tone = hasToday
    ? "bg-red-50 dark:bg-red-900/15"
    : "bg-amber-50 dark:bg-amber-900/15";
  const toneText = hasToday
    ? "text-red-700 dark:text-red-300"
    : "text-amber-700 dark:text-amber-300";
  const toneRing = hasToday
    ? "ring-red-200 dark:ring-red-800/40"
    : "ring-amber-200 dark:ring-amber-800/40";

  // Headline framing — "today" wins when present, otherwise "within 3 days"
  const headline = hasToday
    ? t("expiryHeadlineToday", "{n} items expire today").replace("{n}", String(today.length))
    : t("expiryHeadlineSoon", "{n} items expire within 3 days").replace("{n}", String(items.length));

  // Top 3 names for the preview row — keeps the card scannable
  const preview = items.slice(0, 3).map((i) => i.name).filter(Boolean).join(", ");

  return (
    <Link
      to="/expiry"
      className={`block rounded-xl ring-1 ${toneRing} ${tone} p-5 hover:shadow-sm transition-shadow`}
      aria-label={t("expiryCardAria", "Open expiry alerts")}
    >
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 mb-1.5">
            <Icon name="AlarmClock" size={16} className={toneText} />
            <span className={`text-[11px] font-semibold uppercase tracking-wider ${toneText}`}>
              {t("expiryEyebrow", "Expiry alert")}
            </span>
          </div>
          <div className="text-2xl font-bold text-stone-900 dark:text-stone-100 leading-tight">
            {headline}
          </div>
          {cost > 0 && (
            <div className="mt-1 text-sm text-stone-600 dark:text-stone-300">
              <span className="font-semibold text-stone-900 dark:text-stone-100">
                {fmtAmount(cost, "DKK")}
              </span>{" "}
              <span className="text-stone-500 dark:text-stone-400">
                {t("expiryAtRisk", "at risk")}
              </span>
            </div>
          )}
          {preview && (
            <div className="mt-2 text-xs text-stone-500 dark:text-stone-400 truncate">
              {preview}
              {items.length > 3 ? ` +${items.length - 3}` : ""}
            </div>
          )}
          {hasToday && soon.length > 0 && (
            <div className="mt-1 text-xs text-stone-500 dark:text-stone-400">
              {t("expiryAndSoon", "{n} more within 3 days").replace("{n}", String(soon.length))}
            </div>
          )}
        </div>
        <Icon name="ChevronDown" size={18} className="-rotate-90 text-stone-400 shrink-0 mt-1" />
      </div>
    </Link>
  );
}
