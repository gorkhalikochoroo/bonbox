/**
 * Round 19 — named regressions for the sequence invariants added this round
 * (src/test/closeSequenceHarness.jsx: M4, M4b, M6, MV — held to the STORED
 * row, not the payload). Each seed below broke its invariant on the round-18
 * page (cce8d04e + round 19's first commit) and passes now; they are part of
 * the committed 300 as well, pinned here by name so a reshuffle of those
 * files cannot drop them. The reviewers' own seeds (1175, 1329, 1539, 1254)
 * came from their generator: their exact path is pinned step for step in
 * DailyClosePage.r19StartOver (§3), and the seeds are run here too.
 * Replay one: SEQ_ONLY=<seed> npx vitest run src/__tests__/DailyClosePage.r19Sequences.test.jsx
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

const NAMED = [
  // M4 — a typed day (or a reopened typed draft) stored as a Z-bon read after Start forfra.
  ["M4", [27, 84, 149, 180]],
  // M4b — the thrown-away bon's photo still on the stored row.
  ["M4b", [16, 30, 51, 101, 132]],
  // M6 — Start forfra on a photo-only day kept the photo's draft.
  ["M6", [3, 81, 104, 157, 163]],
  // MV — "Brug dem for {to}" left the old day's draft with the same till.
  ["MV", [13, 17, 21, 32, 58]],
  // I6 — a reopened draft's total emptied before the photo, then Start
  // forfra and two bons summed: the card's empty (red) total turned into the
  // bons' "3.000" under a day that saves 8.234,50 (dailyCloseScanMerge fold).
  ["I6", [1508]],
  // The reviewers' M4 seeds (their generator; see the header).
  ["reviewers' M4", [1175, 1254, 1329, 1539]],
  // Review: M4b on an unseen seed — a reopened Z-bon draft's total emptied,
  // a 1.500 bon "samme terminal" filed, then Fortryd and "brug det ikke":
  // the card stayed (not filed) while the draft kept the dropped bon and
  // its photo. With no photo left the owner's till is the day again, filed.
  ["review M4b", [20235]],
];

describe("daily close — round 19 named sequence regressions", () => {
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
  for (const [inv, seeds] of NAMED) {
    for (const seed of seeds) {
      if (env.SEQ_ONLY && Number(env.SEQ_ONLY) !== seed) continue;
      it(`${inv}: seed ${seed}`, async () => {
        localStorage.clear();
        get.mockReset();
        post.mockReset();
        del.mockReset();
        await runSequence(seed, { DailyClosePage }, { get, post, del });
      }, 30000);
    }
  }
});
