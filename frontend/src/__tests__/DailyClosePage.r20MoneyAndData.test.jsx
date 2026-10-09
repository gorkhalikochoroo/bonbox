/**
 * Round 20 — the last money-wrong and data-loss items, held to the STORED row
 * (closeSequenceHarness.createServer: the backend's save rule in miniature).
 *
 *  1. A reopened draft keeps the float it was counted with: the drawer is
 *     cash_counted + cash_float, never this device's remembered float, and a
 *     note-only save files the saved float back (the reviewers' repro).
 *  3. Start forfra on a photo-only day deletes the draft only when nothing
 *     outside the tills was typed; otherwise the draft stays (the next save
 *     updates it) and the question names what stays and what goes — tips
 *     typed on step 4 included.
 *  4. "" (clear the stored photo) is sent only for a photo this page filed,
 *     or the photo of the draft the banner's "Start forfra" replaced — never
 *     for a photo another device scanned since.
 *  6. A reopened Z-bon draft edited by hand is filed as a correction of its
 *     read, not as read off the bon; a reopened sum that no longer adds up
 *     names each till's read figure and "revenue_total"; untouched, nothing.
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
const FLOAT_KEY = "bonbox.dc.cashFloat.v1";

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
const keyIn = (el, value) => {
  if (el.value !== "") fireEvent.change(el, { target: { value: "" } });
  for (const ch of value) fireEvent.change(el, { target: { value: el.value + ch } });
};
const mount = async () => {
  const view = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
  const want = S.rows.has(`${today}|`) ? "dcDayHasDraft" : "scanZReportTitle";
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
  // Round 21: "Fortsæt kladden" opens the draft as it is stored now (read by
  // id — one round trip), so the form is waited for before walking it.
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
const rowFor = (date) => S.rows.get(`${date}|`);
const posted = () => S.posts.filter((b) => b.date);

/* ─── 1 ─────────────────────────────────────────────────────────────── */

describe("1. a reopened draft keeps the float it was counted with", () => {
  const COUNTED = {
    id: "seed1", date: today, branch_id: null, status: "draft", closed_by: "Test", notes: "Test",
    revenue_total: 3000, revenue_breakdown: { food: 3000 }, payment_breakdown: { card: 1000, cash: 2000 },
    moms_mode: "auto", moms_total: 600, source_meta: { kind: "typed" }, receipt_photo: null,
    // Saved with float 1.000 and a drawer of 2.504,75.
    cash_counted: 1504.75, cash_float: 1000,
  };

  it("the reviewers' repro: saved 1.000 / 2.504,75, device float 1.500, reopened, note edited → step 3 shows 2.504,75 / 1.000 and the save files 1.000", async () => {
    localStorage.setItem(FLOAT_KEY, "1500");
    serve([COUNTED]);
    await mount();
    tap(/^dcContinueDraft$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    await toStepWith("#cash-counted");
    expect(q("#cash-counted").value).toBe("2.504,75");
    expect(q("#cash-float").value).toBe("1.000");
    await toStepWith("#dc-notes");
    // Opening it is not a save.
    expect(posted()).toHaveLength(0);
    keyIn(q("#dc-notes"), "Test 2");
    await flush();
    const body = posted().at(-1);
    expect(body.notes).toBe("Test 2");
    expect(body.cash_float).toBe(1000);
    expect(body.cash_counted).toBe(1504.75);
    expect(rowFor(today)).toMatchObject({ cash_float: 1000, cash_counted: 1504.75, notes: "Test 2" });
    // This device's own default is not touched by opening a close.
    expect(localStorage.getItem(FLOAT_KEY)).toBe("1500");
  });

  it("a close saved without a float takes this device's default", async () => {
    localStorage.setItem(FLOAT_KEY, "1500");
    serve([{ ...COUNTED, cash_counted: 980, cash_float: null }]);
    await mount();
    tap(/^dcContinueDraft$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    await toStepWith("#cash-counted");
    expect(q("#cash-float").value).toBe("1.500");
    expect(q("#cash-counted").value).toBe("2.480");
  });

  it("the owner's own float change on a reopened close is theirs: saved, and remembered on this device", async () => {
    localStorage.setItem(FLOAT_KEY, "1500");
    serve([COUNTED]);
    await mount();
    tap(/^dcContinueDraft$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    await toStepWith("#cash-float");
    keyIn(q("#cash-float"), "500");
    await flush();
    // The drawer they counted stays; the takings follow the float.
    expect(q("#cash-counted").value).toBe("2.504,75");
    expect(posted().at(-1)).toMatchObject({ cash_float: 500, cash_counted: 2004.75 });
    expect(localStorage.getItem(FLOAT_KEY)).toBe("500");
  });
});

/* ─── 3 ─────────────────────────────────────────────────────────────── */

// Round 23 (narrowing A — Manoj, 9 Oct): Start forfra is an explicit,
// confirmed DELETE of the day's draft. Round 20's rule ("never deletes what
// the owner typed beside the photo" — the draft kept, updated by the next
// save) is retired: the question now names the draft and its amount and says
// it cannot be undone; answered yes, the draft goes — count, Lukket af,
// Noter and tips with it — and the form starts over empty. Rewritten per
// test; "cancelling keeps everything" is unchanged.
describe("3. Start forfra on a photo-only day — the draft and everything typed beside the photo go, asked first", () => {
  it("cash count, Lukket af and Noter typed: the question names the draft (5.000) — answered yes, it is deleted with them, and nothing is offered on return", async () => {
    serve();
    const view = await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await toStepWith("#cash-counted");
    keyIn(q("#cash-counted"), "2.450");
    await toStepWith("#dc-notes");
    keyIn(q("#dc-closed-by"), "Test");
    keyIn(q("#dc-notes"), "Test");
    await flush();
    const id = rowFor(today).id;
    expect(rowFor(today)).toMatchObject({ revenue_total: 5000, closed_by: "Test", notes: "Test", cash_counted: 1450 });

    await backToCard();
    window.confirm.mockClear();
    tap(/^startOver$/);
    await flush();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.confirm.mock.calls[0][0]).toMatch(/^dcStartOverDeleteBody:.*\|5\.000 kr\.$/);
    expect(S.deletes).toEqual([id]);
    expect(rowFor(today)).toBeUndefined();

    view.unmount();
    await settle();
    await mount();
    expect(document.body.textContent).not.toContain("dcDayHasDraft");
    expect(document.body.textContent).toContain("scanZReportTitle");
  });

  it("the next photo after Start forfra files a NEW draft of its own figures — nothing of the deleted draft's fields", async () => {
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await toStepWith("#dc-notes");
    keyIn(q("#dc-notes"), "Test");
    await flush();
    const id = rowFor(today).id;
    await backToCard();
    tap(/^startOver$/);
    await flush();
    expect(S.deletes).toEqual([id]);
    await shoot("b3000", "bon3000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    expect(rowFor(today)).toMatchObject({
      revenue_total: 3000, notes: null, receipt_photo: photoUrl("bon3000.jpg"), source_meta: { kind: "zbon" },
    });
  });

  it("tips typed on step 4: the question names the draft (5.000); answered yes, the draft — tips with it — is deleted", async () => {
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await toStepWith("#dc-tips-total");
    keyIn(q("#dc-tips-total"), "320");
    await flush();
    expect(rowFor(today).tips_total).toBe(320);
    await backToCard();
    window.confirm.mockClear();
    tap(/^startOver$/);
    await flush();
    expect(window.confirm.mock.calls[0][0]).toMatch(/^dcStartOverDeleteBody:.*\|5\.000 kr\.$/);
    expect(S.deletes).toHaveLength(1);
    expect(rowFor(today)).toBeUndefined();
  });

  it("nothing typed beside the photo: asked too (the draft is stored) — then deleted", async () => {
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    await backToCard();
    window.confirm.mockClear();
    tap(/^startOver$/);
    await flush();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(S.deletes).toHaveLength(1);
  });

  it("cancelling the question keeps everything as it was", async () => {
    serve();
    await mount();
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await toStepWith("#dc-notes");
    keyIn(q("#dc-notes"), "Test");
    await flush();
    await backToCard();
    window.confirm.mockImplementation(() => false);
    tap(/^startOver$/);
    await flush();
    expect(q('[data-testid="dc-scan-result-date"]')).not.toBeNull();
    expect(S.deletes).toEqual([]);
    expect(rowFor(today)).toMatchObject({ revenue_total: 5000, notes: "Test", receipt_photo: photoUrl("bon5000.jpg") });
  });
});

/* ─── 4 ─────────────────────────────────────────────────────────────── */

// Round 23: Start forfra deletes the day's draft (its photo with it) and the
// banner's Start forfra deletes the draft it was tapped on — so the close
// typed next is a NEW row with no photo to clear, and "" is never sent for
// one. The rule held (a "" never clears another device's photo) is unchanged.
describe("4. \"\" clears only a photo this page filed", () => {
  it("another device's photo, scanned on the close typed after Start forfra, is never cleared", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "14000");
    await flush();
    await backToCard();
    await shoot("b3000", "bon3000.jpg");
    tap(/^scanSecondTotalSum/);
    tap(/^continueStepByStep$/);
    await flush();
    expect(rowFor(today).receipt_photo).toBe(photoUrl("bon3000.jpg"));
    await backToCard();
    tap(/^startOver$/);
    await flush();
    // The draft — its photo with it — is deleted.
    expect(S.deletes).toHaveLength(1);
    expect(rowFor(today)).toBeUndefined();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "14000");
    await flush();
    expect(posted().at(-1).receipt_photo).toBeNull();
    expect(rowFor(today).receipt_photo).toBeNull();
    // Another device scans the day.
    rowFor(today).receipt_photo = "u1/kasserapport/other-device.jpg";
    keyIn(q("#dc-rev-drinks"), "500");
    await flush();
    expect(posted().at(-1).receipt_photo).toBeNull();
    expect(rowFor(today).receipt_photo).toBe("u1/kasserapport/other-device.jpg");
  });

  it("the draft the banner's \"Start forfra\" was tapped on is deleted — its photo with it; the close typed next has none", async () => {
    serve([{
      id: "seed1", date: today, branch_id: null, status: "draft", closed_by: null, notes: null,
      revenue_total: 17030, revenue_breakdown: { food: 17030 }, payment_breakdown: { card: 17030 },
      moms_mode: "manual", moms_total: 3406, source_meta: { kind: "zbon", scans: 1, corrected: [] },
      receipt_photo: "u1/kasserapport/old-draft.jpg",
    }]);
    await mount();
    tap(/^dcStartOverDraft$/);
    await flush();
    expect(S.deletes).toEqual(["seed1"]);
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "9000");
    await flush();
    expect(posted().at(-1).receipt_photo).toBeNull();
    expect(rowFor(today)).toMatchObject({ revenue_total: 9000, receipt_photo: null });
  });
});

/* ─── 6 ─────────────────────────────────────────────────────────────── */

describe("6. a reopened Z-bon draft edited by hand is filed as a correction of its read", () => {
  const ZBON = {
    id: "seed1", date: today, branch_id: null, status: "draft", closed_by: null, notes: null,
    revenue_total: 11250, revenue_breakdown: { food: 7000, drinks: 4250 }, payment_breakdown: { card: 11250 },
    moms_mode: "manual", moms_total: 2250, source_meta: { kind: "zbon", scans: 1, corrected: [] },
    receipt_photo: "u1/kasserapport/own.jpg",
  };

  // The sequences lane's repro: Fortsæt kladden → retype Mad one key at a time.
  it("Mad 7.000 → 15.750: the record keeps its read and names the correction; back to 7.000: no correction left", async () => {
    serve([ZBON]);
    await mount();
    tap(/^dcContinueDraft$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "15750");
    await flush();
    expect(posted().at(-1).source_meta).toMatchObject({ kind: "zbon", scans: 1, corrected: ["rev:food"] });
    expect(rowFor(today).source_meta).toMatchObject({ kind: "zbon", corrected: ["rev:food"] });
    expect(rowFor(today).receipt_photo).toBe("u1/kasserapport/own.jpg");
    // Put back as it was read: the correction goes from the record too.
    keyIn(q("#dc-rev-food"), "7000");
    await flush();
    expect(rowFor(today).source_meta).toMatchObject({ kind: "zbon", corrected: [] });
  });

  it("opened and left untouched: nothing is sent", async () => {
    serve([ZBON]);
    await mount();
    tap(/^dcContinueDraft$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    await toStepWith("#dc-notes");
    await flush();
    expect(posted()).toHaveLength(0);
  });

  it("a note edited only: the read stays as it was (no line corrected)", async () => {
    serve([ZBON]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-notes");
    keyIn(q("#dc-notes"), "x");
    await flush();
    expect(posted().at(-1).source_meta).toBeNull();
    expect(rowFor(today).source_meta).toEqual({ kind: "zbon", scans: 1, corrected: [] });
  });

  // The summed variant: tills [10.000 (typed), 4.000], Mad 10.000 → 12.000.
  it("a reopened sum edited by hand: each till's read figure and \"rettet af ejeren til 16.000\" on the record", async () => {
    serve([{
      ...ZBON, revenue_total: 14000, revenue_breakdown: { food: 10000, drinks: 4000 }, payment_breakdown: { card: 14000 },
      moms_total: 2800, source_meta: { kind: "zbon", scans: 1, terminal_totals: [10000, 4000], typed_tills: [0], corrected: [] },
    }]);
    await mount();
    tap(/^dcContinueDraft$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "12000");
    await flush();
    const meta = posted().at(-1).source_meta;
    expect(rowFor(today).revenue_total).toBe(16000);
    expect(meta).toMatchObject({ kind: "zbon", typed_tills: [0], read_totals: [10000, 4000] });
    // The list adds up to what is saved (the server drops one that does not)…
    expect(meta.terminal_totals.reduce((a, v) => a + v, 0)).toBe(16000);
    expect(meta.terminal_totals).toEqual([12000, 4000]);
    // …and the total is the owner's, said with the line changed.
    expect(meta.corrected).toEqual(expect.arrayContaining(["rev:food", "revenue_total"]));
  });
});
