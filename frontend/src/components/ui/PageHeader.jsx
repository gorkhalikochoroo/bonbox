/**
 * PageHeader — the single, canonical page title block.
 *
 * Before this, every page hand-rolled its own H1 — some used
 * `text-2xl text-green-600`, some used emoji prefixes, some bolted on
 * a subtitle in a different size each time. The result was that even
 * inside a single user journey the page-title "feel" kept shifting,
 * which made the sidebar (consistent, calm, accounting-software grade)
 * look mismatched against the pages it linked to.
 *
 * This component bakes the one true pattern that matches the sidebar
 * reference quality (see Layout.jsx around line 500 for the comment
 * explicitly rejecting the "tech glow" / colored-pill developer-tool
 * aesthetic):
 *
 *   • Optional eyebrow — micro tracking-wider 11px uppercase, gray-400.
 *     Used to label the kind of page ("REPORTS", "MONEY", "STOCK").
 *   • H1 — 28px bold, gray-900, slight negative tracking. No green,
 *     no emoji in the primary slot. Dinero/Billy do this.
 *   • Optional subtitle — 14px gray-500, sits 4px below the H1.
 *   • Actions slot — right-aligned on sm+, stacks under H1 on mobile.
 *     Typically 1 primary <Button> + 1 secondary (download, share, etc).
 *   • Bottom margin: 24px (mobile) → 32px (sm+) so the section that
 *     follows breathes without feeling disconnected.
 *
 * Usage:
 *   <PageHeader
 *     eyebrow="REPORTS"
 *     title="Tax Autopilot"
 *     subtitle="Watch your MOMS in real time"
 *     actions={
 *       <>
 *         <Button variant="secondary">Export</Button>
 *         <Button variant="accent">File</Button>
 *       </>
 *     }
 *   />
 */
import React from "react";

export default function PageHeader({
  title,
  eyebrow = null,
  subtitle = null,
  actions = null,
  className = "",
}) {
  return (
    <header
      className={
        "mb-6 sm:mb-8 flex flex-col sm:flex-row sm:items-end " +
        "sm:justify-between gap-3 sm:gap-4 " + className
      }
    >
      <div className="min-w-0">
        {eyebrow && (
          // Eyebrow mirrors the sidebar group-label treatment exactly
          // (Layout.jsx line ~705): 11px font-semibold uppercase
          // tracking-wider in gray-400. Reusing this rhythm anchors the
          // page in the same visual hierarchy as the nav it sits under.
          <p className="text-[11px] font-semibold uppercase tracking-wider text-gray-400 dark:text-gray-500 mb-1.5">
            {eyebrow}
          </p>
        )}
        {/* 22px on a phone, back to the canonical 28px from sm: up, so tablet
            and desktop stay pixel-identical (the same mobile-only rule
            StatCard's dense scale already follows).

            28px everywhere was a desktop size shipped to a 402pt screen. This
            header renders on 36 pages, and on several of them it stacks with an
            eyebrow, a two-line subtitle, a tab row and a date stepper — so the
            owner scrolled past a third of the viewport before reaching any
            content. The comment on the actions block below already conceded the
            problem ("a 28px H1 already eats most of an iPhone SE's content
            width"); it was worked around there instead of fixed here. */}
        <h1 className="text-[22px] sm:text-[28px] font-bold tracking-[-0.025em] text-gray-900 dark:text-gray-100 leading-tight">
          {title}
        </h1>
        {subtitle && (
          <p className="text-[14px] text-gray-500 dark:text-gray-400 mt-1 leading-relaxed">
            {subtitle}
          </p>
        )}
      </div>

      {actions && (
        // Right-align on sm+. On mobile the actions wrap below the title
        // so they don't fight the H1 for horizontal space — a 28px H1
        // already eats most of an iPhone SE's content width.
        <div className="shrink-0 flex items-center gap-2 flex-wrap">
          {actions}
        </div>
      )}
    </header>
  );
}
