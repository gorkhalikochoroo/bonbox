/**
 * Premium feel 1.4, the haptic map, on the REAL page (a mocked portalApi and
 * a spied components/staff/feel). One haptic per action, on the outcome; a
 * tick only on a real change, and never when a question opens instead:
 *
 *   • Byt: a swap accepted → done once; declined → soft; refused (the
 *     trade would double-book you) → warn; could not answer → fail.
 *   • Fravær: a time-off request without a date → warn once (on Send only).
 *   • Fravær's week strip: a free day marked → one tick; a rostered day in
 *     "kan ikke" (the question sheet opens instead) → no tick, until "Markér
 *     alligevel" makes the mark.
 *   • Kan ikke / Helst: the chosen half again → no tick; the other → one.
 *
 * feel.js itself (words per platform, throttle, never throws) is pinned in
 * feel.test.js; the press controller's warm in pressFeel.test.js.
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tokfeel";
const ok = (data) => Promise.resolve({ data });

const spy = vi.hoisted(() => ({
  feel: { done: vi.fn(), warn: vi.fn(), fail: vi.fn(), soft: vi.fn(), tick: vi.fn(), warm: vi.fn() },
}));
vi.mock("../components/staff/feel", () => ({ feel: spy.feel, resetFeelForTests: () => {} }));
vi.mock("../utils/platform", () => ({
  platform: { isNative: false, isIOS: false, isAndroid: false, isWeb: true },
  isNativeApp: () => false,
  canPurchaseInApp: () => true,
  isIPad: () => false,
}));

const iso = (d) => d.toLocaleDateString("sv-SE");
// Next week's Monday + i: in the future whatever weekday the suite runs on.
const nextWeek = (i) => {
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7) + 7 + i);
  return iso(d);
};

let data;
const get = vi.fn((url) => {
  const sub = url.slice(`/portal/${TOK}`.length);
  if (sub === "") return ok(data.info);
  if (sub.startsWith("/schedule")) return ok({ shifts: data.shifts });
  if (sub.startsWith("/team-schedule")) return ok([]);
  if (sub.startsWith("/availability")) return ok({ availability: data.availability });
  if (sub.startsWith("/absence")) return ok({ absence: data.absence });
  if (sub.startsWith("/notifications")) return ok({ notifications: [] });
  if (sub === "/chat/unread") return ok({ unread: 0 });
  if (sub.startsWith("/swap-requests")) return ok(data.swaps);
  if (sub.startsWith("/give-aways")) return ok([]);
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
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn(), takePhotoFile: vi.fn(), choosePhotoFiles: vi.fn(), isCameraDenied: vi.fn() }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })) } }));
vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })), setAccessoryBarVisible: vi.fn(() => Promise.resolve()), setScroll: vi.fn(() => Promise.resolve()), setResizeMode: vi.fn(() => Promise.resolve()) },
  KeyboardResize: { Body: "body", Native: "native", None: "none", Ionic: "ionic" },
}));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

async function mount() {
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
  await waitFor(() => expect(screen.getByTitle("Rediger profil")).toBeInTheDocument());
}
const go = (tab) => fireEvent.click(screen.getByTestId(`portal-tab-${tab}`));
const calls = () => Object.fromEntries(Object.entries(spy.feel).map(([k, f]) => [k, f.mock.calls.length]).filter(([, n]) => n));

beforeEach(() => {
  localStorage.clear();
  get.mockClear();
  post.mockReset();
  post.mockImplementation(() => ok({}));
  Object.values(spy.feel).forEach((f) => f.mockClear());
  data = {
    info: { has_pin: false, staff_name: "Freja M.", role: "waiter", restaurant_name: "Café Solsikke" },
    // A shift next Sunday: a rostered day nothing marks yet.
    shifts: [{ id: "sh-sun", date: nextWeek(6), start_time: "16:00", end_time: "22:00", status: "published", net_hours: 5.5 }],
    availability: [],
    absence: [],
    swaps: [{
      id: "in", direction: "incoming", status: "proposed", from_staff_name: "Ida H.", to_staff_name: "Freja M.",
      from_shift_date: nextWeek(2), from_shift_time: "10:00–16:00", to_shift_id: "x", to_shift_date: nextWeek(3), to_shift_time: "16:00–22:00",
    }],
  };
});
afterEach(() => {
  document.body.classList.remove("portal-shell");
});

async function openIncomingSwap() {
  await mount();
  go("swaps");
  const [row] = await screen.findAllByTestId("swap-row");
  return row;
}

describe("Byt: a swap answered", () => {
  it("accepted (the server said yes): done, once, and nothing else", async () => {
    const row = await openIncomingSwap();
    fireEvent.click(within(row).getByTestId("swap-accept"));
    await waitFor(() => expect(spy.feel.done).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[0][0]).toBe(`/portal/${TOK}/swap-requests/in/respond`);
    expect(post.mock.calls[0][1]).toEqual({ accept: true });
    expect(calls()).toEqual({ done: 1 });
  });

  it("declined: soft (a routine thing went through)", async () => {
    const row = await openIncomingSwap();
    fireEvent.click(within(row).getByTestId("swap-decline"));
    await waitFor(() => expect(spy.feel.soft).toHaveBeenCalledTimes(1));
    expect(calls()).toEqual({ soft: 1 });
  });

  it("refused (it would double-book you): warn; the server could not be reached: fail", async () => {
    post.mockImplementation(() => Promise.reject(Object.assign(new Error("409"), {
      response: { status: 409, data: { detail: { code: "swap_overlap", who: "self", message: "overlap" } } },
    })));
    const row = await openIncomingSwap();
    fireEvent.click(within(row).getByTestId("swap-accept"));
    await waitFor(() => expect(spy.feel.warn).toHaveBeenCalledTimes(1));
    expect(calls()).toEqual({ warn: 1 });

    post.mockImplementation(() => Promise.reject(new Error("Network Error")));
    fireEvent.click(within(row).getByTestId("swap-accept"));
    await waitFor(() => expect(spy.feel.fail).toHaveBeenCalledTimes(1));
    expect(spy.feel.done).not.toHaveBeenCalled();
  });
});

describe("Fravær", () => {
  it("a time-off request without a date: warn, once, on Send (nothing is posted)", async () => {
    await mount();
    go("availability");
    fireEvent.click(await screen.findByTestId("fravaer-add"));
    const form = await screen.findByTestId("fravaer-form");
    expect(calls()).toEqual({});   // opening the form is silent
    fireEvent.click(within(form).getByTestId("fravaer-submit"));
    expect(await within(form).findByText("Vælg en startdato")).toBeInTheDocument();
    expect(calls()).toEqual({ warn: 1 });
    expect(post.mock.calls.filter(([u]) => u.endsWith("/absence"))).toHaveLength(0);
  });

  it("the week strip: a free day marked ticks once; a rostered day in 'kan ikke' opens the question and does not tick", async () => {
    await mount();
    go("availability");
    const week = await screen.findByTestId("kanikke-week");
    fireEvent.click(within(week).getByRole("button", { name: "Næste uge" }));
    const cells = () => within(week).getAllByRole("button").filter((b) => b.dataset.look);
    const sat = cells()[5];
    const sun = cells()[6];
    expect(within(sun).getByTestId("kanikke-rostered-dot")).toBeInTheDocument();

    // The rostered day: the question sheet opens instead of a mark — silent.
    fireEvent.click(sun);
    const sheet = await screen.findByTestId("kanikke-rostered-sheet");
    expect(spy.feel.tick).not.toHaveBeenCalled();
    expect(post.mock.calls.filter(([u]) => u.endsWith("/availability"))).toHaveLength(0);
    // "Markér alligevel" makes the mark: now it ticks, once.
    fireEvent.click(within(sheet).getByRole("button", { name: "Markér alligevel" }));
    await waitFor(() => expect(post.mock.calls.filter(([u]) => u.endsWith("/availability"))).toHaveLength(1));
    expect(spy.feel.tick).toHaveBeenCalledTimes(1);

    // A free day (both ways: the zero above is not a page that never ticks).
    fireEvent.click(sat);
    await waitFor(() => expect(post.mock.calls.filter(([u]) => u.endsWith("/availability"))).toHaveLength(2));
    expect(spy.feel.tick).toHaveBeenCalledTimes(2);
    expect(spy.feel.fail).not.toHaveBeenCalled();
  });

  it("'Kan ikke / Helst': the chosen half again is silent; the other half ticks once", async () => {
    await mount();
    go("availability");
    const cant = await screen.findByTestId("kanikke-mode-unavailable");
    expect(cant.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(cant);
    expect(spy.feel.tick).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("kanikke-mode-preferred"));
    expect(spy.feel.tick).toHaveBeenCalledTimes(1);
  });
});
