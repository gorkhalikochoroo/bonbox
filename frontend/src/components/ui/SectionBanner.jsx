/**
 * SectionBanner — inline contextual message at the top of a page section.
 *
 * Use when a section needs to tell the owner SOMETHING about the data
 * they're about to look at:
 *   • "Heads up, your MOMS is due in 3 days"  (warn)
 *   • "Your bank link expired — reconnect to keep auto-reconciliation"
 *     (critical)
 *   • "We auto-categorized 12 expenses from your last bank import"
 *     (success)
 *   • "Tip: drag a column header to reorder"  (info)
 *
 * NOT the same as <DismissibleTip>. DismissibleTip is for *teaching*
 * (persists dismissal across sessions, has a default emoji bulb).
 * SectionBanner is for *now-state messaging* — it shows because the
 * data right now warranted saying something. If the user dismisses,
 * that's session-only by default; the caller wires up persistence if
 * they want it via the onDismiss callback.
 *
 * Severity palettes mirror the global semantic colors used by StatCard
 * and the rest of the app. Background tints are the lightest 50-step
 * shade with a matching 200-step border — same recipe Card uses, which
 * keeps banners visually anchored inside the section instead of
 * floating like a toast.
 *
 *   info     — gray-50 / gray-200 / icon gray-500   (the default)
 *   warn     — amber-50 / amber-200 / icon amber-600
 *   critical — red-50 / red-200 / icon red-600
 *   success  — emerald-50 / emerald-200 / icon emerald-600
 *
 * Why gray-50 for `info` (instead of the more obvious blue)?
 *   The sidebar deliberately avoids ANY non-green accent color (see
 *   Layout.jsx around line 500 — the "tech glow" rejection comment).
 *   An info banner in blue would be the FIRST blue in the whole app
 *   and would feel out of place. Neutral gray keeps the banner calm
 *   without inventing a new accent.
 *
 * Usage:
 *   <SectionBanner severity="warn" title="MOMS due soon"
 *                  icon="AlertTriangle"
 *                  onDismiss={() => persistDismissed()}>
 *     Your Q1 MOMS return is due 3 May. We'll keep your filing-ready
 *     PDF in sync until then.
 *   </SectionBanner>
 */
import React from "react";
import Icon from "./Icon";

// Each severity gets its own surface + icon color. Border + bg use the
// 50/200 paired shades; icon uses the 500/600 step so it stands out
// against the lighter bg without competing with the title text.
const SEVERITY_STYLE = {
  info: {
    wrap: "bg-gray-50 border-gray-200 dark:bg-gray-800/60 dark:border-gray-700",
    icon: "text-gray-500 dark:text-gray-400",
  },
  warn: {
    wrap: "bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800/40",
    icon: "text-amber-600 dark:text-amber-400",
  },
  critical: {
    wrap: "bg-red-50 border-red-200 dark:bg-red-900/20 dark:border-red-800/40",
    icon: "text-red-600 dark:text-red-400",
  },
  success: {
    wrap: "bg-emerald-50 border-emerald-200 dark:bg-emerald-900/20 dark:border-emerald-800/40",
    icon: "text-emerald-600 dark:text-emerald-400",
  },
};

export default function SectionBanner({
  title,
  body = null,
  children,
  severity = "info",
  icon = null,        // Lucide icon name, e.g. "AlertTriangle"
  onDismiss = null,
  className = "",
}) {
  const style = SEVERITY_STYLE[severity] || SEVERITY_STYLE.info;
  // Body content is "children" by convention but we also accept `body`
  // prop for cases where the caller wants to pass a plain string from
  // a translation key without JSX overhead.
  const content = children ?? body;

  return (
    <div
      // rounded-xl + 1px border + p-4 follows the Card recipe so a banner
      // visually nests inside the page rhythm rather than feeling like an
      // injected alert.
      className={`relative rounded-xl border p-4 ${style.wrap} ${className}`}
      role="status"
    >
      <div className="flex items-start gap-3">
        {icon && (
          <div className={`shrink-0 ${style.icon} mt-0.5`} aria-hidden="true">
            <Icon name={icon} size={18} />
          </div>
        )}
        <div className="flex-1 min-w-0 pr-6">
          {title && (
            <p className="text-[14px] font-semibold text-gray-900 dark:text-gray-100 mb-1 leading-snug">
              {title}
            </p>
          )}
          {content && (
            <div className="text-[13.5px] text-gray-700 dark:text-gray-300 leading-relaxed">
              {content}
            </div>
          )}
        </div>
      </div>
      {onDismiss && (
        // Dismiss is a quiet 24px hit target with a hover state. Same
        // pattern as DismissibleTip's × — we don't want a heavy "close
        // me" button drawing the eye away from the banner body.
        <button
          type="button"
          onClick={onDismiss}
          aria-label="Dismiss"
          className="absolute top-3 right-3 w-6 h-6 rounded-md inline-flex items-center justify-center text-gray-400 hover:text-gray-700 hover:bg-black/5 dark:text-gray-500 dark:hover:text-gray-200 dark:hover:bg-white/10 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500"
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        </button>
      )}
    </div>
  );
}
