/**
 * AlertsPanel — Zone 3 scannable inbox.
 *
 * Different JTBD from DailyBriefCard: that card surfaces a curated top
 * 3 ranked by urgency; this panel is the FULL inbox of open action
 * items. Per the v2 spec the two cards stay distinct — don't merge.
 *
 * Gated on `actionItems.length >= 1` per the card-set config.
 *
 * Doctrine compliance:
 *   • Neutral surface (rounded-xl, gray-200 border, bg-white)
 *   • No per-item severity tint — the renderIf already gated on "there
 *     are open items"; the count alone is enough signal.
 *   • Clickable card → /reports (where AlertsPanel's deep view lives).
 */
import React from "react";
import { useNavigate } from "react-router-dom";
import { useLanguage } from "../../hooks/useLanguage";

/* The server's title/detail are English; the numbers behind them arrive in
   `params`, so the words are built here in the owner's language. The English
   stays only as the fallback for a type this panel doesn't know. */
function alertText(t, a) {
  const p = a.params || {};
  switch (a.type) {
    case "restock":
      return {
        title: t("alertRestockTitle", "Restock: {name}", { name: p.name }),
        detail: p.qty != null
          ? t("alertRestockDetail", "{qty} left — your minimum is {min}", { qty: p.qty, min: p.min })
          : null,
      };
    case "expiring": {
      const d = Number(p.days);
      return {
        title: t("alertExpiringTitle", "Expiring: {name}", { name: p.name }),
        detail: d === 0 ? t("alertExpiringToday", "Today")
          : d === 1 ? t("alertExpiringTomorrow", "Tomorrow")
            : t("alertExpiringInDays", "In {days} days", { days: d }),
      };
    }
    case "return":
      return {
        title: Number(p.n) === 1
          ? t("alertReturnOne", "1 return pending")
          : t("alertReturnMany", "{n} returns pending", { n: p.n }),
        detail: t("alertReturnDetail", "Refund, replace or put back in stock."),
      };
    case "reminder":
      return {
        title: t("alertNoSalesTitle", "No sales logged today"),
        detail: t("alertNoSalesDetail", "Log today's first sale so the numbers stay right."),
      };
    case "cost":
      return {
        title: t("alertCostTitle", "Expenses are {pct}% of revenue", { pct: p.pct }),
        detail: a.priority === "high"
          ? t("alertCostHigh", "Look at your biggest expense categories first.")
          : t("alertCostMedium", "Fine, but there may be room for a better margin."),
      };
    default:
      return { title: a.title, detail: a.detail };
  }
}

export default function AlertsPanel({ ctx = {} }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const items = ctx?.actionItems || [];

  if (items.length === 0) return null;

  const top = items.slice(0, 5);

  return (
    <div
      onClick={() => navigate("/reports")}
      className="rounded-xl border border-gray-200 dark:border-[rgb(var(--surface-line))] bg-white dark:bg-[rgb(var(--surface-card))] p-5 sm:p-6 cursor-pointer hover:bg-gray-50 dark:hover:bg-[rgb(var(--surface-raised))] transition"
      data-zone="3"
      data-component="AlertsPanel"
    >
      <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
        {t("alerts", "Alerts")}
      </h3>
      <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5 mb-3 tabular-nums">
        {items.length} {t("active", "active")}
      </p>
      <ul className="space-y-2">
        {top.map((a, i) => {
          const { title, detail } = alertText(t, a);
          return (
            <li key={(a.id || a.title || "alert") + i} className="text-sm">
              <p className="font-medium text-gray-900 dark:text-gray-100">
                {title}
              </p>
              {detail && (
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                  {detail}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
