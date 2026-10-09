/**
 * Round 20 — the confusing items on the money paths.
 *
 *  5. A drawer counted below its float: the lock says the real cause, with
 *     both figures and the step ("Optællingen (1.200 kr.) er mindre end
 *     byttepengene (1.500 kr.) — ret den under Optælling af kassen") and a
 *     link there; the count and the float are the red fields it points to;
 *     the draft never files a negative count as counted (null, the typed
 *     drawer stays in the box). An unreadable amount keeps its own message.
 *  7. Two tills summed, then a payment box on the wizard typed in: the
 *     summary above the boxes ("Stod kun på den ene bon …" → "Dine egne tal
 *     …") holds while the box has focus — nothing above the caret changes —
 *     and settles once the box is left.
 * Strings are asserted by key (t echoes key + values).
 */
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";

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

const { BONS, createServer, installApi, photoUrl } = await import("../test/closeSequenceHarness");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);

let S;
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.confirm = vi.fn(() => true);
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  del.mockReset();
  S = createServer();
  installApi(S, get, post, del);
});

const q = (sel) => document.querySelector(sel);
const btn = (re) => [...document.querySelectorAll("button")].find((b) => re.test(b.textContent.trim()));
const tap = (re) => {
  const b = btn(re);
  if (!b) throw new Error(`no button ${re}`);
  fireEvent.click(b);
};
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const flush = async () => {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
  for (let i = 0; i < 4; i++) await settle();
};
const keyIn = (el, value) => {
  if (el.value !== "") fireEvent.change(el, { target: { value: "" } });
  for (const ch of value) fireEvent.change(el, { target: { value: el.value + ch } });
};
const mount = async () => {
  const view = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
  for (let i = 0; i < 10 && !document.body.textContent.includes("scanZReportTitle"); i++) await settle();
  return view;
};
const toStepWith = async (sel) => {
  for (let i = 0; i < 8 && !q(sel); i++) {
    const next = btn(/^next\s*→$/);
    if (!next) break;
    fireEvent.click(next);
  }
  await waitFor(() => expect(q(sel)).not.toBeNull());
};
const posted = () => S.posts.filter((b) => b.date === today);

/* ─── 5 ─────────────────────────────────────────────────────────────── */

describe("5. a drawer counted below its float: the real reason, the red fields, no negative count filed", () => {
  const belowFloat = async () => {
    localStorage.setItem("bonbox.dc.cashFloat.v1", "1500");
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "1000");
    await toStepWith("#dc-pay-cash");
    keyIn(q("#dc-pay-cash"), "1000");
    await toStepWith("#cash-counted");
    keyIn(q("#cash-counted"), "1200");
  };

  it("the reviewers' repro: 1.200 counted against a 1.500 float — both boxes red and described, the hint is their reason", async () => {
    await belowFloat();
    const drawer = q("#cash-counted");
    const float = q("#cash-float");
    expect(drawer.getAttribute("aria-invalid")).toBe("true");
    expect(float.getAttribute("aria-invalid")).toBe("true");
    expect(drawer.getAttribute("aria-describedby")).toContain("dc-drawer-below-float");
    expect(float.getAttribute("aria-describedby")).toContain("dc-drawer-below-float");
    expect(q("#dc-drawer-below-float").textContent).toBe("dcDrawerBelowFloat");
    // Fixed: the boxes are fine again.
    keyIn(drawer, "2600");
    expect(q("#cash-counted").getAttribute("aria-invalid")).toBeNull();
    expect(q("#cash-float").getAttribute("aria-invalid")).toBeNull();
    expect(q("#dc-drawer-below-float")).toBeNull();
  });

  it("the lock names the cause with both figures and the step, and its link goes there", async () => {
    await belowFloat();
    await toStepWith("#dc-notes");
    const lock = btn(/confirmAndLock/);
    expect(lock.disabled).toBe(true);
    const text = document.body.textContent;
    expect(text).toContain("dcLockBlockedBelowFloat:1.200 kr.|1.500 kr.");
    expect(text).not.toContain("dcLockBlockedAmountIn");
    expect(text).not.toContain("dcLockBlockedAmount:");
    fireEvent.click(q('[data-testid="dc-go-to-cash"]'));
    await waitFor(() => expect(q("#cash-counted")).not.toBeNull());
    expect(q("#cash-counted").value).toBe("1200");
  });

  it("the draft never files a negative count: cash_counted null (and no float), the typed drawer stays; fixed, the count is filed", async () => {
    await belowFloat();
    await flush();
    const body = posted().at(-1);
    expect(body.cash_counted).toBeNull();
    expect(body.cash_float).toBeNull();
    expect(S.rows.get(`${today}|`).cash_counted).toBeNull();
    // The drawer the owner typed is still in the box.
    expect(q("#cash-counted").value).toBe("1200");
    keyIn(q("#cash-counted"), "2600");
    await flush();
    expect(posted().at(-1)).toMatchObject({ cash_counted: 1100, cash_float: 1500 });
    await toStepWith("#dc-notes");
    expect(btn(/confirmAndLock/).disabled).toBe(false);
  });

  it("an amount that cannot be read keeps its own message (\"kan ikke læses … det røde felt\")", async () => {
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "1000");
    await toStepWith("#cash-counted");
    fireEvent.change(q("#cash-counted"), { target: { value: "12,3,4" } });
    await toStepWith("#dc-notes");
    expect(document.body.textContent).toContain("dcLockBlockedAmountIn:dcCashLabel");
    expect(document.body.textContent).not.toContain("dcLockBlockedBelowFloat");
  });
});

/* ─── 7 ─────────────────────────────────────────────────────────────── */

describe("7. nothing above the box being typed in changes on the wizard after a sum", () => {
  // The perf lane's repro: bon 1 with Kort + Kontant, bon 2 with Kort only,
  // "læg dem sammen", "Fortsæt trin for trin", Næste, then Kontant typed.
  const summedWizard = async () => {
    await mount();
    S.nextScan = { ...BONS.till1, image_url: photoUrl("a.jpg") };
    let input = [...document.querySelectorAll('input[type="file"]')].at(-1);
    fireEvent.change(input, { target: { files: [new File(["a"], "a.jpg", { type: "image/jpeg", lastModified: 1 })] } });
    await waitFor(() => expect(q('[data-testid="dc-scan-result-date"]')).not.toBeNull());
    S.nextScan = { ...BONS.b5000, image_url: photoUrl("b.jpg") };
    input = [...document.querySelectorAll('input[type="file"]')].at(-1);
    fireEvent.change(input, { target: { files: [new File(["b"], "b.jpg", { type: "image/jpeg", lastModified: 1 })] } });
    await waitFor(() => expect(q('[data-testid="dc-terminal-question"]')).not.toBeNull());
    tap(/^scanSecondTotalSum/);
    tap(/^continueStepByStep$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
  };
  /** The "N terminaler lagt sammen" summary above the step's boxes. */
  const summary = () => {
    const head = [...document.querySelectorAll("span")].find((el) => el.textContent.startsWith("scanMergedTerminals"));
    return head?.closest(".mb-3") || null;
  };
  /** Every block (div/p) above the box, with its text: what could move it. */
  const above = (input) => [...document.querySelectorAll("fieldset div, fieldset p")]
    // eslint-disable-next-line no-bitwise
    .filter((el) => !el.contains(input) && (el.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING))
    .map((el) => `${el.tagName}:${el.children.length ? "" : el.textContent}`)
    .join("¦");

  it("Kontant typed after the sum: the notice holds while the box has focus, then settles once on leaving it", async () => {
    await summedWizard();
    await toStepWith("#dc-pay-cash");
    const cash = q("#dc-pay-cash");
    expect(summary().textContent).toContain("scanMergedIncompleteNamed");
    act(() => { cash.focus(); });
    const before = above(cash);
    const notice = summary().textContent;
    const seen = [];
    fireEvent.change(cash, { target: { value: "4.03" } });
    seen.push([above(cash), summary().textContent]);
    fireEvent.change(cash, { target: { value: "" } });
    seen.push([above(cash), summary().textContent]);
    for (const v of ["5", "50", "500"]) {
      fireEvent.change(cash, { target: { value: v } });
      seen.push([above(cash), summary().textContent]);
    }
    // The caret-stability assertion: the blocks above the box, and what they
    // say, are the same on every keystroke.
    seen.forEach(([blocks, text]) => {
      expect(blocks).toBe(before);
      expect(text).toBe(notice);
    });
    // Left: the summary says what is true now, once.
    act(() => { cash.blur(); });
    expect(summary().textContent).toContain("scanMergedIncompleteOwn");
  });

  it("a category typed on step 1 after the sum: \"med dine rettelser\" waits until the box is left", async () => {
    await summedWizard();
    const food = q("#dc-rev-food");
    act(() => { food.focus(); });
    const before = above(food);
    keyIn(food, "20000");
    expect(above(food)).toBe(before);
    expect(summary().textContent).not.toContain("dcMergeNowSaves");
    act(() => { food.blur(); });
    expect(summary().textContent).toContain("dcMergeNowSaves");
  });

  it("a hold never outlives its step: Næste with the box still focused shows the next step live", async () => {
    await summedWizard();
    const food = q("#dc-rev-food");
    act(() => { food.focus(); });
    keyIn(food, "20000");
    // No blur: the step changes under the focused box.
    tap(/^next\s*→$/);
    await waitFor(() => expect(q("#dc-pay-cash")).not.toBeNull());
    expect(summary().textContent).toContain("dcMergeNowSaves");
  });
});
