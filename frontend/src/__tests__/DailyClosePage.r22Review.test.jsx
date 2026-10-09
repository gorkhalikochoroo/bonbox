/**
 * Round 22 review — the reviewers' repros on round 22 itself, each a named
 * regression beside r22Fixes (same stubbed server: src/test/closeSequenceHarness).
 *
 *  1. A date move made OFFLINE, the page then left offline: the figures were
 *     kept on this phone as the NEW day's copy while the old day still held
 *     them — sent once online, both days held the money. Now the copy stays
 *     on the day the server already has them on (the move is not done), with
 *     the latest figures.
 *  2. Back online while the page is hidden, the form mounted after the page
 *     (any visit to History): the page's queue sync sent the offline copy
 *     before the form took it back, and the form's own save went too — the
 *     owner was asked "saved somewhere else" about their own figures, and a
 *     pending move left both days holding them. One POST now.
 *  3. A 409 answering the OLD day's save after a date move marked the NEW
 *     day locked: banner, "Ikke gemt", the moved figures never saved.
 *  4. A lost create, the banner's Start forfra over another device's draft:
 *     that draft was DELETED (not put back) when the form took its figures
 *     off the day — a replacement wins over a lost create.
 *  5. The could-not-ask take-back forgot the lost save: the next save of the
 *     day was refused against the form's own landed save.
 *  6. A day read with no last_save_id ("couldn't check" — an older backend, a
 *     failed audit query) is unknown, never "not mine": the take-back goes on
 *     the server's own check (base_save_id), and a kept draft stays the form's.
 *  7. A move finishes only on proof that the moved save landed — never on an
 *     earlier save of the form's being the new day's last.
 *  8. A take-back that could not ask (a slow read while online) is tried
 *     again on a timer, not only on an "online" event.
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
const { OQ_KEY } = await import("../utils/dailyCloseQueue");
const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const KEY = `${today}|`;
const shift = (iso, days) => { const d = new Date(`${iso}T12:00:00`); d.setDate(d.getDate() + days); return d.toISOString().slice(0, 10); };
const yesterday = shift(today, -1);

let S;
beforeEach(() => {
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = function scrollIntoView() {};
  window.confirm = vi.fn(() => true);
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  del.mockReset();
  Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => true });
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
const fire = async (name, target = window) => {
  await act(async () => { target.dispatchEvent(new Event(name)); await new Promise((r) => setTimeout(r, 0)); });
};
const flush = async () => {
  await fire("pagehide");
  for (let i = 0; i < 6; i++) await settle();
};
const keyIn = (el, value) => {
  if (el.value !== "") fireEvent.change(el, { target: { value: "" } });
  for (const ch of value) fireEvent.change(el, { target: { value: el.value + ch } });
};
const mount = async () => {
  const view = render(<MemoryRouter initialEntries={["/daily-close"]}><DailyClosePage /></MemoryRouter>);
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
const rowFor = (day = today) => S.rows.get(`${day}|`);
const text = () => document.body.textContent;
const pickDay = async (day) => {
  fireEvent.change(q("#close-date"), { target: { value: day } });
  await settle();
};
const setOnline = (on) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });
const goOffline = async () => {
  S.holding.offline = true;
  setOnline(false);
  await fire("offline");
};
const goOnline = async () => {
  S.holding.offline = false;
  setOnline(true);
  await fire("online");
  for (let i = 0; i < 8; i++) await settle();
};
const queued = () => JSON.parse(localStorage.getItem(OQ_KEY) || "[]");
const dayPosts = (day) => S.posts.filter((b) => b.date === day && b.status === "draft");
/** Another device files a draft for the day (its own row, its own save). */
const otherFiles = (day, fields) => {
  const key = `${day}|`;
  const row = {
    id: `other-${day}`, date: day, branch_id: null, status: "draft", closed_by: null, notes: "B",
    revenue_breakdown: {}, payment_breakdown: {}, moms_mode: "auto", source_meta: { kind: "typed" }, receipt_photo: null,
    is_deleted: false, ...fields,
  };
  S.bump(row);
  S.rows.set(key, row);
  S.writer.set(key, "other");
  S.lastSaveId.set(key, "other-device");
  return row;
};

/* ─── 1. a move made offline, the page left offline ─────────────────── */

describe("review 1 — a date move made offline and the page left offline never puts the figures on both days", () => {
  // Round 23 (C, expectation changed): a move confirmed offline is a move
  // the owner chose — the figures go with the form to yesterday; today's
  // draft cannot be deleted offline, and the page says so ("Kopieret til …
  // står der stadig", never "Flyttet"). Left offline, the latest figures are
  // kept on this phone for the day the form is on, and today's draft stays —
  // as said. (Round 22 kept them on today instead: the owner's move undone.)
  it("answered on today, offline, \"Flyt tallene\" for yesterday, an edit, left: said \"står der stadig\"; once online yesterday holds the latest, today's draft is still there — never \"Flyttet\"", async () => {
    serve();
    try {
      const view = await mount();
      tap(/^skipEnterManually$/);
      await toStepWith("#dc-rev-food");
      keyIn(q("#dc-rev-food"), "3000");
      await flush();
      expect(rowFor()).toMatchObject({ revenue_breakdown: { food: 3000 } });
      await goOffline();
      await pickDay(yesterday);
      await settle();
      expect(text()).toContain("dcDateMovedCopied");
      expect(text()).not.toContain("dcDateMovedFrom");
      keyIn(q("#dc-rev-food"), "3500");
      view.unmount();
      for (let i = 0; i < 4; i++) await settle();
      await mount();
      await goOnline();
      expect(rowFor(yesterday)).toMatchObject({ status: "draft", revenue_breakdown: { food: 3500 } });
      expect(rowFor()).toMatchObject({ status: "draft", revenue_breakdown: { food: 3000 } });
      expect(queued()).toHaveLength(0);
    } finally {
      S.holding.offline = false;
      setOnline(true);
    }
  });

  it("offline from the start (today's save never landed): the figures are kept on this phone, on ONE day", async () => {
    serve();
    try {
      const view = await mount();
      tap(/^skipEnterManually$/);
      await toStepWith("#dc-rev-food");
      await goOffline();
      keyIn(q("#dc-rev-food"), "3000");
      await flush();
      await pickDay(yesterday);
      await settle();
      view.unmount();
      for (let i = 0; i < 4; i++) await settle();
      expect(queued()).toHaveLength(1);
      await mount();
      await goOnline();
      const held = [rowFor(), rowFor(yesterday)].filter(Boolean);
      expect(held).toHaveLength(1);
      expect(held[0]).toMatchObject({ status: "draft", revenue_breakdown: { food: 3000 } });
    } finally {
      S.holding.offline = false;
      setOnline(true);
    }
  });

  it("no move pending: the copy is still the day's own (round 22's offline copy unchanged)", async () => {
    serve();
    try {
      const view = await mount();
      tap(/^skipEnterManually$/);
      await toStepWith("#dc-rev-food");
      await goOffline();
      keyIn(q("#dc-rev-food"), "3000");
      view.unmount();
      for (let i = 0; i < 4; i++) await settle();
      expect(queued()).toHaveLength(1);
      expect(queued()[0].payload).toMatchObject({ date: today, revenue_breakdown: { food: 3000 } });
    } finally {
      S.holding.offline = false;
      setOnline(true);
    }
  });
});

/* ─── 2. online while hidden, the form mounted after the page ────────── */

describe("review 2 — back online while the page is hidden: the waiting draft is sent once", () => {
  const viaHistory = async () => {
    tap(/^historyTab$/);
    await settle();
    tap(/^newClose$/);
    await settle();
    for (let i = 0; i < 6 && !btn(/^skipEnterManually$/); i++) await settle();
  };

  it("after a visit to History: hidden offline, online while hidden — one POST, never \"saved somewhere else\"", async () => {
    serve();
    try {
      await mount();
      await viaHistory();
      tap(/^skipEnterManually$/);
      await toStepWith("#dc-rev-food");
      keyIn(q("#dc-rev-food"), "3000");
      await flush();
      await goOffline();
      const before = dayPosts(today).length;
      keyIn(q("#dc-rev-food"), "3500");
      await fire("pagehide");
      expect(queued()).toHaveLength(1);
      await goOnline();
      await fire("pageshow");
      for (let i = 0; i < 4; i++) await settle();
      expect(dayPosts(today).length - before).toBe(1);
      expect(S.refused).toHaveLength(0);
      expect(rowFor()).toMatchObject({ revenue_breakdown: { food: 3500 } });
      expect(q('[data-testid="dc-draft-changed"]')).toBeNull();
      expect(queued()).toHaveLength(0);
    } finally {
      S.holding.offline = false;
      setOnline(true);
    }
  });

  it("…with an offline \"Brug dem\" pending: the move finishes — only yesterday holds the figures", async () => {
    serve();
    try {
      await mount();
      await viaHistory();
      tap(/^skipEnterManually$/);
      await toStepWith("#dc-rev-food");
      keyIn(q("#dc-rev-food"), "3000");
      await flush();
      await goOffline();
      await pickDay(yesterday);
      await settle();
      await fire("pagehide");
      await goOnline();
      await fire("pageshow");
      for (let i = 0; i < 6; i++) await settle();
      expect(S.refused).toHaveLength(0);
      expect(rowFor()).toBeUndefined();
      expect(rowFor(yesterday)).toMatchObject({ status: "draft", revenue_breakdown: { food: 3000 } });
      expect(text()).toContain("dcDateMovedFrom");
    } finally {
      S.holding.offline = false;
      setOnline(true);
    }
  });
});

/* ─── 3. the old day's 409 after a move ─────────────────────────────── */

describe("review 3 — a 409 answering the OLD day's save never makes the new day locked", () => {
  it("a held save of today meets another device's lock after the move to yesterday: yesterday saves, no lock banner on it", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3000");
    await flush();
    S.otherLock(KEY);
    S.holding.post = true;
    keyIn(q("#dc-rev-food"), "3500");
    await fire("pagehide");
    expect(S.held).toHaveLength(1);
    await pickDay(yesterday);
    await settle();
    // Today's save arrives now: the lock (409).
    S.holding.post = false;
    await act(async () => { S.releaseHeld(); await new Promise((r) => setTimeout(r, 0)); });
    for (let i = 0; i < 4; i++) await settle();
    expect(S.lockConflicts).toBe(1);
    await flush();
    expect(rowFor(yesterday)).toMatchObject({ status: "draft", revenue_breakdown: { food: 3500 } });
    expect(text()).not.toContain("dcDayAlreadyLocked");
    expect(q('[data-testid="dc-save-slot-unsaved"]')).toBeNull();
    // Today is the other device's lock, as it locked it.
    expect(rowFor()).toMatchObject({ status: "confirmed", revenue_breakdown: { food: 3000 } });
  });
});

/* ─── 4. a lost create, then the banner's Start forfra ───────────────── */

// Round 23 (A + commit 2, rewritten): a save that got no answer is now sent
// again once online (it was dropped when the form went back to the card). So:
// over another device's draft D it meets D and ASKS ("gemt et andet sted") —
// never filed over D in silence — and Start forfra, after opening D, deletes
// exactly the version shown (asked, naming 3.000); the form's own lost create
// is answered on its re-send and is the form's own draft — no banner over it —
// and Start forfra deletes it. Nothing is replaced, so nothing is put back.
describe("review 4 — Start forfra after an earlier save got no answer", () => {
  it("lost create → another device files D → online: the re-sent draft meets D and asks; D opened, Start forfra (naming 3.000) deletes it on its version", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    // The request dies on its way: nothing stored, no answer (the browser
    // still says online).
    S.holding.offline = true;
    tap(/^continueStepByStep$/);
    await toStepWith("#dc-rev-food");
    await flush();
    await backToCard();
    await flush();
    S.holding.offline = false;
    expect(rowFor()).toBeUndefined();
    // Another device files its draft for the day.
    const D = otherFiles(today, { revenue_total: 3000, revenue_breakdown: { food: 3000 }, moms_total: 600 });
    await fire("online");
    for (let i = 0; i < 6; i++) await settle();
    // Never over D in silence: asked.
    expect(q('[data-testid="dc-draft-changed"]')).not.toBeNull();
    expect(rowFor()).toMatchObject({ id: D.id, revenue_total: 3000 });
    tap(/^dcDraftChangedReload$/);
    for (let i = 0; i < 6; i++) await settle();
    // D opened; a photo onto it, and from the card Start forfra.
    tap(/^←\s*scanZReportBack$/);
    await settle();
    await shoot("b3000", "b3000.jpg");
    if (q('[data-testid="dc-terminal-question"]')) tap(/^scanSecondTotalSum/);
    await settle();
    window.confirm = vi.fn(() => true);
    tap(/^startOver$/);
    await flush();
    expect(window.confirm.mock.calls.at(-1)[0]).toMatch(/^dcStartOverDeleteBody:.*\|3\.000 kr\.$/);
    expect(del).toHaveBeenCalledWith(`/daily-close/${D.id}`, expect.objectContaining({ params: expect.objectContaining({ base_updated_at: D.updated_at }) }));
    expect(rowFor()).toBeUndefined();
  });

  it("…the form's OWN lost create: answered on its re-send once online — the form's own draft, no banner over it — and Start forfra deletes it", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    // Stored, the answer lost: the row is the form's own.
    // Every save on the way to the card reaches the server, every answer is lost.
    S.holding.drop = true;
    tap(/^continueStepByStep$/);
    await toStepWith("#dc-rev-food");
    await flush();
    expect(rowFor()).toMatchObject({ revenue_total: 5000 });
    await backToCard();
    await flush();
    S.holding.drop = false;
    await fire("online");
    for (let i = 0; i < 6; i++) await settle();
    expect(S.refused).toHaveLength(0);
    expect(text()).not.toContain("dcDayHasDraft");
    tap(/^startOver$/);
    for (let i = 0; i < 4; i++) await settle();
    await flush();
    expect(rowFor()).toBeUndefined();
    expect(text()).not.toContain("dcDayHasDraft");
  });
});

/* ─── 5. could not ask: the lost save is not forgotten ──────────────── */

describe("review 5 — a take-back that could not ask keeps following the lost save", () => {
  it("lost save, Start forfra with the read failing, a typed figure answered: no \"saved somewhere else\"", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    // Every save on the way to the card reaches the server, every answer is lost.
    S.holding.drop = true;
    tap(/^continueStepByStep$/);
    await toStepWith("#dc-rev-food");
    await flush();
    expect(rowFor()).toMatchObject({ revenue_total: 5000 });
    await backToCard();
    await flush();
    S.holding.drop = false;
    // Every read of the day's closes fails (flaky 4G); the browser says online.
    const pass = get.getMockImplementation();
    get.mockImplementation((url, cfg) => (url === "/daily-close"
      ? Promise.reject(Object.assign(new Error("timeout"), { code: "ECONNABORTED" }))
      : pass(url, cfg)));
    // Round 23 (A, rewritten): the read fails — the server cannot be asked
    // whether the lost save is the form's — so nothing is deleted: said, and
    // nothing changes. Asked again once reads work, it is deleted; what is
    // typed next is saved with no "saved somewhere else".
    tap(/^startOver$/);
    for (let i = 0; i < 6; i++) await settle();
    expect(rowFor()).toMatchObject({ revenue_total: 5000 });
    expect(q('[data-testid="dc-start-over-failed"]')).not.toBeNull();
    get.mockImplementation(pass);
    tap(/^startOver$/);
    await flush();
    expect(rowFor()).toBeUndefined();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3000");
    await flush();
    expect(S.refused).toHaveLength(0);
    expect(q('[data-testid="dc-draft-changed"]')).toBeNull();
    expect(rowFor()).toMatchObject({ status: "draft", revenue_breakdown: { food: 3000 } });
  });
});

/* ─── 6. "couldn't check" is not "not mine" ─────────────────────────── */

describe("review 6 — a day read without last_save_id is unknown, never \"saved elsewhere\"", () => {
  const olderBackend = () => {
    const pass = get.getMockImplementation();
    get.mockImplementation(async (url, cfg) => {
      const res = await pass(url, cfg);
      if (url === "/daily-close" && cfg?.params?.with_save_id && Array.isArray(res?.data)) {
        return { data: res.data.map((r) => { const o = { ...r }; delete o.last_save_id; return o; }) };
      }
      return res;
    });
  };

  it("date move after a lost save: the old day's draft goes on the server's own check (base_save_id) — \"moved\"", async () => {
    serve();
    olderBackend();
    await mount();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3000");
    S.holding.drop = true;
    await flush();
    S.holding.drop = false;
    const sid = S.lastSaveId.get(KEY);
    await pickDay(yesterday);
    await flush();
    await flush();
    expect(del).toHaveBeenCalledTimes(1);
    expect(del.mock.calls[0][1].params.base_save_id).toBe(sid);
    expect(rowFor()).toBeUndefined();
    expect(rowFor(yesterday)).toMatchObject({ revenue_breakdown: { food: 3000 } });
    expect(text()).toContain("dcDateMovedFrom");
  });

  it("…saved on another phone since: the server refuses, the draft stays, never \"moved\"", async () => {
    serve();
    olderBackend();
    await mount();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-rev-food");
    keyIn(q("#dc-rev-food"), "3000");
    S.holding.drop = true;
    await flush();
    S.holding.drop = false;
    S.otherSave(KEY, (r) => { r.notes = "B"; });
    await pickDay(yesterday);
    await flush();
    await flush();
    expect(rowFor()).toMatchObject({ status: "draft", notes: "B" });
    expect(text()).not.toContain("dcDateMovedFrom");
    // (Round 23: "Kopieret til … står der stadig".)
    expect(text()).toContain("dcDateMovedCopied");
  });

  // Round 23 (A, expectation changed): Start forfra no longer keeps a draft
  // for a note typed beside the photo — it deletes it (asked); with the older
  // backend's read the server's own check decides, and no banner is left.
  it("Start forfra with a note typed beside the photo: the draft is deleted (the older backend's read: the server's own check) — no banner", async () => {
    serve();
    olderBackend();
    await mount();
    await shoot("b5000", "b5000.jpg");
    tap(/^continueStepByStep$/);
    await toStepWith("#dc-notes");
    keyIn(q("#dc-notes"), "Test");
    await flush();
    expect(rowFor()).toMatchObject({ revenue_total: 5000, notes: "Test" });
    await backToCard();
    tap(/^startOver$/);
    await flush();
    expect(rowFor()).toBeUndefined();
    expect(text()).not.toContain("dcDayHasDraft");
  });
});

/* ─── 7. a move finishes on proof the MOVED save landed ─────────────── */

describe("review 7 — a move finishes only when the moved save itself landed", () => {
  it("the new day holds an earlier save of the form's, the moved save never lands: the old day keeps its draft", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await toStepWith("#dc-rev-food");
    // Yesterday first (answered), then today (answered).
    await pickDay(yesterday);
    keyIn(q("#dc-rev-food"), "1000");
    await flush();
    // Emptied (nothing to file): yesterday keeps 1.000, and the next day
    // picked asks nothing.
    keyIn(q("#dc-rev-food"), "");
    await settle();
    expect(rowFor(yesterday)).toMatchObject({ revenue_breakdown: { food: 1000 } });
    await pickDay(today);
    for (let i = 0; i < 4; i++) await settle();
    keyIn(q("#dc-rev-food"), "3000");
    await flush();
    expect(rowFor()).toMatchObject({ revenue_breakdown: { food: 3000 } });
    // Today's figures moved to yesterday ("Flyt tallene" — round 23: asked,
    // and sent at once): that save dies on its way (never stored, no answer);
    // the day's read right after it answers.
    // (Round 23: the moved save is sent at once and re-sent on the way out —
    // it never lands, every time.)
    const pass = post.getMockImplementation();
    post.mockImplementation((url, body) => (url === "/daily-close" && body?.date === yesterday && body?.revenue_breakdown?.food === 3000
      ? Promise.reject(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" }))
      : pass(url, body)));
    await pickDay(yesterday);
    await settle();
    await flush();
    for (let i = 0; i < 4; i++) await settle();
    expect(rowFor(yesterday)).toMatchObject({ revenue_breakdown: { food: 1000 } });
    // Never "moved" on yesterday's older save: today still holds 3.000.
    expect(rowFor()).toMatchObject({ status: "draft", revenue_breakdown: { food: 3000 } });
    expect(text()).not.toContain("dcDateMovedFrom");
    // (Round 23: said — today still has its draft.)
    expect(text()).toContain("dcDateMovedCopied");
  });
});

/* ─── 8. a take-back that could not ask is tried again on a timer ───── */

// Round 23 (A, rewritten): no take-back is retried on its own any more (the
// automatic paths are gone). A Start forfra whose read times out deletes
// nothing, says so, and changes nothing; tapped again once reads answer, it
// deletes the draft.
describe("review 8 — a Start forfra that could not ask is not retried on its own", () => {
  it("Start forfra, the day's read times out (online): not deleted, said, no timer — tapped again, the thrown-away bon's draft is deleted", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    // Every save on the way to the card reaches the server, every answer is lost.
    S.holding.drop = true;
    tap(/^continueStepByStep$/);
    await toStepWith("#dc-rev-food");
    await flush();
    expect(rowFor()).toMatchObject({ revenue_total: 5000 });
    await backToCard();
    await flush();
    S.holding.drop = false;
    const pass = get.getMockImplementation();
    get.mockImplementation((url, cfg) => (url === "/daily-close" && cfg?.params?.with_save_id
      ? Promise.reject(Object.assign(new Error("timeout of 8000ms exceeded"), { code: "ECONNABORTED" }))
      : pass(url, cfg)));
    const timers = [];
    const real = window.setTimeout;
    const spy = vi.spyOn(window, "setTimeout").mockImplementation((fn, ms, ...rest) => {
      if (ms === 20000) { timers.push(fn); return 0; }
      return real(fn, ms, ...rest);
    });
    try {
      tap(/^startOver$/);
      for (let i = 0; i < 6; i++) await settle();
      expect(rowFor()).toMatchObject({ revenue_total: 5000 });
      expect(q('[data-testid="dc-start-over-failed"]')).not.toBeNull();
      expect(timers).toHaveLength(0);
      get.mockImplementation(pass);
      tap(/^startOver$/);
      for (let i = 0; i < 6; i++) await settle();
      expect(rowFor()).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });
});
