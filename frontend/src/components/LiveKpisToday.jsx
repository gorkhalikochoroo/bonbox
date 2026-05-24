import { useEffect, useMemo, useRef, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { localIso } from "../utils/dateFormat";
import { formatMoney } from "../utils/currency";
import { StatCard, SectionBanner } from "./ui";

// Auto-refresh interval for the live KPI tiles. 5s is the sweet spot
// for a busy shift — fast enough that the owner feels the numbers
// move during a service rush, slow enough not to thrash the backend
// or the browser's tab. Polling pauses while the document is hidden
// (see visibilitychange listener) so a phone in someone's pocket
// doesn't pin the CPU and drain the battery.
const REFRESH_MS = 5000;

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
 *
 * Optional `eventId` prop (migration 013 — kulturarrangør sprint):
 *   When set, scopes the underlying fetch to sales tagged for this
 *   cultural event. EventsPage uses this to render the same KPI row
 *   at the top of an event detail view so the owner gets the same
 *   visual language whether they're scanning today's shift or a past
 *   event recap. Passing null / undefined keeps the legacy behaviour
 *   (full tenant view). Agent X owns the auto-refresh polling; this
 *   prop only adds the query-param plumbing.
 */
export default function LiveKpisToday({ eventId = null } = {}) {
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
  // Tracks the timestamp of the most recent successful fetch — fed into
  // the muted "updated Ns ago" hint. `Date.now()`-style number, not a
  // Date object, so the formatter is a single subtraction.
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  // Re-render driver for the "Ns ago" hint. Stored as a counter (not a
  // timestamp) because we only need to trigger React reconciliation —
  // the actual age is computed off `lastUpdatedAt`.
  const [, setAgeTick] = useState(0);

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

  // ─── Polling auto-refresh ──────────────────────────────────────────
  // The fetch logic lives inside the effect (not a hoisted callback)
  // because the deps drive everything we care about: cutoffHour, the
  // date string, and the polling guard. A ref tracks the "live" cancel
  // flag for any in-flight request so a tab-hidden event can short-
  // circuit a fetch that's already on the wire.
  const inflightRef = useRef({ cancelled: false });

  useEffect(() => {
    if (cutoffHour === null) return;  // wait for cutoff resolution

    // First-paint flag: show the skeleton only on the very first
    // fetch. Subsequent silent refreshes must NOT flash the skeleton
    // — that would look like the page is broken during a service rush.
    let isFirstFetch = report === null;

    const runFetch = async () => {
      // If the tab is hidden, skip the network call entirely. The
      // visibility listener (below) will trigger a fresh fetch on
      // resume, so we won't be stuck with stale numbers.
      if (typeof document !== "undefined" && document.hidden) return;

      // Mark a fresh in-flight request — previous one (if any) is
      // dropped via its closed-over `localCancelled` token.
      const token = inflightRef.current = { cancelled: false };
      if (isFirstFetch) {
        setLoading(true);
        setError("");
      }
      try {
        // event_id (migration 013 — kulturarrangør sprint) is only sent
        // when an EventsPage caller passes it down. Legacy callers
        // (DailyClosePage) keep the same unscoped query they always
        // sent — adding the key only when truthy.
        const params = { date: todayStr, day_cutoff_hour: cutoffHour };
        if (eventId) params.event_id = eventId;
        const r = await api.get("/property-report", { params });
        if (token.cancelled) return;
        setReport(r.data || null);
        setLastUpdatedAt(Date.now());
        // A server-soft-error (_error in payload) is informational
        // — keep the report, surface the message in a thin amber row.
        if (r.data?._error) setError(r.data._error);
        else setError("");
      } catch {
        if (token.cancelled) return;
        // L8 — keep the rest of the page alive; surface a soft error
        // banner instead of a blank component. Only show this on the
        // first failure; silent polling failures stay quiet so the
        // owner doesn't see a flickering error during a brief blip.
        if (isFirstFetch) {
          setError(t("liveKpisUnavailable") || "Live data unavailable — refresh to retry.");
        }
      } finally {
        if (!token.cancelled && isFirstFetch) setLoading(false);
        isFirstFetch = false;
      }
    };

    // Kick off the first fetch immediately, then start the 5s poll.
    runFetch();
    const intervalId = setInterval(runFetch, REFRESH_MS);

    // Pause polling when the tab is hidden, resume + refresh on show.
    // Listening to `visibilitychange` rather than `focus`/`blur` so a
    // background tab that the OS hasn't unfocused (but DID hide) also
    // pauses — matters on iOS Safari where the tab can be visible
    // but the page hidden during the Home Indicator drag.
    const handleVisibility = () => {
      if (typeof document === "undefined") return;
      if (!document.hidden) {
        // Snap-refresh on resume so the owner sees the catch-up
        // numbers immediately instead of waiting up to 5s.
        runFetch();
      }
    };
    if (typeof document !== "undefined") {
      document.addEventListener("visibilitychange", handleVisibility);
    }

    return () => {
      inflightRef.current.cancelled = true;
      clearInterval(intervalId);
      if (typeof document !== "undefined") {
        document.removeEventListener("visibilitychange", handleVisibility);
      }
    };
    // `report` intentionally NOT in deps — its initial-null check is
    // captured in `isFirstFetch` at effect start, and re-running this
    // effect on every fetch would tear down and re-create the
    // interval, breaking the 5s cadence. eventId IS in deps so an
    // EventsPage caller switching events resets the polling cleanly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todayStr, cutoffHour, eventId]);

  // Tick the "Ns ago" hint every second so the number visibly counts
  // up between polls. Independent from the fetch interval — no
  // network impact, just a re-render.
  useEffect(() => {
    if (lastUpdatedAt === null) return;
    const id = setInterval(() => setAgeTick((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [lastUpdatedAt]);

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

  // "Updated Ns ago" — subtle muted hint so the owner knows the
  // numbers are live but doesn't see a noisy spinner during a service
  // rush. Computed once per render off the age tick interval (1s).
  // Stays empty until the first successful fetch lands.
  const ageSeconds = lastUpdatedAt
    ? Math.max(0, Math.floor((Date.now() - lastUpdatedAt) / 1000))
    : null;

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

      {/* Subtle "last updated Ns ago" hint — muted text under the tiles
          so the owner knows the numbers are auto-refreshing without a
          jarring spinner. Hidden until the first poll lands.
          Ephemeral status text, not user-content — left untranslated
          to keep the i18n-keys-allowlist for this sprint tight (only
          quickSale.* exempt keys + dailyClose.salgUdenMomsToday). */}
      {ageSeconds !== null && (
        <p className="text-xs text-gray-400 dark:text-gray-500" aria-live="polite">
          {ageSeconds < 5 ? "Updated just now" : `Updated ${ageSeconds}s ago`}
        </p>
      )}

      {/* Inline soft error — keep the cards visible but tell the truth.
          Happens when the backend returned a payload but with _error set
          (degraded mode). */}
      {error && report && (
        <p className="text-xs text-amber-700 dark:text-amber-300">{error}</p>
      )}
    </section>
  );
}
