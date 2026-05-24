import { useEffect, useMemo, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { localIso } from "../utils/dateFormat";
import { StatCard, SectionBanner } from "./ui";

/**
 * LiveKpisToday — the live operational snapshot that used to live on
 * "Today's Floor" (`/daily-report`). Extracted into a reusable
 * component so the merged "Today" page (`/daily-close`) can render
 * it at the top of the page while the legacy `/daily-report` route
 * keeps the same data visible during the redirect grace period.
 *
 * The component fetches `/property-report?date=…&day_cutoff_hour=6`
 * — identical backend call to the old page — and exposes the four
 * numbers the owner scans during the shift:
 *
 *   1. Total revenue so far
 *   2. Orders (checks) so far
 *   3. Guests so far
 *   4. Dominant payment method (the one with the biggest amount)
 *
 * Multi-barrier doctrine applied here:
 *   L1 — DNA-compliant primitives (StatCard, SectionBanner). No
 *        bespoke gradients / fonts / borders. Same calm look the
 *        rest of the page uses.
 *   L6 — Fail-closed defaults. If the API returns nothing, we
 *        render zeros in a neutral state. Owner sees a clean
 *        empty page rather than a broken one.
 *   L8 — Multi-source fallback. If the call errors, we surface a
 *        "Live data unavailable" SectionBanner — the rest of the
 *        merged page (close wizard, history) still renders cleanly
 *        because this is a self-contained subtree.
 *   L9 — Mobile-first 2-col grid (sm: 4-col on tablets +). Matches
 *        the StatCard rows on Dashboard so the visual language is
 *        consistent across the app.
 */
export default function LiveKpisToday() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const currency = user?.currency || "DKK";

  // localIso (not toISOString) so a Danish owner closing at 01:14 CEST
  // doesn't accidentally see yesterday's data labelled "today".
  const todayStr = localIso();
  // Default cutoff hour mirrors PropertyReport — 6am restaurant convention
  // (so a late-night service that ends at 02:30 still counts as TODAY's
  // shift). Stays at 6 for v1; we can expose the toggle in a later pass
  // if owners ask for it.
  const cutoffHour = 6;

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    api
      .get("/property-report", {
        params: { date: todayStr, day_cutoff_hour: cutoffHour },
      })
      .then((r) => {
        if (cancelled) return;
        setReport(r.data || null);
        if (r.data?._error) setError(r.data._error);
      })
      .catch(() => {
        if (cancelled) return;
        // L8 — keep the rest of the page alive; surface a soft error
        // banner instead of a blank component.
        setError(t("liveKpisUnavailable") || "Live data unavailable — refresh to retry.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [todayStr]);

  const totals = report?.totals || {};
  const channels = report?.order_channels || [];
  const tenders = report?.tender_media || [];

  const orders = useMemo(() => channels.reduce((s, c) => s + (c.checks || 0), 0), [channels]);
  const guests = useMemo(() => channels.reduce((s, c) => s + (c.guests || 0), 0), [channels]);

  // Dominant payment method = the tender with the highest amount.
  // Fall back to "—" when the day hasn't started yet. We only show
  // the label (already localized by the backend) — the StatCard
  // value slot is the right place for the visible number, so we
  // put the amount there and the method name in the helper text.
  const dominantTender = useMemo(() => {
    if (!tenders.length) return null;
    return [...tenders].sort((a, b) => (b.amount || 0) - (a.amount || 0))[0];
  }, [tenders]);

  const fmt = (n) => Number(n || 0).toLocaleString();

  // Loading skeleton — shows the layout immediately so the page
  // doesn't reflow when data arrives. Mobile-first 2-col grid.
  if (loading) {
    return (
      <section aria-busy="true" aria-label={t("liveKpisLabel") || "Live KPIs today"}>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {[0, 1, 2, 3].map((i) => (
            <div
              key={i}
              className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 px-4 py-3.5 animate-pulse"
            >
              <div className="h-2.5 w-20 bg-gray-200 dark:bg-gray-700 rounded mb-2" />
              <div className="h-6 w-24 bg-gray-200 dark:bg-gray-700 rounded" />
            </div>
          ))}
        </div>
      </section>
    );
  }

  // L8 — error placeholder. Keeps the rest of the page alive.
  if (error && !report) {
    return (
      <SectionBanner severity="warn" title={t("liveKpisUnavailable") || "Live data unavailable"}>
        <p>{t("liveKpisUnavailableHint") || "Refresh the page to retry. The close wizard below still works."}</p>
      </SectionBanner>
    );
  }

  const revenue = totals.total_revenue || 0;
  const isEmpty = revenue === 0 && orders === 0;

  return (
    <section aria-label={t("liveKpisLabel") || "Live KPIs today"} className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <StatCard
          label={t("liveRevenueToday") || "Revenue so far"}
          value={`${fmt(revenue)} ${currency}`}
          helper={isEmpty ? (t("liveNoDataYet") || "No sales yet today") : null}
        />
        <StatCard
          label={t("liveOrdersToday") || "Orders"}
          value={fmt(orders)}
          helper={orders > 0 ? `${t("liveSinceCutoff") || "since"} 06:00` : null}
        />
        <StatCard
          label={t("liveGuestsToday") || "Guests"}
          value={fmt(guests)}
          helper={guests > 0 && orders > 0
            ? `${(guests / Math.max(orders, 1)).toFixed(1)} ${t("liveAvgPerOrder") || "avg / order"}`
            : null}
        />
        <StatCard
          label={t("liveTopPayment") || "Top payment"}
          value={dominantTender ? fmt(dominantTender.amount) : "—"}
          helper={dominantTender ? dominantTender.label : (t("liveNoPaymentsYet") || "—")}
        />
      </div>

      {/* Inline soft error — keep the cards visible but tell the truth.
          Happens when the backend returned a payload but with _error set
          (degraded mode). */}
      {error && report && (
        <p className="text-xs text-amber-700 dark:text-amber-300">{error}</p>
      )}
    </section>
  );
}
