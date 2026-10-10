/**
 * R-c round 2 — a date move kept on this phone is ONE queued move: the new
 * day's draft (`payload`) with a `move` envelope, sent as the move (POST
 * /daily-close/move, its own save_id — the server answers a move it already
 * did with what it did), never as a plain save of the new day that leaves the
 * old day's draft behind. A page still open holds the move it is sending
 * itself: the sync never sends it beside the page.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addToOfflineQueue,
  getOfflineQueue,
  isQueuedMove,
  moveRequestOf,
  registerQueueHolder,
  releaseQueueHolder,
  syncOfflineQueue,
  updateQueueItem,
  QUEUE_ALREADY_SAVED,
  QUEUE_ERR_DRAFT_CHANGED,
  QUEUE_ERR_REJECTED,
  QUEUE_FAILED,
} from "../utils/dailyCloseQueue";

const httpError = (status, detail) => Object.assign(new Error(`status ${status}`), { response: { status, data: { detail } } });
const networkError = () => Object.assign(new Error("Network Error"), { response: undefined });

const MOVE = {
  from_date: "2026-10-09", from_branch_id: null, from_base_updated_at: "2026-10-09T08:00:00",
  from_base_save_id: null, also_from: [], save_id: "move-1",
};
const body = { date: "2026-10-08", status: "draft", revenue_breakdown: { food: 12000 }, base_updated_at: "1970-01-01T00:00:00" };

beforeEach(() => localStorage.clear());

describe("a queued move", () => {
  it("is sent as the move — one request with its own save_id — never as a plain save", async () => {
    addToOfflineQueue(body, { move: MOVE });
    const post = vi.fn();
    const postMove = vi.fn().mockResolvedValue({ data: { moved: true, close: { id: "r2" } } });
    const onSent = vi.fn();
    const res = await syncOfflineQueue(post, { postMove, onSent });
    expect(post).not.toHaveBeenCalled();
    expect(postMove).toHaveBeenCalledTimes(1);
    expect(postMove.mock.calls[0][0]).toEqual({
      from_date: "2026-10-09", from_branch_id: null, from_base_updated_at: "2026-10-09T08:00:00",
      from_base_save_id: null, also_from: [], to_date: "2026-10-08", to_base_updated_at: "1970-01-01T00:00:00",
      body: { ...body, save_id: "move-1" }, save_id: "move-1",
    });
    expect(res.synced).toBe(1);
    expect(getOfflineQueue()).toEqual([]);
    expect(onSent).toHaveBeenCalledWith(expect.objectContaining({ move: MOVE }), { moved: true, close: { id: "r2" } });
  });

  it("is kept when the caller cannot send moves (never sent as a plain save instead)", async () => {
    addToOfflineQueue(body, { move: MOVE });
    const post = vi.fn();
    const res = await syncOfflineQueue(post);
    expect(post).not.toHaveBeenCalled();
    expect(res.remaining).toHaveLength(1);
  });

  it("whose new day is locked (409) is failed and kept — never \"already saved\" (nothing moved)", async () => {
    addToOfflineQueue(body, { move: MOVE });
    await syncOfflineQueue(vi.fn(), { postMove: vi.fn().mockRejectedValue(httpError(409, "locked")) });
    const [it] = getOfflineQueue();
    expect(it.state).toBe(QUEUE_FAILED);
    expect(it.errorCode).toBe(QUEUE_ERR_REJECTED);
    expect(it.state).not.toBe(QUEUE_ALREADY_SAVED);
  });

  it("refused because the new day changed (412) waits for the owner, with the newer version's stamp", async () => {
    addToOfflineQueue(body, { move: MOVE });
    await syncOfflineQueue(vi.fn(), {
      postMove: vi.fn().mockRejectedValue(httpError(412, { code: "draft_changed", updated_at: "2026-10-08T09:00:00" })),
    });
    const [it] = getOfflineQueue();
    expect(it).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: "2026-10-08T09:00:00" });
  });

  it("with no answer stays (and so does everything behind it)", async () => {
    addToOfflineQueue(body, { move: MOVE });
    addToOfflineQueue({ date: "2026-10-07", status: "draft" });
    const post = vi.fn();
    const res = await syncOfflineQueue(post, { postMove: vi.fn().mockRejectedValue(networkError()) });
    expect(res.stoppedOnNetwork).toBe(true);
    expect(post).not.toHaveBeenCalled();
    expect(getOfflineQueue()).toHaveLength(2);
  });

  it("held by a page still open is never sent beside it; once the page is gone it is", async () => {
    const holder = registerQueueHolder();
    addToOfflineQueue(body, { move: MOVE, heldBy: holder });
    const postMove = vi.fn().mockResolvedValue({ data: { moved: true } });
    await syncOfflineQueue(vi.fn(), { postMove });
    expect(postMove).not.toHaveBeenCalled();
    expect(getOfflineQueue()).toHaveLength(1);
    releaseQueueHolder(holder);
    await syncOfflineQueue(vi.fn(), { postMove });
    expect(postMove).toHaveBeenCalledTimes(1);
    expect(getOfflineQueue()).toEqual([]);
  });

  it("moveRequestOf sends it on the version chosen (\"keep mine\")", () => {
    const [item] = [addToOfflineQueue(body, { move: MOVE })];
    expect(isQueuedMove(item)).toBe(true);
    expect(moveRequestOf(item, { toBase: "2026-10-08T09:00:00" })).toMatchObject({
      to_base_updated_at: "2026-10-08T09:00:00", body: { base_updated_at: "2026-10-08T09:00:00", save_id: "move-1" },
    });
  });
});

describe("an item changed while a sync was on the network", () => {
  it("keeps the newer copy — the sync decided about the one it read", async () => {
    const item = addToOfflineQueue({ date: "2026-10-07", status: "draft", revenue_breakdown: { food: 100 } });
    const post = vi.fn(async () => {
      // The page puts newer figures in the copy while the old one is on its way.
      updateQueueItem(item.id, { payload: { date: "2026-10-07", status: "draft", revenue_breakdown: { food: 200 } } });
      return { data: { id: 1 } };
    });
    await syncOfflineQueue(post);
    const [left] = getOfflineQueue();
    expect(left.payload.revenue_breakdown).toEqual({ food: 200 });
  });
});
