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
import { render, screen, fireEvent, waitFor, within, configure } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

// Push 8 review: on a loaded machine (load average 200–800) five of these
// timed out — "Timed out in waitFor" (1 s default) and "Test timed out in
// 5000ms" — while the file alone passed 19/19; a test here takes 4–6 s under
// load. The waits are for the page, not for a deadline the page must meet.
vi.setConfig({ testTimeout: 30000 });
configure({ asyncUtilTimeout: 5000 });

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

  it("the header's 'Seat a drop-in' sheet gets the same line as a one-tap seat", async () => {
    // One tap on "2" first: the line a one-tap seat gets.
    renderStand();
    await waitFor(async () => expect((await sizeButton(2)).textContent).toContain("Free now"));
    fireEvent.click(await sizeButton(2));
    const oneTap = await screen.findByText("2 guests seated at 41");
    const oneTapLine = oneTap.closest("[data-walkin-done]");
    expect(oneTapLine.dataset.walkinDone).toBe("seated");
    fireEvent.click(within(oneTapLine).getByRole("button", { name: "Close" }));
    await waitFor(() => expect(document.querySelector("[data-walkin-done]")).toBeNull());
    // The header's sheet, on the table it picks (41 for two): the same line.
    fireEvent.click(screen.getByRole("button", { name: "Seat a drop-in" }));
    const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Table" })).toHaveValue("41"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Seat now" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(2));
    const fromSheet = await screen.findByText("2 guests seated at 41");
    expect(fromSheet.closest("[data-walkin-done]").dataset.walkinDone).toBe("seated");
    expect(screen.queryByRole("dialog", { name: "Seat guests" })).toBeNull();
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

  it("a one-tap seat of one: '1 gæst sat ved 41' / '1 guest seated at 41'", async () => {
    renderStand();
    await waitFor(async () => expect((await sizeButton(1)).textContent).toContain("Free now"));
    fireEvent.click(await sizeButton(1));
    expect(await screen.findByText("1 guest seated at 41")).toBeInTheDocument();
    expect(da.rsvpWalkInSeatedOne.replace("{table}", "41")).toBe("1 gæst sat ved 41");
  });

  it.each([["da", "1 gæst", /(^|\D)1 gæster/], ["en", "1 guest", /(^|\D)1 guests/]])(
    "%s: a party of one in the drawer reads '%s'",
    async (code, one, plural) => {
      lang.code = code;
      const solo = [...BOOK, row("solo", "Holm", null, "confirmed", "19:30", "21:00", 1)];
      mockApi({}, { book: solo });
      renderStand();
      await waitFor(() => expect(compactRowOf("Holm")).toBeTruthy());
      fireEvent.click(compactRowOf("Holm"));
      const drawer = await screen.findByRole("dialog");
      // The party line under the name is exactly "1 gæst" — it read "1 gæster".
      await waitFor(() => expect([...drawer.querySelectorAll("div")].some((d) => d.textContent.trim() === one)).toBe(true));
      expect(drawer.textContent).not.toMatch(plural);
    },
  );

  it("every new One key has real Danish and English", () => {
    for (const k of ["rsvpWalkInPickAriaOne", "rsvpWalkInSeatAriaOne", "rsvpWalkInWaitAriaOne", "rsvpWalkInWlAriaOne", "rsvpCombineSeatsOne", "rsvpTimeMovedCloseOne", "rsvpRailDayLineOne"]) {
      expect(da[k], k).toMatch(/1 gæst\b/);
      expect(da[k], k).not.toMatch(/1 gæster/);
      expect(en[k], k).toMatch(/1 guest\b/);
    }
  });
});

/* ─── Push 8 review round (13 Oct 2026) ────────────────────────────────────
 *
 *   3. The line after a joined seat was cut on a phone ("7 gæster sat ved
 *      Bord 2…": 144 of 279 px at 360) — the second table, often across the
 *      room, never showed; seated list rows cut theirs too ("Bord 8 + Bo…").
 *      It wraps now, never cut. (jsdom cannot measure: the classes that make
 *      it wrap are what is pinned; the layout was checked in a browser.)
 *   3. A seat from the header's sheet where the drop-in row is not on screen
 *      (the book page, the stand's Floor view) said nothing: the same line
 *      floats over the foot of the page there.
 *   4/5. Free tables that are all too small for the party is not "no table
 *      free right now": the sheet says no free table seats them.
 *   5. After a 409 the sheet reads the room again: the refused table is
 *      marked taken and no longer picked.
 */
const classesOf = (el) => el.className.split(/\s+/);

describe("3 · the line names every table, on a phone too (review)", () => {
  const JOINABLE = [
    ...RESOURCES,
    table("51", 4, { combinable: true }),
    table("52", 2, { combinable: true }),
  ];
  it("wraps — never truncates — and its buttons go under it on a phone", async () => {
    mockApi({}, { resources: JOINABLE });
    renderStand();
    await waitFor(async () => expect((await sizeButton(6)).textContent).toContain("Free now"));
    fireEvent.click(await sizeButton(6));
    const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
    fireEvent.click(within(dialog).getByRole("button", { name: "Seat now" }));
    const text = await waitFor(() => {
      const el = document.querySelector("[data-walkin-done-text]");
      expect(el).not.toBeNull();
      return el;
    });
    expect(text.textContent).toBe("6 guests seated at 51 + 52");
    expect(classesOf(text)).not.toContain("truncate");
    expect(classesOf(text)).toEqual(expect.arrayContaining(["break-words", "flex-1", "min-w-0"]));
    // Below sm the sentence takes the first line beside its icon; the buttons wrap under it.
    expect(classesOf(text)).toEqual(expect.arrayContaining(["basis-[calc(100%-1.5rem)]", "sm:basis-0"]));
    const line = text.closest("[data-walkin-done]");
    expect(classesOf(line)).toContain("flex-wrap");
    // On the stand's List view it sits in the drop-in row, not floating.
    expect(line.closest("[data-walkin-done-float]")).toBeNull();
    expect(line.closest('section[aria-labelledby="rsvp-walkin-title"]')).not.toBeNull();
  });

  it("a party at tables pushed together keeps all of them on its list row", async () => {
    renderStand();
    await waitFor(() => expect(compactRowOf("Selskab Kragh")).toBeTruthy());
    const meta = compactRowOf("Selskab Kragh").querySelector("[data-row-meta]");
    expect(classesOf(meta)).toContain("flex-wrap");
    const tables = meta.querySelector("[data-row-tables]");
    expect(tables.textContent).toBe("31 + 32 + 33");
    expect(tables.getAttribute("title")).toBe("31 + 32 + 33");
    expect(classesOf(tables)).toContain("max-w-full");
    // A party at one table keeps its one line.
    expect(classesOf(compactRowOf("Birk").querySelector("[data-row-meta]"))).not.toContain("flex-wrap");
  });
});

describe("3 · where the drop-in row is not on screen, the line floats (review)", () => {
  const seatFromHeader = async () => {
    fireEvent.click(await screen.findByRole("button", { name: "Seat a drop-in" }));
    const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Table" })).toHaveValue("41"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Seat now" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    return screen.findByText("2 guests seated at 41");
  };

  it("on the book page (/reservations)", async () => {
    renderStand("/reservations");
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/reservations/book", expect.anything()));
    expect(document.querySelector("[data-walkin-grid]")).toBeNull();
    const said = await seatFromHeader();
    const float = said.closest("[data-walkin-done-float]");
    expect(float).not.toBeNull();
    expect(classesOf(float)).toContain("fixed");
    expect(said.closest("[data-walkin-done]").dataset.walkinDone).toBe("seated");
    // Change table opens the booking and the line goes.
    fireEvent.click(within(float).getByRole("button", { name: "Change table" }));
    await waitFor(() => expect(document.querySelector("[data-walkin-done-float]")).toBeNull());
  });

  it("on the stand's Floor view", async () => {
    renderStand();
    await sizeButton(1);
    fireEvent.click(screen.getAllByRole("tab", { name: "Floor" })[0]);
    await waitFor(() => expect(document.querySelector("[data-walkin-grid]")).toBeNull());
    const said = await seatFromHeader();
    expect(said.closest("[data-walkin-done-float]")).not.toBeNull();
  });
});

describe("4/5 · free tables, none big enough (review)", () => {
  // An empty room: two four-tops and a two-top, none joinable, no bookings.
  const EMPTY = [table("1", 4), table("2", 4), table("3", 2)];
  const openFor = async (n) => {
    mockApi({}, { book: [], resources: EMPTY });
    renderStand();
    await sizeButton(1);
    fireEvent.click(screen.getByRole("button", { name: lang.code === "da" ? da.rsvpSeatWalkIn : "Seat a drop-in" }));
    const dialog = await screen.findByRole("dialog", { name: lang.code === "da" ? da.rsvpSeatNowTitle : "Seat guests" });
    fireEvent.click(within(dialog).getByRole("button", { name: lang.code === "da" ? `${n} gæster` : `${n} guests` }));
    return dialog;
  };

  it("an empty room and a party of ten: no free table seats ten — not 'no table free'", async () => {
    const dialog = await openFor(10);
    await waitFor(() => expect(within(dialog).getByText("No free table seats 10 — choose a table yourself, or put them on the waitlist")).toBeInTheDocument());
    expect(within(dialog).queryByText("No table free right now — put them on the waitlist")).toBeNull();
    expect(dialog.querySelector("[data-seat-none-free]").getAttribute("data-seat-none-free")).toBe("size");
    // Nothing is picked for them; the host may pick by hand, and is told the size.
    const sel = within(dialog).getByRole("combobox", { name: "Table" });
    expect(sel).toHaveValue("");
    expect(within(dialog).getByRole("button", { name: "Seat now" })).toBeDisabled();
    fireEvent.change(sel, { target: { value: "1" } });
    expect(within(dialog).getByText("That table seats 4 — you're seating 10.")).toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Seat now" })).not.toBeDisabled();
    // The waitlist stays one tap away.
    expect(within(dialog).getByRole("button", { name: "Add to waitlist" })).toBeInTheDocument();
  });

  it("in Danish", async () => {
    lang.code = "da";
    const dialog = await openFor(10);
    await waitFor(() => expect(within(dialog).getByText("Intet ledigt bord har plads til 10 — vælg et bord selv, eller sæt dem på ventelisten")).toBeInTheDocument());
    expect(within(dialog).queryByText(da.rsvpSeatNoneFree)).toBeNull();
  });

  it("a party a free table fits gets that table, and no message", async () => {
    const dialog = await openFor(4);
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Table" })).toHaveValue("1"));
    expect(dialog.querySelector("[data-seat-none-free]")).toBeNull();
  });

  it("a full room still says no table is free", async () => {
    const ROOM = [table("1", 2), table("2", 2), table("4", 4)];
    const FULL = [
      row("s1", "Anders", "1", "seated", "18:30", "20:00", 2, { seated_at: z("18:30") }),
      row("s2", "Drop-in", "2", "seated", "18:40", "20:10", 2, { seated_at: z("18:40") }),
      row("s4", "Berg", "4", "seated", "18:20", "20:20", 4, { seated_at: z("18:20") }),
    ];
    mockApi({}, { book: FULL, resources: ROOM });
    renderStand();
    await sizeButton(1);
    fireEvent.click(screen.getByRole("button", { name: "Seat a drop-in" }));
    const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
    fireEvent.click(within(dialog).getByRole("button", { name: "8 guests" }));
    await waitFor(() => expect(within(dialog).getByText("No table free right now — put them on the waitlist")).toBeInTheDocument());
    expect(dialog.querySelector("[data-seat-none-free]").getAttribute("data-seat-none-free")).toBe("room");
  });

  it("every new key has real Danish and English", () => {
    expect(da.rsvpSeatNoneFits).toMatch(/^Intet ledigt bord har plads til \{n\}/);
    expect(en.rsvpSeatNoneFits).toMatch(/^No free table seats \{n\}/);
  });
});

describe("5 · after a 409 the sheet reads the room again (review)", () => {
  const HOLM = row("x", "Holm", "41", "seated", "19:00", "20:30", 2, { seated_at: z("19:00") });
  // Another host seats a party at 41 while the sheet is open: the server
  // refuses this seat, and from then on the book holds Holm at 41.
  const raced = () => {
    let taken = false;
    mockApi({
      "/reservations/book": () => Promise.resolve({
        data: { date: DAY, reservations: taken ? [...BOOK, HOLM] : BOOK, summary: { total: 0, covers: 0, by_status: {} } },
      }),
    });
    api.post.mockImplementation(() => {
      taken = true;
      return Promise.reject({ response: { status: 409, data: { detail: { error: "table_occupied", occupant: { table: "41", name: "Holm" } } } } });
    });
  };
  const bookReads = () => api.get.mock.calls.filter(([u]) => u === "/reservations/book").length;

  it.each([["pre-picked", false], ["picked by hand", true]])(
    "the refused table (%s) is marked taken and no longer picked; the refusal stays in the sheet",
    async (_label, byHand) => {
      raced();
      renderStand();
      await sizeButton(1);
      fireEvent.click(screen.getByRole("button", { name: "Seat a drop-in" }));
      const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
      const sel = within(dialog).getByRole("combobox", { name: "Table" });
      await waitFor(() => expect(sel).toHaveValue("41"));
      if (byHand) fireEvent.change(sel, { target: { value: "41" } });
      const before = bookReads();
      fireEvent.click(within(dialog).getByRole("button", { name: "Seat now" }));
      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toBe("41 is still taken — finish the party there first, or pick another table.");
      expect(bookReads()).toBeGreaterThan(before);
      await waitFor(() => expect(within(dialog).getByRole("option", { name: /^41 · 2 seats — occupied$/ })).toBeDisabled());
      await waitFor(() => expect(sel).toHaveValue(""));
      expect(within(dialog).getByRole("button", { name: "Seat now" })).toBeDisabled();
      // Still said in the sheet, and only there.
      expect(screen.queryAllByText("41 is still taken — finish the party there first, or pick another table.")).toHaveLength(1);
      expect(api.post).toHaveBeenCalledTimes(1);
    },
  );
});

describe("6 · the covers give no count before the book is in (review)", () => {
  it("'—', never '0 guests', while the book loads; the counts once it has arrived", async () => {
    let arrive;
    mockApi({ "/reservations/book": () => new Promise((resolve) => { arrive = resolve; }) });
    renderStand();
    await waitFor(() => expect(document.querySelector('[data-covers="seated"]')).not.toBeNull());
    await waitFor(() => expect(typeof arrive).toBe("function"));
    for (const k of ["seated", "expected", "finished"]) {
      const cell = document.querySelector(`[data-covers="${k}"]`);
      expect(cell.querySelector("[data-covers-unknown]")).not.toBeNull();
      expect(cell.textContent).not.toMatch(/\b0 guests?\b/);
    }
    arrive({ data: { date: DAY, reservations: BOOK, summary: { total: BOOK.length, covers: 0, by_status: {} } } });
    await waitFor(() => expect(document.querySelector("[data-covers-unknown]")).toBeNull());
    expect(document.querySelector('[data-covers="seated"]').textContent).toMatch(/\d+ guests/);
    expect(document.querySelector('[data-covers="finished"]').textContent).toMatch(/\d+ guests/);
  });
});

// ── Push 8 review (round 3): the minor findings on the stand ─────────────

describe("4/5 · a full room gives one message for every party size (review 3)", () => {
  // Venue "full": 1 and 3 seated; 2 (a two-top) is free now but booked at
  // 19:20. Party 1–2 read "No table free right now"; party 3–4 read "No free
  // table seats 3 — choose a table yourself", as if a table stood free.
  const ROOM = [table("1", 4), table("2", 2), table("3", 4)];
  const FULL = [
    row("s1", "Anders", "1", "seated", "18:30", "20:00", 4, { seated_at: z("18:30") }),
    row("s3", "Berg", "3", "seated", "18:20", "20:20", 4, { seated_at: z("18:20") }),
    row("r2", "Dahl", "2", "confirmed", "19:20", "20:50", 2),
  ];
  it.each([1, 2, 3, 4])("party %i: 'No table free right now', with the waitlist", async (n) => {
    mockApi({}, { book: FULL, resources: ROOM });
    renderStand();
    await sizeButton(1);
    fireEvent.click(screen.getByRole("button", { name: "Seat a drop-in" }));
    const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
    fireEvent.click(within(dialog).getByRole("button", { name: n === 1 ? "1 guest" : `${n} guests` }));
    await waitFor(() => expect(within(dialog).getByText("No table free right now — put them on the waitlist")).toBeInTheDocument());
    expect(dialog.querySelector("[data-seat-none-free]").getAttribute("data-seat-none-free")).toBe("room");
    expect(within(dialog).getByRole("combobox", { name: "Table" })).toHaveValue("");
    expect(within(dialog).getByRole("button", { name: "Add to waitlist" })).toBeInTheDocument();
  });
});

describe("2/3 · tables pushed together wrap on a phone row, never cut (review 3)", () => {
  // At 360 "Vinduesbord 11 + Vinduesbord 12 + Terrassebord 13" read
  // "Vinduesbord 11 + Vind…" (seated) and "… 12 …" (finished): the third
  // table never showed, and the title tooltip does not open on a phone.
  const LONG = [table("v11", 2, { label: "Vinduesbord 11" }), table("v12", 2, { label: "Vinduesbord 12" }), table("t13", 4, { label: "Terrassebord 13" }), table("41", 2)];
  const joined = { combined_resource_ids: ["v11", "v12", "t13"], combined_resource_labels: ["Vinduesbord 11", "Vinduesbord 12", "Terrassebord 13"] };
  const BOOK3 = [
    row("j1", "Selskab Kragh", "v11", "seated", "18:30", "20:30", 8, { seated_at: z("18:30"), ...joined }),
    row("j2", "Selskab Riis", "v11", "completed", "16:00", "17:30", 8, { seated_at: z("16:00"), completed_at: z("17:40"), ...joined }),
  ];
  const ALL3 = "Vinduesbord 11 + Vinduesbord 12 + Terrassebord 13";

  it("a seated party: all three tables, wrapping", async () => {
    mockApi({}, { book: BOOK3, resources: LONG });
    renderStand();
    await waitFor(() => expect(compactRowOf("Selskab Kragh")).toBeTruthy());
    const tables = compactRowOf("Selskab Kragh").querySelector("[data-row-tables]");
    expect(tables.textContent).toBe(ALL3);
    expect(classesOf(tables)).not.toContain("truncate");
    expect(classesOf(tables)).toEqual(expect.arrayContaining(["whitespace-normal", "break-words", "max-w-full", "min-w-0"]));
  });

  it("a finished party: all three tables, wrapping", async () => {
    mockApi({}, { book: BOOK3, resources: LONG });
    renderStand();
    await waitFor(() => expect(document.querySelector('[data-covers="finished"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-covers="finished"]'));
    await waitFor(() => expect(compactRowOf("Selskab Riis")).toBeTruthy());
    const tables = compactRowOf("Selskab Riis").querySelector("[data-row-tables]");
    expect(tables.textContent).toBe(ALL3);
    expect(classesOf(tables)).not.toContain("truncate");
    expect(classesOf(tables)).toEqual(expect.arrayContaining(["whitespace-normal", "break-words"]));
  });

  it("a party at one table keeps its one truncating line (unchanged)", async () => {
    renderStand();
    await waitFor(() => expect(compactRowOf("Birk")).toBeTruthy());
    const tables = compactRowOf("Birk").querySelector("[data-row-tables]");
    expect(classesOf(tables)).toContain("truncate");
  });
});

describe("6 · the stand header keeps its controls on the title's line (review 3)", () => {
  // "Brasserie Kongens Nytorv & Vinbar" pushed the sound and ⋯ controls onto
  // a left-aligned row of their own at 360–414 and at 1024 × 768: the title
  // block took its full width in a wrapping row.
  it("the row wraps only below md, and the title takes what is left (basis 0) and truncates", async () => {
    renderStand();
    await waitFor(() => expect(document.querySelector("[data-stand-header]")).not.toBeNull());
    const header = document.querySelector("[data-stand-header]");
    expect(classesOf(header)).toEqual(expect.arrayContaining(["flex-wrap", "md:flex-nowrap"]));
    const title = header.querySelector("[data-stand-title]");
    expect(classesOf(title)).toEqual(expect.arrayContaining(["min-w-0", "max-md:flex-1", "max-md:basis-0"]));
    // The covers keep their own full-width row on a phone.
    const covers = header.querySelector('[role="group"]');
    expect(classesOf(covers)).toEqual(expect.arrayContaining(["order-last", "basis-full", "md:order-none", "md:basis-auto"]));
  });
});

describe("3 · the floating line carries the doctrine's light shadow (review 3)", () => {
  it("the light shadow (shadow-sm), never a heavy one", async () => {
    renderStand("/reservations");
    await waitFor(() => expect(api.get).toHaveBeenCalledWith("/reservations/book", expect.anything()));
    fireEvent.click(await screen.findByRole("button", { name: "Seat a drop-in" }));
    const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Table" })).toHaveValue("41"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Seat now" }));
    const said = await screen.findByText("2 guests seated at 41");
    const float = said.closest("[data-walkin-done-float]");
    expect(classesOf(float)).toContain("shadow-sm");
    expect(classesOf(float).some((c) => /^shadow-(lg|xl|2xl)$/.test(c))).toBe(false);
  });
});

describe("9 · one is one on the Plan lens (review 3)", () => {
  it("'1 ledig nu', never '1 ledige nu'", async () => {
    lang.code = "da";
    renderStand();
    await sizeButton(1);
    fireEvent.click(screen.getAllByRole("tab", { name: da.rsvpViewPlan })[0]);
    await waitFor(() => expect(screen.getByText(da.rsvpTurnFreeNowOne)).toBeInTheDocument());
    expect(document.body.textContent).not.toContain("1 ledige nu");
    expect(en.rsvpTurnFreeNowOne).toBe("1 free now");
  });
});
