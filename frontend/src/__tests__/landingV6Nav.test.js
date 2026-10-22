/**
 * LANDING V6 — the stepper, as pure functions (PORT_PLAN 1.4 item 10, port step 4).
 *
 * nav.js holds the v6.3 prototype's stepping logic unchanged (SCN / NAV, the track, curScn, the STQ step
 * queue, goNext / goPrev) plus the port's two iOS Safari guards: stepper taps closer than 250 ms to the
 * previous accepted tap count as one, and jumpCheck() decides when a snap-back to the pre-jump place is undone.
 * A fake page (scroll y, pin, svh) drives it here the way engine.js drives it in the browser; the real-browser
 * sibling is the lab's port-build/tools/engine_check.mjs (stepper / rapid / revert modes).
 */
import { describe, it, expect } from "vitest";
import {
  NSC, SCN, NAV, NAVF, buildTrack, seg, beatU, scnOf, curScn, nextTarget, prevTarget,
  createStepper, goNext, goPrev, jumpCheck, STQ_HOLD, STQ_ARRIVE, TAP_MERGE, JUMP_WATCH,
} from "../components/landing/v6/nav";

// a page laid out like the 390x844 phone the lab measures (pin and svh as the prototype's geo() reports them)
function fakePage({ desk = false, pin = 329, svh = 844, roomIn = 0.2, hh = 56 } = {}) {
  const track = buildTrack(desk), trackH = ((track.TOT + 100) * svh) / 100;
  const page = { y: 0, desk, pin, svh, roomIn, track };
  const geo = () => ({ pin, svh, desk, track, roomIn });
  page.beatY = (id, f) => { const u = beatU(track, id, f); return u == null ? 0 : pin + (u * svh) / 100; };
  page.endY = () => pin + trackH - svh - hh;
  page.cur = () => curScn(page.y, geo());
  page.ctx = { cur: page.cur, beatY: page.beatY, endY: page.endY };
  page.st = createStepper();
  // what engine.js does on a tap: the gate, the jump, the queue; the page arrives at once unless told otherwise
  page.tap = (dir, now, { arrive = true } = {}) => {
    if (!page.st.tap(now)) return null;
    const j = dir === "next" ? goNext(page.st, now, page.ctx) : goPrev(page.st, now, page.ctx);
    if (!j) return null;
    page.st.to(j.k, j.y, now);
    if (arrive) { page.y = j.y; page.st.scrolled(page.y); }
    return j;
  };
  return page;
}

describe("nav.js — the scenes and the track", () => {
  it("seven counted scenes; every NAV resting point is a counted scene, in order 1 → 7", () => {
    expect(NSC).toBe(7);
    expect(NAV.map(([id]) => SCN[id])).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(NAVF).toEqual({ "1a": 0.5, "2a": 0.45, "1b": 0.5, S: 0.74, "2b": 0.6, "3a": 0.5, "3b": 0.62 });
    expect(Object.isFrozen(SCN) && Object.isFrozen(NAV) && Object.isFrozen(NAV[0])).toBe(true);
  });

  it("the track: phone 534 svh of beats, desktop + the 30 svh hero beat; A is where night rises", () => {
    const ph = buildTrack(false), dk = buildTrack(true);
    expect(ph.TOT).toBe(534);
    expect(dk.TOT).toBe(564);
    expect(ph.SEG[0]).toEqual(["1a", 36]);
    expect(dk.SEG[0]).toEqual(["h", 30]);
    expect(ph.SEG[ph.AI][0]).toBe("A");
    expect(dk.AI).toBe(ph.AI + 1);
    expect(ph.ACC[ph.SEG.length - 1]).toBe(434); // 'end' starts 100 svh before the sum
  });

  it("seg() and beatU() are inverse at every resting point; before the track it is the first beat at 0", () => {
    for (const desk of [false, true]) {
      const tr = buildTrack(desk);
      for (const [id, f] of NAV) {
        const s = seg(tr, beatU(tr, id, f));
        expect(s[0]).toBe(id);
        expect(s[1]).toBeCloseTo(f, 10);
      }
      expect(seg(tr, -5)).toEqual([tr.SEG[0][0], 0, 0]);
      expect(seg(tr, 1e6)[0]).toBe("end");
      expect(beatU(tr, "nope", 0.5)).toBeNull();
    }
    expect(beatU(buildTrack(false), "h", 0.5)).toBeNull(); // no hero beat on a phone
  });

  it("the A passage counts as 3 / 7 until the room hands over (roomIn), then 4 / 7", () => {
    expect(scnOf("A", 0.1, 0.2)).toBe(3);
    expect(scnOf("A", 0.2, 0.2)).toBe(4);
    expect(scnOf("end", 0.9, 0.2)).toBe(7);
    expect(scnOf("h", 0, 0.2)).toBe(1);
  });

  it("curScn: before the stage pins a phone is on 1, desktop on the hero (0); on the stage, the counter's number", () => {
    const ph = fakePage(), dk = fakePage({ desk: true, pin: 0, svh: 900 });
    ph.y = 0; expect(ph.cur()).toBe(1);
    ph.y = ph.pin - 5; expect(ph.cur()).toBe(1);
    dk.y = 0; expect(dk.cur()).toBe(0); // the hero beat h
    for (const [id, f] of NAV) {
      ph.y = ph.beatY(id, f); expect(ph.cur()).toBe(SCN[id]);
      dk.y = dk.beatY(id, f); expect(dk.cur()).toBe(SCN[id]);
    }
  });

  it("nextTarget / prevTarget: 0 → 1 … 7 → the page after the day; Forrige 7 → 1 and nothing before 1", () => {
    for (let c = 0; c <= 6; c++) expect(nextTarget(c)).toMatchObject({ k: c + 1, id: NAV[c][0], f: NAV[c][1] });
    expect(nextTarget(7)).toEqual({ k: NSC + 1, id: null, f: null });
    for (let c = 2; c <= 8; c++) expect(prevTarget(c)).toMatchObject({ k: c - 1, id: NAV[c - 2][0] });
    expect(prevTarget(1)).toBeNull();
    expect(prevTarget(0)).toBeNull();
  });
});

describe("nav.js — stepping a page 1 → 7 → 1", () => {
  it("phone: Næste from 1 / 7 walks 2 … 7, then the page after the day; Forrige walks back to 1 and stops", () => {
    const p = fakePage();
    p.y = p.beatY("1a", 0.5);
    let t = 0;
    const seen = [];
    for (let n = 0; n < 7; n++) { t += 700; const j = p.tap("next", t); seen.push(j.k); }
    expect(seen).toEqual([2, 3, 4, 5, 6, 7, 8]);
    expect(p.y).toBeCloseTo(p.endY(), 6);
    const back = [];
    for (let n = 0; n < 8; n++) { t += 700; const j = p.tap("prev", t); back.push(j ? j.k : null); }
    // from the page after the day (the counter reads 7 there) back to 1; then Forrige has nowhere to go
    expect(back).toEqual([6, 5, 4, 3, 2, 1, null, null]);
    expect(p.y).toBeCloseTo(p.beatY("1a", 0.5), 6);
  });

  it("each step lands on its scene's resting point (the place the counter shows that scene)", () => {
    const p = fakePage();
    p.y = p.beatY("1a", 0.5);
    let t = 0;
    for (const [id, f] of NAV.slice(1)) { t += 700; p.tap("next", t); expect(p.y).toBeCloseTo(p.beatY(id, f), 6); expect(p.cur()).toBe(SCN[id]); }
  });

  it("desktop: from the hero, Næste goes to 1 / 7 (the week plan)", () => {
    const p = fakePage({ desk: true, pin: 0, svh: 900 });
    p.y = 0;
    expect(p.tap("next", 1000).k).toBe(1);
    expect(p.cur()).toBe(1);
  });
});

describe("nav.js — the v6.3 step queue (STQ)", () => {
  it("taps while the page has not arrived step on from the last jump's scene, not from a scene in between", () => {
    const p = fakePage();
    p.y = p.beatY("1a", 0.5);
    // three taps 300 ms apart (each one counts) while the page is still on its way: 2, 3, 4 — never 2, 2, 2
    expect([0, 300, 600].map((t) => p.tap("next", 10000 + t, { arrive: false }).k)).toEqual([2, 3, 4]);
    expect(p.cur()).toBe(1); // the page itself never moved in this fake
  });

  it("the queue answers for 600 ms after a jump; after that an arrived page steps from where it is", () => {
    const p = fakePage();
    p.y = p.beatY("1a", 0.5);
    p.tap("next", 1000); // → 2, arrived
    p.y = p.beatY("1b", 0.5); // the page is now on 3 / 7 (the scroll listener has not run yet)
    expect(p.st.from(1000 + STQ_HOLD - 1, p.cur)).toBe(2);
    expect(p.st.from(1000 + STQ_HOLD + 1, p.cur)).toBe(3);
  });

  it("once arrived, a scroll by hand drops the queue at once: the next tap steps from where the reader is", () => {
    const p = fakePage();
    p.y = p.beatY("1a", 0.5);
    p.tap("next", 1000);
    p.y = p.beatY("1b", 0.5);
    p.st.scrolled(p.y);
    expect(p.st.queue).toBeNull();
    expect(p.tap("next", 1300).k).toBe(4);
  });

  it("a jump that never arrives is trusted for at most 1.5 s", () => {
    const st = createStepper();
    st.to(5, 4000, 0);
    expect(st.from(STQ_ARRIVE - 1, () => 2)).toBe(5);
    expect(st.from(STQ_ARRIVE + 1, () => 2)).toBe(2);
    expect([STQ_HOLD, STQ_ARRIVE]).toEqual([600, 1500]);
  });

  it("scrolled(): within 2 px counts as arrived; once arrived, 2 px away drops the queue", () => {
    const st = createStepper();
    st.to(3, 1000, 0);
    st.scrolled(1500); expect(st.queue.hit).toBe(false); // still on its way
    st.scrolled(1001.5); expect(st.queue.hit).toBe(true);
    st.scrolled(1001); expect(st.queue).not.toBeNull();
    st.scrolled(1002); expect(st.queue).toBeNull();
  });
});

describe("nav.js — iOS: taps closer than 250 ms count as one", () => {
  it("the gate: 0 counts, 100 and 240 do not, 250 does (measured from the last tap that counted)", () => {
    const st = createStepper();
    expect(TAP_MERGE).toBe(250);
    expect([0, 100, 240, 250, 400, 499, 500].map((t) => st.tap(5000 + t))).toEqual([true, false, false, true, false, false, true]);
  });

  it("a machine-speed double tap (40–80 ms, the Simulator's case) is one step; taps 300 ms apart are three", () => {
    const p = fakePage();
    p.y = p.beatY("1a", 0.5);
    [0, 60, 120].forEach((t) => p.tap("next", 1000 + t));
    expect(p.cur()).toBe(2);
    [700, 1000, 1300].forEach((t) => p.tap("next", 1000 + t));
    expect(p.cur()).toBe(5);
  });

  it("taps every 200 ms still step, every other one (the gate counts from the accepted tap, so steady tapping is never frozen)", () => {
    const p = fakePage();
    p.y = p.beatY("1a", 0.5);
    [0, 200, 400, 600, 800].forEach((t) => p.tap("next", 1000 + t));
    expect(p.cur()).toBe(4); // 0, 400, 800 counted
  });

  it("Forrige shares the gate with Næste", () => {
    const p = fakePage();
    p.y = p.beatY("2b", 0.6);
    p.tap("prev", 1000);
    expect(p.tap("next", 1100)).toBeNull();
    expect(p.cur()).toBe(4);
  });
});

describe("nav.js — iOS: a snap-back after a jump is undone once (jumpCheck)", () => {
  const j = { y0: 800, y: 1150, at: 1000 };
  it("back at the pre-jump place, no finger down, within 400 ms → reassert", () => {
    expect(JUMP_WATCH).toBe(400);
    expect(jumpCheck(j, 800, 1150, false)).toBe("reassert");
    expect(jumpCheck(j, 801.5, 1150, false)).toBe("reassert");
  });
  it("while a finger is down it waits (the touch end checks again)", () => {
    expect(jumpCheck(j, 800, 1150, true)).toBe("wait");
  });
  it("at the target, or somewhere else (a scroll by hand), nothing to undo", () => {
    expect(jumpCheck(j, 1150, 1100, false)).toBe("wait");
    expect(jumpCheck(j, 803, 1100, false)).toBe("wait");
    expect(jumpCheck(j, 1400, 1100, false)).toBe("wait");
  });
  it("after the watch, or without a jump, nothing", () => {
    expect(jumpCheck(j, 800, 1000 + JUMP_WATCH + 1, false)).toBe("expired");
    expect(jumpCheck(null, 800, 1100, false)).toBe("none");
  });
});
