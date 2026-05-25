/**
 * UpgradeNudge tier-flicker regression test.
 *
 * Bug #195 follow-up: after the partial fix in commit 4a66e03, Manoj
 * reported that trial users STILL briefly saw "Upgrade to Starter+"
 * nudges on cold page loads, then a refresh showed the right state.
 *
 * Root cause: many page-level consumers rendered <UpgradeNudge> based on
 * `hasFeature(...)` returning false during the ~150-300ms cold-load
 * window before /billing/entitlements responded.  hasFeature() always
 * returns false while the hook is in `data === null` (fail-closed Free
 * default), so trial / Starter / Pro users saw the locked surface flash
 * before the real payload arrived.
 *
 * Two fixes locked in this commit:
 *
 *   1. UpgradeNudge accepts an optional `feature` prop.  When set, it
 *      self-gates on isReady + hasFeature(feature): returns null while
 *      loading, and null when the user already has the feature.  Every
 *      future callsite that wants automatic flicker-immunity can use
 *      this — no surrounding `isReady && !hasFeature(...)` ternary
 *      required.
 *
 *   2. Existing page-level callers (FakturaPage, ExpiryPage,
 *      OnboardingPage Step 4, Layout sidebar) thread isReady/entReady
 *      through their own gates and render nothing (or a skeleton)
 *      during loading.
 *
 * This test covers fix #1.  Fix #2 is per-page; the Locked.test.jsx
 * three-state test covers the foundational <Locked> wrapper.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("../services/api", () => ({
  default: { get: vi.fn() },
}));

import api from "../services/api";
import { EntitlementsProvider } from "../hooks/useEntitlements";
import { LanguageProvider } from "../hooks/useLanguage";
import UpgradeNudge from "../components/ui/UpgradeNudge";


function withProviders(ui) {
  return render(
    <MemoryRouter>
      <LanguageProvider>
        <EntitlementsProvider>{ui}</EntitlementsProvider>
      </LanguageProvider>
    </MemoryRouter>,
  );
}


beforeEach(() => {
  api.get.mockReset();
});


describe("<UpgradeNudge feature=...> — tier-flicker self-gating", () => {
  it("renders nothing while entitlements are loading", async () => {
    // Hold the /billing/entitlements promise so the provider stays in
    // the `data === null` loading state for the duration of the assertion.
    let resolveFn;
    api.get.mockImplementationOnce(
      () => new Promise((r) => { resolveFn = r; }),
    );

    withProviders(
      <UpgradeNudge
        intent="card"
        tier="starter"
        feature="bank_auto_reconcile"
        benefit="Auto-match bank lines to open fakturaer"
        ctaLabel="See Starter"
      />,
    );

    // The fetch is in flight — we're in the loading window the flicker
    // bug occupies. The nudge MUST be absent from the DOM.
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(
      screen.queryByText(/Auto-match bank lines/i),
    ).toBeNull();
    expect(
      screen.queryByText(/See Starter/i),
    ).toBeNull();

    // Resolve to a Free user → nudge appears as expected.
    resolveFn({
      data: {
        plan: "free",
        raw_plan: "free",
        is_paid: false,
        in_trial: false,
        caps: {},
        features: { bank_auto_reconcile: false },
        min_plan_by_feature: { bank_auto_reconcile: "starter" },
        plans: {},
      },
    });
    await screen.findByText(/Auto-match bank lines/i);
  });

  it("renders nothing when the user already has the feature (e.g. trial / Starter)", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        plan: "starter",
        raw_plan: "starter",
        is_paid: true,
        in_trial: false,
        caps: {},
        features: { bank_auto_reconcile: true },
        min_plan_by_feature: { bank_auto_reconcile: "starter" },
        plans: {},
      },
    });

    withProviders(
      <UpgradeNudge
        intent="card"
        tier="starter"
        feature="bank_auto_reconcile"
        benefit="Auto-match bank lines to open fakturaer"
        ctaLabel="See Starter"
      />,
    );

    // Wait for the entitlements fetch to settle.
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    // After the fetch settles a Starter user with the feature must NOT
    // see the upgrade nudge — the parent rendered it unconditionally
    // but the component self-gated.
    await waitFor(() => {
      expect(screen.queryByText(/Auto-match bank lines/i)).toBeNull();
    });
  });

  it("renders the nudge for a confirmed Free user without the feature", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        plan: "free",
        raw_plan: "free",
        is_paid: false,
        in_trial: false,
        caps: {},
        features: { bank_auto_reconcile: false },
        min_plan_by_feature: { bank_auto_reconcile: "starter" },
        plans: {},
      },
    });

    withProviders(
      <UpgradeNudge
        intent="card"
        tier="starter"
        feature="bank_auto_reconcile"
        benefit="Auto-match bank lines to open fakturaer"
        ctaLabel="See Starter"
      />,
    );

    // Once the Free entitlements land, the upsell appears.
    await screen.findByText(/Auto-match bank lines/i);
  });

  it("renders unconditionally when no `feature` prop is passed (legacy behavior preserved)", async () => {
    // Hold the API so we stay in loading. Legacy callsites pass no
    // `feature` prop and expect the nudge to render right away — their
    // parents handle the gating.  Backward compat contract.
    let resolveFn;
    api.get.mockImplementationOnce(
      () => new Promise((r) => { resolveFn = r; }),
    );

    withProviders(
      <UpgradeNudge
        intent="card"
        tier="starter"
        benefit="Generic upsell, parent handles gating"
        ctaLabel="See plans"
      />,
    );

    // No feature prop → no self-gating → nudge renders immediately.
    await screen.findByText(/Generic upsell/i);
    // Cleanup
    resolveFn({
      data: {
        plan: "free", raw_plan: "free", is_paid: false, in_trial: false,
        caps: {}, features: {}, min_plan_by_feature: {}, plans: {},
      },
    });
  });
});
