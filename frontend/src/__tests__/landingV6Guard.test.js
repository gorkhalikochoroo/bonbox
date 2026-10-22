/**
 * LANDING V6 — the stage's last-line guard (PORT_PLAN 1.4 item 10, port step 4).
 *
 * guard.js is the v6.2 guard's maths: no screen closer than 20 px to the clock's bottom or 24 px to the
 * statement it shows with. The numbers below are RECORDED, not made up: the Claude-viewer case that caused
 * the 10.00 bug (Manoj's phone, 21 Oct), reproduced in Chromium on 22 Oct by the lab's
 * port-build/tools/engine_check.mjs grow mode — the page inside a 440 px wide frame that grows from 680 to
 * 810 px tall after load, read exactly as engine.js guard() reads the phone stage (offsetTop / offsetHeight
 * / style.scale of each screen, the clock's bottom, the three statements' tops). Output: port-build/step4/grow.json,
 * identical for the prototype's own script and the port's engine.
 *   first   the layout at 680 (clock 56 px)
 *   stale   the first frame after the growth, before the re-layout (clock now 83.43 px): the bug's geometry
 *   relaid  after the v6.2 re-layout
 */
import { describe, it, expect } from "vitest";
import { clearanceMisses, repairMiss, figureBox, CLOCK_AIR, COPY_AIR, NOFIX } from "../components/landing/v6/guard";

// [id, statement index, offsetTop, offsetHeight]; scale 1 everywhere (no screen was scaled at these sizes)
const REC = {
  first: { ih: 680, clockPx: 56, clockBottom: 137, copyTops: [465, 444, 444],
    figs: [["roster", 0, 190, 223], ["vagt", 0, 173, 257], ["booking", 1, 162, 257], ["room", 1, 162, 249], ["tal", 1, 164, 96], ["stand", 1, 270, 147], ["foto", 2, 162, 257], ["kasse", 2, 162, 258]] },
  stale: { ih: 810, clockPx: 83.43, clockBottom: 157, copyTops: [486, 464, 464],
    figs: [["roster", 0, 190, 322], ["vagt", 0, 173, 257], ["booking", 1, 162, 257], ["room", 1, 162, 249], ["tal", 1, 164, 96], ["stand", 1, 270, 147], ["foto", 2, 162, 257], ["kasse", 2, 162, 258]] },
  relaid: { ih: 810, clockPx: 83.43, clockBottom: 157, copyTops: [596, 574, 574],
    figs: [["roster", 0, 215, 322], ["vagt", 0, 192, 368], ["booking", 1, 208, 315], ["room", 1, 195, 333], ["tal", 1, 181, 107], ["stand", 1, 302, 247], ["foto", 2, 182, 367], ["kasse", 2, 181, 369]] },
};
const input = (r) => ({ clockBottom: r.clockBottom, copyTops: r.copyTops, figs: r.figs.map(([id, copy, offsetTop, h]) => ({ id, copy, offsetTop, h, scale: 1, cap: 0 })) });
const gaps = (r) => input(r).figs.map((f) => {
  const b = figureBox(f);
  return { id: f.id, clock: b.top - r.clockBottom, copy: r.copyTops[f.copy] - b.bottom };
});

describe("guard.js — the Claude-viewer case, 440 wide, frame 680 → 810 (recorded)", () => {
  it("the first layout (680) keeps every screen ≥ 20 below the clock and ≥ 24 above its statement", () => {
    expect(clearanceMisses(input(REC.first))).toEqual([]);
  });

  it("the stale geometry right after the growth is caught: the clock grew into four screens' air, the roster ran into its statement", () => {
    const bad = clearanceMisses(input(REC.stale));
    expect(bad.map((x) => x.id)).toEqual(["roster", "vagt", "booking", "room", "tal", "foto", "kasse"]);
    const roster = bad.find((x) => x.id === "roster");
    expect(roster).toEqual({ id: "roster", box: "", top: 190, bottom: 512, clock: 157, copy: 486, h: 322, cap: 0 }); // 26 px into the statement
    expect(bad.find((x) => x.id === "booking").top - 157).toBe(5); // 5 px under the clock
  });

  it("after the re-layout (810) every screen keeps clock → screen ≥ 20 and screen → statement ≥ 24", () => {
    expect(clearanceMisses(input(REC.relaid))).toEqual([]);
    for (const g of gaps(REC.relaid)) {
      expect(g.clock, g.id).toBeGreaterThanOrEqual(CLOCK_AIR);
      expect(g.copy, g.id).toBeGreaterThanOrEqual(COPY_AIR);
    }
    // the tightest ones sit exactly on the minimums (the bands give the slack to the screens, never below the minimum)
    expect(Math.min(...gaps(REC.relaid).map((g) => g.clock))).toBe(24);
    expect(Math.min(...gaps(REC.relaid).map((g) => g.copy))).toBe(24);
  });

  it("had the re-layout not run, the second pass would have moved or scaled every fixable screen into its band", () => {
    const r = REC.stale, bad = clearanceMisses(input(r));
    for (const x of bad) {
      if (NOFIX.includes(x.id)) continue;
      const fix = repairMiss(x, 1), k = fix.scale ?? 1;
      const b = figureBox({ offsetTop: fix.top, h: x.h, scale: k, cap: x.cap });
      // inside clock + 20 … statement − 24, give or take the 1 px the prototype rounds to
      expect(b.top - x.clock, x.id).toBeGreaterThanOrEqual(CLOCK_AIR - 1);
      expect(x.copy - b.bottom, x.id).toBeGreaterThanOrEqual(COPY_AIR - 1);
    }
    // the roster (322 tall) no longer fits the 285 px band: scaled to it, about its centre
    const roster = repairMiss(bad.find((x) => x.id === "roster"), 1);
    expect(roster.scale).toBe(0.885);
    // the booking card (257) fits the 282 px band (statement 464): moved down to its top
    expect(repairMiss(bad.find((x) => x.id === "booking"), 1)).toEqual({ top: 177, scale: null });
  });
});

describe("guard.js — the rule itself", () => {
  const one = (top, h, extra = {}) => clearanceMisses({ clockBottom: 100, copyTops: [500, 500, 500], figs: [{ id: "x", copy: 0, offsetTop: top, h, scale: 1, cap: 0, ...extra }] });
  it("20 above and 24 below pass; 19.5 or 23.5 is a miss", () => {
    expect(one(120, 356)).toEqual([]);
    expect(one(119.5, 356).length).toBe(1);
    expect(one(120, 356.5).length).toBe(1);
  });
  it("a scaled screen counts with its visual box (scaled about its centre)", () => {
    // 400 tall at .5 → visual 200, centred: top 100 + 100 = 200, bottom 400
    expect(one(100, 400, { scale: 0.5 })).toEqual([]);
    expect(figureBox({ offsetTop: 100, h: 400, scale: 0.5 })).toEqual({ top: 200, bottom: 400 });
  });
  it("the plate's caption belongs to it (cap) and the plate answers to the highest statement (copy -1)", () => {
    const r = clearanceMisses({ clockBottom: 100, copyTops: [520, 480, 500], figs: [{ id: "plate", copy: -1, offsetTop: 130, h: 300, scale: 1, cap: 30 }] });
    expect(r).toEqual([{ id: "plate", box: "", top: 130, bottom: 460, clock: 100, copy: 480, h: 300, cap: 30 }]);
  });
  it("the Z-bon's own transform (origin top left) gives its box at 3a and 3b", () => {
    const zb = { id: "zb", copy: 2, offsetTop: 150, h: 200, scale: 1, cap: 0 };
    expect(figureBox({ ...zb, zb: { k: 1.5, dy: 20 } })).toEqual({ top: 170, bottom: 470 });
    expect(clearanceMisses({ clockBottom: 100, copyTops: [0, 0, 480], figs: [{ ...zb, box: "3a", zb: { k: 1.5, dy: 20 } }] })[0]).toMatchObject({ box: "3a", top: 170, bottom: 470 });
  });
  it("never scales under half; the 22.50 tile + plan and the Z-bon are logged only", () => {
    const x = { id: "foto", top: 130, bottom: 900, clock: 100, copy: 400, h: 770, cap: 0 };
    expect(repairMiss(x, 1).scale).toBe(0.5);
    expect([...NOFIX]).toEqual(["tal", "stand", "zb"]);
  });
});
