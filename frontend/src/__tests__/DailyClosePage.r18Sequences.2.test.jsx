/**
 * Round 18, step 0 — the page-level sequence test, seeds 61–120 (of 300).
 * The harness and its invariants (I1–I6, and round 19's M4, M4b, M6, MV):
 * src/test/closeSequenceHarness.jsx.
 * Split over five files so they run side by side. Replay one seed:
 *   SEQ_FROM=<seed> SEQ_COUNT=1 npx vitest run src/__tests__/DailyClosePage.r18Sequences.2.test.jsx
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
const FROM = Number(env.SEQ_FROM || 61);
const COUNT = Number(env.SEQ_COUNT || 60);

describe("daily close — seeded owner sequences (2/5)", () => {
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
    // The page's own timers (the 60 ms scroll to the date after a draft
    // opens, the 3 s "Gemt" after a save) run out before the test
    // environment goes.
    await new Promise((r) => setTimeout(r, 3200));
  }, 10000);
  for (let seed = FROM; seed < FROM + COUNT; seed++) {
    it(`seed ${seed}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      await runSequence(seed, { DailyClosePage }, { get, post, del });
    }, 30000);
  }
});
