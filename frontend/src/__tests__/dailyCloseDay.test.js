/**
 * "Is today already closed?" — asked against the BUSINESS day.
 *
 * THE BUG: the daily close page asked `new Date().toISOString().slice(0, 10)`,
 * which is wrong twice over — UTC instead of local, and the calendar day
 * instead of the 06:00 business day the close is actually filed against. A bar
 * locking at 03:00 and reloading watched its own close disappear from the top
 * of the page and was invited to close the day a second time.
 */
import { describe, expect, it } from "vitest";

import { businessTodayIso } from "../utils/dateFormat";
import {
  findConfirmedCloseFor,
  findTodaysConfirmedClose,
  DEFAULT_CLOSE_CUTOFF_HOUR,
} from "../utils/dailyCloseDay";

/** A local-time Date, so the test reads in the same frame the helpers work in. */
const at = (y, m, d, h, min = 0) => new Date(y, m - 1, d, h, min, 0, 0);

const history = [
  { id: 3, date: "2026-09-16", status: "confirmed", revenue_total: 17030 },
  { id: 2, date: "2026-09-15", status: "draft", revenue_total: 4210 },
  { id: 1, date: "2026-09-14", status: "confirmed", revenue_total: 9100 },
];

describe("findConfirmedCloseFor", () => {
  it("finds the confirmed close for a business date", () => {
    expect(findConfirmedCloseFor(history, "2026-09-16").id).toBe(3);
  });

  it("ignores a draft — a draft is not a locked kasserapport", () => {
    expect(findConfirmedCloseFor(history, "2026-09-15")).toBeNull();
  });

  it("tolerates a full ISO timestamp on the row", () => {
    expect(findConfirmedCloseFor(
      [{ id: 7, date: "2026-09-16T00:00:00Z", status: "confirmed" }],
      "2026-09-16",
    ).id).toBe(7);
  });

  it("never throws on a missing history or a missing date", () => {
    expect(findConfirmedCloseFor(null, "2026-09-16")).toBeNull();
    expect(findConfirmedCloseFor(history, "")).toBeNull();
    expect(findConfirmedCloseFor([null, undefined], "2026-09-16")).toBeNull();
  });
});

describe("findTodaysConfirmedClose", () => {
  it("still sees the close at 03:00 — the bar's night is not over", () => {
    // The 16th's service, locked at 02:50, reloaded at 03:00.
    expect(findTodaysConfirmedClose(history, DEFAULT_CLOSE_CUTOFF_HOUR, at(2026, 9, 17, 3, 0)).id).toBe(3);
  });

  it("flips to the new day at the cutoff, not at midnight", () => {
    expect(findTodaysConfirmedClose(history, 6, at(2026, 9, 17, 5, 59))?.id).toBe(3);
    expect(findTodaysConfirmedClose(history, 6, at(2026, 9, 17, 6, 0))).toBeNull();
  });

  it("is an ordinary today during service", () => {
    expect(findTodaysConfirmedClose(history, 6, at(2026, 9, 16, 19, 0)).id).toBe(3);
  });

  it("agrees with businessTodayIso — one definition of 'today' on the page", () => {
    const now = at(2026, 9, 17, 1, 14);
    expect(findTodaysConfirmedClose(history, 6, now))
      .toEqual(findConfirmedCloseFor(history, businessTodayIso(6, now)));
  });

  it("defaults to the DK 06:00 cutoff", () => {
    expect(DEFAULT_CLOSE_CUTOFF_HOUR).toBe(6);
    expect(findTodaysConfirmedClose(history, undefined, at(2026, 9, 17, 3, 0)).id).toBe(3);
  });
});
