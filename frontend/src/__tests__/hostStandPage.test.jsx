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
import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
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
  api.post.mockImplementation((url, body) => Promise.resolve({ data: { id: "new-walkin", ...body } }));
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
});

describe("joined tables at the door", () => {
  // Every single table that seats five or six is taken; 51 + 52 are a free,
  // joinable pair — the set the booking engine would seat them at.
  const JOINABLE = [
    ...RESOURCES,
    { ...table("51", 4, 70, 40), combinable: true },
    { ...table("52", 2, 80, 40), combinable: true },
  ];
  const withJoinable = () => mockApi({
    "/reservations/resources": () => Promise.resolve({ data: { resources: JOINABLE, fixtures: [], venue_seats_total: 30 } }),
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
