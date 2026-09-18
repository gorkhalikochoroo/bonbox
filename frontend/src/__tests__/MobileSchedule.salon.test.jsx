/**
 * The phone day-list, mounted for real — a salon owner and a split shift.
 *
 * Two defects met here, and neither could be caught by reading one function:
 *
 *   1. SALON CRASH. useCatFor() resolves a role through roleSections.js, which
 *      returns "treatment"/"front" for a salon. The grid's colour map held only
 *      kitchen/bar/floor and the lookup was dereferenced on the very next line
 *      (`colors.dot`), so a salon owner's schedule threw on first paint. The
 *      assertion that matters below is simply that this renders at all.
 *
 *   2. SPLIT SHIFTS INVISIBLE. MobileSchedule was handed getShiftsForCell but
 *      destructured only the singular accessor, so a lunch+dinner day showed
 *      ONE shift, in the only view a phone has. The second shift could not be
 *      seen, could not be tapped, and did not count toward the day's hours.
 *
 * Mounted through the real LanguageProvider so the day-pill labels below are
 * the shipped Danish catalogue, not a stub that would agree with anything.
 */
import { render, screen, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The page module pulls the axios client + a chat drawer at import time; the
// component under test touches neither.
vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
// useCatFor() is the whole point of the salon case — this is the vertical.
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { business_type: "salon" } }),
}));

const { MobileSchedule } = await import("../pages/StaffSchedulePage");
const { LanguageProvider, useLanguage } = await import("../hooks/useLanguage");

/** Monday-anchored week containing today, so the component's own default day
 *  index lands on today rather than its Thursday fallback. */
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
const TODAY_ISO = iso(new Date());

/** Ida works a 4h colour appointment block and a 5h evening block — one day,
 *  two shifts, which is ordinary in a salon and used to render as one. */
const LUNCH = { id: "sh-lunch", date: TODAY_ISO, start_time: "11:00", end_time: "15:00", break_minutes: 0, status: "published", role_on_shift: "Frisør" };
const EVENING = { id: "sh-evening", date: TODAY_ISO, start_time: "18:00", end_time: "23:00", break_minutes: 0, status: "published", role_on_shift: "Frisør" };

const STAFF = [{ id: "st-ida", name: "Ida", role: "Frisør", active: true, base_rate: 200 }];

const getShiftsForCell = (staffId, date) =>
  staffId === "st-ida" && iso(date) === TODAY_ISO ? [LUNCH, EVENING] : [];

const onCellClick = vi.fn();

function Harness(props) {
  const { t } = useLanguage();
  return (
    <MobileSchedule
      staff={STAFF}
      weekDates={WEEK}
      getShiftsForCell={getShiftsForCell}
      showCost={false}
      weekCost={null}
      costBasis="gross"
      targetPct={0.3}
      t={t}
      onCellClick={onCellClick}
      {...props}
    />
  );
}

const mount = (lang = "da", props) => {
  localStorage.setItem("lang", lang);
  return render(
    <LanguageProvider>
      <Harness {...props} />
    </LanguageProvider>,
  );
};

beforeEach(() => {
  onCellClick.mockClear();
});

describe("MobileSchedule — salon vertical", () => {
  it("renders without throwing on a salon role", () => {
    // Pre-fix this was a TypeError on `colors.dot`, i.e. a white screen.
    const { container } = mount();
    expect(screen.getByText("Ida")).toBeInTheDocument();
    // …and the salon section gets a real dot rather than an undefined class.
    // NOTE this no longer discriminates the way it did when it was written:
    // the grid's `floor` moved from emerald to violet too (emerald became the
    // "seen by staff" signal), so violet here proves the lookup resolved, not
    // that it resolved to `treatment`. scheduleSectionColors.test.jsx holds
    // the per-section assertion.
    expect(container.querySelector(".bg-violet-500")).toBeTruthy();
  });
});

describe("MobileSchedule — split shifts", () => {
  it("renders EVERY shift of the day with its own tap target", () => {
    mount();
    const lunch = screen.getByRole("button", { name: /11:00–15:00/ });
    const evening = screen.getByRole("button", { name: /18:00–23:00/ });
    expect(lunch).toBeInTheDocument();
    expect(evening).toBeInTheDocument();

    evening.click();
    expect(onCellClick).toHaveBeenCalledTimes(1);
    // The SECOND shift must reach the modal as itself — passing [0] here is
    // the same bug wearing a different hat.
    expect(onCellClick.mock.calls[0][0]).toBe("st-ida");
    expect(onCellClick.mock.calls[0][2]).toBe(EVENING);
  });

  it("never nests a button inside a button", () => {
    const { container } = mount();
    for (const b of container.querySelectorAll("button")) {
      expect(b.querySelector("button")).toBeNull();
    }
  });

  it("counts both shifts in the day's hours and still says one person", () => {
    mount();
    // 4h + 5h, DK comma decimal + 't' — not 4t, which is what the singular
    // accessor produced.
    expect(screen.getByText("9t")).toBeInTheDocument();
    expect(screen.getByText("1")).toBeInTheDocument(); // staffOn is a head count
  });

  it("keeps the empty day as one row-wide OFF button", () => {
    // Nothing on Ida's other days — the add-a-shift affordance must survive
    // the restructure.
    const empty = WEEK.filter((d) => iso(d) !== TODAY_ISO);
    mount("da", { weekDates: [empty[0], ...empty] });
    const row = screen.getByRole("button", { name: /Ida/ });
    expect(within(row).getByText("FRI")).toBeInTheDocument();
    row.click();
    expect(onCellClick.mock.calls[0][2]).toBeNull();
  });
});

describe("MobileSchedule — Danish day labels", () => {
  it("shows 3-letter localized weekday pills, not English initials", () => {
    mount("da");
    // The pills used to render DAY_LABELS[i].charAt(0): T/T for Tue/Thu and
    // S/S for Sat/Sun, ambiguous in both languages, and English besides.
    for (const label of ["Man", "Tir", "Ons", "Tor", "Fre", "Lør", "Søn"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("still reads English for an English owner", () => {
    mount("en");
    for (const label of ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });
});
