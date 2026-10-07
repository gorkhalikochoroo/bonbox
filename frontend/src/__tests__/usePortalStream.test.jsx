/**
 * Round-2 report (lead, then verified in code): after hours idle the Scheduler
 * header never came back to "Live" — only a relaunch did. EventSource gives up
 * for good (readyState CLOSED) on an error STATUS — a 5xx/502 while the server
 * restarts, the 429 stream cap — and nothing ever opened a new one; a socket
 * left half-open by an iOS suspend was never recycled either.
 */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let native = false;
const resumeHandlers = [];
vi.mock("../utils/platform", () => ({
  platform: { get isNative() { return native; } },
}));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn((ev, fn) => {
      if (ev === "resume") resumeHandlers.push(fn);
      return Promise.resolve({ remove: vi.fn() });
    }),
  },
}));

const { usePortalStream, STREAM_BACKOFF_MS } = await import("../hooks/usePortalStream");

class FakeEventSource {
  static all = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.listeners = {};
    this.closed = false;
    FakeEventSource.all.push(this);
  }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  removeEventListener(ev, fn) { this.listeners[ev] = (this.listeners[ev] || []).filter((f) => f !== fn); }
  close() { this.closed = true; this.readyState = 2; }
  // test helpers
  open() { this.readyState = 1; this.onopen?.(); }
  failFatally() { this.readyState = 2; this.onerror?.(); }   // HTTP error status
  dropSocket() { this.readyState = 0; this.onerror?.(); }    // browser retries itself
  emit(ev) { (this.listeners[ev] || []).forEach((f) => f({ type: ev })); }
  static latest() { return FakeEventSource.all[FakeEventSource.all.length - 1]; }
}

let lastLive = null;
function Probe({ onPublished = () => {} }) {
  lastLive = usePortalStream({ enabled: true, url: "/api/portal/tok/stream", onPublished });
  return null;
}

beforeEach(() => {
  vi.useFakeTimers();
  native = false;
  resumeHandlers.length = 0;
  FakeEventSource.all = [];
  window.EventSource = FakeEventSource;
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
});
afterEach(() => {
  vi.useRealTimers();
  delete window.EventSource;
});

describe("usePortalStream", () => {
  it("is Live only while a stream is actually open, and forwards publishes", () => {
    const onPublished = vi.fn();
    render(<Probe onPublished={onPublished} />);
    expect(lastLive).toBe(false);
    act(() => FakeEventSource.latest().open());
    expect(lastLive).toBe(true);
    act(() => FakeEventSource.latest().emit("schedule_published"));
    expect(onPublished).toHaveBeenCalledTimes(1);
  });

  it("a stream the browser gave up on (error status) is reopened with backoff", () => {
    render(<Probe />);
    act(() => FakeEventSource.latest().open());
    act(() => FakeEventSource.latest().failFatally());   // e.g. a 503 while the server restarts
    expect(lastLive).toBe(false);
    expect(FakeEventSource.all).toHaveLength(1);

    act(() => { vi.advanceTimersByTime(STREAM_BACKOFF_MS[0] - 1); });
    expect(FakeEventSource.all).toHaveLength(1);
    act(() => { vi.advanceTimersByTime(1); });
    expect(FakeEventSource.all).toHaveLength(2);

    // Still failing → the next wait is longer.
    act(() => FakeEventSource.latest().failFatally());
    act(() => { vi.advanceTimersByTime(STREAM_BACKOFF_MS[0]); });
    expect(FakeEventSource.all).toHaveLength(2);
    act(() => { vi.advanceTimersByTime(STREAM_BACKOFF_MS[1] - STREAM_BACKOFF_MS[0]); });
    expect(FakeEventSource.all).toHaveLength(3);

    // Back: Live again.
    act(() => FakeEventSource.latest().open());
    expect(lastLive).toBe(true);
  });

  it("a dropped socket is left to the browser's own retry (no duplicate stream)", () => {
    render(<Probe />);
    act(() => FakeEventSource.latest().open());
    act(() => FakeEventSource.latest().dropSocket());
    expect(lastLive).toBe(false);
    act(() => { vi.advanceTimersByTime(60000); });
    expect(FakeEventSource.all).toHaveLength(1);
  });

  it("coming back to the app opens a fresh stream at once (half-open socket after a suspend)", () => {
    render(<Probe />);
    act(() => FakeEventSource.latest().open());
    act(() => { vi.advanceTimersByTime(4 * 3600 * 1000); });   // hours idle
    const stale = FakeEventSource.latest();
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(stale.closed).toBe(true);
    expect(FakeEventSource.all).toHaveLength(2);
    act(() => FakeEventSource.latest().open());
    expect(lastLive).toBe(true);
  });

  it("native 'resume' and 'online' revive a dead stream without waiting out the backoff", () => {
    native = true;
    render(<Probe />);
    act(() => FakeEventSource.latest().failFatally());
    act(() => { vi.advanceTimersByTime(4000); });
    expect(resumeHandlers).toHaveLength(1);
    act(() => resumeHandlers[0]());
    expect(FakeEventSource.all).toHaveLength(2);

    act(() => FakeEventSource.latest().failFatally());
    act(() => { window.dispatchEvent(new Event("online")); });
    expect(FakeEventSource.all).toHaveLength(3);
  });

  it("one unlock firing resume + visibilitychange + online opens ONE stream", () => {
    native = true;
    render(<Probe />);
    act(() => { vi.advanceTimersByTime(10000); });
    act(() => {
      resumeHandlers[0]();
      document.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("online"));
    });
    expect(FakeEventSource.all).toHaveLength(2);
  });

  it("closes everything on unmount", () => {
    const { unmount } = render(<Probe />);
    const es = FakeEventSource.latest();
    unmount();
    expect(es.closed).toBe(true);
    act(() => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(FakeEventSource.all).toHaveLength(1);
  });
});
