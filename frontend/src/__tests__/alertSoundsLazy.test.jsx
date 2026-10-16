/**
 * G (speed push, 15 Oct): the live-alert clips are built lazily — not while
 * the app is still assembling Home. The build (one idle slot per clip, ~60 ms
 * each at 4x CPU) starts only once the app's requests have been quiet for a
 * second. A tap before then still primes them (unlockSound builds on demand),
 * so an alert can never be lost to the deferral.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(() => new Promise(() => {})), post: vi.fn(), patch: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, role: "owner" }, loading: false }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (_k, fallback) => fallback ?? _k, lang: "en" }),
}));
const sound = vi.hoisted(() => ({ prepare: null, unlock: null }));
vi.mock("../utils/sound", () => {
  sound.prepare = vi.fn(() => () => {});
  sound.unlock = vi.fn();
  return {
    playChime: vi.fn(), playUrgent: vi.fn(), playCancel: vi.fn(),
    unlockSound: sound.unlock,
    prepareSoundWhenIdle: sound.prepare,
  };
});

import { requestStarted, requestSettled } from "../services/apiActivity";
import { LiveAlertsProvider } from "../hooks/useLiveAlerts";

beforeEach(() => {
  vi.useFakeTimers();
  sound.prepare.mockClear();
  sound.unlock.mockClear();
});
afterEach(() => {
  vi.useRealTimers();
});

const mount = () =>
  render(
    <MemoryRouter initialEntries={["/dashboard"]}>
      <LiveAlertsProvider><div /></LiveAlertsProvider>
    </MemoryRouter>,
  );

describe("alert sounds are built lazily", () => {
  it("not while requests are in flight; once they have been quiet for a second", async () => {
    requestStarted(); // Home is still loading
    mount();
    await act(async () => { vi.advanceTimersByTime(5000); });
    expect(sound.prepare).not.toHaveBeenCalled();

    requestSettled(); // the last answer is in
    await act(async () => { vi.advanceTimersByTime(900); });
    expect(sound.prepare).not.toHaveBeenCalled();
    await act(async () => { vi.advanceTimersByTime(200); });
    expect(sound.prepare).toHaveBeenCalledTimes(1);
  });

  it("a tap before then still primes the sound", async () => {
    requestStarted();
    try {
      mount();
      fireEvent.pointerDown(window);
      expect(sound.unlock).toHaveBeenCalled();
    } finally {
      requestSettled();
    }
  });
});
