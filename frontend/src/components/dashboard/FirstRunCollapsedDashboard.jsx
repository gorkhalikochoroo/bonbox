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
import { archetypeForUser } from "../../config/archetypes";
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

// Secondary-step link styling (small, quiet — never competes with the hero).
const SECONDARY_LINK =
  "inline-flex items-center gap-1 text-xs font-medium " +
  "text-gray-700 dark:text-gray-300 " +
  "hover:text-gray-900 dark:hover:text-gray-100 transition-colors";

export default function FirstRunCollapsedDashboard({ user = null, className = "" }) {
  const { t } = useLanguage();
  const navigate = useNavigate();
  // Bank-connect / MobilePay are fail-closed OFF in prod until a real PSD2
  // provider is configured (see useFeatures + ConnectionsPage gating). When
  // off, leading first-run with "Connect your bank" was a dead end — the
  // tile is hidden on /connections. So we ONLY surface that step when the
  // backend says the integration is genuinely wired up.
  const { bank_connect_enabled: bankConnectEnabled } = useFeatures();

  // ── Archetype-aware HERO step ──────────────────────────────────────────
  // The hero (step 1, gray-900 Button) must be the first win that fits THIS
  // owner's business — a salon takes a booking, a shop counts stock, a
  // freelancer sends a faktura. Leading every vertical with "Snap your
  // Z-report" was a dead-end CTA for the ~11 verticals with no till.
  // Fail-safe: unknown/blank business_type → generic → daily_close (the
  // historical default), so nobody ever loses the hero.
  const arch = archetypeForUser(user);
  const firstWin = arch?.firstWin || "daily_close";
  const isTransactional =
    (arch?.dashboardMode || "transactionalDaily") === "transactionalDaily";

  const HERO_BY_FEATURE = {
    daily_close: {
      key: "close",
      title: t("dashFirstRunCloseTitle", "Snap your first kasserapport"),
      body: t(
        "dashFirstRunCloseBody",
        "Photograph your Z-report or end-of-day total — we read the numbers, calculate MOMS, and your revisor view starts collecting bilag. This is BonBox's daily 2-minute close.",
      ),
      cta: t("dashFirstRunCloseCta", "Snap your first kasserapport"),
      route: "/daily-close",
    },
    reservations: {
      key: "booking",
      title: t("dashFirstRunBookTitle", "Take your first booking"),
      body: t(
        "dashFirstRunBookBody",
        "Add a booking — a walk-in or the phone — and your floor, waitlist, and no-show view start filling in. Share your booking link and guests book themselves.",
      ),
      cta: t("dashFirstRunBookCta", "Open your booking book"),
      route: "/reservations",
    },
    inventory: {
      key: "stock",
      title: t("dashFirstRunStockTitle", "Do your first stock count"),
      body: t(
        "dashFirstRunStockBody",
        "Snap a delivery or count what's on the shelf — we track what you have, flag what's running low, and your real margins come into view.",
      ),
      cta: t("dashFirstRunStockCta", "Start your first count"),
      route: "/inventory",
    },
    faktura: {
      key: "faktura",
      title: t("dashFirstRunInvoiceTitle", "Send your first faktura"),
      body: t(
        "dashFirstRunInvoiceBody",
        "Create a faktura in under a minute — MOMS calculated, PDF ready to send, and your revisor view starts collecting bilag.",
      ),
      cta: t("dashFirstRunInvoiceCta", "Create your first faktura"),
      route: "/faktura",
    },
    expenses: {
      key: "expense-lead",
      title: t("dashFirstRunExpenseLeadTitle", "Add your first expense"),
      body: t(
        "dashFirstRunExpenseLeadBody",
        "Snap a receipt or pick a category — we OCR it, sort erhverv vs privat, and your tax picture starts to build.",
      ),
      cta: t("dashFirstRunExpenseLeadCta", "Add your first expense"),
      route: "/expenses",
    },
  };
  const heroDef = HERO_BY_FEATURE[firstWin] || HERO_BY_FEATURE.daily_close;

  const heroStep = {
    key: heroDef.key,
    title: heroDef.title,
    body: heroDef.body,
    action: (
      <Button variant="primary" size="md" onClick={() => navigate(heroDef.route)}>
        {heroDef.cta}
      </Button>
    ),
  };

  // Universal secondary steps (small quiet links). Sale only for transactional
  // verticals (a freelancer/personal owner invoices, they don't ring up sales).
  // Dedupe: skip a secondary the hero already covers.
  const secondarySale = {
    key: "sale",
    title: t("dashFirstRunStep2Title", "Log your first sale"),
    body: t(
      "dashFirstRunStep2Body",
      "Tap a quick amount or type it in — your KPIs and Daily Brief unlock as soon as the first sale lands.",
    ),
    action: (
      <Link to="/sales?new=1" className={SECONDARY_LINK}>
        {t("dashFirstRunStep2Cta", "Log your first sale")}
        <span aria-hidden="true">→</span>
      </Link>
    ),
  };
  const secondaryExpense = {
    key: "expense",
    title: t("dashFirstRunStep3Title", "Add an expense"),
    body: t(
      "dashFirstRunStep3Body",
      "Snap a receipt or pick a category — we OCR it and your revisor view starts collecting bilag.",
    ),
    action: (
      <Link to="/expenses?new=1" className={SECONDARY_LINK}>
        {t("dashFirstRunStep3Cta", "Snap a receipt")}
        <span aria-hidden="true">→</span>
      </Link>
    ),
  };

  const steps = [heroStep];
  if (isTransactional && heroDef.key !== "sale") steps.push(secondarySale);
  if (heroDef.key !== "expense-lead") steps.push(secondaryExpense);

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
        <Link to="/connections" className={SECONDARY_LINK}>
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
            "dashFirstRunSubtitleTwoWays",
            "Two ways to begin: explore with sample data to see the whole thing at once, or start your first close and watch your dashboard fill in.",
          )}
        </p>
      </header>

      {/* Explore-first path, surfaced at the TOP as a co-equal choice (it used
          to be a buried footnote below the steps, self-hiding forever after one
          dismissal). forceShow keeps it reachable on an empty dashboard.
          Visually amber/secondary so the gray-900 kasserapport CTA below stays
          the hero — the wedge still leads. Honest: DemoActiveBanner + ` · demo`
          tags mean seeded data never masquerades as real. */}
      <DemoDataCard forceShow />

      <div className="flex items-center gap-3 my-6" aria-hidden="true">
        <span className="h-px flex-1 bg-gray-100 dark:bg-gray-800" />
        <span className="text-[11px] font-medium uppercase tracking-wide text-gray-400 dark:text-gray-500">
          {t("dashFirstRunOrStartReal", "or start with your real numbers")}
        </span>
        <span className="h-px flex-1 bg-gray-100 dark:bg-gray-800" />
      </div>

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
    </div>
  );
}
