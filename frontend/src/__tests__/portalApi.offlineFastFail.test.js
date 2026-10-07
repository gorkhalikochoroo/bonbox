/**
 * Offline: the portal client used to spend ~22 s on backoff retries (a bare
 * spinner / "Tilslutter…") before showing "Ingen forbindelse". When the phone
 * itself reports offline and nothing answered, fail at once — the pages
 * retry on 'online' and on a timer. Online failures keep every retry (a cold
 * Render dyno needs them).
 */
import { afterEach, describe, expect, it, vi } from "vitest";

const portalApi = (await import("../services/portalApi")).default;

const networkError = (config) => {
  const e = new Error("Network Error");
  e.config = config;
  e.code = "ERR_NETWORK";
  return Promise.reject(e);
};

function setOnline(v) {
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => v });
}

afterEach(() => {
  setOnline(true);
  vi.useRealTimers();
});

describe("portalApi retry budget", () => {
  it("offline: one attempt, rejected immediately", async () => {
    setOnline(false);
    const adapter = vi.fn(networkError);
    await expect(portalApi.get("/portal/tok", { adapter })).rejects.toThrow("Network Error");
    expect(adapter).toHaveBeenCalledTimes(1);
  });

  it("online: a dropped request is still retried", async () => {
    vi.useFakeTimers();
    setOnline(true);
    let n = 0;
    const adapter = vi.fn((config) => {
      n += 1;
      return n === 1 ? networkError(config) : Promise.resolve({ data: { ok: true }, status: 200, headers: {}, config });
    });
    const p = portalApi.get("/portal/tok", { adapter });
    await vi.advanceTimersByTimeAsync(1500);
    await expect(p).resolves.toMatchObject({ data: { ok: true } });
    expect(adapter).toHaveBeenCalledTimes(2);
  });
});
