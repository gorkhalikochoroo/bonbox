/**
 * After the FIRST locked kasserapport, the page points onward.
 *
 * First-15 walk (12 Oct 2026): "Du er klar" is the only screen built to invite
 * staff, and its primary button ("Lav din første kasserapport") leaves it for
 * good. Once the close was locked, the card offered only "Send igen", the bank
 * drop and "Send til revisor" — nothing to the schedule or reservations, which
 * the owner then had to dig out of "Mere" (and which fits 0 of 51 venues ever
 * having a staff link opened). The same walk saw the live tiles directly under
 * "låst · 7.000 kr." say "I dag indtil nu 0 kr. · Ingen salg endnu i dag".
 *
 * Strings are asserted by key (t echoes the key plus its values).
 */
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { businessTodayIso } from "../utils/dateFormat";
import { DEFAULT_CLOSE_CUTOFF_HOUR } from "../utils/dailyCloseDay";

const get = vi.fn();
vi.mock("../services/api", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(() => Promise.resolve({ data: {} })), patch: vi.fn() },
}));
let BUSINESS_TYPE = "cafe";
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { currency: "DKK", business_type: BUSINESS_TYPE, business_name: "Café Solsikke", role: "owner" }, refreshUser: vi.fn() }),
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
  useBranch: () => ({ branchId: null, branchType: null, hasMultiBranch: false }),
}));
vi.mock("../components/LiveKpisToday", () => ({ default: () => <div data-testid="live-kpis" /> }));
vi.mock("../utils/resizeImage", () => ({ resizeImageIfLarge: async (f) => f }));

const DailyClosePage = (await import("../pages/DailyClosePage")).default;

const today = businessTodayIso(DEFAULT_CLOSE_CUTOFF_HOUR);
const dayBefore = (() => {
  const d = new Date(`${today}T12:00:00`);
  d.setDate(d.getDate() - 1);
  const pad = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
})();
const close = (id, date) => ({
  id, status: "confirmed", date, revenue_total: 7000, closed_at: "2026-10-11T22:10:00",
  email_status: null, email_sent_to: [],
});

let HISTORY = [];
beforeEach(() => {
  window.scrollTo = () => {};
  localStorage.clear();
  BUSINESS_TYPE = "cafe";
  HISTORY = [close("c1", today)];
  get.mockReset();
  get.mockImplementation((url) => Promise.resolve({ data: url === "/daily-close" ? HISTORY : [] }));
});

function mount(state) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: "/daily-close", state }]}>
      <DailyClosePage />
    </MemoryRouter>,
  );
}

describe("the first locked kasserapport points onward", () => {
  it("offers the schedule (with the staff invite) and reservations", async () => {
    mount();
    const steps = await screen.findByTestId("close-next-steps");
    expect(steps.textContent).toContain("closeNextStepsTitle");
    const hrefs = [...steps.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/staff/schedule", "/reservations"]);
  });

  it("is not shown from the second close on", async () => {
    HISTORY = [close("c1", today), close("c0", dayBefore)];
    mount();
    await screen.findByText(/closeLockedTitle|dcCloseLockedTitle|LockedTitle/);
    expect(screen.queryByTestId("close-next-steps")).toBeNull();
  });

  it("is shown when the owner came from 'Du er klar', however many closes exist", async () => {
    HISTORY = [close("c1", today), close("c0", dayBefore)];
    mount({ fromFirstSteps: true });
    expect(await screen.findByTestId("close-next-steps")).toBeInTheDocument();
  });

  it("never sends a shop to a reservation book", async () => {
    BUSINESS_TYPE = "retail";
    mount();
    const steps = await screen.findByTestId("close-next-steps");
    const hrefs = [...steps.querySelectorAll("a")].map((a) => a.getAttribute("href"));
    expect(hrefs).toEqual(["/staff/schedule"]);
  });
});

describe("the live tiles do not contradict a locked day", () => {
  it("are left out of the close tab once today is locked", async () => {
    mount();
    await screen.findByTestId("close-next-steps");
    expect(screen.queryByTestId("live-kpis")).toBeNull();
  });

  it("are still there while the day is open", async () => {
    HISTORY = [close("c0", dayBefore)];
    mount();
    await waitFor(() => expect(screen.getAllByTestId("live-kpis").length).toBeGreaterThan(0));
  });
});
