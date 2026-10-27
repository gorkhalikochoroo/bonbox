/**
 * R9 (27 Oct 2026) — settings that tell the truth, on the owner's pages.
 *
 *   • One Gem per card that saves THAT card: saving the rules no longer puts
 *     the owner's unsaved hours back (every save re-applied the whole
 *     settings answer), and saving the name no longer blanks the page.
 *   • The hours card says which hours decide online times; the pacing field
 *     says it counts guests and which parties it leaves out; the switch says
 *     when it went on by itself; the link card shows the real address and
 *     the old links; the phone has a jump row; ?show=hours lands on hours.
 *   • Quick setup's first tables: "Online-booking er slået til" on the page.
 *   • The new-booking sheet says when the day is closed for online booking.
 *   • The guest page opened on an old link moves to the new one.
 *   • The Profile hours editor says how booking uses its hours.
 */
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 30000 });

const h = vi.hoisted(() => ({
  get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), del: vi.fn(),
  user: { id: "u1", business_type: "restaurant", business_name: "Havnen", role: "owner" },
  settings: null,
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
const ent = vi.hoisted(() => ({ hasFeature: () => true, isReady: true, plan: "pro", minPlanForFeature: () => null }));
vi.mock("../hooks/useEntitlements", () => ({ useEntitlements: () => ent }));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn().mockResolvedValue(true) }));

const ReservationsPage = (await import("../pages/ReservationsPage")).default;
const ReservationPublicPage = (await import("../pages/ReservationPublicPage")).default;
const OperatingProfileSection = (await import("../components/OperatingProfileSection")).default;
const { da } = await import("../i18n/da");
const { todayIso } = await import("../utils/closures");

const settle = async (n = 14) => {
  for (let i = 0; i < n; i++) await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
};
const fill = (k, vars) => da[k].replace(/\{(\w+)\}/g, (m, n) => (vars[n] !== undefined ? String(vars[n]) : m));
const WEEK = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];

function baseSettings(over = {}) {
  return {
    reservations_enabled: true, reservation_slug: "havnen", public_url: "https://www.bonbox.dk/havnen",
    business_name: "Havnen", public_name: "Havnen", hours_declared: true,
    open_hours: Object.fromEntries(WEEK.map((d) => [d, [["11:00", "22:00"]]])),
    closures: [], slug_aliases: [], slug_alias_max: 5, auto_enabled_at: null,
    settings: {
      group_request_threshold: 8, max_party_size: 10, lead_time_min: 60, max_advance_days: 60,
      pacing_max_per_slot: null, combine_enabled: true, guest_can_pick_table: false,
      booking_hours: Object.fromEntries(WEEK.map((d) => [d, "11:00-22:00"])),
    },
    ...over,
  };
}

function routes() {
  h.get.mockImplementation((url) => {
    if (url === "/reservations/settings" || url === "/reservations/booking-rules") {
      return Promise.resolve({ data: h.settings });
    }
    if (url === "/reservations/resources") {
      return Promise.resolve({ data: { resources: [{ id: "t1", kind: "table", label: "Bord 1", capacity_seats: 4, is_active: true }], fixtures: [], book_has_entries: true } });
    }
    if (url === "/reservations/book") return Promise.resolve({ data: { reservations: [], summary: { total: 0, covers: 0, by_status: {} } } });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    if (url === "/stand/links") return Promise.resolve({ data: { devices: [] } });
    if (url === "/reservations/contact-blocks") return Promise.resolve({ data: { entries: [] } });
    return Promise.resolve({ data: {} });
  });
  // A save answers with what the server holds — the SAVED settings.
  h.put.mockImplementation((url, body) => {
    const next = { ...h.settings, settings: { ...h.settings.settings, ...(body?.settings || {}) } };
    h.settings = next;
    return Promise.resolve({ data: next });
  });
}

const mount = async (path = "/reservations?tab=settings") => {
  routes();
  render(<MemoryRouter initialEntries={[path]}><ReservationsPage /></MemoryRouter>);
  await settle();
};
const hoursCard = () => document.getElementById("rsvp-hours");
const rulesCard = () => document.getElementById("rsvp-rules");
const fieldIn = (root, labelText) => {
  const label = [...root.querySelectorAll("label")].find((l) => l.querySelector("span")?.textContent === labelText);
  return label?.querySelector("input");
};

beforeEach(() => {
  for (const f of [h.get, h.post, h.put, h.patch, h.del]) f.mockReset();
  h.user = { id: "u1", business_type: "restaurant", business_name: "Havnen", role: "owner" };
  h.settings = baseSettings();
  window.scrollTo = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!globalThis.ResizeObserver) globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
});
afterEach(() => cleanup());

describe("one Gem per card, and it saves that card", () => {
  it("saving the rules keeps the hours the owner changed and has not saved", async () => {
    await mount();
    const monday = hoursCard().querySelectorAll('input[type="checkbox"]')[0];
    expect(monday.checked).toBe(true);
    await act(async () => { fireEvent.click(monday); });
    expect(within(hoursCard()).getByTestId("rsvp-hours-save").textContent).toContain(da.rsvpCardUnsaved);
    // Now a rule, and the rules' own Gem.
    const lead = fieldIn(rulesCard(), da.rsvpLeadTime);
    await act(async () => { fireEvent.change(lead, { target: { value: "90" } }); });
    expect(within(rulesCard()).getByTestId("rsvp-rules-save").textContent).toContain(da.rsvpCardUnsaved);
    await act(async () => { fireEvent.click(within(within(rulesCard()).getByTestId("rsvp-rules-save")).getByRole("button", { name: da.save })); });
    await settle();
    const put = h.put.mock.calls.find(([u, b]) => u === "/reservations/settings" && b?.settings?.lead_time_min === 90);
    expect(put).toBeTruthy();
    expect(put[1].settings.booking_hours).toBeUndefined();          // the rules' Gem saved the rules
    // The hours card still shows Monday closed — and still says it is not saved.
    expect(hoursCard().querySelectorAll('input[type="checkbox"]')[0].checked).toBe(false);
    expect(within(hoursCard()).getByTestId("rsvp-hours-save").textContent).toContain(da.rsvpCardUnsaved);
    // The rules card is clean again.
    expect(within(rulesCard()).getByTestId("rsvp-rules-save").textContent).not.toContain(da.rsvpCardUnsaved);
  });

  it("saving the hours keeps a half-typed rule", async () => {
    await mount();
    const lead = fieldIn(rulesCard(), da.rsvpLeadTime);
    await act(async () => { fireEvent.change(lead, { target: { value: "45" } }); });
    await act(async () => { fireEvent.click(hoursCard().querySelectorAll('input[type="checkbox"]')[0]); });
    await act(async () => { fireEvent.click(within(within(hoursCard()).getByTestId("rsvp-hours-save")).getByRole("button", { name: da.save })); });
    await settle();
    const put = h.put.mock.calls.find(([, b]) => b?.settings?.booking_hours);
    expect(put[1].settings.booking_hours.mon).toBe("closed");
    expect(put[1].settings.lead_time_min).toBeUndefined();
    expect(fieldIn(rulesCard(), da.rsvpLeadTime).value).toBe("45");
    expect(within(rulesCard()).getByTestId("rsvp-rules-save").textContent).toContain(da.rsvpCardUnsaved);
    expect(within(hoursCard()).getByTestId("rsvp-hours-save").textContent).not.toContain(da.rsvpCardUnsaved);
  });

  it("the switch, the e-mails and a name save keep every card's typing", async () => {
    await mount();
    await act(async () => { fireEvent.click(hoursCard().querySelectorAll('input[type="checkbox"]')[1]); });
    // The owner e-mail switch saves on tap.
    await act(async () => { fireEvent.click(screen.getByRole("switch", { name: da.rsvpOwnerEmailToggle })); });
    await settle();
    expect(hoursCard().querySelectorAll('input[type="checkbox"]')[1].checked).toBe(false);
    // The name row's save re-reads quietly: no "Indlæser…" blank, the hours stay.
    h.patch.mockResolvedValue({ data: {} });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpBookingNameEdit })); });
    fireEvent.change(screen.getByLabelText(da.rsvpBookingNameLabel), { target: { value: "Havnen Aarhus" } });
    await act(async () => { fireEvent.click(within(screen.getByTestId("rsvp-booking-name")).getByRole("button", { name: da.save })); });
    await settle();
    expect(hoursCard()).toBeTruthy();
    expect(hoursCard().querySelectorAll('input[type="checkbox"]')[1].checked).toBe(false);
  });
});

describe("what the settings say", () => {
  it("the hours card: Profile hours in use until saved here", async () => {
    h.settings = baseSettings({ settings: { ...baseSettings().settings, booking_hours: undefined } });
    await mount();
    const line = within(hoursCard()).getByTestId("rsvp-hours-source");
    expect(line.getAttribute("data-source")).toBe("profile");
    expect(line.textContent).toBe(da.rsvpHoursSourceProfile);
  });

  it("the hours card: saved here, Profile changes nothing", async () => {
    await mount();
    expect(within(hoursCard()).getByTestId("rsvp-hours-source").textContent).toBe(da.rsvpHoursSourceBooking);
  });

  it("a salon: the chair reads these hours only", async () => {
    h.user = { id: "u1", business_type: "salon", business_name: "Klip", role: "owner" };
    await mount();
    expect(within(hoursCard()).getByTestId("rsvp-hours-source").textContent).toBe(da.rsvpHoursSourceChairs);
  });

  it("pacing: counts guests, and names the parties it leaves out", async () => {
    h.settings = baseSettings({ settings: { ...baseSettings().settings, pacing_max_per_slot: 4 } });
    await mount();
    expect(rulesCard().textContent).toContain(da.rsvpPacing);
    expect(rulesCard().textContent).toContain(da.rsvpPacingGuestsHint);
    expect(screen.getByTestId("rsvp-pacing-gap").textContent).toBe(fill("rsvpPacingGap", { from: 5, to: 7 }));
    // A cap above every online party: nothing to warn about.
    await act(async () => { fireEvent.change(fieldIn(rulesCard(), da.rsvpPacing), { target: { value: "30" } }); });
    expect(screen.queryByTestId("rsvp-pacing-gap")).toBeNull();
  });

  it("the switch says it went on by itself, until the owner flips it", async () => {
    h.settings = baseSettings({ auto_enabled_at: "2026-10-27" });
    await mount();
    expect(screen.getByTestId("rsvp-auto-on").textContent.startsWith(da.rsvpAutoOnTable.split("{date}")[0])).toBe(true);
    expect(screen.getByTestId("rsvp-auto-on").textContent).not.toContain("{date}");
    cleanup();
    h.settings = baseSettings();
    await mount();
    expect(screen.queryByTestId("rsvp-auto-on")).toBeNull();
  });

  it("the link card: the real address and the old links", async () => {
    h.settings = baseSettings({ slug_aliases: [{ slug: "gamle-havn", since: "2026-10-27", url: "https://www.bonbox.dk/gamle-havn" }] });
    await mount();
    expect(screen.getByTestId("rsvp-slug-prefix").textContent).toBe("www.bonbox.dk/");
    expect(screen.getByTestId("rsvp-old-links").textContent).toContain("www.bonbox.dk/gamle-havn");
  });

  it("the phone's jump row lists the cards, and each target exists", async () => {
    await mount();
    const nav = screen.getByTestId("rsvp-settings-jump");
    const labels = [...nav.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).toEqual([da.rsvpJumpLink, da.rsvpJumpHours, da.rsvpJumpClosures, da.rsvpJumpRules, da.rsvpJumpMessages, da.rsvpJumpDevices]);
    for (const id of ["rsvp-link", "website", "rsvp-hours", "rsvp-closures", "rsvp-rules", "rsvp-messages", "rsvp-devices"]) {
      expect(document.getElementById(id), id).toBeTruthy();
    }
  });

  it("?show=hours lands on the hours card", async () => {
    const spy = vi.fn();
    const orig = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function f(...a) { spy(this.id, ...a); };
    try {
      await mount("/reservations?tab=settings&show=hours");
      expect(spy.mock.calls.some(([id]) => id === "rsvp-hours")).toBe(true);
    } finally {
      Element.prototype.scrollIntoView = orig;
    }
  });
});

describe("quick setup's first tables say booking went on", () => {
  it("the page shows the notice with the link", async () => {
    h.post.mockImplementation((url) => {
      if (url === "/reservations/resources/bulk") {
        return Promise.resolve({ data: {
          created: [{ id: "n1", kind: "table", label: "Bord 2", capacity_seats: 2, is_active: true }],
          created_count: 1, requested: 1, capped: 0,
          reservations_activated: { reservations_enabled: true, reservation_slug: "havnen", public_url: "https://www.bonbox.dk/havnen" },
        } });
      }
      return Promise.resolve({ data: {} });
    });
    await mount("/reservations?tab=floor");
    expect(screen.queryByTestId("rsvp-live-notice")).toBeNull();
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: da.rsvpBulkMore })[0]); });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: da.rsvpBulkSubmit })); });
    await settle();
    const notice = screen.getByTestId("rsvp-live-notice");
    expect(notice.textContent).toContain(da.rsvpLiveTitle);
    expect(notice.querySelector("a").textContent).toBe("www.bonbox.dk/havnen");
    // The new table is on the floor list (its label is an editable field).
    expect(screen.getAllByDisplayValue("Bord 2").length).toBeGreaterThan(0);
  });
});

describe("the new-booking sheet on a day closed for online booking", () => {
  it("says so, and the booking can still be made", async () => {
    h.settings = baseSettings({ closures: [{ id: "c1", from: todayIso(), to: todayIso(), kind: "closed", note: "Privat fest", bookings: 0 }] });
    await mount("/reservations");
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: da.rsvpNewBooking })[0]); });
    await settle(4);
    const dialog = screen.getByRole("dialog", { name: da.rsvpNewBooking });
    expect(within(dialog).getByTestId("nb-closure-chip").textContent).toBe(fill("rsvpNewClosedDayNote", { note: "Privat fest" }));
  });

  it("no chip on an open day", async () => {
    await mount("/reservations");
    await act(async () => { fireEvent.click(screen.getAllByRole("button", { name: da.rsvpNewBooking })[0]); });
    await settle(4);
    expect(within(screen.getByRole("dialog", { name: da.rsvpNewBooking })).queryByTestId("nb-closure-chip")).toBeNull();
  });
});

describe("the guest page on an old link", () => {
  let where = null;
  function Where() {
    const loc = useLocation();
    where = loc;
    return null;
  }
  const renderGuest = (path) => render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/r/:slug" element={<><ReservationPublicPage /><Where /></>} />
        <Route path="/:slug" element={<><ReservationPublicPage /><Where /></>} />
      </Routes>
    </MemoryRouter>,
  );
  beforeEach(() => {
    where = null;
    h.get.mockImplementation((url) => {
      if (url === "/public/reservations/gammel") {
        return Promise.resolve({ data: { business_name: "Havnen", business_type: "restaurant", canonical_slug: "havnen", providers: [] } });
      }
      if (url === "/public/reservations/havnen") {
        return Promise.resolve({ data: { business_name: "Havnen", business_type: "restaurant", providers: [] } });
      }
      return Promise.resolve({ data: {} });
    });
  });

  it("moves to the new link, keeping /r/, the query and the hash", async () => {
    renderGuest("/r/gammel?embed=1&party=2#tider");
    await settle();
    expect(where.pathname).toBe("/r/havnen");
    expect(where.search).toBe("?embed=1&party=2");
    expect(where.hash).toBe("#tider");
    // Fix round 27 Oct (walk P3-4): the page now carries on with the NEW
    // link — its venue is not asked for a second time, and every question
    // after the first goes to the new link, none to the old one.
    const urls = h.get.mock.calls.map(([u]) => u);
    expect(urls.filter((u) => u === "/public/reservations/gammel")).toHaveLength(1);
    expect(urls.filter((u) => u === "/public/reservations/havnen")).toHaveLength(0);
    expect(urls.some((u) => u.startsWith("/public/reservations/havnen/"))).toBe(true);
    expect(urls.some((u) => u.startsWith("/public/reservations/gammel/"))).toBe(false);
  });

  it("the root form moves to the root form", async () => {
    renderGuest("/gammel");
    await settle();
    expect(where.pathname).toBe("/havnen");
  });

  it("the current link stays where it is", async () => {
    renderGuest("/havnen?party=4");
    await settle();
    expect(where.pathname).toBe("/havnen");
    expect(where.search).toBe("?party=4");
  });
});

describe("the Profile hours editor", () => {
  it("reads its saved week and says how booking uses it", async () => {
    h.get.mockImplementation((url) => {
      if (url === "/business/operating-profile") {
        return Promise.resolve({ data: {
          open_days_mask: "12345", operating_hours: { mon: "10:00-18:00" }, peak_windows: [],
          booking_hours: { days: WEEK, chairs_only: false },
        } });
      }
      if (url === "/business/role-catalog") return Promise.resolve({ data: { vertical: "restaurant", roles: [] } });
      return Promise.resolve({ data: [] });
    });
    render(<MemoryRouter><OperatingProfileSection /></MemoryRouter>);
    await settle();
    const note = screen.getByTestId("profile-hours-note");
    expect(note.getAttribute("data-note")).toBe("booking");
    expect(note.textContent).toContain(da.profileHoursNoteBooking);
    expect(screen.getByDisplayValue("10:00-18:00")).toBeTruthy();
  });
});
