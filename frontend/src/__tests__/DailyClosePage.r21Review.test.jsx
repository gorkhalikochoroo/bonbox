/**
 * Round 21 review — the version check, held where the round left it open
 * (closeSequenceHarness.createServer: the backend's rules in miniature).
 *
 *  1. The "draft saved somewhere else" question open and the page left: the
 *     owner's figures are kept on the device as a failed copy (the autosave
 *     sends nothing over the newer draft, so they were lost) — and only
 *     while the question is unanswered.
 *  2. A save waiting its turn never goes after a newer one already sent
 *     (a keepalive save whose answer comes back first).
 *  3. A save whose answer was lost (it landed) is the form's own: the next
 *     save and the lock follow it — never "saved somewhere else".
 *  4. A refused save older than a save of the form's already sent is not
 *     re-posted or kept once the form is gone.
 *  5. Start forfra never deletes a draft another phone has saved into since.
 *  6. "Behold mine tal" over another phone's Z-bon takes its photo off the
 *     day, said on the banner first.
 *  7. A queued lock that met draft_changed AND the anomaly check locks.
 *  8. Offline, Fortsæt opens the listed draft at once (no read by id).
 * Strings are asserted by key (t echoes key + values).
 */
import { act, fireEvent, render, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
const {
  OQ_KEY, QUEUE_ERR_DRAFT_CHANGED, QUEUE_FAILED, QUEUE_NEEDS_CONFIRMATION, getOfflineQueue,
} = await import("../utils/dailyCloseQueue");
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
afterEach(() => { vi.restoreAllMocks(); });
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
const settleN = async (n = 6) => { for (let i = 0; i < n; i++) await settle(); };
const hide = () => act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
const flush = async () => { await hide(); await settleN(4); };
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
const text = () => document.body.textContent;
const conflict = () => q('[data-testid="dc-draft-changed"]');
const foodsPosted = () => S.posts.filter((b) => b.date).map((b) => b.revenue_breakdown?.food ?? null);

const DRAFT = {
  id: "seed1", date: today, branch_id: null, status: "draft", closed_by: null, notes: null,
  revenue_total: 3000, revenue_breakdown: { food: 3000 }, payment_breakdown: {},
  moms_mode: "auto", moms_total: 600, source_meta: { kind: "typed" }, receipt_photo: null,
};
const phoneB = () => S.otherSave(KEY, (r) => {
  r.payment_breakdown = { card: 2000 }; r.payment_total = 2000; r.notes = "B";
});
const continueDraft = async (sel = "#dc-rev-food") => {
  tap(/^dcContinueDraft$/);
  await toStepWith(sel);
};

/* ─── 1 ─────────────────────────────────────────────────────────────── */

describe("1. the question open and the page left: the owner's figures are kept on the device", () => {
  it("refused, then 3.600 typed under the question, then left: a failed copy holds 3.600 — and \"Behold mine tal\" there stores it", async () => {
    serve([DRAFT]);
    const view = await mount();
    await continueDraft();
    phoneB();
    keyIn(q("#dc-rev-food"), "3.500");
    await flush();
    expect(conflict()).not.toBeNull();
    expect(getOfflineQueue()).toHaveLength(0);
    keyIn(q("#dc-rev-food"), "3.600");
    await settle();
    view.unmount();
    await settle();
    const kept = getOfflineQueue();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: rowFor().updated_at });
    expect(kept[0].payload).toMatchObject({ status: "draft", revenue_breakdown: { food: 3600 } });
    // Nothing was written over B's draft.
    expect(rowFor()).toMatchObject({ revenue_total: 3000, payment_breakdown: { card: 2000 }, notes: "B" });
    await mount();
    await waitFor(() => expect(text()).toContain("dcQueueErrDraftChanged"));
    fireEvent.click(q('[data-testid="dc-queue-keep-mine"]'));
    await settleN();
    expect(rowFor()).toMatchObject({ revenue_total: 3600, revenue_breakdown: { food: 3600 } });
    expect(JSON.parse(localStorage.getItem(OQ_KEY) || "[]")).toHaveLength(0);
  });

  it("left with nothing typed since the refusal: the refused 3.500 is the copy", async () => {
    serve([DRAFT]);
    const view = await mount();
    await continueDraft();
    phoneB();
    keyIn(q("#dc-rev-food"), "3.500");
    await flush();
    expect(conflict()).not.toBeNull();
    view.unmount();
    await settle();
    const kept = getOfflineQueue();
    expect(kept).toHaveLength(1);
    expect(kept[0].payload.revenue_breakdown).toEqual({ food: 3500 });
  });

  it("the lock refused, \"Behold mine tal og lås\" not yet tapped, the page left: the LOCK is kept — and locks from the copy", async () => {
    serve([DRAFT]);
    const view = await mount();
    await continueDraft("#dc-notes");
    phoneB();
    tap(/confirmAndLock/);
    await settleN();
    expect(conflict()).not.toBeNull();
    expect(rowFor().status).toBe("draft");
    view.unmount();
    await settle();
    const kept = getOfflineQueue();
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED });
    expect(kept[0].payload).toMatchObject({ status: "confirmed", revenue_breakdown: { food: 3000 } });
    expect(kept[0].payload.acknowledge_anomaly).toBeUndefined();
    await mount();
    await waitFor(() => expect(q('[data-testid="dc-queue-keep-mine"]')).not.toBeNull());
    fireEvent.click(q('[data-testid="dc-queue-keep-mine"]'));
    await settleN();
    expect(rowFor()).toMatchObject({ status: "confirmed", revenue_total: 3000, payment_breakdown: {} });
  });

  it("the page hidden with the question open keeps ONE copy (the newest figures); shown again, the copy goes and the question stays", async () => {
    serve([DRAFT]);
    await mount();
    await continueDraft();
    phoneB();
    keyIn(q("#dc-rev-food"), "3.500");
    await flush();
    expect(conflict()).not.toBeNull();
    await hide();
    keyIn(q("#dc-rev-food"), "3.700");
    await settle();
    await hide();
    const kept = getOfflineQueue();
    expect(kept).toHaveLength(1);
    expect(kept[0].payload.revenue_breakdown).toEqual({ food: 3700 });
    // Back on the page (bfcache / the tab shown again).
    await act(async () => { window.dispatchEvent(new Event("pageshow")); await new Promise((r) => setTimeout(r, 0)); });
    expect(getOfflineQueue()).toHaveLength(0);
    expect(conflict()).not.toBeNull();
  });

  it("answered after a hide: \"Behold mine tal\" stores the figures and the copy kept for the way out goes", async () => {
    serve([DRAFT]);
    await mount();
    await continueDraft();
    phoneB();
    keyIn(q("#dc-rev-food"), "3.500");
    await flush();
    await hide();
    expect(getOfflineQueue()).toHaveLength(1);
    tap(/^dcDraftChangedKeep$/);
    await settleN();
    expect(rowFor()).toMatchObject({ revenue_total: 3500 });
    expect(getOfflineQueue()).toHaveLength(0);
  });

  it("…and \"Hent den nyeste kladde\" lets the figures go: no copy is left behind", async () => {
    serve([DRAFT]);
    await mount();
    await continueDraft();
    phoneB();
    keyIn(q("#dc-rev-food"), "3.500");
    await flush();
    await hide();
    expect(getOfflineQueue()).toHaveLength(1);
    tap(/^dcDraftChangedReload$/);
    await toStepWith("#dc-pay-card");
    await settle();
    expect(getOfflineQueue()).toHaveLength(0);
  });

  it("no question open: leaving keeps no copy (the waiting save simply goes)", async () => {
    serve([DRAFT]);
    const view = await mount();
    await continueDraft();
    keyIn(q("#dc-rev-food"), "3.500");
    view.unmount();
    await settleN();
    expect(getOfflineQueue()).toHaveLength(0);
    expect(rowFor().revenue_breakdown).toEqual({ food: 3500 });
  });
});

/* ─── 2 ─────────────────────────────────────────────────────────────── */

describe("2. a save waiting its turn never goes after a newer one already sent", () => {
  it("A stored (its answer late), B waits on the debounce, D goes at once on pagehide and answers first: B is not sent — D's 4.500 is stored", async () => {
    serve([DRAFT]);
    await mount();
    await continueDraft();
    const real = post.getMockImplementation();
    let openA = null;
    post.mockImplementation((url, body, cfg) => {
      if (url === "/daily-close" && body?.revenue_breakdown?.food === 3500 && !openA) {
        const out = real(url, body, cfg); // stored now …
        out.catch(() => {});
        return new Promise((res, rej) => { openA = () => out.then(res, rej); }); // … answered later
      }
      return real(url, body, cfg);
    });
    keyIn(q("#dc-rev-food"), "3.500");
    await hide();
    expect(openA).toBeTruthy();
    keyIn(q("#dc-rev-food"), "4.000");
    // The 2 s debounce: B starts and waits for A's answer.
    await act(() => new Promise((r) => setTimeout(r, 2200)));
    keyIn(q("#dc-rev-food"), "4.500");
    await hide();
    await settleN(3);
    expect(rowFor().revenue_breakdown).toEqual({ food: 4500 });
    await act(async () => { openA(); await new Promise((r) => setTimeout(r, 0)); });
    await settleN(8);
    expect(foodsPosted()).toEqual([3500, 4500]);
    expect(S.refused).toHaveLength(0);
    expect(rowFor().revenue_breakdown).toEqual({ food: 4500 });
    expect(q("#dc-rev-food").value).toBe("4.500");
    expect(conflict()).toBeNull();
  }, 15000);
});

/* ─── 3 ─────────────────────────────────────────────────────────────── */

describe("3. a save whose answer was lost is the form's own", () => {
  const dropFirst = (food) => {
    const real = post.getMockImplementation();
    let dropped = null;
    post.mockImplementation((url, body, cfg) => {
      if (url === "/daily-close" && body?.revenue_breakdown?.food === food && !dropped) {
        dropped = body;
        // It reaches the server and is stored; the answer never comes back.
        return real(url, body, cfg).then(() => Promise.reject(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" })));
      }
      return real(url, body, cfg);
    });
    return () => dropped;
  };

  it("the next save follows it (base_save_id): stored, nobody asked", async () => {
    serve([DRAFT]);
    await mount();
    await continueDraft();
    const lost = dropFirst(3500);
    keyIn(q("#dc-rev-food"), "3.500");
    await flush();
    expect(rowFor().revenue_breakdown).toEqual({ food: 3500 });
    keyIn(q("#dc-rev-food"), "4.000");
    await flush();
    const next = S.posts.filter((b) => b.date).at(-1);
    expect(next.base_save_id).toBe(lost().save_id);
    expect(S.refused).toHaveLength(0);
    expect(conflict()).toBeNull();
    expect(rowFor().revenue_breakdown).toEqual({ food: 4000 });
  });

  it("the lock follows it too: locked, never \"saved somewhere else\"", async () => {
    serve([DRAFT]);
    await mount();
    await continueDraft("#dc-notes");
    const lost = dropFirst(3000);
    keyIn(q("#dc-notes"), "A");
    await flush();
    expect(rowFor().notes).toBe("A");
    tap(/confirmAndLock/);
    await settleN();
    expect(S.refused).toHaveLength(0);
    expect(conflict()).toBeNull();
    const lock = S.posts.filter((b) => b.status === "confirmed").at(-1);
    expect(lock.base_save_id).toBe(lost().save_id);
    expect(rowFor()).toMatchObject({ status: "confirmed", notes: "A" });
  });

  it("…while another phone's save after it is still refused", async () => {
    serve([DRAFT]);
    await mount();
    await continueDraft();
    dropFirst(3500);
    keyIn(q("#dc-rev-food"), "3.500");
    await flush();
    phoneB();
    keyIn(q("#dc-rev-food"), "4.000");
    await flush();
    expect(S.refused).toHaveLength(1);
    expect(rowFor()).toMatchObject({ notes: "B", payment_breakdown: { card: 2000 } });
    expect(conflict()).not.toBeNull();
  });
});

/* ─── 4 ─────────────────────────────────────────────────────────────── */

describe("4. a refused save older than one already sent is never re-posted or kept", () => {
  const holdArrival = (food) => {
    const real = post.getMockImplementation();
    let open = null;
    post.mockImplementation((url, body, cfg) => {
      if (url === "/daily-close" && body?.revenue_breakdown?.food === food && !open) {
        return new Promise((res, rej) => { open = () => real(url, body, cfg).then(res, rej); });
      }
      return real(url, body, cfg);
    });
    return () => open;
  };

  it("R (3.500) stalls, O (4.000) goes at once and lands, the form is left, R arrives and is refused: 4.000 stays, nothing re-posted, nothing kept", async () => {
    serve([DRAFT]);
    const view = await mount();
    await continueDraft();
    const openR = holdArrival(3500);
    keyIn(q("#dc-rev-food"), "3.500");
    await hide();
    keyIn(q("#dc-rev-food"), "4.000");
    await hide();
    await settleN(3);
    expect(rowFor().revenue_breakdown).toEqual({ food: 4000 });
    view.unmount();
    await settle();
    await act(async () => { openR()(); await new Promise((r) => setTimeout(r, 0)); });
    await settleN(8);
    expect(S.refused).toHaveLength(1);
    expect(foodsPosted()).toEqual([4000]);
    expect(rowFor().revenue_breakdown).toEqual({ food: 4000 });
    expect(getOfflineQueue()).toHaveLength(0);
  });

  it("…and with O's answer still on its way when R is refused: still not kept as \"saved somewhere else\"", async () => {
    serve([DRAFT]);
    const view = await mount();
    await continueDraft();
    const real = post.getMockImplementation();
    let openR = null;
    let openO = null;
    post.mockImplementation((url, body, cfg) => {
      if (url === "/daily-close" && body?.revenue_breakdown?.food === 3500 && !openR) {
        return new Promise((res, rej) => { openR = () => real(url, body, cfg).then(res, rej); });
      }
      if (url === "/daily-close" && body?.revenue_breakdown?.food === 4000 && !openO) {
        const out = real(url, body, cfg);
        out.catch(() => {});
        return new Promise((res, rej) => { openO = () => out.then(res, rej); });
      }
      return real(url, body, cfg);
    });
    keyIn(q("#dc-rev-food"), "3.500");
    await hide();
    keyIn(q("#dc-rev-food"), "4.000");
    await hide();
    await settle();
    view.unmount();
    await settle();
    await act(async () => { openR(); await new Promise((r) => setTimeout(r, 0)); });
    await settleN(4);
    expect(S.refused).toHaveLength(1);
    expect(getOfflineQueue()).toHaveLength(0);
    await act(async () => { openO(); await new Promise((r) => setTimeout(r, 0)); });
    await settleN(4);
    expect(foodsPosted()).toEqual([4000]);
    expect(rowFor().revenue_breakdown).toEqual({ food: 4000 });
    expect(getOfflineQueue()).toHaveLength(0);
  });
});

/* ─── 5 ─────────────────────────────────────────────────────────────── */

describe("5. Start forfra never deletes a draft another phone saved into since", () => {
  it("a 5.000 bon filed (this form made the draft), the other phone adds Kort 2.000 and a note, Start forfra: refused — kept, and the banner shows it", async () => {
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^useTheseValuesJumpReview$/);
    await flush();
    expect(rowFor()).toMatchObject({ revenue_total: 5000 });
    S.otherSave(KEY, (r) => { r.payment_breakdown = { ...r.payment_breakdown, card: 2000 }; r.notes = "B"; });
    await backToCard();
    tap(/^startOver$/);
    await settle();
    await flush();
    expect(S.deletes).toEqual([]);
    expect(S.refusedDeletes).toHaveLength(1);
    expect(rowFor()).toMatchObject({ status: "draft", notes: "B", revenue_total: 5000 });
    expect(rowFor().payment_breakdown.card).toBe(2000);
    // The day's banner shows the draft as it is stored.
    await waitFor(() => expect(text()).toContain("dcDayHasDraftBody:5.000 kr."));
  });

  it("nobody else wrote: Start forfra deletes the draft this form made (on its own version)", async () => {
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^useTheseValuesJumpReview$/);
    await flush();
    const id = rowFor().id;
    await backToCard();
    tap(/^startOver$/);
    await settle();
    await flush();
    expect(S.deletes).toEqual([id]);
    expect(S.refusedDeletes).toHaveLength(0);
    expect(del.mock.calls.at(-1)[1]).toMatchObject({ params: { base_updated_at: expect.any(String) } });
    expect(rowFor()).toBeUndefined();
  });
});

/* ─── 6 ─────────────────────────────────────────────────────────────── */

describe("6. \"Behold mine tal\" over another phone's Z-bon takes its photo off the day", () => {
  it("typed 3.500 kept over a 15.000 Z-bon with a photo: stored 3.500, typed, no photo — said on the banner first", async () => {
    serve([DRAFT]);
    await mount();
    await continueDraft();
    S.otherSave(KEY, (r) => {
      r.revenue_breakdown = { food: 9000, drinks: 6000 }; r.revenue_total = 15000;
      r.receipt_photo = "u1/kasserapport/otherphone.jpg";
      r.source_meta = { kind: "zbon", scans: 1, corrected: [] };
    });
    keyIn(q("#dc-rev-food"), "3.500");
    await flush();
    expect(conflict()).not.toBeNull();
    expect(q('[data-testid="dc-draft-changed-photo"]')).not.toBeNull();
    tap(/^dcDraftChangedKeep$/);
    await settleN();
    expect(posted().at(-1).receipt_photo).toBe("");
    expect(rowFor()).toMatchObject({ revenue_total: 3500, revenue_breakdown: { food: 3500 }, source_meta: { kind: "typed" }, receipt_photo: null });
  });

  it("the other version has no photo: nothing about a photo is said", async () => {
    serve([DRAFT]);
    await mount();
    await continueDraft();
    phoneB();
    keyIn(q("#dc-rev-food"), "3.500");
    await flush();
    expect(conflict()).not.toBeNull();
    expect(q('[data-testid="dc-draft-changed-photo"]')).toBeNull();
  });
});
const posted = () => S.posts.filter((b) => b.date);

/* ─── 7 ─────────────────────────────────────────────────────────────── */

describe("7. a queued lock that met draft_changed and the anomaly check locks", () => {
  // The server checks the version first, then the anomaly guard (a lock with
  // no acknowledge_anomaly is answered requires_confirmation, nothing saved).
  const anomalyGuard = () => {
    const real = post.getMockImplementation();
    post.mockImplementation((url, body, cfg) => {
      if (url === "/daily-close" && body?.status === "confirmed" && !body.acknowledge_anomaly && !S.changedSince(body)) {
        return Promise.resolve({ data: { requires_confirmation: true, anomaly: { reason: "low", today_total: 3500, baseline_avg: 20000, delta_pct: -0.8 } } });
      }
      return real(url, body, cfg);
    });
  };
  const lockCopy = (base, stamp) => ({
    id: "q1", ts: 1, state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: stamp, httpStatus: 412,
    payload: { date: today, branch_id: null, status: "confirmed", revenue_breakdown: { food: 3500 }, payment_breakdown: {}, base_updated_at: base },
  });

  it("\"Behold mine tal\" meets the anomaly: the copy now holds the newer version — \"Ja, lås den\" locks it", async () => {
    serve([DRAFT]);
    const opened = rowFor().updated_at;
    phoneB();
    localStorage.setItem(OQ_KEY, JSON.stringify([lockCopy(opened, rowFor().updated_at)]));
    anomalyGuard();
    await mount();
    await waitFor(() => expect(q('[data-testid="dc-queue-keep-mine"]')).not.toBeNull());
    fireEvent.click(q('[data-testid="dc-queue-keep-mine"]'));
    await settleN();
    const [item] = getOfflineQueue();
    expect(item).toMatchObject({ state: QUEUE_NEEDS_CONFIRMATION });
    expect(item.payload.base_updated_at).toBe(rowFor().updated_at);
    tap(/^dcQueueReviewCta$/);
    await waitFor(() => expect(btn(/^closeAnomalyConfirm$/)).toBeTruthy());
    tap(/^closeAnomalyConfirm$/);
    await settleN();
    expect(rowFor()).toMatchObject({ status: "confirmed", revenue_total: 3500 });
    expect(getOfflineQueue()).toHaveLength(0);
  });

  it("the anomaly first, then the draft changed again before the confirm: refused once, kept — then it locks", async () => {
    serve([DRAFT]);
    const opened = rowFor().updated_at;
    phoneB();
    localStorage.setItem(OQ_KEY, JSON.stringify([lockCopy(opened, rowFor().updated_at)]));
    anomalyGuard();
    await mount();
    await waitFor(() => expect(q('[data-testid="dc-queue-keep-mine"]')).not.toBeNull());
    fireEvent.click(q('[data-testid="dc-queue-keep-mine"]'));
    await settleN();
    expect(getOfflineQueue()[0].state).toBe(QUEUE_NEEDS_CONFIRMATION);
    // The other phone saves again before the owner confirms.
    S.otherSave(KEY, (r) => { r.notes = "B2"; });
    tap(/^dcQueueReviewCta$/);
    await waitFor(() => expect(btn(/^closeAnomalyConfirm$/)).toBeTruthy());
    tap(/^closeAnomalyConfirm$/);
    await settleN();
    expect(rowFor().status).toBe("draft");
    expect(getOfflineQueue()[0]).toMatchObject({ state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: rowFor().updated_at });
    // The dialog says why; the owner closes it and keeps theirs again.
    const close = btn(/^closeAnomalyEdit$/) || btn(/^cancel$/) || btn(/^close$/);
    if (close) fireEvent.click(close);
    await settle();
    fireEvent.click(q('[data-testid="dc-queue-keep-mine"]'));
    await settleN();
    expect(getOfflineQueue()[0].state).toBe(QUEUE_NEEDS_CONFIRMATION);
    tap(/^dcQueueReviewCta$/);
    await waitFor(() => expect(btn(/^closeAnomalyConfirm$/)).toBeTruthy());
    tap(/^closeAnomalyConfirm$/);
    await settleN();
    expect(rowFor()).toMatchObject({ status: "confirmed", revenue_total: 3500 });
    expect(getOfflineQueue()).toHaveLength(0);
  });
});

/* ─── 8 ─────────────────────────────────────────────────────────────── */

describe("8. offline, Fortsæt opens the listed draft at once", () => {
  it("navigator offline: no read by id — the listed draft opens", async () => {
    serve([DRAFT]);
    vi.spyOn(window.navigator, "onLine", "get").mockReturnValue(false);
    await mount();
    await continueDraft();
    expect(q("#dc-rev-food").value).toBe("3.000");
    expect(S.byIdGets || 0).toBe(0);
  });

  it("a copy refused as draft_changed alone: no \"couldn't be saved — retry\" chip that would send nothing", async () => {
    serve([DRAFT]);
    localStorage.setItem(OQ_KEY, JSON.stringify([{
      id: "q1", ts: 1, state: QUEUE_FAILED, errorCode: QUEUE_ERR_DRAFT_CHANGED, conflictStamp: "x",
      payload: { date: today, status: "draft", revenue_breakdown: { food: 3500 } },
    }]));
    await mount();
    await waitFor(() => expect(q('[data-testid="dc-queue-keep-mine"]')).not.toBeNull());
    expect(text()).not.toContain("dcQueuedFailed");
  });
});
