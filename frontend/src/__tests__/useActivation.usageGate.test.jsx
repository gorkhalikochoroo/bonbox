/**
 * useActivation — the USAGE GATE contract (Sep 2026).
 *
 * The gate hides a never-used pillar (today: Events) from the nav for EVERY
 * owner. Because it hides a real surface, its failure modes are asymmetric and
 * each one is pinned here:
 *
 *   • FLAPPING — the row appearing and then vanishing (or vice versa) is worse
 *     than showing up a beat late. Hence: dormant-by-default while loading, a
 *     localStorage hint to skip even that beat, and "a failed refetch keeps the
 *     last good answer".
 *   • BLEED — one owner's answer applied to the next. Activation is per-user;
 *     a response for a previous user key must never commit, and the switch must
 *     not leave a single COMMITTED render where the new owner sees the old
 *     owner's nav. That one is asserted with a layout-effect probe, because a
 *     post-act assertion only sees the final frame.
 *   • DEAD SURFACE — an event organizer (or anyone who HAS used events) losing
 *     the feature. Hence the exempt-type and hint-says-used cases.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { useLayoutEffect } from "react";
import { render, screen, act, waitFor } from "@testing-library/react";

vi.mock("../services/api", () => ({
  default: { get: vi.fn() },
}));

const authState = vi.hoisted(() => ({ user: { id: 1 } }));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: authState.user, loading: false }),
}));

import api from "../services/api";
import { ActivationProvider, useActivation } from "../hooks/useActivation";

const HINT_KEY = (id) => `bonbox_usage_hint:${id}`;

/** A full /activation payload. `events` is the bit under test. */
const payload = (events, extra = {}) => ({
  data: {
    inventory: true,
    reservations: true,
    events,
    staff: true,
    in_scope: false, // every production account today: established → exempt
    enabled: true,
    ...extra,
  },
});

// Probe — exposes both Sets, and records EVERY committed render (layout effect,
// so it runs on commit) so a test can assert about frames, not just the end
// state.
const renders = [];
function Probe({ label = "u" }) {
  const { usageDormantPillars, usageKnownDormant, loading } = useActivation();
  const navHidesEvents = usageDormantPillars.has("events");
  const knownDormant = usageKnownDormant.has("events");
  useLayoutEffect(() => {
    renders.push({ label, navHidesEvents, knownDormant, loading });
  });
  return (
    <div
      data-testid="probe"
      data-nav-hides-events={String(navHidesEvents)}
      data-known-dormant={String(knownDormant)}
      data-loading={String(loading)}
    />
  );
}

const probe = () => screen.getByTestId("probe");
const navHides = () => probe().getAttribute("data-nav-hides-events") === "true";
const knownDormant = () => probe().getAttribute("data-known-dormant") === "true";

beforeEach(() => {
  api.get.mockReset();
  authState.user = { id: 1 };
  renders.length = 0;
  try { localStorage.clear(); } catch { /* jsdom always has it */ }
});

describe("usage gate — who it applies to", () => {
  it("logged out → hides nothing", async () => {
    authState.user = null;
    render(<ActivationProvider><Probe /></ActivationProvider>);
    await act(async () => {});
    expect(navHides()).toBe(false);
    expect(knownDormant()).toBe(false);
    expect(api.get).not.toHaveBeenCalled();
  });

  it("accountant → both Sets hide events (their sidebar never had it)", async () => {
    authState.user = { id: 7, role: "accountant" };
    render(<ActivationProvider><Probe /></ActivationProvider>);
    await act(async () => {});
    expect(navHides()).toBe(true);
    expect(knownDormant()).toBe(true);
    // A revisor session never fetches activation.
    expect(api.get).not.toHaveBeenCalled();
  });

  it("an event organizer is EXEMPT — Events visible with zero rows", async () => {
    authState.user = { id: 3, business_type: "event_organizer" };
    api.get.mockResolvedValue(payload(false));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    await waitFor(() => expect(probe()).toHaveAttribute("data-loading", "false"));
    expect(navHides()).toBe(false);
    expect(knownDormant()).toBe(false);
  });

  it("the exempt check is case/whitespace tolerant", async () => {
    authState.user = { id: 4, business_type: " Event_Organizer " };
    api.get.mockResolvedValue(payload(false));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    await act(async () => {});
    expect(navHides()).toBe(false);
  });
});

describe("usage gate — loading", () => {
  it("with no hint: the NAV hides events, the on-screen surfaces do not", async () => {
    // Never resolves — we are asserting the loading frame itself.
    api.get.mockImplementation(() => new Promise(() => {}));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    expect(probe()).toHaveAttribute("data-loading", "true");
    expect(navHides()).toBe(true);     // no flash-then-hide in the sidebar
    expect(knownDormant()).toBe(false); // nothing moves under a finger
  });

  it("a hint saying this owner HAS used events keeps it visible while loading", async () => {
    localStorage.setItem(HINT_KEY(1), JSON.stringify({ events: true }));
    api.get.mockImplementation(() => new Promise(() => {}));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    expect(probe()).toHaveAttribute("data-loading", "true");
    expect(navHides()).toBe(false);
    expect(knownDormant()).toBe(false);
  });

  it("a hint saying UNUSED is enough for the on-screen surfaces too", async () => {
    localStorage.setItem(HINT_KEY(1), JSON.stringify({ events: false }));
    api.get.mockImplementation(() => new Promise(() => {}));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    expect(navHides()).toBe(true);
    expect(knownDormant()).toBe(true);
  });

  it("a corrupt hint is ignored, not thrown on", async () => {
    localStorage.setItem(HINT_KEY(1), "{not json");
    api.get.mockImplementation(() => new Promise(() => {}));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    expect(navHides()).toBe(true);      // falls back to the loading default
    expect(knownDormant()).toBe(false);
  });
});

describe("usage gate — responses", () => {
  it("events:false → both Sets hide it, and the hint is written", async () => {
    api.get.mockResolvedValue(payload(false));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    await waitFor(() => expect(probe()).toHaveAttribute("data-loading", "false"));
    expect(navHides()).toBe(true);
    expect(knownDormant()).toBe(true);
    expect(JSON.parse(localStorage.getItem(HINT_KEY(1)))).toEqual({ events: false });
  });

  it("events:true → visible everywhere, hint records it", async () => {
    api.get.mockResolvedValue(payload(true));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    await waitFor(() => expect(probe()).toHaveAttribute("data-loading", "false"));
    expect(navHides()).toBe(false);
    expect(knownDormant()).toBe(false);
    expect(JSON.parse(localStorage.getItem(HINT_KEY(1)))).toEqual({ events: true });
  });

  it("a payload with the flag OFF (all true) leaves Events visible", async () => {
    // The kill-switch path: routers/activation.py forces every pillar true.
    api.get.mockResolvedValue(payload(true, { enabled: false }));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    await waitFor(() => expect(probe()).toHaveAttribute("data-loading", "false"));
    expect(navHides()).toBe(false);
  });

  it("error with no prior answer and no hint → FAIL OPEN", async () => {
    api.get.mockRejectedValue(new Error("offline"));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    await waitFor(() => expect(probe()).toHaveAttribute("data-loading", "false"));
    expect(navHides()).toBe(false);
    expect(knownDormant()).toBe(false);
  });

  it("error with only a hint → the hint decides", async () => {
    localStorage.setItem(HINT_KEY(1), JSON.stringify({ events: false }));
    api.get.mockRejectedValue(new Error("offline"));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    await waitFor(() => expect(probe()).toHaveAttribute("data-loading", "false"));
    expect(navHides()).toBe(true);
    expect(knownDormant()).toBe(true);
  });

  it("a FAILED REFETCH keeps the last good answer (no flap into view)", async () => {
    api.get.mockResolvedValueOnce(payload(false));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    await waitFor(() => expect(probe()).toHaveAttribute("data-loading", "false"));
    expect(navHides()).toBe(true);

    // A write elsewhere triggers the graduation refetch — and it fails.
    api.get.mockRejectedValueOnce(new Error("503"));
    await act(async () => {
      window.dispatchEvent(new Event("bonbox-data-changed"));
    });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    // Still hidden: an offline blip must not push Events back into the nav.
    expect(navHides()).toBe(true);
    expect(knownDormant()).toBe(true);
    // And no frame in between said otherwise.
    expect(renders.every((r) => r.navHidesEvents)).toBe(true);
  });

  it("a real event row graduates Events back on the next refetch", async () => {
    api.get.mockResolvedValueOnce(payload(false));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    await waitFor(() => expect(navHides()).toBe(true));

    api.get.mockResolvedValueOnce(payload(true));
    await act(async () => {
      window.dispatchEvent(new Event("bonbox-data-changed"));
    });
    await waitFor(() => expect(navHides()).toBe(false));
  });
});

describe("usage gate — the account switch", () => {
  it("owner B never gets a committed render based on owner A's answer", async () => {
    // A has used events → visible for A.
    api.get.mockResolvedValue(payload(true));
    const { rerender } = render(<ActivationProvider><Probe label="A" /></ActivationProvider>);
    await waitFor(() => expect(navHides()).toBe(false));

    // B signs in. B's request is left pending, so the ONLY thing that could
    // make Events visible for B is A's leftover state.
    api.get.mockImplementation(() => new Promise(() => {}));
    authState.user = { id: 2 };
    renders.length = 0;
    await act(async () => {
      rerender(<ActivationProvider><Probe label="B" /></ActivationProvider>);
    });

    const bFrames = renders.filter((r) => r.label === "B");
    expect(bFrames.length).toBeGreaterThan(0);
    // EVERY committed frame for B hides events — not just the last one.
    expect(bFrames.every((r) => r.navHidesEvents)).toBe(true);
    expect(probe()).toHaveAttribute("data-loading", "true");
  });

  it("a response that lands after the switch is DROPPED, not applied to B", async () => {
    // A's request resolves late — with events:true. If it committed, B (who
    // has never used events) would see Events appear out of nowhere.
    let resolveA;
    api.get.mockImplementationOnce(() => new Promise((r) => { resolveA = r; }));
    const { rerender } = render(<ActivationProvider><Probe label="A" /></ActivationProvider>);

    api.get.mockImplementation(() => new Promise(() => {}));
    authState.user = { id: 2 };
    await act(async () => {
      rerender(<ActivationProvider><Probe label="B" /></ActivationProvider>);
    });
    await act(async () => { resolveA(payload(true)); });

    expect(navHides()).toBe(true);
    expect(probe()).toHaveAttribute("data-loading", "true");
    // A's answer must not have been cached under B's key either.
    expect(localStorage.getItem(HINT_KEY(2))).toBeNull();
  });

  it("A's LATE response can't clobber B's already-settled answer", async () => {
    // The second half of the bleed guard: A's request resolves after B's did.
    // If it committed, B would drop back to "not known yet" — and the surfaces
    // keyed on usageKnownDormant (the /modules list, the DoorScan tiles) would
    // pop back into view for a frame.
    let resolveA;
    api.get.mockImplementationOnce(() => new Promise((r) => { resolveA = r; }));
    const { rerender } = render(<ActivationProvider><Probe label="A" /></ActivationProvider>);

    api.get.mockResolvedValueOnce(payload(false)); // B's own answer
    authState.user = { id: 2 };
    await act(async () => {
      rerender(<ActivationProvider><Probe label="B" /></ActivationProvider>);
    });
    await waitFor(() => expect(probe()).toHaveAttribute("data-loading", "false"));
    expect(knownDormant()).toBe(true);

    await act(async () => { resolveA(payload(true)); });
    expect(probe()).toHaveAttribute("data-loading", "false");
    expect(navHides()).toBe(true);
    expect(knownDormant()).toBe(true);
  });

  it("B's own hint is used, not A's", async () => {
    localStorage.setItem(HINT_KEY(1), JSON.stringify({ events: true }));
    localStorage.setItem(HINT_KEY(2), JSON.stringify({ events: false }));
    api.get.mockImplementation(() => new Promise(() => {}));
    const { rerender } = render(<ActivationProvider><Probe label="A" /></ActivationProvider>);
    expect(navHides()).toBe(false);

    authState.user = { id: 2 };
    await act(async () => {
      rerender(<ActivationProvider><Probe label="B" /></ActivationProvider>);
    });
    expect(navHides()).toBe(true);
    expect(knownDormant()).toBe(true);
  });
});

describe("usage gate — the existing contract still holds", () => {
  it("keeps every pre-existing field behaving as before", async () => {
    api.get.mockResolvedValue(payload(false, { in_scope: true, enabled: true }));
    let captured;
    function Legacy() {
      const ctx = useActivation();
      // Captured in a layout effect, not during render — assigning an outer
      // variable mid-render is the side effect the react-hooks rules forbid.
      useLayoutEffect(() => { captured = ctx; });
      return null;
    }
    render(<ActivationProvider><Legacy /><Probe /></ActivationProvider>);
    await waitFor(() => expect(probe()).toHaveAttribute("data-loading", "false"));

    expect(captured.isInScope).toBe(true);
    expect(captured.activationEnabled).toBe(true);
    expect(captured.isReady).toBe(true);
    expect(captured.isActivated("events")).toBe(false);   // dormant per payload
    expect(captured.isActivated("inventory")).toBe(true);
    expect(captured.isActivated("insights")).toBe(true);  // not gateable
    expect(captured.activatedPillars.has("staff")).toBe(true);
    expect(typeof captured.refresh).toBe("function");
  });

  it("outside the provider everything fails open, including the new Sets", () => {
    let captured;
    function Bare() {
      const ctx = useActivation();
      useLayoutEffect(() => { captured = ctx; });
      return null;
    }
    render(<Bare />);
    expect(captured.usageDormantPillars.size).toBe(0);
    expect(captured.usageKnownDormant.size).toBe(0);
    expect(captured.isActivated("events")).toBe(true);
    expect(captured.loading).toBe(false);
  });

  it("de-dupes concurrent consumers into ONE request", async () => {
    api.get.mockResolvedValue(payload(false));
    render(
      <ActivationProvider>
        <Probe /><Probe /><Probe />
      </ActivationProvider>,
    );
    await act(async () => {});
    expect(api.get).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledWith("/activation", expect.objectContaining({ _noRetry: true }));
  });
});
