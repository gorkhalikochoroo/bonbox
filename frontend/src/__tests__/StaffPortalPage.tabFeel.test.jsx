/**
 * Premium feel 1.6, the tab change (PREMIUM-FEEL-SPEC.md), on the REAL page
 * against a mocked portalApi.
 *
 *   a) Pill first, page second: a dock tap moves the pill (--i), the name and
 *      aria-current at the tap; the new screen mounts in a transition right
 *      after. Tests run inside act, which also flushes the transition, so the
 *      new screen is there in the same act as the click (checked here once).
 *   b) The page only fades (vp-tab-in; pinned in dockMotion + motion kit).
 *   c) Each tab keeps its scroll; tapping the tab you are on scrolls it to
 *      the top (smooth with motion, a jump without).
 *   d) No shimmer on return: a tab paints its last SERVER answer from memory
 *      (components/staff/tabMemory.js) and refreshes behind it. The memory
 *      dies with the page, and never holds an optimistic tmp- row.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clearVenueMapCache } from "../utils/venueMapImage";
import { recall } from "../components/staff/tabMemory";

const TOK = "toktabs";
const ok = (data) => Promise.resolve({ data });
const never = () => new Promise(() => {});
function deferred() {
  let resolve;
  const promise = new Promise((res) => { resolve = res; });
  return { promise, resolve };
}
const iso = (d) => d.toLocaleDateString("sv-SE");
// Next week's Monday + i: in the future whatever weekday the suite runs on.
const nextWeek = (i) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 + i);
  return iso(d);
};

let impl;   // per-path answers: { threads, swaps, giveaways, availability, absence, notifications }
const get = vi.fn((url) => {
  const sub = url.slice(`/portal/${TOK}`.length);
  if (sub === "") return ok({ has_pin: false, staff_name: "Freja M.", role: "waiter", restaurant_name: "Café Solsikke" });
  if (sub.startsWith("/schedule")) return ok({ shifts: [{ id: "sh-1", date: nextWeek(1), start_time: "16:00", end_time: "22:00", status: "published", net_hours: 5.5 }] });
  if (sub.startsWith("/team-schedule")) return ok([]);
  if (sub.startsWith("/hours")) return ok({ period_start: nextWeek(-7), period_end: nextWeek(7), total_hours: 12.5, entries: [] });
  if (sub === "/chat/unread") return ok({ unread: 0 });
  if (sub === "/chat/threads") return impl.threads();
  if (sub.startsWith("/swap-requests")) return impl.swaps();
  if (sub.startsWith("/give-aways")) return impl.giveaways();
  if (sub.startsWith("/availability")) return impl.availability();
  if (sub.startsWith("/absence")) return impl.absence();
  if (sub.startsWith("/notifications")) return impl.notifications();
  return ok([]);
});
const post = vi.fn(() => ok({}));

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: (...a) => post(...a), put: vi.fn(), delete: vi.fn(() => ok({})), defaults: { baseURL: "" } },
  storePinProof: vi.fn(),
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(() => Promise.resolve()),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: Object.assign(vi.fn(), { light: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn() }) }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn(), takePhotoFile: vi.fn(), choosePhotoFiles: vi.fn(), isCameraDenied: vi.fn() }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

function renderPortal() {
  localStorage.setItem("lang", "da");
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
async function mount() {
  const view = renderPortal();
  await waitFor(() => expect(screen.getByTestId("portal-hero-meta")).toBeInTheDocument());
  return view;
}
const go = (tab) => fireEvent.click(screen.getByTestId(`portal-tab-${tab}`));
const shell = () => document.querySelector(".full-height.scrollable");
const indicator = () => screen.getByTestId("portal-dock-indicator");
const skeletons = () => screen.queryAllByTestId("portal-skeleton");
const THREAD = { thread_id: "t1", kind: "owner", title: "Café Solsikke", last_body: "Hej Freja", last_at: new Date().toISOString(), unread: 0 };

function motionPref({ reduce }) {
  window.matchMedia = (q) => ({
    matches: q === "(prefers-reduced-motion: reduce)" ? reduce : false,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  });
}

beforeEach(() => {
  localStorage.clear();
  clearVenueMapCache();
  get.mockClear();
  post.mockReset();
  post.mockImplementation(() => ok({}));
  impl = {
    threads: () => ok({ threads: [THREAD] }),
    swaps: () => ok([]),
    giveaways: () => ok([]),
    availability: () => ok({ availability: [] }),
    absence: () => ok({ absence: [] }),
    notifications: () => ok({ notifications: [] }),
  };
});
afterEach(() => {
  delete window.matchMedia;
  document.body.classList.remove("portal-shell");
});

describe("a) Pill first, page second", () => {
  it("the pill's --i, the name pop and aria-current move in the click's act; the new screen is there in the same act", async () => {
    await mount();
    expect(indicator().style.getPropertyValue("--i")).toBe("0");
    const before = screen.getByTestId("portal-content");
    go("hours");
    expect(indicator().style.getPropertyValue("--i")).toBe("4");
    expect(screen.getByTestId("portal-tab-hours").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("portal-tab-schedule").getAttribute("aria-current")).toBeNull();
    const popped = screen.getByTestId("portal-tabbar-v3").querySelectorAll(".vp-label-in");
    expect([...popped].map((n) => n.textContent)).toEqual(["Timer"]);
    // act flushed the transition: the Timer screen replaced the home already.
    expect(screen.getByTestId("portal-content")).not.toBe(before);
    expect(screen.queryByTestId("portal-hero")).toBeNull();
    expect(screen.getByTestId("portal-content").className).toContain("vp-tab-in");
  });

  it("the bell (Alerts) and every other setTab path still work beside the dock", async () => {
    await mount();
    go("swaps");
    fireEvent.click(within(screen.getByTestId("portal-header-row")).getByRole("button", { name: "Nyt" }));
    expect(indicator().hasAttribute("data-hidden")).toBe(true);
    expect(indicator().style.getPropertyValue("--i")).toBe("3");   // fades where it was
    go("schedule");
    expect(indicator().hasAttribute("data-hidden")).toBe(false);
    expect(indicator().style.getPropertyValue("--i")).toBe("0");
    expect(screen.getByTestId("portal-hero")).toBeInTheDocument();
  });
});

describe("c) Each tab keeps its scroll", () => {
  it("Vagtplan at 300 → Timer starts at 0 → back on Vagtplan at 300", async () => {
    await mount();
    const el = shell();
    el.scrollTop = 300;
    fireEvent.scroll(el);
    go("hours");
    expect(el.scrollTop).toBe(0);
    fireEvent.scroll(el);          // the scroll event that follows records Timer's 0
    go("schedule");
    expect(el.scrollTop).toBe(300);
    go("hours");
    expect(el.scrollTop).toBe(0);
  });

  it("tapping the tab you are on scrolls it to the top (a jump without motion); nothing re-mounts", async () => {
    await mount();
    const el = shell();
    el.scrollTo = vi.fn();
    const content = screen.getByTestId("portal-content");
    go("schedule");
    expect(el.scrollTo).toHaveBeenCalledTimes(1);
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "auto" });
    expect(screen.getByTestId("portal-content")).toBe(content);
    expect(content.className).not.toContain("vp-tab-in");
  });

  it("with motion allowed the scroll to the top is smooth", async () => {
    motionPref({ reduce: false });
    await mount();
    go("hours");
    const el = shell();
    el.scrollTo = vi.fn();
    go("hours");
    expect(el.scrollTo).toHaveBeenCalledWith({ top: 0, behavior: "smooth" });
  });
});

describe("d) No shimmer on return", () => {
  it("Beskeder → Timer → Beskeder: the second visit shows the threads at once (its GET held open), no skeleton", async () => {
    await mount();
    go("messages");
    expect(skeletons().length).toBeGreaterThan(0);        // a first visit has no memory
    expect(await screen.findAllByTestId("portal-thread-row")).toHaveLength(1);
    go("hours");
    impl.threads = never;
    const reads = get.mock.calls.filter(([u]) => u.endsWith("/chat/threads")).length;
    go("messages");
    expect(screen.getAllByTestId("portal-thread-row")).toHaveLength(1);
    expect(skeletons()).toEqual([]);
    // The fetch on mount still runs behind it.
    expect(get.mock.calls.filter(([u]) => u.endsWith("/chat/threads")).length).toBe(reads + 1);
  });

  it("Byt → Timer → Byt: the inbox from memory, no list skeleton", async () => {
    impl.swaps = () => ok([{
      id: "in", direction: "incoming", status: "proposed", from_staff_name: "Ida H.", to_staff_name: "Freja M.",
      from_shift_date: nextWeek(2), from_shift_time: "10:00–16:00", to_shift_id: "x", to_shift_date: nextWeek(3), to_shift_time: "16:00–22:00",
    }]);
    await mount();
    go("swaps");
    expect(await screen.findAllByTestId("swap-row")).toHaveLength(1);
    go("hours");
    impl.swaps = never;
    impl.giveaways = never;
    go("swaps");
    expect(screen.getAllByTestId("swap-row")).toHaveLength(1);
    expect(screen.queryByTestId("portal-list-loading")).toBeNull();
  });

  it("Nyt (the bell) → Vagtplan → Nyt: the list at once, no skeleton", async () => {
    impl.notifications = () => ok({ notifications: [{ id: 1, event_type: "schedule_published", channel: "email", subject: "Schedule published - week", created_at: new Date().toISOString() }] });
    await mount();
    const bell = () => within(screen.getByTestId("portal-header-row")).getByRole("button", { name: "Nyt" });
    fireEvent.click(bell());
    expect(await screen.findByText("Vagtplan offentliggjort")).toBeInTheDocument();
    go("schedule");
    impl.notifications = never;
    fireEvent.click(bell());
    expect(screen.getByText("Vagtplan offentliggjort")).toBeInTheDocument();
    expect(skeletons()).toEqual([]);
  });

  it("unmounting the page clears the memory: a fresh mount shows the skeleton again", async () => {
    const view = await mount();
    go("messages");
    await screen.findAllByTestId("portal-thread-row");
    expect(recall(TOK, "threads")).toHaveLength(1);
    view.unmount();
    expect(recall(TOK, "threads")).toBeUndefined();
    impl.threads = never;
    await mount();
    go("messages");
    expect(skeletons().length).toBeGreaterThan(0);
    expect(screen.queryAllByTestId("portal-thread-row")).toEqual([]);
  });

  it("Fravær: an optimistic mark, then leave and return before the save answers → no tmp- row from memory", async () => {
    const save = deferred();
    post.mockImplementation((url) => (url.endsWith("/availability") ? save.promise : ok({})));
    await mount();
    go("availability");
    const week = () => screen.getByTestId("kanikke-week");
    await screen.findByTestId("kanikke-week");
    const sat = () => within(week()).getAllByRole("button").filter((b) => b.dataset.look)[5];
    fireEvent.click(within(week()).getByRole("button", { name: "Næste uge" }));
    expect(sat().dataset.look).toBe("free");
    fireEvent.click(sat());
    expect(sat().dataset.look).toBe("cant");               // the optimistic tmp- row
    go("schedule");
    impl.availability = never;                             // what shows next is memory alone
    go("availability");
    fireEvent.click(within(week()).getByRole("button", { name: "Næste uge" }));
    expect(sat().dataset.look).toBe("free");
    expect((recall(TOK, "avail") || []).some((r) => String(r.id).startsWith("tmp-"))).toBe(false);
    // The save answers later; its own reload (a server answer) may update memory.
    impl.availability = () => ok({ availability: [{ id: "a1", kind: "unavailable", date: nextWeek(5), weekday: null, start_time: null, end_time: null, note: null }] });
    await act(async () => { save.resolve({ data: {} }); });
    await waitFor(() => expect(recall(TOK, "avail")).toEqual([expect.objectContaining({ id: "a1" })]));
  });

  it("Fravær: a mark the server deleted is gone from memory too (no ghost on the next return)", async () => {
    impl.availability = () => ok({ availability: [{ id: "a9", kind: "unavailable", date: nextWeek(5), weekday: null, start_time: null, end_time: null, note: null }] });
    await mount();
    go("availability");
    await screen.findByTestId("kanikke-week");
    fireEvent.click(within(screen.getByTestId("kanikke-week")).getByRole("button", { name: "Næste uge" }));
    const sat = () => within(screen.getByTestId("kanikke-week")).getAllByRole("button").filter((b) => b.dataset.look)[5];
    await waitFor(() => expect(sat().dataset.look).toBe("cant"));
    fireEvent.click(sat());                                // un-mark → DELETE (answers at once)
    await waitFor(() => expect(recall(TOK, "avail")).toEqual([]));
    go("schedule");
    impl.availability = never;
    go("availability");
    fireEvent.click(within(screen.getByTestId("kanikke-week")).getByRole("button", { name: "Næste uge" }));
    expect(sat().dataset.look).toBe("free");
  });
});
