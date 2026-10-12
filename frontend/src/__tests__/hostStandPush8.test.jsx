/**
 * Push 8 — the host stand polish round (QA click-through, 12 Oct 2026).
 *
 *   2. A finished row on a phone keeps its table and its times: the seated →
 *      left line wraps under the table and status instead of running off the
 *      card (it was shrink-0 on one line — "2 E ● Afsluttet 10.20 → 11.45 ·
 *      1 t 2…" at 360 px).
 *   3. A 6+ seat at joined tables from the sheet gets the line a one-tap seat
 *      gets, named from the server's answer ("6 gæster sat ved 52 + 51").
 *   4. With the booking-rules door down the 6+ sheet pre-picks no table the
 *      party does not fit (it pre-picked a 4-top for six and warned).
 *   5. A full room: the header sheet pre-picks no table that is not free for
 *      the whole sitting, says "Ingen ledige borde lige nu — sæt dem på
 *      ventelisten" with the waitlist action, and a 409 shows in the sheet.
 *   6. The header covers show on a phone, compactly.
 *   9. One guest is "1 gæst" / "1 guest" in the drop-in buttons' names.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const lang = vi.hoisted(() => ({ code: "en" }));
vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { business_type: "restaurant", business_name: "Havnen" }, logout: vi.fn(), loading: false }),
}));
vi.mock("../hooks/useLanguage", async () => {
  const { da: DA } = await import("../i18n/da");
  const { en: EN } = await import("../i18n/en");
  return {
    useLanguage: () => ({
      t: (k, fb, vars) => {
        const v = typeof fb === "object" && fb ? fb : vars;
        const dict = lang.code === "da" ? DA : EN;
        let s = dict[k] ?? (typeof fb === "string" ? fb : k);
        if (v) s = s.replace(/\{(\w+)\}/g, (m, n) => (v[n] !== undefined ? String(v[n]) : m));
        return s;
      },
      lang: lang.code,
    }),
  };
});
vi.mock("../hooks/useEntitlements", () => ({
  useEntitlements: () => ({ hasFeature: () => true, isReady: true }),
}));
vi.mock("../hooks/useConfirm", () => ({ useConfirm: () => vi.fn(async () => true) }));
vi.mock("../hooks/useToast", () => ({ useToast: () => Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }) }));
vi.mock("../utils/sound", () => ({
  getSoundStatus: () => "off",
  subscribeSound: () => () => {},
  testSound: vi.fn(),
  playChime: vi.fn(),
  playUrgent: vi.fn(),
  unlockSound: vi.fn(),
  prepareSoundWhenIdle: vi.fn(() => () => {}),
}));

import api from "../services/api";
import ReservationsPage from "../pages/ReservationsPage";
import { da } from "../i18n/da";
import { en } from "../i18n/en";

const DAY = "2026-10-12";
const at = (hhmm) => `${DAY}T${hhmm}:00`;
const z = (hhmm) => new Date(at(hhmm)).toISOString();
const table = (id, seats, extra = {}) => ({ id, label: id, capacity_seats: seats, kind: "table", is_active: true, zone: "Sal", pos_x: 10, pos_y: 10, ...extra });
const row = (id, name, tableId, status, from, to, party, extra = {}) => ({
  id, guest_name: name, resource_id: tableId, status, starts_at: at(from), ends_at: at(to),
  party_size: party, source: "manual", allergen_tags: [], seated_at: null, completed_at: null, ...extra,
});

// 19:00 on a busy evening: one free two-top (41); the rest seated.
const RESOURCES = [table("21", 2), table("22", 2), table("23", 4), table("25", 6), table("31", 2), table("32", 2), table("33", 4), table("41", 2)];
const BOOK = [
  row("riis", "Riis", "22", "completed", "17:00", "18:30", 2, { seated_at: z("17:20"), completed_at: z("18:10") }),
  row("hansen", "Hansen", "23", "completed", "17:10", "19:10", 3, { seated_at: z("16:55"), completed_at: z("18:10") }),
  row("a", "Birk", "21", "seated", "18:00", "19:30", 2, { seated_at: z("18:00") }),
  row("b", "Lund", "22", "seated", "18:30", "20:00", 2, { seated_at: z("18:30") }),
  row("c", "Mortensen", "23", "seated", "18:15", "20:15", 4, { seated_at: z("18:15") }),
  row("d", "Østergaard", "25", "seated", "18:45", "20:45", 6, { seated_at: z("18:45") }),
  row("e", "Selskab Kragh", "31", "seated", "18:30", "20:30", 8, {
    seated_at: z("18:30"), combined_resource_ids: ["31", "32", "33"], combined_resource_labels: ["31", "32", "33"],
  }),
  row("h", "Juhl", null, "confirmed", "19:45", "21:45", 4),
];
const RULES = {
  settings: { turn_time_tiers: [{ up_to: 2, minutes: 90 }, { up_to: 8, minutes: 120 }], default_duration_min: 90 },
  hours_declared: false,
};

function mockApi(over = {}, { book = BOOK, resources = RESOURCES } = {}) {
  api.get.mockImplementation((url) => {
    if (over[url]) return over[url]();
    if (url === "/reservations/settings") return Promise.resolve({ data: RULES });
    if (url === "/reservations/booking-rules") return Promise.resolve({ data: RULES });
    if (url === "/reservations/book") {
      return Promise.resolve({ data: { date: DAY, reservations: book, summary: { total: book.length, covers: 0, by_status: {} } } });
    }
    if (url === "/reservations/resources") return Promise.resolve({ data: { resources, fixtures: [], venue_seats_total: 30 } });
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    return Promise.resolve({ data: {} });
  });
  api.post.mockImplementation((url, body) => {
    const { resource_ids: joined, ...rest } = body || {};
    return Promise.resolve({
      data: {
        id: "new-walkin", ...rest,
        ...(Array.isArray(joined) && joined.length > 1 ? { resource_id: joined[0], combined_resource_ids: joined } : { combined_resource_ids: null }),
      },
    });
  });
}

beforeAll(() => {
  globalThis.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  window.scrollTo = () => {};
  Element.prototype.scrollIntoView = () => {};
});
beforeEach(() => {
  lang.code = "en";
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(at("19:00")));
  vi.clearAllMocks();
  mockApi();
});
afterEach(() => vi.useRealTimers());

const renderStand = (path = "/reservations/stand") =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ReservationsPage />
    </MemoryRouter>,
  );
const sizeButton = async (n) => {
  await waitFor(() => expect(document.querySelector(`[data-walkin="${n}"]`)).not.toBeNull());
  return document.querySelector(`[data-walkin="${n}"]`);
};
// The compact (phone and tablet) row of a booking — DataTable's mobileRow.
const compactRowOf = (name) =>
  [...document.querySelectorAll('[role="button"][data-status]')].find((el) => el.textContent.includes(name));

describe("2 · a finished row on a phone", () => {
  it("keeps the table and lets the seated → left line wrap and truncate, never run off the card", async () => {
    renderStand();
    await waitFor(() => expect(document.querySelector('[data-covers="finished"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-covers="finished"]'));
    await waitFor(() => expect(compactRowOf("Riis")).toBeTruthy());
    const meta = compactRowOf("Riis").querySelector("[data-row-meta]");
    expect(meta.className).toMatch(/(^|\s)flex-wrap(\s|$)/);
    // The table is on the row.
    expect([...meta.querySelectorAll("span")].some((s) => s.textContent === "22")).toBe(true);
    const stay = meta.querySelector("[data-stay]");
    expect(stay.textContent.replace(/\s+/g, " ").trim()).toBe("17.20 → 18.10 · 50 min");
    expect(stay.className).toMatch(/(^|\s)truncate(\s|$)/);
    expect(stay.className).not.toMatch(/shrink-0|whitespace-nowrap/);
  });

  it("a live row keeps its one line (no wrap)", async () => {
    renderStand();
    await waitFor(() => expect(compactRowOf("Birk")).toBeTruthy());
    expect(compactRowOf("Birk").querySelector("[data-row-meta]").className).not.toMatch(/flex-wrap/);
  });
});

describe("3 · a joined seat from the sheet says where", () => {
  const JOINABLE = [
    ...RESOURCES,
    table("51", 4, { combinable: true }),
    table("52", 2, { combinable: true }),
  ];
  it("6+ at 51 + 52: the line is named from the server's answer, in its order", async () => {
    mockApi({}, { resources: JOINABLE });
    api.post.mockImplementation((url, body) => Promise.resolve({
      data: { id: "held", guest_name: body.guest_name, party_size: body.party_size, status: "seated", resource_id: "52", combined_resource_ids: ["52", "51"] },
    }));
    renderStand();
    await waitFor(async () => expect((await sizeButton(6)).textContent).toContain("Free now"));
    fireEvent.click(await sizeButton(6));
    const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Seat now" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1]).toMatchObject({ resource_ids: ["51", "52"], party_size: 6 });
    expect(await screen.findByText("6 guests seated at 52 + 51")).toBeInTheDocument();
    expect(document.querySelector("[data-walkin-done]").dataset.walkinDone).toBe("seated");
    expect(screen.queryByRole("dialog", { name: "Seat guests" })).toBeNull();
  });

  it("in Danish too", async () => {
    lang.code = "da";
    mockApi({}, { resources: JOINABLE });
    renderStand();
    await waitFor(async () => expect((await sizeButton(6)).textContent).toContain(da.rsvpWalkInFreeNow));
    fireEvent.click(await sizeButton(6));
    const dialog = await screen.findByRole("dialog", { name: da.rsvpSeatNowTitle });
    fireEvent.click(within(dialog).getByRole("button", { name: da.rsvpSeatNowBtn }));
    expect(await screen.findByText("6 gæster sat ved 51 + 52")).toBeInTheDocument();
  });
});

describe("4 · the booking-rules door down", () => {
  const DEVICE = "/stand/tok-door-1";
  const doorDown = () => mockApi({ "/reservations/booking-rules": () => Promise.reject({ response: { status: 404 } }) });

  it("6+ pre-picks no table smaller than the party — the host chooses", async () => {
    doorDown();
    renderStand(DEVICE);
    fireEvent.click(await sizeButton(6));
    const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
    const sel = within(dialog).getByRole("combobox", { name: "Table" });
    // Only 41 (a two-top) is free: nothing is picked for six.
    expect(sel).toHaveValue("");
    expect(within(dialog).getByRole("option", { name: "Choose a table" })).toBeInTheDocument();
    expect(within(dialog).queryByText(/That table seats/)).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Seat now" })).toBeDisabled();
    // A size the free table fits is still picked for the host.
    fireEvent.click(within(dialog).getByRole("button", { name: "2 guests" }));
    await waitFor(() => expect(sel).toHaveValue("41"));
    // Back up to six: the pick made for two does not stay under six.
    fireEvent.click(within(dialog).getByRole("button", { name: "6 guests" }));
    await waitFor(() => expect(sel).toHaveValue(""));
    expect(api.post).not.toHaveBeenCalled();
  });

  it("the host may still choose a smaller table — then the sheet informs, it never blocks", async () => {
    doorDown();
    renderStand(DEVICE);
    fireEvent.click(await sizeButton(6));
    const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Table" }), { target: { value: "41" } });
    expect(within(dialog).getByText("That table seats 2 — you're seating 6.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Seat now" })).not.toBeDisabled();
  });
});

describe("5 · a full room and the header sheet", () => {
  // Everything seated but two tables that are booked within the sitting:
  // 3 at 19.20, 5 at 19.10 — free now, not for 90 minutes.
  const ROOM = [table("1", 2), table("2", 2), table("3", 2), table("4", 4), table("5", 4)];
  const FULL = [
    row("s1", "Anders", "1", "seated", "18:30", "20:00", 2, { seated_at: z("18:30") }),
    row("s2", "Drop-in", "2", "seated", "18:40", "20:10", 2, { seated_at: z("18:40") }),
    row("s4", "Berg", "4", "seated", "18:20", "20:20", 4, { seated_at: z("18:20") }),
    row("r3", "Krog", "3", "confirmed", "19:20", "20:50", 2),
    row("r5", "Sø", "5", "confirmed", "19:10", "21:10", 4),
  ];
  const full = (over = {}) => mockApi(over, { book: FULL, resources: ROOM });
  const openHeaderSheet = async () => {
    renderStand();
    await sizeButton(1);
    fireEvent.click(screen.getByRole("button", { name: "Seat a drop-in" }));
    return screen.findByRole("dialog", { name: "Seat guests" });
  };

  it("pre-picks nothing, says so, and offers the waitlist", async () => {
    full();
    const dialog = await openHeaderSheet();
    expect(within(dialog).getByRole("combobox", { name: "Table" })).toHaveValue("");
    expect(within(dialog).getByText("No table free right now — put them on the waitlist")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Seat now" })).toBeDisabled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Add to waitlist" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Seat guests" })).toBeNull());
    // The Venteliste form, on the sheet's party size.
    expect(await screen.findByPlaceholderText("Phone (required)")).toBeInTheDocument();
    const venteliste = document.getElementById("rsvp-venteliste");
    expect(within(venteliste).getByRole("button", { name: "2 guests" })).toHaveAttribute("aria-pressed", "true");
    expect(api.post).not.toHaveBeenCalled();
  });

  it("says it in Danish", async () => {
    lang.code = "da";
    full();
    renderStand();
    await sizeButton(1);
    fireEvent.click(screen.getByRole("button", { name: da.rsvpSeatWalkIn }));
    const dialog = await screen.findByRole("dialog", { name: da.rsvpSeatNowTitle });
    expect(within(dialog).getByText("Ingen ledige borde lige nu — sæt dem på ventelisten")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: da.rsvpWlAdd })).toBeInTheDocument();
  });

  it("a 409 for a table the host chose shows inside the sheet, and the sheet stays open", async () => {
    full();
    api.post.mockImplementation(() => Promise.reject({ response: { status: 409, data: { detail: { error: "slot_unavailable" } } } }));
    const dialog = await openHeaderSheet();
    fireEvent.change(within(dialog).getByRole("combobox", { name: "Table" }), { target: { value: "3" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Seat now" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const alert = await within(dialog).findByRole("alert");
    expect(alert.textContent).toBe("That table is now taken — pick another free table.");
    expect(screen.getByRole("dialog", { name: "Seat guests" })).toBeInTheDocument();
    // Not on the page behind it.
    expect(screen.queryAllByText("That table is now taken — pick another free table.")).toHaveLength(1);
  });
});

describe("6 · the header covers on a phone", () => {
  it("are a compact row of three below md, not hidden; the parties ride along from md up", async () => {
    renderStand();
    await waitFor(() => expect(document.querySelector('[data-covers="seated"]')).not.toBeNull());
    const group = document.querySelector('[data-covers="seated"]').parentElement;
    expect(group.className).not.toMatch(/(^|\s)hidden(\s|$)/);
    expect(group.className).toMatch(/(^|\s)grid-cols-3(\s|$)/);
    expect(group.className).toMatch(/(^|\s)md:flex(\s|$)/);
    expect(group.className).toMatch(/(^|\s)basis-full(\s|$)/);
    const btn = document.querySelector('[data-covers="expected"]');
    expect(btn.className).toMatch(/min-h-\[40px\]/);
    expect(btn.textContent).toContain("4 guests");
    // The innermost span carrying " · 1 party" (document order: outer first).
    const parties = [...btn.querySelectorAll("span")].filter((s) => s.textContent.includes("1 party")).pop();
    expect(parties.className).toMatch(/(^|\s)hidden md:inline(\s|$)/);
  });
});

describe("9 · one guest is one guest", () => {
  const names = () => [...document.querySelectorAll("[data-walkin]")].map((b) => b.getAttribute("aria-label"));

  it("English: the 1 button reads '1 guest', the rest plural", async () => {
    renderStand();
    await waitFor(async () => expect((await sizeButton(1)).textContent).toContain("Free now"));
    expect(names()[0]).toBe("1 guest: seat now at 41");
    expect(names()[1]).toBe("2 guests: seat now at 41");
    expect(names().join(" ")).not.toMatch(/\b1 guests\b/);
  });

  it("Danish: '1 gæst' on a free table", async () => {
    lang.code = "da";
    renderStand();
    await waitFor(async () => expect((await sizeButton(1)).textContent).toContain(da.rsvpWalkInFreeNow));
    expect(names()[0]).toBe("1 gæst: sæt til bords nu ved 41");
    expect(names()[1]).toBe("2 gæster: sæt til bords nu ved 41");
  });

  it("Danish: '1 gæst' when the room is full and the button waits", async () => {
    lang.code = "da";
    const busy = [...BOOK, row("x", "Holm", "41", "seated", "18:50", "20:20", 2, { seated_at: z("18:50") })];
    mockApi({}, { book: busy });
    renderStand();
    await waitFor(async () => expect((await sizeButton(1)).getAttribute("aria-label")).toMatch(/^1 gæst: intet bord ledigt nu/));
    expect(names().join(" ")).not.toMatch(/\b1 gæster\b/);
  });

  it("before the rules are in", async () => {
    lang.code = "da";
    mockApi({ "/reservations/booking-rules": () => new Promise(() => {}) });
    renderStand("/stand/tok-door-1");
    await sizeButton(1);
    expect(names()[0]).toBe("1 gæst: vælg bord");
    expect(names()[1]).toBe("2 gæster: vælg bord");
  });

  it("every new One key has real Danish and English", () => {
    for (const k of ["rsvpWalkInPickAriaOne", "rsvpWalkInSeatAriaOne", "rsvpWalkInWaitAriaOne", "rsvpWalkInWlAriaOne", "rsvpCombineSeatsOne", "rsvpTimeMovedCloseOne", "rsvpRailDayLineOne"]) {
      expect(da[k], k).toMatch(/1 gæst\b/);
      expect(da[k], k).not.toMatch(/1 gæster/);
      expect(en[k], k).toMatch(/1 guest\b/);
    }
  });
});
