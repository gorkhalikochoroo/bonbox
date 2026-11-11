/**
 * The staff app on Android, wired on the REAL portal page — fixes from the
 * Android emulator walk of 11 Nov 2026 (Medium Phone, API 37):
 *
 *   • BACK (key, edge swipe, 3-button bar) did nothing anywhere. Now: the top
 *     layer closes (sheet, chat thread), else back to Vagtplan, else the app
 *     goes to the background.
 *   • The keyboard lifted things twice (the WebView already shrinks on
 *     Android): the composer jumped over the thread title and the dock rode
 *     on the keyboard. Now: composer at the window's edge, dock hidden while
 *     typing.
 *   • Empty date fields were blank boxes (the "Vælg dato" hint was iOS-only).
 *   • The Timer week chart squeezed its labels once the phone's text was
 *     larger (fixed 108 px row).
 *   • Source contracts: the pull-to-refresh pill clears the status bar,
 *     Disconnect leaves no way BACK into the portal, and the native shell
 *     registers no service worker.
 *
 * iOS / web behaviour is pinned by the existing suites (keyboardNative,
 * schedulerRound1 …), which run with the iOS platform.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

const TOK = "tokand";
const ok = (data) => Promise.resolve({ data });
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
};

vi.mock("../utils/platform", () => ({
  platform: { isNative: true, isIOS: false, isAndroid: true, isWeb: false },
  isNativeApp: () => true,
  canPurchaseInApp: () => false,
  isIPad: () => false,
}));

// Stateful like the real hook. Android: the WebView shrinks, so the lift is
// 0 while the keyboard is open.
const kbBus = vi.hoisted(() => ({ open: false, listeners: new Set() }));
vi.mock("../hooks/useKeyboardLift", async () => {
  const React = await import("react");
  const useOpen = () => {
    const [v, set] = React.useState(kbBus.open);
    React.useEffect(() => {
      kbBus.listeners.add(set);
      return () => kbBus.listeners.delete(set);
    }, []);
    return v;
  };
  return {
    useKeyboardLift: () => 0,
    useKeyboardState: () => ({ lift: 0, open: useOpen() }),
  };
});
function setKeyboardOpen(open) {
  kbBus.open = open;
  act(() => { kbBus.listeners.forEach((f) => f(open)); });
}

const cap = vi.hoisted(() => ({ back: new Set(), minimize: null }));
vi.mock("@capacitor/app", () => ({
  App: {
    addListener: vi.fn((name, fn) => {
      if (name === "backButton") cap.back.add(fn);
      return Promise.resolve({ remove: () => cap.back.delete(fn) });
    }),
    minimizeApp: (...a) => cap.minimize(...a),
  },
}));
function pressBack() {
  act(() => { cap.back.forEach((f) => f({ canGoBack: false })); });
}

vi.mock("../services/portalApi", () => ({
  default: {
    get: (url) => {
      if (url === `/portal/${TOK}`) return ok({ has_pin: false, staff_name: "Ali R.", restaurant_name: "Testcafé", role: "kitchen" });
      if (url.includes("/schedule")) return ok({ shifts: [] });
      if (url.includes("/absence")) return ok({ absence: [] });
      if (url.includes("/notifications")) return ok({ notifications: [] });
      if (url.endsWith("/chat/unread")) return ok({ unread: 0 });
      if (url.endsWith("/chat/threads")) return ok({ threads: [{ thread_id: "th1", kind: "direct", title: "Testcafé", last_body: "Hej" }] });
      if (url.includes("/chat/threads/th1")) return ok({ kind: "direct", messages: [] });
      if (url.includes("/hours")) {
        return ok({
          period_start: inDays(-20), period_end: inDays(0), total_hours: 13, hours_source: "logged",
          entries: [
            { date: inDays(-14), start_time: "10:00", end_time: "17:00", total_hours: 7 },
            { date: inDays(-1), start_time: "10:00", end_time: "16:00", total_hours: 6 },
          ],
        });
      }
      return ok([]);
    },
    post: vi.fn(() => ok({})), put: vi.fn(), delete: vi.fn(), defaults: { baseURL: "" },
  },
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

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel) => fs.readFileSync(path.join(SRC, rel), "utf8");

// jsdom has no layout: every element counts as on screen for BACK.
const realRects = Element.prototype.getClientRects;
beforeAll(() => {
  Element.prototype.getClientRects = function rects() { return [{ width: 1, height: 1 }]; };
});
afterAll(() => {
  Element.prototype.getClientRects = realRects;
});

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
const dock = () => screen.getByTestId("portal-tabbar-v3");
const navTo = (label) => fireEvent.click(within(dock()).getByText(label).closest("button"));
const activeTab = () => dock().querySelector('[aria-current="page"]')?.getAttribute("data-testid");

beforeEach(() => {
  localStorage.clear();
  kbBus.open = false;
  cap.minimize = vi.fn(() => Promise.resolve());
});

describe("Android BACK", () => {
  it("is answered on Android: the open sheet closes first, then Vagtplan, then the app goes to the background", async () => {
    await mount();
    expect(cap.back.size).toBe(1);

    navTo("Byt");
    fireEvent.click(screen.getByTitle("Rediger profil"));
    await waitFor(() => expect(screen.getByText("Frakobl denne telefon fra vagtplanen")).toBeInTheDocument());
    pressBack();
    await waitFor(() => expect(screen.queryByText("Frakobl denne telefon fra vagtplanen")).toBeNull());
    expect(activeTab()).toBe("portal-tab-swaps");      // only the sheet closed
    expect(cap.minimize).not.toHaveBeenCalled();

    pressBack();
    await waitFor(() => expect(activeTab()).toBe("portal-tab-schedule"));
    expect(cap.minimize).not.toHaveBeenCalled();

    pressBack();
    expect(cap.minimize).toHaveBeenCalledTimes(1);
    expect(activeTab()).toBe("portal-tab-schedule");
  });

  it("a confirm over the profile sheet: BACK cancels the confirm, the sheet stays", async () => {
    await mount();
    localStorage.setItem("bonbox_portal_token", TOK);
    fireEvent.click(screen.getByTitle("Rediger profil"));
    fireEvent.click(await screen.findByText("Frakobl denne telefon fra vagtplanen"));
    await screen.findByText("Frakoble denne telefon?");
    pressBack();
    await waitFor(() => expect(screen.queryByText("Frakoble denne telefon?")).toBeNull());
    expect(screen.getByText("Frakobl denne telefon fra vagtplanen")).toBeInTheDocument();
    expect(localStorage.getItem("bonbox_portal_token")).toBe(TOK);   // Cancel, never Disconnect
  });
});

describe("Chat thread with the Android keyboard up", () => {
  async function openThread() {
    await mount();
    navTo("Beskeder");
    fireEvent.click(await screen.findByText("Testcafé", { selector: "button *" }));
    return screen.findByTestId("portal-chat-composer");
  }

  it("the composer sits on the keyboard's edge (no second lift) and the dock steps aside", async () => {
    const composer = await openThread();
    expect(composer.style.bottom).toContain("68px");          // above the dock at rest
    expect(dock().style.display).toBe("");

    setKeyboardOpen(true);
    await waitFor(() => expect(screen.getByTestId("portal-chat-composer").style.bottom).toBe("0px"));
    expect(dock().style.display).toBe("none");
    const stream = screen.getByTestId("portal-chat-stream");
    expect(stream.style.maxHeight).toContain("safe-area-inset-top");
    expect(stream.style.maxHeight).not.toMatch(/- [1-9]\d*px\)$/);  // no keyboard height subtracted again

    setKeyboardOpen(false);
    await waitFor(() => expect(screen.getByTestId("portal-chat-composer").style.bottom).toContain("68px"));
    expect(dock().style.display).toBe("");
  });

  it("BACK leaves the thread for the list, and stays on Beskeder", async () => {
    await openThread();
    pressBack();
    await waitFor(() => expect(screen.queryByTestId("portal-chat-composer")).toBeNull());
    expect(activeTab()).toBe("portal-tab-messages");
    expect(cap.minimize).not.toHaveBeenCalled();
  });
});

describe("Android: the rest of the walk", () => {
  it("empty date fields say what tapping them does (the WebView draws an empty box)", async () => {
    await mount();
    navTo("Fravær");
    fireEvent.click(await screen.findByRole("button", { name: /Anmod om fri/ }));
    const form = await screen.findByTestId("fravaer-form");
    expect(within(form).getAllByText("Vælg dato").length).toBeGreaterThanOrEqual(2);
  });

  it("the Timer week chart grows with the text instead of squeezing its labels", async () => {
    await mount();
    navTo("Timer");
    const row = await screen.findByTestId("portal-week-bars");
    expect(row.style.minHeight).toBe("108px");
    expect(row.style.height).toBe("");
    const bar = within(row).getAllByTestId("portal-week-bar")[0];
    const labels = bar.querySelectorAll("span");
    expect(labels[0].style.flexShrink).toBe("0");
    expect(labels[labels.length - 1].style.flexShrink).toBe("0");
  });

  it("source: the refresh pill clears the status bar; Disconnect replaces the history entry", () => {
    const src = read("pages/StaffPortalPage.jsx");
    expect(src).toMatch(/data-testid="portal-pull-status"/);
    expect(src).toMatch(/top: "calc\(env\(safe-area-inset-top, 0px\) \+ 8px\)"/);
    expect(src).not.toMatch(/style=\{\{ top: 8 \}\}/);
    expect(src).toMatch(/window\.location\.replace\("\/join"\)/);
    expect(src).not.toMatch(/window\.location\.href = "\/join"/);
  });

  it("source: the native shells register no service worker; browsers still do", () => {
    const html = read("../index.html");
    const block = html.slice(html.indexOf('navigator.serviceWorker.register("/sw.js")') - 600, html.indexOf('navigator.serviceWorker.register("/sw.js")'));
    expect(block).toMatch(/window\.Capacitor\.isNativePlatform\(\)\) return;/);
    expect(html).toMatch(/if \("serviceWorker" in navigator && !window\.__bbBooking\)/);
  });
});
