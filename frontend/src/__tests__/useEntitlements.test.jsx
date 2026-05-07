/**
 * Tests for the useEntitlements hook + EntitlementsProvider.
 *
 * Why this matters for security: useEntitlements is the FRONT-DOOR of
 * client-side tier gating. The contract that absolutely must not
 * regress:
 *
 *   1. Fail-closed default — when the API errors, the hook returns
 *      a Free-tier shape, NEVER a paid shape. A bug here would mean
 *      a backend outage silently grants Pro entitlements UI-side.
 *      (Backend re-checks every gate, so a tampered cache can't
 *      grant real access — but the UI would mislead the user about
 *      what they're allowed to do.)
 *
 *   2. hasFeature(unknown) → false — defends against typo'd feature
 *      keys silently rendering as "available". Mirrors the backend's
 *      `has_feature` fail-closed contract.
 *
 *   3. isAtCap(unknown_key) → false — defers to server. Local
 *      enforcement of an unknown cap would be wrong; the server
 *      knows. Local short-circuit must permit and let the gate fire.
 *
 *   4. Used outside <EntitlementsProvider> → safe defaults — a
 *      stray <Locked> on a public page must not crash; it gets the
 *      Free-tier shape and renders the locked state correctly.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, waitFor } from "@testing-library/react";

// Mock the api module BEFORE importing the hook, so the
// EntitlementsProvider's useEffect → api.get path is intercepted.
vi.mock("../services/api", () => ({
  default: {
    get: vi.fn(),
  },
}));

import api from "../services/api";
import { EntitlementsProvider, useEntitlements } from "../hooks/useEntitlements";


// Tiny consumer component — exposes the hook return as data-attrs so
// each test can read and assert without coupling to a real UI.
function HookProbe({ onRender }) {
  const ent = useEntitlements();
  onRender?.(ent);
  return (
    <div
      data-testid="probe"
      data-plan={ent.plan}
      data-loading={String(ent.loading)}
      data-is-paid={String(ent.isPaid)}
      data-has-anomaly={String(ent.hasFeature("ai_anomaly_detection"))}
      data-min-plan-anomaly={String(ent.minPlanForFeature("ai_anomaly_detection"))}
    />
  );
}


beforeEach(() => {
  api.get.mockReset();
});


describe("useEntitlements — happy path", () => {
  it("loads data from /billing/entitlements and exposes plan/isPaid/hasFeature", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        plan: "pro",
        raw_plan: "pro",
        is_paid: true,
        in_trial: false,
        trial_ends_at: null,
        trial_days_remaining: null,
        caps: { branches: 3, daily_close_export_days: 366 },
        features: { ai_anomaly_detection: true, multi_branch_dashboard: true },
        min_plan_by_feature: {
          ai_anomaly_detection: "starter",
          multi_branch_dashboard: "pro",
        },
        plans: { free: {}, starter: {}, pro: {} },
      },
    });

    render(
      <EntitlementsProvider>
        <HookProbe />
      </EntitlementsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe")).toHaveAttribute("data-loading", "false");
    });

    const probe = screen.getByTestId("probe");
    expect(probe).toHaveAttribute("data-plan", "pro");
    expect(probe).toHaveAttribute("data-is-paid", "true");
    expect(probe).toHaveAttribute("data-has-anomaly", "true");
    expect(probe).toHaveAttribute("data-min-plan-anomaly", "starter");
    expect(api.get).toHaveBeenCalledWith("/billing/entitlements");
  });

  it("hits /billing/entitlements only once when multiple consumers mount", async () => {
    // De-dup is critical: every page renders 3-5 useEntitlements
    // consumers (TrialChip, Layout, page-level gate, etc.). Without
    // the inflight ref, each one would fire its own request on mount.
    let resolveFn;
    api.get.mockImplementationOnce(
      () => new Promise((r) => { resolveFn = r; }),
    );

    render(
      <EntitlementsProvider>
        <HookProbe />
        <HookProbe />
        <HookProbe />
      </EntitlementsProvider>,
    );

    // Resolve after the children have all mounted; even with three
    // probes the provider should have made a single request.
    await act(async () => {
      resolveFn({
        data: {
          plan: "free",
          raw_plan: "free",
          is_paid: false,
          in_trial: false,
          trial_ends_at: null,
          trial_days_remaining: null,
          caps: {},
          features: {},
          min_plan_by_feature: {},
          plans: {},
        },
      });
    });

    expect(api.get).toHaveBeenCalledTimes(1);
  });
});


describe("useEntitlements — fail-closed defaults", () => {
  it("falls back to Free tier when /billing/entitlements rejects", async () => {
    // Simulates a 401 / network error / 500. The hook MUST resolve
    // to Free shape — never leave the user in a paid state by accident.
    api.get.mockRejectedValueOnce(new Error("network down"));

    render(
      <EntitlementsProvider>
        <HookProbe />
      </EntitlementsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe")).toHaveAttribute("data-loading", "false");
    });
    const probe = screen.getByTestId("probe");
    expect(probe).toHaveAttribute("data-plan", "free");
    expect(probe).toHaveAttribute("data-is-paid", "false");
    expect(probe).toHaveAttribute("data-has-anomaly", "false");
  });

  it("returns the unauthenticated default when used OUTSIDE a Provider", () => {
    // No provider in the tree — hook returns the safe Free-tier shape
    // synchronously. A stray <Locked> on a public landing page shouldn't
    // crash; it should just render as locked.
    let captured;
    render(<HookProbe onRender={(ent) => { captured = ent; }} />);

    expect(captured.plan).toBe("free");
    expect(captured.isPaid).toBe(false);
    expect(captured.inTrial).toBe(false);
    expect(captured.hasFeature("ai_anomaly_detection")).toBe(false);
    expect(captured.hasFeature("any_unknown_feature")).toBe(false);
    expect(captured.isAtCap("branches", 100)).toBe(false);
    expect(captured.minPlanForFeature("ai_anomaly_detection")).toBeNull();
  });
});


describe("useEntitlements — accessor correctness", () => {
  it("hasFeature returns false for unknown feature keys (fail-closed)", async () => {
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

    let captured;
    render(
      <EntitlementsProvider>
        <HookProbe onRender={(ent) => { captured = ent; }} />
      </EntitlementsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe")).toHaveAttribute("data-loading", "false");
    });
    expect(captured.hasFeature("ai_anomaly_detection")).toBe(true);
    expect(captured.hasFeature("nonexistent_made_up_feature")).toBe(false);
    // Defensive: a key with explicit `false` on the server is also denied
    expect(captured.hasFeature("multi_branch_dashboard")).toBe(false);
  });

  it("isAtCap respects -1 as unlimited and ignores unknown keys", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        plan: "pro",
        raw_plan: "pro",
        is_paid: true,
        in_trial: false,
        caps: { branches: 3, modules: -1 },
        features: {},
        min_plan_by_feature: {},
        plans: {},
      },
    });

    let captured;
    render(
      <EntitlementsProvider>
        <HookProbe onRender={(ent) => { captured = ent; }} />
      </EntitlementsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe")).toHaveAttribute("data-loading", "false");
    });
    // Below the cap → false
    expect(captured.isAtCap("branches", 2)).toBe(false);
    // At the cap → true
    expect(captured.isAtCap("branches", 3)).toBe(true);
    // -1 unlimited → never at cap
    expect(captured.isAtCap("modules", 999)).toBe(false);
    // Unknown key → defer to server (return false locally)
    expect(captured.isAtCap("unknown_cap", 999)).toBe(false);
  });

  it("minPlanForFeature returns null for unknown features", async () => {
    api.get.mockResolvedValueOnce({
      data: {
        plan: "free",
        raw_plan: "free",
        is_paid: false,
        in_trial: false,
        caps: {},
        features: {},
        min_plan_by_feature: { ai_anomaly_detection: "starter" },
        plans: {},
      },
    });

    let captured;
    render(
      <EntitlementsProvider>
        <HookProbe onRender={(ent) => { captured = ent; }} />
      </EntitlementsProvider>,
    );

    await waitFor(() => {
      expect(screen.getByTestId("probe")).toHaveAttribute("data-loading", "false");
    });
    expect(captured.minPlanForFeature("ai_anomaly_detection")).toBe("starter");
    expect(captured.minPlanForFeature("nonsense")).toBeNull();
  });
});
