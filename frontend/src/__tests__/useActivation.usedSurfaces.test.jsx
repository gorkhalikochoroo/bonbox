/**
 * useActivation — what the owner has IN USE (vertical-fit review, Oct 2026).
 *
 *   • usedSurfaces — the tools with real rows (GET /activation `surfaces`):
 *     the nav's business-type gate never takes one of them away. Loading →
 *     this owner's last known answer, else none (the type gate decides and a
 *     used tool appears once the answer lands); error → the hint, else EVERY
 *     tool (fail open); an older API without the map → every tool.
 *   • knownActivatedPillars — the pillars KNOWN to be in use, for the phone
 *     tab bar: null while loading with no stored answer (the bar keeps
 *     Kasserapport rather than flipping back and forth), the stored answer
 *     on a reload, the response once in.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";

vi.mock("../services/api", () => ({ default: { get: vi.fn() } }));
const authState = vi.hoisted(() => ({ user: { id: 7 } }));
vi.mock("../hooks/useAuth", () => ({ useAuth: () => ({ user: authState.user, loading: false }) }));

import api from "../services/api";
import { ActivationProvider, useActivation } from "../hooks/useActivation";

const payload = (extra = {}) => ({
  data: { inventory: false, reservations: true, events: false, staff: true, in_scope: false, enabled: true, ...extra },
});

function Probe() {
  const { usedSurfaces, knownActivatedPillars, loading } = useActivation();
  return (
    <div
      data-testid="p"
      data-loading={String(loading)}
      data-surfaces={[...usedSurfaces].sort().join(",")}
      data-known={knownActivatedPillars === null ? "null" : [...knownActivatedPillars].sort().join(",")}
    />
  );
}
const attr = (k) => screen.getByTestId("p").getAttribute(k);

beforeEach(() => {
  api.get.mockReset();
  authState.user = { id: 7 };
  localStorage.clear();
});

describe("usedSurfaces + knownActivatedPillars", () => {
  it("reads the response's tools and pillars, and keeps them for the next load", async () => {
    api.get.mockResolvedValue(payload({ surfaces: { waste: true, expiry: false, workshop: false } }));
    const first = render(<ActivationProvider><Probe /></ActivationProvider>);
    await waitFor(() => expect(attr("data-loading")).toBe("false"));
    expect(attr("data-surfaces")).toBe("waste");
    expect(attr("data-known")).toBe("reservations,staff");
    first.unmount();

    // A reload: the request is in flight, the stored answer holds the line.
    api.get.mockReturnValue(new Promise(() => {}));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    expect(attr("data-loading")).toBe("true");
    expect(attr("data-surfaces")).toBe("waste");
    expect(attr("data-known")).toBe("reservations,staff");
  });

  it("loading with nothing stored: no tool kept, pillars unknown (null)", () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    expect(attr("data-surfaces")).toBe("");
    expect(attr("data-known")).toBe("null");
  });

  it("an older API without `surfaces` keeps every tool (fail open)", async () => {
    api.get.mockResolvedValue(payload());
    render(<ActivationProvider><Probe /></ActivationProvider>);
    await waitFor(() => expect(attr("data-loading")).toBe("false"));
    expect(attr("data-surfaces")).toBe("expiry,waste,workshop");
  });

  it("an error with nothing stored keeps every tool and every pillar (fail open)", async () => {
    api.get.mockRejectedValue(new Error("Network Error"));
    render(<ActivationProvider><Probe /></ActivationProvider>);
    await waitFor(() => expect(attr("data-loading")).toBe("false"));
    expect(attr("data-surfaces")).toBe("expiry,waste,workshop");
    expect(attr("data-known")).toBe("events,inventory,reservations,staff");
  });

  it("outside the provider: everything (a bare render never hides a tool)", () => {
    render(<Probe />);
    expect(attr("data-surfaces")).toBe("expiry,waste,workshop");
  });
});
