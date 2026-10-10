/**
 * R-c round 2 fix-up — the offline queue's half of the round-2 review.
 *
 *  - Every request the queue sends names the account it was queued for
 *    (account_id): the server refuses it on another account's session
 *    (409 account_changed) — the account can change under a sync while a
 *    request is on its way (axios re-sends a 503 with whatever credential is
 *    current then), and a web tab can hold another account's queue while the
 *    login cookie is shared. The sync then stops and keeps everything.
 *  - A copy from before this release names no account: shown to whoever is
 *    signed in, never sent by itself, claimed only by the owner's "Send".
 *    Refused for another account's branch, it is hidden from that account.
 *  - A copy that met a signed-out session (401) is kept, waiting, said as
 *    that — never "refused, check the numbers".
 *  - withQueueAccount: a Daily close form's copies stay the account it was
 *    opened for, whoever is signed in by the time it writes.
 *  - A queued move answered 404/405 (a server without the move endpoint)
 *    waits; one refused because its old day is locked, or because its draft
 *    was moved to another day already, says so.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  addFailedToOfflineQueue,
  addToOfflineQueue,
  claimQueueItem,
  disownQueueItem,
  getOfflineQueue,
  isRefusalOfFigures,
  isUnclaimed,
  moveRequestOf,
  payloadOf,
  queueAccount,
  setQueueAccount,
  syncOfflineQueue,
  updateQueueItem,
  withQueueAccount,
  OQ_KEY,
  OQ_MOVES_KEY,
  QUEUE_ERR_BRANCH_NOT_OWNED,
  QUEUE_ERR_MOVED_ELSEWHERE,
  QUEUE_ERR_OLD_DAY_LOCKED,
  QUEUE_ERR_SIGNED_OUT,
  QUEUE_FAILED,
  QUEUE_WAITING_NETWORK,
} from "../utils/dailyCloseQueue";

const raw = () => [...JSON.parse(localStorage.getItem(OQ_KEY) || "[]"), ...JSON.parse(localStorage.getItem(OQ_MOVES_KEY) || "[]")];
const answered = (status, detail) => Object.assign(new Error(`status ${status}`), { response: { status, data: { detail } } });
const move = (over = {}) => ({ from_date: "2026-10-10", from_branch_id: null, from_base_updated_at: "2026-10-10T08:00:00", from_base_save_id: null, also_from: [], save_id: "mv-1", ...over });

beforeEach(() => { localStorage.clear(); });
afterEach(() => { setQueueAccount(undefined); });

describe("every queued request names the account it was queued for", () => {
  it("a plain copy and a move both carry account_id", async () => {
    setQueueAccount("user-a");
    addToOfflineQueue({ date: "2026-10-09", status: "draft", revenue_breakdown: { food: 5000 } });
    addToOfflineQueue({ date: "2026-10-08", status: "draft", revenue_breakdown: { food: 3000 } }, { move: move() });
    const post = vi.fn().mockResolvedValue({ data: { id: 1 } });
    const postMove = vi.fn().mockResolvedValue({ data: { moved: true } });
    await syncOfflineQueue(post, { postMove });
    expect(post.mock.calls[0][0]).toMatchObject({ date: "2026-10-09", account_id: "user-a" });
    expect(postMove.mock.calls[0][0]).toMatchObject({ account_id: "user-a", to_date: "2026-10-08" });
    expect(getOfflineQueue()).toEqual([]);
  });

  it("the server says another account is signed in (409 account_changed): nothing more goes, everything is kept", async () => {
    setQueueAccount("user-a");
    addToOfflineQueue({ date: "2026-10-07", status: "confirmed" });
    addToOfflineQueue({ date: "2026-10-08", status: "confirmed" });
    const post = vi.fn().mockRejectedValue(answered(409, { code: "account_changed" }));
    const res = await syncOfflineQueue(post);
    expect(post).toHaveBeenCalledTimes(1);
    expect(res.stoppedOnAccount).toBe(true);
    expect(raw().map((it) => [it.payload.date, it.state, it.account])).toEqual([
      ["2026-10-07", QUEUE_WAITING_NETWORK, "user-a"], ["2026-10-08", QUEUE_WAITING_NETWORK, "user-a"],
    ]);
  });
});

describe("a copy from before this release (no account)", () => {
  const legacy = (over = {}) => localStorage.setItem(OQ_KEY, JSON.stringify([{ id: "old", ts: 1, payload: { date: "2026-10-01", status: "draft", revenue_breakdown: { food: 900 } }, ...over }]));

  it("is unclaimed: shown, never sent by the sync, until the owner's Send claims it", async () => {
    legacy();
    setQueueAccount("user-b");
    const [it0] = getOfflineQueue();
    expect(isUnclaimed(it0)).toBe(true);
    const post = vi.fn().mockResolvedValue({ data: { id: 1 } });
    await syncOfflineQueue(post);
    expect(post).not.toHaveBeenCalled();
    claimQueueItem("old");
    expect(raw()[0].account).toBe("user-b");
    expect(payloadOf(raw()[0])).toMatchObject({ account_id: "user-b" });
    await syncOfflineQueue(post);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toMatchObject({ date: "2026-10-01", account_id: "user-b" });
  });

  it("refused for another account's branch: hidden from that account, waiting for the account it belongs to", () => {
    legacy({ payload: { date: "2026-10-01", status: "draft", branch_id: "a-branch" } });
    setQueueAccount("user-b");
    claimQueueItem("old");
    disownQueueItem("old");
    expect(getOfflineQueue()).toEqual([]);
    setQueueAccount("user-a");
    expect(getOfflineQueue().map((it) => [it.id, isUnclaimed(it)])).toEqual([["old", true]]);
  });

  it("never unclaimed without a signed-in account (a unit test, no page): the whole device's, as before", async () => {
    legacy();
    setQueueAccount(undefined);
    expect(isUnclaimed(getOfflineQueue()[0])).toBe(false);
    const post = vi.fn().mockResolvedValue({ data: { id: 1 } });
    await syncOfflineQueue(post);
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe("answers that are not about the figures", () => {
  it("a 401 (signed out when it arrived) keeps the copy waiting, says so, and keeps everything behind it", async () => {
    setQueueAccount("user-a");
    addToOfflineQueue({ date: "2026-10-07", status: "draft" });
    addToOfflineQueue({ date: "2026-10-08", status: "draft" });
    const post = vi.fn().mockRejectedValue(answered(401, "Not authenticated"));
    const res = await syncOfflineQueue(post);
    expect(post).toHaveBeenCalledTimes(1);
    expect(res.stoppedOnNetwork).toBe(true);
    expect(raw().map((it) => [it.payload.date, it.state, it.errorCode || null])).toEqual([
      ["2026-10-07", QUEUE_WAITING_NETWORK, QUEUE_ERR_SIGNED_OUT], ["2026-10-08", QUEUE_WAITING_NETWORK, null],
    ]);
  });

  it("a branch that is not the account's (403 branch_not_owned) is its own reason", async () => {
    setQueueAccount("user-a");
    addToOfflineQueue({ date: "2026-10-07", status: "draft", branch_id: "x" });
    await syncOfflineQueue(vi.fn().mockRejectedValue(answered(403, { code: "branch_not_owned" })));
    expect(raw()[0]).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_BRANCH_NOT_OWNED });
  });

  it("a queued move answered 404 / 405 (no move endpoint on that server) waits — never refused", async () => {
    setQueueAccount("user-a");
    addToOfflineQueue({ date: "2026-10-08", status: "draft" }, { move: move() });
    const postMove = vi.fn().mockRejectedValue(answered(405, "Method Not Allowed"));
    await syncOfflineQueue(vi.fn(), { postMove });
    expect(raw()[0]).toMatchObject({ state: QUEUE_WAITING_NETWORK, move: { save_id: "mv-1" } });
  });

  it("a move off a locked day, or of a draft moved elsewhere, says which (nothing moved)", async () => {
    setQueueAccount("user-a");
    addToOfflineQueue({ date: "2026-10-08", status: "draft" }, { move: move() });
    addToOfflineQueue({ date: "2026-10-06", status: "draft" }, { move: move({ save_id: "mv-2" }) });
    const postMove = vi.fn()
      .mockRejectedValueOnce(answered(409, { code: "old_day_locked", date: "2026-10-10" }))
      .mockRejectedValueOnce(answered(409, { code: "moved_elsewhere", date: "2026-10-10", to: "2026-10-09" }));
    await syncOfflineQueue(vi.fn(), { postMove });
    expect(raw().map((it) => [it.errorCode, it.refusedDay, it.movedTo || null])).toEqual([
      [QUEUE_ERR_OLD_DAY_LOCKED, "2026-10-10", null], [QUEUE_ERR_MOVED_ELSEWHERE, "2026-10-10", "2026-10-09"],
    ]);
  });

  it("only a refusal of the figures counts as one", () => {
    expect([400, 409, 412, 422, 423].map((s) => isRefusalOfFigures(answered(s, {})))).toEqual([true, true, true, true, true]);
    expect([401, 403, 404, 405, 429, 500, 503].map((s) => isRefusalOfFigures(answered(s, {})))).toEqual([false, false, false, false, false, false, false]);
    expect(isRefusalOfFigures(answered(409, { code: "account_changed" }))).toBe(false);
    expect(isRefusalOfFigures(new Error("Network Error"))).toBe(false);
  });
});

describe("withQueueAccount — a form's copies stay its own account's", () => {
  it("written for A while B is signed in: A's, unseen by B, and the signed-in account is unchanged", () => {
    setQueueAccount("user-b");
    const kept = withQueueAccount("user-a", () => addFailedToOfflineQueue({ date: "2026-10-09", status: "draft", revenue_breakdown: { food: 7777 } }, { errorCode: "draft_changed" }));
    expect(kept.account).toBe("user-a");
    expect(queueAccount()).toBe("user-b");
    expect(getOfflineQueue()).toEqual([]);
    setQueueAccount("user-a");
    expect(getOfflineQueue()).toHaveLength(1);
  });

  it("signed out meanwhile (null): the form's copy is still kept for its own account", () => {
    setQueueAccount(null);
    const kept = withQueueAccount("user-a", () => addToOfflineQueue({ date: "2026-10-09", status: "draft" }));
    expect(kept).not.toBeNull();
    expect(queueAccount()).toBeNull();
    setQueueAccount("user-a");
    expect(getOfflineQueue()).toHaveLength(1);
  });

  it("a queued move's request names the account it was queued for", () => {
    setQueueAccount("user-a");
    const it0 = addToOfflineQueue({ date: "2026-10-08", status: "draft" }, { move: move() });
    setQueueAccount("user-b");
    expect(moveRequestOf(it0).account_id).toBe("user-a");
  });
});

describe("queued moves are kept under a key of their own (code from before R-c never sees them)", () => {
  it("a pre-R-c sync reading OQ_KEY finds no move to post as a plain save, and its rewrite of that key erases none", async () => {
    setQueueAccount("user-a");
    addToOfflineQueue({ date: "2026-10-07", status: "draft", revenue_breakdown: { food: 100 } });
    addToOfflineQueue({ date: "2026-10-08", status: "draft", revenue_breakdown: { food: 12000 }, save_id: "mv-1" }, { move: move() });
    const oldList = JSON.parse(localStorage.getItem(OQ_KEY) || "[]");
    expect(oldList.map((it) => it.payload.date)).toEqual(["2026-10-07"]);
    expect(oldList.some((it) => it.move)).toBe(false);
    // The old code's sync: posts what it reads, then writes back what is left.
    localStorage.setItem(OQ_KEY, JSON.stringify([]));
    expect(getOfflineQueue().map((it) => [it.payload.date, Boolean(it.move)])).toEqual([["2026-10-08", true]]);
  });

  it("the two keys are one list, in the order queued, and a copy that becomes a move changes key", () => {
    setQueueAccount("user-a");
    const a = addToOfflineQueue({ date: "2026-10-06", status: "draft" });
    addToOfflineQueue({ date: "2026-10-07", status: "draft" }, { move: move({ save_id: "mv-7" }) });
    addToOfflineQueue({ date: "2026-10-08", status: "draft" });
    expect(getOfflineQueue().map((it) => it.payload.date)).toEqual(["2026-10-06", "2026-10-07", "2026-10-08"]);
    updateQueueItem(a.id, { move: move({ save_id: "mv-6" }) });
    expect(JSON.parse(localStorage.getItem(OQ_KEY)).map((it) => it.payload.date)).toEqual(["2026-10-08"]);
    expect(JSON.parse(localStorage.getItem(OQ_MOVES_KEY)).map((it) => it.payload.date).sort()).toEqual(["2026-10-06", "2026-10-07"]);
    expect(getOfflineQueue().map((it) => it.payload.date)).toEqual(["2026-10-06", "2026-10-07", "2026-10-08"]);
    // Nothing left under the moves key: the key goes.
    for (const it of getOfflineQueue()) if (it.move) updateQueueItem(it.id, { move: null });
    expect(localStorage.getItem(OQ_MOVES_KEY)).toBeNull();
  });
});
