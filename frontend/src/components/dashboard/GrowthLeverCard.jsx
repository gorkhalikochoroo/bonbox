/**
 * GrowthLeverCard — Pro-only Zone 2 informative card.
 *
 * The PM critique flagged that the v1 Dashboard had no "what should I
 * change to make more money?" surface. This card fills that gap: it
 * surfaces 1-2 ranked growth signals from event/sale pattern analysis.
 *
 * Example signal:
 *   title: "Friday events earn 73% more per ticket"
 *   body:  "Your last 3 Friday events averaged 2,340 DKK/ticket vs 1,350 weekday"
 *   ctaLabel: "See breakdown →"
 *   ctaHref:  "/reports?range=weekday-comparison"
 *
 * Doctrine compliance:
 *   • Neutral surface — bg-white / dark:bg-gray-900, rounded-xl, 1px
 *     gray-200 border. The card surface itself NEVER changes color even
 *     for the most exciting growth signal. Color is signal, not vibe.
 *   • TrendingUp icon is text-emerald-600 — the only colored pixel
 *     (besides the small Sparkles "Pro" tag in the corner).
 *   • Sparkles tag uses text-amber-500 — small, in the corner, doesn't
 *     compete with the heading. This signals "Pro feature" without
 *     painting the whole card.
 *
 * Data:
 *   • Reads `ctx.growthSignals` — array of { title, body, ctaLabel, ctaHref }.
 *     Renders top 1 (default) or top 2 when `maxSignals=2` is passed.
 *   • The orchestrator's renderIf guards this card on
 *     `ctx.has("growth_intelligence") && growthSignals.length > 0` so
 *     the card itself never has to render a "no signals" empty state.
 *
 * Multi-barrier note: the backend `/api/dashboard/growth-signals` endpoint
 * re-checks PLAN_FEATURES server-side. This frontend gate is the L9
 * advisory layer; the server is L7 fail-closed.
 */
import React from "react";
import { Link } from "react-router-dom";
import { TrendingUp } from "lucide-react";
import { Icon } from "../ui";
import { useLanguage } from "../../hooks/useLanguage";

export default function GrowthLeverCard({
  ctx = {},
  maxSignals = 1,
  className = "",
}) {
  const { t } = useLanguage();
  const signals = Array.isArray(ctx?.growthSignals)
    ? ctx.growthSignals.slice(0, Math.max(1, Math.min(2, maxSignals)))
    : [];

  if (signals.length === 0) return null;

  return (
    <div
      className={
        "relative rounded-xl border border-gray-200 dark:border-gray-800 " +
        "bg-white dark:bg-gray-900 p-5 sm:p-6 " +
        (className || "")
      }
      data-zone="2"
      data-component="GrowthLeverCard"
    >
      {/* Pro tag — corner. Small + amber so it reads as "feature tag",
          not as a competing focal point. */}
      <div
        className={
          "absolute top-3 right-3 inline-flex items-center gap-1 " +
          "text-[10px] font-semibold uppercase tracking-wider " +
          "text-amber-600 dark:text-amber-400"
        }
        aria-label={t("dashGrowthProTag", "Pro feature")}
      >
        <Icon
          name="Sparkles"
          size={14}
          strokeWidth={2}
          className="text-amber-500 dark:text-amber-400"
        />
        <span>{t("dashGrowthProTagLabel", "Pro")}</span>
      </div>

      <div className="flex items-start gap-3 pr-12">
        <div
          className={
            "shrink-0 inline-flex items-center justify-center " +
            "w-9 h-9 rounded-full bg-gray-50 dark:bg-gray-800 " +
            "border border-gray-200 dark:border-gray-800"
          }
          aria-hidden="true"
        >
          <TrendingUp
            size={18}
            strokeWidth={2}
            className="text-emerald-600 dark:text-emerald-400"
          />
        </div>

        <div className="flex-1 min-w-0">
          <p
            className={
              "text-[11px] font-semibold uppercase tracking-wider " +
              "text-gray-400 dark:text-gray-500 mb-1"
            }
          >
            {t("dashGrowthInsightTitle", "Growth insight")}
          </p>

          <div className="space-y-4">
            {signals.map((sig, i) => (
              <div key={sig?.id || `${i}-${sig?.title || ""}`}>
                <h3 className="text-base font-semibold text-gray-900 dark:text-gray-100 leading-snug">
                  {sig?.title || t("dashGrowthSignalTitleFallback", "Untitled insight")}
                </h3>
                {sig?.body && (
                  <p className="text-sm text-gray-700 dark:text-gray-300 mt-1 leading-relaxed">
                    {sig.body}
                  </p>
                )}
                {sig?.ctaLabel && sig?.ctaHref && (
                  <div className="mt-2">
                    <Link
                      to={sig.ctaHref}
                      className={
                        "inline-flex items-center gap-1 text-xs font-medium " +
                        "text-gray-700 dark:text-gray-300 " +
                        "hover:text-gray-900 dark:hover:text-gray-100 " +
                        "transition-colors focus-visible:outline-none " +
                        "focus-visible:ring-2 focus-visible:ring-gray-900 " +
                        "dark:focus-visible:ring-gray-100 " +
                        "focus-visible:ring-offset-1 rounded px-1 py-0.5"
                      }
                    >
                      {sig.ctaLabel}
                      <span aria-hidden="true">→</span>
                    </Link>
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
