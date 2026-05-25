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
 *   • cap     — DEPRECATED.  The original design capped visible banners
 *               at 2 and put the rest behind a "+N more" disclosure.
 *               That broke in May 2026 when notice components started
 *               self-vetoing (returning null based on data they fetch
 *               internally — e.g. BankConsentExpiryBanner returns null
 *               when no bank is within its 14-day window).  PageNotices
 *               counts those as overflow because renderIf says "yes,
 *               show me" but the component then renders nothing → user
 *               sees "+1 more notice" and clicks it to find an empty
 *               box.  We dropped the cap entirely; each notice
 *               component's own self-veto + tight renderIf are enough
 *               to keep the stack short (typically 0-1 visible in
 *               practice).  Prop kept for API compat but ignored.
 */
import React from "react";

export default function PageNotices({
  notices = [],
  ctx = {},
  registry = {},
  // `cap` prop accepted but ignored — kept in the signature for callsite
  // backward compatibility (DashboardPage still passes cap={2}).  See
  // JSDoc above for why the cap was removed.
  className = "",
  // eslint-disable-next-line no-unused-vars
  cap,
}) {

  // Filter notices through their predicates AND component-resolvability.
  // A notice with no renderIf is treated as "always render" — matches the
  // config semantics.  We also drop any notice whose component name isn't
  // in the registry: otherwise it would pass renderIf, count toward the
  // overflow disclosure ("+1 more notice"), and then render nothing when
  // expanded — the May 2026 bug where the dashboard advertised "+1 more"
  // but the expansion was an empty box.  Filtering here keeps the count
  // honest end-to-end (collapsed pill, expanded list, ARIA exposure).
  const matched = notices
    .map((n) => {
      const pass =
        typeof n.renderIf !== "function" ? true : Boolean(n.renderIf(ctx));
      if (!pass) return null;
      // Drop notices with unresolvable component names.  Logged once via
      // console.warn so the next dev sees the misconfig immediately.
      if (!registry[n.component]) {
        if (typeof console !== "undefined" && console.warn) {
          console.warn(
            "PageNotices: dropping notice with unknown component name",
            { id: n.id, component: n.component },
          );
        }
        return null;
      }
      return n;
    })
    .filter(Boolean);

  if (matched.length === 0) return null;

  function renderOne(notice) {
    // Defensive — `matched` already filtered out unresolvable components,
    // so this lookup should always hit.  Keep the null-guard as a final
    // belt-and-braces in case the registry changes mid-render.
    const Component = registry[notice.component];
    if (!Component) return null;
    const propsFromCtx =
      typeof notice.props === "function"
        ? notice.props(ctx) || {}
        : notice.props || {};
    return <Component key={notice.id} {...propsFromCtx} />;
  }

  // Render every matched notice inline.  Each notice component is
  // responsible for its own self-veto (returning null when it has
  // nothing meaningful to show).  We don't try to second-guess that —
  // attempting a "+N more" overflow disclosure required us to count
  // notices BEFORE knowing whether they'd actually render, which
  // produced empty disclosures whenever a self-vetoing component sat
  // behind the cap.  Suppress the lint warning about unused `t` and
  // `cap` — both stay in the signature for API compat.
  return (
    <div
      className={"space-y-2 " + (className || "")}
      data-component="PageNotices"
    >
      {matched.map((n) => renderOne(n))}
    </div>
  );
}
