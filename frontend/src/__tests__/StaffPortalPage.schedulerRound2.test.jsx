/**
 * BonBox Scheduler — round 2, pinned on the REAL page against a mocked
 * portalApi (fetch → state → rendered text, not a re-implementation).
 *
 *   • Swap picker (C5): a colleague shift that would put either person on two
 *     shifts at once is never offered; the server's 409 reason is shown in
 *     Danish on propose AND on accept (it used to vanish on accept).
 *   • Header pill (lead report): "Offline" stuck for hours although the
 *     backend was up — only the 'online' event could clear it. A schedule
 *     answer now proves the phone is online.
 *   • Opening a link while the server is in trouble says so ("Serveren svarer
 *     ikke", not "du er offline") and retries by itself.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tokr2";
const ok = (data) => Promise.resolve({ data });
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
};
const reject = (status, data = {}) => {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data };
  return Promise.reject(e);
};

const WED = inDays(7);
const THU = inDays(8);
const FRI = inDays(9);

/** Swapped per test. */
let scheduleImpl;
let teamImpl;
let swapsImpl;
let postImpl;

const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) {
    return ok({ has_pin: false, staff_name: "Ali R.", restaurant_name: "Testcafé", role: "kitchen" });
  }
  if (url.startsWith(`/portal/${TOK}/schedule`)) return scheduleImpl();
  if (url.startsWith(`/portal/${TOK}/team-schedule`)) return teamImpl();
  if (url.startsWith(`/portal/${TOK}/swap-requests`)) return swapsImpl();
  if (url.startsWith(`/portal/${TOK}/hours`)) {
    return ok({ period_start: inDays(-10), period_end: inDays(10), total_hours: 0, entries: [] });
  }
  if (url.includes("/notifications")) return ok({ notifications: [] });
  if (url.endsWith("/chat/unread")) return ok({ unread: 0 });
  return ok([]);
});
const post = vi.fn((...a) => postImpl(...a));

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: "" } },
  storePinProof: vi.fn(),
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(() => Promise.resolve()),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: Object.assign(vi.fn(), { warning: vi.fn(), success: vi.fn(), error: vi.fn() }) }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

async function mount(lang = "da") {
  localStorage.setItem("lang", lang);
  render(
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
  await waitFor(() => expect(screen.getByTitle("Rediger profil")).toBeInTheDocument());
}

const navTo = (label) => {
  const nav = document.querySelector("nav");
  fireEvent.click(within(nav).getByText(label).closest("button"));
};

const ALI = "staff-ali";
const JONAS = "staff-jonas";
const ANNA = "staff-anna";

beforeEach(() => {
  localStorage.clear();
  get.mockClear();
  post.mockClear();
  // Ali works Wed 11:00–20:00 and Fri 15:00–23:00 (the round-2 repro).
  scheduleImpl = () => ok({
    shifts: [
      { id: "ali-wed", date: WED, start_time: "11:00", end_time: "20:00", status: "published", net_hours: 9 },
      { id: "ali-fri", date: FRI, start_time: "15:00", end_time: "23:00", status: "published", net_hours: 8 },
    ],
  });
  teamImpl = () => ok([
    { shift_id: "ali-wed", staff_id: ALI, staff_name: "Ali R.", date: WED, start_time: "11:00", end_time: "20:00" },
    { shift_id: "ali-fri", staff_id: ALI, staff_name: "Ali R.", date: FRI, start_time: "15:00", end_time: "23:00" },
    // Overlaps Ali's own Wednesday → never offered.
    { shift_id: "jonas-wed", staff_id: JONAS, staff_name: "Jonas B.", date: WED, start_time: "11:30", end_time: "15:00" },
    // Fine for Ali — but Anna keeps her Fri 14:00–18:00, so taking Ali's
    // Fri 15:00–23:00 would double-book HER → never offered either.
    { shift_id: "anna-thu", staff_id: ANNA, staff_name: "Anna K.", date: THU, start_time: "10:00", end_time: "14:00" },
    // The same-day trade IS fine: Anna hands this one over as she takes Ali's.
    { shift_id: "anna-fri", staff_id: ANNA, staff_name: "Anna K.", date: FRI, start_time: "14:00", end_time: "18:00" },
    // Clean on both sides → offered.
    { shift_id: "jonas-thu", staff_id: JONAS, staff_name: "Jonas B.", date: THU, start_time: "16:00", end_time: "22:00" },
  ]);
  swapsImpl = () => ok([]);
  postImpl = () => ok({});
});

async function openSwapPicker() {
  await mount("da");
  navTo("Bytte");
  fireEvent.click(await screen.findByRole("button", { name: /^Byt$/ }));
  await waitFor(() => expect(get).toHaveBeenCalledWith(`/portal/${TOK}/team-schedule`));
  const own = await screen.findByDisplayValue("Vælg en af dine vagter…");
  fireEvent.change(own, { target: { value: "ali-fri" } });
  return screen.findByDisplayValue("Vælg en kollegas vagt…");
}

describe("Swap picker — never offers a trade that double-books someone", () => {
  it("hides colleague shifts that overlap yours, or theirs after the trade, and says how many", async () => {
    const picker = await openSwapPicker();
    const offered = within(picker).getAllByRole("option").map((o) => o.value).filter(Boolean);
    expect(offered.sort()).toEqual(["anna-fri", "jonas-thu"]);
    expect(screen.getByTestId("swap-hidden-overlap").textContent)
      .toBe("2 skjult — de ville give dig eller din kollega to vagter på samme tid.");
  });

  it("a server refusal on propose reads as Danish, not English", async () => {
    postImpl = () => reject(409, { detail: { code: "swap_overlap", who: "colleague", message: "This swap would put the person taking the shift on two shifts at the same time." } });
    const picker = await openSwapPicker();
    fireEvent.change(picker, { target: { value: "jonas-thu" } });
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "Send bytteanmodning" })); });
    expect(await screen.findByText(/Din kollega har allerede en vagt på det tidspunkt den dag/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("This swap would put");
  });
});

describe("Accepting a swap that would double-book you", () => {
  it("shows the reason and keeps Afvis within reach (it used to vanish silently)", async () => {
    swapsImpl = () => ok([{
      id: "sw1", status: "proposed", direction: "incoming",
      from_staff_name: "Jonas B.", to_staff_name: "Ali R.",
      from_shift_id: "jonas-wed", from_shift_date: WED, from_shift_time: "11:30–15:00",
      to_shift_id: "ali-fri", to_shift_date: FRI, to_shift_time: "15:00–23:00",
    }]);
    postImpl = () => reject(409, { detail: { code: "swap_overlap", who: "self", message: "x" } });
    await mount("da");
    navTo("Bytte");
    const accept = await screen.findByRole("button", { name: "Accepter" });
    await act(async () => { fireEvent.click(accept); });
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Du har allerede en vagt på det tidspunkt den dag");
    expect(screen.getByRole("button", { name: "Afvis" })).not.toBeDisabled();
  });
});

describe("Header pill — 'Offline' recovers without relaunching the app", () => {
  it("a stale 'offline' is cleared by the next schedule answer", async () => {
    await mount("da");
    const pill = () => document.querySelector("h1").parentElement.querySelector("button");
    await waitFor(() => expect(pill().textContent).toBe("Synket"));

    // The web view reported offline while the phone slept; on wake the
    // 'online' event never comes and navigator.onLine is still stale.
    const desc = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    try {
      await act(async () => { window.dispatchEvent(new Event("offline")); });
      expect(pill().textContent).toBe("Offline");

      const before = get.mock.calls.filter(([u]) => u.startsWith(`/portal/${TOK}/schedule`)).length;
      await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
      await waitFor(() =>
        expect(get.mock.calls.filter(([u]) => u.startsWith(`/portal/${TOK}/schedule`)).length).toBeGreaterThan(before),
      );
      await waitFor(() => expect(pill().textContent).not.toBe("Offline"));
    } finally {
      if (desc) Object.defineProperty(window.navigator, "onLine", desc);
      else delete window.navigator.onLine;
    }
  });
});

describe("Opening a link while the server is in trouble", () => {
  it("says the server is not answering and retries by itself", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let opens = 0;
      const base = get.getMockImplementation();
      get.mockImplementation((url) => {
        if (url === `/portal/${TOK}`) {
          opens += 1;
          if (opens === 1) return reject(503, { detail: "Server is starting up, please retry in a moment" });
        }
        return base(url);
      });
      localStorage.setItem("lang", "da");
      render(
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
      expect(await screen.findByText("Serveren svarer ikke")).toBeInTheDocument();
      expect(document.body.textContent).not.toContain("Ingen forbindelse");
      expect(document.body.textContent).not.toContain("starting up");
      expect(document.title).toBe("BonBox Scheduler");

      await act(async () => { vi.advanceTimersByTime(15000); });
      await waitFor(() => expect(screen.getByTitle("Rediger profil")).toBeInTheDocument());
      expect(opens).toBe(2);
      get.mockImplementation(base);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Dead link", () => {
  it("offers a real 44px button with /join's verb, and the staff title", async () => {
    const base = get.getMockImplementation();
    get.mockImplementation((url) => (url === `/portal/${TOK}` ? reject(404, { detail: "Link not found or inactive" }) : base(url)));
    try {
      localStorage.setItem("lang", "da");
      render(
        <LanguageProvider>
          <MemoryRouter initialEntries={[`/portal/${TOK}`]}>
            <Routes>
              <Route path="/portal/:token" element={<StaffPortalPage />} />
            </Routes>
          </MemoryRouter>
        </LanguageProvider>,
      );
      const cta = await screen.findByRole("link", { name: "Tilslut med kode" });
      expect(cta.getAttribute("href")).toBe("/join");
      expect(cta.className).toContain("min-h-[44px]");
      expect(document.title).toBe("BonBox Scheduler");
    } finally {
      get.mockImplementation(base);
    }
  });
});
