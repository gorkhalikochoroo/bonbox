import { describe, expect, it } from "vitest";
import { exportPieces, previousQuarter, spanDays } from "../utils/exportPieces";

describe("previousQuarter — the MOMS quarter before today's", () => {
  it("is the calendar quarter, not a rolling 90 days", () => {
    expect(previousQuarter("2026-10-07")).toEqual({ from: "2026-07-01", to: "2026-09-30" });
    expect(previousQuarter("2026-05-20")).toEqual({ from: "2026-01-01", to: "2026-03-31" });
    // Across the new year.
    expect(previousQuarter("2027-02-01")).toEqual({ from: "2026-10-01", to: "2026-12-31" });
  });
});

describe("exportPieces — what the plan allows, as one-tap pieces", () => {
  it("a range inside the window needs no pieces", () => {
    expect(exportPieces("2026-09-01", "2026-09-30", 31)).toEqual({ kind: "fits", pieces: [] });
    expect(spanDays("2026-09-01", "2026-09-30")).toBe(30);
  });

  it("Starter's 31 days: the quarter month by month, whole months marked", () => {
    const { kind, pieces } = exportPieces("2026-07-01", "2026-09-30", 31);
    expect(kind).toBe("months");
    expect(pieces).toEqual([
      { from: "2026-07-01", to: "2026-07-31", wholeMonth: true },
      { from: "2026-08-01", to: "2026-08-31", wholeMonth: true },
      { from: "2026-09-01", to: "2026-09-30", wholeMonth: true },
    ]);
  });

  it("a rolling range is clipped at both ends, and every piece fits the window", () => {
    const { pieces } = exportPieces("2026-07-10", "2026-10-07", 31);
    expect(pieces.map((p) => [p.from, p.to, p.wholeMonth])).toEqual([
      ["2026-07-10", "2026-07-31", false],
      ["2026-08-01", "2026-08-31", true],
      ["2026-09-01", "2026-09-30", true],
      ["2026-10-01", "2026-10-07", false],
    ]);
    expect(pieces.every((p) => spanDays(p.from, p.to) <= 31)).toBe(true);
  });

  it("Free's 7 days: the last 7 days of the range", () => {
    expect(exportPieces("2026-09-01", "2026-09-30", 7)).toEqual({
      kind: "tail", pieces: [{ from: "2026-09-24", to: "2026-09-30", wholeMonth: false }],
    });
  });
});
