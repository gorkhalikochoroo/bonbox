/**
 * TopSellersCard — ranked products by revenue.
 *
 * Gated on `activations.hasInventory && topSellers.length >= 2` per the
 * card-set config. Empty state ("Log a sale to see your top movers")
 * lives in the spec but is here as a quiet body line — the renderIf
 * already trims most empty cases.
 *
 * Doctrine compliance:
 *   • Neutral surface (rounded-xl, gray-200 border, bg-white).
 *   • Single bar color (gray-700) — no rainbow palette across ranks.
 *     The doctrine explicitly bans "categorical rainbow palettes."
 *   • Rank treatment: 1-3 bold gray-900, 4+ quiet gray-400 (hierarchy
 *     via weight + size, not color).
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../../hooks/useLanguage";

export default function TopSellersCard({ ctx = {} }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const topSellers = ctx?.topSellers || [];
  const currency = ctx?.currency || "DKK";

  if (!topSellers || topSellers.length < 2) return null;

  const sorted = [...topSellers]
    .sort((a, b) => (b.revenue || 0) - (a.revenue || 0))
    .slice(0, 5);
  const maxVal = Math.max(...sorted.map((s) => s.revenue || 0), 1);

  return (
    <div
      onClick={() => navigate("/sales")}
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 sm:p-6 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60 transition"
      data-zone="2"
      data-component="TopSellersCard"
    >
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
        {t("topSellers", "Top sellers")}
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-3 tabular-nums">
        {sorted.length} {t("products", "products")}
      </p>
      <div className="space-y-2.5">
        {sorted.map((item, i) => {
          const val = item.revenue || 0;
          const barW = Math.max((val / maxVal) * 100, 4);
          const rankClass =
            i < 3
              ? "text-sm font-bold text-gray-900 dark:text-gray-100"
              : "text-xs text-gray-400 font-medium";
          return (
            <div key={(item.name || "item") + i} className="flex items-center gap-3">
              <span className={`${rankClass} w-6 text-center tabular-nums`}>
                {i + 1}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline justify-between mb-1">
                  <span className="text-sm font-medium text-gray-700 dark:text-gray-200 truncate">
                    {item.name}
                  </span>
                  <span className="text-sm font-bold tabular-nums text-gray-900 dark:text-gray-100 ml-2">
                    {Math.round(val).toLocaleString()} {currency}
                  </span>
                </div>
                <div className="h-1.5 bg-gray-100 dark:bg-gray-800 rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full bg-gray-700 dark:bg-gray-300"
                    style={{ width: `${barW}%` }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
