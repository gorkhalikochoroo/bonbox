/**
 * Round 20 — the sequence harness in its "r20" variant (src/test/closeSequenceHarness.jsx):
 * the review variant's openings and timings (banner Start forfra, a slow
 * network, fast date changes) over the round-20 drafts — counted with a float
 * other than this device's, a Z-bon read with its own photo, a reopened sum —
 * plus another device's scan landing behind the page's back, and the owner's
 * note typed on a photo-only day before Start forfra.
 * Every invariant after every step (I1–I6, M4, M4b, M6, MV) and round 20's:
 *   F1  a reopened draft keeps the float it was counted with (step 3 and
 *       every payload);
 *   F3  Start forfra never deletes (or puts back) a draft holding the
 *       owner's own fields — it stays as filed until the next save;
 *   F4  "" clears only a photo this page filed (or the replaced draft's),
 *       never another device's;
 *   F6  a reopened Z-bon read changed by hand is stored as corrected (every
 *       changed line, nothing else), a reopened sum's tills add up.
 * Replay one: SEQ_FROM=<seed> SEQ_COUNT=1 npx vitest run src/__tests__/DailyClosePage.r20Sequences.test.jsx
 */
import { afterAll, beforeAll, describe, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn(), delete: (...a) => del(...a) },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fallbackOrVars, maybeVars) => {
      const vars = typeof fallbackOrVars === "object" ? fallbackOrVars : maybeVars;
      return vars ? `${k}:${Object.values(vars).join("|")}` : k;
    },
    lang: "da",
    setLang: () => {},
    LANGUAGES: [],
  }),
}));
// Round 23 — the page's questions (useConfirm) are answered by the harness
// like the owner (closeSequenceHarness: __dcSeqConfirm).
vi.mock("../hooks/useConfirm", () => ({
  useConfirm: () => (opts) => Promise.resolve(globalThis.__dcSeqConfirm ? globalThis.__dcSeqConfirm(opts) : true),
}));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const { runSequence, STATS } = await import("../test/closeSequenceHarness");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const env = globalThis.process?.env || {};
const FROM = Number(env.SEQ_FROM || 7001);
const COUNT = Number(env.SEQ_COUNT || 150);
// The reviewers' repros, as seeds of this variant that walk them (each named
// by the round-19 break it pins): also run when a replay range is given.
// Each one broke on the round-19 page (89d3ae3c) with this harness.
const NAMED = [
  ["F1 a reopened draft re-saved this device's float (desktop lane, blocking)", [7001, 7007]],
  ["F3 Start forfra deleted the draft holding the owner's note (sequences lane, U5)", [7002, 7041]],
  ["F4 \"\" cleared another device's photo (removal audit U6)", [7018, 7045]],
  ["F6 a hand-edited reopened Z-bon read stayed \"scannet\" (sequences lane)", [7033, 7058]],
  // Round 20 review: broke on 6025d198 — MOMS 600 typed on a reopened read
  // (opened with 3.406) stored as "Salgsmoms aflæst fra Z-bon".
  ["F6 a MOMS typed on a reopened Z-bon read was filed as read off the bon (round 20 review)", [7019]],
];

describe("daily close — round 20 sequences (floats, own photos, a reopened sum, another device)", () => {
  beforeAll(() => {
    window.scrollTo = () => {};
    Element.prototype.scrollIntoView = () => {};
    window.confirm = () => true;
    window.URL.createObjectURL = () => "blob:http://localhost/preview";
    window.URL.revokeObjectURL = () => {};
  });
  afterAll(async () => {
    // eslint-disable-next-line no-console
    if (env.SEQ_STATS) console.log("sequence checks", JSON.stringify(STATS));
    await new Promise((r) => setTimeout(r, 3200));
  }, 10000);
  for (const [what, seeds] of NAMED) {
    for (const seed of seeds) {
      it(`${what}: seed ${seed}`, async () => {
        localStorage.clear();
        get.mockReset();
        post.mockReset();
        del.mockReset();
        await runSequence(seed, { DailyClosePage }, { get, post, del }, { variant: "r20" });
      }, 30000);
    }
  }
  for (let seed = FROM; seed < FROM + COUNT; seed++) {
    it(`seed ${seed}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      await runSequence(seed, { DailyClosePage }, { get, post, del }, { variant: "r20" });
    }, 30000);
  }
});
