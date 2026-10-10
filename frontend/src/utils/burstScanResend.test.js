// R-d round 3: a pile the server stops part-way (every photo-decode slot
// busy) keeps its drafts and says from which photo on nothing was read
// (`busy_from`). The page sends those again on their own and names what is
// still left — a photo is never dropped silently, and the photos already
// read are never sent (and paid for) twice.
import { describe, expect, it, vi } from "vitest";
import { scanPileWithResends } from "./burstScanResend";

const noSleep = () => Promise.resolve();

function server(replies) {
  const sent = [];
  const post = vi.fn(async (photos) => {
    sent.push([...photos]);
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r;
  });
  return { post, sent };
}

describe("scanPileWithResends", () => {
  it("sends a pile once when the server reads all of it", async () => {
    const { post, sent } = server([{ created: 3, cap_reached: false, busy_from: null, busy_remaining: 0 }]);
    const r = await scanPileWithResends(["a", "b", "c"], post, { sleep: noSleep });
    expect(r).toEqual({ added: 3, capHit: false, left: 0 });
    expect(sent).toEqual([["a", "b", "c"]]);
  });

  it("sends only the unread photos again and adds up the drafts", async () => {
    const { post, sent } = server([
      { created: 1, busy_from: 1, busy_remaining: 3 },
      { created: 3, busy_from: null },
    ]);
    const sleep = vi.fn(noSleep);
    const r = await scanPileWithResends(["a", "b", "c", "d"], post, { sleep, pauseMs: 5000 });
    expect(r).toEqual({ added: 4, capHit: false, left: 0 });
    expect(sent).toEqual([["a", "b", "c", "d"], ["b", "c", "d"]]);
    expect(sleep).toHaveBeenCalledWith(5000);
  });

  it("stops after the allowed resends and reports what is still unread", async () => {
    const { post, sent } = server([
      { created: 1, busy_from: 1 },
      { created: 1, busy_from: 1 },
      { created: 0, busy_from: 0 },
    ]);
    const r = await scanPileWithResends(["a", "b", "c", "d"], post, { sleep: noSleep, resends: 2 });
    expect(r).toEqual({ added: 2, capHit: false, left: 2 });
    expect(sent).toEqual([["a", "b", "c", "d"], ["b", "c", "d"], ["c", "d"]]);
  });

  it("keeps what was added when a resend fails, and counts the rest as left", async () => {
    const { post } = server([{ created: 2, busy_from: 2 }, new Error("503")]);
    const r = await scanPileWithResends(["a", "b", "c"], post, { sleep: noSleep });
    expect(r).toEqual({ added: 2, capHit: false, left: 1 });
  });

  it("rethrows a failure of the first request (nothing was added)", async () => {
    const { post } = server([new Error("503")]);
    await expect(scanPileWithResends(["a"], post, { sleep: noSleep })).rejects.toThrow("503");
  });

  it("does not resend into a reached scan cap", async () => {
    const { post, sent } = server([{ created: 2, cap_reached: true, busy_from: null }]);
    const r = await scanPileWithResends(["a", "b", "c"], post, { sleep: noSleep });
    expect(r).toEqual({ added: 2, capHit: true, left: 0 });
    expect(sent.length).toBe(1);
  });

  it("works against an older server that sends no busy_from", async () => {
    const { post } = server([{ created: 2, skipped: 0, cap_reached: false }]);
    const r = await scanPileWithResends(["a", "b"], post, { sleep: noSleep });
    expect(r).toEqual({ added: 2, capHit: false, left: 0 });
  });
});
