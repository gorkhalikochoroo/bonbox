/**
 * Round 23 — the three narrowings Manoj chose (9 Oct): cut the risky
 * combinations instead of patching them. Every check reads the stub server's
 * row (closeSequenceHarness.createServer — the backend's save and DELETE
 * rules in miniature, version checks included).
 *
 *  A. "Start forfra" is one explicit action wherever it is (the day's draft
 *     banner, the scan card): a question that names the draft, its day and
 *     its amount ("… slettes, og du starter forfra. Det kan ikke fortrydes."),
 *     then ONE version-checked delete by the server, and the form starts over
 *     empty. 412: the newer draft is kept and shown. No answer: nothing
 *     changes, and the page says so. Nothing filed: the form is simply
 *     cleared (asked only when the owner put something of their own in it).
 *  B. No scan offline: every way to a scan is gray and says why; a photo
 *     picked offline, or a scan whose connection drops, changes nothing.
 *  C. A date move with figures is asked first: "Flyt tallene til {to}?
 *     Kladden for {from} slettes." Yes: saved to the new day, then the old
 *     draft is deleted — "Flyttet fra" only once it is gone, else "Kopieret
 *     til … står der stadig" with "Slet den". No: nothing moves. A day that
 *     holds another close is never moved onto.
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
// The page's questions (useConfirm): recorded, and answered by `answer`.
const asked = [];
let answer = () => true;
vi.mock("../hooks/useConfirm", () => ({
  useConfirm: () => (o) => { asked.push(o); return Promise.resolve(answer(o)); },
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
const shiftIso = (iso, days) => {
  const d = new Date(`${iso}T12:00:00`);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};
const yesterday = shiftIso(today, -1);
const KEY = `${today}|`;
const DRAFT = {
  id: "seed1", date: today, branch_id: null, status: "draft", closed_by: "Test", notes: "Test",
  revenue_total: 14000, revenue_breakdown: { food: 9000, drinks: 5000 }, payment_breakdown: { card: 14000 },
  moms_mode: "auto", moms_total: 2800, source_meta: { kind: "typed" }, receipt_photo: null,
};

let S;
const setOnline = (on) => Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => on });
beforeEach(() => {
  window.scrollTo = () => {};
  window.scrollBy = () => {};
  Element.prototype.scrollIntoView = () => {};
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  localStorage.clear();
  setOnline(true);
  asked.length = 0;
  answer = () => true;
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
const text = () => document.body.textContent;
const settle = () => act(() => new Promise((r) => setTimeout(r, 0)));
const flush = async () => {
  await act(async () => { window.dispatchEvent(new Event("pagehide")); await new Promise((r) => setTimeout(r, 0)); });
  for (let i = 0; i < 6; i++) await settle();
};
const fire = (name) => act(async () => { window.dispatchEvent(new Event(name)); await new Promise((r) => setTimeout(r, 0)); });
const keyIn = (el, value) => {
  if (el.value !== "") fireEvent.change(el, { target: { value: "" } });
  for (const ch of value) fireEvent.change(el, { target: { value: el.value + ch } });
};
const mount = async () => {
  const view = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
  const want = S.rows.has(KEY) ? "dcDayHasDraft" : "scanZReportTitle";
  for (let i = 0; i < 10 && !text().includes(want); i++) await settle();
  return view;
};
const shoot = async (key, name) => {
  S.nextScan = { ...BONS[key], image_url: photoUrl(name) };
  const input = [...document.querySelectorAll('input[type="file"]')].at(-1);
  fireEvent.change(input, { target: { files: [new File([name], name, { type: "image/jpeg", lastModified: 1 })] } });
  for (let i = 0; i < 6; i++) await settle();
};
const backToCard = async () => {
  for (let i = 0; i < 8 && !q("#dc-rev-food"); i++) tap(/^←\s*back$/);
  tap(/^←\s*scanZReportBack$/);
  await settle();
};
const rowFor = (day = today) => S.rows.get(`${day}|`);
const typed = async (value = "14000") => {
  tap(/^skipEnterManually$/);
  await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
  keyIn(q("#dc-rev-food"), value);
  await flush();
};

/* ─── A ─────────────────────────────────────────────────────────────── */

describe("A. Start forfra — asked, then one version-checked delete by the server, and an empty form", () => {
  it("the banner: the question names the day and the amount; the server deletes that version; the page starts over empty", async () => {
    serve([DRAFT]);
    await mount();
    const shownVersion = rowFor().updated_at;
    tap(/^dcStartOverDraft$/);
    await flush();
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ title: "dcScanStartOverTitle", destructive: true, confirmLabel: "startOver" });
    expect(asked[0].message).toMatch(/^dcStartOverDeleteBody:.+\|14\.000 kr\.$/);
    expect(del).toHaveBeenCalledWith("/daily-close/seed1", { params: { base_updated_at: shownVersion } });
    expect(rowFor()).toBeUndefined();
    expect(text()).not.toContain("dcDayHasDraft");
    expect(btn(/^skipEnterManually$/)).toBeTruthy();
  });

  it("answered no: nothing is deleted and nothing changes", async () => {
    serve([DRAFT]);
    await mount();
    answer = () => false;
    tap(/^dcStartOverDraft$/);
    await flush();
    expect(del).not.toHaveBeenCalled();
    expect(rowFor()).toMatchObject({ revenue_total: 14000 });
    expect(text()).toContain("dcDayHasDraftBody:14.000 kr.");
  });

  it("412 — saved on another phone since the page showed it: never deleted; the newer draft is shown, and the form starts over empty", async () => {
    serve([DRAFT]);
    await mount();
    S.otherSave(KEY, (r) => { r.revenue_total = 15000; r.revenue_breakdown = { food: 10000, drinks: 5000 }; });
    tap(/^dcStartOverDraft$/);
    await flush();
    expect(del).toHaveBeenCalledTimes(1);
    expect(S.refusedDeletes).toHaveLength(1);
    expect(rowFor()).toMatchObject({ status: "draft", revenue_total: 15000 });
    expect(text()).toContain("dcDayHasDraftBody:15.000 kr.");
  });

  it("the card: a photo's draft filed — asked, deleted on the form's version, and the scan's start is empty", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    const stored = rowFor();
    expect(stored).toMatchObject({ revenue_total: 5000 });
    await backToCard();
    tap(/^startOver$/);
    await flush();
    expect(asked.at(-1).message).toMatch(/^dcStartOverDeleteBody:.+\|5\.000 kr\.$/);
    expect(del).toHaveBeenCalledWith(`/daily-close/${stored.id}`, { params: { base_updated_at: stored.updated_at } });
    expect(rowFor()).toBeUndefined();
    expect(q('[data-testid="dc-scan-result-date"]')).toBeNull();
    expect(text()).toContain("scanZReportTitle");
  });

  it("no answer (offline): nothing changes — the card stays, and says the draft was not deleted", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    await backToCard();
    S.holding.offline = true;
    tap(/^startOver$/);
    await flush();
    S.holding.offline = false;
    expect(rowFor()).toMatchObject({ revenue_total: 5000 });
    expect(q('[data-testid="dc-start-over-failed"]').textContent).toContain("dcStartOverNotDeletedOffline");
    expect(q('[data-testid="dc-scan-result-date"]')).not.toBeNull();
  });

  it("nothing filed: an untouched photo goes in one tap; a card the owner corrected is asked about (\"Der er ikke gemt noget endnu\")", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    tap(/^startOver$/);
    await flush();
    expect(asked).toHaveLength(0);
    expect(del).not.toHaveBeenCalled();
    expect(text()).toContain("scanZReportTitle");
    await shoot("b3000", "b3000.jpg");
    keyIn(q("#scan-total"), "3.500");
    tap(/^startOver$/);
    await flush();
    expect(asked).toHaveLength(1);
    expect(asked[0].message).toBe("dcStartOverClearBody");
    expect(del).not.toHaveBeenCalled();
    expect(S.posts).toHaveLength(0);
  });

  it("while the delete is on its way the card waits: no photo, no \"Brug disse tal\" onto a day being emptied", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    await backToCard();
    S.holding.del = true;
    tap(/^startOver$/);
    for (let i = 0; i < 4; i++) await settle();
    expect(btn(/^continueStepByStep$/).disabled).toBe(true);
    expect(btn(/^useTheseValuesJumpReview$/).disabled).toBe(true);
    expect(text()).toContain("dcStartOverDeleting");
    S.holding.del = false;
    await act(async () => { S.releaseHeld(); await new Promise((r) => setTimeout(r, 0)); });
    await flush();
    expect(rowFor()).toBeUndefined();
    expect(text()).toContain("scanZReportTitle");
  });
});

/* ─── B ─────────────────────────────────────────────────────────────── */

describe("B. no scan offline — gray, said why; typing keeps working", () => {
  it("offline: the scan's start, the card's \"+ Tilføj\" and \"← Scan Z-bon\" are gray and say why", async () => {
    serve();
    await mount();
    await shoot("b5000", "b5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    setOnline(false);
    await fire("offline");
    // On the form: "← Scan Z-bon" gray, the reason under it.
    const back = btn(/^←\s*scanZReportBack$/);
    expect(back.disabled).toBe(true);
    expect(back.getAttribute("aria-describedby")).toBe("dc-scan-offline");
    expect(q('[data-testid="dc-scan-offline"]').textContent).toContain("dcScanNeedsInternet");
    // Typing works as always: a figure typed offline waits, and is sent once online.
    keyIn(q("#dc-rev-takeaway"), "2.000");
    await flush();
    setOnline(true);
    await fire("online");
    await flush();
    expect(rowFor().revenue_breakdown.takeaway).toBe(2000);
  });

  it("the scan's start offline: Tag billede / Upload gray, the reason said; a photo picked anyway changes nothing", async () => {
    serve();
    await mount();
    setOnline(false);
    await fire("offline");
    expect(btn(/^takePhoto$/).disabled).toBe(true);
    expect(btn(/^uploadImage$/).disabled).toBe(true);
    expect(q('[data-testid="dc-scan-offline"]')).not.toBeNull();
    S.nextScan = { ...BONS.b5000, image_url: photoUrl("x.jpg") };
    const input = [...document.querySelectorAll('input[type="file"]')].at(-1);
    fireEvent.change(input, { target: { files: [new File(["x"], "x.jpg", { type: "image/jpeg" })] } });
    for (let i = 0; i < 4; i++) await settle();
    expect(post.mock.calls.filter(([u]) => String(u).includes("scan"))).toHaveLength(0);
    expect(q('[data-testid="dc-scan-result-date"]')).toBeNull();
    expect(text()).toContain("dcScanNeedsInternet");
  });

  it("a scan whose connection drops while it is read: not used — nothing on the card or in the day changes", async () => {
    serve();
    await mount();
    S.scanHold = true;
    S.nextScan = { ...BONS.b5000, image_url: photoUrl("y.jpg") };
    const input = [...document.querySelectorAll('input[type="file"]')].at(-1);
    fireEvent.change(input, { target: { files: [new File(["y"], "y.jpg", { type: "image/jpeg" })] } });
    for (let i = 0; i < 4 && !S.scanHeld; i++) await settle();
    expect(text()).toContain("readingZReport");
    setOnline(false);
    await fire("offline");
    S.scanHold = false;
    await act(async () => { S.scanHeld(); await new Promise((r) => setTimeout(r, 0)); });
    for (let i = 0; i < 4; i++) await settle();
    expect(q('[data-testid="dc-scan-result-date"]')).toBeNull();
    expect(text()).toContain("dcScanNeedsInternet");
    expect(S.posts).toHaveLength(0);
  });
});

/* ─── C ─────────────────────────────────────────────────────────────── */

describe("C. a date move with figures is asked first", () => {
  it("\"Flyt tallene til {to}? Kladden for {from} slettes.\" — yes: saved to the new day, the old draft deleted, \"Flyttet fra\"", async () => {
    serve();
    await mount();
    await typed();
    const todayRow = rowFor();
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    await flush();
    expect(asked.at(-1).title).toMatch(/^dcMoveConfirmTitle:/);
    expect(asked.at(-1).message).toMatch(/^dcMoveConfirmBody:/);
    expect(rowFor(yesterday)).toMatchObject({ revenue_total: 14000 });
    expect(del).toHaveBeenCalledWith(`/daily-close/${todayRow.id}`, { params: { base_updated_at: todayRow.updated_at } });
    expect(rowFor()).toBeUndefined();
    expect(q('[data-testid="dc-date-moved"]').textContent).toMatch(/^dcDateMovedFrom:/);
  });

  it("the old draft saved on another phone meanwhile: refused (412) — \"Kopieret til … står der stadig\", never \"Flyttet\", and no \"Slet den\" over someone else's version", async () => {
    serve();
    await mount();
    await typed();
    S.otherSave(KEY, (r) => { r.notes = "B"; });
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    await flush();
    expect(rowFor(yesterday)).toMatchObject({ revenue_total: 14000 });
    expect(rowFor()).toMatchObject({ status: "draft", notes: "B" });
    const note = q('[data-testid="dc-date-moved"]');
    expect(note.textContent).toMatch(/dcDateMovedCopied:/);
    expect(note.textContent).not.toContain("dcDateMovedFrom");
    expect(btn(/^dcDateMovedDeleteOld$/)).toBeUndefined();
  });

  it("the old draft's delete gets no answer: \"står der stadig\" with \"Slet den\" — tapped once it can, it is deleted and the line says \"Flyttet fra\"", async () => {
    serve();
    await mount();
    await typed();
    const realDel = del.getMockImplementation();
    del.mockImplementation(() => Promise.reject(Object.assign(new Error("Network Error"), { code: "ERR_NETWORK" })));
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    await flush();
    expect(rowFor()).toMatchObject({ revenue_total: 14000 });
    expect(q('[data-testid="dc-date-moved"]').textContent).toMatch(/dcDateMovedCopied:/);
    del.mockImplementation(realDel);
    tap(/^dcDateMovedDeleteOld$/);
    await flush();
    expect(rowFor()).toBeUndefined();
    expect(q('[data-testid="dc-date-moved"]').textContent).toMatch(/^dcDateMovedFrom:/);
  });

  it("answered no: the form stays on its day with its figures, nothing is filed elsewhere", async () => {
    serve();
    await mount();
    await typed();
    answer = () => false;
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    await flush();
    expect(q("#close-date").value).toBe(today);
    expect(q("#dc-rev-food").value).toBe("14000");
    expect(rowFor(yesterday)).toBeUndefined();
    expect(del).not.toHaveBeenCalled();
  });

  it("a day that holds another draft is never moved onto: said, with \"Fortsæt kladden\" as its one tap — answered \"Bliv\", the figures stay", async () => {
    serve([{ ...DRAFT, id: "y1", date: yesterday, revenue_total: 800, revenue_breakdown: { food: 800 }, payment_breakdown: { card: 800 } }]);
    await mount();
    await typed("3000");
    answer = () => false;
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    await flush();
    expect(asked.at(-1).title).toMatch(/^dcMoveTargetDraftTitle:/);
    expect(asked.at(-1).message).toMatch(/^dcMoveTargetDraftBody:/);
    expect(asked.at(-1).confirmLabel).toBe("dcContinueDraft");
    expect(q("#close-date").value).toBe(today);
    expect(rowFor(yesterday)).toMatchObject({ revenue_total: 800 });
    expect(rowFor()).toMatchObject({ revenue_total: 3000 });
  });

  // Round 23 review — the one tap restored (it had become a detour through
  // History): "Fortsæt kladden" opens that day's draft; the figures typed
  // stay with their own day, and nothing is moved onto the draft.
  it("…answered \"Fortsæt kladden\": that day's draft is open in one tap; the figures typed stay filed for their own day", async () => {
    serve([{ ...DRAFT, id: "y1", date: yesterday, revenue_total: 800, revenue_breakdown: { food: 800 }, payment_breakdown: { card: 800 } }]);
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "3000");
    // (Still waiting to be sent when the date is picked: it goes first.)
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    await flush();
    expect(asked.at(-1).confirmLabel).toBe("dcContinueDraft");
    await waitFor(() => expect(q("#close-date").value).toBe(yesterday));
    await waitFor(() => expect(q("#dc-rev-food").value).toBe("800"));
    expect(rowFor()).toMatchObject({ revenue_total: 3000 });
    expect(rowFor(yesterday)).toMatchObject({ revenue_total: 800 });
    expect(del).not.toHaveBeenCalled();
    expect(text()).not.toContain("dcDayHasDraft");
  });

  it("a day already locked: never moved onto — \"Åbn Historik\" is its one tap", async () => {
    serve([{ ...DRAFT, id: "y1", date: yesterday, status: "confirmed", revenue_total: 800, revenue_breakdown: { food: 800 }, payment_breakdown: { card: 800 } }]);
    await mount();
    await typed("3000");
    answer = () => false;
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    await flush();
    expect(asked.at(-1).title).toMatch(/^dcMoveTargetLockedTitle:/);
    expect(asked.at(-1).confirmLabel).toBe("dcOpenHistory");
    expect(q("#close-date").value).toBe(today);
    expect(rowFor()).toMatchObject({ revenue_total: 3000 });
  });

  it("nothing of the owner's on the form: no question — the date simply moves", async () => {
    serve();
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#close-date")).not.toBeNull());
    fireEvent.change(q("#close-date"), { target: { value: yesterday } });
    await flush();
    expect(asked).toHaveLength(0);
    expect(q("#close-date").value).toBe(yesterday);
  });
});
