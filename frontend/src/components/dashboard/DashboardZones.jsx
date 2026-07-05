/**
 * DashboardZones — the orchestrator that turns `dashboardCardSets.js`
 * into rendered output.
 *
 * Renders, in order:
 *   1. fullPageStates — if any matches, REPLACES everything below.
 *   2. notices (via PageNotices) — banner stack capped at 2 visible.
 *   3. zone1 → zone2 → zone3.
 *
 * Per-zone rules:
 *   • Iterate the declarative entries.
 *   • For each entry, evaluate `renderIf(ctx)` (default: render).
 *   • Resolve `props` (object OR `(ctx) => ({...})`).
 *   • Look up `component` in the `registry` (string → React component).
 *     Unknown component names render nothing (fail quiet — same pattern
 *     as Icon's Circle fallback).
 *   • Cards in a `Row` compound render side-by-side at lg+ and stack
 *     on `<lg`.
 *
 * Why a string → component registry (vs importing in the config):
 *   • Keeps `dashboardCardSets.js` pure data — no React imports there.
 *   • Lets DashboardPage code-split the heavy cards (e.g.
 *     RevenueTrendChart) without rebuilding the config tree.
 *   • Makes it trivial to mock components in tests — just inject a fake
 *     registry that returns `<div data-testid="X" />`.
 *
 * Zone 3 dynamic count:
 *   AllClearCard renders only when no OTHER Zone 3 card matched. We
 *   pre-compute `ctx.zone3DynamicCount` by filtering ZONE3_DYNAMIC_IDS
 *   through their predicates and pass an augmented ctx into the zone3
 *   render pass. This keeps the AllClearCard predicate trivial:
 *   `(ctx) => ctx.zone3DynamicCount === 0`.
 */
import React, { useMemo } from "react";
import PageNotices from "./PageNotices";
import {
  DASHBOARD_CARD_SET,
  DASHBOARD_ZONE_KEYS,
  ZONE3_DYNAMIC_IDS,
} from "../../config/dashboardCardSets";

/**
 * resolveProps — handle the static-object | function-returns-object split.
 * Always returns a plain object.
 */
function resolveProps(propsSpec, ctx) {
  if (typeof propsSpec === "function") {
    try {
      const out = propsSpec(ctx);
      return out && typeof out === "object" ? out : {};
    } catch {
      // Fail quiet — a broken props function shouldn't crash the dashboard.
      return {};
    }
  }
  return propsSpec && typeof propsSpec === "object" ? propsSpec : {};
}

/**
 * shouldRender — evaluate a renderIf predicate safely. Missing predicate
 * means "always render". Throwing predicate fails closed (don't render)
 * — same contract as the entitlement fail-closed default.
 */
function shouldRender(entry, ctx) {
  if (typeof entry?.renderIf !== "function") return true;
  try {
    return Boolean(entry.renderIf(ctx));
  } catch {
    return false;
  }
}

/**
 * Row — compound layout primitive used inside zones. Children render
 * side-by-side on lg+ and stack on `<lg`. The children prop is the
 * rendered React nodes, not the entry config — the orchestrator
 * resolves children first then wraps.
 */
function Row({ children, className = "" }) {
  // Skip empty rows entirely — happens when every child gates off.
  const visible = React.Children.toArray(children).filter(Boolean);
  if (visible.length === 0) return null;
  return (
    <div
      className={
        "grid grid-cols-1 lg:grid-cols-2 gap-4 " + (className || "")
      }
      data-component="Row"
    >
      {visible}
    </div>
  );
}

/**
 * renderEntry — render a single zone entry (card or Row).
 *
 * Returns null when:
 *   • renderIf returns false
 *   • The component name is unknown in the registry
 *   • A Row's children all gate off
 */
function renderEntry(entry, ctx, registry, keyPrefix = "") {
  if (!entry || !shouldRender(entry, ctx)) return null;

  const key = `${keyPrefix}${entry.id}`;

  // The `Row` compound is special — children are entries, not a
  // pre-built React node.
  if (entry.component === "Row") {
    const childNodes = (entry.children || [])
      .map((child) => renderEntry(child, ctx, registry, `${key}__`))
      .filter(Boolean);
    if (childNodes.length === 0) return null;
    return (
      <Row key={key} className={entry.className}>
        {childNodes}
      </Row>
    );
  }

  const Component = registry[entry.component];
  if (!Component) {
    // Unknown component name. Fail quiet — same pattern as Icon's
    // Circle fallback. A warning here would noise up dev consoles
    // during incremental migrations.
    return null;
  }

  const propsFromCtx = resolveProps(entry.props, ctx);
  // Always thread `ctx` through so cards that read additional fields
  // (OutstandingFakturaCard, BusinessHealthCard, etc.) don't need
  // bespoke wiring in DashboardPage.
  return <Component key={key} ctx={ctx} {...propsFromCtx} />;
}

/**
 * computeZone3DynamicCount — how many Zone 3 cards (other than the
 * AllClearCard itself) would render given the current ctx? Used by
 * AllClearCard's renderIf to decide whether to render the Inbox-Zero
 * empty state.
 */
function computeZone3DynamicCount(cardSet, ctx) {
  const zone3 = cardSet?.zone3 || [];
  return zone3.reduce((acc, entry) => {
    if (!ZONE3_DYNAMIC_IDS.includes(entry.id)) return acc;
    return acc + (shouldRender(entry, ctx) ? 1 : 0);
  }, 0);
}

/**
 * DashboardZones
 *
 * Props:
 *   • ctx       — the assembled Dashboard context.
 *   • registry  — string → React component map. Required.
 *   • cardSet   — optional. Defaults to the exported DASHBOARD_CARD_SET
 *                  but allows tests / variants to inject a custom tree.
 *   • zoneIds   — optional. Subset of ["zone1", "zone2", "zone3"] to
 *                  render. Defaults to all three.
 */
export default function DashboardZones({
  ctx = {},
  registry = {},
  cardSet = DASHBOARD_CARD_SET,
  zoneIds = DASHBOARD_ZONE_KEYS,
  className = "",
}) {
  // 0. HOOKS FIRST — rules-of-hooks. This useMemo must run on EVERY render,
  //    before the full-page early-return below. When a brand-new owner records
  //    their first sale, `isFirstRun` flips true→false with no remount; if the
  //    early return sat above this hook, the hook count would change between
  //    renders → "Rendered more hooks than during the previous render" crash on
  //    the Home screen (self-healed by SelfHealBoundary but it flashed + spammed
  //    the client-error beacon on every first-run user). Cheap to always run.
  const zone3DynamicCount = useMemo(
    () => computeZone3DynamicCount(cardSet, ctx),
    [cardSet, ctx],
  );

  // 1. Full-page replacement state — first match wins, hides everything
  //    below. (Spec lists only firstRun today; others can be added
  //    without touching this orchestrator.)
  const fullPageMatch = (cardSet?.fullPageStates || []).find((entry) =>
    shouldRender(entry, ctx),
  );
  if (fullPageMatch) {
    const Component = registry[fullPageMatch.component];
    if (Component) {
      const props = resolveProps(fullPageMatch.props, ctx);
      return (
        <div className={className} data-component="DashboardZones" data-fullpage={fullPageMatch.id}>
          <Component ctx={ctx} {...props} />
        </div>
      );
    }
    // Component missing — fall through and render zones normally.
  }

  // 2. Augmented ctx passed down so AllClearCard's renderIf sees the right
  //    Zone-3 count.
  const ctxWithZone3 = { ...ctx, zone3DynamicCount };

  // 3. Render notices.
  const noticesNode = (
    <PageNotices
      notices={cardSet?.notices || []}
      ctx={ctxWithZone3}
      registry={registry}
    />
  );

  // 4. Render zones.
  const zoneNodes = zoneIds.map((zoneKey) => {
    const entries = cardSet?.[zoneKey] || [];
    const rendered = entries
      .map((entry) => renderEntry(entry, ctxWithZone3, registry, `${zoneKey}__`))
      .filter(Boolean);

    if (rendered.length === 0) {
      // Empty zone — render nothing (per spec: empty Zone 3 reads as
      // "broken" so we omit it entirely).
      return null;
    }

    return (
      <section
        key={zoneKey}
        data-zone={zoneKey.replace("zone", "")}
        className="space-y-4"
      >
        {rendered}
      </section>
    );
  });

  return (
    <div
      className={"space-y-6 " + (className || "")}
      data-component="DashboardZones"
    >
      {noticesNode}
      {zoneNodes}
    </div>
  );
}
