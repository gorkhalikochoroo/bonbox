/**
 * The phone half of the Option-B Vagtplan, mounted for real.
 *
 * MobileSchedule is the only piece of StaffSchedulePage that is exported, so it
 * is the only place these four decisions can be checked as DOM rather than as
 * source:
 *
 *   1. NO PAY RATE ON THE GRID. The per-shift "≈ 640 kr." line is gone. That
 *      number divided by the hours printed directly above it is the person's
 *      hourly rate, and a rota is a screen colleagues stand in front of. This
 *      test mounts with showCost ON — the strongest form of the assertion is
 *      that the kroner stay away even when the owner asked for cost.
 *   2. CONTRACT TYPE replaced it — Fuldtid / Deltid / Studerende / Freelance,
 *      which is what an owner actually needs while placing a Wednesday lunch.
 *   3. EMERALD MEANS SEEN. Today's pill and the "I dag" label moved to the
 *      brand token, because emerald now carries the acknowledgement signal (and
 *      already carried "helst" on this same screen).
 *   4. A DRAFT IS NOT AN ERROR. Dashed amber outline + an 11px sentence-case
 *      "Kladde" pill, replacing a 9px uppercase amber shout.
 *
 * Danish catalogue throughout: the strings below are the shipped ones, not a
 * stub that would agree with anything.
 */
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { business_type: "cafe", role: "owner" } }),
}));

const { MobileSchedule } = await import("../pages/StaffSchedulePage");
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
// A day nobody has published yet — drives the amber pill dot.
const TOMORROW = iso(WEEK[(WEEK.findIndex((d) => iso(d) === TODAY) + 1) % 7]);

const SEEN = {
  id: "sh-seen", date: TODAY, start_time: "10:00", end_time: "18:00",
  break_minutes: 0, status: "published", confirmed_current: true,
};
const NOTED = {
  id: "sh-note", date: TODAY, start_time: "18:00", end_time: "23:00",
  break_minutes: 0, status: "published", confirmed_current: false,
  notes: "Har nøglen — lukker",
};
const DRAFT = {
  id: "sh-draft", date: TOMORROW, start_time: "09:00", end_time: "15:00",
  break_minutes: 0, status: "draft",
};

const STAFF = [
  { id: "st-a", name: "Mette", role: "Server", active: true, base_rate: 180, contract_type: "part" },
  { id: "st-b", name: "Jonas", role: "Chef", active: true, base_rate: 220 }, // no contract_type
];

const getShiftsForCell = (staffId, date) => {
  const d = iso(date);
  if (staffId === "st-a" && d === TODAY) return [SEEN, NOTED];
  if (staffId === "st-b" && d === TOMORROW) return [DRAFT];
  return [];
};

function Harness(props) {
  const { t } = useLanguage();
  return (
    <MobileSchedule
      staff={STAFF}
      weekDates={WEEK}
      getShiftsForCell={getShiftsForCell}
      // ON deliberately — the point is that cost totals may show and per-shift
      // kroner still may not.
      showCost
      weekCost={{ daily: [{ date: TODAY, hours: 13, cost_gross: 2340, revenue: 9000, labor_pct_gross: 0.26 }] }}
      costBasis="gross"
      targetPct={0.3}
      t={t}
      onCellClick={vi.fn()}
      {...props}
    />
  );
}

const mount = (props) => {
  localStorage.setItem("lang", "da");
  return render(
    <LanguageProvider>
      <Harness {...props} />
    </LanguageProvider>,
  );
};

describe("MobileSchedule — no pay rate on the grid", () => {
  it("prints no per-shift kroner even with the cost toggle on", () => {
    const { container } = mount();
    const chip = screen.getByRole("button", { name: /10:00–18:00/ });
    expect(chip.textContent).not.toMatch(/kr/i);
    expect(chip.textContent).not.toContain("≈");
    // The DAY total is still there — that is the point of the toggle.
    expect(container.textContent).toContain("≈");
  });

  it("shows the staffer's contract type, and nothing when there isn't one", () => {
    mount();
    expect(screen.getByText("Deltid")).toBeInTheDocument();
    // Jonas has no contract_type: no empty chip, and no "undefined".
    expect(screen.queryByText("undefined")).toBeNull();
    expect(screen.queryAllByText("Fuldtid")).toHaveLength(0);
  });

  it("drops the whole labor%% cluster for a staff seat, not just its number", () => {
    // Desktop removes the cluster; the phone kept the LABEL over a permanent
    // "—", because weekCost is null by construction for a manager/cashier seat
    // (the page skips the fetch) and `hasRevenue` is therefore always false.
    // A label for a number the seat will never be shown is not a degraded
    // state, it is a promise the page cannot keep.
    const { container } = mount({ isStaffSeat: true, showCost: false, weekCost: null });
    expect(container.textContent).not.toMatch(/Lønprocent/i);
    expect(container.textContent).not.toContain("≈");
    // …and the operational half of the strip survives: they still see who is on.
    expect(screen.getByText("Mette")).toBeInTheDocument();
  });

  it("keeps the labor%% cluster for the owner even with cost display off", () => {
    // The seat gate and the display toggle are different questions — an owner
    // who hid kroner still wants the day's labor%.
    const { container } = mount({ showCost: false });
    expect(container.textContent).toMatch(/Lønprocent/i);
  });
});

describe("MobileSchedule — emerald means seen", () => {
  it("marks an acknowledged shift with the emerald check", () => {
    mount();
    const chip = screen.getByRole("button", { name: /10:00–18:00/ });
    expect(within(chip).getByTitle("Set af medarbejderen")).toBeInTheDocument();
  });

  it("does not mark one the staffer has not seen", () => {
    mount();
    const chip = screen.getByRole("button", { name: /18:00–23:00/ });
    expect(within(chip).queryByTitle("Set af medarbejderen")).toBeNull();
  });

  it("surfaces a shift note the grid used to hide entirely", () => {
    mount();
    const chip = screen.getByRole("button", { name: /18:00–23:00/ });
    expect(within(chip).getByTitle("Har nøglen — lukker")).toBeInTheDocument();
  });

  it("paints today's pill and label with the brand token, not emerald", () => {
    const { container } = mount();
    const idag = screen.getByText("I dag");
    expect(idag.className).toContain("text-[rgb(var(--brand-600))]");
    expect(idag.className).not.toContain("emerald");

    // Today's pill only shows its own tint once it is NOT the selected day —
    // selection (gray-900) outranks it, and on first paint today IS selected.
    const pills = [...container.querySelectorAll("[aria-pressed]")];
    const todayIdx = WEEK.findIndex((d) => iso(d) === TODAY);
    fireEvent.click(pills[(todayIdx + 3) % 7]);
    const todayPill = [...container.querySelectorAll("[aria-pressed]")][todayIdx];
    expect(todayPill.className).toContain("bg-[rgb(var(--brand-50))]");
    expect(todayPill.className).not.toContain("emerald");
  });
});

describe("MobileSchedule — a draft is not an error", () => {
  /** Tap through to the one day that holds a draft, the way an owner would. */
  const openDraftDay = () => {
    const { container } = mount();
    const pills = [...container.querySelectorAll("[aria-pressed]")];
    fireEvent.click(pills[WEEK.findIndex((d) => iso(d) === TOMORROW)]);
    return container;
  };

  it("wears a dashed amber outline instead of the published gray ring", () => {
    openDraftDay();
    const chip = screen.getByRole("button", { name: /09:00–15:00/ });
    expect(chip.className).toContain("outline-dashed");
    expect(chip.className).toContain("outline-amber-400");
    expect(chip.className).not.toContain("ring-1");
    // …and the 3px role bar stays SOLID. It says which SECTION the shift is,
    // not which state — and `border-dashed` used to dissolve it on exactly the
    // shifts the owner was still writing.
    expect(chip.className).not.toContain("border-dashed");
    expect(chip.className).toContain("border-l-[3px]");
  });

  it("labels it with a sentence-case Kladde pill, not a 9px uppercase shout", () => {
    openDraftDay();
    const chip = screen.getByRole("button", { name: /09:00–15:00/ });
    const pill = within(chip).getByText("Kladde");
    expect(pill.className).toContain("text-[11px]");
    expect(pill.className).toContain("bg-amber-50");
    expect(pill.className).not.toContain("uppercase");
  });
});

describe("MobileSchedule — day pills carry the week's shape", () => {
  it("gives every pill the sentence behind its dot", () => {
    mount();
    // Today: one seen + one not → the partial sentence, from the real catalogue.
    expect(screen.getByText("1 af 2 har set deres vagt")).toBeInTheDocument();
    // Tomorrow: a lone draft.
    expect(screen.getByText("1 af 1 er stadig kladder")).toBeInTheDocument();
    // The other five are empty and say so rather than showing a bare dot.
    expect(screen.getAllByText("Ingen vagter denne dag").length).toBe(5);
  });

  it("colours the dot amber for a draft day and emerald only when all seen", () => {
    const { container } = mount();
    const pills = [...container.querySelectorAll("[aria-pressed]")];
    expect(pills).toHaveLength(7);
    const tomorrowPill = pills[WEEK.findIndex((d) => iso(d) === TOMORROW)];
    expect(tomorrowPill.querySelector(".bg-amber-500")).toBeTruthy();
    const todayPill = pills[WEEK.findIndex((d) => iso(d) === TODAY)];
    // 1 of 2 seen is NOT "everyone" — neutral, never emerald.
    expect(todayPill.querySelector(".bg-emerald-500")).toBeNull();
  });

  it("keeps every pill at or above the 44px tap-target floor", () => {
    const { container } = mount();
    for (const pill of container.querySelectorAll("[aria-pressed]")) {
      expect(pill.className).toContain("min-h-[44px]");
    }
  });
});
