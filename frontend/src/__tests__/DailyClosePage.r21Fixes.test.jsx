/**
 * Round 21 — the money / data-loss items, held to the STORED row
 * (closeSequenceHarness.createServer: the backend's save rule in miniature,
 * updated_at and the draft_changed check included).
 *
 *  1. Start forfra on a day whose own till is payments only files that till
 *     (the autosave's own rule) — the thrown-away Z-bon's figures, photo and
 *     source leave the stored draft; nothing is deleted.
 *  2. A draft changed elsewhere is never overwritten in silence: every
 *     draft is opened fresh (by id — Fortsæt, Rediger, ?date=), every save
 *     says which version it was built on, a refusal (draft_changed) asks
 *     "Hent den nyeste kladde" / "Behold mine tal", the form's own crossing
 *     saves never ask, a save refused after the page was left is kept as a
 *     failed copy on the device, and a lock is never made over a newer draft.
 *  3. Payments only are saved (revenue 0), and History / the day's banner /
 *     the delete question say "kun betalinger", never "0 kr.".
 *  4. The photo filed is recorded when its save is SENT: Start forfra while
 *     that save is on its way clears it ("").
 *  6. The scan card never blames the bons for the owner's own correction.
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
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, minPlanForFeature: () => null, isReady: true }),
}));
vi.mock("../components/BranchSelector", () => ({
  useBranch: () => ({ branchId: null, branchType: "restaurant", hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => null }));
vi.mock("../components/SmartScanModal", () => ({ default: () => null }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const { BONS, NO_ROW_BASE, createServer, installApi, photoUrl } = await import("../test/closeSequenceHarness");
const { OQ_KEY, QUEUE_ERR_DRAFT_CHANGED, QUEUE_FAILED, getOfflineQueue } = await import("../utils/dailyCloseQueue");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const KEY = `${today}|`;

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
});
const serve = (rows = []) => {
  S = createServer({ rows: rows.map((r) => ({ ...r })) });
  installApi(S, get, post, del);
};

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
const release = async () => {
  for (let i = 0; i < 6 && S.held.length; i++) {
    await act(async () => { S.releaseHeld(); await new Promise((r) => setTimeout(r, 0)); });
    await settle();
  }
};
const keyIn = (el, value) => {
  if (el.value !== "") fireEvent.change(el, { target: { value: "" } });
  for (const ch of value) fireEvent.change(el, { target: { value: el.value + ch } });
};
const mount = async (entry = "/daily-close") => {
  const view = render(<MemoryRouter initialEntries={[entry]}><DailyClosePage /></MemoryRouter>);
  const want = S.rows.has(KEY) ? "dcDayHasDraft" : "scanZReportTitle";
  for (let i = 0; i < 10 && !document.body.textContent.includes(want); i++) await settle();
  return view;
};
const shoot = async (key, name) => {
  S.nextScan = { ...BONS[key], image_url: photoUrl(name) };
  const input = [...document.querySelectorAll('input[type="file"]')].at(-1);
  fireEvent.change(input, { target: { files: [new File([name], name, { type: "image/jpeg", lastModified: 1 })] } });
  await waitFor(() => expect(q('[data-testid="dc-scan-result-date"]')).not.toBeNull());
};
const shootStub = async (stub, name) => {
  S.nextScan = { raw_text: "BON", ocr_available: true, payments: {}, revenue: {}, ...stub, image_url: photoUrl(name) };
  const input = [...document.querySelectorAll('input[type="file"]')].at(-1);
  fireEvent.change(input, { target: { files: [new File([name], name, { type: "image/jpeg", lastModified: 1 })] } });
  await waitFor(() => expect(q('[data-testid="dc-scan-result-date"]')).not.toBeNull());
};
const toStepWith = async (sel) => {
  await waitFor(() => expect(q("#close-date")).not.toBeNull());
  for (let i = 0; i < 8 && !q(sel); i++) {
    const next = btn(/^next\s*→$/);
    if (!next) break;
    fireEvent.click(next);
  }
  await waitFor(() => expect(q(sel)).not.toBeNull());
};
const backToCard = async () => {
  for (let i = 0; i < 8 && !q("#dc-rev-food"); i++) tap(/^←\s*back$/);
  tap(/^←\s*scanZReportBack$/);
  await settle();
};
const rowFor = () => S.rows.get(KEY);
const posted = () => S.posts.filter((b) => b.date);
const text = () => document.body.textContent;

const DRAFT = {
  id: "seed1", date: today, branch_id: null, status: "draft", closed_by: null, notes: null,
  revenue_total: 3000, revenue_breakdown: { food: 3000 }, payment_breakdown: {},
  moms_mode: "auto", moms_total: 600, source_meta: { kind: "typed" }, receipt_photo: null,
};
// Another phone saves the day: Kort 2.000 and a note (a new version).
const phoneB = () => S.otherSave(KEY, (r) => {
  r.payment_breakdown = { card: 2000 }; r.payment_total = 2000; r.notes = "B";
});

/* ─── 3 ─────────────────────────────────────────────────────────────── */

describe("3. payments only are saved, and said as payments only", () => {
  it("MobilePay 1.234,50 typed with no revenue line: one draft, revenue 0, the payments — leaving sends it", async () => {
    serve();
    const view = await mount();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-pay-mobilepay");
    keyIn(q("#dc-pay-mobilepay"), "1.234,50");
    // Leaving the page (an unmount, no pagehide): the waiting save goes.
    view.unmount();
    await settle();
    await settle();
    expect(posted()).toHaveLength(1);
    expect(posted()[0]).toMatchObject({ status: "draft", revenue_breakdown: {}, payment_breakdown: { mobilepay: 1234.5 } });
    expect(rowFor()).toMatchObject({ revenue_total: 0, payment_breakdown: { mobilepay: 1234.5 } });
  });

  it("the day's banner, History and the delete question say \"kun betalinger\" — never 0 kr. — and Fortsæt brings the payments back", async () => {
    serve([{ ...DRAFT, revenue_total: 0, revenue_breakdown: {}, payment_breakdown: { mobilepay: 1234.5 }, moms_total: 0 }]);
    await mount();
    expect(text()).toContain("dcDayHasDraftBodyPaymentsOnly:1.234,50 kr.");
    expect(text()).not.toContain("dcDayHasDraftBody:");
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-pay-mobilepay");
    expect(q("#dc-pay-mobilepay").value).toBe("1.234,50");
    // History.
    fireEvent.click(screen.getByRole("tab", { name: "historyTab" }));
    await waitFor(() => expect(q('[data-testid="dc-history-payments-only"]')).not.toBeNull());
    expect(q('[data-testid="dc-history-payments-only"]').textContent).toBe("dcDraftPaymentsOnly:1.234,50 kr.");
  });
});

/* ─── 1 ─────────────────────────────────────────────────────────────── */

describe("1. Start forfra on a payments-only own till", () => {
  // Round 23 (A, expectation changed): Start forfra deletes the day's draft
  // — the summed 18.264,50, asked first — instead of filing the owner's
  // payments back; the thrown-away bon is never left stored, because
  // nothing is.
  it("the reviewers' repro: MobilePay 1.234,50 + a 17.030 bon summed and filed, Start forfra → the draft is deleted (asked, named): no bon left stored", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-pay-mobilepay");
    keyIn(q("#dc-pay-mobilepay"), "1.234,50");
    await flush();
    await backToCard();
    await shoot("till1", "till1.jpg");
    tap(/^scanSecondTotalSum/);
    tap(/^continueStepByStep$/);
    await flush();
    expect(rowFor()).toMatchObject({ revenue_total: 18264.5, receipt_photo: photoUrl("till1.jpg") });
    await backToCard();
    const n = S.posts.length;
    tap(/^startOver$/);
    await settle();
    await flush();
    expect(window.confirm.mock.calls.at(-1)[0]).toMatch(/^dcStartOverDeleteBody:.*\|18\.264,50 kr\.$/);
    expect(S.deletes).toHaveLength(1);
    expect(rowFor()).toBeUndefined();
    // Nothing filed after: the form starts over empty.
    expect(S.posts.length).toBe(n);
  });
});

/* ─── 2 ─────────────────────────────────────────────────────────────── */

describe("2. a draft changed elsewhere is never overwritten in silence", () => {
  it("Fortsæt reads the draft by id: a draft saved on another phone after the list was read opens as it is now", async () => {
    serve([DRAFT]);
    await mount();
    phoneB();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-pay-card");
    // (Never retried, never held long — round 21 review: offline it stalled ~26 s.)
    expect(get).toHaveBeenCalledWith("/daily-close/seed1", expect.objectContaining({ _noRetry: true }));
    expect(q("#dc-pay-card").value).toBe("2.000");
  });

  it("Rediger in History reads it fresh too", async () => {
    serve([DRAFT]);
    await mount();
    fireEvent.click(screen.getByRole("tab", { name: "historyTab" }));
    await waitFor(() => expect(btn(/^edit$/)).toBeTruthy());
    phoneB();
    tap(/^edit$/);
    await toStepWith("#dc-pay-card");
    expect(q("#dc-pay-card").value).toBe("2.000");
  });

  it("a ?date= link that opens the draft by itself reads it fresh too", async () => {
    serve([DRAFT]);
    const real = get.getMockImplementation();
    let changed = false;
    get.mockImplementation((url, cfg) => {
      const r = real(url, cfg);
      // The list answers with the older row; the phone saves right after.
      if (url === "/daily-close" && !changed) { changed = true; phoneB(); }
      return r;
    });
    render(<MemoryRouter initialEntries={[`/daily-close?date=${today}`]}><DailyClosePage /></MemoryRouter>);
    await toStepWith("#dc-pay-card");
    expect(q("#dc-pay-card").value).toBe("2.000");
  });

  it("every save says which version it was built on: the opened one, then each answer's; a new day says \"no row\"", async () => {
    serve([DRAFT]);
    await mount();
    const opened = rowFor().updated_at;
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3.500");
    await flush();
    expect(posted().at(-1).base_updated_at).toBe(opened);
    const answered = rowFor().updated_at;
    expect(answered > opened).toBe(true);
    keyIn(q("#dc-rev-food"), "4.000");
    await flush();
    expect(posted().at(-1).base_updated_at).toBe(answered);
    expect(S.refused).toHaveLength(0);
  });

  it("a new day's first save carries the no-row base", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3.000");
    await flush();
    expect(posted().at(-1).base_updated_at).toBe(NO_ROW_BASE);
  });

  it("device B saves between A's open and A's edit: A's edit is refused, B's draft stays, A is asked — and nothing more is sent until A answers", async () => {
    serve([DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-rev-food");
    phoneB();
    keyIn(q("#dc-rev-food"), "3.500");
    await flush();
    expect(S.refused).toHaveLength(1);
    expect(rowFor()).toMatchObject({ revenue_total: 3000, payment_breakdown: { card: 2000 }, notes: "B" });
    const banner = q('[data-testid="dc-draft-changed"]');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("dcDraftChangedTitle");
    expect(banner.textContent).toContain("dcDraftChangedBody:");
    expect(banner.textContent).toContain("3.000 kr.");
    expect(btn(/^dcDraftChangedReload$/)).toBeTruthy();
    expect(btn(/^dcDraftChangedKeep$/)).toBeTruthy();
    const n = S.posts.length + S.refused.length;
    keyIn(q("#dc-rev-food"), "3.600");
    await flush();
    expect(S.posts.length + S.refused.length).toBe(n);
  });

  it("\"Behold mine tal\": sent again at once on B's version — A's figures are stored, by the owner's choice", async () => {
    serve([DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-rev-food");
    phoneB();
    const bVersion = rowFor().updated_at;
    keyIn(q("#dc-rev-food"), "3.500");
    await flush();
    tap(/^dcDraftChangedKeep$/);
    for (let i = 0; i < 4; i++) await settle();
    expect(posted().at(-1)).toMatchObject({ base_updated_at: bVersion, revenue_breakdown: { food: 3500 } });
    expect(rowFor()).toMatchObject({ revenue_total: 3500, payment_breakdown: {} });
    expect(q('[data-testid="dc-draft-changed"]')).toBeNull();
  });

  it("\"Behold mine tal\" over another version's Z-bon corrections: the form says its own source again (null kept theirs)", async () => {
    serve([{ ...DRAFT, revenue_total: 17030, revenue_breakdown: { food: 9000, drinks: 6000, takeaway: 2030 },
      payment_breakdown: { card: 12000, cash: 5030 }, moms_mode: "manual", moms_total: 3406,
      source_meta: { kind: "zbon", scans: 1, corrected: [] } }]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-notes");
    // B corrected Mad and MobilePay on its copy of the read.
    S.otherSave(KEY, (r) => {
      r.revenue_breakdown = { ...r.revenue_breakdown, food: 9500 }; r.revenue_total = 17530;
      r.source_meta = { kind: "zbon", scans: 1, corrected: ["rev:food", "pay:mobilepay"] };
    });
    keyIn(q("#dc-notes"), "A");
    await flush();
    expect(q('[data-testid="dc-draft-changed"]')).not.toBeNull();
    tap(/^dcDraftChangedKeep$/);
    for (let i = 0; i < 4; i++) await settle();
    const row = rowFor();
    expect(row).toMatchObject({ revenue_total: 17030, notes: "A" });
    expect(row.revenue_breakdown.food).toBe(9000);
    // The read as this form holds it: nothing corrected — never B's "Mad, MobilePay".
    expect(row.source_meta).toMatchObject({ kind: "zbon", corrected: [] });
  });

  it("\"Hent den nyeste kladde\": B's draft opens (read by id); the next edit is saved on it", async () => {
    serve([DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-rev-food");
    phoneB();
    keyIn(q("#dc-rev-food"), "3.500");
    await flush();
    tap(/^dcDraftChangedReload$/);
    await toStepWith("#dc-pay-card");
    expect(q("#dc-pay-card").value).toBe("2.000");
    expect(q('[data-testid="dc-draft-changed"]')).toBeNull();
    keyIn(q("#dc-pay-card"), "2.500");
    await flush();
    expect(rowFor()).toMatchObject({ revenue_total: 3000, payment_breakdown: { card: 2500 }, notes: "B" });
    expect(S.refused).toHaveLength(1);
  });

  it("the form's own saves never cross: the next one waits for the one on its way and goes on its answer — nobody is asked", async () => {
    serve([DRAFT]);
    const view = await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3.500");
    // Stored at once, its answer late.
    S.holding.answer = true;
    await flush();
    S.holding.answer = false;
    keyIn(q("#dc-rev-food"), "4.000");
    // Leaving (an unmount: not the page going away) — the save waits its turn.
    view.unmount();
    await settle();
    await release();
    for (let i = 0; i < 4; i++) await settle();
    expect(S.refused).toHaveLength(0);
    expect(rowFor().revenue_breakdown).toEqual({ food: 4000 });
  });

  it("the page going away with a save on its way: the last change goes at once, after its own save — stored, nobody asked", async () => {
    serve([DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3.500");
    S.holding.answer = true;
    await flush();
    keyIn(q("#dc-rev-food"), "4.000");
    // pagehide (keepalive): no time to wait for the first save's answer.
    await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
    S.holding.answer = false;
    const [first, second] = post.mock.calls.filter(([u]) => u === "/daily-close").map(([, b]) => b).slice(-2);
    expect(second.base_save_id).toBe(first.save_id);
    expect(second.base_updated_at).toBe(first.base_updated_at);
    await release();
    expect(S.refused).toHaveLength(0);
    expect(rowFor().revenue_breakdown).toEqual({ food: 4000 });
  });

  it("…and another phone's save in between is still refused: the change is never filed over it", async () => {
    serve([DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3.500");
    S.holding.post = true;
    await flush();
    keyIn(q("#dc-rev-food"), "4.000");
    await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
    S.holding.post = false;
    // The first lands, then the phone saves, then the second arrives.
    await act(async () => { const go = S.held.shift(); go(); await new Promise((r) => setTimeout(r, 0)); });
    phoneB();
    await release();
    for (let i = 0; i < 4; i++) await settle();
    expect(S.refused).toHaveLength(1);
    expect(rowFor()).toMatchObject({ payment_breakdown: { card: 2000 }, notes: "B" });
    expect(q('[data-testid="dc-draft-changed"]')).not.toBeNull();
  });

  it("refused after the page was left: kept on this phone as a failed copy (never \"already saved\"), and \"Behold mine tal\" there sends it on the newer version", async () => {
    serve([DRAFT]);
    const view = await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-notes");
    keyIn(q("#dc-notes"), "A");
    phoneB();
    view.unmount();
    for (let i = 0; i < 6; i++) await settle();
    expect(S.refused).toHaveLength(1);
    const kept = getOfflineQueue();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: rowFor().updated_at });
    expect(kept[0].payload.notes).toBe("A");
    // Opened again: said in Danish, with the owner's way out.
    await mount();
    await waitFor(() => expect(text()).toContain("dcQueueErrDraftChanged"));
    expect(text()).not.toContain("dcQueueErrLocked");
    fireEvent.click(q('[data-testid="dc-queue-keep-mine"]'));
    for (let i = 0; i < 6; i++) await settle();
    expect(rowFor().notes).toBe("A");
    expect(JSON.parse(localStorage.getItem(OQ_KEY) || "[]")).toHaveLength(0);
  });

  it("a lock is never made over a newer draft: refused, asked — \"Behold mine tal og lås\" locks on the newer version", async () => {
    serve([DRAFT]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-notes");
    phoneB();
    tap(/confirmAndLock/);
    for (let i = 0; i < 6; i++) await settle();
    expect(rowFor().status).toBe("draft");
    expect(rowFor().payment_breakdown).toEqual({ card: 2000 });
    expect(q('[data-testid="dc-draft-changed"]')).not.toBeNull();
    tap(/^dcDraftChangedKeepLock$/);
    for (let i = 0; i < 6; i++) await settle();
    expect(rowFor()).toMatchObject({ status: "confirmed", revenue_total: 3000, payment_breakdown: {} });
  });
});

/* ─── found by the round-21 harness (date moves) ─────────────────────── */

describe("a Z-bon's day moved, and moved back before the new day's save answered", () => {
  it("today → yesterday (its save stored, the answer late) → today: yesterday keeps no copy of the figures", async () => {
    const yesterday = (() => { const d = new Date(`${today}T12:00:00`); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^useTheseValuesJumpReview$/);
    await flush();
    expect(rowFor()).toMatchObject({ revenue_total: 5000 });
    S.holding.answer = true;
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    await flush();
    expect(S.rows.get(`${yesterday}|`)).toMatchObject({ revenue_total: 5000 });
    fireEvent.change(q("#close-date"), { target: { value: today } });
    await flush();
    S.holding.answer = false;
    await release();
    await flush();
    await release();
    for (let i = 0; i < 4; i++) await settle();
    expect(S.rows.get(`${yesterday}|`)).toBeUndefined();
    expect(rowFor()).toMatchObject({ revenue_total: 5000 });
  });
});

/* ─── 4 ─────────────────────────────────────────────────────────────── */

describe("4. the photo filed is recorded when its save is sent", () => {
  // Round 23 (A, expectation changed): Start forfra waits for the late answer,
  // then deletes the draft — the bon's photo with it; nothing is filed after.
  it("typed 3.000 + a 4.000 bon filed (its answer late), Start forfra: the draft — the bon's photo with it — is deleted once that save has answered", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3.000");
    await flush();
    await backToCard();
    await shoot("b4000", "bon4000.jpg");
    tap(/^scanSecondTotalSum/);
    S.holding.answer = true;
    tap(/^continueStepByStep$/);
    await flush();
    expect(rowFor().receipt_photo).toBe(photoUrl("bon4000.jpg"));
    await backToCard();
    tap(/^startOver$/);
    await settle();
    await flush();
    S.holding.answer = false;
    await release();
    await flush();
    expect(S.deletes).toHaveLength(1);
    expect(S.deletedRows.at(-1)).toMatchObject({ revenue_total: 7000, receipt_photo: photoUrl("bon4000.jpg") });
    expect(rowFor()).toBeUndefined();
  });
});

/* ─── 6 ─────────────────────────────────────────────────────────────── */

describe("6. the scan card never blames the bons for the owner's own correction", () => {
  const BON_14000 = { revenue: { food: 10000, drinks: 4000 }, revenue_total: 14000, moms_total: 2800, payments: { card: 14000 } };
  const BON_2000 = { revenue: { food: 1500, drinks: 500 }, revenue_total: 2000, moms_total: 400, payments: { card: 2000 } };

  it("two bons summed, Mad raised by 500 on the card: \"Med dine rettelser …\" — never \"the bons' categories\"", async () => {
    serve();
    await mount();
    await shootStub(BON_14000, "a.jpg");
    await shootStub(BON_2000, "b.jpg");
    tap(/^scanSecondTotalSum/);
    await settle();
    keyIn(q("#scan-rev-food"), "12.000");
    fireEvent.blur(q("#scan-rev-food"));
    await settle();
    expect(text()).toContain("dcScanTillsOverBonEdited:500 kr.");
    expect(text()).not.toContain("dcScanTillsOverBon:");
  });

  it("the bons' own categories over their totals (no correction): said so, with the remedy", async () => {
    serve();
    await mount();
    await shootStub({ revenue: { food: 3000 }, revenue_total: 2500, payments: { card: 2500 } }, "a.jpg");
    await shootStub(BON_2000, "b.jpg");
    tap(/^scanSecondTotalSum/);
    await settle();
    expect(text()).toContain("dcScanTillsOverBon:500 kr.");
    expect(text()).not.toContain("dcScanTillsOverBonEdited");
  });
});
