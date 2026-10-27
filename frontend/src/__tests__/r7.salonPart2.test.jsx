/**
 * R7 — Salon, part 2 (27 Oct 2026).
 *
 *  • S5  per day, "2 kan bookes samtidig (dig og Mia)": the next 7 days on
 *        Behandlere, the day shown on Aftaler.
 *  • S11 a stylist by name from Behandlere — one POST makes the person and
 *        her chair; the Free plan's 3-staff lock; booked on the opening
 *        hours or on her shifts.
 *  • S12 every chair renamed in place (the owner's own too — never the
 *        business name), the salon's hours suggestion (not 11–22), and all
 *        five Tidsbestilling tabs on a 390 px phone.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(),
  user: null, confirm: vi.fn(),
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
// Stable references, as the real provider gives (the page's effects depend
// on hasFeature). `atCap` is flipped per test.
const ent = vi.hoisted(() => ({
  hasFeature: () => true, isReady: true, plan: "free", minPlanForFeature: () => null,
  atCap: false,
  isAtCap(key) { return key === "staff_members" && this.atCap; },
  cap: (key) => (key === "staff_members" ? 3 : -1),
}));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => h.confirm }));

const { da } = await import("../i18n/da");
const { en } = await import("../i18n/en");
const CapMod = await import("../components/reservations/SalonCapacity");
const SalonWeekCapacity = CapMod.default;
const { SalonDayCapacity, capacityText, joinNames, awayText, hoursClosedNote, peopleNames } = CapMod;
const RowMod = await import("../components/reservations/StylistRow");
const StylistRow = RowMod.default;
const { stylistChanges, isOwnChair, namedAfterBusiness, tidyName } = RowMod;
const AddMod = await import("../components/reservations/StylistAddCard");
const StylistAddCard = AddMod.default;
const { addRefusal } = AddMod;
const TabPills = (await import("../components/ui/TabPills")).default;
const ReservationsPage = (await import("../pages/ReservationsPage")).default;

// The same t the components get from the page: DA strings, {vars} filled.
const t = (k, fb, vars) => {
  const v = typeof fb === "object" && fb ? fb : vars;
  let s = da[k] ?? (typeof fb === "string" ? fb : k);
  if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
  return s;
};
const tEn = (k, fb, vars) => {
  const v = typeof fb === "object" && fb ? fb : vars;
  let s = en[k] ?? (typeof fb === "string" ? fb : k);
  if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
  return s;
};
const settle = async (n = 8) => { for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); }); };
const withRouter = (ui) => render(<MemoryRouter>{ui}</MemoryRouter>);

beforeEach(() => {
  for (const f of [h.get, h.post, h.put, h.patch, h.del, h.confirm]) f.mockReset();
  h.confirm.mockResolvedValue(true);
  h.del.mockResolvedValue({ data: { ok: true } });
  ent.atCap = false;
  h.user = { id: "u1", business_type: "salon", business_name: "Frisør Saks", role: "owner" };
  localStorage.clear();
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  window.scrollTo = () => {};
  if (!globalThis.IntersectionObserver) {
    globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} takeRecords() { return []; } };
  }
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

const YOU = { id: "c0", name: "Anna", self: true, windows: [["09:00", "17:00"]] };
const MIA = { id: "c1", name: "Mia", self: false, windows: [["10:00", "16:00"]] };
const JONAS = { id: "c2", name: "Jonas", self: false, windows: [["12:00", "17:00"]] };
const day = (over = {}) => ({
  date: "2026-10-30", count: 0, people: [], away: [], hours_closed: false, closed: null, note: null, ...over,
});

// ── The day in words (S5) ─────────────────────────────────────────────────
describe("capacityText", () => {
  it("says 2 kan bookes samtidig (dig og Mia), the owner's chair first as 'dig'", () => {
    expect(capacityText(day({ count: 2, people: [MIA, YOU] }), t, "da")).toBe("2 kan bookes samtidig (dig og Mia)");
    expect(capacityText(day({ count: 3, people: [MIA, YOU, JONAS] }), t, "da"))
      .toBe("3 kan bookes samtidig (dig, Mia og Jonas)");
  });
  it("says 'op til' when not everyone is in at the same time, and 'én ad gangen' on shifts that follow each other", () => {
    expect(capacityText(day({ count: 2, people: [YOU, MIA, JONAS] }), t, "da"))
      .toBe("Op til 2 kan bookes samtidig (dig, Mia og Jonas)");
    expect(capacityText(day({ count: 1, people: [MIA, JONAS] }), t, "da"))
      .toBe("Én ad gangen (Mia og Jonas på skift)");
  });
  it("names the only one", () => {
    expect(capacityText(day({ count: 1, people: [YOU] }), t, "da")).toBe("Kun dig kan bookes");
    expect(capacityText(day({ count: 1, people: [MIA] }), t, "da")).toBe("Kun Mia kan bookes");
  });
  it("says nobody, a closed day, a closed date with its note, and a pause", () => {
    expect(capacityText(day(), t, "da")).toBe("Ingen kan bookes");
    expect(capacityText(day({ hours_closed: true }), t, "da")).toBe("Lukket — ingen kan bookes");
    expect(capacityText(day({ closed: "closed_date", note: "Kursus", people: [YOU] }), t, "da"))
      .toBe("Lukket for online booking: Kursus");
    expect(capacityText(day({ closed: "closed_date" }), t, "da")).toBe("Lukket for online booking");
    expect(capacityText(day({ closed: "paused" }), t, "da")).toBe("Online booking er sat på pause");
  });
  it("reads in English too", () => {
    expect(capacityText(day({ count: 2, people: [MIA, YOU] }), tEn, "en")).toBe("2 can be booked at the same time (you and Mia)");
    expect(joinNames(["you", "Mia", "Jonas"], "en")).toBe("you, Mia, and Jonas");
    expect(joinNames(["dig", "Mia", "Jonas"], "da")).toBe("dig, Mia og Jonas");
    expect(joinNames(["Mia"], "da")).toBe("Mia");
    expect(peopleNames(day({ people: [MIA, YOU] }), t)).toEqual(["dig", "Mia"]);
  });
  it("names who is away, and a shift on a day the hours say closed", () => {
    expect(awayText(day({ away: [{ id: "c1", name: "Mia", kind: "ferie" }, { id: "c2", name: "Jonas", kind: "sick" }] }), t))
      .toBe("Fravær: Mia (Ferie), Jonas (Syg)");
    expect(awayText(day(), t)).toBe("");
    expect(hoursClosedNote(day({ hours_closed: true, count: 1, people: [MIA] }), t)).toBe(da.rsvpCapacityHoursClosedShift);
    expect(hoursClosedNote(day({ hours_closed: true }), t)).toBe("");
    expect(hoursClosedNote(day({ count: 1, people: [MIA] }), t)).toBe("");
  });
});

describe("Hvem kan bookes — the week on Behandlere", () => {
  const WEEK = Array.from({ length: 7 }, (_, i) => day({
    date: `2026-10-${String(27 + i).padStart(2, "0")}`,
    ...(i === 3 ? { count: 2, people: [MIA, YOU], away: [{ id: "c2", name: "Jonas", kind: "ferie" }] } : {}),
  }));
  it("shows each day with its line", async () => {
    h.get.mockResolvedValue({ data: { start: "2026-10-27", days: WEEK } });
    render(<SalonWeekCapacity t={t} lang="da" />);
    await settle();
    expect(h.get).toHaveBeenCalledWith("/reservations/salon/capacity", { params: { days: 7 } });
    const rows = screen.getAllByTestId("salon-capacity-day");
    expect(rows).toHaveLength(7);
    expect(rows[3].textContent).toContain("2 kan bookes samtidig (dig og Mia)");
    expect(rows[3].textContent).toContain("Fravær: Jonas (Ferie)");
    expect(rows[0].textContent).toContain("Ingen kan bookes");
    expect(screen.getByText(da.rsvpCapacityWeekTitle)).toBeInTheDocument();
  });
  it("says when the opening hours are not saved, with the way to save them", async () => {
    h.get.mockResolvedValue({ data: { days: WEEK, follows_hours: true, hours_saved: false } });
    withRouter(<SalonWeekCapacity t={t} lang="da" />);
    await settle();
    const note = screen.getByTestId("salon-capacity-no-hours");
    expect(note.textContent).toContain(da.rsvpCapacityNoHours);
    expect(within(note).getByRole("link").getAttribute("href")).toBe("/reservations?tab=settings");
  });
  it("no such note once the hours are saved, or with no one on the hours", async () => {
    h.get.mockResolvedValue({ data: { days: WEEK, follows_hours: true, hours_saved: true } });
    const { unmount } = withRouter(<SalonWeekCapacity t={t} lang="da" />);
    await settle();
    expect(screen.queryByTestId("salon-capacity-no-hours")).toBeNull();
    unmount();
    h.get.mockResolvedValue({ data: { days: WEEK, follows_hours: false, hours_saved: false } });
    withRouter(<SalonWeekCapacity t={t} lang="da" />);
    await settle();
    expect(screen.queryByTestId("salon-capacity-no-hours")).toBeNull();
  });
  it("a failed read shows nothing", async () => {
    h.get.mockRejectedValue(new Error("Network Error"));
    render(<SalonWeekCapacity t={t} lang="da" />);
    await settle();
    expect(screen.queryByTestId("salon-week-capacity")).toBeNull();
  });
  it("reads again when a stylist changes", async () => {
    h.get.mockResolvedValue({ data: { days: WEEK } });
    const { rerender } = render(<SalonWeekCapacity t={t} lang="da" refreshKey={0} />);
    await settle();
    rerender(<SalonWeekCapacity t={t} lang="da" refreshKey={1} />);
    await settle();
    expect(h.get).toHaveBeenCalledTimes(2);
  });
});

describe("the day line on Aftaler", () => {
  it("asks for the day shown and says it", async () => {
    h.get.mockResolvedValue({ data: { days: [day({ date: "2026-10-30", count: 2, people: [MIA, YOU] })] } });
    render(<SalonDayCapacity t={t} lang="da" day="2026-10-30" />);
    await settle();
    expect(h.get).toHaveBeenCalledWith("/reservations/salon/capacity", { params: { start: "2026-10-30", days: 1 } });
    expect(screen.getByTestId("salon-day-capacity").textContent).toBe("2 kan bookes samtidig (dig og Mia)");
  });
  it("never shows an answer for another day", async () => {
    h.get.mockResolvedValue({ data: { days: [day({ date: "2026-10-29", count: 1, people: [YOU] })] } });
    render(<SalonDayCapacity t={t} lang="da" day="2026-10-30" />);
    await settle();
    expect(screen.queryByTestId("salon-day-capacity")).toBeNull();
  });
  it("a failed read shows nothing", async () => {
    h.get.mockRejectedValue(new Error("x"));
    render(<SalonDayCapacity t={t} lang="da" day="2026-10-30" />);
    await settle();
    expect(screen.queryByTestId("salon-day-capacity")).toBeNull();
  });
});

// ── A stylist by name (S11) ───────────────────────────────────────────────
describe("Tilføj en behandler", () => {
  const added = (over = {}) => ({
    data: {
      resource: { id: "r9", kind: "provider", label: "Mia", staff_id: "s9", follows_opening_hours: true, is_active: true, staff_name: "Mia" },
      staff: { id: "s9", name: "Mia" }, created_staff: true, activation: null, ...over,
    },
  });
  const typeName = (v) => fireEvent.change(screen.getByLabelText(da.rsvpStylistNameLabel), { target: { value: v } });
  const tapAdd = async () => { await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpStylistAddBtn })); }); await settle(); };

  it("a name and one tap: one POST, booked whenever the salon is open", async () => {
    h.post.mockResolvedValue(added());
    const onAdded = vi.fn();
    withRouter(<StylistAddCard t={t} defaultFollows onAdded={onAdded} />);
    expect(screen.getByRole("radio", { name: da.rsvpStylistModeHours })).toHaveAttribute("aria-checked", "true");
    typeName("  Mia ");
    await tapAdd();
    expect(h.post).toHaveBeenCalledTimes(1);
    expect(h.post).toHaveBeenCalledWith("/reservations/salon/stylists", { name: "Mia", follows_opening_hours: true });
    expect(onAdded).toHaveBeenCalledWith(added().data);
    expect(screen.getByTestId("stylist-added").textContent).toBe("Mia er tilføjet og kan bookes, når salonen har åbent.");
    expect(screen.getByLabelText(da.rsvpStylistNameLabel).value).toBe("");
  });

  it("on shifts: says so and links to Vagtplan", async () => {
    h.post.mockResolvedValue(added({ resource: { id: "r9", staff_id: "s9", follows_opening_hours: false } }));
    withRouter(<StylistAddCard t={t} defaultFollows={false} />);
    expect(screen.getByRole("radio", { name: da.rsvpStylistModeShifts })).toHaveAttribute("aria-checked", "true");
    expect(screen.getByText(da.rsvpStylistModeShiftsHint)).toBeInTheDocument();
    typeName("Mia");
    await tapAdd();
    expect(h.post.mock.calls[0][1]).toEqual({ name: "Mia", follows_opening_hours: false });
    const done = screen.getByTestId("stylist-added");
    expect(done.textContent).toContain("Mia er tilføjet og kan bookes i sine udgivne vagter.");
    expect(within(done).getByRole("link").getAttribute("href")).toBe("/staff/schedule");
  });

  it("the owner's pick is never replaced by a default that arrives later", async () => {
    const { rerender } = withRouter(<StylistAddCard t={t} defaultFollows />);
    fireEvent.click(screen.getByRole("radio", { name: da.rsvpStylistModeShifts }));
    rerender(<MemoryRouter><StylistAddCard t={t} defaultFollows /></MemoryRouter>);
    expect(screen.getByRole("radio", { name: da.rsvpStylistModeShifts })).toHaveAttribute("aria-checked", "true");
  });

  it("a blank name is refused on the spot", async () => {
    withRouter(<StylistAddCard t={t} />);
    typeName("   ");
    await tapAdd();
    expect(h.post).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toBe(da.rsvpStylistNameRequired);
  });

  it("the Free plan's staff lock: the plan's words and the way up, nothing added", async () => {
    h.post.mockRejectedValue({ response: { status: 402, data: { detail: { error: "cap_exceeded", cap: "staff_members", limit: 3, current: 3, upgrade_to: "starter" } } } });
    const onAdded = vi.fn();
    withRouter(<StylistAddCard t={t} onAdded={onAdded} />);
    typeName("Ny");
    await tapAdd();
    const alert = screen.getByRole("alert");
    expect(alert.textContent).toContain("Din plan har plads til 3 medarbejdere, og alle pladser er brugt.");
    expect(within(alert).getByRole("link").getAttribute("href")).toBe("/subscription");
    expect(onAdded).not.toHaveBeenCalled();
  });

  it("a stylist who is already there is named", async () => {
    h.post.mockRejectedValue({ response: { status: 409, data: { detail: { error: "stylist_exists", name: "Mia", resource_id: "r1" } } } });
    withRouter(<StylistAddCard t={t} />);
    typeName("mia");
    await tapAdd();
    expect(screen.getByRole("alert").textContent).toBe("Mia er allerede behandler.");
  });

  it("at the staff lock the form gives way to the plan's words", () => {
    withRouter(<StylistAddCard t={t} staffCap={{ limit: 3, upgradeTo: "starter" }} />);
    expect(screen.queryByLabelText(da.rsvpStylistNameLabel)).toBeNull();
    const cap = screen.getByTestId("stylist-staff-cap");
    expect(cap.textContent).toContain("Din plan har plads til 3 medarbejdere");
    expect(within(cap).getByRole("link").getAttribute("href")).toBe("/subscription");
  });

  it("addRefusal reads the server's refusals", () => {
    expect(addRefusal({ status: 402, data: { detail: { cap: "bookable_resources_max", limit: 3, upgrade_to: "starter" } } }, "X", t))
      .toEqual({ cap: "bookable_resources_max", text: "Din plan har plads til 3 stole, og alle er brugt. Opgrader for at tilføje flere.", upgradeTo: "starter" });
    expect(addRefusal({ status: 422, data: { detail: { error: "name_too_long" } } }, "X", t).text).toBe(da.rsvpStylistNameTooLong);
    expect(addRefusal({ status: 500, data: {} }, "X", t)).toBeNull();
  });
});

// ── A chair renamed in place (S12) ───────────────────────────────────────
describe("stylistChanges", () => {
  const OWN = { id: "c0", kind: "provider", label: "Frisør Saks", staff_id: null, follows_opening_hours: true };
  const STAFF = { id: "c1", kind: "provider", label: "Mia", staff_id: "s1", follows_opening_hours: false };
  it("sends only what changed", () => {
    expect(stylistChanges(OWN, "Frisør Saks", { name: " Anna ", follows: true })).toEqual({ changes: { name: "Anna" } });
    expect(stylistChanges(STAFF, "Mia", { name: "Mia", follows: true })).toEqual({ changes: { follows_opening_hours: true } });
    expect(stylistChanges(STAFF, "Mia", { name: "Mia", follows: false })).toEqual({ changes: {} });
  });
  it("never switches the owner's own chair off the opening hours", () => {
    expect(stylistChanges(OWN, "Frisør Saks", { name: "Frisør Saks", follows: false })).toEqual({ changes: {} });
  });
  it("refuses a blank or too long name", () => {
    expect(stylistChanges(OWN, "x", { name: "   " })).toEqual({ error: "name" });
    expect(stylistChanges(OWN, "x", { name: "x".repeat(81) })).toEqual({ error: "too_long" });
  });
  it("knows the owner's chair and one still called after the business", () => {
    expect(isOwnChair(OWN)).toBe(true);
    expect(isOwnChair(STAFF)).toBe(false);
    expect(isOwnChair({ ...STAFF, follows_opening_hours: true })).toBe(false);   // a stylist on the hours
    expect(namedAfterBusiness(OWN, " frisør saks ")).toBe(true);
    expect(namedAfterBusiness({ ...OWN, label: "Anna" }, "Frisør Saks")).toBe(false);
    expect(namedAfterBusiness(STAFF, "Mia")).toBe(false);
    expect(tidyName("  Mia \t Holm ")).toBe("Mia Holm");
  });
});

describe("a chair row", () => {
  const OWN = { id: "c0", kind: "provider", label: "Frisør Saks", staff_id: null, follows_opening_hours: true, is_active: true };
  const MIA_ROW = { id: "c1", kind: "provider", label: "Mia", staff_id: "s1", follows_opening_hours: false, is_active: true };
  const row = (props) => render(<ul><StylistRow t={t} businessName="Frisør Saks" {...props} /></ul>);

  it("the owner's own chair: her name, 'dig', the opening hours — and a nudge while it is the business name", () => {
    row({ r: OWN });
    const li = screen.getByTestId("stylist-row");
    expect(li.textContent).toContain("Frisør Saks");
    expect(li.textContent).toContain("(dig)");
    expect(li.textContent).toContain(da.rsvpProviderFollowsHours);
    expect(screen.getByTestId("self-chair-business-name").textContent).toBe(da.rsvpSelfChairNamedAfterBusiness);
  });

  it("renames the owner's chair in two taps and typing; no booking choice for it", async () => {
    h.patch.mockResolvedValue({ data: { ...OWN, label: "Anna", staff_name: null } });
    const onSaved = vi.fn();
    row({ r: OWN, onSaved });
    fireEvent.click(screen.getByTestId("stylist-edit"));
    expect(screen.queryByRole("radiogroup")).toBeNull();
    fireEvent.change(screen.getByLabelText(da.rsvpStylistNameLabel), { target: { value: "Anna" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.save })); });
    await settle();
    expect(h.patch).toHaveBeenCalledWith("/reservations/salon/stylists/c0", { name: "Anna" });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ id: "c0", label: "Anna" }));
  });

  it("a stylist on shifts: 'Efter vagtplan', and she can switch to the opening hours", async () => {
    h.patch.mockResolvedValue({ data: { ...MIA_ROW, follows_opening_hours: true, staff_name: "Mia" } });
    const onSaved = vi.fn();
    row({ r: MIA_ROW, staffName: "Mia", onSaved });
    expect(screen.getByTestId("stylist-row").textContent).toContain(da.rsvpStylistByShifts);
    expect(screen.queryByTestId("self-chair-business-name")).toBeNull();
    fireEvent.click(screen.getByTestId("stylist-edit"));
    expect(screen.getByText(da.rsvpStylistRenameHint)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("radio", { name: da.rsvpStylistModeHours }));
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.save })); });
    await settle();
    expect(h.patch).toHaveBeenCalledWith("/reservations/salon/stylists/c1", { follows_opening_hours: true });
    expect(onSaved).toHaveBeenCalledWith(expect.objectContaining({ follows_opening_hours: true }));
  });

  it("renaming a stylist sends her new name", async () => {
    h.patch.mockResolvedValue({ data: { ...MIA_ROW, label: "Mia Holm", staff_name: "Mia Holm" } });
    row({ r: MIA_ROW, staffName: "Mia" });
    fireEvent.click(screen.getByTestId("stylist-edit"));
    fireEvent.change(screen.getByLabelText(da.rsvpStylistNameLabel), { target: { value: "Mia Holm" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.save })); });
    await settle();
    expect(h.patch).toHaveBeenCalledWith("/reservations/salon/stylists/c1", { name: "Mia Holm" });
  });

  it("a blank name is refused on the spot; Escape leaves it as it was", () => {
    row({ r: OWN });
    fireEvent.click(screen.getByTestId("stylist-edit"));
    const input = screen.getByLabelText(da.rsvpStylistNameLabel);
    fireEvent.change(input, { target: { value: "  " } });
    fireEvent.click(screen.getByRole("button", { name: da.save }));
    expect(screen.getByRole("alert").textContent).toBe(da.rsvpStylistNameRequired);
    expect(h.patch).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByLabelText(da.rsvpStylistNameLabel)).toBeNull();
    expect(screen.getByTestId("stylist-row").textContent).toContain("Frisør Saks");
  });

  it("a failed save says so and keeps the form", async () => {
    h.patch.mockRejectedValue({ response: { status: 500 } });
    row({ r: OWN });
    fireEvent.click(screen.getByTestId("stylist-edit"));
    fireEvent.change(screen.getByLabelText(da.rsvpStylistNameLabel), { target: { value: "Anna" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.save })); });
    await settle();
    expect(screen.getByRole("alert").textContent).toBe(da.rsvpStylistSaveError);
    expect(screen.getByLabelText(da.rsvpStylistNameLabel).value).toBe("Anna");
  });

  it("delete goes to the page's confirm", () => {
    const onRemove = vi.fn();
    row({ r: MIA_ROW, staffName: "Mia", onRemove });
    fireEvent.click(screen.getByRole("button", { name: da.delete }));
    expect(onRemove).toHaveBeenCalledWith(MIA_ROW);
  });
});

// ── Behandlere, wired on the page ────────────────────────────────────────
describe("the Behandlere tab", () => {
  let resources;
  let staff;
  const SETTINGS = {
    reservations_enabled: true, reservation_slug: "saks", public_url: "https://www.bonbox.dk/saks",
    business_name: "Frisør Saks", hours_declared: true, closures: [],
    settings: { group_request_threshold: 99, booking_hours: { tue: "09:00-17:00" } },
  };
  function routes() {
    h.get.mockImplementation((url) => {
      if (url === "/reservations/settings") return Promise.resolve({ data: SETTINGS });
      if (url === "/reservations/resources") return Promise.resolve({ data: { resources, fixtures: [], book_has_entries: true } });
      if (url === "/staff/members") return Promise.resolve({ data: staff });
      if (url === "/reservations/salon/capacity") return Promise.resolve({ data: { days: [day({ count: 1, people: [YOU] })] } });
      if (url.startsWith("/reservations/behandlinger")) return Promise.resolve({ data: { behandlinger: [] } });
      return Promise.resolve({ data: {} });
    });
  }
  const openTab = async (path = "/reservations?tab=floor") => {
    routes();
    render(<MemoryRouter initialEntries={[path]}><ReservationsPage /></MemoryRouter>);
    await settle(12);
  };
  const capacityReads = () => h.get.mock.calls.filter(([u]) => u === "/reservations/salon/capacity").length;

  beforeEach(() => {
    resources = [
      { id: "c0", kind: "provider", label: "Anna", staff_id: null, follows_opening_hours: true, is_active: true, sort_order: 0 },
      { id: "c1", kind: "provider", label: "Mia", staff_id: "s1", follows_opening_hours: false, is_active: true, sort_order: 1 },
    ];
    staff = [{ id: "s1", name: "Mia" }, { id: "s2", name: "Jonas" }];
  });

  it("adds a stylist by name: her row appears and the week is read again", async () => {
    await openTab();
    expect(screen.getByTestId("salon-week-capacity")).toBeInTheDocument();
    // The salon already runs Mia on shifts → a new stylist starts on shifts.
    expect(screen.getByRole("radio", { name: da.rsvpStylistModeShifts })).toHaveAttribute("aria-checked", "true");
    const before = capacityReads();
    h.post.mockResolvedValue({ data: {
      resource: { id: "c9", kind: "provider", label: "Ida", staff_id: "s9", follows_opening_hours: false, is_active: true, staff_name: "Ida" },
      staff: { id: "s9", name: "Ida" }, created_staff: true,
    } });
    fireEvent.change(screen.getByLabelText(da.rsvpStylistNameLabel), { target: { value: "Ida" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpStylistAddBtn })); });
    await settle(8);
    expect(h.post).toHaveBeenCalledWith("/reservations/salon/stylists", { name: "Ida", follows_opening_hours: false });
    expect(screen.getAllByTestId("stylist-row").map((li) => li.textContent).join("|")).toContain("Ida");
    expect(capacityReads()).toBeGreaterThan(before);
  });

  it("a salon with only the owner's chair starts a new stylist on the opening hours", async () => {
    resources = [resources[0]];
    staff = [];
    await openTab();
    expect(screen.getByRole("radio", { name: da.rsvpStylistModeHours })).toHaveAttribute("aria-checked", "true");
  });

  it("the Vagtplan picker offers only people without a chair, and goes when there are none", async () => {
    await openTab();
    const picker = screen.getByTestId("stylist-from-roster");
    const options = [...picker.querySelectorAll("option")].map((o) => o.textContent);
    expect(options).toContain("Jonas");
    expect(options).not.toContain("Mia");
    cleanup();
    staff = [{ id: "s1", name: "Mia" }];
    await openTab();
    expect(screen.queryByTestId("stylist-from-roster")).toBeNull();
  });

  it("at the Free plan's staff lock the add form gives way to the plan's words", async () => {
    ent.atCap = true;
    await openTab();
    expect(screen.getByTestId("stylist-staff-cap")).toBeInTheDocument();
    expect(screen.queryByLabelText(da.rsvpStylistNameLabel)).toBeNull();
  });

  it("removing a stylist's chair says she stays on the Vagtplan roster", async () => {
    await openTab();
    const miaRow = screen.getAllByTestId("stylist-row").find((li) => li.textContent.includes("Mia"));
    await act(async () => { fireEvent.click(within(miaRow).getByRole("button", { name: da.delete })); });
    await settle();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.confirm.mock.calls[0][0].message).toContain("Mia bliver stående på medarbejderlisten i Vagtplan.");
    expect(h.del).toHaveBeenCalledWith("/reservations/resources/c1");
  });

  it("the owner's chair still called after the business is pointed out", async () => {
    resources = [{ ...resources[0], label: "Frisør Saks" }];
    await openTab();
    expect(screen.getByTestId("self-chair-business-name")).toBeInTheDocument();
  });
});

// ── Five tabs on a 390 px phone (S12) ─────────────────────────────────────
describe("the Tidsbestilling tabs on a phone", () => {
  const TABS = [{ id: "a", label: "Aftaler" }, { id: "b", label: "Indstillinger", phoneIcon: (p) => <svg data-testid="gear" {...p} /> }];

  it("phoneSpread shares the gaps over the row; without it the row is as before", () => {
    const { container, rerender } = render(<TabPills tabs={TABS} activeId="a" phone="underline" phoneSpread />);
    const row = container.querySelector('[role="tablist"]');
    expect(row.className).toContain("max-sm:justify-between");
    expect(row.className).toContain("max-sm:gap-3");
    expect(row.className).not.toContain("max-sm:gap-5");
    rerender(<TabPills tabs={TABS} activeId="a" phone="underline" />);
    expect(container.querySelector('[role="tablist"]').className).toContain("max-sm:gap-5");
    expect(container.querySelector('[role="tablist"]').className).not.toContain("justify-between");
  });

  it("a phone icon stands for the word on a phone, and the word stays its name", () => {
    render(<TabPills tabs={TABS} activeId="a" phone="underline" phoneSpread />);
    const tab = screen.getByRole("tab", { name: "Indstillinger" });
    expect(within(tab).getByTestId("gear").getAttribute("class")).toContain("sm:hidden");
    expect(within(tab).getByText("Indstillinger").className).toContain("max-sm:sr-only");
  });

  it("the salon's five tabs: the gear on Indstillinger and a spread row; a restaurant keeps its row", async () => {
    h.get.mockResolvedValue({ data: {} });
    render(<MemoryRouter initialEntries={["/reservations?tab=insights"]}><ReservationsPage /></MemoryRouter>);
    await settle();
    let list = screen.getByRole("tablist");
    expect(within(list).getAllByRole("tab").map((x) => x.textContent))
      .toEqual([da.rsvpTabBookProvider, da.rsvpTabProviders, da.rsvpTabBehandlinger, da.rsvpTabInsights, da.rsvpTabSettings]);
    expect(list.className).toContain("max-sm:justify-between");
    const settingsTab = within(list).getByRole("tab", { name: da.rsvpTabSettings });
    expect(settingsTab.querySelector("svg")).not.toBeNull();
    cleanup();
    h.user = { id: "u1", business_type: "restaurant", business_name: "Bistro", role: "owner" };
    render(<MemoryRouter initialEntries={["/reservations?tab=insights"]}><ReservationsPage /></MemoryRouter>);
    await settle();
    list = screen.getByRole("tablist");
    expect(list.className).not.toContain("justify-between");
    expect(within(list).getByRole("tab", { name: da.rsvpTabSettings }).querySelector("svg")).toBeNull();
  });
});

// ── The salon's hours (S12) ───────────────────────────────────────────────
describe("the salon's opening hours card", () => {
  const settingsRoutes = (bookingHours) => h.get.mockImplementation((url) => {
    if (url === "/reservations/settings") {
      return Promise.resolve({ data: {
        reservations_enabled: true, reservation_slug: "saks", public_url: "https://www.bonbox.dk/saks",
        business_name: "Frisør Saks", hours_declared: true, closures: [], open_hours: {},
        settings: { group_request_threshold: 99, ...(bookingHours ? { booking_hours: bookingHours } : {}) },
      } });
    }
    return Promise.resolve({ data: {} });
  });
  const dayRow = (label) => screen.getAllByText(label, { selector: "span" })
    .map((s) => s.parentElement).find((r) => r.querySelector('input[type="checkbox"]'));

  it("says what the hours steer for a salon, and suggests a salon week while nothing is saved", async () => {
    settingsRoutes(null);
    render(<MemoryRouter initialEntries={["/reservations?tab=settings"]}><ReservationsPage /></MemoryRouter>);
    await screen.findAllByText(da.rsvpDayMon);
    await settle();
    expect(screen.getByText(da.rsvpHoursHintSalon)).toBeInTheDocument();
    expect(dayRow(da.rsvpDayMon).querySelector('input[type="checkbox"]').checked).toBe(false);
    expect([...dayRow(da.rsvpDayFri).querySelectorAll('input[type="time"]')].map((i) => i.value)).toEqual(["09:00", "17:00"]);
    expect(screen.getByText(da.rsvpHoursNotSetProvider)).toBeInTheDocument();
  });

  it("saved hours: no banner, and a closed day reopens on the salon's times", async () => {
    settingsRoutes({ mon: "closed", tue: "10:00-18:00", wed: "closed", thu: "closed", fri: "closed", sat: "closed", sun: "closed" });
    render(<MemoryRouter initialEntries={["/reservations?tab=settings"]}><ReservationsPage /></MemoryRouter>);
    await screen.findAllByText(da.rsvpDayMon);
    await settle();
    expect(screen.queryByText(da.rsvpHoursNotSetProvider)).toBeNull();
    expect([...dayRow(da.rsvpDayTue).querySelectorAll('input[type="time"]')].map((i) => i.value)).toEqual(["10:00", "18:00"]);
    fireEvent.click(dayRow(da.rsvpDayWed).querySelector('input[type="checkbox"]'));
    expect([...dayRow(da.rsvpDayWed).querySelectorAll('input[type="time"]')].map((i) => i.value)).toEqual(["09:00", "17:00"]);
  });
});

describe("the first-run card names the owner's chair", () => {
  function firstRunRoutes() {
    h.get.mockImplementation((url) => {
      if (url === "/reservations/settings") {
        return Promise.resolve({ data: { reservations_enabled: false, reservation_slug: null, hours_declared: false, settings: { group_request_threshold: 99 }, closures: [] } });
      }
      if (url === "/reservations/resources") return Promise.resolve({ data: { resources: [], fixtures: [], book_has_entries: false } });
      if (url === "/reservations/behandlinger") return Promise.resolve({ data: { behandlinger: [{ id: "b1", name: "Klip", duration_min: 30, active: true }] } });
      if (url === "/reservations/book") return Promise.resolve({ data: { reservations: [], summary: { total: 0, by_status: {} } } });
      return Promise.resolve({ data: {} });
    });
    h.post.mockResolvedValue({ data: {} });
  }
  const quickSetupBody = () => h.post.mock.calls.find(([u]) => u === "/reservations/salon/quick-setup")?.[1];

  it("sends the name she typed", async () => {
    firstRunRoutes();
    render(<MemoryRouter initialEntries={["/reservations"]}><ReservationsPage /></MemoryRouter>);
    await settle(12);
    fireEvent.change(screen.getByLabelText(da.rsvpSelfChairNameLabel), { target: { value: " Anna " } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(da.rsvpSalonOpenForBooking) })); });
    await settle(4);
    expect(quickSetupBody().chair_name).toBe("Anna");
  });

  it("no name: 'Indehaver', never the business name", async () => {
    firstRunRoutes();
    render(<MemoryRouter initialEntries={["/reservations"]}><ReservationsPage /></MemoryRouter>);
    await settle(12);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: new RegExp(da.rsvpSalonOpenForBooking) })); });
    await settle(4);
    expect(quickSetupBody().chair_name).toBe(da.rsvpSelfChairDefaultName);
  });
});

// ── The words ─────────────────────────────────────────────────────────────
describe("the R7 words", () => {
  const KEYS = [
    "rsvpCapacityYou", "rsvpCapacityN", "rsvpCapacityUpTo", "rsvpCapacityOneAtATime", "rsvpCapacityOnlyYou",
    "rsvpCapacityOnlyOne", "rsvpCapacityNobody", "rsvpCapacityClosedDay", "rsvpCapacityClosedNote", "rsvpCapacityClosed",
    "rsvpCapacityPaused", "rsvpCapacityAway", "rsvpCapacityHoursClosedShift", "rsvpCapacityWeekTitle", "rsvpCapacityWeekIntro",
    "rsvpCapacityNoHours",
    "rsvpStylistsIntro", "rsvpStylistAddTitle", "rsvpStylistNameLabel", "rsvpStylistNamePh", "rsvpStylistBookableLabel",
    "rsvpStylistModeHours", "rsvpStylistModeShifts", "rsvpStylistModeHoursHint", "rsvpStylistModeShiftsHint", "rsvpStylistAddBtn",
    "rsvpStylistAddedHours", "rsvpStylistAddedShifts", "rsvpStylistExists", "rsvpStylistNameRequired", "rsvpStylistNameTooLong",
    "rsvpStylistAddError", "rsvpStylistStaffCap", "rsvpStylistStaffCapBenefit", "rsvpStylistChairCap", "rsvpStylistFromRoster",
    "rsvpStylistByShifts", "rsvpStylistEditAria", "rsvpStylistEditTitle", "rsvpStylistSaveError", "rsvpStylistRenameHint",
    "rsvpStylistDeleteStays", "rsvpSelfChairNamedAfterBusiness", "rsvpSelfChairNameLabel", "rsvpSelfChairNamePh",
    "rsvpSelfChairDefaultName", "rsvpHoursHintSalon",
  ];
  it("exist in en and da", () => {
    for (const k of KEYS) {
      expect(typeof en[k], `en.${k}`).toBe("string");
      expect(typeof da[k], `da.${k}`).toBe("string");
      expect(en[k].length, `en.${k}`).toBeGreaterThan(0);
      expect(da[k].length, `da.${k}`).toBeGreaterThan(0);
    }
  });
  it("keep behandler Danish in da and say stylist in en", () => {
    expect(da.rsvpStylistAddTitle).toContain("behandler");
    expect(en.rsvpStylistAddTitle).toContain("stylist");
    expect(da.rsvpCapacityN).toContain("samtidig");
    expect(da.rsvpCapacityYou).toBe("dig");
  });
});
