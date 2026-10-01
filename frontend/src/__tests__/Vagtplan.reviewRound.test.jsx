/**
 * The Vagtplan grid, phone view and autopilot card after the review round.
 *
 *   • PHONE: the week's hours and wage bill under the day strip (the desktop
 *     summary is hidden there), "planlagt, inkl. kladder" so it never
 *     silently disagrees with the Timer tab, "X t denne uge" on each person,
 *     and a shift inside a fravær flagged with the KIND;
 *   • DESKTOP: the conflict ring names the absence kind instead of "Kan ikke";
 *     the Timer column and hours chip never wrap; a fravær action per row;
 *   • a missing wage is "—" with the names, never an invented number;
 *   • AUTOPILOT: codes from the server, Danish on the page; an empty proposal
 *     says it is empty and why.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { business_type: "cafe", role: "owner" } }),
}));

const { MobileSchedule, ScheduleGrid, AutopilotPanel } = await import("../pages/StaffSchedulePage");
const { LanguageProvider, useLanguage } = await import("../hooks/useLanguage");

function weekDatesForToday() {
  const d = new Date();
  const day = d.getDay();
  const monday = new Date(d);
  monday.setDate(d.getDate() - day + (day === 0 ? -6 : 1));
  monday.setHours(0, 0, 0, 0);
  return Array.from({ length: 7 }, (_, i) => {
    const x = new Date(monday);
    x.setDate(monday.getDate() + i);
    return x;
  });
}
const iso = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const WEEK = weekDatesForToday();
const TODAY = iso(new Date());

const STAFF = [
  { id: "a", name: "Anna", role: "Server", active: true, base_rate: 180 },
  { id: "b", name: "Bo", role: "bar", active: true },
];
const SHIFTS = [
  { id: "s1", staff_id: "a", date: TODAY, start_time: "17:00", end_time: "23:30", break_minutes: 45, status: "published" },
  { id: "s2", staff_id: "b", date: TODAY, start_time: "10:00", end_time: "16:00", break_minutes: 0, status: "draft" },
];
const getShiftsForCell = (staffId, date) =>
  SHIFTS.filter((s) => s.staff_id === staffId && s.date === iso(date));

function Phone(props) {
  const { t, lang } = useLanguage();
  return (
    <MobileSchedule
      staff={STAFF}
      weekDates={WEEK}
      getShiftsForCell={getShiftsForCell}
      unavailFor={() => null}
      preferredFor={() => null}
      absenceFor={() => null}
      showCost
      weekCost={null}
      costBasis="gross"
      targetPct={0.3}
      t={t}
      lang={lang}
      onCellClick={vi.fn()}
      {...props}
    />
  );
}

function Grid(props) {
  const { t, lang } = useLanguage();
  return (
    <ScheduleGrid
      staff={STAFF}
      weekDates={WEEK}
      getShiftsForCell={getShiftsForCell}
      unavailFor={() => null}
      preferredFor={() => null}
      absenceFor={() => null}
      onCellClick={vi.fn()}
      onMoveShift={vi.fn()}
      showCost
      dailyCost={null}
      forecastByDate={{}}
      costBasis="gross"
      targetPct={0.3}
      weekLoad={{ staff: [{ staff_id: "a", name: "Anna", hours: 29.25, cap: null }] }}
      t={t}
      lang={lang}
      {...props}
    />
  );
}

const mount = (node) => {
  localStorage.setItem("lang", "da");
  return render(<LanguageProvider>{node}</LanguageProvider>);
};

describe("phone — the week in one line", () => {
  it("prints the week's hours and cost under the day strip, labelled as planned with drafts", () => {
    mount(<Phone weekTotals={{ hours: 50.75, cost: 8083, missingWage: [], hasDrafts: true }} />);
    const line = screen.getByTestId("sched-week-line");
    expect(line.textContent).toContain("Uge:");
    expect(line.textContent).toContain("50,75 t");
    expect(line.textContent).toContain("≈ 8.083 kr.");
    expect(line.textContent).toContain("planlagt, inkl. kladder");
  });

  it("says — and who is missing a wage instead of inventing a number", () => {
    mount(<Phone weekTotals={{ hours: 12, cost: null, missingWage: ["Bo"], hasDrafts: false }} />);
    const line = screen.getByTestId("sched-week-line");
    expect(line.textContent).toContain("—");
    expect(line.textContent).not.toContain("≈");
    expect(line.textContent).toContain("Mangler timeløn: Bo");
    expect(line.textContent).toContain("(planlagt)");
  });

  it("puts each person's week on their row", () => {
    mount(<Phone weekTotals={{ hours: 11.75, cost: null, missingWage: [], hasDrafts: true }} />);
    // 17.00–23.30 less 45 min = 5,75 t; 10–16 = 6 t.
    expect(screen.getByText("5,75 t denne uge")).toBeInTheDocument();
    expect(screen.getByText("6 t denne uge")).toBeInTheDocument();
  });

  it("flags a shift inside a fravær with the kind, in the Danish clock", () => {
    mount(<Phone absenceFor={(id, d) => (id === "a" && iso(d) === TODAY ? { kind: "sick" } : null)} />);
    const chip = screen.getByRole("button", { name: /Anna.*17\.00–23\.30.*Syg/ });
    expect(within(chip).getByText("Syg")).toBeInTheDocument();
    expect(chip.className).toContain("ring-red-400");
  });

  it("gives each person a 40px fravær action that reports the day on screen", () => {
    const onAbsence = vi.fn();
    mount(<Phone onAbsence={onAbsence} />);
    const btn = screen.getByRole("button", { name: "Registrér fravær for Bo" });
    expect(btn.className).toContain("w-10");
    expect(btn.className).toContain("h-10");
    fireEvent.click(btn);
    expect(onAbsence).toHaveBeenCalledWith("b", TODAY);
  });

  it("reports which day it shows, so Tilføj can open on it", () => {
    const onDayChange = vi.fn();
    mount(<Phone onDayChange={onDayChange} />);
    expect(onDayChange).toHaveBeenCalledWith(TODAY);
  });

  it("makes the day arrows 40px and FRI readable", () => {
    // Only Anna works today, so Bo's row reads FRI.
    const onlyAnna = (staffId, date) => (staffId === "a" ? getShiftsForCell(staffId, date) : []);
    mount(<Phone getShiftsForCell={onlyAnna} />);
    expect(screen.getByRole("button", { name: "Forrige dag" }).className).toContain("w-10");
    expect(screen.getByRole("button", { name: "Næste dag" }).className).toContain("h-10");
    // gray-500 / dark gray-400 — gray-400 on white was ~2.5:1.
    const fri = screen.getByText("FRI").parentElement;
    expect(fri.className).toContain("text-gray-500");
    expect(fri.className).toContain("dark:text-gray-400");
    expect(fri.className).not.toMatch(/(^|\s)text-gray-400(\s|$)/);
  });

  it("shows a raw role key nowhere — a 'bar' staffer reads Bar", () => {
    mount(<Phone />);
    expect(screen.getByText("Bar")).toBeInTheDocument();
    expect(screen.queryByText("bar")).toBeNull();
  });
});

describe("desktop — the grid", () => {
  it("names the absence KIND on the conflict ring, not 'Kan ikke'", () => {
    const { container } = mount(
      <Grid absenceFor={(id, d) => (id === "a" && iso(d) === TODAY ? { kind: "ferie" } : null)} />,
    );
    const ringed = container.querySelector("tbody .ring-red-400");
    expect(ringed).not.toBeNull();
    expect(ringed.textContent).toContain("Ferie");
    expect(ringed.textContent).not.toContain("Kan ikke");
    expect(ringed.getAttribute("title")).toBe("Anna: Ferie denne dag — registreret som fraværende");
  });

  it("keeps 'Kan ikke' for a standing can't-work day", () => {
    const { container } = mount(
      <Grid unavailFor={(id, d) => (id === "a" && iso(d) === TODAY ? { kind: "unavailable" } : null)} />,
    );
    expect(container.querySelector("tbody .ring-red-400").textContent).toContain("Kan ikke");
  });

  it("prints Danish times and never wraps the hours", () => {
    const { container } = mount(<Grid />);
    expect(container.querySelector("tbody").textContent).toContain("17.00–23.30");
    const chip = screen.getByText("29,25 t");
    expect(chip.className).toContain("whitespace-nowrap");
    const timerCells = [...container.querySelectorAll("tbody tr > td:last-child")];
    expect(timerCells.length).toBeGreaterThan(0);
    for (const td of timerCells) expect(td.className).toContain("whitespace-nowrap");
  });

  it("offers fravær on each person's row", () => {
    const onAbsence = vi.fn();
    mount(<Grid onAbsence={onAbsence} />);
    fireEvent.click(screen.getByRole("button", { name: "Registrér fravær for Anna" }));
    expect(onAbsence).toHaveBeenCalledWith("a");
  });

  it("offers no fravær action to a seat that may not write one", () => {
    mount(<Grid onAbsence={null} />);
    expect(screen.queryByRole("button", { name: /Registrér fravær/ })).toBeNull();
  });
});

// ── Autopilot ────────────────────────────────────────────────────────

function Autopilot({ suggestion }) {
  const { t, lang } = useLanguage();
  return (
    <MemoryRouter>
      <AutopilotPanel suggestion={suggestion} applying={false} onApply={vi.fn()} onDiscard={vi.fn()} t={t} lang={lang} />
    </MemoryRouter>
  );
}

const day = (i, extra = {}) => ({
  date: iso(WEEK[i]), weekday: "Monday", weather: {}, predicted_revenue: 9000,
  predicted_demand_hours: 12, shifts: [], total_cost: 0, total_hours: 0, ...extra,
});

describe("autopilot — codes in, Danish out", () => {
  const withShifts = {
    week_start: iso(WEEK[0]),
    confidence: "high",
    basis: { weeks_of_data: 8, avg_weekday_samples: 8, target_labor_pct: 0.3, signal: "revenue" },
    days: [day(0, { shifts: [{ staff_id: "a", staff_name: "Anna", start: "11:00", end: "15:00", break_minutes: 0, hours: 4, cost: 720 }], total_cost: 720, total_hours: 4 })],
    week_total_cost: 720,
    week_total_hours: 4,
    compared_to_last_week: { direction: "saves", delta_kr: -650, delta_pct: -10, savings_label: "Saves 650 DKK vs last week" },
    warnings: [
      { code: "unfilled", date: iso(WEEK[0]), hours_short: 4, shift: "dinner" },
      { code: "over_weekly_cap", staff_name: "Anna", hours: 12, cap: 10 },
    ],
    compliance_warnings: ["English text the page must not print"],
    missing_wage_names: [],
  };

  it("words the warnings and the comparison in Danish, never the server's English", () => {
    mount(<Autopilot suggestion={withShifts} />);
    expect(screen.getByText("Sparer 650 kr. i forhold til sidste uge")).toBeInTheDocument();
    expect(screen.getByText(/mangler 4 t på aftenvagten — ingen ledige til at tage den/)).toBeInTheDocument();
    expect(screen.getByText("Anna: 12 t — over ugegrænsen på 10 t")).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("Saves 650 DKK");
    expect(document.body.textContent).not.toContain("English text the page must not print");
    expect(document.body.textContent).toContain("11.00–15.00");
  });

  it("says an empty proposal is empty — and why — when there is nothing to plan from", () => {
    mount(<Autopilot suggestion={{
      ...withShifts,
      basis: { ...withShifts.basis, avg_weekday_samples: 0, weeks_of_data: 0 },
      days: [day(0, { predicted_revenue: 0 })],
      warnings: [], compared_to_last_week: {}, week_total_cost: 0, week_total_hours: 0,
    }} />);
    expect(screen.getByText(/Ingen vagter foreslået — der er ingen dagsafslutninger eller salg/)).toBeInTheDocument();
    // The old sentence claimed a plan built on opening hours.
    expect(document.body.textContent).not.toMatch(/åbningstider/);
  });

  it("shows — and the names when a proposed staffer has no wage", () => {
    mount(<Autopilot suggestion={{
      ...withShifts,
      week_total_cost: null,
      compared_to_last_week: { direction: null, delta_kr: null },
      days: [day(0, { shifts: [{ staff_id: "b", staff_name: "Bo", start: "11:00", end: "15:00", hours: 4, cost: null }], total_cost: null, total_hours: 4 })],
      missing_wage_names: ["Bo"],
    }} />);
    expect(screen.getByText("Mangler timeløn: Bo")).toBeInTheDocument();
    // No labor% computed from an unknown cost (null ÷ revenue would print 0 %).
    expect(document.body.textContent).not.toMatch(/Lønprocent: 0\s?%/);
  });
});
