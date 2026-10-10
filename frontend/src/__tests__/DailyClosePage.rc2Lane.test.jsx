/**
 * R-c round 2 fix-up — the round-2 SEQUENCE LANE, committed: the harness in
 * its "rc2" variant (src/test/closeSequenceHarness.jsx) — r23 biased to moves,
 * offline, lost and late answers, other devices, Start forfra, scans and
 * "Hent salg", plus full reloads and app kills mid-save and mid-move (a fresh
 * JS world per page load: the page's modules loaded again) and account
 * switches on one phone (logout A → login B → login A, in the app). Every
 * step is held to every invariant, and to the lane's own:
 *   X   nothing of account A is ever sent, stored or queued as account B's
 *       (and B's drafts are never deleted for A);
 *   L   the owner's last figures sent before a reload / kill / sign-out are
 *       stored for the day, or kept on this phone (their account's queue);
 *   MB  a confirmed move never leaves the figures on both days;
 *   LD  a locked day is never offered as a draft.
 * By default it runs the seeds the round-2 review named (each failed on
 * e4febb30 — X, L, MB) and two the fix-up's own sweep found in the harness
 * model; SEQ_SEEDS lists others, SEQ_FROM / SEQ_COUNT a range, SEQ_SOFT=
 * L,X,MB,LD records those classes and goes on, SEQ_STATS=1 prints counters.
 * (Seed 60753 — a kill while the "saved somewhere else" question is open —
 * is the review's deferred nit, not in this list.)
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock("../services/api", () => {
  const gen = (globalThis.__seqGen = (globalThis.__seqGen || 0) + 1);
  const w = (fn) => (...a) => { const prev = globalThis.__seqSender; globalThis.__seqSender = gen; try { return fn(...a); } finally { globalThis.__seqSender = prev; } };
  return { default: { get: w((...a) => get(...a)), post: w((...a) => post(...a)), patch: vi.fn(), delete: w((...a) => del(...a)) } };
});
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: globalThis.__seqUser || { id: "acctA", currency: "DKK", business_type: "restaurant" }, refreshUser: vi.fn() }),
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
const NAMED = [60020, 60164, 60409, 60550, 60024, 60060, 60121, 60106, 60448, 60073, 60083, 60147, 61014, 62050,
  60067, 60075, 60163, 60209, 60237, 60095, 61156, 63876, 61840, 62309, 60516, 61037];

describe("daily close — R-c round 2 sequence lane (rc2)", () => {
  beforeAll(() => {
    window.scrollTo = () => {};
    window.scrollBy = () => {};
    Element.prototype.scrollIntoView = () => {};
    window.confirm = () => true;
    window.URL.createObjectURL = () => "blob:http://localhost/preview";
    window.URL.revokeObjectURL = () => {};
  });
  afterAll(async () => {
    if (env.SEQ_STATS) console.log("sequence checks", JSON.stringify(STATS));
    for (const r of globalThis.__seqSoft || []) console.log(`SOFT ${JSON.stringify(r)}`);
    await new Promise((r) => setTimeout(r, 3200));
  }, 10000);
  const SEEDS = env.SEQ_SEEDS ? env.SEQ_SEEDS.split(",").map(Number)
    : env.SEQ_FROM ? Array.from({ length: Number(env.SEQ_COUNT || 20) }, (_, i) => Number(env.SEQ_FROM) + i) : NAMED;
  for (const seed of SEEDS) {
    it(`seed ${seed}`, async () => {
      localStorage.clear();
      get.mockReset();
      post.mockReset();
      del.mockReset();
      await runSequence(seed, { DailyClosePage }, { get, post, del }, { variant: "rc2" });
    }, Number(env.SEQ_TIMEOUT || 60000));
  }
});
