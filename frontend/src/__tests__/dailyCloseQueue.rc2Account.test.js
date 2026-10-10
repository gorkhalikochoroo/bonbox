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

  // R-c round 2 fix-up (review: attacker + removal lenses) — CONTRACT
  // CHANGE, listed as a narrowing: an item from before this release names no
  // account and whose it is cannot be told. It used to be the next signed-in
  // account's — sent on its session and stamped as its own on the first
  // write (CMS-1 once more for every copy on a phone at the deploy). Now it
  // is shown to whoever is signed in as unclaimed, never sent by itself and
  // never stamped by another write; the owner claims it by sending it
  // (dailyCloseQueue.rc2FixUp.test.js).
  it("an item from before this release (no account) is shown, never sent by itself, never stamped by another write", async () => {
    localStorage.setItem(OQ_KEY, JSON.stringify([{ id: "old", ts: 1, payload: { date: "2026-10-01", status: "draft" } }]));
    setQueueAccount("user-a");
    expect(getOfflineQueue()).toHaveLength(1);
    addToOfflineQueue({ date: "2026-10-02", status: "draft" });
    expect(raw().map((it) => it.account)).toEqual([undefined, "user-a"]);
    const post = vi.fn().mockResolvedValue({ data: { id: 1 } });
    await syncOfflineQueue(post);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toMatchObject({ date: "2026-10-02", account_id: "user-a" });
    expect(raw().map((it) => it.id)).toEqual(["old"]);
    setQueueAccount("user-b");
    expect(getOfflineQueue().map((it) => it.id)).toEqual(["old"]);
  });

  it("never set (no page — a unit test): the whole device's list, as before", () => {
    setQueueAccount(undefined);
    addToOfflineQueue({ date: "2026-10-02", status: "draft" });
    expect(raw()[0].account).toBeUndefined();
    expect(getOfflineQueue()).toHaveLength(1);
  });
});
