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
const cellsFrom = (list) => (staffId, date) =>
  list.filter((s) => s.staff_id === staffId && s.date === iso(date));

/** Class TOKENS, not a substring: "dark:bg-amber-500/15" contains "bg-amber-50". */
const tokens = (el) => String(el?.className || "").split(/\s+/).filter(Boolean);
/** The shift card in `name`'s row on Monday-indexed day `dayIdx`. */
const cardIn = (name, dayIdx) => {
  const row = screen.getByText(name).closest("tr");
  return row.querySelectorAll("td")[1 + dayIdx].querySelector("div.rounded-lg");
};

function Harness(props) {
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
      dailyCost={[{ date: MON, hours: 16, cost_gross: 2880, revenue: 11000, labor_pct_gross: 0.26 }]}
      forecastByDate={{}}
      costBasis="gross"
      targetPct={0.3}
      weekLoad={null}
      t={t}
      lang={lang}
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
    // An amber PILL now (3 Nov): -100 so it keeps a shape on the red-50 band.
    expect(tokens(zero)).toContain("bg-amber-100");
    expect(tokens(zero)).toContain("rounded-full");
    // …and it SAYS so to a screen reader, not only in a hover title.
    expect(zero.getAttribute("role")).toBe("img");
    expect(zero.getAttribute("aria-label")).toBe("Ingen fra Køkken på vagt");
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
    // The Danish clock: "09.00–15.00", the way a payslip and the booking
    // book print it (fmtClock). English keeps the colon.
    expect(card.textContent).toContain("09.00–15.00");
    expect(card.className).not.toContain("ring-1");
    expect(card.className).not.toContain("border-dashed");
    expect(within(card).getByText("Kladde")).toBeInTheDocument();
  });

  it("gives a draft the cream fill and NO left bar — its section rides on a dot instead", () => {
    // 3 Nov: the solid red stripe against the amber dash was the clash in the
    // owner's mockup. The bar goes; the section stays readable as a dot in
    // front of the tag on line 2, in the section's colour.
    mount();
    const card = cardIn("Jonas", 2); // Wednesday, the Køkken draft
    expect(tokens(card)).toContain("outline-dashed");
    expect(tokens(card)).toContain("bg-[#FFFBF4]");
    expect(tokens(card)).toContain("dark:bg-amber-500/10");
    expect(tokens(card)).not.toContain("border-l-[3px]");
    expect(card.className).not.toMatch(/\bborder-(red|blue|violet)-500\b/);
    // The 3px the bar took is paid back in padding, so the time lines up with
    // a published card in the same column.
    expect(tokens(card)).toContain("pl-[13px]");
    const dot = card.querySelector("[data-role-dot]");
    expect(dot).toBeTruthy();
    expect(tokens(dot)).toContain("bg-red-500");
    // The dot sits IN the tag, in front of the job title.
    expect(dot.closest("[data-shift-tag]").textContent).toBe("Kok");
  });

  it("gives a published card its section's soft fill and keeps the solid 3px bar", () => {
    mount();
    const kitchen = cardIn("Jonas", 0); // Monday, published, Køkken
    for (const c of ["bg-red-50", "dark:bg-red-500/10", "ring-1", "ring-red-200", "border-l-[3px]", "border-red-500"]) {
      expect(tokens(kitchen)).toContain(c);
    }
    expect(tokens(kitchen)).not.toContain("outline-dashed");
    expect(kitchen.querySelector("[data-role-dot]")).toBeNull(); // the bar says it
    const bar = cardIn("Lars", 1); // Tuesday, Bar
    expect(tokens(bar)).toContain("bg-blue-50");
    expect(tokens(bar)).toContain("border-blue-500");
    const floor = cardIn("Mette", 0); // Monday, Gulv
    expect(tokens(floor)).toContain("bg-violet-50");
    expect(tokens(floor)).toContain("border-violet-500");
    // The emerald check is still there on the seen one…
    expect(within(kitchen).getByTitle("Set af medarbejderen")).toBeInTheDocument();
    // …and line 2 is gray-600, which clears 4.5:1 on the tints (gray-500 does not).
    expect(tokens(within(kitchen).getByText("8 t").parentElement)).toContain("text-gray-600");
  });

  it("keeps a published card white with the gray ring where there are no sections", () => {
    BUSINESS_TYPE = "retail";
    try {
      const { container } = mount();
      const cards = [...container.querySelectorAll("tbody div.rounded-lg")].filter(
        (el) => !tokens(el).includes("outline-dashed"),
      );
      expect(cards.length).toBeGreaterThan(0);
      for (const c of cards) {
        expect(tokens(c)).toContain("bg-white");
        expect(tokens(c)).toContain("ring-gray-200");
        expect(c.className).not.toMatch(/\bbg-(red|blue|violet)-50\b/);
      }
      // …and a retail draft carries no section dot either.
      expect(container.querySelector("[data-role-dot]")).toBeNull();
    } finally {
      BUSINESS_TYPE = "cafe";
    }
  });
});

describe("ScheduleGrid — the job-title tag on line 2", () => {
  it("prints the person's job title, translated, with the full word in title", () => {
    mount();
    const tag = cardIn("Jonas", 0).querySelector("[data-shift-tag]");
    expect(tag.textContent).toBe("Kok"); // stored "Chef" — the Danish word
    expect(tag.getAttribute("title")).toBe("Kok");
    expect(cardIn("Mette", 0).querySelector("[data-shift-tag]").textContent).toBe("Tjener");
    expect(cardIn("Lars", 1).querySelector("[data-shift-tag]").textContent).toBe("Bartender");
  });

  it("ends in an ellipsis rather than widening a narrow day column", () => {
    mount();
    const word = cardIn("Jonas", 0).querySelector("[data-shift-tag] span");
    expect(tokens(word)).toContain("line-clamp-1");
    expect(tokens(word)).toContain("[overflow-wrap:anywhere]");
  });

  it("falls back to the role name, then to the shift's role, and never invents one", () => {
    const staff = [
      { id: "a", name: "Anna", role: "kitchen", active: true }, // the section word IS the role
      { id: "b", name: "Bo", role: "", active: true },          // no title: the shift's role
      { id: "c", name: "Cille", role: "", active: true },       // nothing at all
    ];
    const list = [
      shift("a1", MON, "a"),
      shift("b1", MON, "b", { role_on_shift: "Server" }),
      shift("c1", MON, "c"),
    ];
    mount({ staff, getShiftsForCell: cellsFrom(list) });
    expect(cardIn("Anna", 0).querySelector("[data-shift-tag]").textContent).toBe("Køkken");
    expect(cardIn("Bo", 0).querySelector("[data-shift-tag]").textContent).toBe("Tjener");
    expect(cardIn("Cille", 0).querySelector("[data-shift-tag]")).toBeNull();
  });

  it("names the OTHER section on a cross-role shift, in that section's colours", () => {
    // A chef lent to the bar: "Kok" would be the wrong word on that card.
    const list = [shift("x1", MON, "k1", { role_on_shift: "Bartender" })];
    mount({ getShiftsForCell: cellsFrom(list) });
    const card = cardIn("Jonas", 0);
    expect(card.querySelector("[data-shift-tag]").textContent).toBe("Bar");
    expect(tokens(card)).toContain("bg-blue-50");
    expect(tokens(card)).toContain("border-blue-500");
  });
});

describe("ScheduleGrid — department pills", () => {
  const headerRow = (container, n) => container.querySelectorAll("tbody")[n].querySelector("tr");

  it("puts the section's shift count in a tinted pill with a real sentence behind it", () => {
    const { container } = mount();
    const kitchen = headerRow(container, 0);
    const mon = kitchen.querySelectorAll("td")[1].querySelector('[role="img"]');
    expect(mon.getAttribute("aria-label")).toBe("Køkken: 1 vagt");
    expect(mon.getAttribute("title")).toBe("Køkken: 1 vagt");
    expect(tokens(mon)).toContain("bg-red-100");
    expect(tokens(mon)).toContain("rounded-full");
    // The word from xl, the bare number below it (the day header's own rule).
    expect(within(mon).getByText("1 vagt").className).toContain("hidden xl:inline");
    expect(within(mon).getByText("1").className).toContain("xl:hidden");
    const bar = headerRow(container, 1);
    expect(tokens(bar.querySelectorAll("td")[2].querySelector('[role="img"]'))).toContain("bg-blue-100");
  });

  it("uses the amber 0 ONLY on a day the house is open, and never says understaffed", () => {
    const { container } = mount();
    const amberDays = (row) =>
      [...row.querySelectorAll("td")].slice(1, 8)
        .map((td, i) => (td.querySelector(".bg-amber-100") ? i : null))
        .filter((i) => i !== null);
    expect(amberDays(headerRow(container, 0))).toEqual([1]);    // Køkken: Tuesday only
    expect(amberDays(headerRow(container, 1))).toEqual([0, 2]); // Bar: Monday + Wednesday
    expect(amberDays(headerRow(container, 2))).toEqual([]);     // Gulv works all three
    // Thursday–Sunday nobody works at all: "—" under every section, no pill.
    for (let n = 0; n < 3; n++) {
      const cells = [...headerRow(container, n).querySelectorAll("td")].slice(4, 8);
      for (const td of cells) expect(td.textContent).toBe("—");
    }
    expect(container.textContent).not.toMatch(/underbemand|understaff/i);
  });
});

describe("ScheduleGrid — day gridlines", () => {
  it("rules every day column in the header, the bands, the body and the footer", () => {
    const { container } = mount();
    const dayCells = [
      ...[...container.querySelectorAll("thead th")].slice(1, 9),
      ...[...container.querySelectorAll("tbody tr")].flatMap((tr) => [...tr.querySelectorAll("td")].slice(1)),
      ...[...container.querySelectorAll("tfoot td")].slice(1),
    ];
    expect(dayCells.length).toBeGreaterThan(40);
    for (const td of dayCells) {
      expect(tokens(td)).toContain("border-l");
      expect(tokens(td)).toContain("border-gray-100");
      // dark: NOT gray-800 — that is the grid card's own colour in dark.
      expect(tokens(td)).toContain("dark:border-gray-700/50");
    }
    // The staff column has no line of its own (the section bar lives there).
    expect(tokens(container.querySelector("thead th"))).not.toContain("border-l");
  });

  it("keeps today's column tint", () => {
    const todayIdx = WEEK.findIndex((d) => iso(d) === iso(new Date()));
    mount();
    const td = screen.getByText("Jonas").closest("tr").querySelectorAll("td")[1 + todayIdx];
    expect(td.className).toContain("bg-gray-50/60");
  });
});

describe("ScheduleGrid — names that fit", () => {
  const LONG = [
    { id: "o", name: "Oscar Christensen", role: "kitchen", active: true, contract_type: "full" },
    { id: "m", name: "Magnus Madsen", role: "Chef", active: true, contract_type: "full" },
    { id: "b1", name: "Lars", role: "Bartender", active: true },
    { id: "f1", name: "Mette", role: "Server", active: true },
  ];

  it("shows the whole name — two lines at most, never cut at 104px", () => {
    mount({ staff: LONG, getShiftsForCell: () => [] });
    for (const name of ["Oscar Christensen", "Magnus Madsen"]) {
      const el = screen.getByText(name);
      expect(el.textContent).toBe(name);
      expect(el.getAttribute("title")).toBe(name);
      expect(tokens(el)).toContain("line-clamp-2");
      expect(tokens(el)).toContain("break-words");
      expect(tokens(el)).not.toContain("truncate");
      expect(el.className).not.toMatch(/max-w-\[/);
    }
  });

  it("keeps the badge and the fravær button on the name's first line, beside it", () => {
    mount({ staff: LONG, getShiftsForCell: () => [], onAbsence: vi.fn() });
    const name = screen.getByText("Oscar Christensen");
    const line = name.parentElement;
    expect(tokens(line)).toContain("items-start");
    const btn = within(line).getByRole("button", { name: "Registrér fravær for Oscar Christensen" });
    expect(tokens(btn)).toContain("shrink-0");
    // Same line as the name, AFTER it — a sibling in the flow, not an overlay.
    expect(btn.parentElement).toBe(line);
    expect(tokens(btn).some((c) => /^(absolute|fixed)$/.test(c))).toBe(false);
    expect(name.compareDocumentPosition(btn) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("drops a role word that only repeats the section header, keeps a real job title", () => {
    mount({ staff: LONG, getShiftsForCell: () => [] });
    const meta = (name) => screen.getByText(name).closest("td").querySelector(".text-\\[11px\\]");
    // Oscar's stored role is "kitchen" — under the Køkken band that is noise.
    expect(meta("Oscar Christensen").textContent).not.toContain("Køkken");
    expect(meta("Oscar Christensen").textContent).toContain("Fuldtid");
    // Magnus is a "Chef": a job title, not the header. It stays.
    expect(meta("Magnus Madsen").textContent).toContain("Kok");
  });

  it("keeps the role word when there is no section header to repeat", () => {
    const three = [LONG[0], LONG[2], LONG[3]]; // below the grouping gate
    const { container } = mount({ staff: three, getShiftsForCell: () => [] });
    expect(container.querySelectorAll("tbody")).toHaveLength(1);
    const meta = screen.getByText("Oscar Christensen").closest("td").querySelector(".text-\\[11px\\]");
    expect(meta.textContent).toContain("Køkken");
  });
});

describe("ScheduleGrid — the shift cards (seen marks)", () => {
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
