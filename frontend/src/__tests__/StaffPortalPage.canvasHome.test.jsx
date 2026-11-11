/**
 * Staff home in the owner's canvas "Min vagtplan · Pine, ivory & brass"
 * (Nov 2026) — pinned on the REAL page against a mocked portalApi, with the
 * clock pinned to Wednesday 11 November 2026 (only Date is faked).
 *
 *   • Home per canvas: the date line over "Min vagtplan", the pine card (chip,
 *     time in Manrope, role · pause · effektiv, the place, brass "Jeg har set
 *     det" + ghost Rute), "På arbejde med dig" with a count and a sentence of
 *     names, "Åbne vagter" with a badge and "Tag den", the week (date strip,
 *     rows, dashed open-shift rows), "Brug for en ændring?" tiles.
 *   • Card states: Bekræftet (dashed status, the confirm truth is still
 *     confirmed_at) and "Stempl ind nu" (brass Stempl ind, no Jeg har set det).
 *   • The live (clocked-in) card: ring of the time on the clock against the
 *     planned shift, Start / Pause / Slut, Stempl ud — and Start pause / Slut
 *     pause ONLY when the clock answer says breaks_live.
 *   • Meld syg is reachable two ways (⋯ sheet, tile), both the one form.
 *   • An empty week says so, and offers open shifts only when there are some.
 *   • The owner's "Pauser stemples live" toggle, off by default.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tokcanvas";
const ok = (data) => Promise.resolve({ data });
const fail = (status, detail = {}) => {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: { detail } };
  return Promise.reject(e);
};

// Wednesday 11 Nov 2026. Week: Mon 9 … Sun 15.
const WED = "2026-11-11";
const THU = "2026-11-12";
const FRI = "2026-11-13";
const SAT = "2026-11-14";
const SUN = "2026-11-15";
const NEXT_WEEK_WED = "2026-11-25"; // two weeks on: lets the pager reach next week

let info;
let shiftsImpl;
let teamImpl;
let openImpl;
let clockImpl;
let postImpl;
const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) return ok(info);
  if (url.startsWith(`/portal/${TOK}/schedule`)) return ok({ shifts: shiftsImpl() });
  if (url.startsWith(`/portal/${TOK}/team-schedule`)) return ok(teamImpl());
  if (url.startsWith(`/portal/${TOK}/open-shifts`)) return ok(openImpl());
  if (url === `/portal/${TOK}/clock`) return clockImpl();
  if (url.startsWith(`/portal/${TOK}/hours`)) return ok({ period_start: WED, period_end: WED, total_hours: 0, entries: [] });
  if (url.includes("/notifications")) return ok({ notifications: [] });
  if (url.endsWith("/chat/unread")) return ok({ unread: 0 });
  return ok([]);
});
const post = vi.fn((...a) => postImpl(...a));

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: "" } },
  storePinProof: vi.fn(),
}));
vi.mock("../services/api", () => ({
  default: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(() => Promise.resolve()),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: Object.assign(vi.fn(), { light: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn() }) }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { ClockGeofenceSettings } = await import("../pages/StaffSchedulePage");
const api = (await import("../services/api")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

function renderPage(lang = "da") {
  localStorage.setItem("lang", lang);
  return render(
    <LanguageProvider>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[`/portal/${TOK}`]}>
          <Routes>
            <Route path="/portal/:token" element={<StaffPortalPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </LanguageProvider>,
  );
}

async function mount(lang = "da") {
  renderPage(lang);
  await waitFor(() => expect(screen.getByTitle(lang === "da" ? "Rediger profil" : "Edit profile")).toBeInTheDocument());
  await waitFor(() => expect(get.mock.calls.some(([u]) => u === `/portal/${TOK}/clock`)).toBe(true));
}

const at = (h, m = 0) => vi.setSystemTime(new Date(2026, 10, 11, h, m, 0));
const posts = (suffix) => post.mock.calls.filter(([u]) => u === `/portal/${TOK}${suffix}`);
const WED_SHIFT = { id: "w1", date: WED, start_time: "10:00", end_time: "16:00", status: "published", net_hours: 5.5, break_minutes: 30, role_on_shift: "Tjener" };

let scrolled;
const origScroll = Element.prototype.scrollIntoView;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(3, 30);
  localStorage.clear();
  get.mockClear();
  post.mockClear();
  scrolled = [];
  Element.prototype.scrollIntoView = function scrollIntoView(opts) { scrolled.push({ el: this, opts }); };
  info = {
    has_pin: false, staff_name: "Freja Nielsen", role: "server",
    restaurant_name: "Café Solsikke", restaurant_address: "Nørrebrogade 52", restaurant_city: "København N",
  };
  shiftsImpl = () => [
    WED_SHIFT,
    { id: "t1", date: THU, start_time: "16:00", end_time: "22:00", status: "published", net_hours: 5.5, break_minutes: 30, role_on_shift: "Tjener" },
  ];
  teamImpl = () => [
    { staff_id: "s-sofie", staff_name: "Sofie Hansen", date: WED, start_time: "09:00", end_time: "15:00" },
    { staff_id: "s-oliver", staff_name: "Oliver Berg", date: WED, start_time: "11:00", end_time: "17:00" },
  ];
  openImpl = () => [{ id: "o1", date: FRI, start_time: "16:00", end_time: "22:00", role: "Tjener" }];
  clockImpl = () => ok({ clocked_in: false, geofence_on: false, locked: false });
  postImpl = () => ok({});
});

afterEach(() => {
  Element.prototype.scrollIntoView = origScroll;
  vi.useRealTimers();
  delete window.matchMedia;
});

describe("Home per canvas", () => {
  it("header: the date over 'Min vagtplan', the avatar with its initials, the bell", async () => {
    await mount("da");
    const row = screen.getByTestId("portal-header-row");
    expect(screen.getByTestId("portal-header-date").textContent).toBe("Onsdag 11. november");
    expect(within(row).getByRole("heading", { level: 1 }).textContent).toBe("Min vagtplan");
    expect(screen.getByTitle("Rediger profil").textContent).toBe("FN");
    // The bell keeps its name (the Alerts tab it replaced), 44 px, radius 14.
    const bell = within(row).getByRole("button", { name: "Nyt" });
    expect([bell.style.width, bell.style.height, bell.style.borderRadius]).toEqual(["44px", "44px", "14px"]);
    // Built by hand: never ICU's "onsdag den 11.".
    expect(document.body.textContent).not.toMatch(/\bden \d/);
  });

  it("the date line is the home's: another tab shows the title alone", async () => {
    await mount("da");
    fireEvent.click(screen.getByTestId("portal-tab-hours"));
    expect(screen.queryByTestId("portal-header-date")).toBeNull();
  });

  it("next-shift card: chip, time in Manrope, role · pause · effektiv, the place, brass 'Jeg har set det' beside a ghost Rute", async () => {
    await mount("da");
    const hero = screen.getByTestId("portal-hero");
    expect(hero.dataset.state).toBe("next");
    expect(screen.getByTestId("portal-hero-chip").textContent).toBe("I dag · om 6 t 30 min");
    const time = screen.getByTestId("portal-hero-time");
    expect(time.textContent).toBe("10:00–16:00");
    expect(time.style.fontFamily).toContain("Manrope");
    const meta = screen.getByTestId("portal-hero-meta").textContent;
    expect(meta).toContain("Tjener");
    expect(meta).toContain("30 min pause");
    expect(meta).toContain("5,5 t effektiv");
    expect(screen.getByTestId("portal-hero-place").textContent).toBe("Café Solsikke · Nørrebrogade 52, København N");
    const seen = within(hero).getByRole("button", { name: /Jeg har set det/ });
    expect(seen.style.background).toBe("rgb(200, 164, 100)");
    const rute = screen.getByTestId("portal-route");
    expect(rute.textContent).toBe("Rute");
    expect(rute.style.background).toBe("rgba(243, 239, 228, 0.06)");
    // One flat pine card.
    expect(hero.style.background).toBe("rgb(14, 59, 46)");
  });

  it("På arbejde med dig: a count, flat discs and the names as a sentence; the row opens that day in the week", async () => {
    await mount("da");
    const who = screen.getByTestId("portal-whos-on");
    expect(within(who).getByText("På arbejde med dig")).toBeInTheDocument();
    expect(who.textContent).toContain("2 kolleger");
    const row = screen.getByTestId("portal-whos-on-row");
    expect(row.textContent).toContain("Sofie og Oliver");
    fireEvent.click(row);
    await waitFor(() => expect(scrolled.some((c) => c.el.id === `portal-day-${WED}`)).toBe(true));
  });

  it("Åbne vagter: a pine count badge, rows with 'Tag den'; 'Se alle' only past three, and it shows the rest", async () => {
    openImpl = () => [
      { id: "o1", date: FRI, start_time: "16:00", end_time: "22:00", role: "Tjener" },
      { id: "o2", date: SAT, start_time: "10:00", end_time: "15:00" },
      { id: "o3", date: SUN, start_time: "10:00", end_time: "15:00" },
      { id: "o4", date: "2026-11-17", start_time: "12:00", end_time: "18:00" },
    ];
    await mount("da");
    const open = screen.getByTestId("portal-open-shifts");
    expect(within(open).getByText("Åbne vagter")).toBeInTheDocument();
    expect(within(open).getByText("4")).toBeInTheDocument();
    expect(within(open).getAllByRole("button", { name: "Tag den" })).toHaveLength(3);
    // The row's meta: role · its span.
    expect(open.textContent).toContain("Tjener · 6 t");
    fireEvent.click(within(open).getByRole("button", { name: "Se alle" }));
    expect(within(open).getAllByRole("button", { name: "Tag den" })).toHaveLength(4);
  });

  it("no 'Se alle' when the list is already all on screen", async () => {
    await mount("da");
    expect(within(screen.getByTestId("portal-open-shifts")).queryByRole("button", { name: "Se alle" })).toBeNull();
  });

  it("the week: range title, date strip (today the pine chip; your days a pine dot; open days a brass ring), rows, and a dashed open shift that claims", async () => {
    await mount("da");
    const week = screen.getByTestId("portal-week");
    expect(within(week).getByRole("heading", { level: 2 }).textContent).toBe("9.–15. november");
    const strip = screen.getByTestId("portal-week-strip");
    const cells = within(strip).getAllByRole("button");
    expect(cells).toHaveLength(7);
    const today = cells.find((c) => c.getAttribute("aria-current") === "date");
    expect(today.style.background).toBe("rgb(14, 59, 46)");
    expect(cells[3].getAttribute("aria-label")).toContain("Din vagt"); // Thu
    expect(cells[4].getAttribute("aria-label")).toContain("Ledig");     // Fri, open
    expect(screen.getByTestId("portal-week-summary").textContent).toContain("2 vagter");
    expect(screen.getByTestId("portal-week-summary").textContent).toContain("11 t effektiv");
    // Rows: today's outlined in pine, with its "I dag" pill.
    const wedRow = document.getElementById(`portal-day-${WED}`);
    expect(wedRow.textContent).toContain("10:00–16:00");
    expect(wedRow.textContent).toContain("I dag");
    // The open Friday is a dashed row in the week.
    const free = within(document.getElementById(`portal-day-${FRI}`)).getByTestId("portal-week-free");
    expect(free.textContent).toContain("Ledig vagt");
    expect(free.textContent).toContain("16:00–22:00");
    await act(async () => { fireEvent.click(within(free).getByRole("button", { name: "Tag den" })); });
    expect(posts("/open-shifts/o1/claim")).toHaveLength(1);
    // The answer prints in the week, not twice.
    expect(await within(week).findByText("Tilføjet til din vagtplan.")).toBeInTheDocument();
    expect(within(screen.getByTestId("portal-open-shifts")).queryByText("Tilføjet til din vagtplan.")).toBeNull();
  });

  it("'Brug for en ændring?' is two tiles: Meld syg and Byt en vagt", async () => {
    await mount("da");
    const section = screen.getByTestId("portal-need-change");
    const tiles = within(section).getAllByRole("button");
    expect(tiles.map((b) => b.textContent)).toEqual([
      "Meld sygGiv din leder besked",
      "Byt en vagtTilbyd til en kollega",
    ]);
  });
});

describe("Card states", () => {
  it("Bekræftet: every shift confirmed → the dashed 'Vagten er bekræftet', no button to tap again", async () => {
    shiftsImpl = () => [{ ...WED_SHIFT, confirmed_at: "2026-11-10T12:00:00" }];
    await mount("da");
    const hero = screen.getByTestId("portal-hero");
    expect(within(hero).queryByRole("button", { name: /Jeg har set det/ })).toBeNull();
    const status = screen.getByTestId("portal-hero-confirmed");
    expect(status.getAttribute("role")).toBe("status");
    expect(status.textContent).toBe("Vagten er bekræftet");
  });

  it("Bekræftet on a narrow phone says it short", async () => {
    window.matchMedia = (q) => ({ matches: q === "(max-width: 359px)", addEventListener: () => {}, removeEventListener: () => {} });
    shiftsImpl = () => [{ ...WED_SHIFT, confirmed_at: "2026-11-10T12:00:00" }];
    await mount("da");
    expect(screen.getByTestId("portal-hero-confirmed").textContent).toBe("Bekræftet");
  });

  it("'Jeg har set det' confirms the shifts on screen (confirm-schedule with their ids)", async () => {
    postImpl = (url) => (url.endsWith("/confirm-schedule") ? ok({ confirmed_count: 2 }) : ok({}));
    await mount("da");
    await act(async () => { fireEvent.click(within(screen.getByTestId("portal-hero")).getByRole("button", { name: /Jeg har set det/ })); });
    expect(posts("/confirm-schedule")).toHaveLength(1);
    expect(posts("/confirm-schedule")[0][1]).toEqual({ shift_ids: ["w1", "t1"] });
    expect(await screen.findByText("✓ 2 vagter bekræftet")).toBeInTheDocument();
  });

  it("Stempl ind nu: the shift is close → brass Stempl ind on the card (no 'Jeg har set det'), Rute stays the ghost", async () => {
    at(9, 48);
    await mount("da");
    const hero = screen.getByTestId("portal-hero");
    const punch = within(hero).getByRole("button", { name: /Stempl ind/ });
    expect(punch.style.background).toBe("rgb(200, 164, 100)");
    expect(within(hero).queryByRole("button", { name: /Jeg har set det/ })).toBeNull();
    // Canvas Stempl ind state: under an hour away, "Starter om …".
    expect(screen.getByTestId("portal-hero-chip").textContent).toBe("Starter om 12 min");
    expect(screen.getByTestId("portal-route").style.background).toBe("rgba(243, 239, 228, 0.06)");
  });
});

describe("Active shift (clocked in)", () => {
  const CLOCKED = { clocked_in: true, since: "09:58", elapsed_sec: 2 * 3600 + 16 * 60, geofence_on: false, locked: false };

  it("the ring is the time on the clock against the planned shift; Start / Pause / Slut; Stempl ud is the one action", async () => {
    at(12, 14);
    clockImpl = () => ok({ ...CLOCKED, breaks_live: false });
    postImpl = (url) => (url.endsWith("/clock-out") ? ok({ clocked_in: false, worked_hours: 2.25 }) : ok({}));
    await mount("da");
    const live = await screen.findByTestId("portal-live-shift");
    expect(screen.getByTestId("portal-hero").dataset.state).toBe("live");
    expect(screen.getByTestId("portal-live-chip").textContent).toBe("Stemplet ind kl. 09:58");
    expect(screen.getByTestId("portal-live-elapsed").textContent).toBe("2:16");
    const ring = screen.getByTestId("portal-live-ring");
    expect(ring.textContent).toContain("På vagt");
    expect(ring.textContent).toContain("3 t 46 min tilbage");
    expect(ring.getAttribute("aria-label")).toBe("På vagt i 2 t 16 min. 3 t 46 min tilbage.");
    // 2 t 16 min of the planned 6 t: 37.8 % of the 552.9 circumference.
    expect(screen.getByTestId("portal-live-arc").getAttribute("stroke-dasharray")).toBe("208.9 552.9");
    expect(live.textContent).toContain("Start10:00");
    expect(live.textContent).toContain("Slut16:00");
    // Without live breaks the app shows the plan only — never "mangler".
    expect(screen.getByTestId("portal-live-pause").textContent).toBe("Pause30 min");
    expect(screen.queryByTestId("portal-break-btn")).toBeNull();
    const out = screen.getByTestId("portal-clock-out");
    expect(out.textContent).toBe("Stempl ud");
    expect(out.style.background).toBe("rgb(200, 164, 100)");
    await act(async () => { fireEvent.click(out); });
    expect(posts("/clock-out")).toHaveLength(1);
  });

  it("no pause button when the clock answer does not mention breaks_live at all", async () => {
    at(12, 14);
    clockImpl = () => ok(CLOCKED);
    await mount("da");
    await screen.findByTestId("portal-live-shift");
    expect(screen.queryByTestId("portal-break-btn")).toBeNull();
    expect(screen.queryByText("Start pause")).toBeNull();
  });

  it("breaks_live: Start pause → POST break/start; on a break it is Slut pause → POST break/end", async () => {
    at(12, 14);
    let st = { ...CLOCKED, breaks_live: true, on_break: false, break_started_at: null, break_minutes_so_far: 0 };
    clockImpl = () => ok(st);
    postImpl = (url) => {
      // The backend's answer: the whole clock state (_clock_status_dict),
      // break_since owner-local, break_started_at ISO UTC.
      if (url.endsWith("/clock/break/start")) {
        st = { ...st, on_break: true, break_since: "12:20", break_started_at: "2026-11-11T12:20:00Z", break_elapsed_sec: 0 };
        return ok(st);
      }
      if (url.endsWith("/clock/break/end")) {
        st = { ...st, on_break: false, break_since: null, break_started_at: null, break_elapsed_sec: null, break_minutes_so_far: 12 };
        return ok(st);
      }
      return ok({});
    };
    await mount("da");
    const btn = await screen.findByTestId("portal-break-btn");
    expect(btn.textContent).toBe("Start pause");
    expect(btn.style.background).toBe("rgb(200, 164, 100)");
    // Stempl ud steps back to the ghost beside it.
    expect(screen.getByTestId("portal-clock-out").style.background).toBe("rgba(243, 239, 228, 0.06)");
    expect(screen.getByTestId("portal-live-pause").textContent).toBe("Pause30 min · mangler");

    await act(async () => { fireEvent.click(btn); });
    expect(posts("/clock/break/start")).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("portal-break-btn").textContent).toBe("Slut pause"));
    expect(screen.getByTestId("portal-live-chip").textContent).toBe("På pause siden kl. 12:20");
    expect(screen.getByTestId("portal-live-ring").textContent).toContain("På pause");
    expect(screen.getByTestId("portal-live-pause").textContent).toBe("Pause30 min · i gang");

    await act(async () => { fireEvent.click(screen.getByTestId("portal-break-btn")); });
    expect(posts("/clock/break/end")).toHaveLength(1);
    await waitFor(() => expect(screen.getByTestId("portal-break-btn").textContent).toBe("Start pause"));
    expect(screen.getByTestId("portal-live-pause").textContent).toBe("Pause30 min · 12 min holdt");
  });

  it("a pause still running after the owner switched live breaks off can be ended — Start pause never shows", async () => {
    at(12, 30);
    clockImpl = () => ok({ ...CLOCKED, breaks_live: false, on_break: true, break_since: "12:20", break_minutes_so_far: 10 });
    postImpl = () => ok({ ...CLOCKED, breaks_live: false, on_break: false, break_minutes_so_far: 10 });
    await mount("da");
    const btn = await screen.findByTestId("portal-break-btn");
    expect(btn.textContent).toBe("Slut pause");
    await act(async () => { fireEvent.click(btn); });
    expect(posts("/clock/break/end")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByTestId("portal-break-btn")).toBeNull());
    expect(screen.queryByText("Start pause")).toBeNull();
  });

  it("the owner turned live breaks off meanwhile (403 breaks_off): says so, and the button goes", async () => {
    at(12, 14);
    let live = true;
    clockImpl = () => ok({ ...CLOCKED, breaks_live: live, on_break: false });
    postImpl = () => { live = false; return fail(403, { error: "breaks_off" }); };
    await mount("da");
    await act(async () => { fireEvent.click(await screen.findByTestId("portal-break-btn")); });
    expect(await screen.findByText("Din leder har slået live-pauser fra.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId("portal-break-btn")).toBeNull());
  });

  it("a failed break says so politely; a 409 (the punch was closed elsewhere) just re-reads the clock", async () => {
    at(12, 14);
    clockImpl = () => ok({ ...CLOCKED, breaks_live: true, on_break: false });
    postImpl = () => fail(500);
    await mount("da");
    await act(async () => { fireEvent.click(await screen.findByTestId("portal-break-btn")); });
    expect(await screen.findByText("Kunne ikke starte pausen. Prøv igen.")).toBeInTheDocument();

    // The server's real 409 for a start (a second start is a 200, never a
    // 409): see fixtures/liveBreaksContract.json, written by the endpoints.
    postImpl = () => fail(409, { error: "not_clocked_in" });
    const clockReads = () => get.mock.calls.filter(([u]) => u === `/portal/${TOK}/clock`).length;
    const before = clockReads();
    await act(async () => { fireEvent.click(screen.getByTestId("portal-break-btn")); });
    await waitFor(() => expect(clockReads()).toBeGreaterThan(before));
    expect(screen.queryByText("Kunne ikke starte pausen. Prøv igen.")).toBeNull();
  });

  it("a clock-in with no planned shift draws no plan: no arc, 'Ingen planlagt vagt', Slut —", async () => {
    at(12, 14);
    shiftsImpl = () => [{ id: "t1", date: THU, start_time: "16:00", end_time: "22:00", status: "published", net_hours: 5.5 }];
    clockImpl = () => ok({ ...CLOCKED, breaks_live: false });
    await mount("da");
    const live = await screen.findByTestId("portal-live-shift");
    expect(screen.queryByTestId("portal-live-arc")).toBeNull();
    expect(screen.getByTestId("portal-live-ring").textContent).toContain("Ingen planlagt vagt");
    expect(live.textContent).toContain("Start09:58");
    expect(live.textContent).toContain("Slut—");
  });

  it("under the live card: På vagt nu, then Næste vagt, which opens its day", async () => {
    at(12, 14);
    clockImpl = () => ok({ ...CLOCKED, breaks_live: false });
    await mount("da");
    await screen.findByTestId("portal-live-shift");
    expect(within(screen.getByTestId("portal-whos-on")).getByText("På vagt nu")).toBeInTheDocument();
    const next = screen.getByTestId("portal-after-live");
    expect(next.textContent).toContain("Næste vagt");
    expect(next.textContent).toContain("16:00–22:00");
    fireEvent.click(within(next).getByRole("button"));
    await waitFor(() => expect(scrolled.some((c) => c.el.id === `portal-day-${THU}`)).toBe(true));
  });
});

describe("Canvas review: the week row's colleagues line", () => {
  it("is ONE line, 'Med' + four first names + '+N', one 44 px button that opens everyone's other shifts", async () => {
    teamImpl = () => [
      { staff_id: "s-sofie", staff_name: "Sofie Hansen", date: WED, start_time: "09:00", end_time: "15:00" },
      { staff_id: "s-oliver", staff_name: "Oliver Berg", date: WED, start_time: "11:00", end_time: "17:00" },
      { staff_id: "s-magnus", staff_name: "Magnus Lund", date: WED, start_time: "10:00", end_time: "14:00" },
      { staff_id: "s-emil", staff_name: "Emil Holm", date: WED, start_time: "12:00", end_time: "16:00" },
      { staff_id: "s-ida", staff_name: "Ida Ravn", date: WED, start_time: "13:00", end_time: "18:00" },
      { staff_id: "s-oliver", staff_name: "Oliver Berg", date: THU, start_time: "16:00", end_time: "22:00" },
    ];
    await mount("da");
    const lines = await screen.findAllByTestId("portal-week-mates");
    const btn = lines[0];
    expect(btn.tagName).toBe("BUTTON");
    // Discs (initials) then the one line of text.
    expect(btn.lastElementChild.textContent).toBe("Med Sofie, Oliver, Magnus, Emil +1");
    // No per-name buttons: the whole line is the one tap target.
    expect(btn.querySelectorAll("button")).toHaveLength(0);
    expect(btn.style.minHeight).toBe("44px");
    const text = btn.lastElementChild;
    expect(text.style.whiteSpace).toBe("nowrap");
    expect(text.style.textOverflow).toBe("ellipsis");
    expect(text.style.overflow).toBe("hidden");
    expect(btn.getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(btn);
    expect(btn.getAttribute("aria-expanded")).toBe("true");
    const panel = screen.getByTestId("portal-week-mates-panel");
    expect(btn.getAttribute("aria-controls")).toBe(panel.id);
    // Everyone on the shift, the fifth included, with their other shifts.
    expect(panel.textContent).toContain("Ida har ingen anden vagt på planen.");
    expect(panel.textContent).toContain("Oliver");
    expect(panel.textContent).toContain("16:00–22:00");
    fireEvent.click(btn);
    expect(screen.queryByTestId("portal-week-mates-panel")).toBeNull();
  });

  it("three colleagues: no '+N'", async () => {
    teamImpl = () => [
      { staff_id: "s-sofie", staff_name: "Sofie Hansen", date: WED, start_time: "09:00", end_time: "15:00" },
      { staff_id: "s-oliver", staff_name: "Oliver Berg", date: WED, start_time: "11:00", end_time: "17:00" },
      { staff_id: "s-magnus", staff_name: "Magnus Lund", date: WED, start_time: "10:00", end_time: "14:00" },
    ];
    await mount("da");
    expect((await screen.findAllByTestId("portal-week-mates"))[0].lastElementChild.textContent)
      .toBe("Med Sofie, Oliver, Magnus");
  });
});

describe("Canvas review: strip and ⋯ sheet words", () => {
  it("the date strip prints 'man', 'tir', 'ons' with no full stop", async () => {
    await mount("da");
    const strip = await screen.findByRole("button", { name: /^ons\. 11\./ });
    expect(strip.querySelector("span").textContent).toBe("ons");
    expect(screen.getByRole("button", { name: /^man\. 9\./ }).querySelector("span").textContent).toBe("man");
  });

  it("Tilføj til kalender says 'Synkroniseres automatisk' (never cut mid-word)", async () => {
    await mount("da");
    fireEvent.click(screen.getByRole("button", { name: "Flere valg for vagten" }));
    const sheet = await screen.findByTestId("portal-shift-menu");
    expect(within(sheet).getByTestId("portal-menu-calendar").textContent).toContain("Synkroniseres automatisk");
  });
});

describe("Meld syg — reachable two ways, one form", () => {
  it("from the ⋯ sheet (its own group, last) and from the tile; both open the form that posts /sick-call", async () => {
    postImpl = () => ok({ id: "sc1" });
    await mount("da");
    fireEvent.click(screen.getByRole("button", { name: "Flere valg for vagten" }));
    const sheet = await screen.findByTestId("portal-shift-menu");
    const rows = [...sheet.querySelectorAll("[data-testid^='portal-menu-']")].map((r) => r.dataset.testid);
    expect(rows[rows.length - 1]).toBe("portal-menu-sick");
    fireEvent.click(within(sheet).getByTestId("portal-menu-sick"));
    expect(await screen.findByTestId("portal-sick-from-menu")).toBeInTheDocument();

    fireEvent.click(within(screen.getByTestId("portal-need-change")).getByText("Meld syg").closest("button"));
    const form = await screen.findByTestId("portal-sick-from-week");
    await act(async () => { fireEvent.click(within(form).getByRole("button", { name: "Send sygemelding" })); });
    expect(posts("/sick-call")).toHaveLength(1);
  });
});

describe("The ⋯ sheet per canvas", () => {
  it("title and role · place; while the shift is not close a pine Stempl ind leads; Hvem er på names the colleagues", async () => {
    await mount("da");
    fireEvent.click(screen.getByRole("button", { name: "Flere valg for vagten" }));
    const sheet = await screen.findByTestId("portal-shift-menu");
    expect(sheet.textContent).toContain("I dag · 10:00–16:00");
    expect(sheet.textContent).toContain("Tjener · Café Solsikke");
    const punch = within(sheet).getByTestId("portal-menu-clock-in");
    expect(punch.style.background).toBe("rgb(14, 59, 46)");
    expect(within(sheet).getByTestId("portal-menu-whos-on").textContent).toContain("Sofie og Oliver");
    expect(within(sheet).getByTestId("portal-menu-swaps").textContent).toContain("Tilbyd vagten til en kollega");
  });
});

describe("An empty week", () => {
  it("says so in the canvas's words, and offers open shifts only when there are some", async () => {
    shiftsImpl = () => [WED_SHIFT, { ...WED_SHIFT, id: "n1", date: NEXT_WEEK_WED }];
    openImpl = () => [];
    await mount("da");
    fireEvent.click(screen.getByRole("button", { name: "Næste uge" }));
    const empty = await screen.findByTestId("portal-week-empty");
    expect(empty.textContent).toContain("Ingen vagter i næste uge");
    expect(empty.textContent).toContain("Du har fri. Nye og ledige vagter dukker op her, så snart de bliver lagt ud.");
    expect(within(empty).queryByRole("button")).toBeNull();
  });

  it("with an open shift elsewhere, 'Se ledige vagter' takes you to the list", async () => {
    shiftsImpl = () => [WED_SHIFT, { ...WED_SHIFT, id: "n1", date: NEXT_WEEK_WED }];
    openImpl = () => [{ id: "o9", date: NEXT_WEEK_WED, start_time: "08:00", end_time: "12:00" }];
    await mount("da");
    fireEvent.click(screen.getByRole("button", { name: "Næste uge" }));
    const empty = await screen.findByTestId("portal-week-empty");
    fireEvent.click(within(empty).getByRole("button", { name: /Se ledige vagter/ }));
    expect(scrolled.some((c) => c.el.id === "portal-open-shifts")).toBe(true);
  });
});

describe("Owner: Pauser stemples live", () => {
  const LanguageWrap = ({ children }) => <LanguageProvider><MemoryRouter>{children}</MemoryRouter></LanguageProvider>;
  beforeEach(() => {
    localStorage.setItem("lang", "da");
    api.get.mockReset();
    api.post.mockReset();
  });

  it("is off by default with a one-line explanation, and saves breaks_live through the clock settings", async () => {
    api.get.mockResolvedValue({ data: { enabled: false, has_location: false, radius_m: 150, window_enabled: false } });
    api.post.mockResolvedValue({ data: { enabled: false, has_location: false, radius_m: 150, window_enabled: false, breaks_live: true } });
    render(<LanguageWrap><ClockGeofenceSettings /></LanguageWrap>);
    const toggle = await screen.findByTestId("breaks-live-toggle");
    expect(toggle.checked).toBe(false);
    expect(screen.getByText("Pauser stemples live")).toBeInTheDocument();
    expect(screen.getByText("Personalet trykker Start pause og Slut pause i appen, så pauserne registreres, mens de holdes. En pause, de selv registrerer, erstatter det automatiske fradrag på 45 minutter i lønnen.")).toBeInTheDocument();
    await act(async () => { fireEvent.click(toggle); });
    expect(api.post).toHaveBeenCalledWith("/staff/clock-geofence", { enabled: false, breaks_live: true });
    await waitFor(() => expect(screen.getByTestId("breaks-live-toggle").checked).toBe(true));
  });

  it("the collapsed card says when breaks are clocked live", async () => {
    api.get.mockResolvedValue({ data: { enabled: true, has_location: true, radius_m: 150, breaks_live: true } });
    render(<LanguageWrap><ClockGeofenceSettings /></LanguageWrap>);
    expect((await screen.findByTestId("breaks-live-summary")).textContent).toContain("pauser stemples live");
  });
});
