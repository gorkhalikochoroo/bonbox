/**
 * Round 23 R-c — the re-rate's verified items, on the page:
 *  2. Phone, scan card: "Ikke fordelt på kategori" never shows a stale
 *     amount while focus is in the total box (or the payment boxes below
 *     it) — the lines on screen always add up. It follows the total, and a
 *     line that would vanish while focus is on the card keeps its place (the
 *     box being typed in never moves).
 *  3. One "Behold mine tal" per day: the conflict card's stores exactly what
 *     is on screen (the form's figures). A refused copy of the same day kept
 *     on this phone (figures typed earlier here, on no server) always says
 *     what it holds, and its button says it stores the copy ("Gem kopien
 *     (5.000 kr.) i stedet") — it is never answered (dropped) by the card's
 *     answer (R-c review). A queued copy of a day the form does not show
 *     says what it holds, and its "Behold mine tal" stores exactly that. A
 *     newer draft of the day landed since the question: the card names it,
 *     and "Hent den nyeste kladde" opens it.
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
  const shoot = async (container, bon = BON) => {
    S.nextScan = bon;
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

  // R-c review — the common case: a bon whose lines add up (no line). A slot
  // reserved on the tap pushed the total box down the moment it was tapped,
  // and the payment box up at the Tab on.
  /** The blocks (div/p) above a box on the card — their count and order. */
  const above = (input) => {
    const card = q('[data-testid="dc-scan-result-date"]').parentElement;
    return [...card.querySelectorAll("div,p")]
      .filter((el) => !el.contains(input) && (el.compareDocumentPosition(input) & Node.DOCUMENT_POSITION_FOLLOWING))
      .map((el) => el.tagName + (el.getAttribute("data-testid") ? `#${el.getAttribute("data-testid")}` : ""))
      .join(",");
  };
  it("lines that add up: the tap on the total mounts nothing above it, nor typing it up, nor the Tab on to a payment box — the line appears, live, once focus leaves", async () => {
    serve();
    const { container } = await mount("scanZReportTitle");
    await shoot(container, { ...BON, revenue: { food: 12000, drinks: 1500 }, revenue_total: 13500, moms_total: 2700, payments: { card: 13500 } });
    expect(unsplit()).toBe("");
    const total = q("#scan-total");
    const before = above(total);
    act(() => { total.focus(); });
    fireEvent.focus(total);
    expect(above(total)).toBe(before);
    expect(q('[data-testid="dc-unsplit-slot"]')).toBeNull();
    fireEvent.change(total, { target: { value: "" } });
    for (const ch of "15000") {
      fireEvent.change(total, { target: { value: total.value + ch } });
      expect(above(total)).toBe(before);
    }
    const pay = q("#scan-pay-cash") || q('[id^="scan-pay-"]');
    expect(pay).not.toBeNull();
    const payBefore = above(pay);
    tabTo(total, pay);
    expect(above(pay)).toBe(payBefore);
    fireEvent.blur(pay);
    // Settled: the total's unsplit part, never a stale figure.
    expect(unsplit()).toContain("1.500");
  });
});

/* ─── 3. one "Behold mine tal" per day ────────────────────────────────── */

describe("R-c 3 — one \"Behold mine tal\" per day; the queued copy of the same day says what it holds and stores exactly that", () => {
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
    // One "Behold mine tal" (the card's); the copy says what it holds, and its
    // button names what it stores (R-c review: two identical buttons did two
    // different things).
    expect(keepButtons()).toHaveLength(1);
    expect(text()).toMatch(/dcQueueCopyHolds:5\.000/);
    expect(q('[data-testid="dc-queue-keep-mine"]').textContent.trim()).toMatch(/^dcQueueKeepCopyInstead:5\.000/);
  };
  /** The copy is still on this phone, says what it holds, and its own button stores exactly that. */
  const copyStoredByItsButton = async () => {
    expect(copiesOf()).toHaveLength(1);
    expect(text()).toMatch(/dcQueueCopyHolds:5\.000/);
    // (On the version it met: saved again since, it meets the newest first —
    // kept, with that version's stamp — and the next tap stores it.)
    for (let i = 0; i < 3 && copiesOf().length; i++) {
      fireEvent.click(q('[data-testid="dc-queue-keep-mine"]'));
      await settleMany(10);
      if (copiesOf().length) expect(text()).toMatch(/dcQueueCopyHolds:5\.000/);
    }
    await waitFor(() => expect(copiesOf()).toHaveLength(0));
    expect(rowFor().revenue_breakdown).toEqual({ food: 5000 });
    expect(rowFor().payment_breakdown).toEqual({ cash: 5000 });
  };
  /** What is on screen is what is stored — and the day's copy is not answered by it. */
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
    // The copy's 5.000 (typed earlier on this phone, on no server) is still
    // here — never dropped by the card's answer — and was never sent by it.
    expect(copiesOf()).toHaveLength(1);
    expect(S.posts.some((b) => b.date === today && b.payment_breakdown?.cash === 5000)).toBe(false);
  };

  it("the queued copy's button stores the copy (its 5.000, as it says) — never the form's figures, and the card's question stays", async () => {
    await twoQuestions();
    const n = S.posts.length;
    await copyStoredByItsButton();
    // Nothing of the form's was sent by it: only the copy.
    expect(S.posts.slice(n).every((b) => b.payment_breakdown?.cash === 5000)).toBe(true);
    expect(q('[data-testid="dc-draft-changed"]')).not.toBeNull();
  }, 15000);

  it("the conflict card's button stores what is on screen — and the day's copy survives it, says what it holds, and its button still stores it", async () => {
    await twoQuestions();
    const card = q('[data-testid="dc-draft-changed"]');
    fireEvent.click([...card.querySelectorAll("button")].find((b) => b.textContent.trim() === "dcDraftChangedKeep"));
    await onScreenStored();
    await copyStoredByItsButton();
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
