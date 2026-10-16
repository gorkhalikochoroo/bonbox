/**
 * K security: Home's in-memory copy (lib/swrCache) only exists on a device
 * KNOWN not to be shared. DeviceShareProvider is the one who knows:
 *   • /auth/device-pin/status says shared:false → copy allowed;
 *   • shared:true → never;
 *   • the probe failed → "could not check" is not "not shared" → never;
 *   • before the probe has answered → never.
 * Probed through the cache's public API: a dashboard write only sticks when
 * the copy is allowed.
 */
import { render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const get = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(() => Promise.resolve({ data: {} })) },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "o1", role: "owner" } }),
}));

const { DeviceShareProvider } = await import("../hooks/useDeviceShare");
const swr = await import("../lib/swrCache");

const DAY = "2026-10-16";
const canKeep = () => swr.writeDashboard(DAY, { summary: {} }, swr.cacheGeneration());

beforeEach(() => {
  get.mockReset();
  swr.__resetSwrCacheForTests();
  swr.setCacheAccount(swr.accountKeyFor({ id: "o1", role: "owner" }));
});

describe("Home's copy follows the device-share probe", () => {
  it("not shared → allowed (only once the probe has answered)", async () => {
    let answer;
    get.mockImplementation(() => new Promise((r) => { answer = r; }));
    render(<DeviceShareProvider><div /></DeviceShareProvider>);
    await waitFor(() => expect(get).toHaveBeenCalledWith("/auth/device-pin/status"));
    expect(canKeep()).toBe(false); // still unknown
    answer({ data: { shared: false, has_pin: false, locked: false } });
    await waitFor(() => expect(canKeep()).toBe(true));
  });

  it("shared → never", async () => {
    get.mockResolvedValue({ data: { shared: true, has_pin: true, locked: true } });
    render(<DeviceShareProvider><div /></DeviceShareProvider>);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(canKeep()).toBe(false);
  });

  it("probe failed → never (could not check is not 'not shared')", async () => {
    get.mockRejectedValue(new Error("503"));
    render(<DeviceShareProvider><div /></DeviceShareProvider>);
    await waitFor(() => expect(get).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(canKeep()).toBe(false);
  });
});
