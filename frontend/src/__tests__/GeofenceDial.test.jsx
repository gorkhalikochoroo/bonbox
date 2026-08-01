/**
 * The clock-in geofence dial.
 *
 * This tells someone whether they can start their shift, so the tests that
 * matter are the ones proving it never draws a harder line than the server
 * enforces, and never turns "we can't see you" into "you're refused":
 *
 *   • accuracy is a GRACE radius, exactly as staff_portal.py applies it
 *   • no fix → "you can still clock in", because the server allows it and
 *     flags it unverified
 *   • nothing is fetched — the whole point of a schematic dial over tiles
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (_k, fb, vars) => {
      let out = fb ?? "";
      for (const [k, v] of Object.entries(vars || {})) out = out.replaceAll(`{${k}}`, v);
      return out;
    },
  }),
}));

const { default: GeofenceDial, metresBetween } = await import("../components/GeofenceDial");

const VENUE = { lat: 55.6761, lng: 12.5683 };            // København
// ~100 m due north: 1 deg lat ≈ 111.32 km
const near = (m) => ({ lat: VENUE.lat + m / 111320, lng: VENUE.lng });

describe("metresBetween", () => {
  it("measures a known offset within a metre", () => {
    expect(metresBetween(VENUE, near(100))).toBeGreaterThan(99);
    expect(metresBetween(VENUE, near(100))).toBeLessThan(101);
  });

  it("is zero at the same point", () => {
    expect(metresBetween(VENUE, VENUE)).toBeCloseTo(0, 5);
  });
});

describe("GeofenceDial", () => {
  it("renders nothing without a configured fence", () => {
    const { container } = render(<GeofenceDial venue={null} me={near(10)} radiusM={150} />);
    expect(container.firstChild).toBeNull();
  });

  it("says you're at the venue when inside", () => {
    render(<GeofenceDial venue={VENUE} me={near(40)} radiusM={150} accuracyM={10} />);
    expect(screen.getByText("You're at the venue")).toBeTruthy();
  });

  it("says too far when outside, and states both numbers", () => {
    render(<GeofenceDial venue={VENUE} me={near(400)} radiusM={150} accuracyM={10} />);
    expect(screen.getByText("Too far to clock in")).toBeTruthy();
    // The 403 already carries these; showing them is the whole point.
    expect(screen.getByText(/400 m away · must be within 150 m/)).toBeTruthy();
  });

  it("treats accuracy as GRACE, matching the server", () => {
    // 200m out with a 120m fix: the server allows it (dist - grace <= radius),
    // so the dial must not say refused. Drawing a stricter line than the
    // server enforces would lock out a real worker standing at the door.
    render(<GeofenceDial venue={VENUE} me={near(200)} radiusM={150} accuracyM={120} />);
    expect(screen.getByText("You're at the venue")).toBeTruthy();
  });

  it("caps grace at 200m so a spoofed accuracy cannot buy entry", () => {
    // The server clamps grace to 200; a claimed 100km accuracy must not pass.
    render(<GeofenceDial venue={VENUE} me={near(5000)} radiusM={150} accuracyM={100000} />);
    expect(screen.getByText("Too far to clock in")).toBeTruthy();
  });

  it("floors a negative accuracy rather than widening the fence", () => {
    render(<GeofenceDial venue={VENUE} me={near(400)} radiusM={150} accuracyM={-9999} />);
    expect(screen.getByText("Too far to clock in")).toBeTruthy();
  });

  it("never turns 'no fix' into a refusal", () => {
    // The server allows a no-fix punch and flags it unverified. Saying
    // "refused" here would be a lie that stops someone starting work.
    render(<GeofenceDial venue={VENUE} me={null} radiusM={150} />);
    expect(screen.getByText("Can't see your location")).toBeTruthy();
    expect(screen.getByText(/You can still clock in/)).toBeTruthy();
    expect(screen.queryByText("Too far to clock in")).toBeNull();
  });

  it("makes no network request — no tiles, no vendor, works offline", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const { container } = render(<GeofenceDial venue={VENUE} me={near(40)} radiusM={150} />);
    expect(fetchSpy).not.toHaveBeenCalled();
    // and nothing points at a remote host
    expect(container.innerHTML).not.toMatch(/https?:\/\//);
    fetchSpy.mockRestore();
  });
});
