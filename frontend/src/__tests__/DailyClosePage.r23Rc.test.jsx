/**
 * Round 23 R-c — the re-rate's verified items, on the page:
 *  2. Phone, scan card: "Ikke fordelt på kategori" never shows a stale
 *     amount while focus is in the total box (or the payment boxes below
 *     it) — the lines on screen always add up. It follows the total, and a
 *     line that would vanish while focus is on the card keeps its place (the
 *     box being typed in never moves).
 *  3. One "Behold mine tal" per day: the conflict card's and the queued
 *     copy's do the same thing — store exactly what is on screen (the form's
 *     figures), and both questions for the day are answered. A queued copy of
 *     a day the form does not show says what it holds, and its "Behold mine
 *     tal" stores exactly that. A newer draft of the day landed since the
 *     question: the card names it, and "Hent den nyeste kladde" opens it.
 * (Item 1 — "Hent {dag}s salg" lets go of the old day — is the sequence
 * harness's named plans 23020–23022 in DailyClosePage.r23Sequences.)
 * Strings are asserted by key (t echoes key + values).
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => () => Promise.resolve(true) }));
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const { NO_ROW_BASE, createServer, installApi } = await import("../test/closeSequenceHarness");
const { addFailedToOfflineQueue, addToOfflineQueue, getOfflineQueue, QUEUE_ERR_DRAFT_CHANGED } = await import("../utils/dailyCloseQueue");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const shiftIso = (iso, days) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const yesterday = shiftIso(today, -1);
const KEY = `${today}|`;

let S;
beforeEach(() => {
  window.scrollTo = () => {};
  window.scrollBy = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  del.mockReset();
});
const serve = (rows = []) => {
  S = createServer({ rows });
  installApi(S, get, post, del);
};

const q = (sel) => document.querySelector(sel);
const btns = (re) => [...document.querySelectorAll("button")].filter((b) => re.test(b.textContent.trim()));
const tap = (re) => {
  const b = btns(re)[0];
  if (!b) throw new Error(`no button ${re}`);
  fireEvent.click(b);
};
const text = () => document.body.textContent;
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const settleMany = async (n = 8) => { for (let i = 0; i < n; i++) await settle(); };
const fire = (name) => act(async () => { window.dispatchEvent(new Event(name)); await new Promise((r) => setTimeout(r, 0)); });
/** A browser: each key goes onto what the box shows NOW. */
const typeOn = (el, chars) => { for (const ch of chars) fireEvent.change(el, { target: { value: el.value + ch } }); };
const keyIn = (el, value) => {
  if (el.value !== "") fireEvent.change(el, { target: { value: "" } });
  typeOn(el, value);
};
const mount = async (want) => {
  const view = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
  for (let i = 0; i < 12 && !text().includes(want); i++) await settle();
  return view;
};
const rowFor = (day = today) => S.rows.get(`${day}|`);

/* ─── 2. the scan card's "Ikke fordelt" line ─────────────────────────── */

describe("R-c 2 — \"Ikke fordelt på kategori\" is never stale while a box below it has focus", () => {
  const BON = {
    raw_text: "BON", ocr_available: true,
    revenue: { food: 12000, drinks: 1500 }, revenue_total: 22000, moms_total: 4400, payments: { card: 22000 },
  };
  const shoot = async (container) => {
    S.nextScan = BON;
    const input = [...container.querySelectorAll('input[type="file"]')].at(-1);
    fireEvent.change(input, { target: { files: [new File(["b"], "b.jpg", { type: "image/jpeg", lastModified: 1 })] } });
    await waitFor(() => expect(screen.queryByText("readingZReport")).toBeNull());
    await waitFor(() => expect(q("#scan-total")).not.toBeNull());
  };
  const unsplit = () => [...document.querySelectorAll("span")]
    .find((el) => el.textContent === "dcUnsplitRevenue" || el.textContent === "dcCorrectedDown")?.parentElement?.textContent || "";
  /** Focus moving straight on from one box to the next (Tab): blur with the next box as relatedTarget, then its focus. */
  const tabTo = (from, to) => {
    fireEvent.blur(from, { relatedTarget: to });
    fireEvent.focus(to, { relatedTarget: from });
  };

  it("the re-rate's repro: Takeaway 3000 typed, Tab to the total — 5.500 (never the 6.500 from before the typing), also on to a payment box; right after leaving", async () => {
    serve();
    const { container } = await mount("scanZReportTitle");
    await shoot(container);
    expect(unsplit()).toContain("8.500");
    const takeaway = q("#scan-rev-takeaway");
    fireEvent.focus(takeaway);
    typeOn(takeaway, "2000");
    expect(unsplit()).toContain("6.500");
    // Over it: 3000.
    fireEvent.change(takeaway, { target: { value: "" } });
    typeOn(takeaway, "3000");
    expect(unsplit()).toContain("5.500");
    const total = q("#scan-total");
    tabTo(takeaway, total);
    expect(unsplit()).toContain("5.500");
    expect(unsplit()).not.toContain("6.500");
    expect(unsplit()).not.toContain("8.500");
    const cash = q("#scan-pay-cash") || q('[id^="scan-pay-"]');
    if (cash) {
      tabTo(total, cash);
      expect(unsplit()).toContain("5.500");
      fireEvent.blur(cash);
    } else fireEvent.blur(total);
    expect(unsplit()).toContain("5.500");
  });

  it("typing in the total box: the line follows the total (12.000 + 1.500 + 3.000 + line = the total on every key), and a line that would vanish keeps its place", async () => {
    serve();
    const { container } = await mount("scanZReportTitle");
    await shoot(container);
    const takeaway = q("#scan-rev-takeaway");
    fireEvent.focus(takeaway);
    typeOn(takeaway, "3000");
    const total = q("#scan-total");
    tabTo(takeaway, total);
    fireEvent.change(total, { target: { value: "" } });
    typeOn(total, "25000");
    expect(unsplit()).toContain("8.500");
    // The total typed down to exactly the categories: nothing is unsplit —
    // no stale figure, and the line's place is kept (the box does not move).
    fireEvent.change(total, { target: { value: "" } });
    typeOn(total, "16500");
    expect(unsplit()).toBe("");
    expect(q('[data-testid="dc-unsplit-slot"]')).not.toBeNull();
    // Left: the card settles (no empty slot).
    fireEvent.blur(total);
    expect(unsplit()).toBe("");
    expect(q('[data-testid="dc-unsplit-slot"]')).toBeNull();
  });
});

/* ─── 3. one "Behold mine tal" per day ────────────────────────────────── */

describe("R-c 3 — the conflict card's and the queued copy's \"Behold mine tal\" for the same day do the same thing", () => {
  // The other phone's draft of today; another visit's copy of today on this
  // phone, refused when it was sent (the other phone had saved since).
  const otherDraft = () => ({
    id: "d1", date: today, branch_id: null, status: "draft",
    revenue_total: 3099, revenue_breakdown: { food: 3099 }, payment_breakdown: { card: 3099 },
    moms_mode: "auto", moms_total: 619.8, source_meta: { kind: "typed" }, closed_by: null, notes: "B",
  });
  const queueCopy = (date = today) => addFailedToOfflineQueue({
    date, branch_id: null, status: "draft",
    revenue_breakdown: { food: 5000 }, payment_breakdown: { cash: 5000 }, revenue_total_override: null,
    base_updated_at: NO_ROW_BASE,
  }, { errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: "2026-01-01T00:00:00.000000" });
  const copiesOf = (date = today) => getOfflineQueue().filter((it) => it.payload?.date === date);
  const keepButtons = () => btns(/^dcDraftChangedKeep$/);

  /** Continue the other phone's draft; it saves again; the owner's next figure is refused — the form's card asks. */
  const twoQuestions = async () => {
    serve([otherDraft()]);
    queueCopy();
    await mount("dcDayHasDraft");
    expect(text()).toContain("dcQueueErrDraftChanged");
    tap(/^dcContinueDraft$/);
    await waitFor(() => expect(q("#dc-rev-food")?.value || "").toMatch(/3[.]?099/));
    S.otherSave(KEY, (r) => { r.revenue_breakdown = { food: 3198 }; r.revenue_total = 3198; r.payment_breakdown = { card: 3198 }; r.notes = "B2"; });
    keyIn(q("#dc-rev-food"), "3500");
    await fire("pagehide");
    await settleMany(10);
    await fire("pageshow");
    await waitFor(() => expect(q('[data-testid="dc-draft-changed"]')).not.toBeNull());
    expect(rowFor()).toMatchObject({ revenue_total: 3198, notes: "B2" });
    // Two answers for the same day on screen — one wording.
    expect(keepButtons()).toHaveLength(2);
    expect(q('[data-testid="dc-queue-keep-mine"]').textContent.trim()).toBe("dcDraftChangedKeep");
  };
  /** What is on screen is what is stored, and both questions for the day are answered. */
  const onScreenStored = async () => {
    await settleMany(10);
    await fire("pagehide");
    await settleMany(10);
    await fire("pageshow");
    await waitFor(() => expect(rowFor().revenue_breakdown).toEqual({ food: 3500 }));
    const row = rowFor();
    expect(row.payment_breakdown).toEqual({ card: 3099 });
    expect(row.notes || "").toBe("B");
    expect(q('[data-testid="dc-draft-changed"]')).toBeNull();
    expect(copiesOf()).toHaveLength(0);
    expect(keepButtons()).toHaveLength(0);
    // Nothing else stored it after: the copy's 5.000 never reached the day.
    expect(S.posts.some((b) => b.date === today && b.payment_breakdown?.cash === 5000)).toBe(false);
  };

  it("the queued copy's button stores what is on screen (the form's figures), never the earlier visit's copy", async () => {
    await twoQuestions();
    fireEvent.click(q('[data-testid="dc-queue-keep-mine"]'));
    await onScreenStored();
  }, 15000);

  it("the conflict card's button: the same — what is on screen is stored, and the copy's question for the day is answered too", async () => {
    await twoQuestions();
    const card = q('[data-testid="dc-draft-changed"]');
    fireEvent.click([...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "dcDraftChangedKeep"));
    await onScreenStored();
  }, 15000);

  it("a newer draft of the day landed since the question (a copy from this phone's queue): the card names it, and \"Hent den nyeste kladde\" opens it — offline too, never the stale version", async () => {
    await twoQuestions();
    expect(q('[data-testid="dc-draft-changed"]').textContent).toContain("3.198");
    // Another visit's copy of today, waiting for the network, lands on the
    // version stored now: History is read again and lists 4.000.
    addToOfflineQueue({
      date: today, branch_id: null, status: "draft",
      revenue_breakdown: { food: 4000 }, payment_breakdown: { card: 4000 }, base_updated_at: rowFor().updated_at,
    });
    await fire("online");
    await settleMany(12);
    await waitFor(() => expect(rowFor().revenue_breakdown).toEqual({ food: 4000 }));
    await waitFor(() => expect(q('[data-testid="dc-draft-changed"]').textContent).toContain("4.000"));
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    try {
      await fire("offline");
      const card = q('[data-testid="dc-draft-changed"]');
      fireEvent.click([...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "dcDraftChangedReload"));
      await settleMany(8);
      await waitFor(() => expect(q("#dc-rev-food")?.value || "").toMatch(/4[.]?000/));
    } finally {
      Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
    }
  }, 15000);

  it("a copy of a day the form does not show says what it holds — and its \"Behold mine tal\" stores exactly that", async () => {
    serve([{ ...otherDraft(), id: "y1", date: yesterday }]);
    queueCopy(yesterday);
    await mount("scanZReportTitle");
    await waitFor(() => expect(text()).toContain("dcQueueErrDraftChanged"));
    expect(text()).toContain("dcQueueCopyHolds:");
    expect(text()).toMatch(/dcQueueCopyHolds:5\.000/);
    // The copy goes on the version it met — changed again since: kept, said.
    S.rows.get(`${yesterday}|`).updated_at = "2026-01-01T00:00:00.000000";
    fireEvent.click(q('[data-testid="dc-queue-keep-mine"]'));
    await settleMany(10);
    await waitFor(() => expect(copiesOf(yesterday)).toHaveLength(0));
    expect(rowFor(yesterday).revenue_breakdown).toEqual({ food: 5000 });
    expect(rowFor(yesterday).payment_breakdown).toEqual({ cash: 5000 });
  }, 15000);
});
