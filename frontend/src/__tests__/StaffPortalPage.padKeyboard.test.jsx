/**
 * Vagtplan 1.7 — the iPad Beskeder card and the native keyboard.
 *
 * Device pass (12 Nov 2026, iPad Air 11" landscape): with the keyboard up the
 * conversation card kept its 360 px floor, but the room above a landscape
 * keyboard is ≈220 px — so the card ran under the keyboard and its last row,
 * the composer, with it. Portrait (≈680 px of room) never hit the floor.
 * Pinned here: while the keyboard is up the card, the split's list column and
 * its pick pane all end at the keyboard with no floor; with it down the card
 * keeps its 360 px floor. The phone never draws the card.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tokpadkb";
const ok = (data) => Promise.resolve({ data });
let kb = 0;

vi.mock("../utils/platform", () => ({
  platform: { isNative: true, isIOS: true, isAndroid: false, isWeb: false },
  isNativeApp: () => true,
  canPurchaseInApp: () => false,
  isIPad: () => true,
}));
// Stateful like the real hook: the keyboard event re-renders every user.
const kbBus = vi.hoisted(() => ({ listeners: new Set() }));
vi.mock("../hooks/useKeyboardLift", async () => {
  const React = await import("react");
  const useKb = () => {
    const [v, set] = React.useState(kb);
    React.useEffect(() => {
      kbBus.listeners.add(set);
      return () => kbBus.listeners.delete(set);
    }, []);
    return v;
  };
  return {
    useKeyboardLift: useKb,
    useKeyboardState: () => {
      const v = useKb();
      return { lift: v, open: v > 0 };
    },
  };
});
function setKeyboard(h) {
  kb = h;
  act(() => { kbBus.listeners.forEach((f) => f(h)); });
}

const THREAD = {
  thread_id: "own", kind: "owner", title: "Testcafé",
  messages: [{ id: 1, sender_type: "owner", mine: false, body: "Kan du tage fredag?", created_at: new Date().toISOString() }],
};
vi.mock("../services/portalApi", () => ({
  default: {
    get: (url) => {
      if (url === `/portal/${TOK}`) return ok({ has_pin: false, staff_name: "Ali R.", restaurant_name: "Testcafé", role: "kitchen" });
      if (url.includes("/schedule")) return ok({ shifts: [] });
      if (url.includes("/notifications")) return ok({ notifications: [] });
      if (url.endsWith("/chat/unread")) return ok({ unread: 0 });
      if (url.includes("/chat/threads/")) return ok(THREAD);
      if (url.includes("/chat/threads")) return ok({ threads: [{ thread_id: "own", kind: "owner", title: "Testcafé", last_body: "Kan du tage fredag?", last_message_at: new Date().toISOString(), unread: 0 }] });
      if (url.includes("/hours")) return ok({ period_start: "2026-10-01", period_end: "2026-10-31", total_hours: 0, entries: [] });
      return ok([]);
    },
    post: vi.fn(() => ok({})), put: vi.fn(), delete: vi.fn(() => ok({})), defaults: { baseURL: "" },
  },
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
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })) } }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

// A pretend window: matchMedia answers the range queries for a width × height.
const realMatchMedia = window.matchMedia;
let win = { w: 1180, h: 820 };
function evalQuery(q) {
  return q.split(/\s+and\s+/).every((p) => {
    const m = p.match(/\(\s*(width|height)\s*>=\s*(\d+)px\s*\)/);
    return !!m && (m[1] === "width" ? win.w : win.h) >= Number(m[2]);
  });
}
beforeEach(() => {
  kb = 0;
  localStorage.clear();
  localStorage.setItem("lang", "da");
  window.matchMedia = (q) => ({
    media: q,
    get matches() { return evalQuery(q); },
    addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
  });
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  document.body.classList.remove("portal-shell");
  document.documentElement.removeAttribute("data-vp-rail");
});

async function mount(w, h) {
  win = { w, h };
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
  // iPad: the sidebar; a phone: the dock.
  fireEvent.click(screen.getByTestId(w >= 744 && h >= 600 ? "portal-rail-messages" : "portal-tab-messages"));
}

describe("iPad Beskeder: the card ends at the keyboard (no 360 px floor while it is up)", () => {
  it("wide iPad (1180 × 820): the pick pane and the list column follow the keyboard", async () => {
    await mount(1180, 820);
    const split = await screen.findByTestId("portal-messages-split");
    const pick = within(split).getByTestId("portal-chat-pick");
    const listCol = split.firstElementChild;
    expect(pick.style.minHeight).toBe("360px");
    expect(pick.style.height).toContain("- 0px)");
    expect(listCol.style.maxHeight).toContain("- 0px)");
    setKeyboard(422);
    expect(pick.style.minHeight).toBe("0");
    expect(pick.style.height).toContain("- 422px)");
    expect(listCol.style.maxHeight).toContain("- 422px)");
  });

  it("wide iPad: an open conversation's card drops its floor while typing, the composer stays its last row", async () => {
    await mount(1180, 820);
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[0]);
    const pane = await screen.findByTestId("portal-chat-pane");
    expect(pane.style.minHeight).toBe("360px");
    setKeyboard(422);
    expect(pane.style.minHeight).toBe("0");
    expect(pane.style.height).toContain("- 422px)");
    const composer = within(pane).getByTestId("portal-chat-composer");
    expect(composer.className).toContain("flex-none");
    expect(composer.className).not.toMatch(/\bfixed\b/);
    expect(pane.lastElementChild).toBe(composer);
    // Keyboard down again: the card's floor is back.
    setKeyboard(0);
    expect(pane.style.minHeight).toBe("360px");
    expect(pane.style.height).toContain("- 0px)");
  });

  it("portrait iPad (820 × 1180): the same card, the same rule", async () => {
    await mount(820, 1180);
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[0]);
    const pane = await screen.findByTestId("portal-chat-pane");
    setKeyboard(320);
    expect(pane.style.minHeight).toBe("0");
    expect(pane.style.height).toContain("- 320px)");
  });

  it("phone (390 × 844): no card, the composer floats on the keyboard as before", async () => {
    await mount(390, 844);
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[0]);
    const composer = await screen.findByTestId("portal-chat-composer");
    expect(screen.queryByTestId("portal-chat-pane")).toBeNull();
    setKeyboard(300);
    expect(composer.className).toMatch(/\bfixed\b/);
    expect(composer.style.bottom).toBe("300px");
  });
});
