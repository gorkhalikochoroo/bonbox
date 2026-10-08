/**
 * Round 19 review — the sequence harness in its "review" variant: the
 * openings and timings the reviewers attacked with (src/test/closeSequenceHarness.jsx):
 * "Start forfra" on the day's draft banner first (then a photo, or figures
 * typed), a slow network now and then (a save or a delete still on its way
 * while the owner takes the next step), and two date changes inside the
 * autosave's 2 s. Every invariant (I1–I6, M4, M4b, M6, MV — M6 / MV / M4b
 * also over a draft the page replaced) after every step.
 * Replay one: SEQ_FROM=<seed> SEQ_COUNT=1 npx vitest run src/__tests__/DailyClosePage.r19ReviewSequences.test.jsx
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
const FROM = Number(env.SEQ_FROM || 6001);
const COUNT = Number(env.SEQ_COUNT || 100);
// Seeds of this variant that broke on the round-19 page before the review
// fixes (each named by what broke), pinned by name: also run when a replay
// range is given.
const NAMED = [
  ["MV a move left this page's draft on the old day", [6005, 6036]],
  ["I1 a Start forfra delete raced a newer save (nothing stored)", [6006, 6115]],
  ["M6 a replaced draft kept the thrown-away photo's figures", [6016, 6043]],
  ["MV a replaced draft kept the moved figures", [6019, 6035]],
  ["MV \"Hent\" after a second date change deleted the first day's draft", [6069]],
];

describe("daily close — round 19 review sequences (banner Start forfra, slow network, fast date changes)", () => {
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
        await runSequence(seed, { DailyClosePage }, { get, post, del }, { variant: "review" });
      }, 30000);
    }
  }
  for (let seed = FROM; seed < FROM + COUNT; seed++) {
    it(`seed ${seed}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      await runSequence(seed, { DailyClosePage }, { get, post, del }, { variant: "review" });
    }, 30000);
  }
});
