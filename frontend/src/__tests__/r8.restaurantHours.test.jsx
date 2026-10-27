/**
 * R8 — Restaurant hours, deeper (27 Oct 2026).
 *
 *  • R4  lunch and dinner on one day: "Tilføj periode" splits the day, × takes
 *        the second period away, "Brug mandag på alle" copies both; stored
 *        beside the old "HH:MM-HH:MM" (which a one-period day still is).
 *  • R8  the last booking time of each period, in words under the day's
 *        times ("Sidste booking 20.30 (auto) og 21.00") and settable; the
 *        rule behind "(auto)" said once; the owner's own pickers may start
 *        up to it.
 *  • R9  Starttider 15 / 30 / 60 on a restaurant's hours card, saved with
 *        its one Gem — which says when changes are not saved yet, and which
 *        day cannot be saved.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(), user: null,
}));
vi.mock("../services/api", () => ({
  default: {
    get: (...a) => h.get(...a), post: (...a) => h.post(...a), put: (...a) => h.put(...a),
    patch: (...a) => h.patch(...a), delete: (...a) => h.del(...a),
  },
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const t = (k, fb, vars) => {
    const v = typeof fb === "object" && fb ? fb : vars;
    let s = DA[k] ?? (typeof fb === "string" ? fb : k);
    if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
    return s;
  };
  return { useLanguage: () => ({ lang: "da", setLang: () => {}, t }), LanguageProvider: ({ children }) => children };
});
vi.mock("../hooks/useAuth", async (importOriginal) => {
  const real = await importOriginal();
  return { ...real, useAuth: () => ({ user: h.user, logout: vi.fn(), refreshUser: vi.fn() }) };
});
const ent = vi.hoisted(() => ({
  hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null,
  isAtCap: () => false, cap: () => -1,
}));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");
const H = await import("../utils/bookingHours");
const { openTimesFor, overrunsClose } = await import("../utils/bookingTimes");
const WeekHoursEditor = (await import("../components/reservations/WeekHoursEditor")).default;
const StartTimesChoice = (await import("../components/reservations/StartTimesChoice")).default;
const ReservationsPage = (await import("../pages/ReservationsPage")).default;

const t = (k, fb, vars) => {
  const v = typeof fb === "object" && fb ? fb : vars;
  let s = da[k] ?? (typeof fb === "string" ? fb : k);
  if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
  return s;
};
const settle = async (n = 10) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };

const P = (open, close, last = "") => ({ open, close, last });
const LUNCH_DINNER = [{ open: "11:30", close: "14:30" }, { open: "17:30", close: "22:00" }];
const TIERS = [{ up_to: 2, minutes: 90 }, { up_to: 4, minutes: 120 }];

beforeEach(() => {
  h.get.mockReset(); h.post.mockReset(); h.put.mockReset(); h.patch.mockReset(); h.del.mockReset();
  window.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

// ── The hours model (utils/bookingHours) ──────────────────────────────────
describe("reading and writing the week", () => {
  it("reads the old string, the new list and junk", () => {
    expect(H.readPeriods("17:00-22:00")).toEqual([P("17:00", "22:00")]);
    expect(H.readPeriods([{ open: "11:30", close: "14:30" }, { open: "17:30", close: "22:00", last: "21:00" }]))
      .toEqual([P("11:30", "14:30"), P("17:30", "22:00", "21:00")]);
    expect(H.readPeriods([{ open: "x", close: "14:30" }])).toBeNull();
    expect(H.readPeriods(42)).toBeNull();
    expect(H.readPeriods([P("08:00", "10:00"), P("11:00", "13:00"), P("17:00", "22:00")])).toHaveLength(2);
  });

  it("parses a stored week; a closed day keeps the suggestion to reopen on", () => {
    const w = H.parseBookingHours({ mon: "closed", tue: "16:00-22:00", fri: LUNCH_DINNER, sat: "junk" });
    expect(w.mon).toEqual({ closed: true, periods: [P("11:00", "22:00")] });
    expect(w.tue).toEqual({ closed: false, periods: [P("16:00", "22:00")] });
    expect(w.fri.periods).toEqual([P("11:30", "14:30"), P("17:30", "22:00")]);
    expect(w.sat).toEqual({ closed: false, periods: [P("11:00", "22:00")] });
  });

  it("writes the old string when it says it all, else the periods", () => {
    const w = H.defaultBookingHours();
    w.mon = { closed: true, periods: [P("11:00", "22:00")] };
    w.tue = { closed: false, periods: [P("17:30", "22:00", "21:00")] };
    w.fri = { closed: false, periods: [P("11:30", "14:30"), P("17:30", "22:00", "21:00")] };
    const out = H.serializeBookingHours(w);
    expect(out.mon).toBe("closed");
    expect(out.wed).toBe("11:00-22:00");
    expect(out.tue).toEqual([{ open: "17:30", close: "22:00", last: "21:00" }]);
    expect(out.fri).toEqual([{ open: "11:30", close: "14:30" }, { open: "17:30", close: "22:00", last: "21:00" }]);
    // A salon's card never sends a last booking time.
    const salon = H.serializeBookingHours(w, { withLast: false });
    expect(salon.tue).toBe("17:30-22:00");
    expect(salon.fri).toEqual([{ open: "11:30", close: "14:30" }, { open: "17:30", close: "22:00" }]);
  });

  it("round-trips", () => {
    const stored = { mon: "closed", tue: "16:00-22:00", wed: "16:00-22:00", thu: "16:00-22:00",
      fri: [{ open: "11:30", close: "14:30" }, { open: "17:30", close: "22:00", last: "21:00" }],
      sat: [{ open: "12:00", close: "23:00", last: "22:00" }], sun: "closed" };
    expect(H.serializeBookingHours(H.parseBookingHours(stored))).toEqual(stored);
  });

  it("counts a list-only week as saved", () => {
    expect(H.hasSavedBookingHours({ fri: LUNCH_DINNER })).toBe(true);
    expect(H.hasSavedBookingHours({ fri: "closed" })).toBe(true);
    expect(H.hasSavedBookingHours({ fri: [] })).toBe(false);
    expect(H.hasSavedBookingHours(null)).toBe(false);
  });

  it("seeds a Profile-hours day with every window and its last booking", () => {
    const w = H.cardBookingHours({}, {
      hoursDeclared: true,
      openHours: { mon: [["11:30", "14:30"], ["17:30", "22:00", "21:00"]], tue: [], wed: [], thu: [], fri: [], sat: [], sun: [] },
    });
    expect(w.mon.periods).toEqual([P("11:30", "14:30"), P("17:30", "22:00", "21:00")]);
    expect(w.tue.closed).toBe(true);
  });

  it("reads the start step as the engine does", () => {
    expect(H.slotStepOf({ slot_granularity_min: 30 })).toBe(30);
    expect(H.slotStepOf({ slot_granularity_min: "60" })).toBe(60);
    for (const junk of [1, 500, "abc", null, true, 30.5]) expect(H.slotStepOf({ slot_granularity_min: junk })).toBe(15);
    expect(H.slotStepOf(undefined)).toBe(15);
  });
});

describe("what the card cannot save", () => {
  const week = (fri) => ({ ...H.defaultBookingHours(), fri: { closed: false, periods: fri } });
  it("finds the first problem day, the server's own rules", () => {
    expect(H.hoursProblem(H.defaultBookingHours())).toBeNull();
    expect(H.hoursProblem(week([P("11:30", "15:00"), P("14:30", "22:00")]))).toEqual({ day: "fri", problem: "overlap" });
    expect(H.hoursProblem(week([P("", "22:00")]))).toEqual({ day: "fri", problem: "bad_time" });
    expect(H.hoursProblem(week([P("17:30", "22:00", "22:30")]))).toEqual({ day: "fri", problem: "last_outside" });
    expect(H.hoursProblem(week([P("17:30", "22:00", "16:00")]))).toEqual({ day: "fri", problem: "last_outside" });
    // Touching periods, a late second period and a last booking after midnight are fine.
    expect(H.hoursProblem(week([P("11:00", "15:00"), P("15:00", "22:00")]))).toBeNull();
    expect(H.hoursProblem(week([P("11:30", "14:30"), P("18:00", "02:00", "01:00")]))).toBeNull();
    // A salon's card never checks a last booking time it does not send.
    expect(H.hoursProblem(week([P("17:30", "22:00", "23:00")]), { withLast: false })).toBeNull();
    // A closed day is never checked.
    expect(H.hoursProblem({ ...H.defaultBookingHours(), fri: { closed: true, periods: [P("", "")] } })).toBeNull();
  });

  it("says it in words with the weekday", () => {
    expect(H.hoursProblemWords({ day: "fri", problem: "overlap" }, t, "da"))
      .toBe(da.rsvpHoursErrOverlap.replace("{day}", "Fredag"));
    expect(H.hoursProblemWords({ day: "tue", problem: "bad_time" }, t, "da")).toBe(da.rsvpHoursErrTime.replace("{day}", "Tirsdag"));
    expect(H.hoursProblemWords({ day: "tue", problem: "weird" }, t, "da")).toBe(da.rsvpHoursSaveError);
  });
});

describe("the last booking time", () => {
  it("lists the starts of a period on the grid", () => {
    expect(H.gridTimes(P("17:30", "19:00"), 30)).toEqual(["17:30", "18:00", "18:30", "19:00"]);
    expect(H.gridTimes(P("23:00", "00:30"), 30)).toEqual(["23:00", "23:30", "00:00", "00:30"]);
  });

  it("is closing minus the table time on the grid when automatic", () => {
    expect(H.autoLast(P("17:30", "22:00"), 30, 90)).toBe("20:30");
    expect(H.autoLast(P("17:30", "22:00"), 15, 120)).toBe("20:00");
    expect(H.autoLast(P("17:30", "21:45"), 60, 90)).toBe("19:30");
    expect(H.autoLast(P("12:00", "13:00"), 15, 90)).toBeNull();
  });

  it("follows a change of the period or the step", () => {
    expect(H.fitLast(P("17:30", "22:00", "21:15"), 60).last).toBe("20:30");
    expect(H.fitLast(P("17:30", "20:00", "21:00"), 30).last).toBe("");
    expect(H.fitLast(P("17:30", "22:00", "21:00"), 30).last).toBe("21:00");
    const w = { ...H.defaultBookingHours(), fri: { closed: false, periods: [P("17:30", "22:00", "21:00")] } };
    expect(H.snapLasts(w, 60).fri.periods[0].last).toBe("20:30");
  });

  it("is counted for two guests, or one at a shop", () => {
    expect(H.lastBookingSitting({ turn_time_tiers: TIERS })).toBe(90);
    expect(H.lastBookingSitting({ turn_time_tiers: [{ up_to: 1, minutes: 45 }, { up_to: 4, minutes: 120 }] }, { booksOne: true })).toBe(45);
  });
});

describe("adding a period", () => {
  it("splits a restaurant's long day into lunch and dinner", () => {
    expect(H.addPeriod([P("11:00", "22:00", "21:00")], "meal")).toEqual([P("11:00", "14:30"), P("17:30", "22:00", "21:00")]);
    expect(H.addPeriod([P("11:30", "14:30")], "meal")).toEqual([P("11:30", "14:30"), P("17:30", "22:00")]);
    expect(H.addPeriod([P("17:00", "22:00")], "meal")).toEqual([P("11:30", "14:30"), P("17:00", "22:00")]);
  });
  it("gives a salon a lunch break", () => {
    expect(H.addPeriod([P("09:00", "17:00")], "day")).toEqual([P("09:00", "12:00"), P("12:30", "17:00")]);
  });
  it("never goes past two, and × leaves one", () => {
    const two = [P("11:30", "14:30"), P("17:30", "22:00")];
    expect(H.addPeriod(two, "meal")).toBe(two);
    expect(H.removePeriod(two, 0)).toEqual([P("17:30", "22:00")]);
    expect(H.removePeriod([P("11:30", "14:30")], 0)).toEqual([P("11:30", "14:30")]);
  });
  it("shows example starts from the first open period", () => {
    const w = H.parseBookingHours({ mon: "closed", tue: "17:30-22:00" });
    expect(H.exampleStarts(w, 30, "da")).toEqual(["17.30", "18.00", "18.30"]);
    expect(H.exampleStarts(w, 60, "en")).toEqual(["17:30", "18:30", "19:30"]);
  });
});

// ── The owner's own pickers (utils/bookingTimes) ──────────────────────────
describe("the owner's pickers read the last booking time", () => {
  const FRI = "2026-11-06";
  it("offer up to a late last booking, past closing", () => {
    const o = openTimesFor(FRI, { fri: [["17:30", "22:00", "21:00"]] }, 90);
    expect(o.times).toContain("20:30");
    expect(o.times).toContain("21:00");
    expect(o.times).not.toContain("21:15");
    expect(overrunsClose([["17:30", "22:00", "21:00"]], "21:00", 90)).toBe(false);
    expect(overrunsClose([["17:30", "22:00", "21:00"]], "21:15", 90)).toBe(true);
  });
  it("keep the classic rule beside an early last booking", () => {
    const o = openTimesFor(FRI, { fri: [["17:30", "22:00", "20:00"]] }, 90);
    expect(o.times).toContain("20:15");
    expect(o.times).toContain("20:30");
    expect(o.times).not.toContain("20:45");
  });
  it("offer lunch and dinner, nothing between", () => {
    const o = openTimesFor(FRI, { fri: [["11:30", "14:30"], ["17:30", "22:00"]] }, 90);
    expect(o.times).toContain("13:00");
    expect(o.times).not.toContain("15:00");
    expect(o.times).toContain("17:30");
  });
});

// ── The editor ────────────────────────────────────────────────────────────
function EditorHarness({ initial, ...props }) {
  const [hours, setHours] = useState(initial);
  const setHourDay = (k, patch) => setHours((x) => ({ ...x, [k]: { ...x[k], ...patch } }));
  return (
    <>
      <WeekHoursEditor t={t} lang="da" hours={hours} setHourDay={setHourDay} {...props} />
      <pre data-testid="state">{JSON.stringify(H.serializeBookingHours(hours))}</pre>
    </>
  );
}
const stateOf = () => JSON.parse(screen.getByTestId("state").textContent);
const row = (k) => document.querySelector(`[data-day="${k}"]`);
const timesIn = (el) => [...el.querySelectorAll('input[type="time"]')].map((i) => i.value);

describe("the weekday rows", () => {
  it("splits a day with one tap and takes the second period away again", () => {
    render(<EditorHarness initial={H.defaultBookingHours()} allowAddPeriod addMode="meal" />);
    fireEvent.click(within(row("fri")).getByRole("button", { name: `${da.rsvpHoursAddPeriod}, Fredag` }));
    expect(timesIn(row("fri"))).toEqual(["11:00", "14:30", "17:30", "22:00"]);
    expect(stateOf().fri).toEqual([{ open: "11:00", close: "14:30" }, { open: "17:30", close: "22:00" }]);
    expect(within(row("fri")).queryByRole("button", { name: /Tilføj periode/ })).toBeNull();
    fireEvent.click(within(row("fri")).getByRole("button", { name: "Fjern 11.00–14.30" }));
    expect(stateOf().fri).toBe("17:30-22:00");
  });

  it("offers no extra period where the server cannot read one, but shows a stored one", () => {
    render(<EditorHarness initial={H.parseBookingHours({ fri: LUNCH_DINNER })} />);
    expect(screen.queryByRole("button", { name: /Tilføj periode/ })).toBeNull();
    expect(timesIn(row("fri"))).toEqual(["11:30", "14:30", "17:30", "22:00"]);
    expect(within(row("fri")).getByRole("button", { name: "Fjern 17.30–22.00" })).toBeTruthy();
  });

  it("says the last booking time in words and lets the owner pick it", () => {
    render(<EditorHarness initial={H.parseBookingHours({ fri: LUNCH_DINNER })} lastBooking={{ step: 30, sitting: 90 }} />);
    const fri = row("fri");
    expect(fri.textContent).toContain(da.rsvpLastBookingLabel);
    const dinner = screen.getByTestId("last-booking-fri-1");
    expect(dinner.options[dinner.selectedIndex].textContent).toBe("20.30 (auto)");
    expect(screen.getByTestId("last-booking-fri-0").options[0].textContent).toBe("13.00 (auto)");
    expect(dinner.getAttribute("aria-label")).toBe("Sidste booking, Fredag 17.30–22.00");
    fireEvent.change(dinner, { target: { value: "21:00" } });
    expect(stateOf().fri).toEqual([{ open: "11:30", close: "14:30" }, { open: "17:30", close: "22:00", last: "21:00" }]);
    // Closing earlier than the chosen time puts it back on automatic.
    fireEvent.change(within(fri).getAllByLabelText(da.rsvpHoursCloseAt2)[0], { target: { value: "20:30" } });
    expect(stateOf().fri[1]).toEqual({ open: "17:30", close: "20:30" });
  });

  it("warns when no sitting fits a period", () => {
    render(<EditorHarness initial={H.parseBookingHours({ fri: "12:00-13:00" })} lastBooking={{ step: 15, sitting: 90 }} />);
    expect(screen.getByTestId("last-booking-fri-0").options[0].textContent).toBe(da.rsvpLastBookingAutoNone);
    expect(row("fri").textContent).toContain("12.00–13.00 er kortere end bordtiden (90 min)");
  });

  it("marks the day that cannot be saved", () => {
    render(<EditorHarness initial={H.defaultBookingHours()} problemDay="tue" />);
    expect(row("tue").getAttribute("aria-invalid")).toBe("true");
    expect(row("mon").getAttribute("aria-invalid")).toBeNull();
  });
});

describe("Starttider on a restaurant's card", () => {
  it("offers 15, 30 and 60 with the guests' first times", () => {
    const pick = vi.fn();
    render(<StartTimesChoice t={t} lang="da" value={30} onPick={pick} hours={H.parseBookingHours({ mon: "closed", tue: "17:30-22:00" })} />);
    const radios = screen.getAllByRole("radio");
    expect(radios.map((r) => r.textContent)).toEqual(["Hvert 15. min", "Hvert 30. min", "Hvert 60. min"]);
    expect(radios[1].getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Gæsterne kan vælge 17.30, 18.00, 18.30 …")).toBeTruthy();
    fireEvent.click(radios[2]);
    expect(pick).toHaveBeenCalledWith(60);
  });
  it("shows an odd stored step as the one that applies", () => {
    render(<StartTimesChoice t={t} value={20} onPick={() => {}} hours={H.defaultBookingHours()} apptWords />);
    expect(screen.getAllByRole("radio").map((r) => r.textContent)).toContain("Hvert 20. min");
    expect(screen.getByText(/Kunderne kan vælge/)).toBeTruthy();
  });
});

// ── The Settings card on the page ─────────────────────────────────────────
const settingsBody = ({ bookingHours, shape = 2, extra = {}, settings = {} } = {}) => ({
  reservations_enabled: true, reservation_slug: "bistro", public_url: "https://www.bonbox.dk/bistro",
  business_name: "Bistro", hours_declared: !!bookingHours, closures: [], open_hours: {},
  ...(shape ? { hours_shape: shape } : {}),
  settings: {
    max_party_size: 10, group_request_threshold: 8, lead_time_min: 60, max_advance_days: 60,
    default_duration_min: 90, turn_time_tiers: TIERS, combine_enabled: true, guest_can_pick_table: false,
    slot_granularity_min: 15, ...(bookingHours ? { booking_hours: bookingHours } : {}), ...settings,
  },
  ...extra,
});
const pageRoutes = (body) => {
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") return Promise.resolve({ data: body });
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }], fixtures: [], book_has_entries: true } });
    if (url === "/reservations/book") return Promise.resolve({ data: { reservations: [], summary: { total: 0, covers: 0, by_status: {} } } });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    if (url.startsWith("/reservations/behandlinger")) return Promise.resolve({ data: { behandlinger: [] } });
    return Promise.resolve({ data: {} });
  });
  h.put.mockResolvedValue({ data: body });
};
const openSettings = async (type = "restaurant") => {
  h.user = { id: "u1", business_type: type, business_name: "Bistro", role: "owner" };
  render(<MemoryRouter initialEntries={["/reservations?tab=settings"]}><ReservationsPage /></MemoryRouter>);
  await screen.findAllByText(da.rsvpDayMon);
  await settle(8);
};
const hoursCard = () => screen.getByText(da.rsvpHoursTitle).closest("div.rounded-xl");
const saveHours = async () => {
  await act(async () => { fireEvent.click(within(hoursCard()).getByRole("button", { name: da.save })); });
  await settle(4);
};
const putBody = () => h.put.mock.calls.at(-1)?.[1];
const WEEK = { mon: "closed", tue: "17:00-22:00", wed: "17:00-22:00", thu: "17:00-22:00", fri: "17:00-22:00", sat: "12:00-23:00", sun: "closed" };

describe("the hours card in Indstillinger", () => {
  it("lunch + dinner on Friday, last booking 21.30 and every 30 min — one Gem", async () => {
    pageRoutes(settingsBody({ bookingHours: { ...WEEK, fri: "11:00-22:00" } }));
    await openSettings();
    expect(screen.queryByTestId("hours-unsaved")).toBeNull();
    fireEvent.click(within(row("fri")).getByRole("button", { name: `${da.rsvpHoursAddPeriod}, Fredag` }));
    expect(timesIn(row("fri"))).toEqual(["11:00", "14:30", "17:30", "22:00"]);
    fireEvent.click(within(screen.getByTestId("table-start-times-choice")).getByRole("radio", { name: "Hvert 30. min" }));
    fireEvent.change(screen.getByTestId("last-booking-fri-1"), { target: { value: "21:30" } });
    expect(screen.getByTestId("hours-unsaved").textContent).toBe(da.rsvpHoursUnsaved);
    expect(screen.getByTestId("last-booking-hint").textContent).toBe(da.rsvpLastBookingHint.replace("{min}", "90"));
    await saveHours();
    const body = putBody();
    expect(body.hours_shape).toBe(2);
    expect(body.settings.slot_granularity_min).toBe(30);
    expect(body.settings.booking_hours).toEqual({
      ...WEEK, fri: [{ open: "11:00", close: "14:30" }, { open: "17:30", close: "22:00", last: "21:30" }],
    });
  });

  it("a stored step is not sent again, and Brug mandag på alle copies both periods", async () => {
    pageRoutes(settingsBody({ bookingHours: { ...WEEK, mon: [{ open: "11:30", close: "14:30" }, { open: "17:30", close: "22:00", last: "21:00" }] } }));
    await openSettings();
    expect(screen.getByTestId("last-booking-mon-1").value).toBe("21:00");
    fireEvent.click(screen.getByText(da.rsvpHoursCopyMon));
    expect(timesIn(row("sat"))).toEqual(["11:30", "14:30", "17:30", "22:00"]);
    await saveHours();
    const sent = putBody().settings;
    expect("slot_granularity_min" in sent).toBe(false);
    expect(sent.booking_hours.sun).toEqual([{ open: "11:30", close: "14:30" }, { open: "17:30", close: "22:00", last: "21:00" }]);
  });

  it("overlapping periods never leave the card; it names the day", async () => {
    pageRoutes(settingsBody({ bookingHours: { ...WEEK, fri: [{ open: "11:30", close: "14:30" }, { open: "17:30", close: "22:00" }] } }));
    await openSettings();
    fireEvent.change(within(row("fri")).getAllByLabelText(da.rsvpHoursCloseAt)[0], { target: { value: "18:00" } });
    await saveHours();
    expect(h.put).not.toHaveBeenCalled();
    expect(within(hoursCard()).getByRole("alert").textContent).toBe(da.rsvpHoursErrOverlap.replace("{day}", "Fredag"));
    expect(row("fri").getAttribute("aria-invalid")).toBe("true");
  });

  it("a 422 bad_hours from the server is said in words, never as a code", async () => {
    pageRoutes(settingsBody({ bookingHours: WEEK }));
    await openSettings();
    h.put.mockRejectedValueOnce({ response: { status: 422, data: { detail: { error: "bad_hours", day: "sat", problem: "last_outside" } } } });
    fireEvent.change(within(row("tue")).getAllByLabelText(da.rsvpHoursOpenAt)[0], { target: { value: "16:00" } });
    await saveHours();
    expect(within(hoursCard()).getByRole("alert").textContent).toBe(da.rsvpHoursErrLast.replace("{day}", "Lørdag"));
    expect(document.body.textContent).not.toContain("bad_hours");
  });

  it("an older server: no extra period and no last booking, but Starttider", async () => {
    pageRoutes(settingsBody({ bookingHours: WEEK, shape: null }));
    await openSettings();
    expect(screen.queryByRole("button", { name: /Tilføj periode/ })).toBeNull();
    expect(screen.queryByTestId("last-booking-tue-0")).toBeNull();
    expect(screen.queryByTestId("last-booking-hint")).toBeNull();
    expect(screen.getByTestId("table-start-times")).toBeTruthy();
  });

  it("a salon: a lunch break, no last booking and no Starttider on this card", async () => {
    pageRoutes(settingsBody({ bookingHours: { mon: "closed", tue: "09:00-17:00", wed: "09:00-17:00", thu: "09:00-17:00", fri: "09:00-17:00", sat: "09:00-14:00", sun: "closed" }, settings: { group_request_threshold: 99 } }));
    await openSettings("salon");
    fireEvent.click(within(row("tue")).getByRole("button", { name: `${da.rsvpHoursAddPeriod}, Tirsdag` }));
    expect(timesIn(row("tue"))).toEqual(["09:00", "12:00", "12:30", "17:00"]);
    expect(screen.queryByTestId("last-booking-tue-0")).toBeNull();
    expect(screen.queryByTestId("table-start-times")).toBeNull();
    await saveHours();
    expect(putBody().settings.booking_hours.tue).toEqual([{ open: "09:00", close: "12:00" }, { open: "12:30", close: "17:00" }]);
    expect("slot_granularity_min" in putBody().settings).toBe(false);
  });
});

describe("the salon first-run card", () => {
  function firstRunRoutes(bookingHours) {
    h.get.mockImplementation((url) => {
      if (url === "/reservations/settings") {
        return Promise.resolve({ data: { reservations_enabled: false, reservation_slug: null, hours_declared: !!bookingHours, hours_shape: 2,
          settings: { group_request_threshold: 99, ...(bookingHours ? { booking_hours: bookingHours } : {}) }, closures: [] } });
      }
      if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [], fixtures: [], book_has_entries: false } });
      if (url === "/reservations/behandlinger") return Promise.resolve({ data: { behandlinger: [{ id: "b1", name: "Klip", duration_min: 30, active: true }] } });
      if (url === "/reservations/book") return Promise.resolve({ data: { reservations: [], summary: { total: 0, by_status: {} } } });
      return Promise.resolve({ data: {} });
    });
    h.post.mockResolvedValue({ data: {} });
  }
  const quickSetupBody = () => h.post.mock.calls.find(([u]) => u === "/reservations/salon/quick-setup")?.[1];

  it("shows a saved lunch break, offers no new period, and says it reads the shape", async () => {
    firstRunRoutes({ tue: [{ open: "09:00", close: "12:00" }, { open: "12:30", close: "17:00" }] });
    h.user = { id: "u1", business_type: "salon", business_name: "Saks", role: "owner" };
    render(<MemoryRouter initialEntries={["/reservations"]}><ReservationsPage /></MemoryRouter>);
    await settle(12);
    expect(timesIn(row("tue"))).toEqual(["09:00", "12:00", "12:30", "17:00"]);
    expect(screen.queryByRole("button", { name: /Tilføj periode/ })).toBeNull();
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(da.rsvpSalonOpenForBooking) })); });
    await settle(4);
    const body = quickSetupBody();
    expect(body.hours_shape).toBe(2);
    expect(body.replace_hours).toBe(false);
    expect(body.booking_hours.tue).toEqual([{ open: "09:00", close: "12:00" }, { open: "12:30", close: "17:00" }]);
  });

  it("an overlap stops the tap with the day's words", async () => {
    firstRunRoutes({ tue: [{ open: "09:00", close: "12:00" }, { open: "12:30", close: "17:00" }] });
    h.user = { id: "u1", business_type: "salon", business_name: "Saks", role: "owner" };
    render(<MemoryRouter initialEntries={["/reservations"]}><ReservationsPage /></MemoryRouter>);
    await settle(12);
    fireEvent.change(within(row("tue")).getAllByLabelText(da.rsvpHoursCloseAt)[0], { target: { value: "13:00" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(da.rsvpSalonOpenForBooking) })); });
    await settle(4);
    expect(quickSetupBody()).toBeUndefined();
    expect(document.body.textContent).toContain(da.rsvpHoursErrOverlap.replace("{day}", "Tirsdag"));
  });
});

// ── The words ─────────────────────────────────────────────────────────────
describe("the R8 words", () => {
  const KEYS = [
    "rsvpHoursAddPeriod", "rsvpHoursAddPeriodAria", "rsvpHoursRemovePeriod", "rsvpHoursOpenAt2", "rsvpHoursCloseAt2",
    "rsvpLastBookingLabel", "rsvpLastBookingAnd", "rsvpLastBookingAuto", "rsvpLastBookingAutoNone", "rsvpLastBookingFor",
    "rsvpLastBookingNoneFits", "rsvpLastBookingNoneFitsAppt", "rsvpLastBookingHint", "rsvpLastBookingHintAppt",
    "rsvpStartTimesExampleGuests", "rsvpHoursUnsaved", "rsvpHoursErrOverlap", "rsvpHoursErrTime", "rsvpHoursErrLast",
    "rsvpHoursErrTooMany",
  ];
  it("every key has real en and da text", () => {
    for (const k of KEYS) {
      expect(typeof en[k], k).toBe("string");
      expect(typeof da[k], k).toBe("string");
      expect(en[k].length, k).toBeGreaterThan(1);
      expect(da[k].length, k).toBeGreaterThan(1);
    }
    // Danish is Danish (not the English copied over), bar the two that read the same.
    for (const k of KEYS.filter((x) => !["rsvpLastBookingAuto"].includes(x))) expect(da[k], k).not.toBe(en[k]);
    // The placeholders match in both languages.
    for (const k of KEYS) {
      const vars = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
      expect(vars(da[k]), k).toEqual(vars(en[k]));
    }
  });
});
