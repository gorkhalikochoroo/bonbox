/**
 * The desktop Vagtplan grid — Option B — mounted for real.
 *
 * F2 and F4 are structural changes to a <table>: a new header line under the
 * bookings count, and one <tbody> per section with a tinted band above its
 * people. Both are the class of change a green `npm run build` says nothing
 * about — this repo has shipped a white screen past a green build before. So
 * the load-bearing assertion in the first test is simply that the thing renders
 * with rows in it.
 *
 * The rest pin the claims an owner would act on:
 *   • amber before emerald on the day header — a day that still owes a publish
 *     must not be able to look finished;
 *   • the amber 0 on a section header — "there IS a roster on Saturday and
 *     nobody from Køkken is on it" is the gap you cannot see by counting rows;
 *   • no kroner per shift, anywhere, with the cost toggle ON;
 *   • the section headers register no drop target (dnd-kit must never offer the
 *     owner a cell that belongs to nobody).
 */
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));

let BUSINESS_TYPE = "cafe";
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { business_type: BUSINESS_TYPE, role: "owner" } }),
}));

const { ScheduleGrid } = await import("../pages/StaffSchedulePage");
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
const MON = iso(WEEK[0]);
const TUE = iso(WEEK[1]);
const WED = iso(WEEK[2]);

/** Four people across three sections — the roster that clears the gate. */
const STAFF = [
  { id: "k1", name: "Jonas", role: "Chef", active: true, contract_type: "full" },
  { id: "k2", name: "Sara", role: "Opvasker", active: true, contract_type: "student" },
  { id: "b1", name: "Lars", role: "Bartender", active: true },
  { id: "f1", name: "Mette", role: "Server", active: true, contract_type: "part" },
];

const shift = (id, date, staffId, extra = {}) => ({
  id, date, staff_id: staffId, start_time: "10:00", end_time: "18:00",
  break_minutes: 0, status: "published", ...extra,
});

// Monday: everybody seen it → emerald.
// Tuesday: kitchen is EMPTY while the rest of the house works → the amber 0.
// Wednesday: one unsent draft → amber beats everything.
const SHIFTS = [
  shift("m-k1", MON, "k1", { confirmed_current: true }),
  // confirmed_at ALONE — the pre-backend-deploy shape. It must still count as
  // seen, or every owner reads "nobody has looked" for a week after we ship.
  shift("m-f1", MON, "f1", { confirmed_at: "2026-09-14T09:00:00Z" }),
  shift("t-b1", TUE, "b1", { confirmed_current: true }),
  shift("t-f1", TUE, "f1", { confirmed_at: null }),
  shift("w-k1", WED, "k1", { status: "draft", start_time: "09:00", end_time: "15:00" }),
  shift("w-f1", WED, "f1", { confirmed_current: true }),
];

const getShiftsForCell = (staffId, date) =>
  SHIFTS.filter((s) => s.staff_id === staffId && s.date === iso(date));

function Harness(props) {
  const { t } = useLanguage();
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
      dailyCost={[{ date: MON, hours: 16, cost_gross: 2880, revenue: 11000, labor_pct_gross: 0.26 }]}
      forecastByDate={{}}
      costBasis="gross"
      targetPct={0.3}
      weekLoad={null}
      t={t}
      {...props}
    />
  );
}

const mount = (props, lang = "da") => {
  localStorage.setItem("lang", lang);
  return render(
    <LanguageProvider>
      <Harness {...props} />
    </LanguageProvider>,
  );
};

describe("ScheduleGrid — it renders at all", () => {
  it("paints the whole week without throwing", () => {
    const { container } = mount();
    for (const name of ["Jonas", "Sara", "Lars", "Mette"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(container.querySelectorAll("tbody").length).toBeGreaterThan(0);
  });
});

describe("ScheduleGrid — section bodies (Option B)", () => {
  it("groups a mixed café roster into one tbody per section, in service order", () => {
    const { container } = mount();
    const bodies = [...container.querySelectorAll("tbody")];
    expect(bodies).toHaveLength(3); // Køkken, Bar, Gulv
    expect(within(bodies[0]).getByText("Køkken")).toBeInTheDocument();
    expect(within(bodies[1]).getByText("Bar")).toBeInTheDocument();
    expect(within(bodies[2]).getByText("Gulv")).toBeInTheDocument();
    // …with their people under them, not shuffled together.
    expect(within(bodies[0]).getByText("Jonas")).toBeInTheDocument();
    expect(within(bodies[0]).getByText("Sara")).toBeInTheDocument();
    expect(within(bodies[2]).getByText("Mette")).toBeInTheDocument();
  });

  it("falls back to ONE ungrouped body below the gate", () => {
    // Three people is not a roster that needs chapter headings.
    const { container } = mount({ staff: STAFF.slice(0, 3) });
    expect(container.querySelectorAll("tbody")).toHaveLength(1);
    expect(screen.queryByText("Køkken")).toBeNull();
  });

  it("names the day a section is missing from, and stays quiet on a closed day", () => {
    const { container } = mount();
    const kitchenHeader = container.querySelector("tbody tr");
    // Tuesday: the house is open, the kitchen is not — the amber 0.
    const zero = within(kitchenHeader).getByTitle("Ingen fra Køkken på vagt");
    expect(zero.textContent).toBe("0");
    expect(zero.className).toContain("bg-amber-50");
    // Thursday onward nobody at all works: that is closed, not a hole.
    expect(within(kitchenHeader).getAllByText("—").length).toBeGreaterThan(0);
  });

  it("never turns a section header into a drop target", () => {
    // dnd-kit registers droppables on the grid's own cells. A header row that
    // accepted a drop would hand the owner a cell belonging to nobody.
    const { container } = mount();
    const header = container.querySelector("tbody tr");
    for (const td of header.querySelectorAll("td")) {
      expect(td.getAttribute("aria-label")).toBeNull();
      expect(td.className).not.toContain("cursor-pointer");
    }
  });

  it("suppresses the row dot on a vertical with no sections", () => {
    // A shop gets one colour for everybody and nothing in the legend to
    // explain it — so it gets no dot.
    BUSINESS_TYPE = "retail";
    try {
      const { container } = mount();
      expect(container.querySelectorAll("tbody")).toHaveLength(1);
      expect(container.querySelector(".bg-violet-500")).toBeNull();
    } finally {
      BUSINESS_TYPE = "cafe";
    }
  });

  it("suppresses the CARD BAR too on a vertical with no sections", () => {
    // The row dot was the small half of this. Every shift card also carries a
    // 3px left bar, and the grid's `|| "floor"` fallback painted all of them
    // with the floor hue — a colour key on a page whose legend deliberately
    // renders no "Roller:" block, because this vertical has no roles to key.
    // F1 moving floor off emerald onto violet made it louder, not different.
    BUSINESS_TYPE = "retail";
    try {
      const { container } = mount();
      const bars = [...container.querySelectorAll("tbody .border-l-\\[3px\\]")];
      expect(bars.length).toBeGreaterThan(0);   // there ARE cards to check
      for (const bar of bars) {
        expect(bar.className).toContain("border-gray-200");
        expect(bar.className).not.toContain("border-violet");
        expect(bar.className).not.toContain("border-red-500");
        expect(bar.className).not.toContain("border-blue-500");
      }
    } finally {
      BUSINESS_TYPE = "cafe";
    }
  });

  it("keeps the section hue on the card bar where the legend explains it", () => {
    // The other half of the same rule — the fix must not flatten a café.
    const { container } = mount();
    const bars = [...container.querySelectorAll("tbody .border-l-\\[3px\\]")]
      .map((el) => el.className);
    expect(bars.some((c) => c.includes("border-red-500"))).toBe(true);
    expect(bars.every((c) => c.includes("border-gray-200"))).toBe(false);
  });
});

describe("ScheduleGrid — the day-header status line", () => {
  const headerFor = (container, idx) =>
    [...container.querySelectorAll("thead th")][idx + 1]; // +1 = the staff column

  it("goes emerald only when every published shift is acknowledged", () => {
    const { container } = mount();
    const mon = headerFor(container, 0);
    expect(within(mon).getByText("Alle har set deres vagt")).toBeInTheDocument();
    expect(mon.querySelector(".bg-emerald-500")).toBeTruthy();
  });

  it("stays neutral when someone has not looked yet", () => {
    const { container } = mount();
    const tue = headerFor(container, 1);
    expect(within(tue).getByText("1 af 2 har set deres vagt")).toBeInTheDocument();
    expect(tue.querySelector(".bg-emerald-500")).toBeNull();
    expect(tue.querySelector(".bg-amber-500")).toBeNull();
  });

  it("puts amber ahead of emerald when the day still owes a publish", () => {
    // Wednesday: one draft + one seen. If emerald won here, an owner would
    // confidently send nothing.
    const { container } = mount();
    const wed = headerFor(container, 2);
    expect(within(wed).getByText("1 af 2 er stadig kladder")).toBeInTheDocument();
    expect(wed.querySelector(".bg-amber-500")).toBeTruthy();
    expect(wed.querySelector(".bg-emerald-500")).toBeNull();
  });

  it("says '0 vagter' with no dot on an empty day", () => {
    const { container } = mount();
    const thu = headerFor(container, 3);
    expect(within(thu).getByText("Ingen vagter denne dag")).toBeInTheDocument();
    expect(thu.textContent).toContain("0");
    expect(thu.querySelector(".rounded-full")).toBeNull();
  });

  it("labels today's column 'I dag' in the brand token", () => {
    const todayIdx = WEEK.findIndex((d) => iso(d) === iso(new Date()));
    const { container } = mount();
    const th = headerFor(container, todayIdx);
    const label = within(th).getByText("I dag");
    expect(label.className).toContain("text-[rgb(var(--brand-600))]");
  });
});

describe("ScheduleGrid — the shift cards", () => {
  it("gives a draft a dashed amber outline and a sentence-case Kladde pill", () => {
    const { container } = mount();
    const draftCards = [...container.querySelectorAll("tbody div")].filter(
      (el) => el.className.includes("outline-dashed"),
    );
    expect(draftCards).toHaveLength(1); // Wednesday's w-k1, and only that one
    const [card] = draftCards;
    expect(card.textContent).toContain("09:00–15:00");
    expect(card.className).not.toContain("ring-1");
    expect(card.className).not.toContain("border-dashed"); // the role bar stays solid
    expect(within(card).getByText("Kladde")).toBeInTheDocument();
  });

  it("marks an acknowledged published shift, and only that one", () => {
    const { container } = mount();
    const seen = container.querySelectorAll('[title="Set af medarbejderen"]');
    // Monday×2 + Tuesday×1 + Wednesday×1 = 4 acknowledged published shifts.
    expect(seen).toHaveLength(4);
  });
});

describe("ScheduleGrid — no pay rate on the grid", () => {
  it("prints no per-shift kroner with the cost toggle ON, but keeps the day total", () => {
    const { container } = mount();
    const body = container.querySelector("tbody");
    expect(body.textContent).not.toContain("≈");
    // The footer aggregate — the reason the toggle exists — survives.
    expect(container.querySelector("tfoot").textContent).toContain("≈");
  });

  it("shows contract type on the row instead, and omits it when unset", () => {
    mount();
    expect(screen.getByText("Fuldtid")).toBeInTheDocument();
    expect(screen.getByText("Studerende")).toBeInTheDocument();
    expect(screen.getByText("Deltid")).toBeInTheDocument();
    expect(screen.queryByText("undefined")).toBeNull(); // Lars has none
  });

  it("drops the whole cost footer when the wage endpoint is denied", () => {
    // A manager seat: the page passes dailyCost=null rather than a 403 error.
    const { container } = mount({ dailyCost: null, showCost: false });
    expect(container.querySelector("tfoot")).toBeNull();
    expect(container.textContent).not.toContain("≈");
  });
});
