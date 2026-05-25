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

export default function AlertsPanel({ ctx = {} }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  const items = ctx?.actionItems || [];

  if (items.length === 0) return null;

  const top = items.slice(0, 5);

  return (
    <div
      onClick={() => navigate("/reports")}
      className="rounded-xl border border-gray-200 dark:border-gray-800 bg-white dark:bg-gray-900 p-5 sm:p-6 cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-800/60 transition"
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
        {top.map((a, i) => (
          <li key={(a.id || a.title || "alert") + i} className="text-sm">
            <p className="font-medium text-gray-900 dark:text-gray-100">
              {a.title}
            </p>
            {a.detail && (
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                {a.detail}
              </p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
