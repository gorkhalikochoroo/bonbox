/**
 * FirstRunCollapsedDashboard — replaces the entire Dashboard when the
 * user is in the first-run state (`ctx.activations.isFirstRun`, which
 * means totalSales === 0).
 *
 * Why a full-page replacement (vs three empty-state cards across zones):
 *   A fresh account with no data renders 8-10 cards in their empty state,
 *   each saying "no data yet" — it reads as "the dashboard is broken,"
 *   not "I haven't started yet." This component collapses to a single
 *   3-step onboarding card that drives the next action.
 *
 * Doctrine compliance:
 *   • Hero heading uses the same H1 treatment PageHeader prescribes
 *     (text-[28px] font-bold tracking-[-0.025em]).
 *   • Primary CTA uses <Button intent="primary"> — gray-900, NEVER a
 *     bare bg-green-* hand-rolled.
 *   • Step rows: numbered chips (gray-100 / gray-700) + heading + body.
 *     No tinted backgrounds, no shadow.
 *   • No data fetched — this is static onboarding copy. Any "is this
 *     step done?" logic belongs in the orchestrator's renderIf, not here.
 */
import React from "react";
import { Link, useNavigate } from "react-router-dom";
import { Button } from "../ui";
import { useLanguage } from "../../hooks/useLanguage";

function StepRow({ index, title, body, action, lastItem = false }) {
  return (
    <li
      className={
        "flex items-start gap-4 " +
        (lastItem ? "" : "pb-5 border-b border-gray-100 dark:border-gray-800")
      }
    >
      <span
        className={
          "shrink-0 inline-flex items-center justify-center " +
          "w-7 h-7 rounded-full bg-gray-100 dark:bg-gray-800 " +
          "text-gray-700 dark:text-gray-300 text-sm font-semibold tabular-nums"
        }
        aria-hidden="true"
      >
        {index}
      </span>
      <div className="flex-1 min-w-0">
        <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          {title}
        </h3>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-0.5 leading-relaxed">
          {body}
        </p>
        {action && <div className="mt-3">{action}</div>}
      </div>
    </li>
  );
}

export default function FirstRunCollapsedDashboard({ className = "" }) {
  const { t } = useLanguage();
  const navigate = useNavigate();

  return (
    <div
      className={
        "rounded-xl border border-gray-200 dark:border-gray-800 " +
        "bg-white dark:bg-gray-900 p-6 sm:p-8 " +
        (className || "")
      }
      data-component="FirstRunCollapsedDashboard"
    >
      <header className="mb-6">
        <h1 className="text-[28px] font-bold tracking-[-0.025em] text-gray-900 dark:text-gray-100 leading-tight">
          {t("dashFirstRunTitle", "Welcome to BonBox")}
        </h1>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
          {t(
            "dashFirstRunSubtitle",
            "Three steps to start tracking sales, expenses, and MOMS — your dashboard fills in as you go.",
          )}
        </p>
      </header>

      <ol className="space-y-5">
        <StepRow
          index={1}
          title={t("dashFirstRunStep1Title", "Connect MobilePay or Aiia")}
          body={t(
            "dashFirstRunStep1Body",
            "Pull in your bank + payment data so reconciliation is automatic — or skip and log manually for now.",
          )}
          action={
            <Link
              to="/connections"
              className={
                "inline-flex items-center gap-1 text-xs font-medium " +
                "text-gray-700 dark:text-gray-300 " +
                "hover:text-gray-900 dark:hover:text-gray-100 " +
                "transition-colors"
              }
            >
              {t("dashFirstRunStep1Cta", "Open Connections")}
              <span aria-hidden="true">→</span>
            </Link>
          }
        />

        <StepRow
          index={2}
          title={t("dashFirstRunStep2Title", "Log your first sale")}
          body={t(
            "dashFirstRunStep2Body",
            "Tap a quick amount or type it in — your KPIs and Daily Brief unlock as soon as the first sale lands.",
          )}
          action={
            <Button
              variant="primary"
              size="md"
              onClick={() => navigate("/sales?new=1")}
            >
              {t("dashFirstRunStep2Cta", "Log your first sale")}
            </Button>
          }
        />

        <StepRow
          index={3}
          title={t("dashFirstRunStep3Title", "Add an expense")}
          body={t(
            "dashFirstRunStep3Body",
            "Snap a receipt or pick a category — we OCR it and your revisor view starts collecting bilag.",
          )}
          action={
            <Link
              to="/expenses?new=1"
              className={
                "inline-flex items-center gap-1 text-xs font-medium " +
                "text-gray-700 dark:text-gray-300 " +
                "hover:text-gray-900 dark:hover:text-gray-100 " +
                "transition-colors"
              }
            >
              {t("dashFirstRunStep3Cta", "Snap a receipt")}
              <span aria-hidden="true">→</span>
            </Link>
          }
          lastItem
        />
      </ol>
    </div>
  );
}
