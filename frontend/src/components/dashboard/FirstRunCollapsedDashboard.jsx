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
import { useFeatures } from "../../hooks/useFeatures";
import DemoDataCard from "../DemoDataCard";

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
  // Bank-connect / MobilePay are fail-closed OFF in prod until a real PSD2
  // provider is configured (see useFeatures + ConnectionsPage gating). When
  // off, leading first-run with "Connect your bank" was a dead end — the
  // tile is hidden on /connections. So we ONLY surface that step when the
  // backend says the integration is genuinely wired up. The product's real
  // wedge — the daily kasserapport — leads instead.
  const { bank_connect_enabled: bankConnectEnabled } = useFeatures();

  // Steps are assembled as a list so numbering stays correct whether or not
  // the optional bank step is present. The kasserapport snap is ALWAYS the
  // primary action (step 1, gray-900 Button); sale + expense follow.
  const steps = [
    {
      key: "close",
      title: t("dashFirstRunCloseTitle", "Snap your first kasserapport"),
      body: t(
        "dashFirstRunCloseBody",
        "Photograph your Z-report or end-of-day total — we read the numbers, calculate MOMS, and your revisor view starts collecting bilag. This is BonBox's daily 2-minute close.",
      ),
      action: (
        <Button
          variant="primary"
          size="md"
          onClick={() => navigate("/daily-close")}
        >
          {t("dashFirstRunCloseCta", "Snap your first kasserapport")}
        </Button>
      ),
    },
    {
      key: "sale",
      title: t("dashFirstRunStep2Title", "Log your first sale"),
      body: t(
        "dashFirstRunStep2Body",
        "Tap a quick amount or type it in — your KPIs and Daily Brief unlock as soon as the first sale lands.",
      ),
      action: (
        <Link
          to="/sales?new=1"
          className={
            "inline-flex items-center gap-1 text-xs font-medium " +
            "text-gray-700 dark:text-gray-300 " +
            "hover:text-gray-900 dark:hover:text-gray-100 " +
            "transition-colors"
          }
        >
          {t("dashFirstRunStep2Cta", "Log your first sale")}
          <span aria-hidden="true">→</span>
        </Link>
      ),
    },
    {
      key: "expense",
      title: t("dashFirstRunStep3Title", "Add an expense"),
      body: t(
        "dashFirstRunStep3Body",
        "Snap a receipt or pick a category — we OCR it and your revisor view starts collecting bilag.",
      ),
      action: (
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
      ),
    },
  ];

  // Bank/MobilePay only when the backend has a real provider configured.
  if (bankConnectEnabled) {
    steps.push({
      key: "bank",
      title: t("dashFirstRunStep1Title", "Connect MobilePay or your bank"),
      body: t(
        "dashFirstRunStep1Body",
        "Pull in your bank + payment data so reconciliation is automatic — or keep logging manually.",
      ),
      action: (
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
      ),
    });
  }

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
            "Start with your daily close — sales, expenses, and MOMS fill your dashboard in as you go.",
          )}
        </p>
      </header>

      <ol className="space-y-5">
        {steps.map((step, i) => (
          <StepRow
            key={step.key}
            index={i + 1}
            title={step.title}
            body={step.body}
            action={step.action}
            lastItem={i === steps.length - 1}
          />
        ))}
      </ol>

      {/* No slip handy? Seed 30 days of realistic sample data in one tap so
          the owner can explore the dashboard/brief/reports before their
          first real close. DemoDataCard self-hides once seeded, if the user
          already has real data, or on dismissal. */}
      <div className="mt-6">
        <DemoDataCard />
      </div>
    </div>
  );
}
