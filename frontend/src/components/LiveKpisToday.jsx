import { useEffect, useMemo, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { localIso } from "../utils/dateFormat";
import { formatMoney } from "../utils/currency";
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
  // CRIT-fix (Report Coherence audit #148): cutoff USED to be hardcoded
  // to 6 here while DailyClosePage (rendered on the same /daily-close
  // route) read the value from BusinessProfile.day_cutoff_hour. If an
  // owner had configured a different cutoff (e.g. 4am for a bakery),
  // the two surfaces on the same page would disagree about whether a
  // 05:00 sale counts toward today or yesterday. Now we fetch the
  // owner-configured cutoff from BusinessProfile and fall back to 6
  // (the Danish restaurant convention) only when the profile lookup
  // fails — same fallback the backend helper uses, so a missing profile
  // never produces drift between client and server.
  const FALLBACK_CUTOFF_HOUR = 6;
  const [cutoffHour, setCutoffHour] = useState(null);

  const [report, setReport] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  // Fetch the owner-configured cutoff once on mount. Defer the
  // property-report fetch until we know what cutoff to ask for — if we
  // pre-fetch with 6 and the profile says 4, we'd briefly render the
  // wrong numbers and then snap to the right ones, which is exactly the
  // drift this audit is trying to eliminate.
  useEffect(() => {
    let cancelled = false;
    api
      .get("/business")
      .then((r) => {
        if (cancelled) return;
        const raw = r?.data?.day_cutoff_hour;
        const num = Number(raw);
        // Treat null / undefined / NaN as "no preference saved" and
        // fall back to the convention. Clamp to [0, 23] defensively —
        // a corrupted DB row should never let LiveKpisToday explode.
        if (!Number.isFinite(num)) {
          setCutoffHour(FALLBACK_CUTOFF_HOUR);
        } else {
          setCutoffHour(Math.min(23, Math.max(0, Math.trunc(num))));
        }
      })
      .catch((e) => {
        if (cancelled) return;
        // L8 — multi-source fallback. Profile fetch failure is non-fatal
        // here; we just degrade to the convention and surface a soft
        // warning in the console so this regression is loud during dev
        // without breaking the owner's view of the shift.
        // eslint-disable-next-line no-console
        console.warn("LiveKpisToday: BusinessProfile fetch failed, using cutoff=6 fallback", e);
        setCutoffHour(FALLBACK_CUTOFF_HOUR);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (cutoffHour === null) return;  // wait for cutoff resolution
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
  }, [todayStr, cutoffHour]);

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

  // Money values go through `formatMoney` so a DK owner sees "15.000 DKK"
  // regardless of their browser's default locale. The previous
  // `Number(n).toLocaleString()` rendered "15,000 DKK" on EN-locale
  // browsers (Vercel preview / TestFlight builds), which drifted from
  // every other money cell in the app (#148 MEDIUM-12). Counts (orders,
  // guests) keep `toLocaleString` but pin to da-DK when the currency is
  // DKK so the grouping separator matches the money values.
  const moneyFmt = (n) => formatMoney(n || 0, currency, { decimals: 0 });
  const countLocale = currency === "DKK" ? "da-DK" : undefined;
  const countFmt = (n) => Number(n || 0).toLocaleString(countLocale);

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
          // `moneyFmt` returns the value with the currency code appended
          // (e.g. "15.000 DKK"), so we don't append `currency` separately.
          value={moneyFmt(revenue)}
          helper={isEmpty ? (t("liveNoDataYet") || "No sales yet today") : null}
        />
        <StatCard
          label={t("liveOrdersToday") || "Orders"}
          value={countFmt(orders)}
          helper={
            orders > 0
              ? `${t("liveSinceCutoff") || "since"} ${String(
                  cutoffHour ?? FALLBACK_CUTOFF_HOUR
                ).padStart(2, "0")}:00`
              : null
          }
        />
        <StatCard
          label={t("liveGuestsToday") || "Guests"}
          value={countFmt(guests)}
          helper={guests > 0 && orders > 0
            ? `${(guests / Math.max(orders, 1)).toFixed(1)} ${t("liveAvgPerOrder") || "avg / order"}`
            : null}
        />
        <StatCard
          label={t("liveTopPayment") || "Top payment"}
          value={dominantTender ? moneyFmt(dominantTender.amount) : "—"}
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
