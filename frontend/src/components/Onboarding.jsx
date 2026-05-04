import { useState, useEffect, useMemo } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "../hooks/useAuth";
import { trackEvent } from "../hooks/useEventLog";

const STORAGE_KEY = "bonbox_onboarding_dismissed";
const WELCOME_KEY = "bonbox_welcome_seen";

/**
 * Vertical-specific suggestions. Shown in the first-run welcome modal so the
 * dashboard feels purpose-built for THIS owner from minute one. Falls back to
 * generic if the business_type isn't in the map.
 */
const VERTICAL_INTRO = {
  restaurant: {
    icon: "🍽️",
    headline: "Let's set up your restaurant",
    bullets: [
      "Log a Daily Close at end of shift — auto-tallies cash & cards",
      "Use Snap Receipt to scan supplier invoices in seconds",
      "Set staffing patterns once → AI predicts your weekend needs",
    ],
  },
  bar: {
    icon: "🍺",
    headline: "Let's set up your bar",
    bullets: [
      "Bar Pour tracks bottle pours and cost-per-drink automatically",
      "Daily Close at last call captures everything in 30 seconds",
      "AI flags wastage and over-pouring patterns",
    ],
  },
  retail: {
    icon: "🛍️",
    headline: "Let's set up your shop",
    bullets: [
      "Add inventory once → BonBox tracks stock and reorder needs",
      "Khata for customer credit, with reminder messages",
      "Snap supplier receipts to log expenses without typing",
    ],
  },
  cafe: {
    icon: "☕",
    headline: "Let's set up your café",
    bullets: [
      "Log sales by category (espresso, pastry, etc.) for profit insight",
      "Daily Close before you leave — never miss numbers",
      "Track staff tips fairly with the Tip Distribution module",
    ],
  },
  salon: {
    icon: "💈",
    headline: "Let's set up your salon",
    bullets: [
      "Log every service in 2 taps with Quick Sale",
      "Track stylist tips and commission separately",
      "Khata for repeat customers who pay monthly",
    ],
  },
  workshop: {
    icon: "🔧",
    headline: "Let's set up your workshop",
    bullets: [
      "Workshop Manager organises every job, parts, and labour",
      "Track customer credit (Khata) for invoiced jobs",
      "Daily Close summarises the day's revenue + outstanding work",
    ],
  },
  grocery: {
    icon: "🛒",
    headline: "Let's set up your shop",
    bullets: [
      "Add inventory items so you see margin on every sale",
      "Khata for regular customers paying monthly",
      "Daily Close = your day's takings in 30 seconds",
    ],
  },
};

const GENERIC_INTRO = {
  icon: "📊",
  headline: "Let's get you set up",
  bullets: [
    "Log your first sale — that's the most important step",
    "Snap a receipt to test the OCR (just take a photo)",
    "Ask BonBox AI 'how was today?' once you have data",
  ],
};


/**
 * First-run welcome modal — shows once per user on their first dashboard
 * visit, then never again. Driven by localStorage so dismissal sticks across
 * sessions on the same device. (Server-side state would be better long-term
 * but localStorage is fine for v1.)
 */
function WelcomeModal({ user, onClose }) {
  const intro = useMemo(() => {
    const t = (user?.business_type || "").toLowerCase();
    return VERTICAL_INTRO[t] || GENERIC_INTRO;
  }, [user]);

  const handleStart = () => {
    trackEvent("onboarding_started", "dashboard", user?.business_type || "unknown");
    onClose();
  };

  const handleSkip = () => {
    trackEvent("onboarding_welcome_skipped", "dashboard", null);
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4 animate-fadeIn">
      <div className="bg-white dark:bg-gray-800 rounded-2xl max-w-md w-full shadow-xl overflow-hidden">
        <div className="bg-gradient-to-br from-green-500 via-emerald-500 to-teal-500 p-6 text-white">
          <div className="text-5xl mb-2">{intro.icon}</div>
          <h2 className="text-xl font-bold">{intro.headline}</h2>
          <p className="text-sm text-green-50 mt-1 opacity-90">
            Welcome to BonBox{user?.business_name ? `, ${user.business_name}` : ""}.
            Three things will give you the most value first:
          </p>
        </div>
        <div className="p-6 space-y-3">
          {intro.bullets.map((b, i) => (
            <div key={i} className="flex items-start gap-3">
              <span className="flex items-center justify-center w-6 h-6 rounded-full bg-green-100 dark:bg-green-900/40 text-green-600 dark:text-green-400 font-bold text-sm shrink-0">
                {i + 1}
              </span>
              <p className="text-sm text-gray-700 dark:text-gray-200 leading-relaxed">{b}</p>
            </div>
          ))}
          <div className="flex gap-2 pt-2">
            <button
              onClick={handleSkip}
              className="px-4 py-2 text-sm text-gray-500 dark:text-gray-400 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition"
            >
              Skip
            </button>
            <button
              onClick={handleStart}
              className="flex-1 px-4 py-2 bg-green-600 hover:bg-green-700 text-white text-sm font-medium rounded-lg transition shadow-sm"
            >
              Let's go →
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}


/**
 * Onboarding checklist + first-run welcome.
 *
 * - Welcome modal: shows ONCE per user (local-storage flag). On dismiss,
 *   never reappears. Vertical-aware bullets.
 * - Checklist: shown until either total_sales >= 5 OR user dismisses. Tracks
 *   each step via trackEvent so we can measure completion in the admin panel.
 */
export default function Onboarding({ summary }) {
  const { user } = useAuth();
  const [dismissed, setDismissed] = useState(
    () => localStorage.getItem(STORAGE_KEY) === "true"
  );
  const [welcomeOpen, setWelcomeOpen] = useState(false);

  // First-run welcome — show once if user has no sales yet AND hasn't seen it
  useEffect(() => {
    if (!user || !summary) return;
    const seen = localStorage.getItem(WELCOME_KEY) === "true";
    if (seen) return;
    if (summary.total_sales > 0) {
      // User already started using the app on another device — mark seen, don't pop
      localStorage.setItem(WELCOME_KEY, "true");
      return;
    }
    setWelcomeOpen(true);
    trackEvent("onboarding_welcome_shown", "dashboard", user.business_type || "unknown");
  }, [user, summary]);

  const closeWelcome = () => {
    localStorage.setItem(WELCOME_KEY, "true");
    setWelcomeOpen(false);
  };

  const dailyGoal = user?.daily_goal || 0;
  const steps = [
    { id: "first_sale", label: "Log your first sale", to: "/sales", done: summary?.total_sales > 0 },
    { id: "expense_cat", label: "Set up expense categories", to: "/expenses", done: summary?.has_expense_categories },
    { id: "inventory", label: "Add an inventory item", to: "/inventory", done: summary?.has_inventory_items },
    { id: "daily_goal", label: "Set your daily revenue goal", to: "/profile", done: dailyGoal > 0 },
  ];

  const completedCount = steps.filter((s) => s.done).length;
  const allDone = completedCount === steps.length;

  // Track step completion (one event per step the moment it flips done)
  // Keyed by step id so we don't repeatedly fire on every render.
  useEffect(() => {
    if (!summary || !user) return;
    steps.forEach((s) => {
      const flagKey = `bonbox_onboarding_step_${s.id}_tracked`;
      if (s.done && !sessionStorage.getItem(flagKey)) {
        trackEvent("onboarding_step_completed", "dashboard", s.id);
        sessionStorage.setItem(flagKey, "1");
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summary?.total_sales, summary?.has_expense_categories, summary?.has_inventory_items, dailyGoal]);

  const handleDismiss = () => {
    localStorage.setItem(STORAGE_KEY, "true");
    trackEvent("onboarding_dismissed", "dashboard", `${completedCount}/${steps.length}`);
    setDismissed(true);
  };

  // Hide the checklist once the user has 5+ sales or has dismissed it.
  const showChecklist = !dismissed && !!summary && summary.total_sales < 5;

  return (
    <>
      {welcomeOpen && <WelcomeModal user={user} onClose={closeWelcome} />}
      {showChecklist && (
        <div className="bg-gradient-to-br from-blue-50 to-indigo-50 dark:from-blue-900/20 dark:to-indigo-900/20 border border-blue-200 dark:border-blue-800/50 rounded-2xl p-5 sm:p-6">
          <div className="flex items-start justify-between gap-3 mb-4">
            <div>
              <h2 className="text-lg font-semibold text-blue-900 dark:text-blue-100">
                {allDone ? "🎉 You're all set!" : "Welcome to BonBox — let's get you started"}
              </h2>
              <p className="text-sm text-blue-700 dark:text-blue-300 mt-1">
                {allDone
                  ? "You've completed setup. We'll hide this once you log a few more sales."
                  : `${completedCount} of ${steps.length} done`}
              </p>
            </div>
            <button
              onClick={handleDismiss}
              className="text-xs text-blue-600 dark:text-blue-400 hover:underline font-medium shrink-0"
            >
              Dismiss
            </button>
          </div>

          {/* Progress bar */}
          <div className="w-full h-1.5 bg-blue-100 dark:bg-blue-900/40 rounded-full overflow-hidden mb-4">
            <div
              className="h-full bg-gradient-to-r from-green-400 to-emerald-500 transition-all duration-500"
              style={{ width: `${(completedCount / steps.length) * 100}%` }}
            />
          </div>

          <ul className="space-y-2.5">
            {steps.map((step) => (
              <li key={step.id} className="flex items-center gap-3">
                {step.done ? (
                  <span className="flex items-center justify-center w-6 h-6 rounded-full bg-green-500 text-white text-xs font-bold shrink-0">
                    ✓
                  </span>
                ) : (
                  <span className="flex items-center justify-center w-6 h-6 rounded-full border-2 border-blue-300 dark:border-blue-600 shrink-0" />
                )}
                {step.to ? (
                  <Link
                    to={step.to}
                    className={`text-sm font-medium ${
                      step.done
                        ? "text-gray-500 dark:text-gray-400 line-through"
                        : "text-blue-700 dark:text-blue-300 hover:underline"
                    }`}
                  >
                    {step.label}
                  </Link>
                ) : (
                  <span
                    className={`text-sm font-medium ${
                      step.done
                        ? "text-gray-500 dark:text-gray-400 line-through"
                        : "text-blue-700 dark:text-blue-300"
                    }`}
                  >
                    {step.label}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
