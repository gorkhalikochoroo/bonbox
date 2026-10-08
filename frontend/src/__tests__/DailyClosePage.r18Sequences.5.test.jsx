/**
 * Round 18, step 0 — the page-level sequence test, seeds 241–300 (of 300).
 * The harness and its four invariants: src/test/closeSequenceHarness.jsx.
 * Split over five files so they run side by side. Replay one seed:
 *   SEQ_FROM=<seed> SEQ_COUNT=1 npx vitest run src/__tests__/DailyClosePage.r18Sequences.5.test.jsx
 */
import { afterAll, beforeAll, describe, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
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
const FROM = Number(env.SEQ_FROM || 241);
const COUNT = Number(env.SEQ_COUNT || 60);

describe("daily close — seeded owner sequences (5/5)", () => {
  beforeAll(() => {
    window.scrollTo = () => {};
    Element.prototype.scrollIntoView = () => {};
    window.confirm = () => true;
    window.URL.createObjectURL = () => "blob:http://localhost/preview";
    window.URL.revokeObjectURL = () => {};
  });
  afterAll(() => {
    // eslint-disable-next-line no-console
    if (env.SEQ_STATS) console.log("sequence checks", JSON.stringify(STATS));
  });
  for (let seed = FROM; seed < FROM + COUNT; seed++) {
    it(`seed ${seed}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      await runSequence(seed, { DailyClosePage }, { get, post });
    }, 30000);
  }
});
