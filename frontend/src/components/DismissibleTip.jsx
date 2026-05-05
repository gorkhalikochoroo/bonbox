import { useState, useEffect } from "react";

/**
 * DismissibleTip — small contextual hint that teaches owners how a section works.
 *
 * Persists dismissal per-tip-id in localStorage so the tip never reappears.
 * Use one near the top of major sections (Tax Autopilot, Daily Close, Inventory, …)
 * to onboard without a heavy modal flow. Tone defaults to BonBox green.
 *
 * <DismissibleTip
 *   id="tax-autopilot-intro"
 *   icon="💡"
 *   title="How Tax Autopilot works"
 * >
 *   We watch your sales + expenses and tell you exactly what Moms you owe and when.
 * </DismissibleTip>
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

export default function DismissibleTip({
  id,
  icon = "\u{1F4A1}",
  title,
  children,
  tone = "info",
  className = "",
}) {
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

  const palette =
    {
      info:
        "bg-green-50/70 dark:bg-green-900/15 border-green-200/70 dark:border-green-800/40 text-green-900 dark:text-green-100",
      neutral:
        "bg-gray-50 dark:bg-gray-800/50 border-gray-200 dark:border-gray-700 text-gray-800 dark:text-gray-100",
      amber:
        "bg-amber-50/70 dark:bg-amber-900/15 border-amber-200/70 dark:border-amber-800/40 text-amber-900 dark:text-amber-100",
    }[tone] || "";

  return (
    <div
      className={`relative rounded-xl border p-4 pr-12 text-sm leading-relaxed ${palette} ${className}`}
      role="note"
    >
      <div className="flex items-start gap-3">
        <span className="text-lg shrink-0" aria-hidden="true">{icon}</span>
        <div className="flex-1 min-w-0">
          {title && <p className="font-semibold mb-1">{title}</p>}
          <div className="opacity-90">{children}</div>
        </div>
      </div>
      <button
        type="button"
        onClick={dismiss}
        aria-label="Dismiss tip"
        className="absolute top-3 right-3 w-7 h-7 rounded-full inline-flex items-center justify-center hover:bg-black/5 dark:hover:bg-white/10 transition text-current opacity-60 hover:opacity-100"
      >
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
          <path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
        </svg>
      </button>
    </div>
  );
}
