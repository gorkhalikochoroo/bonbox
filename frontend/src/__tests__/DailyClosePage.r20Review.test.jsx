/**
 * Round 20 review fixes — held to the STORED row
 * (closeSequenceHarness.createServer: the backend's save rule in miniature).
 *
 *  A. A branch day held by a deleted, LOCKED kasserapport (423
 *     deleted_locked_close) is not "already locked — unlock it from
 *     History": the wizard says what it is, in the server's words, and the
 *     autosave stops knocking.
 *  B. A Z-report's own prefill (the drawer its denomination count set, the
 *     per-clerk lines and read notes it appended) is the photo's, not the
 *     owner's: Start forfra deletes the photo's draft in one tap, as before
 *     round 20, and takes the prefill away with the photo.
 *  C. Start forfra while the day's first save is still on its way: the draft
 *     holding what the owner typed beside the photo is kept.
 *  D. A MOMS typed on a reopened Z-bon read (not the MOMS it was opened
 *     with) is the owner's — "moms" in `typed` — never "aflæst fra Z-bon".
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

const shootWith = async (key, name, extra) => {
  S.nextScan = { ...BONS[key], ...extra, image_url: photoUrl(name) };
  const input = [...document.querySelectorAll('input[type="file"]')].at(-1);
  fireEvent.change(input, { target: { files: [new File([name], name, { type: "image/jpeg", lastModified: 1 })] } });
  await waitFor(() => expect(q('[data-testid="dc-scan-result-date"]')).not.toBeNull());
};

/* ─── A ─────────────────────────────────────────────────────────────── */

describe("A. a day held by a deleted, locked kasserapport", () => {
  const SAID = "Der ligger en slettet, låst kasserapport for denne dag og afdeling. Den bevares (bogføringsloven) og kan ikke overskrives — kontakt support.";
  const refuse = () => Object.assign(new Error("423"), {
    response: { status: 423, data: { detail: { code: "deleted_locked_close", message: SAID } } },
  });

  it("the autosave is refused: said on the wizard in the server's words, no more knocking; Lock names the real reason, not History", async () => {
    serve();
    const pass = post.getMockImplementation();
    let refused = 0;
    post.mockImplementation((url, body) => {
      if (url === "/daily-close") { refused += 1; return Promise.reject(refuse()); }
      return pass(url, body);
    });
    await mount();
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "1234");
    await flush();
    expect(refused).toBe(1);
    const banner = q('[data-testid="dc-deleted-locked"]');
    expect(banner).not.toBeNull();
    expect(banner.textContent).toContain("dcDeletedLockedClose");
    expect(banner.textContent).toContain("kontakt support");
    // Not the lock's "unlock it from History" — there is nothing to unlock.
    expect(document.body.textContent).not.toMatch(/dcDayLockedNoAmount|dcDayAlreadyLockedBody/);
    // Further edits do not knock again.
    keyIn(q("#dc-rev-food"), "1300");
    await flush();
    expect(refused).toBe(1);

    await toStepWith("#dc-pay-card");
    keyIn(q("#dc-pay-card"), "1300");
    await toStepWith("#dc-notes");
    tap(/^confirmAndLock$/);
    await flush();
    expect(refused).toBe(2);
    expect(document.body.textContent).toContain("dcDeletedLockedClose");
    expect(document.body.textContent).toContain("kontakt support");
    expect(document.body.textContent).not.toMatch(/dcDayLockedNoAmount|dcDayAlreadyLockedBody|dcLockFailed/);
    // The figures are still on screen.
    expect(document.body.textContent).toContain("1.300");
  });
});

/* ─── B ─────────────────────────────────────────────────────────────── */

describe("B. a Z-report's own prefill is the photo's, not the owner's", () => {
  // The reviewers' repro: a Z-bon whose read carries a denomination count,
  // per-clerk lines and an ambiguity note, applied step by step, back to the
  // card, Start forfra — the owner typed nothing.
  const PF = {
    prefill: { cash_drawer: { counted_total: 2450 }, per_clerk_notes: "Pr. ekspedient: Anna: 5000.00 kr" },
    claude_notes: "To mulige aflæsninger af Kort",
  };

  // Round 23 (A): asked first — the draft is stored — then deleted; the
  // photo's count and notes go with it (unchanged).
  it("Start forfra deletes the photo's draft (asked, naming 5.000), and the count and notes go with the photo", async () => {
    serve();
    await mount();
    await shootWith("b5000", "z.jpg", PF);
    tap(/^continueStepByStep$/);
    await flush();
    const id = rowFor(today).id;
    expect(rowFor(today).notes).toContain("Anna");
    expect(rowFor(today).notes).toContain("To mulige aflæsninger");
    expect(rowFor(today).cash_counted).not.toBeNull();

    await backToCard();
    window.confirm.mockClear();
    tap(/^startOver$/);
    await flush();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.confirm.mock.calls[0][0]).toMatch(/^dcStartOverDeleteBody:.*\|5\.000 kr\.$/);
    expect(S.deletes).toEqual([id]);
    expect(rowFor(today)).toBeUndefined();

    // The thrown-away photo's count and notes are not filed with the next
    // figures typed.
    tap(/^skipEnterManually$/);
    await waitFor(() => expect(q("#dc-rev-food")).not.toBeNull());
    keyIn(q("#dc-rev-food"), "1000");
    await flush();
    const body = posted().at(-1);
    expect(body.notes).toBeNull();
    expect(body.cash_counted).toBeNull();
  });

  // Round 23 (A, expectation changed): what the owner typed beside the
  // prefill no longer keeps the draft — Start forfra is the owner's explicit
  // choice to delete it (the question names the draft and its amount), and
  // the form starts over empty.
  it("a note line added and a recount beside the prefill: the question names the draft (5.000); answered yes, it is deleted and the form starts empty", async () => {
    serve();
    await mount();
    await shootWith("b5000", "z.jpg", PF);
    tap(/^continueStepByStep$/);
    await toStepWith("#cash-counted");
    keyIn(q("#cash-counted"), "2.500");
    await toStepWith("#dc-notes");
    fireEvent.change(q("#dc-notes"), { target: { value: `${q("#dc-notes").value}\nTest` } });
    await flush();
    const id = rowFor(today).id;
    await backToCard();
    window.confirm.mockClear();
    tap(/^startOver$/);
    await flush();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.confirm.mock.calls[0][0]).toMatch(/^dcStartOverDeleteBody:.*\|5\.000 kr\.$/);
    expect(S.deletes).toEqual([id]);
    tap(/^skipEnterManually$/);
    await toStepWith("#cash-counted");
    expect(q("#cash-counted").value).toBe("");
    await toStepWith("#dc-notes");
    expect(q("#dc-notes").value).toBe("");
  });

  it("a Lukket af typed beside the prefill: the same — the draft is named and deleted", async () => {
    serve();
    await mount();
    await shootWith("b5000", "z.jpg", PF);
    tap(/^continueStepByStep$/);
    await toStepWith("#dc-notes");
    keyIn(q("#dc-closed-by"), "Test");
    await flush();
    await backToCard();
    window.confirm.mockClear();
    tap(/^startOver$/);
    await flush();
    expect(window.confirm.mock.calls[0][0]).toMatch(/^dcStartOverDeleteBody:.*\|5\.000 kr\.$/);
    expect(S.deletes).toHaveLength(1);
  });
});

/* ─── C ─────────────────────────────────────────────────────────────── */

// Round 23 (A, expectations changed): a save on its way counts as filed —
// Start forfra is asked (naming what that save files), waits for it to land,
// and then deletes the day's draft on that very version.
describe("C. Start forfra while the day's first save is still on its way", () => {
  it("note typed beside the photo, the first POST held, Start forfra: asked, and once the POST lands the draft is deleted — nothing of it stays", async () => {
    serve();
    await mount();
    // A slow connection: every save waits (the scan itself goes through).
    S.holding.post = true;
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await toStepWith("#dc-notes");
    keyIn(q("#dc-notes"), "Test");
    await flush();
    expect(S.held.length).toBeGreaterThan(0);
    expect(rowFor(today)).toBeUndefined();

    await backToCard();
    window.confirm.mockClear();
    tap(/^startOver$/);
    await settle();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    expect(window.confirm.mock.calls[0][0]).toMatch(/^dcStartOverDeleteBody:.*\|5\.000 kr\.$/);
    expect(S.deletes).toEqual([]);

    S.holding.post = false;
    S.releaseHeld();
    await flush();
    expect(S.deletes).toHaveLength(1);
    expect(rowFor(today)).toBeUndefined();
  });

  it("nothing typed beside the photo, its save still on its way: asked too, and the draft goes once it lands", async () => {
    serve();
    await mount();
    S.holding.post = true;
    await shoot("b5000", "bon5000.jpg");
    tap(/^continueStepByStep$/);
    await flush();
    expect(S.held.length).toBeGreaterThan(0);
    await backToCard();
    window.confirm.mockClear();
    tap(/^startOver$/);
    await settle();
    expect(window.confirm).toHaveBeenCalledTimes(1);
    S.holding.post = false;
    S.releaseHeld();
    await flush();
    expect(S.deletes).toHaveLength(1);
    expect(rowFor(today)).toBeUndefined();
  });
});

/* ─── D ─────────────────────────────────────────────────────────────── */

describe("D. a MOMS typed on a reopened Z-bon read is the owner's", () => {
  const ZBON = {
    id: "seed1", date: today, branch_id: null, status: "draft", closed_by: null, notes: null,
    revenue_total: 15750, revenue_breakdown: { food: 15750 }, payment_breakdown: { card: 15750 },
    moms_mode: "manual", moms_total: 3150, source_meta: { kind: "zbon", scans: 1, corrected: [] },
    receipt_photo: "u1/kasserapport/own.jpg",
  };
  // The server's moms_source (kasserapport_claims.moms_source) on a row.
  const momsSource = (row) => {
    if ((row.moms_mode || "auto") !== "manual") return "auto";
    const m = row.source_meta || {};
    if (m.kind === "zbon" && ((m.typed_tills || []).length || (m.typed || []).includes("moms"))) return "typed";
    if (m.kind === "zbon" || (!m.kind && row.receipt_photo)) return "zbon";
    return "typed";
  };
  const momsBox = () => document.querySelector('input[placeholder="momsAmountPlaceholder"]');

  it("the reviewers' repro: bon MOMS 3.150, 2.900 typed on review → stored 2.900, \"indtastet\", the read kept", async () => {
    serve([ZBON]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-notes");
    expect(momsBox()).not.toBeNull();
    keyIn(momsBox(), "2.900");
    await flush();
    const body = posted().at(-1);
    expect(body).toMatchObject({ moms_mode: "manual", moms_total: 2900 });
    expect(body.source_meta).toMatchObject({ kind: "zbon", scans: 1, corrected: [] });
    expect(body.source_meta.typed).toContain("moms");
    expect(rowFor(today).moms_total).toBe(2900);
    expect(momsSource(rowFor(today))).toBe("typed");
  });

  it("the bon's own MOMS typed back (or left): nothing said typed", async () => {
    serve([ZBON]);
    await mount();
    tap(/^dcContinueDraft$/);
    await toStepWith("#dc-notes");
    keyIn(momsBox(), "3.150");
    await flush();
    const sent = posted().at(-1);
    if (sent) expect(sent.source_meta).toBeNull();
    expect(momsSource(rowFor(today))).toBe("zbon");
  });
});
