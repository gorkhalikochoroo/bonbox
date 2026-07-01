import { useState, useEffect } from "react";
import { useLanguage } from "../hooks/useLanguage";
import { Icon } from "./ui";

/**
 * HowItWorksCard — multi-step onboarding panel for a feature page.
 *
 * Difference from <DismissibleTip>: that component is a single-sentence
 * hint. This one is a 3–5 step walkthrough that owners read once to
 * understand a whole feature flow. It collapses to a compact button after
 * the first read (state persisted in localStorage by storageKey).
 *
 * Usage:
 *   <HowItWorksCard
 *     storageKey="faktura-tips"
 *     icon="🧾"
 *     title="How Faktura works"
 *     steps={[
 *       { title: "Add a customer", body: "Just type the CVR…" },
 *       …
 *     ]}
 *     footer="Numbering follows Bogføringsloven §7…"
 *   />
 *
 * Steps render as numbered cards. Footer is optional small-print at the
 * bottom — good for compliance call-outs.
 */
// Default tone changed from "blue" → "neutral" (May 2026): the new gray
// neutral surface matches the rest of the redesigned app (sidebar +
// SectionBanner + DismissibleTip). Pages that still pass tone="blue"
// explicitly keep their old look until they're individually migrated,
// so this default change is non-breaking.
export default function HowItWorksCard({
  storageKey,
  // Prefer `iconName` — a Lucide icon (outline, matches the sidebar). The
  // legacy `icon` string (emoji) is still honored for back-compat, but new
  // callers should pass `iconName`. Default is a Lucide "Lightbulb".
  icon = null,
  iconName = null,
  title,
  steps = [],
  footer = null,
  tone = "neutral",
  className = "",
}) {
  const { t } = useLanguage();

  // One glyph resolver: Lucide `iconName` wins, then a legacy emoji string,
  // else the Lucide lightbulb — so the card never falls back to an emoji.
  const glyphFor = (size) => {
    if (iconName) return <Icon name={iconName} size={size} />;
    if (typeof icon === "string" && icon) return <span aria-hidden="true">{icon}</span>;
    return <Icon name="Lightbulb" size={size} />;
  };
  const fullKey = `bonbox_howitworks_${storageKey || "default"}`;

  // Start expanded for first-time visitors, collapsed thereafter.
  // Initialize to `true` (collapsed) to avoid a flash on slow loads where
  // localStorage hasn't been read yet — then resolve in useEffect.
  const [collapsed, setCollapsed] = useState(true);

  useEffect(() => {
    if (!storageKey) {
      setCollapsed(false);
      return;
    }
    try {
      const saved = localStorage.getItem(fullKey);
      // First visit (no saved state) → expanded.
      setCollapsed(saved === "1");
    } catch {
      setCollapsed(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullKey]);

  const persist = (val) => {
    try {
      localStorage.setItem(fullKey, val ? "1" : "0");
    } catch {
      /* ignore — localStorage may be disabled */
    }
  };

  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    persist(next);
  };

  const palette =
    {
      // Neutral is the new default — matches the sidebar / SectionBanner
      // recipe (gray-50 / gray-200 / gray-700 text + gray-900 chip).
      // Using gray-900 (not green) on the step-number chip echoes the
      // selected-pill treatment from TabPills and the active-nav-item
      // treatment from Layout.jsx. Calm, accounting-software feel.
      neutral: {
        wrap:
          "bg-gray-50 dark:bg-gray-800/60 border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-100",
        chip: "bg-gray-900 text-white dark:bg-white dark:text-gray-900",
        accent: "text-gray-600 dark:text-gray-400",
      },
      blue: {
        wrap:
          "bg-blue-50/70 dark:bg-blue-900/15 border-blue-200/70 dark:border-blue-800/40 text-blue-900 dark:text-blue-100",
        chip: "bg-blue-600 text-white",
        accent: "text-blue-700 dark:text-blue-300",
      },
      green: {
        wrap:
          "bg-gray-50/70 dark:bg-gray-800/50 border-gray-100/70 dark:border-gray-800/40 text-gray-900 dark:text-gray-100",
        chip: "bg-gray-900 text-white",
        accent: "text-gray-700 dark:text-gray-300",
      },
      amber: {
        wrap:
          "bg-amber-50/70 dark:bg-amber-900/15 border-amber-200/70 dark:border-amber-800/40 text-amber-900 dark:text-amber-100",
        chip: "bg-amber-600 text-white",
        accent: "text-amber-700 dark:text-amber-300",
      },
    }[tone] || {};

  if (collapsed) {
    return (
      <button
        type="button"
        onClick={toggle}
        className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full border ${palette.wrap} text-xs font-medium hover:opacity-100 opacity-80 transition ${className}`}
      >
        {glyphFor(14)}
        <span>{t("showTips") || "How it works"}</span>
        <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
          <path d="M3 4.5l3 3 3-3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
    );
  }

  return (
    <div
      // rounded-xl (12px) — matches the rest of the design system. Was
      // rounded-xl before, which made the panel feel "softer" than its
      // neighbors. Single radius across all cards keeps the page rhythm
      // tight.
      className={`relative rounded-xl border p-5 ${palette.wrap} ${className}`}
      role="note"
    >
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          {glyphFor(20)}
          <h3 className="font-bold text-base">{title}</h3>
        </div>
        <button
          type="button"
          onClick={toggle}
          aria-label={t("hideTips") || "Hide tips"}
          className="shrink-0 inline-flex items-center gap-1 text-xs font-medium opacity-70 hover:opacity-100 transition px-2 py-1 rounded-md hover:bg-black/5 dark:hover:bg-white/10"
        >
          <span>{t("hideTips") || "Hide tips"}</span>
          <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
            <path d="M3 7.5l3-3 3 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
      </div>

      <ol className="space-y-3">
        {steps.map((step, idx) => (
          <li key={idx} className="flex gap-3">
            <span
              className={`shrink-0 w-6 h-6 rounded-full ${palette.chip} text-xs font-bold inline-flex items-center justify-center`}
              aria-hidden="true"
            >
              {idx + 1}
            </span>
            <div className="flex-1 min-w-0">
              {step.title && <p className="font-semibold text-sm leading-snug">{step.title}</p>}
              {step.body && (
                <p className="text-[13px] leading-relaxed opacity-90 mt-0.5">{step.body}</p>
              )}
            </div>
          </li>
        ))}
      </ol>

      {footer && (
        <p className={`mt-4 pt-3 border-t border-current/10 text-[11px] leading-relaxed ${palette.accent}`}>
          {footer}
        </p>
      )}
    </div>
  );
}
