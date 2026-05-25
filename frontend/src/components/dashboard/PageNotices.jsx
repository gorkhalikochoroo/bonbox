/**
 * PageNotices — the banner stack slot for SmartDrift / TrialBanner /
 * DemoActiveBanner / PushOptInPrompt and any future top-of-page notice.
 *
 * Why a dedicated slot (vs banners sprinkled inside zones):
 *   • Caps visible banners at 2 — every extra banner crowds out the
 *     hero (Daily Brief). Banners beyond 2 collapse into a "+N more"
 *     row the user can expand.
 *   • Stable order — the config in `dashboardCardSets.js` defines order;
 *     this component preserves it. Without a stable slot, banner order
 *     drifts as new conditions get bolted onto DashboardPage.
 *   • Renders nothing when no banner matches — no empty wrapper space
 *     above the hero.
 *
 * Composition rules (doctrine):
 *   • All surfaces are neutral. Severity tinting only inside individual
 *     banner components (which use SectionBanner under the hood and
 *     follow the gray-50 / amber-50 / red-50 surface recipe).
 *   • Spacing: vertical `space-y-2` between stacked banners — tight
 *     enough to read as a stack, loose enough not to look like a flash
 *     popup. The wrapper inherits the parent's `space-y-6` rhythm.
 *
 * Props:
 *   • notices — array of { id, component, renderIf(ctx) } from
 *               dashboardCardSets.js. Order = render order.
 *   • ctx     — the assembled Dashboard context.
 *   • registry — { ComponentName: ReactComponent } map. Caller injects
 *               so PageNotices itself stays import-free of the actual
 *               banner components (lets DashboardPage code-split them
 *               and avoid circular imports).
 *   • cap     — max banners visible at once (default 2). Overflow goes
 *               behind a "+N more" disclosure.
 */
import React, { useState } from "react";
import { ChevronDown } from "lucide-react";
import { useLanguage } from "../../hooks/useLanguage";

export default function PageNotices({
  notices = [],
  ctx = {},
  registry = {},
  cap = 2,
  className = "",
}) {
  const { t } = useLanguage();
  const [showOverflow, setShowOverflow] = useState(false);

  // Filter notices through their predicates. A notice with no renderIf
  // is treated as "always render" — matches the config semantics.
  const matched = notices
    .map((n) => {
      const pass =
        typeof n.renderIf !== "function" ? true : Boolean(n.renderIf(ctx));
      return pass ? n : null;
    })
    .filter(Boolean);

  if (matched.length === 0) return null;

  const visible = matched.slice(0, cap);
  const overflow = matched.slice(cap);

  function renderOne(notice) {
    const Component = registry[notice.component];
    if (!Component) {
      // Unknown component name — fail quiet rather than crash the page.
      // (Same pattern as Icon's `Circle` fallback.)
      return null;
    }
    const propsFromCtx =
      typeof notice.props === "function"
        ? notice.props(ctx) || {}
        : notice.props || {};
    return <Component key={notice.id} {...propsFromCtx} />;
  }

  return (
    <div
      className={"space-y-2 " + (className || "")}
      data-component="PageNotices"
    >
      {visible.map((n) => renderOne(n))}

      {overflow.length > 0 && (
        <div>
          <button
            type="button"
            onClick={() => setShowOverflow((v) => !v)}
            className={
              "inline-flex items-center gap-1.5 text-xs font-medium " +
              "text-gray-700 dark:text-gray-300 " +
              "hover:text-gray-900 dark:hover:text-gray-100 " +
              "focus-visible:outline-none focus-visible:ring-2 " +
              "focus-visible:ring-gray-900 dark:focus-visible:ring-gray-100 " +
              "focus-visible:ring-offset-1 rounded px-1 py-0.5 " +
              "transition-colors"
            }
            aria-expanded={showOverflow}
          >
            <ChevronDown
              size={14}
              strokeWidth={2}
              aria-hidden="true"
              className={
                "transition-transform " + (showOverflow ? "rotate-180" : "")
              }
            />
            {showOverflow
              ? t("dashNoticesHideMore", "Hide {n} more notice")
                  .replace("{n}", String(overflow.length))
              : t("dashNoticesShowMore", "+{n} more notice")
                  .replace("{n}", String(overflow.length))}
          </button>
          {showOverflow && (
            <div className="space-y-2 mt-2">
              {overflow.map((n) => renderOne(n))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
