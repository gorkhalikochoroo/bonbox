/**
 * AllClearCard — the explicit empty state for Zone 3.
 *
 * Linear's Inbox-Zero pattern: when there's nothing urgent to act on,
 * the empty zone EXPLAINS its emptiness instead of silently disappearing.
 * Without this card, Zone 3 looks "broken" — owners assume the system
 * failed to load rather than recognizing the calm state.
 *
 * Doctrine compliance:
 *   • Neutral gray-50 surface (matches SectionBanner.info recipe)
 *   • Single colored icon — the Check is the success signal, body text
 *     stays gray. No tinted backgrounds, no shadow.
 *   • rounded-xl (per doctrine), 1px gray-200 border
 *   • Heading sized as H3 (`text-base font-semibold`), body sized as
 *     caption (`text-sm text-gray-500`).
 *
 * Renders when:
 *   ctx.zone3DynamicCount === 0 && !ctx.activations.isFirstRun
 *
 * (the predicate lives in dashboardCardSets.js — this component just
 *  receives `ctx` and renders.)
 */
import React from "react";
import { Check } from "lucide-react";
import { Link } from "react-router-dom";
import { useLanguage } from "../../hooks/useLanguage";

export default function AllClearCard({ ctx = {}, className = "" }) {
  const { t } = useLanguage();
  const nextLabel =
    ctx?.compliance?.nextDeadlineLabel ||
    ctx?.compliance?.nextDeadline?.label ||
    null;
  const daysAway =
    ctx?.compliance?.daysToNext ??
    ctx?.compliance?.nextDeadline?.daysAway ??
    null;

  // Body text composes the two sentences. The deadline sentence only
  // renders if we actually have a label + days — otherwise just the
  // primary all-clear line.
  let deadlineSentence = null;
  if (nextLabel && typeof daysAway === "number" && daysAway >= 0) {
    deadlineSentence = t(
      "dashAllClearNext",
      "Next deadline: {label} in {days} days",
    )
      .replace("{label}", nextLabel)
      .replace("{days}", String(daysAway));
  }

  return (
    <div
      className={
        "rounded-xl border border-gray-200 dark:border-gray-800 " +
        "bg-gray-50 dark:bg-gray-900/60 p-5 sm:p-6 " +
        (className || "")
      }
      data-zone="3"
      data-component="AllClearCard"
      role="status"
      aria-label={t("dashAllClearTitle", "All clear")}
    >
      <div className="flex items-start gap-3">
        <div
          className={
            "shrink-0 inline-flex items-center justify-center " +
            "w-9 h-9 rounded-full bg-white dark:bg-gray-900 " +
            "border border-gray-200 dark:border-gray-800"
          }
          aria-hidden="true"
        >
          <Check
            size={18}
            strokeWidth={2.25}
            className="text-emerald-600 dark:text-emerald-400"
          />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
            {t("dashAllClearTitle", "All clear")}
          </h3>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
            {t(
              "dashAllClearBody",
              "Nothing urgent right now. Reports and Daily Brief continue to track everything in the background.",
            )}
            {deadlineSentence && (
              <>
                {" "}
                <span className="text-gray-700 dark:text-gray-300">
                  {deadlineSentence}
                </span>
              </>
            )}
          </p>
          {nextLabel && (
            <div className="mt-3">
              <Link
                to="/tax"
                className={
                  "inline-flex items-center gap-1 text-xs font-medium " +
                  "text-gray-700 dark:text-gray-300 " +
                  "hover:text-gray-900 dark:hover:text-gray-100 " +
                  "transition-colors"
                }
              >
                {t("dashAllClearViewDeadlines", "View deadlines")}
                <span aria-hidden="true">→</span>
              </Link>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
