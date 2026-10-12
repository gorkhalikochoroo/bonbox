/**
 * The host stand, walked as a host at 19:00 on a busy evening
 * (/reservations/stand). What a host at the door has to read and do in one
 * look, one tap:
 *   • drop-in by party size: "Free now" seats the party at once on the
 *     smallest free table that fits, and says where (with "Change table");
 *     no table free → the Venteliste form opens with the size filled in, and
 *     the button says when one frees ("approx. HH.MM", from booked ends);
 *   • covers in the header: seated / expected / finished, guests and parties;
 *   • a finished party reads seated → left and the time at the table, and the
 *     finished list runs in the order they sat down;
 *   • the floor joins the tables a combined party sits at;
 *   • on the paired door device (/stand/<token>) the row claims nothing until
 *     the venue's own turn times and hours have arrived — from the device's
 *     own read-only door, never /settings;
 *   • a party only joined tables seat reads "Free now" and one tap seats them
 *     there; on a phone the six sizes are a 3×2 grid.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useAuth", () => ({
  useAuth: () => ({ user: { business_type: "restaurant", business_name: "Havnen" }, logout: vi.fn(), loading: false }),
}));
vi.mock("../hooks/useLanguage", () => ({
  useLanguage: () => ({
    t: (_k, fb, vars) =>
      String(typeof fb === "string" ? fb : _k).replace(/\{(\w+)\}/g, (m, k) => (vars && k in vars ? vars[k] : m)),
    lang: "en",
  }),
}));
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
import FloorPlan from "../components/FloorPlan";
import { deriveFloorState } from "../utils/floorState";

const DAY = "2026-10-12";
const at = (hhmm) => `${DAY}T${hhmm}:00`;
const z = (hhmm) => new Date(at(hhmm)).toISOString();

const table = (id, seats, x, y) => ({ id, label: id, capacity_seats: seats, kind: "table", is_active: true, zone: "Sal", pos_x: x, pos_y: y });
const RESOURCES = [
  table("21", 2, 10, 20), table("22", 2, 25, 20), table("23", 4, 40, 20), table("25", 6, 60, 20),
  table("31", 2, 10, 60), table("32", 2, 25, 60), table("33", 4, 40, 60), table("41", 2, 80, 80),
];
const row = (id, name, tableId, status, from, to, party, extra = {}) => ({
  id, guest_name: name, resource_id: tableId, status, starts_at: at(from), ends_at: at(to),
  party_size: party, source: "manual", allergen_tags: [], seated_at: null, completed_at: null, ...extra,
});
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

// `over` answers chosen urls differently: { url: () => Promise }.
function mockApi(over = {}) {
  api.get.mockImplementation((url) => {
    if (over[url]) return over[url]();
    if (url === "/reservations/settings") return Promise.resolve({ data: RULES });
    if (url === "/reservations/book") {
      return Promise.resolve({ data: { date: DAY, reservations: BOOK, summary: { total: BOOK.length, covers: 0, by_status: {} } } });
    }
    if (url === "/reservations/resources") {
      return Promise.resolve({ data: { resources: RESOURCES, fixtures: [], venue_seats_total: 24 } });
    }
    if (url === "/reservations/waitlist") return Promise.resolve({ data: { waitlist: [], active_count: 0 } });
    return Promise.resolve({ data: {} });
  });
  // The booking as the server answers it (_reservation_dict): joined tables
  // come back as combined_resource_ids with the first as resource_id — the
  // server never echoes a resource_ids field.
  api.post.mockImplementation((url, body) => {
    const { resource_ids: joined, ...rest } = body || {};
    return Promise.resolve({
      data: {
        id: "new-walkin",
        ...rest,
        ...(Array.isArray(joined) && joined.length > 1
          ? { resource_id: joined[0], combined_resource_ids: joined }
          : { combined_resource_ids: null }),
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
const walkinText = () =>
  [...document.querySelectorAll("[data-walkin]")].map((b) => b.textContent.replace(/\s+/g, " ").trim());
const sizeButton = async (n) => {
  await waitFor(() => expect(document.querySelector(`[data-walkin="${n}"]`)).not.toBeNull());
  return document.querySelector(`[data-walkin="${n}"]`);
};

describe("drop-in by party size", () => {
  it("says Free now where a table fits, and approx. HH.MM from booked ends where none does", async () => {
    renderStand();
    expect((await sizeButton(1)).textContent).toContain("Free now");
    expect((await sizeButton(2)).textContent).toContain("Free now");
    expect((await sizeButton(3)).textContent).toContain("approx. 20.15");
    expect((await sizeButton(5)).textContent).toContain("approx. 20.45");
    expect((await sizeButton(6)).textContent).toMatch(/6\+/);
    // The estimate says how it was made.
    expect(screen.getByText(/worked out from the bookings' end times/)).toBeInTheDocument();
  });

  it("one tap seats a couple on the smallest free table and names it", async () => {
    renderStand();
    fireEvent.click(await sizeButton(2));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe("/reservations/book");
    expect(body).toMatchObject({ resource_id: "41", party_size: 2, status: "seated", source: "walk_in" });
    expect(await screen.findByText("2 guests seated at 41")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Change table" })).toBeInTheDocument();
  });

  it("no table free now → the waitlist form opens on that party size, nothing is seated", async () => {
    renderStand();
    fireEvent.click(await sizeButton(4));
    expect(await screen.findByPlaceholderText("Phone (required)")).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    const venteliste = document.getElementById("rsvp-venteliste");
    const chip = within(venteliste).getByRole("button", { name: "4 guests" });
    expect(chip).toHaveAttribute("aria-pressed", "true");
  });
});

describe("the paired door device", () => {
  const DEVICE = "/stand/tok-door-1";

  it("claims nothing until the venue's turn times and hours arrive — then the same answers as the owner's stand", async () => {
    let arrive;
    mockApi({
      "/reservations/booking-rules": () => new Promise((res) => { arrive = () => res({ data: RULES }); }),
      // What the device met before: /settings rewritten onto the stand prefix, 404.
      "/reservations/settings": () => Promise.reject({ response: { status: 404, data: { detail: { error: "not_found" } } } }),
    });
    renderStand(DEVICE);
    await sizeButton(1);
    const texts = walkinText();
    expect(texts).toHaveLength(6);
    for (const x of texts) {
      expect(x).not.toMatch(/Free now|approx\./);
      expect(x).toContain("—");
    }
    expect([...document.querySelectorAll("[data-walkin]")].every((b) => b.dataset.walkinState === "unknown")).toBe(true);
    const asked = api.get.mock.calls.map((c) => c[0]);
    expect(asked).toContain("/reservations/booking-rules");
    expect(asked).not.toContain("/reservations/settings");

    // A tap still helps the host: the seat sheet opens on that size, and
    // nothing is seated by a guess.
    fireEvent.click(await sizeButton(3));
    expect(await screen.findByRole("dialog", { name: "Seat guests" })).toBeInTheDocument();
    expect(api.post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Close" }));

    arrive();
    await waitFor(() => expect((document.querySelector('[data-walkin="1"]')).textContent).toContain("Free now"));
    expect(document.querySelector('[data-walkin="3"]').textContent).toContain("approx. 20.15");
  });

  it("stays silent when the device cannot read the rules at all", async () => {
    mockApi({ "/reservations/booking-rules": () => Promise.reject({ response: { status: 404 } }) });
    renderStand(DEVICE);
    await sizeButton(1);
    await waitFor(() => expect(api.get.mock.calls.map((c) => c[0])).toContain("/reservations/booking-rules"));
    expect(walkinText().join(" ")).not.toMatch(/Free now|approx\./);
  });

  it("asks again on the minute tick until the rules arrive — a 404 mid-deploy too — then stops asking", async () => {
    const ticks = minuteTicks();
    try {
      const answers = [
        () => Promise.reject({ response: { status: 404 } }), // the API mid-deploy
        () => Promise.reject(new Error("Network Error")), // the tablet's Wi-Fi not up after waking
        () => Promise.resolve({ data: RULES }),
      ];
      let n = 0;
      mockApi({ "/reservations/booking-rules": () => answers[Math.min(n++, answers.length - 1)]() });
      renderStand(DEVICE);
      await sizeButton(1);
      const asks = () => api.get.mock.calls.filter((c) => c[0] === "/reservations/booking-rules").length;
      await waitFor(() => expect(asks()).toBe(1));
      expect(walkinText().join(" ")).not.toMatch(/Free now|approx\./);

      await ticks.to("19:01");
      await waitFor(() => expect(asks()).toBe(2));
      expect(walkinText().join(" ")).not.toMatch(/Free now|approx\./);

      await ticks.to("19:02");
      await waitFor(() => expect(document.querySelector('[data-walkin="1"]').textContent).toContain("Free now"));
      expect(asks()).toBe(3);

      // In: the tick asks no more.
      await ticks.to("19:03");
      await ticks.to("19:04");
      expect(asks()).toBe(3);
      // Never /settings from the device, and nothing said about the misses.
      expect(api.get.mock.calls.map((c) => c[0])).not.toContain("/reservations/settings");
      expect(document.querySelector(".bg-red-50")).toBeNull();
    } finally {
      ticks.restore();
    }
  });
});

// Every single table that seats five or six is taken; 51 + 52 are a free,
// joinable pair — the set the booking engine would seat them at.
const JOINABLE = [
  ...RESOURCES,
  { ...table("51", 4, 70, 40), combinable: true },
  { ...table("52", 2, 80, 40), combinable: true },
];

// The page's minute tick, run by hand: the clock moves on, then every
// 60-second interval the page set fires (other timers stay real, so waitFor
// keeps working).
function minuteTicks() {
  const fns = [];
  const real = globalThis.setInterval;
  const spy = vi.spyOn(globalThis, "setInterval").mockImplementation((fn, ms, ...rest) => {
    if (ms === 60000) fns.push(fn);
    return real.call(globalThis, fn, ms, ...rest);
  });
  return {
    async to(hhmm) {
      vi.setSystemTime(new Date(at(hhmm)));
      await act(async () => { fns.forEach((f) => f()); });
    },
    restore: () => spy.mockRestore(),
  };
}

describe("joined tables at the door", () => {
  // A server that seats one party across joined tables: it has the
  // booking-rules door (the owner's stand reads its rules there).
  const withJoinable = () => mockApi({
    "/reservations/resources": () => Promise.resolve({ data: { resources: JOINABLE, fixtures: [], venue_seats_total: 30 } }),
    "/reservations/booking-rules": () => Promise.resolve({ data: RULES }),
  });

  it("says Free now for five and one tap seats them across both tables", async () => {
    withJoinable();
    renderStand();
    await waitFor(async () => expect((await sizeButton(5)).textContent).toContain("Free now"));
    fireEvent.click(await sizeButton(5));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const [url, body] = api.post.mock.calls[0];
    expect(url).toBe("/reservations/book");
    expect(body).toMatchObject({ resource_id: null, resource_ids: ["51", "52"], party_size: 5, status: "seated", source: "walk_in" });
    expect(await screen.findByText("5 guests seated at 51 + 52")).toBeInTheDocument();
  });

  it("6+ opens the seat sheet with the joined tables already picked", async () => {
    withJoinable();
    renderStand();
    await waitFor(async () => expect((await sizeButton(6)).textContent).toContain("Free now"));
    fireEvent.click(await sizeButton(6));
    const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
    expect(within(dialog).getByText("51 + 52 · 6 seats")).toBeInTheDocument();
    expect(within(dialog).getByRole("combobox", { name: "Table" })).toHaveValue("__joined");
    fireEvent.click(within(dialog).getByRole("button", { name: "Seat now" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1]).toMatchObject({ resource_id: null, resource_ids: ["51", "52"], party_size: 6 });
  });

  it("names the tables from the server's answer", async () => {
    withJoinable();
    // Held at 51 + 52 — the server lists them in its own order.
    api.post.mockImplementation((url, body) => Promise.resolve({
      data: { id: "held", guest_name: body.guest_name, party_size: body.party_size, status: "seated", resource_id: "52", combined_resource_ids: ["52", "51"] },
    }));
    renderStand();
    await waitFor(async () => expect((await sizeButton(5)).textContent).toContain("Free now"));
    fireEvent.click(await sizeButton(5));
    expect(await screen.findByText("5 guests seated at 52 + 51")).toBeInTheDocument();
    expect(document.querySelector("[data-walkin-done]").dataset.walkinDone).toBe("seated");
  });

  it("says in amber where a server that ignored the tables actually seated them — never a green 'seated at'", async () => {
    withJoinable();
    // What a server that drops resource_ids answers: its own pick, 201.
    api.post.mockImplementation((url, body) => Promise.resolve({
      data: { id: "elsewhere", guest_name: body.guest_name, party_size: body.party_size, status: "seated", resource_id: "41", combined_resource_ids: null },
    }));
    renderStand();
    await waitFor(async () => expect((await sizeButton(5)).textContent).toContain("Free now"));
    fireEvent.click(await sizeButton(5));
    await waitFor(() => expect(document.querySelector("[data-walkin-done]")).not.toBeNull());
    const line = document.querySelector("[data-walkin-done]");
    expect(line.dataset.walkinDone).toBe("moved");
    expect(line.textContent).toContain("Seated at 41 — not at 51 + 52");
    expect(screen.queryByText("5 guests seated at 51 + 52")).toBeNull();
    // The booking is still one tap away, to move them.
    expect(within(line).getByRole("button", { name: "Change table" })).toBeInTheDocument();
  });
});

describe("a server older than joined tables (the frontend goes live first)", () => {
  it("offers and sends single tables only until the booking-rules door answers — then joined, without a reload", async () => {
    const ticks = minuteTicks();
    try {
      let door = () => Promise.reject({ response: { status: 404, data: { detail: "Not Found" } } });
      mockApi({
        "/reservations/resources": () => Promise.resolve({ data: { resources: JOINABLE, fixtures: [], venue_seats_total: 30 } }),
        "/reservations/booking-rules": () => door(),
      });
      renderStand();
      // The rules from /settings as before — real waits, single tables only.
      await waitFor(async () => expect((await sizeButton(5)).textContent).toContain("approx. 20.45"));
      expect((await sizeButton(6)).textContent).toContain("approx. 20.45");
      expect(api.get.mock.calls.map((c) => c[0])).toContain("/reservations/settings");
      // Five at the door: the waitlist, as before joined tables — no seat.
      fireEvent.click(await sizeButton(5));
      expect(await screen.findByPlaceholderText("Phone (required)")).toBeInTheDocument();
      // The seat sheet lists no joined set either.
      fireEvent.click(screen.getByRole("button", { name: "Seat a drop-in" }));
      const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
      fireEvent.click(within(dialog).getByRole("button", { name: "6 guests" }));
      const sel = within(dialog).getByRole("combobox", { name: "Table" });
      expect([...sel.querySelectorAll("option")].map((o) => o.value)).not.toContain("__joined");
      fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
      expect(api.post).not.toHaveBeenCalled();

      // The API lands; the next minute's tick asks the door again.
      door = () => Promise.resolve({ data: RULES });
      await ticks.to("19:01");
      await waitFor(() => expect(document.querySelector('[data-walkin="5"]').textContent).toContain("Free now"));
      fireEvent.click(await sizeButton(5));
      await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
      expect(api.post.mock.calls[0][1]).toMatchObject({ resource_ids: ["51", "52"], party_size: 5 });
      expect(await screen.findByText("5 guests seated at 51 + 52")).toBeInTheDocument();
    } finally {
      ticks.restore();
    }
  });
});

describe("the seat sheet picks what the drop-in row counted", () => {
  // A six-top that never joins; 51 + 52 that do (4 + 2).
  const ROOM = [
    { ...table("10", 6, 10, 10), combinable: false },
    { ...table("51", 4, 70, 40), combinable: true },
    { ...table("52", 2, 80, 40), combinable: true },
  ];
  const venue = (tiers, book, resources = ROOM) => {
    const rules = {
      settings: { turn_time_tiers: tiers, default_duration_min: 90, combine_enabled: true, max_combo_size: 3 },
      hours_declared: false,
    };
    mockApi({
      "/reservations/booking-rules": () => Promise.resolve({ data: rules }),
      "/reservations/resources": () => Promise.resolve({ data: { resources, fixtures: [], venue_seats_total: 12 } }),
      "/reservations/book": () => Promise.resolve({ data: { date: DAY, reservations: book, summary: { total: book.length, covers: 0, by_status: {} } } }),
    });
  };
  const options = (sel) => [...sel.querySelectorAll("option")].map((o) => o.value);

  it("six-top booked 21.10, a 150-minute sitting for six: row and 6+ sheet both seat them at 51 + 52", async () => {
    venue(
      [{ up_to: 2, minutes: 90 }, { up_to: 4, minutes: 105 }, { up_to: 8, minutes: 150 }],
      [row("x", "Holm", "10", "confirmed", "21:10", "23:40", 6)],
    );
    renderStand();
    await waitFor(async () => expect((await sizeButton(6)).textContent).toContain("Free now"));
    fireEvent.click(await sizeButton(6));
    const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
    const sel = within(dialog).getByRole("combobox", { name: "Table" });
    expect(sel).toHaveValue("__joined");
    expect(within(dialog).getByRole("option", { name: "51 + 52 · 6 seats, pushed together" })).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole("button", { name: "Seat now" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1]).toMatchObject({ resource_id: null, resource_ids: ["51", "52"], party_size: 6 });
  });

  it("six-top booked 20.40, a 90-minute sitting: row and 6+ sheet both seat them at the six-top", async () => {
    venue([{ up_to: 8, minutes: 90 }], [row("x", "Holm", "10", "confirmed", "20:40", "22:10", 6)]);
    renderStand();
    await waitFor(async () => expect((await sizeButton(6)).textContent).toContain("Free now"));
    fireEvent.click(await sizeButton(6));
    const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
    const sel = within(dialog).getByRole("combobox", { name: "Table" });
    expect(sel).toHaveValue("10");
    expect(options(sel)).not.toContain("__joined");
    fireEvent.click(within(dialog).getByRole("button", { name: "Seat now" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    const body = api.post.mock.calls[0][1];
    expect(body).toMatchObject({ resource_id: "10", party_size: 6 });
    expect(body.resource_ids).toBeUndefined();
  });

  it("the header sheet for three and four: the four-top the row counts, not a joined pair", async () => {
    // The four-top is booked at 20.40 — free for a 90-minute sitting from
    // 19.00 — and 31 + 32 are two joinable two-tops.
    venue(
      [{ up_to: 8, minutes: 90 }],
      [row("y", "Juhl", "23", "confirmed", "20:40", "22:10", 4)],
      [
        { ...table("23", 4, 40, 20), combinable: false },
        { ...table("31", 2, 10, 60), combinable: true },
        { ...table("32", 2, 25, 60), combinable: true },
      ],
    );
    renderStand();
    await waitFor(async () => expect((await sizeButton(4)).textContent).toContain("Free now"));
    expect((await sizeButton(3)).textContent).toContain("Free now");
    fireEvent.click(screen.getByRole("button", { name: "Seat a drop-in" }));
    const dialog = await screen.findByRole("dialog", { name: "Seat guests" });
    const sel = within(dialog).getByRole("combobox", { name: "Table" });
    for (const n of [4, 3]) {
      fireEvent.click(within(dialog).getByRole("button", { name: `${n} guests` }));
      await waitFor(() => expect(sel).toHaveValue("23"));
      expect(options(sel)).not.toContain("__joined");
    }
    fireEvent.click(within(dialog).getByRole("button", { name: "Seat now" }));
    await waitFor(() => expect(api.post).toHaveBeenCalledTimes(1));
    expect(api.post.mock.calls[0][1]).toMatchObject({ resource_id: "23", party_size: 3 });
  });
});

describe("the drop-in row on a phone", () => {
  it("is a 3×2 grid below md, six across from md up", async () => {
    renderStand();
    await sizeButton(1);
    const grid = document.querySelector("[data-walkin-grid]");
    expect(grid).not.toBeNull();
    expect(grid.className).toMatch(/(^|\s)grid-cols-3(\s|$)/);
    expect(grid.className).toMatch(/(^|\s)md:grid-cols-6(\s|$)/);
    expect(grid.className).not.toMatch(/(^|\s)grid-cols-6(\s|$)/);
  });
});

describe("the Plan lens keeps the whole room", () => {
  it("does not draw the drop-in row over the fitted floor", async () => {
    renderStand();
    await sizeButton(1);
    fireEvent.click(screen.getByRole("tab", { name: "Floor" }));
    await waitFor(() => expect(document.querySelector("[data-walkin]")).toBeNull());
  });
});

describe("covers in the stand header", () => {
  it("reads seated, expected and finished — guests and parties", async () => {
    renderStand();
    await waitFor(() => expect(document.querySelector('[data-covers="seated"]')).not.toBeNull());
    await waitFor(() => expect(document.querySelector('[data-covers="seated"]').textContent).toContain("22 guests"));
    expect(document.querySelector('[data-covers="seated"]').textContent).toContain("5 parties");
    expect(document.querySelector('[data-covers="expected"]').textContent).toContain("4 guests · 1 party");
    expect(document.querySelector('[data-covers="finished"]').textContent).toContain("5 guests · 2 parties");
  });
});

describe("finished history", () => {
  it("a finished row reads seated → left and the time at the table, in seated order", async () => {
    renderStand();
    await waitFor(() => expect(document.querySelector('[data-covers="finished"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-covers="finished"]'));
    await waitFor(() => expect(document.querySelectorAll("[data-stay]").length).toBeGreaterThanOrEqual(2));
    const stays = [...document.querySelectorAll("[data-stay]")].map((n) => n.textContent.replace(/\s+/g, " ").trim());
    // Hansen sat first (16.55) though booked after Riis (17.00 booked, seated 17.20).
    expect(stays[0]).toBe("16.55 → 18.10 · 1 h 15 min");
    expect(stays[1]).toBe("17.20 → 18.10 · 50 min");
  });

  it("reads the stamps as /book sends them — six-digit fractions and a Z", async () => {
    // utc_now() with microseconds: "2026-10-12T15:20:00.123456Z".
    const micro = (hhmm, frac) => z(hhmm).replace(/\.\d{3}Z$/, `.${frac}Z`);
    const book = BOOK.map((r) =>
      r.id === "riis" ? { ...r, seated_at: micro("17:20", "123456"), completed_at: micro("18:10", "654321") }
        : r.id === "hansen" ? { ...r, seated_at: micro("16:55", "999999"), completed_at: micro("18:10", "000001") }
          : r,
    );
    mockApi({
      "/reservations/book": () => Promise.resolve({ data: { date: DAY, reservations: book, summary: { total: book.length, covers: 0, by_status: {} } } }),
    });
    renderStand();
    await waitFor(() => expect(document.querySelector('[data-covers="finished"]')).not.toBeNull());
    fireEvent.click(document.querySelector('[data-covers="finished"]'));
    await waitFor(() => expect(document.querySelectorAll("[data-stay]").length).toBeGreaterThanOrEqual(2));
    const stays = [...document.querySelectorAll("[data-stay]")].map((n) => n.textContent.replace(/\s+/g, " ").trim());
    expect(stays[0]).toBe("16.55 → 18.10 · 1 h 15 min");
    expect(stays[1]).toBe("17.20 → 18.10 · 50 min");
  });
});

describe("combined tables on the floor", () => {
  it("joins the tables a combined party sits at, neighbour to neighbour", () => {
    const cells = deriveFloorState(BOOK, RESOURCES, new Date(at("19:00")).getTime());
    const { container } = render(<FloorPlan cells={cells} nowMs={new Date(at("19:00")).getTime()} t={(_k, fb) => fb} />);
    const svg = container.querySelector("[data-combo-links]");
    expect(svg).not.toBeNull();
    const edges = [...svg.querySelectorAll("[data-combo-edge]")].map((l) => l.getAttribute("data-combo-edge").split(":").sort().join("-")).sort();
    expect(edges).toEqual(["31-32", "32-33"]);
  });

  it("draws nothing when no party sits at combined tables", () => {
    const single = BOOK.filter((r) => !r.combined_resource_ids);
    const cells = deriveFloorState(single, RESOURCES, new Date(at("19:00")).getTime());
    const { container } = render(<FloorPlan cells={cells} nowMs={new Date(at("19:00")).getTime()} t={(_k, fb) => fb} />);
    expect(container.querySelector("[data-combo-links]")).toBeNull();
  });
});
