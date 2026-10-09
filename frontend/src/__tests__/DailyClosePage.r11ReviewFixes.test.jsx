/**
 * Round-11 review fixes, each pinned on the path a reviewer walked.
 *
 * - A lock the server refused (the double-check) dropped the draft save that
 *   was waiting: "Gemmer…" stayed on screen and the edit never reached the
 *   server, even after leaving.
 * - A reopened draft's MOMS stayed pinned under a corrected category: the
 *   "follows the total" rule needed a photo the reopened form no longer had.
 * - Two lock cards (tonight + a back-filled day) shared one X.
 * - A photo read for another day stayed behind and was filed on a reopened
 *   draft without one.
 * - A reopened draft's card stayed "not read" after a real photo was summed in.
 *
 * Strings are asserted by key (t echoes the key plus its values).
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";

const get = vi.fn();
const post = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), patch: vi.fn() },
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

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const daysBefore = (n) => {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

let closes = [];
let scans = [];
let lockAnswer = null;

beforeEach(() => {
  window.scrollTo = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  closes = [];
  scans = [];
  lockAnswer = null;
  window.URL.createObjectURL = () => "blob:http://localhost/preview";
  window.URL.revokeObjectURL = () => {};
  get.mockImplementation((url) => Promise.resolve({ data: url === "/daily-close" ? closes : [] }));
  post.mockImplementation((url, body) => {
    if (String(url).includes("scan")) return Promise.resolve({ data: scans.shift() });
    if (url === "/daily-close" && body?.status === "confirmed" && lockAnswer) return Promise.resolve({ data: lockAnswer(body) });
    return Promise.resolve({ data: {} });
  });
});

const closePosts = () => post.mock.calls.filter(([url]) => url === "/daily-close");
const draftPosts = () => closePosts().filter(([, b]) => b.status === "draft");
const tick = () => new Promise((r) => setTimeout(r, 0));
const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};
const toReview = async () => {
  for (let i = 0; i < 6 && !screen.queryByText("confirmAndLock"); i++) {
    tapNext();
    await tick();
  }
  await screen.findByText("confirmAndLock");
};
const shoot = (container) =>
  fireEvent.change(container.querySelector('input[type="file"]'), {
    target: { files: [new File(["x"], "kasse.jpg", { type: "image/jpeg" })] },
  });

describe("daily close — a lock that does not happen keeps the waiting draft save", () => {
  beforeEach(() => {
    closes = [{
      id: "d1", date: today, status: "draft", revenue_total: 12000,
      revenue_breakdown: { food: 12000 }, payment_breakdown: { card: 12000 },
      notes: "Test", closed_by: "Test",
    }];
    lockAnswer = () => ({ requires_confirmation: true, anomaly: { reason: "high", today_total: 12000, baseline_avg: 3000, delta_pct: 3 } });
  });
  const openDraftAndRefuseLock = async (container) => {
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("12.000"));
    await toReview();
    fireEvent.change(container.querySelector("#dc-notes"), { target: { value: "Test X" } });
    // Within the 2 s debounce.
    fireEvent.click(screen.getByText("confirmAndLock"));
    await screen.findByText("closeAnomalyCancel");
    fireEvent.click(screen.getByText("closeAnomalyCancel"));
  };

  it("the double-check, then Annuller: the edit is still saved, and Gemmer… ends", async () => {
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await openDraftAndRefuseLock(container);
    expect(screen.getByText("savingEllipsis")).toBeInTheDocument();
    await waitFor(() => expect(draftPosts()).toHaveLength(1), { timeout: 3500 });
    expect(draftPosts()[0][1]).toMatchObject({ notes: "Test X", date: today });
    await waitFor(() => expect(screen.queryByText("savingEllipsis")).toBeNull());
  });

  it("…and leaving right after sends it at once", async () => {
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await openDraftAndRefuseLock(container);
    fireEvent.click(screen.getByRole("tab", { name: "historyTab" }));
    await waitFor(() => expect(draftPosts()).toHaveLength(1), { timeout: 400 });
    expect(draftPosts()[0][1]).toMatchObject({ notes: "Test X" });
  });
});

describe("daily close — a reopened draft's MOMS and a category corrected by hand", () => {
  const seed = (moms) => {
    closes = [{
      id: "d1", date: today, status: "draft", revenue_total: 17030,
      revenue_breakdown: { food: 10000, drinks: 7030 }, payment_breakdown: { card: 12000, cash: 5030 },
      moms_mode: "manual", moms_total: moms, closed_by: "Test", notes: "Test",
    }];
  };
  const reopen = async (container) => {
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("10.000"));
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "10.100" } });
    await toReview();
  };

  it("the bon's one-rate MOMS follows the new total, and says so", async () => {
    seed(3406);
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await reopen(container);
    expect(screen.getByText(/^dcMomsDraftFollowed:3\.406 kr\.\|17\.030 kr\.\|17\.130 kr\./)).toBeInTheDocument();
    await waitFor(() => expect(draftPosts()).toHaveLength(1), { timeout: 3500 });
    expect(draftPosts()[0][1]).toMatchObject({ moms_mode: "auto", moms_total: 3426 });
  });

  it("any other MOMS stays the owner's, with a word that it belongs to the old total", async () => {
    seed(3000);
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await reopen(container);
    expect(screen.getByText(/^dcMomsDraftOtherTotal:3\.000 kr\.\|17\.030 kr\.\|17\.130 kr\./)).toBeInTheDocument();
    await waitFor(() => expect(draftPosts()).toHaveLength(1), { timeout: 3500 });
    expect(draftPosts()[0][1]).toMatchObject({ moms_mode: "manual", moms_total: 3000 });
  });
});

describe("daily close — tonight's lock card and a past day's each close themselves", () => {
  it("X on tonight's card hides tonight's card, not the past day's", async () => {
    const past = daysBefore(5);
    closes = [{
      id: "t1", date: today, status: "confirmed", revenue_total: 9000,
      closed_by: "Test", closed_at: "2026-10-07T21:00:00",
    }];
    lockAnswer = (body) => ({
      id: "c1", status: "confirmed", date: body.date, revenue_total: 1234.5,
      closed_by: "Test", closed_at: "2026-10-07T05:20:00",
      close_ritual: { email_status: "sent", sent_to: ["revisor@example.dk"] },
    });
    const { container } = render(
      <MemoryRouter initialEntries={[`/daily-close?date=${past}`]}><DailyClosePage /></MemoryRouter>,
    );
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "1234,50" } });
    tapNext();
    await waitFor(() => expect(container.querySelector("#dc-pay-card")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-pay-card"), { target: { value: "1234,50" } });
    await toReview();
    fireEvent.click(screen.getByText("confirmAndLock"));

    const pastTitle = await screen.findByText(/^dcPastDayLockedTitle(Amount)?:/);
    const tonightTitle = screen.getByText(/^closeLockedTitle:/);
    const cardOf = (el) => {
      let n = el;
      while (n && n.querySelectorAll('button[aria-label="dismiss"]').length !== 1) n = n.parentElement;
      return n;
    };
    fireEvent.click(cardOf(tonightTitle).querySelector('button[aria-label="dismiss"]'));
    await waitFor(() => expect(screen.queryByText(/^closeLockedTitle:/)).toBeNull());
    expect(pastTitle.isConnected).toBe(true);
    expect(screen.getByText(/^dcPastDayLockedTitle(Amount)?:/)).toBeInTheDocument();
  });
});

describe("daily close — a reopened draft files only its own photo", () => {
  it("a Z-bon read for tonight is not saved on another day's draft", async () => {
    const past = daysBefore(3);
    closes = [{
      id: "d2", date: past, status: "draft", revenue_total: 5000,
      revenue_breakdown: { food: 5000 }, payment_breakdown: { card: 5000 },
      closed_by: "Test", notes: "Test",
    }];
    scans = [{
      revenue: { food: 17030 }, revenue_total: 17030, payments: { card: 17030 },
      raw_text: "KASSE", ocr_available: true, image_url: "https://cdn.example/tonight.jpg",
    }];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    await waitFor(() => expect(container.querySelector('input[type="file"]')).not.toBeNull());
    shoot(container);
    await waitFor(() => expect(screen.getByText("scanResults")).toBeInTheDocument());
    fireEvent.click(screen.getByText("continueStepByStep"));
    await waitFor(() => expect(container.querySelector("#close-date")).not.toBeNull());
    // Round 23 (path changed): figures are never moved onto a day that holds
    // another draft — the question says so, and "Åbn Historik" opens it
    // there; the draft is continued from History (Rediger).
    const asked = [];
    window.confirm = (m) => { asked.push(m); return true; };
    fireEvent.change(container.querySelector("#close-date"), { target: { value: past } });
    await waitFor(() => expect(asked.length).toBe(1));
    expect(asked[0]).toMatch(/dcMoveTargetBody/);
    fireEvent.click(await screen.findByText("edit"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("5.000"));
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "5.100" } });
    fireEvent.click(screen.getByRole("tab", { name: "historyTab" }));
    // (Round 23: tonight's read stayed tonight's — it is filed for today when
    // the form is left for History; only the past draft's own save counts.)
    const pastPosts = () => draftPosts().filter(([, b]) => b.date === past);
    await waitFor(() => expect(pastPosts()).toHaveLength(1), { timeout: 400 });
    expect(pastPosts()[0][1]).toMatchObject({ date: past, receipt_photo: null });
    expect(draftPosts().filter(([, b]) => b.date !== past && b.date !== today)).toHaveLength(0);
  });
});

describe("daily close — a reopened draft's card after a real photo is summed in", () => {
  it("shows that photo's confidence and missing lines again", async () => {
    closes = [{
      id: "d1", date: today, status: "draft", revenue_total: 17030,
      revenue_breakdown: { food: 10000 }, payment_breakdown: { card: 12000, cash: 5030 },
      closed_by: "Test", notes: "Test",
    }];
    scans = [{ revenue: { food: 5000 }, revenue_total: 5000, payments: { card: 5000 }, raw_text: "TILL 2", ocr_available: true }];
    const { container } = render(<MemoryRouter><DailyClosePage /></MemoryRouter>);
    fireEvent.click(await screen.findByText("dcContinueDraft"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food").value).toBe("10.000"));
    fireEvent.click(screen.getByText("← scanZReportBack"));
    await waitFor(() => expect(container.querySelector("#scan-total")).not.toBeNull());
    expect(screen.queryByText(/^scanConfidenceLevel/)).toBeNull();

    shoot(container);
    await waitFor(() => expect(screen.getByText("scanSecondTotalTitle")).toBeInTheDocument());
    fireEvent.click(screen.getByText(/scanSecondTotalSum/));
    await waitFor(() => expect(screen.getByText("scanMergedTerminals:2")).toBeInTheDocument());
    expect(screen.getByText(/^scanConfidenceLevel/)).toBeInTheDocument();
    // The owner's own lines are not "missing" from a bon (round 16, verified):
    // what no category carries is said on the card's own "Ikke fordelt" line.
    expect(screen.queryByText("scanBadgeMissing")).toBeNull();
    expect(screen.getByText("dcUnsplitRevenue")).toBeInTheDocument();
  });
});
