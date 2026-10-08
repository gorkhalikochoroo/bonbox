/**
 * Locking a PAST day ends on a dated "locked" answer — and tonight stays open.
 *
 * The round-10 fix ("a past day doesn't lock tonight") was right that a
 * back-filled 1 June must not hide tonight's "Luk dagen". But it dropped the
 * confirmation altogether: the lock landed on History's top with today's live
 * cards and "Luk dagen", and no word that 1 June had just been locked.
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
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const daysBefore = (n) => {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - n);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

beforeEach(() => {
  window.scrollTo = () => {};
  localStorage.clear();
  get.mockReset();
  post.mockReset();
  get.mockImplementation(() => Promise.resolve({ data: [] }));
  post.mockImplementation((url, body) => {
    if (url === "/daily-close" && body?.status === "confirmed") {
      return Promise.resolve({ data: {
        id: "c1", status: "confirmed", date: body.date, revenue_total: 1234.5,
        closed_by: "Test", closed_at: "2026-10-07T05:20:00",
        close_ritual: { email_status: "sent", sent_to: ["revisor@example.dk"] },
      } });
    }
    return Promise.resolve({ data: {} });
  });
});

const tapNext = () => {
  const btn = screen.getAllByRole("button").find((b) => /^next\s/.test(b.textContent));
  if (btn) fireEvent.click(btn);
  return !!btn;
};

describe("daily close — locking a past day", () => {
  it("says which day is locked, and leaves tonight's Luk dagen in place", async () => {
    const past = daysBefore(5);
    const { container } = render(
      <MemoryRouter initialEntries={[`/daily-close?date=${past}`]}>
        <DailyClosePage />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByText("skipEnterManually"));
    await waitFor(() => expect(container.querySelector("#dc-rev-food")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-rev-food"), { target: { value: "1234,50" } });
    tapNext();
    await waitFor(() => expect(container.querySelector("#dc-pay-card")).not.toBeNull());
    fireEvent.change(container.querySelector("#dc-pay-card"), { target: { value: "1234,50" } });
    for (let i = 0; i < 4 && !screen.queryByText("confirmAndLock"); i++) {
      tapNext();
      await new Promise((r) => setTimeout(r, 0));
    }
    fireEvent.click(await screen.findByText("confirmAndLock"));

    const title = await screen.findByText(/^dcPastDayLockedTitleAmount:/);
    // Named by its date (full year), with the amount, the time and who.
    expect(title.textContent).toContain("1.234,50 kr.");
    const [y, , d] = past.split("-");
    expect(title.textContent).toMatch(new RegExp(`:${parseInt(d, 10)}\\.? `));
    expect(title.textContent).toContain(y);
    expect(title.textContent).toContain("Test");
    // The email line of the same card — said once (round 19): the status
    // line names who got it, and the plain "Sendt til …" no longer repeats it.
    expect(container.textContent).toMatch(/dcMailOwnerOnly(NoRevisor|DemoRevisor)?:/);
    expect(screen.queryByText(/closeLockedEmailSent/)).toBeNull();
    // Tonight is not done: its "Luk dagen" is still offered, and the card
    // never claims tonight's kasserapport is locked.
    expect(screen.getByText("closeTheDayCta")).toBeInTheDocument();
    expect(screen.queryByText(/^closeLockedTitle:/)).toBeNull();
  });
});
