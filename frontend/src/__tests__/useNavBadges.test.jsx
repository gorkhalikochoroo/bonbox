/**
 * The rail's badges follow the owner's own actions: answering a booking or
 * publishing the week is a write, and any answered write re-reads the
 * badges at once (lib/swrCache onWrite) — "Reservationer 1" / "Vagtplan 6"
 * used to stay up to five minutes. A dismissed finding re-reads too, and its
 * day travels as `skip` (the same CSV /diagnostics/needs-you takes).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, act } from "@testing-library/react";

const get = vi.fn();
vi.mock("../services/api", () => ({ default: { get: (...a) => get(...a) } }));

import { useNavBadges } from "../hooks/useNavBadges";
import { noteWrite } from "../lib/swrCache";
import { saveDismissal } from "../components/needsYouRenderers";

let seen = null;
function Probe() {
  seen = useNavBadges(true);
  return null;
}
const flush = async (ms = 0) => {
  await act(async () => { vi.advanceTimersByTime(ms); });
  for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); });
};
const badgeCalls = () => get.mock.calls.filter(([u]) => u === "/today");

beforeEach(() => {
  vi.useFakeTimers();
  get.mockReset();
  try { localStorage.clear(); } catch { /* none */ }
});

describe("useNavBadges", () => {
  it("re-reads after an answered write, once per burst", async () => {
    get.mockResolvedValueOnce({ data: { badges: { reservations: 1, schedule: 6, daily_close: 0 } } });
    render(<Probe />);
    await flush();
    expect(seen["/reservations"]).toEqual({ count: 1, tone: "act" });
    get.mockResolvedValue({ data: { badges: { reservations: 0, schedule: 0, daily_close: 0 } } });
    noteWrite("/reservations/reservations/r1/status");
    noteWrite("/reservations/reservations/r2/status");
    await flush(1000);
    expect(badgeCalls()).toHaveLength(2);
    expect(seen).toEqual({});
    // telemetry is not a write the owner made
    noteWrite("/event-log");
    await flush(1000);
    expect(badgeCalls()).toHaveLength(2);
    vi.useRealTimers();
  });

  it("a dismissal re-reads with the day as skip", async () => {
    get.mockResolvedValue({ data: { badges: { reservations: 0, schedule: 0, daily_close: 1 } } });
    render(<Probe />);
    await flush();
    saveDismissal({}, { code: "close_missing", meta: { date: "2026-11-11" } });
    await flush(1000);
    const last = badgeCalls().at(-1);
    expect(last[1]).toEqual({ params: { part: "badges", skip: "close_missing:2026-11-11" } });
    vi.useRealTimers();
  });
});
