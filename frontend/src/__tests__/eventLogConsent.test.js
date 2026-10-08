/**
 * The cookie banner's Analytics choice covers this log ("which features are
 * useful and where the app breaks"). An owner who declined it was still logged
 * on every page. A decline now stops it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const post = vi.fn(() => Promise.resolve({}));
vi.mock("../services/api", () => ({ default: { post: (...a) => post(...a) } }));

const consent = (analytics) =>
  localStorage.setItem(
    "bonbox_cookie_consent",
    JSON.stringify({
      version: 1,
      timestamp: new Date().toISOString(),
      choices: { necessary: true, functional: false, analytics, marketing: false },
    }),
  );

beforeEach(() => {
  vi.useFakeTimers();
  post.mockClear();
  localStorage.clear();
});
afterEach(() => vi.useRealTimers());

describe("event log and the analytics choice", () => {
  it("sends nothing after the owner declined analytics", async () => {
    consent(false);
    const { trackEvent } = await import("../hooks/useEventLog");
    trackEvent("page_view", "dashboard");
    vi.advanceTimersByTime(6000);
    expect(post).not.toHaveBeenCalled();
  });

  it("still logs when analytics is accepted", async () => {
    consent(true);
    const { trackEvent } = await import("../hooks/useEventLog");
    trackEvent("page_view", "dashboard");
    vi.advanceTimersByTime(6000);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

// /cookies: usage events "are recorded until you decline Analytics in the
// banner". The Smart-card telemetry posted straight to /event-log and ignored
// that decline. It now uses the same check as the page-view log.
describe("smart-card telemetry and the analytics choice", () => {
  it("sends nothing after the owner declined analytics", async () => {
    consent(false);
    const { useSmartTelemetry } = await import("../hooks/useSmartTelemetry");
    useSmartTelemetry().track("smart_proposal_accepted", "smart_staffing", { confidence: "high" });
    expect(post).not.toHaveBeenCalled();
  });

  it("still sends when analytics is accepted", async () => {
    consent(true);
    const { useSmartTelemetry } = await import("../hooks/useSmartTelemetry");
    useSmartTelemetry().track("smart_proposal_accepted", "smart_staffing", { confidence: "high" });
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe("/event-log");
  });
});
