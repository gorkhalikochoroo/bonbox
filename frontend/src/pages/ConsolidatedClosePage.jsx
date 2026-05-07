import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useEntitlements } from "../hooks/useEntitlements";
import { FadeIn } from "../components/AnimationKit";

/**
 * Consolidated close — multi-branch daily-close roll-up. Pro+ only.
 *
 * Surfaces the backend service shipped in cbde6db:
 *   POST /api/branches/consolidated-close { date, branch_ids? }
 *
 * The whole point of this page is to make the marketing claim
 * "Cross-outlet daily close consolidation" something the user actually
 * does — pick a date, see all your branches' closes summed in one
 * panel, ready to forward to the revisor.
 *
 * Render rules:
 *   • Free / Starter: shows a Pro-feature gate (the backend already
 *     enforces 403; we render politely instead of letting the request
 *     blow up)
 *   • Pro / trial / business: full consolidator UI
 *
 * Design: Copenhagen-clean, no aggressive colors. Per-branch rows are
 * neutral; cash-diff column tints amber/green like the multi-terminal
 * close PDF. Totals row is bold + sits below the branch list, mirroring
 * the kasserapport visual hierarchy owners already know.
 */
export default function ConsolidatedClosePage() {
  const { t } = useLanguage();
  // Tier gating now goes through the unified entitlements hook — the
  // backend feature flag "multi_branch_dashboard" is the single source
  // of truth (Pro/trial/business have it, Free/Starter don't). Old
  // hard-coded plan-string check ["pro","trial","business"] removed.
  const ent = useEntitlements();
  const [date, setDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  // Currency still comes from /billing/me (entitlements payload doesn't
  // include it — locale data, not entitlement data).
  const [currency, setCurrency] = useState("DKK");

  useEffect(() => {
    api.get("/billing/me")
      .then((res) => setCurrency(res.data?.currency || "DKK"))
      .catch(() => {});
  }, []);

  const isPro = ent.loading ? null : ent.hasFeature("multi_branch_dashboard");

  async function fetchConsolidated() {
    setLoading(true);
    setError("");
    setResult(null);
    try {
      const res = await api.post("/branches/consolidated-close", {
        date,
        branch_ids: null, // null = all owned branches with a close on that date
      });
      setResult(res.data);
    } catch (err) {
      const detail = err?.response?.data?.detail;
      const status = err?.response?.status;
      // Backend now uses 402 (Payment Required) for tier-locked features
      // — see services/billing.py enforce_feature(). Older 403s still
      // possible during the rollout window so handle both.
      if (status === 402 || status === 403) {
        // detail can be a structured object {error, feature, upgrade_to}
        // from the new layer, or a plain string from older code paths.
        const msg = typeof detail === "string"
          ? detail
          : (t("consolidatedNotPro") || "Cross-outlet consolidation requires Pro.");
        setError(msg);
      } else {
        const msg = typeof detail === "string" ? detail : null;
        setError(msg || t("consolidatedLoadFailed") || "Could not load consolidated close.");
      }
    } finally {
      setLoading(false);
    }
  }

  if (isPro === null) {
    return (
      <div className="px-4 sm:px-6 py-6 max-w-4xl mx-auto">
        <div className="text-sm text-gray-500 dark:text-gray-400">
          {t("loading") || "Loading…"}
        </div>
      </div>
    );
  }

  // Free / Starter — render the polite gate
  if (isPro === false) {
    return (
      <div className="px-4 sm:px-6 py-6 max-w-3xl mx-auto">
        <FadeIn>
          <div className="mb-2">
            <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
              🏢 {t("consolidatedTitle") || "Consolidated daily close"}
            </h1>
            <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-xl">
              {t("consolidatedSubtitle") ||
                "Roll up daily closes from all your branches into one report. Send the consolidated PDF to the owner or revisor in one tap."}
            </p>
          </div>
        </FadeIn>

        <FadeIn delay={0.05}>
          <div className="mt-6 rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60 p-6 sm:p-8">
            <div className="flex items-start gap-4">
              <div className="text-3xl shrink-0">🔒</div>
              <div className="flex-1">
                <h2 className="text-base font-bold text-gray-900 dark:text-white">
                  {t("consolidatedProGateTitle") || "A Pro feature"}
                </h2>
                <p className="text-[13px] text-gray-600 dark:text-gray-300 mt-1.5 leading-relaxed">
                  {t("consolidatedProGateBody") ||
                    "Cross-outlet daily close consolidation is for restaurants and bars with 2-3 locations. It rolls up each branch's daily close into one super-close — same numbers Caro snapped per terminal, summed across every venue."}
                </p>
                <p className="text-[13px] text-gray-600 dark:text-gray-300 mt-2 leading-relaxed">
                  {t("consolidatedProGateAvailability") ||
                    "Available on Pro (founding 249 kr/mo) and during your 14-day Pro trial."}
                </p>
                <Link
                  to="/subscription"
                  className="inline-block mt-4 px-5 py-2.5 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg transition"
                >
                  {t("consolidatedProGateCta") || "See Pro plan"}
                </Link>
              </div>
            </div>
          </div>
        </FadeIn>
      </div>
    );
  }

  return (
    <div className="px-4 sm:px-6 py-6 max-w-4xl mx-auto">
      <FadeIn>
        <div className="mb-2">
          <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
            🏢 {t("consolidatedTitle") || "Consolidated daily close"}
          </h1>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 max-w-xl">
            {t("consolidatedSubtitle") ||
              "Roll up daily closes from all your branches into one report. Send the consolidated PDF to the owner or revisor in one tap."}
          </p>
        </div>
      </FadeIn>

      {/* Date picker + run */}
      <FadeIn delay={0.02}>
        <div className="mt-5 mb-5 rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60 p-5 flex items-end gap-4 flex-wrap">
          <div className="flex-1 min-w-[200px]">
            <label className="block text-[11px] font-semibold uppercase tracking-wider text-gray-700 dark:text-gray-300 mb-1.5">
              {t("consolidatedDate") || "Close date"}
            </label>
            <input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              max={new Date().toISOString().slice(0, 10)}
              className="px-3 py-2.5 rounded-xl border border-gray-200 dark:border-gray-600 bg-white dark:bg-gray-700 text-sm text-gray-800 dark:text-gray-200 outline-none focus:ring-2 focus:ring-green-300 dark:focus:ring-green-700"
            />
          </div>
          <button
            onClick={fetchConsolidated}
            disabled={loading || !date}
            className="px-5 py-2.5 bg-[#22c55e] hover:bg-[#16a34a] text-white text-sm font-semibold rounded-lg disabled:opacity-50 transition"
          >
            {loading
              ? (t("loading") || "Loading…")
              : (t("consolidatedRun") || "Consolidate")}
          </button>
        </div>
      </FadeIn>

      {error && (
        <div className="mb-4 px-4 py-3 rounded-lg bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-[13px] text-red-700 dark:text-red-300">
          {error}
        </div>
      )}

      {result && result.branch_count === 0 && (
        <FadeIn delay={0.04}>
          <div className="rounded-2xl border border-dashed border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/40 p-8 text-center">
            <div className="text-3xl mb-2">📭</div>
            <p className="text-sm font-semibold text-gray-700 dark:text-gray-200">
              {t("consolidatedNoData") || "No closes for this date"}
            </p>
            <p className="text-[12.5px] text-gray-500 dark:text-gray-400 mt-1 max-w-md mx-auto leading-relaxed">
              {t("consolidatedNoDataHelp") ||
                "Make sure each branch has completed its daily close for the date you picked. Closes appear here automatically once they're confirmed."}
            </p>
          </div>
        </FadeIn>
      )}

      {result && result.branch_count > 0 && (
        <FadeIn delay={0.04}>
          {/* Summary band */}
          <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60 p-5 mb-3 grid grid-cols-2 sm:grid-cols-4 gap-4 text-center">
            <Stat
              label={t("consolidatedStatBranches") || "Branches"}
              value={result.branch_count}
            />
            <Stat
              label={t("consolidatedStatRevenue") || "Revenue total"}
              value={fmtKr(result.totals.revenue_total, currency)}
            />
            <Stat
              label={t("consolidatedStatMoms") || "Moms total"}
              value={fmtKr(result.totals.moms_total, currency)}
            />
            <Stat
              label={t("consolidatedStatCashDiff") || "Cash diff total"}
              value={fmtKr(result.totals.cash_difference, currency)}
              tone={Math.abs(result.totals.cash_difference) > 0.005 ? "amber" : "neutral"}
            />
          </div>

          {/* Per-branch rows */}
          <div className="rounded-2xl border border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800/60 overflow-hidden">
            <div className="px-5 py-3 border-b border-gray-100 dark:border-gray-700/60 text-[11px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
              {t("consolidatedPerBranch") || "Per branch"}
            </div>
            <div className="divide-y divide-gray-100 dark:divide-gray-700/60">
              {result.branches.map((b) => {
                const flagged = Math.abs(b.cash_difference || 0) > 0.005;
                return (
                  <div key={(b.branch_id || "unassigned") + b.name} className="px-5 py-3 flex items-center justify-between gap-4 flex-wrap">
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-semibold text-gray-900 dark:text-white truncate">
                        {b.name}
                      </div>
                      {b.closed_by && (
                        <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">
                          {t("closedBy") || "Closed by"}: {b.closed_by}
                        </div>
                      )}
                    </div>
                    <div className="text-right">
                      <div className="text-sm font-semibold text-gray-800 dark:text-gray-100">
                        {fmtKr(b.revenue_total, currency)}
                      </div>
                      <div className={`text-[11px] mt-0.5 ${flagged ? "text-amber-700 dark:text-amber-400 font-semibold" : "text-gray-400 dark:text-gray-500"}`}>
                        {flagged ? "⚠ " : ""}
                        {t("cashDiff") || "Cash diff"}: {fmtKr(b.cash_difference, currency)}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
            {/* Totals row — bold, separated */}
            <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-700 bg-gray-50/60 dark:bg-gray-900/30 flex items-center justify-between">
              <div className="text-sm font-bold text-gray-900 dark:text-white">
                {t("total") || "Total"}
              </div>
              <div className="text-base font-bold text-gray-900 dark:text-white">
                {fmtKr(result.totals.revenue_total, currency)}
              </div>
            </div>
          </div>

          {/* Branches-with-diff banner */}
          {result.branches_with_diff > 0 && (
            <div className="mt-3 px-4 py-3 rounded-lg bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800/50 text-[13px] text-amber-800 dark:text-amber-200">
              ⚠ {(t("consolidatedDiffWarning") || "{n} of {total} branches flagged a cash difference.")
                .replace("{n}", result.branches_with_diff)
                .replace("{total}", result.branch_count)}
            </div>
          )}
        </FadeIn>
      )}
    </div>
  );
}


/* ─── Small UI atoms ─────────────────────────────────────────────────── */

function Stat({ label, value, tone = "neutral" }) {
  const valueClass =
    tone === "amber"
      ? "text-amber-700 dark:text-amber-400"
      : "text-gray-900 dark:text-white";
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-gray-500 dark:text-gray-400">
        {label}
      </div>
      <div className={`text-base font-bold mt-0.5 ${valueClass}`}>
        {value}
      </div>
    </div>
  );
}

function fmtKr(n, currency) {
  if (n == null) return `0,00 ${currency}`;
  // Match the Danish format used in the kasserapport PDF: "14.854,00 DKK"
  const v = Number(n).toFixed(2);
  const [int, frac] = v.split(".");
  const withSep = int.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${withSep},${frac} ${currency}`;
}
