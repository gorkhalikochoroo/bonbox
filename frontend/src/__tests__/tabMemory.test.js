/**
 * The tabs' memory (premium feel P7, components/staff/tabMemory.js): the last
 * server answer per tab, per staff link, in memory only; forgotten when the
 * portal unmounts. Nothing is written to any storage.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { forgetAll, recall, remember } from "../components/staff/tabMemory";

afterEach(() => forgetAll());

describe("tabMemory", () => {
  it("recalls what was remembered, per token and key", () => {
    expect(recall("tokA", "threads")).toBeUndefined();
    const threads = [{ thread_id: "th1" }];
    remember("tokA", "threads", threads);
    expect(recall("tokA", "threads")).toBe(threads);
    expect(recall("tokB", "threads")).toBeUndefined();     // another staff link
    expect(recall("tokA", "alerts")).toBeUndefined();      // another tab
    remember("tokA", "threads", []);
    expect(recall("tokA", "threads")).toEqual([]);
  });

  it("forgetAll empties it (the portal unmounted: a disconnect or another token)", () => {
    remember("tokA", "swaps", { inbox: [], pool: [] });
    remember("tokB", "alerts", []);
    forgetAll();
    expect(recall("tokA", "swaps")).toBeUndefined();
    expect(recall("tokB", "alerts")).toBeUndefined();
  });

  it("memory only: never localStorage or sessionStorage", () => {
    const ls = vi.spyOn(Storage.prototype, "setItem");
    remember("tokA", "avail", [{ id: 1 }]);
    expect(ls).not.toHaveBeenCalled();
    ls.mockRestore();
  });
});
