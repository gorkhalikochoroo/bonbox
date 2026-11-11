/**
 * The owner's view of live pauses — on the REAL backend bodies.
 *
 * Contract sibling: both bodies come from fixtures/liveBreaksContract.json,
 * written by backend/tests/test_live_breaks_contract.py from the real
 * /staff/clocked-in and /staff/hours (owner_clocked_in_on_break,
 * owner_hours_after_out). The scenario ends with a pause the staffer never
 * ended, so clock-out had to — which the owner must be able to SEE.
 *
 *   • The "clocked in now" strip says who is on a pause, and since when.
 *   • An hours row says whether the paid break is what was measured or the
 *     DK suggestion, lists the pauses as recorded ("12:00–12:30 · målt"), and
 *     marks one that clock-out ended for a look — never as measured.
 *
 * t() is the key here (StaffHoursPage), so these pin which sentence is used.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const C = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "liveBreaksContract.json"), "utf8"),
);
const STEP = Object.fromEntries(C.steps.map((s) => [s.name, s]));
const body = (name) => structuredClone(STEP[name].body);

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: 1, role: "owner", currency: "DKK" }, loading: false }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (k, _f, vars) => (vars && typeof _f === "string" ? `${k}|${Object.values(vars).join("|")}` : k),
    lang: "en", setLang: () => {}, LANGUAGES: [],
  }),
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn(async () => true) }));

const api = (await import("../services/api")).default;
const StaffHoursPage = (await import("../pages/StaffHoursPage")).default;
const { ClockedInStrip } = await import("../pages/StaffSchedulePage");

beforeEach(() => {
  api.get.mockReset();
});

describe("the live strip: who is on a pause", () => {
  it("names the pause and its start from the real /staff/clocked-in body", async () => {
    const strip = body("owner_clocked_in_on_break");
    expect(strip.clocked_in[0].on_break).toBe(true);
    api.get.mockImplementation((url) => (url === C.paths.owner_clocked_in
      ? Promise.resolve({ data: { ...strip, clocked_in: strip.clocked_in.map((r) => ({ ...r, staff_id: "s-1" })) } })
      : Promise.resolve({ data: null })));
    render(<MemoryRouter><ClockedInStrip /></MemoryRouter>);
    const chip = await screen.findByTestId("clocked-in-on-break");
    expect(chip.textContent).toContain(`schedOnBreakSince|${strip.clocked_in[0].break_since}`);
  });

  it("not on a pause: nothing extra", async () => {
    const strip = body("owner_clocked_in_on_break");
    strip.clocked_in[0].on_break = false;
    strip.clocked_in[0].break_since = null;
    api.get.mockImplementation(() => Promise.resolve({ data: { ...strip, clocked_in: strip.clocked_in.map((r) => ({ ...r, staff_id: "s-1" })) } }));
    render(<MemoryRouter><ClockedInStrip /></MemoryRouter>);
    await screen.findByText("Agnes");
    expect(screen.queryByTestId("clocked-in-on-break")).toBeNull();
  });
});

describe("an hours row: measured or suggested, and the pauses as recorded", () => {
  const PERIOD = { period_type: "monthly_1st", start_date: "2026-06-01", end_date: "2026-06-30" };
  const OVERVIEW = { has_any_hours: true, hours: { actual_total: 7.17, scheduled_total: 7.17 }, period: { is_complete: true }, cost: {}, labor: {}, flags: {} };
  const summaryRow = {
    staff_id: "s-1", staff_name: "Agnes", actual_hours: 7.17, scheduled_hours: 7.5, hourly_rate: 150,
    earned: 1075, tips: 0, total: 1075, work_limit: null, worst_state: "matched",
    needs_answer_count: 0, exceptions: [], entries_count: 1, approved_count: 0, period_approved_count: 0,
  };

  async function mountWith(entries) {
    api.get.mockImplementation((url) => {
      if (url === "/staff/members") return Promise.resolve({ data: [{ id: "s-1", name: "Agnes" }] });
      if (url === "/staff/pay-period/current") return Promise.resolve({ data: PERIOD });
      if (url === "/staff/hours/summary") return Promise.resolve({ data: [summaryRow] });
      if (url === "/staff/hours/overview") return Promise.resolve({ data: OVERVIEW });
      if (url === C.paths.owner_hours) return Promise.resolve({ data: entries });
      return Promise.resolve({ data: null });
    });
    render(<MemoryRouter><StaffHoursPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole("tab", { name: /hovTabPerStaff/ }));
  }
  const real = () => body("owner_hours_after_out").map((r) => ({ ...r, id: "h-1", staff_id: "s-1", staff_name: "Agnes" }));

  it("the real row: paid break measured; each pause listed; the one clock-out ended is marked to check", async () => {
    await mountWith(real());
    const list = await screen.findByTestId("hours-recorded-breaks");
    expect(screen.getByTestId("hours-break-source").textContent).toContain("shpBreakMeasured");
    expect(screen.queryByTestId("hours-break-short")).toBeNull();
    const items = [...list.children].map((n) => n.textContent);
    expect(items).toEqual([
      "12:00–12:30 · shpBreakMeasured",
      "16:00–16:20 · shpBreakMeasured",
      "16:45–17:00 · shpBreakEndedByClockOut",
    ]);
    expect(list.children[2].className).toContain("text-amber-600");
    expect(list.children[0].className).not.toContain("text-amber-600");
  });

  it("recorded_short is flagged; a DK-suggestion row with pauses says 'suggested'", async () => {
    const short = real();
    short[0] = { ...short[0], break_source: "recorded_short" };
    await mountWith(short);
    await screen.findByTestId("hours-recorded-breaks");
    expect(screen.getByTestId("hours-break-short").textContent).toContain("shpBreakShort");
  });

  it("pauses recorded but not counted (setting off at clock-out): 'suggested'", async () => {
    const dk = real();
    dk[0] = { ...dk[0], break_minutes: 45, break_source: null, breaks: dk[0].breaks.map((b) => ({ ...b, counted: false })) };
    await mountWith(dk);
    await screen.findByTestId("hours-recorded-breaks");
    expect(screen.getByTestId("hours-break-source").textContent).toContain("shpBreakSuggested");
  });

  it("a row without recorded pauses is exactly as before", async () => {
    const plain = real();
    plain[0] = { ...plain[0], breaks: [], recorded_break_minutes: null, break_source: null, break_minutes: 45 };
    await mountWith(plain);
    await waitFor(() => expect(screen.getByText(/shpMinBreak/)).toBeInTheDocument());
    expect(screen.queryByTestId("hours-recorded-breaks")).toBeNull();
    expect(screen.queryByTestId("hours-break-source")).toBeNull();
  });
});
