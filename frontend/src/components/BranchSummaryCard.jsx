/**
 * BranchSummaryCard — at-a-glance "all my locations" view for Pro+
 * users with ≥2 branches.
 *
 * Why this exists:
 *   Pro tier promises "AI that thinks across them" for 2-3 locations.
 *   Without this card, the Dashboard only shows ONE branch (the
 *   currently-selected one in BranchSelector). Multi-location owners
 *   had to either:
 *     (a) manually switch branches to compare, or
 *     (b) navigate to a separate consolidated page
 *   Both are friction. This card sits on the Dashboard and shows a
 *   compact horizontal stack of "this month, per location":
 *
 *      Nørrebro  45,200 kr  ████████████░░░░
 *      Østerbro  38,100 kr  ██████████░░░░░░
 *      Frederiksberg 41,400 kr  ███████████░░░░░
 *
 *   One glance, three facts, no clicking.
 *
 * Visibility rules:
 *   • Auth-gated server-side (`/branches/summary`).
 *   • Renders only when has_branches=true AND ≥2 branches (single-
 *     branch owners don't need a "compare" view).
 *   • No plan gate at the component level — the server already
 *     enforces multi_branch_dashboard for the consolidated PDF;
 *     this read-only summary uses the existing /branches/summary
 *     endpoint which is open to all tiers (the data is already
 *     theirs to see).
 *
 * Calm UX:
 *   • Single horizontal section, no chrome.
 *   • Click a branch row → switches BranchSelector to that branch
 *     so the Smart cards below re-scope. Shortcut without leaving
 *     the page.
 */
import { useEffect, useState } from "react";
import api from "../services/api";
import { useLanguage } from "../hooks/useLanguage";
import { useAuth } from "../hooks/useAuth";
import { displayCurrency } from "../utils/currency";
import { useBranch } from "./BranchSelector";


export default function BranchSummaryCard() {
  const { t } = useLanguage();
  const { user } = useAuth();
  const { setBranchId, branchId: activeBranchId } = useBranch();
  const currency = displayCurrency(user?.currency);
  const [summary, setSummary] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    api.get("/branches/summary")
      .then((res) => { if (alive) setSummary(res.data); })
      .catch(() => { /* silent — this is a non-critical addon */ })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, []);

  if (loading) return null;
  if (!summary?.has_branches) return null;
  if ((summary.branches || []).length < 2) return null;

  const max = Math.max(1, ...summary.branches.map((b) => b.month_revenue || 0));
  const totalRev = summary.consolidated?.month_revenue || 0;

  return (
    <div className="rounded-xl border border-gray-200 dark:border-gray-700/60 bg-white dark:bg-gray-800/40 p-5 mb-4">
      <div className="flex items-baseline justify-between mb-3">
        <h2 className="text-sm font-semibold text-gray-900 dark:text-gray-100">
          {t("branchSummaryTitle") || "Your locations this month"}
        </h2>
        <span className="text-[12px] text-gray-500 dark:text-gray-400">
          {(t("branchSummaryTotal") || "Total {amount}").replace(
            "{amount}",
            `${Math.round(totalRev).toLocaleString()} ${currency}`,
          )}
        </span>
      </div>

      <div className="space-y-2">
        {summary.branches.map((b) => {
          const w = max > 0 ? Math.max(2, Math.round((b.month_revenue / max) * 100)) : 0;
          const isActive = activeBranchId === b.id;
          return (
            <button
              key={b.id}
              type="button"
              onClick={() => setBranchId(isActive ? null : b.id)}
              aria-pressed={isActive}
              className={`w-full text-left rounded-lg px-3 py-2 transition ${
                isActive
                  ? "bg-gray-50 dark:bg-gray-800/50 ring-1 ring-gray-200 dark:ring-gray-700"
                  : "bg-gray-50 dark:bg-gray-700/30 hover:bg-gray-100 dark:hover:bg-gray-700/50"
              }`}
            >
              <div className="flex items-center justify-between gap-3 mb-1">
                <span className="text-sm font-semibold text-gray-900 dark:text-gray-100 truncate">
                  {b.name}
                  {b.is_default && (
                    <span className="ml-1.5 text-[10px] uppercase font-medium text-gray-400">
                      {t("branchDefaultBadge") || "default"}
                    </span>
                  )}
                </span>
                <span className="text-[13px] tabular-nums font-semibold text-gray-900 dark:text-gray-100 shrink-0">
                  {Math.round(b.month_revenue).toLocaleString()} {currency}
                </span>
              </div>
              <div className="h-1.5 rounded-full bg-gray-200 dark:bg-gray-600/60 overflow-hidden">
                <div
                  className="h-full bg-emerald-500 dark:bg-emerald-400 transition-all duration-500"
                  style={{ width: `${w}%` }}
                />
              </div>
              <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-1 flex items-center gap-3">
                <span>{(t("branchSummaryProfit") || "profit")}: {Math.round(b.month_profit).toLocaleString()} {currency}</span>
                {isActive && (
                  <span className="text-emerald-600 dark:text-emerald-400 font-medium">
                    ✓ {t("branchSummaryActive") || "scoped to this branch"}
                  </span>
                )}
              </div>
            </button>
          );
        })}
      </div>

      <p className="text-[11px] text-gray-400 dark:text-gray-500 mt-2">
        {t("branchSummaryHint") || "Tap a location to scope the Smart cards below to it."}
      </p>
    </div>
  );
}
