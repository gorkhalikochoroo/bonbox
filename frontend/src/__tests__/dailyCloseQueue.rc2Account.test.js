/**
 * R-c round 2, CMS-1 (audit, P1 — money integrity, cross-tenant): the Daily
 * close offline queue is the signed-in account's. One device, two accounts
 * (two businesses, a family member, a manager with an account of their own,
 * a demo account): a close queued by A was shown to — and filed (locked) into
 * the books of — whoever signed in next. Now every item names the account
 * that queued it; B never sees, sends or removes A's items, and A's wait for
 * A's next sign-in.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addFailedToOfflineQueue,
  addToOfflineQueue,
  getOfflineQueue,
  removeFromOfflineQueue,
  setQueueAccount,
  syncOfflineQueue,
  updateQueueItem,
  OQ_KEY,
} from "../utils/dailyCloseQueue";

const raw = () => JSON.parse(localStorage.getItem(OQ_KEY) || "[]");

beforeEach(() => { localStorage.clear(); });
afterEach(() => { setQueueAccount(undefined); });

describe("the offline queue is the signed-in account's", () => {
  it("A's queued close is neither shown to nor sent for B — and is still there for A", async () => {
    setQueueAccount("user-a");
    addToOfflineQueue({ date: "2026-10-09", status: "confirmed", revenue_breakdown: { food: 5000 } });
    addFailedToOfflineQueue({ date: "2026-10-08", status: "draft" }, { errorCode: "draft_changed" });
    expect(raw().map((it) => it.account)).toEqual(["user-a", "user-a"]);

    setQueueAccount("user-b");
    expect(getOfflineQueue()).toEqual([]);
    const postB = vi.fn().mockResolvedValue({ data: { id: 1 } });
    const res = await syncOfflineQueue(postB);
    expect(postB).not.toHaveBeenCalled();
    expect(res.remaining).toEqual([]);
    // B's own close goes in beside A's, and B's writes leave A's untouched.
    const b = addToOfflineQueue({ date: "2026-10-09", status: "draft", revenue_breakdown: { food: 700 } });
    removeFromOfflineQueue(b.id);
    updateQueueItem("nope", { x: 1 });
    expect(raw()).toHaveLength(2);
    expect(raw().every((it) => it.account === "user-a")).toBe(true);

    setQueueAccount("user-a");
    expect(getOfflineQueue()).toHaveLength(2);
    const postA = vi.fn().mockResolvedValue({ data: { id: 2 } });
    await syncOfflineQueue(postA);
    expect(postA).toHaveBeenCalledTimes(1);
    expect(postA.mock.calls[0][0]).toMatchObject({ date: "2026-10-09", revenue_breakdown: { food: 5000 } });
  });

  it("signed out: nothing is read, written or sent", async () => {
    setQueueAccount("user-a");
    addToOfflineQueue({ date: "2026-10-09", status: "confirmed" });
    setQueueAccount(null);
    expect(getOfflineQueue()).toEqual([]);
    expect(addToOfflineQueue({ date: "2026-10-10", status: "draft" })).toBeNull();
    const post = vi.fn();
    await syncOfflineQueue(post);
    expect(post).not.toHaveBeenCalled();
    expect(raw()).toHaveLength(1);
  });

  it("a sync stops the moment another account signs in under it — nothing more of A's goes out on B's session", async () => {
    setQueueAccount("user-a");
    addToOfflineQueue({ date: "2026-10-07", status: "confirmed" });
    addToOfflineQueue({ date: "2026-10-08", status: "confirmed" });
    addToOfflineQueue({ date: "2026-10-09", status: "confirmed" });
    const post = vi.fn(async () => {
      // A signs out and B signs in while A's first close is on its way.
      setQueueAccount("user-b");
      return { data: { id: 1 } };
    });
    const res = await syncOfflineQueue(post);
    expect(post).toHaveBeenCalledTimes(1);
    expect(res.stoppedOnAccount).toBe(true);
    // B sees nothing of A's; A's two unsent closes are kept — for A.
    expect(res.remaining).toEqual([]);
    expect(getOfflineQueue()).toEqual([]);
    setQueueAccount("user-a");
    expect(getOfflineQueue().map((it) => it.payload.date)).toEqual(["2026-10-08", "2026-10-09"]);
  });

  it("an item from before this release (no account) is the next signed-in account's, stamped on the first write", () => {
    localStorage.setItem(OQ_KEY, JSON.stringify([{ id: "old", ts: 1, payload: { date: "2026-10-01", status: "draft" } }]));
    setQueueAccount("user-a");
    expect(getOfflineQueue()).toHaveLength(1);
    addToOfflineQueue({ date: "2026-10-02", status: "draft" });
    expect(raw().map((it) => it.account)).toEqual(["user-a", "user-a"]);
    setQueueAccount("user-b");
    expect(getOfflineQueue()).toEqual([]);
  });

  it("never set (no page — a unit test): the whole device's list, as before", () => {
    setQueueAccount(undefined);
    addToOfflineQueue({ date: "2026-10-02", status: "draft" });
    expect(raw()[0].account).toBeUndefined();
    expect(getOfflineQueue()).toHaveLength(1);
  });
});
