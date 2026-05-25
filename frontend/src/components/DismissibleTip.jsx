import { useState, useEffect } from "react";
import { useLanguage } from "../hooks/useLanguage";
import { Icon } from "./ui";

/**
 * DismissibleTip — small contextual hint that teaches owners how a
 * section works. Persists dismissal per-tip-id in localStorage so the
 * tip never reappears.
 *
 * Re-skinned May 2026 to match the new SectionBanner aesthetic — neutral
 * gray surface by default, Lucide info icon (not an emoji bulb), and
 * the same border / radius / padding rhythm as the Card primitive. The
 * old `bg-gray-50/70` "lightbulb in a green box" look made tips
 * visually compete with primary content; the new neutral treatment
 * recedes until the owner actually reads it.
 *
 * API is back-compatible:
 *   • `icon` prop still accepted — passed strings render as text (legacy
 *     emoji callers still work), but for new code prefer Lucide names
 *     via the `iconName` prop or omit and let it default to "Info".
 *   • `tone` still accepted with values info / neutral / amber; mapped
 *     internally to the new gray / amber severities.
 *
 * Usage:
 *   <DismissibleTip
 *     id="tax-autopilot-intro"
 *     title="How Tax Autopilot works"
 *   >
 *     We watch your sales + expenses and tell you exactly what Moms you owe.
 *   </DismissibleTip>
 */

const STORAGE_KEY = "bonbox_tips_dismissed";

function getDismissed() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveDismissed(ids) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(ids));
  } catch {
    /* localStorage may be disabled — silently ignore, tips just won't persist */
  }
}

export function isTipDismissed(id) {
  return getDismissed().includes(id);
}

/** Resurface every dismissed tip (used by a "Show tips again" admin/profile action). */
export function resetAllTips() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}

// Tone → palette mapping. Mirrors SectionBanner so a tip and a banner
// on the same page read as one design system. Old `info` callers now
// see the neutral gray surface (was green-tinted) — intentional: the
// app is moving away from green-glow ambient color.
const TONE_STYLE = {
  info: {
    wrap: "bg-gray-50 border-gray-200 dark:bg-gray-800/60 dark:border-gray-700",
    icon: "text-gray-500 dark:text-gray-400",
    title: "text-gray-900 dark:text-gray-100",
    body: "text-gray-700 dark:text-gray-300",
  },
  neutral: {
    wrap: "bg-gray-50 border-gray-200 dark:bg-gray-800/60 dark:border-gray-700",
    icon: "text-gray-500 dark:text-gray-400",
    title: "text-gray-900 dark:text-gray-100",
    body: "text-gray-700 dark:text-gray-300",
  },
  amber: {
    wrap: "bg-amber-50 border-amber-200 dark:bg-amber-900/20 dark:border-amber-800/40",
    icon: "text-amber-600 dark:text-amber-400",
    title: "text-gray-900 dark:text-gray-100",
    body: "text-gray-700 dark:text-gray-300",
  },
};

export default function DismissibleTip({
  id,
  // `icon` kept for API compat: string emojis still render. New code
  // should pass `iconName` for a Lucide icon instead.
  icon = null,
  iconName = "AlertTriangle",  // Lucide default — using AlertTriangle as our generic "heads up"
  title,
  children,
  tone = "info",
  className = "",
}) {
  const { t } = useLanguage();
  // Start hidden to avoid a flash before localStorage is read.
  const [hidden, setHidden] = useState(true);

  useEffect(() => {
    if (!id) return;
    setHidden(isTipDismissed(id));
  }, [id]);

  if (hidden) return null;

  const dismiss = () => {
    if (!id) return;
    const next = Array.from(new Set([...getDismissed(), id]));
    saveDismissed(next);
    setHidden(true);
  };

  const style = TONE_STYLE[tone] || TONE_STYLE.info;
  // Legacy `icon` string is treated as opaque text content (emoji
  // callers still see their emoji). New callers omit `icon` and get
  // a Lucide icon via `iconName`.
  const showLegacyEmoji = typeof icon === "string" && icon.length > 0;

  return (
    <div
      className={`relative rounded-xl border p-4 pr-12 ${style.wrap} ${className}`}
      role="note"
    >
      <div className="flex items-start gap-3">
        <div className={`shrink-0 ${style.icon} mt-0.5`} aria-hidden="true">
          {showLegacyEmoji ? (
            <span className="text-lg leading-none">{icon}</span>
          ) : (
            <Icon name={iconName} size={18} />
          )}
        </div>
        <div className="flex-1 min-w-0">
          {title && (
            <p className={`text-[14px] font-semibold ${style.title} mb-1 leading-snug`}>
              {title}
            </p>
          )}
          <div className={`text-[13.5px] ${style.body} leading-relaxed`}>
            {children}
          </div>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t("dismissTip") || "Dismiss tip"}
        className="absolute top-3 right-3 w-7 h-7 rounded-full inline-flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/10 transition text-gray-400 hover:text-gray-700 dark:text-gray-500 dark:hover:text-gray-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-gray-400"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
