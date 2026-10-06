/**
 * The Timer tab's measured fixes (Hours usability lab, 1 Oct).
 *
 * Three persona testers asked to "approve last week" scored it 2–3 of 7. These
 * lock what they hit:
 *   1. Looking is not saving — quick ranges never POST the pay period; a
 *      change to the pay period asks first; Enter applies a custom range.
 *   2. One cost number — the tile is Løn's "Samlet lønomkostning", and the
 *      per-person gross reconciles to it on both per-person views.
 *   3. A path to approval — the amber count and "Svar først" open the sheet
 *      on the first unanswered shift; a save never silently swaps the person;
 *      the clear rows can be approved now; unclocked shifts in one go.
 *   4. The forgotten clock-out sheet — editable start, a pause selector whose
 *      default says where it came from, both sent with the save.
 *   6. FORSKEL shows the signed hours.
 *
 * t() returns the key, plus the vars when there are any ("key:v1|v2"), so the
 * assertions are about which sentence and which figures — not the phrasing.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, role: "owner", currency: "DKK" }, loading: false }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, fb, vars) => {
      const v = fb && typeof fb === "object" ? fb : vars;
      return v ? `${k}:${Object.values(v).join("|")}` : k;
    },
    lang: "da", setLang: () => {}, LANGUAGES: [],
  }),
}));
const confirmMock = vi.fn(async () => true);
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => confirmMock }));

import api from "../services/api";
import StaffHoursPage from "../pages/StaffHoursPage";
import { viewRange, stepUnit, stepWindow, matchViewRange } from "../utils/viewRanges";

const PERIOD = { period_type: "monthly_1st", start_date: "2026-10-01", end_date: "2026-10-31" };
const BREAKDOWN = { gross: 44317.67, feriepenge: 5539.7, atp: 189.33, total: 50046.7 };
const OVERVIEW = {
  has_any_hours: true,
  hours: { actual_total: 30, scheduled_total: 30, measured_share: 1 },
  period: { is_complete: true },
  cost: { gross: 44317.67, loaded_est: 50046.7, basis: "payroll", breakdown: BREAKDOWN, has_basis: true, unpriced_count: 0 },
  labor: {}, flags: {},
};

const row = (over) => ({
  staff_id: "s-1", staff_name: "Tilde", actual_hours: 8, scheduled_hours: 8, hourly_rate: 150,
  earned: 1200, tips: 0, total: 1200, work_limit: null, worst_state: "matched",
  needs_answer_count: 0, exceptions: [], entries_count: 2, approved_count: 0, period_approved_count: 0,
  on_payroll: true,
  ...over,
});
const FORGOT = {
  date: "2026-09-26", state: "forgot_clock_out", scheduled_hours: 5.5, actual_hours: 0,
  start_time: "16:58", scheduled_start: "17:00", scheduled_end: "23:00", scheduled_break_minutes: 30,
};
const MISSING = (date) => ({
  date, state: "no_clock_in", scheduled_hours: 6, actual_hours: 0,
  scheduled_start: "16:00", scheduled_end: "22:30", scheduled_break_minutes: 30,
});

function mountPage({ summary = [row()], overview = OVERVIEW, entries = [], url = "/staff/hours?view=details" } = {}) {
  api.get.mockImplementation((u) => {
    if (u === "/staff/members") return Promise.resolve({ data: [{ id: "s-1", name: "Tilde" }] });
    if (u === "/staff/pay-period/current") return Promise.resolve({ data: PERIOD });
    if (u === "/staff/hours/summary") return Promise.resolve({ data: summary });
    if (u === "/staff/hours/overview") return Promise.resolve({ data: overview });
    if (u === "/staff/hours") return Promise.resolve({ data: entries });
    return Promise.resolve({ data: null });
  });
  api.post.mockResolvedValue({ data: {} });
  return render(<MemoryRouter initialEntries={[url]}><StaffHoursPage /></MemoryRouter>);
}

const lastSummaryParams = () => {
  const calls = api.get.mock.calls.filter(([u]) => u === "/staff/hours/summary");
  return calls[calls.length - 1]?.[1]?.params;
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(2026, 9, 7, 12, 0));    // Wed 7 Oct 2026, midday
  api.get.mockReset(); api.post.mockReset(); api.put.mockReset();
  confirmMock.mockReset();
  confirmMock.mockImplementation(async () => true);
});
afterEach(() => { vi.useRealTimers(); });

// ── 1. Looking is not saving ─────────────────────────────────────────────

describe("view-only quick ranges", () => {
  it("computes Monday-based weeks and whole months", () => {
    expect(viewRange("thisWeek", "2026-10-07")).toEqual({ from: "2026-10-05", to: "2026-10-11" });
    expect(viewRange("lastWeek", "2026-10-07")).toEqual({ from: "2026-09-28", to: "2026-10-04" });
    expect(viewRange("lastWeek", "2026-10-04")).toEqual({ from: "2026-09-21", to: "2026-09-27" }); // a Sunday
    expect(viewRange("thisMonth", "2026-10-07")).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(viewRange("lastMonth", "2026-03-15")).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(matchViewRange("2026-09-28", "2026-10-04", "2026-10-07")).toBe("lastWeek");
  });

  it("steps a month by the month and a week by 7 days", () => {
    expect(stepUnit("2026-09-01", "2026-09-30")).toBe("month");
    expect(stepWindow("month", "2026-09-01", 1)).toEqual({ from: "2026-10-01", to: "2026-10-31" });
    expect(stepWindow("month", "2026-03-01", -1)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(stepUnit("2026-09-28", "2026-10-04")).toBe("week");
    expect(stepWindow("week", "2026-09-28", -1)).toEqual({ from: "2026-09-21", to: "2026-09-27" });
    expect(stepUnit("2026-09-03", "2026-09-10")).toBeNull();
  });

  it("'Sidste uge' shows last week and saves nothing", async () => {
    mountPage();
    fireEvent.click(await screen.findByTitle("hovFrameChange"));
    fireEvent.click(screen.getByRole("button", { name: "hovRangeLastWeek" }));
    await waitFor(() => expect(lastSummaryParams()).toEqual({ from: "2026-09-28", to: "2026-10-04" }));
    expect(api.post).not.toHaveBeenCalledWith("/staff/pay-period", expect.anything());
    expect(confirmMock).not.toHaveBeenCalled();
    // The way home says where it goes.
    expect(screen.getByRole("button", { name: "hovToCurrentPeriod" })).toBeInTheDocument();
    // Choosing closes the picker; reopened, the chip says what is showing.
    expect(screen.queryByRole("button", { name: "hovRangeLastWeek" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle("hovFrameChange"));
    expect(screen.getByRole("button", { name: "hovRangeLastWeek" })).toHaveAttribute("aria-pressed", "true");
  });

  it("changing the pay period asks first, and a no saves nothing", async () => {
    confirmMock.mockImplementation(async () => false);
    mountPage();
    fireEvent.click(await screen.findByTitle("hovFrameChange"));
    expect(screen.getByText("hovPayFrameHeading")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "hovFrameWeekly" }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(confirmMock.mock.calls[0][0].title).toBe("hovFrameConfirmTitle");
    expect(confirmMock.mock.calls[0][0].confirmLabel).toBe("hovFrameConfirmCta");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("a yes saves the pay period", async () => {
    mountPage();
    fireEvent.click(await screen.findByTitle("hovFrameChange"));
    fireEvent.click(screen.getByRole("button", { name: "hovFrameWeekly" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/staff/pay-period", { period_type: "weekly", custom_start_day: null }));
  });

  it("the saved frame is marked, and tapping it saves nothing", async () => {
    mountPage();
    fireEvent.click(await screen.findByTitle("hovFrameChange"));
    const saved = screen.getByRole("button", { name: "hovFrameMonth1" });
    expect(saved).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(saved);
    await act(async () => {});
    expect(confirmMock).not.toHaveBeenCalled();
    expect(api.post).not.toHaveBeenCalled();
  });

  it("Enter in a custom date field shows the range", async () => {
    mountPage();
    fireEvent.click(await screen.findByTitle("hovFrameChange"));
    fireEvent.click(screen.getByRole("button", { name: "hovFrameCustomRange" }));
    const from = screen.getByLabelText("hovFrameFrom");
    fireEvent.change(from, { target: { value: "2026-09-03" } });
    fireEvent.change(screen.getByLabelText("hovFrameTo"), { target: { value: "2026-09-10" } });
    // Enter in a field submits its form.
    fireEvent.submit(from.closest("form"));
    await waitFor(() => expect(lastSummaryParams()).toEqual({ from: "2026-09-03", to: "2026-09-10" }));
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ── 2. One cost number ───────────────────────────────────────────────────

describe("one cost number", () => {
  it("the Oversigt tile is Løn's total, and the people add up to it", async () => {
    mountPage({ url: "/staff/hours" });
    expect(await screen.findByText("hovTileCostTotal")).toBeInTheDocument();
    expect(screen.getByText(/50\.047 kr\./)).toBeInTheDocument();   // the tile (whole kroner)
    const line = screen.getByTestId("cost-reconcile");
    expect(line.textContent).toMatch(/^hovCostReconcile:44\.317,67 kr\.\|5\.539,70 kr\.\|189,33 kr\.\|50\.046,70 kr\./);
    expect(screen.getByText("shpColGross")).toBeInTheDocument();
  });

  it("Pr. medarbejder labels the gross and reconciles it, naming who is off the payroll", async () => {
    mountPage({ summary: [row(), row({ staff_id: "s-2", staff_name: "Theo", on_payroll: false, earned: 300, total: 300 })] });
    expect(await screen.findByText("shpColGross")).toBeInTheDocument();
    const line = await screen.findByTestId("cost-reconcile");
    expect(line.textContent).toContain("hovCostReconcile:44.317,67 kr.");
    expect(line.textContent).toContain("hovCostOffPayroll:Theo");
  });

  it("without the payroll basis it keeps the honest 'excl. ATP' and no reconcile line", async () => {
    mountPage({ url: "/staff/hours", overview: { ...OVERVIEW, cost: { ...OVERVIEW.cost, basis: "estimate", breakdown: null } } });
    expect(await screen.findByText("hovTileCost")).toBeInTheDocument();
    expect(screen.queryByTestId("cost-reconcile")).toBeNull();
  });
});

// ── 3 + 4. The path to approval, and the forgotten clock-out sheet ───────

const QUEUE = [
  row({ staff_id: "s-1", staff_name: "Tilde", worst_state: "forgot_clock_out", needs_answer_count: 1, exceptions: [FORGOT] }),
  row({ staff_id: "s-2", staff_name: "Tina", worst_state: "no_clock_in", needs_answer_count: 2,
    exceptions: [MISSING("2026-09-22"), MISSING("2026-09-23")] }),
];

describe("a path to approval", () => {
  it("the amber count is a button that opens the first unanswered shift, focused", async () => {
    mountPage({ summary: QUEUE });
    fireEvent.click(await screen.findByRole("button", { name: /shpNeedsAnswer:3/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText("Tilde")).toBeInTheDocument();
    // The first field has the focus.
    expect(document.activeElement).toBe(within(dialog).getByLabelText("shpResolveStartLabel"));
  });

  it("'Svar først på de N vagter' says what is wrong and opens the sheet", async () => {
    mountPage({ summary: QUEUE });
    const btn = await screen.findByRole("button", { name: /shpApproveAnswerFirst:3/ });
    expect(btn.textContent).toContain("hovForgotOutOne · hovNoClockInN:2");
    fireEvent.click(btn);
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("the sheet sends the corrected start and the chosen pause; Enter saves", async () => {
    mountPage({ summary: QUEUE });
    fireEvent.click(await screen.findByRole("button", { name: /shpNeedsAnswer:3/ }));
    const dialog = await screen.findByRole("dialog");
    // The default pause is the planned break — and says so.
    expect(within(dialog).getByRole("button", { name: "shpPauseMin:30" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByText("shpPauseFromPlan:30")).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText("shpResolveStartLabel"), { target: { value: "17:00" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "shpPauseMin:15" }));
    expect(within(dialog).queryByText(/shpPauseFromPlan/)).toBeNull();
    fireEvent.submit(within(dialog).getByLabelText("shpResolveEndLabel").closest("form"));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/staff/hours/resolve", {
      staff_id: "s-1", date: "2026-09-26", action: "clock_out",
      end_time: "23:00", start_time: "17:00", break_minutes: 15, confirm_long: false,
    }));
  });

  it("a planned 0-minute break is the plan — not replaced by the 45-minute rule", async () => {
    const ex = { ...FORGOT, scheduled_break_minutes: 0 };
    mountPage({ summary: [row({ worst_state: "forgot_clock_out", needs_answer_count: 1, exceptions: [ex] })] });
    fireEvent.click(await screen.findByRole("button", { name: /shpNeedsAnswerOne/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "shpPauseMin:0" })).toHaveAttribute("aria-pressed", "true");
  });

  it("without a planned break the pause defaults to the DK rule, said in one line", async () => {
    const ex = { ...FORGOT, scheduled_break_minutes: null };
    mountPage({ summary: [row({ worst_state: "forgot_clock_out", needs_answer_count: 1, exceptions: [ex] })] });
    fireEvent.click(await screen.findByRole("button", { name: /shpNeedsAnswerOne/ }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByRole("button", { name: "shpPauseMin:45" })).toHaveAttribute("aria-pressed", "true");
    expect(within(dialog).getByText("shpPauseFromRule")).toBeInTheDocument();
  });

  it("after a save the next person is named, the save is shown, and a double tap is ignored", async () => {
    api.post.mockResolvedValue({ data: { start_time: "16:58", end_time: "23:00", total_hours: 5.53 } });
    mountPage({ summary: QUEUE });
    fireEvent.click(await screen.findByRole("button", { name: /shpNeedsAnswer:3/ }));
    let dialog = await screen.findByRole("dialog");
    fireEvent.submit(within(dialog).getByLabelText("shpResolveEndLabel").closest("form"));
    await waitFor(() => expect(screen.getByText(/^shpSavedLine:Tilde\|16:58–23:00 · 5,53 t/)).toBeInTheDocument(), { timeout: 4000 });
    dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("shpNextLabel")).toBeInTheDocument();
    expect(within(dialog).getByText("Tina")).toBeInTheDocument();
    expect(within(dialog).getByText("shpResolvePos:2|3")).toBeInTheDocument();
    // The same tap again, at once, on the next person's primary: ignored.
    const posts = api.post.mock.calls.length;
    fireEvent.click(within(dialog).getByRole("button", { name: /shpResolveAsPlanned/ }));
    await act(async () => {});
    expect(api.post.mock.calls.length).toBe(posts);
    // A deliberate tap a moment later is an answer.
    vi.setSystemTime(new Date(Date.now() + 700));
    fireEvent.click(within(dialog).getByRole("button", { name: /shpResolveAsPlanned/ }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith("/staff/hours/resolve", {
      staff_id: "s-2", date: "2026-09-22", action: "as_planned",
    }), { timeout: 4000 });
  });

  it("when the queue is done it says so and offers the approval there", async () => {
    mountPage({ summary: [QUEUE[0]] });
    fireEvent.click(await screen.findByRole("button", { name: /shpNeedsAnswerOne/ }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.submit(within(dialog).getByLabelText("shpResolveEndLabel").closest("form"));
    expect(await screen.findByText("shpQueueDoneTitle")).toBeInTheDocument();
    fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "shpApprovePeriod" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/staff/hours/approve", { from: "2026-10-01", to: "2026-10-31" }));
  });

  it("Esc closes the sheet and the focus goes back to the button that opened it", async () => {
    mountPage({ summary: QUEUE });
    const chip = await screen.findByRole("button", { name: /shpNeedsAnswer:3/ });
    chip.focus();
    fireEvent.click(chip);
    await screen.findByRole("dialog");
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(chip));
  });

  it("'Godkend de klare nu' approves the closed rows and leaves the open ones", async () => {
    api.post.mockResolvedValue({ data: { approved: 3, already: 0, rows: 4, skipped_open: 1 } });
    mountPage({ summary: [
      row({ entries_count: 3 }),
      row({ staff_id: "s-2", staff_name: "Tina", worst_state: "forgot_clock_out", needs_answer_count: 1, exceptions: [FORGOT], entries_count: 1 }),
    ] });
    fireEvent.click(await screen.findByRole("button", { name: "shpApproveClearCta" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/staff/hours/approve", { from: "2026-10-01", to: "2026-10-31", skip_open: true }));
    // Said before: how many, and what waits.
    expect(confirmMock.mock.calls[0][0].message).toBe("shpApproveClearBody:3|hovForgotOutOne");
    // And after.
    expect(await screen.findByText(/shpApprovedClearDone:3\|hovForgotOutOne/)).toBeInTheDocument();
    // The full approval still waits for the answer.
    expect(screen.getByRole("button", { name: "shpApprovePeriod" })).toBeDisabled();
  });

  it("'Alle uden stempling: som planlagt' lists the shifts, then answers each", async () => {
    mountPage({ summary: QUEUE });
    fireEvent.click(await screen.findByRole("button", { name: "shpBulkPlannedBtn" }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    const { title, message } = confirmMock.mock.calls[0][0];
    expect(title).toBe("shpBulkPlannedTitle:2");
    const { container } = render(<div>{message}</div>);
    expect(container.textContent).toMatch(/Tina · 22\.? sep\w*\.? · 16:00–22:30/i);
    expect(container.textContent).toMatch(/Tina · 23\.? sep\w*\.? · 16:00–22:30/i);
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    expect(api.post).toHaveBeenCalledWith("/staff/hours/resolve", { staff_id: "s-2", date: "2026-09-22", action: "as_planned" });
    expect(api.post).toHaveBeenCalledWith("/staff/hours/resolve", { staff_id: "s-2", date: "2026-09-23", action: "as_planned" });
    expect(await screen.findByText("shpBulkPlannedDone:2")).toBeInTheDocument();
  });

  it("a no to the bulk confirm answers nothing", async () => {
    confirmMock.mockImplementation(async () => false);
    mountPage({ summary: QUEUE });
    fireEvent.click(await screen.findByRole("button", { name: "shpBulkPlannedBtn" }));
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await act(async () => {});
    expect(api.post).not.toHaveBeenCalled();
  });
});

// ── 6. FORSKEL is a number ───────────────────────────────────────────────

describe("the difference column", () => {
  it("shows the signed hours, with the word underneath", async () => {
    mountPage({ summary: [row({ actual_hours: 8.5, scheduled_hours: 8, worst_state: "over" })] });
    // The row's cell and the footer's total — the row used to carry the word only.
    expect(await screen.findAllByText("+0,5 t")).toHaveLength(2);
    expect(screen.getByText("shpStateOver")).toBeInTheDocument();
  });

  it("the Log sub-tab is called what it is", async () => {
    mountPage();
    expect(await screen.findByRole("tab", { name: /hovTabLog/ })).toBeInTheDocument();
  });
});
