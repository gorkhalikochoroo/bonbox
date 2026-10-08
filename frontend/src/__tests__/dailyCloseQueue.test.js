/**
 * The offline daily-close queue — the one place a locked close can be held on
 * the device, and therefore the one place it can be LOST.
 *
 * Two real losses lived in the old inline version of this code:
 *   (a) a failure mid-queue pushed only the FAILING item to `remaining`, so
 *       every close queued behind it was erased by the write that followed;
 *   (b) the anomaly guard answers HTTP 200 {requires_confirmation: true} and
 *       saves NOTHING, and the loop counted any 2xx as sent.
 *
 * A close is a signed kasserapport in waiting. Every path below either keeps
 * it or proves it reached the server — nothing in between.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  addFailedToOfflineQueue,
  addToOfflineQueue,
  draftChangedStamp,
  isDraftChanged,
  firstNeedingConfirmation,
  getOfflineQueue,
  queueSummary,
  removeFromOfflineQueue,
  syncOfflineQueue,
  updateQueueItem,
  OQ_KEY,
  QUEUE_ALREADY_SAVED,
  QUEUE_ERR_DELETED_LOCKED,
  QUEUE_ERR_DRAFT_CHANGED,
  QUEUE_ERR_REJECTED,
  QUEUE_ERR_SERVER,
  QUEUE_FAILED,
  QUEUE_NEEDS_CONFIRMATION,
} from "../utils/dailyCloseQueue";

/** An axios-shaped network failure: no `response` at all. */
const networkError = () => Object.assign(new Error("Network Error"), { response: undefined });

/** An axios-shaped HTTP failure with a FastAPI detail string. */
const httpError = (status, detail) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: { detail } },
  });

const seed = (payloads) => payloads.forEach((p) => addToOfflineQueue(p));

beforeEach(() => {
  localStorage.clear();
});

describe("syncOfflineQueue", () => {
  it("empties the queue when every close reaches the server", async () => {
    seed([{ date: "2026-09-14" }, { date: "2026-09-15" }, { date: "2026-09-16" }]);
    const post = vi.fn().mockResolvedValue({ data: { id: 1 } });

    const res = await syncOfflineQueue(post);

    expect(post).toHaveBeenCalledTimes(3);
    expect(res.synced).toBe(3);
    expect(res.remaining).toEqual([]);
    expect(getOfflineQueue()).toEqual([]);
  });

  it("keeps the failing close AND everything queued behind it on a network error", async () => {
    // THE BUG: this used to keep one item and delete the other two.
    seed([{ date: "2026-09-14" }, { date: "2026-09-15" }, { date: "2026-09-16" }]);
    const post = vi.fn()
      .mockResolvedValueOnce({ data: { id: 1 } })
      .mockRejectedValueOnce(networkError())
      .mockResolvedValue({ data: { id: 3 } });

    const res = await syncOfflineQueue(post);

    // The third close is never even attempted — the network is down.
    expect(post).toHaveBeenCalledTimes(2);
    expect(res.stoppedOnNetwork).toBe(true);
    expect(res.synced).toBe(1);
    expect(res.remaining.map((i) => i.payload.date)).toEqual(["2026-09-15", "2026-09-16"]);
    expect(getOfflineQueue().map((i) => i.payload.date)).toEqual(["2026-09-15", "2026-09-16"]);
  });

  it("keeps a close the anomaly guard stopped, and never auto-acknowledges it", async () => {
    seed([{ date: "2026-09-15", revenue_breakdown: { food: 2234 } }]);
    const post = vi.fn().mockResolvedValue({
      data: {
        requires_confirmation: true,
        anomaly: { reason: "low", today_total: 2234, baseline_avg: 22340, delta_pct: -0.9 },
      },
    });

    const res = await syncOfflineQueue(post);

    expect(res.synced).toBe(0);
    expect(res.needsConfirmation).toBe(1);
    expect(getOfflineQueue()).toHaveLength(1);
    const [held] = getOfflineQueue();
    expect(held.state).toBe(QUEUE_NEEDS_CONFIRMATION);
    expect(held.anomaly.reason).toBe("low");
    // The payload is untouched: acknowledge_anomaly is the owner's word, not ours.
    expect(held.payload.acknowledge_anomaly).toBeUndefined();
    expect(post).toHaveBeenCalledWith({ date: "2026-09-15", revenue_breakdown: { food: 2234 } });
  });

  it("does not re-post a close that is already waiting for the owner", async () => {
    seed([{ date: "2026-09-15" }]);
    const guard = vi.fn().mockResolvedValue({
      data: { requires_confirmation: true, anomaly: { reason: "high" } },
    });
    await syncOfflineQueue(guard);

    const second = vi.fn().mockResolvedValue({ data: { id: 9 } });
    const res = await syncOfflineQueue(second);

    expect(second).not.toHaveBeenCalled();
    expect(res.needsConfirmation).toBe(1);
    expect(getOfflineQueue()).toHaveLength(1);
  });

  it("keeps a 4xx close with its reason instead of dropping it", async () => {
    seed([{ date: "2026-09-15" }]);
    const post = vi.fn().mockRejectedValue(httpError(422, "revenue_total: must be positive"));

    const res = await syncOfflineQueue(post);

    expect(res.synced).toBe(0);
    expect(res.failed).toBe(1);
    const [held] = getOfflineQueue();
    expect(held.state).toBe(QUEUE_FAILED);
    expect(held.httpStatus).toBe(422);
    // A CODE the page can translate, plus the raw server text as detail. An
    // English sentence baked in here is an English sentence in a Danish
    // audit trail — the one surface that says money was not saved.
    expect(held.errorCode).toBe(QUEUE_ERR_REJECTED);
    expect(held.errorDetail).toMatch(/positive/i);
  });

  it("classifies a 5xx as a server-side reason, not a refused close", async () => {
    seed([{ date: "2026-09-15" }]);
    await syncOfflineQueue(vi.fn().mockRejectedValue(httpError(503, "Service Unavailable")));
    expect(getOfflineQueue()[0].errorCode).toBe(QUEUE_ERR_SERVER);
  });

  it("stops retrying a date the server has already locked, and says so", async () => {
    // Path this actually takes in the field: our POST committed, the response
    // was lost on flaky 4G, and the retry hits the lock guard. The money IS in
    // the books — retrying forever under "couldn't be saved" is a false alarm.
    seed([{ date: "2026-09-15" }]);
    const post = vi.fn().mockRejectedValue(
      httpError(409, "This daily close is locked. Unlock it first to make changes."),
    );

    const res = await syncOfflineQueue(post);

    expect(res.failed).toBe(0);
    expect(res.alreadySaved).toBe(1);
    expect(getOfflineQueue()[0].state).toBe(QUEUE_ALREADY_SAVED);

    // ...and the next sync does not re-post it.
    const again = vi.fn().mockResolvedValue({ data: {} });
    await syncOfflineQueue(again);
    expect(again).not.toHaveBeenCalled();
  });

  // Round 20 review: a branch day held by a deleted, LOCKED kasserapport is
  // refused (423 deleted_locked_close). Nothing of the day is in the books —
  // this queued copy is the only one, so it is never "already saved" (whose
  // row offers "remove this copy" as a spare).
  it.each([423, 409])("a %s with code deleted_locked_close is never ALREADY_SAVED: kept, failed, with the server's words", async (status) => {
    seed([{ date: "2026-09-15", revenue_total: 7000 }]);
    const said = "Der ligger en slettet, låst kasserapport for denne dag og afdeling. Den bevares (bogføringsloven) og kan ikke overskrives — kontakt support.";
    const post = vi.fn().mockRejectedValue(httpError(status, { code: "deleted_locked_close", message: said }));

    const res = await syncOfflineQueue(post);

    expect(res.alreadySaved).toBe(0);
    expect(res.failed).toBe(1);
    const [item] = getOfflineQueue();
    expect(item.state).toBe(QUEUE_FAILED);
    expect(item.errorCode).toBe(QUEUE_ERR_DELETED_LOCKED);
    expect(item.errorDetail).toBe(said);
    expect(item.payload.revenue_total).toBe(7000);
  });

  it("never erases a close queued WHILE a sync is in flight", async () => {
    // The original module fixed the loop and then re-created the same deletion
    // one level up: snapshot at the top, overwrite at the bottom. The owner
    // locks tonight's close on marginal 4G — which is exactly when the
    // "online" listener fires a sync — and it was gone without ever being sent.
    seed([{ date: "2026-09-16", revenue_total: 17030 }]);
    let release;
    const hung = new Promise((r) => { release = r; });
    const post = vi.fn(() => hung.then(() => ({ data: { id: 1 } })));

    const inFlight = syncOfflineQueue(post);
    addToOfflineQueue({ date: "2026-09-17", revenue_total: 22400 });
    release();
    const res = await inFlight;

    expect(post).toHaveBeenCalledTimes(1); // the newcomer was never in the snapshot
    expect(res.remaining.map((i) => i.payload.date)).toEqual(["2026-09-17"]);
    expect(getOfflineQueue().map((i) => i.payload.date)).toEqual(["2026-09-17"]);
  });

  it("does not resurrect an item another writer removed during the sync", async () => {
    seed([{ date: "2026-09-16" }, { date: "2026-09-17" }]);
    const [first] = getOfflineQueue();
    let release;
    const hung = new Promise((r) => { release = r; });
    const post = vi.fn()
      .mockImplementationOnce(() => hung.then(() => { throw httpError(500, "boom"); }))
      .mockResolvedValue({ data: { id: 2 } });

    const inFlight = syncOfflineQueue(post);
    removeFromOfflineQueue(first.id); // owner tapped "remove this copy"
    release();
    await inFlight;

    expect(getOfflineQueue().map((i) => i.payload.date)).toEqual([]);
  });

  it("keeps a 500 close too, and still tries the ones behind it", async () => {
    seed([{ date: "2026-09-14" }, { date: "2026-09-15" }]);
    const post = vi.fn()
      .mockRejectedValueOnce(httpError(500, "Internal Server Error"))
      .mockResolvedValueOnce({ data: { id: 2 } });

    const res = await syncOfflineQueue(post);

    expect(post).toHaveBeenCalledTimes(2);
    expect(res.synced).toBe(1);
    expect(res.remaining.map((i) => i.payload.date)).toEqual(["2026-09-14"]);
  });

  it("retries a previously failed close on the next sync", async () => {
    seed([{ date: "2026-09-15" }]);
    await syncOfflineQueue(vi.fn().mockRejectedValue(httpError(503, "Service Unavailable")));
    expect(queueSummary(getOfflineQueue()).failed).toBe(1);

    const res = await syncOfflineQueue(vi.fn().mockResolvedValue({ data: { id: 1 } }));

    expect(res.synced).toBe(1);
    expect(getOfflineQueue()).toEqual([]);
  });

  it("is a no-op on an empty queue", async () => {
    const post = vi.fn();
    const res = await syncOfflineQueue(post);
    expect(post).not.toHaveBeenCalled();
    expect(res.total).toBe(0);
  });
});

describe("queue storage", () => {
  it("never throws on corrupt localStorage", () => {
    localStorage.setItem(OQ_KEY, "{not json at all");
    expect(() => getOfflineQueue()).not.toThrow();
    expect(getOfflineQueue()).toEqual([]);
  });

  it("never throws when the stored value is not an array", () => {
    localStorage.setItem(OQ_KEY, JSON.stringify({ payload: "nope" }));
    expect(getOfflineQueue()).toEqual([]);
  });

  it("drops entries that carry no payload — an item we cannot POST is not a close", () => {
    localStorage.setItem(OQ_KEY, JSON.stringify([null, 7, { id: "x" }, { id: "y", payload: { date: "2026-09-15" } }]));
    expect(getOfflineQueue().map((i) => i.id)).toEqual(["y"]);
  });

  it("survives a syncOfflineQueue over corrupt storage", async () => {
    localStorage.setItem(OQ_KEY, "]]][[[");
    const post = vi.fn();
    await expect(syncOfflineQueue(post)).resolves.toMatchObject({ total: 0 });
    expect(post).not.toHaveBeenCalled();
  });
});

describe("queueSummary", () => {
  it("counts waiting-for-network and waiting-for-you separately", () => {
    const items = [
      { id: "a", payload: {} },
      { id: "b", payload: {}, state: QUEUE_NEEDS_CONFIRMATION },
      { id: "c", payload: {}, state: QUEUE_FAILED },
      { id: "d", payload: {}, state: QUEUE_NEEDS_CONFIRMATION },
    ];
    expect(queueSummary(items)).toEqual({
      total: 4, waitingNetwork: 1, needsConfirmation: 2, failed: 1, alreadySaved: 0,
    });
  });

  it("treats a never-tried item as waiting for the network", () => {
    expect(queueSummary([{ id: "a", payload: {} }]).waitingNetwork).toBe(1);
  });
});

describe("queue edits", () => {
  it("removes one close by id after the owner acknowledges it", () => {
    seed([{ date: "2026-09-14" }, { date: "2026-09-15" }]);
    const [first] = getOfflineQueue();
    const left = removeFromOfflineQueue(first.id);
    expect(left).toHaveLength(1);
    expect(getOfflineQueue().map((i) => i.payload.date)).toEqual(["2026-09-15"]);
  });

  it("patches one close and leaves the rest alone", () => {
    seed([{ date: "2026-09-14" }, { date: "2026-09-15" }]);
    const [, second] = getOfflineQueue();
    updateQueueItem(second.id, { state: QUEUE_FAILED, error: "nope" });
    const [a, b] = getOfflineQueue();
    expect(a.state).not.toBe(QUEUE_FAILED);
    expect(b.error).toBe("nope");
  });

  it("finds the first close blocked on the owner", () => {
    const items = [
      { id: "a", payload: {} },
      { id: "b", payload: {}, state: QUEUE_NEEDS_CONFIRMATION },
    ];
    expect(firstNeedingConfirmation(items).id).toBe("b");
    expect(firstNeedingConfirmation([])).toBeNull();
  });
});

/* ─── round 21: a copy that met draft_changed ───────────────────────── */

describe("a queued copy refused as draft_changed (round 21)", () => {
  const draftChanged = (stamp) => Object.assign(new Error("Request failed with status code 412"), {
    response: { status: 412, data: { detail: { code: "draft_changed", updated_at: stamp, current: { id: "r1", updated_at: stamp } } } },
  });
  // Even a server that said it as a 409: never "already saved".
  const draftChanged409 = (stamp) => Object.assign(new Error("Request failed with status code 409"), {
    response: { status: 409, data: { detail: { code: "draft_changed", updated_at: stamp } } },
  });

  beforeEach(() => { localStorage.clear(); });

  it("stays as a FAILED copy with the newer version's stamp — never already-saved, never dropped", async () => {
    addToOfflineQueue({ date: "2026-06-05", status: "confirmed", base_updated_at: "2026-06-05T20:00:00" });
    const post = vi.fn().mockRejectedValue(draftChanged("2026-06-05T21:00:00.123456"));
    const res = await syncOfflineQueue(post);
    expect(res.synced).toBe(0);
    expect(res.remaining).toHaveLength(1);
    const it0 = res.remaining[0];
    expect(it0.state).toBe(QUEUE_FAILED);
    expect(it0.errorCode).toBe(QUEUE_ERR_DRAFT_CHANGED);
    expect(it0.conflictStamp).toBe("2026-06-05T21:00:00.123456");
    expect(it0.payload.base_updated_at).toBe("2026-06-05T20:00:00");
    expect(getOfflineQueue()).toHaveLength(1);
    expect(queueSummary(getOfflineQueue())).toMatchObject({ failed: 1, alreadySaved: 0 });
  });

  it("a 409 carrying draft_changed is not the locked-row 409", async () => {
    addToOfflineQueue({ date: "2026-06-05", status: "draft" });
    const res = await syncOfflineQueue(vi.fn().mockRejectedValue(draftChanged409("2026-06-05T21:00:00")));
    expect(res.remaining[0].state).toBe(QUEUE_FAILED);
    expect(res.remaining[0].errorCode).toBe(QUEUE_ERR_DRAFT_CHANGED);
    expect(res.alreadySaved).toBe(0);
  });

  it("isDraftChanged / draftChangedStamp read the server's detail", () => {
    expect(isDraftChanged(draftChanged("x"))).toBe(true);
    expect(draftChangedStamp(draftChanged("2026-06-05T21:00:00"))).toBe("2026-06-05T21:00:00");
    expect(isDraftChanged(httpError(409, "This daily close is locked."))).toBe(false);
    expect(isDraftChanged(networkError())).toBe(false);
  });

  it("addFailedToOfflineQueue keeps a copy straight away as failed (the form was gone when it was refused)", () => {
    const item = addFailedToOfflineQueue({ date: "2026-06-05", status: "draft", notes: "x" },
      { errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: "2026-06-05T21:00:00" });
    expect(item.state).toBe(QUEUE_FAILED);
    const q = getOfflineQueue();
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: "2026-06-05T21:00:00" });
  });

  it("a later sync tries it again and keeps it failed while the draft is still newer", async () => {
    addFailedToOfflineQueue({ date: "2026-06-05", status: "draft" }, { errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: "a" });
    const post = vi.fn().mockRejectedValue(draftChanged("b"));
    const res = await syncOfflineQueue(post);
    expect(post).toHaveBeenCalledTimes(1);
    expect(res.remaining[0]).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: "b" });
  });
});
