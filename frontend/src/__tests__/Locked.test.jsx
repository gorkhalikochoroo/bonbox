/**
 * Tests for the <Locked> tier-gating wrapper.
 *
 * The component's job is to be the LAST line of UI defense before a
 * Free user can interact with a Pro-only feature. The contract:
 *
 *   • When the feature is unlocked → render children verbatim, no
 *     wrapping div, no overlay, full pointer access.
 *   • When the feature is LOCKED → still render children visibly (so
 *     the user can see what they're missing), but:
 *       - Set aria-hidden="true" on the children container
 *       - Apply pointer-events: none + opacity reduction
 *       - Cover the children with a transparent click-overlay button
 *         that opens the upgrade prompt
 *       - Show a small Tier badge in the corner
 *   • The lock state must be derived correctly from useEntitlements:
 *       - hasFeature(feature) === false → locked
 *       - hasFeature(feature) === true  → unlocked
 *       - For atCap mode: isAtCap(capKey, current) → locked
 *
 * If any of these regress, a Free user could click straight through
 * the lock to a Pro-only handler. Backend gates would still block the
 * actual API call, but the UI deceit alone is a serious bug.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// EntitlementsProvider now reads the signed-in user (the logout->login
// entitlements fix), so it needs an auth context to mount.
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1 }, loading: false }),
}));

vi.mock("../services/api", () => ({
  default: { get: vi.fn() },
}));

import api from "../services/api";
import { EntitlementsProvider } from "../hooks/useEntitlements";
import { LanguageProvider } from "../hooks/useLanguage";
import { Locked } from "../components/Entitlement";


function ProtectedButton({ onClick, label = "Run AI Anomaly Scan" }) {
  // The "feature" the test pretends a Free user is trying to use.
  // The handler is what would fire if Locked failed to block clicks.
  return (
    <button onClick={onClick} data-testid="protected-button">{label}</button>
  );
}


/** Wraps a test tree with the providers <Locked> needs:
 *   - LanguageProvider — TierBadge + UpgradePrompt call useLanguage()
 *   - EntitlementsProvider — Locked + UpgradePrompt call useEntitlements()
 *   - MemoryRouter — UpgradePrompt's "See plans" CTA renders <Link>
 */
function withProviders(ui) {
  return render(
    <MemoryRouter>
      <LanguageProvider>
        <EntitlementsProvider>{ui}</EntitlementsProvider>
      </LanguageProvider>
    </MemoryRouter>,
  );
}


/** Wait for the entitlements API call to settle so the lock decision
 * reflects the mocked response. Without this, tests race the
 * provider's useEffect → api.get → setData. */
async function waitForEntitlementsLoaded() {
  await waitFor(() => expect(api.get).toHaveBeenCalled());
  // One more microtask flush so the resolved promise's setData fires.
  await waitFor(() => {
    // we just need the queued state update to commit; expect a no-op
    expect(api.get).toHaveBeenCalledTimes(1);
  });
}


beforeEach(() => {
  api.get.mockReset();
});


describe("<Locked> — feature unlocked", () => {
  it("passes children through when the user has the feature", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        plan: "pro",
        raw_plan: "pro",
        is_paid: true,
        in_trial: false,
        caps: {},
        features: { ai_anomaly_detection: true },
        min_plan_by_feature: {},
        plans: {},
      },
    });

    const handler = vi.fn();
    const { container } = withProviders(
      <Locked feature="ai_anomaly_detection">
        <ProtectedButton onClick={handler} />
      </Locked>,
    );

    // Wait for entitlements to resolve. With the feature unlocked,
    // the lock overlay must NOT appear, so wait for absence + click.
    await waitForEntitlementsLoaded();
    await waitFor(() =>
      expect(
        container.querySelector('button[aria-label="Upgrade required"]'),
      ).toBeNull(),
    );

    const button = screen.getByTestId("protected-button");
    fireEvent.click(button);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});


describe("<Locked> — feature locked (security-critical)", () => {
  it("renders children but blocks pointer events when feature is missing", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        plan: "free",
        raw_plan: "free",
        is_paid: false,
        in_trial: false,
        caps: {},
        features: { ai_anomaly_detection: false },
        min_plan_by_feature: { ai_anomaly_detection: "starter" },
        plans: { free: {}, starter: {}, pro: {} },
      },
    });

    const handler = vi.fn();
    const { container } = withProviders(
      <Locked feature="ai_anomaly_detection">
        <ProtectedButton onClick={handler} />
      </Locked>,
    );

    // Wait for the locked state to render. findByLabelText is the
    // canonical "wait until this appears" — the upgrade overlay only
    // appears when locked, so this asserts + waits in one step.
    const overlay = await screen.findByLabelText("Upgrade required");
    expect(overlay).toBeInTheDocument();

    // The button is still in the DOM (so users can see what they'd get)
    const button = screen.getByTestId("protected-button");
    expect(button).toBeInTheDocument();

    // Its parent has `pointer-events-none` + `aria-hidden="true"` —
    // the actual click-blocking layers Locked applies.
    const lockedWrapper = button.closest('[aria-hidden="true"]');
    expect(lockedWrapper).not.toBeNull();
    expect(lockedWrapper.className).toContain("pointer-events-none");
  });

  it("opens the upgrade prompt when the lock overlay is clicked", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        plan: "free",
        raw_plan: "free",
        is_paid: false,
        in_trial: false,
        caps: {},
        features: { multi_branch_dashboard: false },
        min_plan_by_feature: { multi_branch_dashboard: "pro" },
        plans: {
          free: { caps: { branches: 1 }, features: {} },
          starter: { caps: { branches: 1 }, features: {} },
          pro: {
            caps: { branches: 3, daily_close_export_days: 366 },
            features: { multi_branch_dashboard: true, white_label_pdf: true },
          },
        },
      },
    });

    withProviders(
      <Locked feature="multi_branch_dashboard">
        <ProtectedButton onClick={() => {}} label="Cross-outlet roll-up" />
      </Locked>,
    );

    // Wait for the lock to resolve.
    const overlay = await screen.findByLabelText("Upgrade required");
    fireEvent.click(overlay);

    // The UpgradePrompt modal renders via the same provider tree —
    // its title text is "Upgrade to unlock this feature" by default.
    // We assert it appeared (which proves the click reached the
    // overlay handler that triggers the prompt's open state).
    expect(
      await screen.findByText(/Upgrade to unlock this feature/i),
    ).toBeInTheDocument();
  });
});


describe("<Locked> — atCap mode (numeric cap exceeded)", () => {
  it("locks when the user's count is at or above the cap", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        plan: "free",
        raw_plan: "free",
        is_paid: false,
        in_trial: false,
        caps: { branches: 1 },
        features: {},
        min_plan_by_feature: {},
        plans: {
          free: { caps: { branches: 1 }, features: {} },
          starter: { caps: { branches: 1 }, features: {} },
          pro: { caps: { branches: 3 }, features: {} },
        },
      },
    });

    withProviders(
      <Locked atCap capKey="branches" current={1}>
        <ProtectedButton onClick={() => {}} label="Add branch" />
      </Locked>,
    );

    // Wait for the lock to resolve. Cap=1, current=1 → at cap → locked.
    const overlay = await screen.findByLabelText("Upgrade required");
    expect(overlay).toBeInTheDocument();
  });

  it("does NOT lock when the user is below the cap", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        plan: "pro",
        raw_plan: "pro",
        is_paid: true,
        in_trial: false,
        caps: { branches: 3 },
        features: {},
        min_plan_by_feature: {},
        plans: {},
      },
    });

    const handler = vi.fn();
    const { container } = withProviders(
      <Locked atCap capKey="branches" current={1}>
        <ProtectedButton onClick={handler} label="Add branch" />
      </Locked>,
    );

    // Wait for entitlements to load + the (no-)lock decision to settle.
    await waitForEntitlementsLoaded();
    await waitFor(() =>
      expect(
        container.querySelector('button[aria-label="Upgrade required"]'),
      ).toBeNull(),
    );

    const button = screen.getByTestId("protected-button");
    fireEvent.click(button);
    expect(handler).toHaveBeenCalledTimes(1);
  });
});


// ─────────────────────────────────────────────────────────────────────
// Tier-flicker contract: <Locked> must NOT render the upgrade overlay
// while entitlements are loading. The default Free fallback used during
// that ~150-300ms window would otherwise trigger a brief "Upgrade
// required" flash on trial / Starter / Pro users — the "trial glitch"
// Manoj reported. While loading, children render pass-through.
// ─────────────────────────────────────────────────────────────────────
describe("<Locked> — tier-flicker contract (loading state)", () => {
  it("renders children WITHOUT the locked overlay while entitlements are still loading", async () => {
    // Hold the API response so the provider stays in `data === null`
    // (loading) state for the duration of the assertion.
    let resolveFn;
    api.get.mockImplementationOnce(
      () => new Promise((r) => { resolveFn = r; }),
    );

    withProviders(
      <Locked feature="ai_anomaly_detection">
        <ProtectedButton onClick={() => {}} />
      </Locked>,
    );

    // The fetch fired (provider mounted) but hasn't resolved yet —
    // we're now in the loading window the flicker bug occupies.
    await waitFor(() => expect(api.get).toHaveBeenCalled());

    // Critical contract: NO upgrade overlay is in the DOM during loading.
    // If this regresses, every trial user sees the "Upgrade required"
    // overlay flash on every <Locked> wrapped feature for 150-300ms.
    expect(screen.queryByLabelText("Upgrade required")).toBeNull();
    // Children are visible and interactive (not aria-hidden, not
    // pointer-events: none) so the user sees the real feature UI.
    expect(screen.getByTestId("protected-button")).toBeInTheDocument();

    // Resolve to confirm we transition cleanly to the locked state
    // once entitlements settle to a Free user.
    resolveFn({
      data: {
        plan: "free",
        raw_plan: "free",
        is_paid: false,
        in_trial: false,
        caps: {},
        features: { ai_anomaly_detection: false },
        min_plan_by_feature: { ai_anomaly_detection: "starter" },
        plans: { free: {}, starter: {}, pro: {} },
      },
    });
    await screen.findByLabelText("Upgrade required");
  });
});
