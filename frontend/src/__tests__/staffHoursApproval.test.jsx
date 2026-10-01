/**
 * Approving a period's hours, and correcting a shift as times.
 *
 * The Hours hub promised that the owner "godkender timer" and had no way to do
 * it. The per-person view now says how many entries are approved, approves
 * the whole period in one action (asked first), refuses while shifts still
 * need an answer, and offers an undo once approved.
 *
 * A clocked shift is corrected AS start / end / break, so the working-time
 * register keeps the right in/out — it could only be corrected as a total,
 * which left the old times behind.
 *
 * t() is mocked to return the KEY, so these assertions are about which
 * sentence is shown, not how it is phrased.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, role: "owner", currency: "DKK" }, loading: false }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({ t: (k) => k, lang: "da", setLang: () => {}, LANGUAGES: [] }),
}));
// The app's one confirm dialog — answered "yes" here.
const confirmMock = vi.fn(async () => true);
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => confirmMock }));

import api from "../services/api";
import StaffHoursPage from "../pages/StaffHoursPage";

const PERIOD = { period_type: "monthly_1st", start_date: "2026-09-01", end_date: "2026-09-30" };
const OVERVIEW = { has_any_hours: true, hours: { actual_total: 18, scheduled_total: 18 }, period: { is_complete: true }, cost: {}, labor: {}, flags: {} };

const row = (over) => ({
  staff_id: "s-1", staff_name: "Agnes", actual_hours: 8, scheduled_hours: 8, hourly_rate: 150,
  earned: 1200, tips: 0, total: 1200, work_limit: null, worst_state: "matched",
  needs_answer_count: 0, exceptions: [], entries_count: 2, approved_count: 0, period_approved_count: 0,
  ...over,
});

function mountPage({ summary, entries = [] }) {
  api.get.mockImplementation((url) => {
    if (url === "/staff/members") return Promise.resolve({ data: [{ id: "s-1", name: "Agnes" }] });
    if (url === "/staff/pay-period/current") return Promise.resolve({ data: PERIOD });
    if (url === "/staff/hours/summary") return Promise.resolve({ data: summary });
    if (url === "/staff/hours/overview") return Promise.resolve({ data: OVERVIEW });
    if (url === "/staff/hours") return Promise.resolve({ data: entries });
    return Promise.resolve({ data: null });
  });
  api.post.mockResolvedValue({ data: { approved: 2, already: 0, rows: 2 } });
  api.put.mockResolvedValue({ data: {} });
  return render(<MemoryRouter><StaffHoursPage /></MemoryRouter>);
}

const openPerStaff = async () => {
  fireEvent.click(await screen.findByRole("tab", { name: /hovTabPerStaff/ }));
};

beforeEach(() => {
  api.get.mockReset(); api.post.mockReset(); api.put.mockReset();
  confirmMock.mockClear();
});

describe("approving the period", () => {
  it("approves the whole period in one action, asked first", async () => {
    mountPage({ summary: [row()] });
    await openPerStaff();
    fireEvent.click(await screen.findByRole("button", { name: /shpApprovePeriod/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/staff/hours/approve", { from: "2026-09-01", to: "2026-09-30" }));
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it("refuses while shifts still need an answer, and says so", async () => {
    mountPage({ summary: [row({ needs_answer_count: 3 })] });
    await openPerStaff();
    const btn = await screen.findByRole("button", { name: /shpApprovePeriod/ });
    expect(btn).toBeDisabled();
    expect(screen.getByText("shpApproveAnswerFirst")).toBeInTheDocument();
  });

  it("an approved period offers the undo, not the approve", async () => {
    mountPage({ summary: [row({ approved_count: 2, period_approved_count: 2 })] });
    await openPerStaff();
    fireEvent.click(await screen.findByRole("button", { name: /shpUnapproveCta/ }));
    await waitFor(() => expect(api.post).toHaveBeenCalledWith("/staff/hours/unapprove", { from: "2026-09-01", to: "2026-09-30" }));
    expect(screen.queryByRole("button", { name: /shpApprovePeriod/ })).not.toBeInTheDocument();
  });
});

describe("correcting a clocked shift", () => {
  it("edits start, end and break, and sends the times", async () => {
    mountPage({
      summary: [row()],
      entries: [{ id: "h-1", staff_id: "s-1", staff_name: "Agnes", date: "2026-09-12", start_time: "16:00", end_time: "23:00", break_minutes: 45, total_hours: 6.25, entry_method: "clock", earned: 937.5 }],
    });
    await openPerStaff();
    fireEvent.click(await screen.findByRole("button", { name: "editHours" }));
    const [start, end] = await screen.findAllByDisplayValue(/:\d\d/);
    expect(start.value).toBe("16:00");
    fireEvent.change(end, { target: { value: "23:15" } });
    fireEvent.click(screen.getByRole("button", { name: "save" }));
    await waitFor(() => expect(api.put).toHaveBeenCalledWith("/staff/hours/h-1", { start_time: "16:00", end_time: "23:15", break_minutes: 45 }));
  });
});
