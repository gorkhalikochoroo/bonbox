// Reservations v2 fix round: the door screen's clock turns on the minute,
// not up to 59 s after it (hooks/useMinuteNow.js).
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import useMinuteNow from "../hooks/useMinuteNow";

afterEach(() => vi.useRealTimers());

describe("useMinuteNow", () => {
  it("opened at 18.20.37, it reads 18.21 at 18.21.00 — not at 18.21.37", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 10, 12, 18, 20, 37));
    const { result } = renderHook(() => useMinuteNow());
    const minute = () => new Date(result.current).getMinutes();
    expect(minute()).toBe(20);
    act(() => vi.advanceTimersByTime(23 * 1000 + 100));
    expect(minute()).toBe(21);
    // …and every minute after that, on the minute.
    act(() => vi.advanceTimersByTime(60 * 1000));
    expect(minute()).toBe(22);
    expect(new Date(result.current).getSeconds()).toBe(0);
  });
});
