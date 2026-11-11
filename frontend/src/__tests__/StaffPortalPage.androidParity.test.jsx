/**
 * The staff app on Android — the "fix android all" round (11 Nov 2026),
 * pinned on the REAL portal page against a mocked portalApi, with the
 * platform switched per test: the native Android app, Chrome on Android (an
 * Android user agent, not native), the iPhone app, and a desktop browser.
 *
 *   • Tilføj til kalender: nothing on Android handles webcal:, so the tap did
 *     nothing and the hint then implied it had worked. Android opens Google
 *     Calendar's add-by-URL page (the app: Browser.open; Chrome: a new tab),
 *     flags the tap only when something opened, says so when it did not, and
 *     offers "Kopiér kalenderlink". iPhone and desktop: webcal:, as before.
 *   • Kontrakt og dokumenter: the Android app cannot save a file, so it lists
 *     the documents and says honestly where to get them — no "Prøv igen".
 *   • Mind mig om vagt: hidden in the Android app (no push there); Chrome on
 *     Android keeps it (Web Push).
 *   • The branch link: Google Maps on Android, Apple Maps elsewhere.
 *   • The no-location fix names Android's own path, app or Chrome.
 *   • Chat photo in the Android app: a small "take or choose" sheet — the
 *     camera for one photo, the photo picker for as many as still fit (up to
 *     3, like the file input) — feeds the same picker; a refused camera is
 *     said.
 *
 * Only the platform module, the API, and native plugins at their boundary
 * (Browser, Camera, App, Keyboard) are mocked; the rest is the real page.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "../i18n/en";

const TOK = "tokparity1";
const TOK8 = TOK.slice(0, 8);
const ok = (data) => Promise.resolve({ data });

const PIXEL = "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36";
const FEED = `https://api.bonbox.dk/api/portal/${TOK}/schedule.ics`;
const GOOGLE = `https://calendar.google.com/calendar/render?cid=${encodeURIComponent(`webcal://api.bonbox.dk/api/portal/${TOK}/schedule.ics`)}`;

// The platform, switched per test. utils/routeUrl, utils/download and the
// page all read this one module.
const plat = vi.hoisted(() => ({ isNative: false, isIOS: false, isAndroid: false, isWeb: true }));
vi.mock("../utils/platform", async (importOriginal) => ({
  ...(await importOriginal()),
  platform: plat,
  isNativeApp: () => plat.isNative,
}));
const asWeb = () => Object.assign(plat, { isNative: false, isIOS: false, isAndroid: false, isWeb: true });
const asAndroidApp = () => Object.assign(plat, { isNative: true, isIOS: false, isAndroid: true, isWeb: false });
const asIOSApp = () => Object.assign(plat, { isNative: true, isIOS: true, isAndroid: false, isWeb: false });

// Native plugins at their boundary. Plain stubs, not vi.fn, for the ones that
// reject: a spy's own derived promise would go unhandled.
const native = vi.hoisted(() => ({ browserCalls: [], browserImpl: null, photoCalls: [], photoImpl: null, pickCalls: [], pickImpl: null }));
vi.mock("@capacitor/browser", () => ({
  Browser: { open: (opts) => { native.browserCalls.push(opts); return native.browserImpl(opts); } },
}));
vi.mock("@capacitor/camera", () => ({
  Camera: {
    getPhoto: (opts) => { native.photoCalls.push(opts); return native.photoImpl(opts); },
    pickImages: (opts) => { native.pickCalls.push(opts); return native.pickImpl(opts); },
  },
  CameraSource: { Prompt: "PROMPT", Camera: "CAMERA", Photos: "PHOTOS" },
  CameraResultType: { Base64: "base64", Uri: "uri" },
}));
vi.mock("@capacitor/app", () => ({
  App: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })), minimizeApp: vi.fn(() => Promise.resolve()) },
}));
vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })), setAccessoryBarVisible: vi.fn(() => Promise.resolve()), setScroll: vi.fn(() => Promise.resolve()), setResizeMode: vi.fn(() => Promise.resolve()) },
  KeyboardResize: { Body: "body", Native: "native", None: "none", Ionic: "ionic" },
}));

// Wednesday 11 Nov 2026.
const WED = "2026-11-11";
const THU = "2026-11-12";

let info;
let shifts;
let clockImpl;
let extraGet;
let postImpl;
const get = vi.fn((url) => {
  const sub = url.slice(`/portal/${TOK}`.length);
  if (sub === "") return ok(info);
  if (sub.startsWith("/schedule")) return ok({ shifts });
  if (sub.startsWith("/team-schedule")) return ok([]);
  if (sub === "/clock") return clockImpl();
  if (sub.startsWith("/hours")) return ok({ period_start: WED, period_end: WED, total_hours: 0, entries: [] });
  if (sub.includes("/notifications")) return ok({ notifications: [] });
  if (sub === "/chat/unread") return ok({ unread: 0 });
  if (sub === "/chat/threads") return ok({ threads: [{ thread_id: "th1", kind: "direct", title: "Café Solsikke", last_body: "Hej" }] });
  if (sub.startsWith("/chat/threads/th1")) return ok({ kind: "direct", messages: [] });
  if (extraGet[sub]) return extraGet[sub]();
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
vi.mock("../utils/haptics", () => ({ haptic: Object.assign(vi.fn(), { light: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn() }) }));

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
  await waitFor(() => expect(screen.getByTitle(lang === "da" ? "Rediger profil" : "Edit profile")).toBeInTheDocument());
}

// Chrome on Android: an Android user agent in a browser (not the app).
const setUA = (ua) => Object.defineProperty(window.navigator, "userAgent", { configurable: true, get: () => ua });
const realOpen = window.open;
const realGeo = Object.getOwnPropertyDescriptor(window.navigator, "geolocation");
const realCreateObjectURL = URL.createObjectURL;
const at = (h, m = 0) => vi.setSystemTime(new Date(2026, 10, 11, h, m, 0));

beforeAll(() => {
  if (!URL.revokeObjectURL) URL.revokeObjectURL = () => {};
});

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  at(8, 0);
  asWeb();
  localStorage.clear();
  get.mockClear();
  post.mockClear();
  native.browserCalls.length = 0;
  native.browserImpl = () => Promise.resolve();
  native.photoCalls.length = 0;
  native.photoImpl = () => Promise.resolve({ base64String: btoa("\xff\xd8\xff\xe0"), format: "jpeg" });
  native.pickCalls.length = 0;
  native.pickImpl = () => Promise.resolve({ photos: [] });
  info = { has_pin: false, staff_name: "Freja Nielsen", role: "server", restaurant_name: "Café Solsikke", restaurant_address: "Nørrebrogade 52", restaurant_city: "København N" };
  shifts = [
    { id: "w1", date: WED, start_time: "10:00", end_time: "16:00", status: "published", net_hours: 5.5, break_minutes: 30, role_on_shift: "Tjener", branch_name: "Hovedafdeling", branch_address: "Vesterbrogade 1" },
    { id: "t1", date: THU, start_time: "16:00", end_time: "22:00", status: "published", net_hours: 5.5, break_minutes: 30, role_on_shift: "Tjener" },
  ];
  clockImpl = () => ok({ clocked_in: false, geofence_on: false, locked: false });
  extraGet = {};
  postImpl = () => ok({});
  window.open = vi.fn(() => ({}));
});

afterEach(() => {
  vi.useRealTimers();
  delete window.navigator.userAgent;
  delete window.navigator.clipboard;
  delete window.navigator.share;
  delete window.navigator.canShare;
  if (realGeo) Object.defineProperty(window.navigator, "geolocation", realGeo);
  else delete window.navigator.geolocation;
  window.open = realOpen;
  URL.createObjectURL = realCreateObjectURL;
  asWeb();
});

async function openShiftMenu() {
  fireEvent.click(await screen.findByRole("button", { name: "Flere valg for vagten" }));
  return screen.findByTestId("portal-shift-menu");
}
const menuGone = () => waitFor(() => expect(screen.queryByTestId("portal-shift-menu")).toBeNull());

describe("Tilføj til kalender", () => {
  it("desktop browser: webcal:, as before — no Google, no copy row; flagged; the sheet closes", async () => {
    await mount();
    const sheet = await openShiftMenu();
    const row = within(sheet).getByTestId("portal-menu-calendar");
    expect(row.textContent).toContain("Synkroniseres automatisk");
    expect(within(sheet).queryByTestId("portal-menu-calendar-copy")).toBeNull();
    await act(async () => { fireEvent.click(row); });
    expect(window.open).toHaveBeenCalledTimes(1);
    expect(window.open).toHaveBeenCalledWith(`webcal://api.bonbox.dk/api/portal/${TOK}/schedule.ics`, "_blank", "noopener");
    expect(native.browserCalls).toHaveLength(0);
    expect(localStorage.getItem(`bb_cal_${TOK8}`)).toBe("1");
    await menuGone();
  });

  it("the iPhone app: the same webcal: open, the same hint, no copy row", async () => {
    asIOSApp();
    await mount();
    const sheet = await openShiftMenu();
    expect(within(sheet).getByTestId("portal-menu-calendar").textContent).toContain("Synkroniseres automatisk");
    expect(within(sheet).queryByTestId("portal-menu-calendar-copy")).toBeNull();
    await act(async () => { fireEvent.click(within(sheet).getByTestId("portal-menu-calendar")); });
    expect(window.open).toHaveBeenCalledWith(`webcal://api.bonbox.dk/api/portal/${TOK}/schedule.ics`, "_blank", "noopener");
    expect(native.browserCalls).toHaveLength(0);
    expect(localStorage.getItem(`bb_cal_${TOK8}`)).toBe("1");
  });

  it("Chrome on Android: opens Google Calendar's add page in a new tab, flags it under its own key, closes", async () => {
    setUA(PIXEL);
    await mount();
    const sheet = await openShiftMenu();
    const row = within(sheet).getByTestId("portal-menu-calendar");
    expect(row.textContent).toContain("Åbner Google Kalender");
    expect(within(sheet).getByTestId("portal-menu-calendar-copy").textContent).toContain("Kopiér kalenderlink");
    await act(async () => { fireEvent.click(row); });
    expect(window.open).toHaveBeenCalledTimes(1);
    // No "noopener" feature: with it window.open answers null even on success.
    expect(window.open.mock.calls[0]).toEqual([GOOGLE, "_blank"]);
    expect(native.browserCalls).toHaveLength(0);
    expect(localStorage.getItem(`bb_cal_g_${TOK8}`)).toBe("1");
    expect(localStorage.getItem(`bb_cal_${TOK8}`)).toBeNull();
    await menuGone();
  });

  it("Chrome on Android, the tab did not open: the sheet stays and says so; nothing is flagged", async () => {
    setUA(PIXEL);
    window.open = vi.fn(() => null);
    await mount();
    const sheet = await openShiftMenu();
    await act(async () => { fireEvent.click(within(sheet).getByTestId("portal-menu-calendar")); });
    expect(within(screen.getByTestId("portal-shift-menu")).getByTestId("portal-menu-calendar").textContent)
      .toContain("Google Kalender åbnede ikke. Kopiér linket i stedet.");
    expect(localStorage.getItem(`bb_cal_g_${TOK8}`)).toBeNull();
  });

  it("the Android app: Browser.open (a Custom Tab, outside the WebView), never window.open; flagged", async () => {
    asAndroidApp();
    await mount();
    const sheet = await openShiftMenu();
    expect(within(sheet).getByTestId("portal-menu-calendar").textContent).toContain("Åbner Google Kalender");
    await act(async () => { fireEvent.click(within(sheet).getByTestId("portal-menu-calendar")); });
    expect(native.browserCalls).toEqual([{ url: GOOGLE }]);
    expect(window.open).not.toHaveBeenCalled();
    expect(localStorage.getItem(`bb_cal_g_${TOK8}`)).toBe("1");
    await menuGone();
    // Reopened: the hint stays conditional — never a claim it worked.
    const again = await openShiftMenu();
    expect(within(again).getByTestId("portal-menu-calendar").textContent)
      .toContain("Har du abonneret, opdaterer din kalender sig allerede selv");
  });

  it("the Android app, Browser.open refused: the failed hint, nothing flagged", async () => {
    asAndroidApp();
    native.browserImpl = () => Promise.reject(new Error("No Activity found to handle Intent"));
    await mount();
    const sheet = await openShiftMenu();
    await act(async () => { fireEvent.click(within(sheet).getByTestId("portal-menu-calendar")); });
    await waitFor(() => expect(within(screen.getByTestId("portal-shift-menu")).getByTestId("portal-menu-calendar").textContent)
      .toContain("Google Kalender åbnede ikke"));
    expect(localStorage.getItem(`bb_cal_g_${TOK8}`)).toBeNull();
  });

  it("Kopiér kalenderlink: the https feed (with a PIN link's key) on the clipboard; the sheet stays to confirm", async () => {
    asAndroidApp();
    info = { ...info, calendar_key: "k1" };
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText } });
    await mount();
    const sheet = await openShiftMenu();
    const copy = within(sheet).getByTestId("portal-menu-calendar-copy");
    expect(copy.textContent).toContain("Til andre kalendere eller Google Kalender på en computer");
    await act(async () => { fireEvent.click(copy); });
    expect(writeText).toHaveBeenCalledWith(`${FEED}?k=k1`);
    expect(screen.getByTestId("portal-menu-calendar-copy").textContent).toContain("Kopieret. Linket er personligt – kun til din kalender.");
    expect(screen.getByTestId("portal-shift-menu")).toBeInTheDocument();
    // The Google link carries the same key inside cid.
    await act(async () => { fireEvent.click(within(screen.getByTestId("portal-shift-menu")).getByTestId("portal-menu-calendar")); });
    expect(new URL(native.browserCalls[0].url).searchParams.get("cid")).toBe(`webcal://api.bonbox.dk/api/portal/${TOK}/schedule.ics?k=k1`);
  });

  it("a failed copy says so", async () => {
    setUA(PIXEL);
    Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("denied")) } });
    const realExec = document.execCommand;
    document.execCommand = () => false;
    try {
      await mount();
      const sheet = await openShiftMenu();
      await act(async () => { fireEvent.click(within(sheet).getByTestId("portal-menu-calendar-copy")); });
      expect(screen.getByTestId("portal-menu-calendar-copy").textContent).toContain("Linket kunne ikke kopieres.");
    } finally {
      document.execCommand = realExec;
    }
  });

  it("an old webcal: flag on Android (a tap that opened nothing) is not read as subscribed", async () => {
    asAndroidApp();
    localStorage.setItem(`bb_cal_${TOK8}`, "1");
    await mount();
    const sheet = await openShiftMenu();
    expect(within(sheet).getByTestId("portal-menu-calendar").textContent).toContain("Åbner Google Kalender");
  });

  it("English: the Android rows speak English", async () => {
    asAndroidApp();
    await mount("en");
    fireEvent.click(await screen.findByRole("button", { name: "More options for this shift" }));
    const sheet = await screen.findByTestId("portal-shift-menu");
    expect(within(sheet).getByTestId("portal-menu-calendar").textContent).toContain(en.portalCalendarRowHintAndroid);
    expect(within(sheet).getByTestId("portal-menu-calendar-copy").textContent).toContain(en.portalCalendarCopyLink);
  });
});

describe("Kontrakt og dokumenter", () => {
  const DOC = { id: "d1", label: "Ansættelseskontrakt" };
  const openDocs = async (lang = "da") => {
    fireEvent.click(screen.getByTitle(lang === "da" ? "Rediger profil" : "Edit profile"));
    const entry = await screen.findByText(lang === "da" ? "Kontrakt og dokumenter" : "Contract & documents");
    fireEvent.click(entry.closest("button"));
    return screen.findByRole("dialog", { name: lang === "da" ? "Kontrakt og dokumenter" : "Contract & documents" });
  };
  beforeEach(() => {
    extraGet["/documents"] = () => ok([DOC]);
    extraGet["/documents/d1"] = () => ok(new Blob(["%PDF-1.4"], { type: "application/pdf" }));
  });
  const docGets = () => get.mock.calls.filter(([u]) => u === `/portal/${TOK}/documents/d1`);

  it("the Android app: the names and one honest line — no download button, no 'Prøv igen', no fetch", async () => {
    asAndroidApp();
    await mount();
    const sheet = await openDocs();
    expect(within(sheet).getByTestId("portal-docs-app-cant-save").textContent).toBe(
      "Du kan hente dokumenterne i en browser: Bed din leder om dit personlige link, og åbn det dér. Eller bed om selve filen. Appen kan ikke gemme filer på telefonen.",
    );
    expect(within(sheet).getByText("Ansættelseskontrakt")).toBeInTheDocument();
    expect(within(sheet).queryByRole("button", { name: "Ansættelseskontrakt" })).toBeNull();
    fireEvent.click(within(sheet).getByText("Ansættelseskontrakt"));
    expect(docGets()).toHaveLength(0);
    expect(sheet.textContent).not.toContain("Prøv igen");
  });

  it("English: the same note in English", async () => {
    asAndroidApp();
    await mount("en");
    const sheet = await openDocs("en");
    expect(within(sheet).getByTestId("portal-docs-app-cant-save").textContent).toBe(en.portalDocsAppCantSave);
  });

  it("a browser (Chrome on Android too): the download button, as before", async () => {
    setUA(PIXEL);
    URL.createObjectURL = vi.fn(() => "blob:doc");
    await mount();
    const sheet = await openDocs();
    expect(within(sheet).queryByTestId("portal-docs-app-cant-save")).toBeNull();
    const btn = within(sheet).getByRole("button", { name: "Ansættelseskontrakt" });
    await act(async () => { fireEvent.click(btn); });
    expect(docGets()).toEqual([[`/portal/${TOK}/documents/d1`, { responseType: "blob" }]]);
    expect(URL.createObjectURL).toHaveBeenCalled();
  });

  it("the iPhone app (it can share a file): the button, as before", async () => {
    asIOSApp();
    Object.defineProperty(window.navigator, "share", { configurable: true, value: () => Promise.resolve() });
    Object.defineProperty(window.navigator, "canShare", { configurable: true, value: () => true });
    await mount();
    const sheet = await openDocs();
    expect(within(sheet).getByRole("button", { name: "Ansættelseskontrakt" })).toBeInTheDocument();
    expect(within(sheet).queryByTestId("portal-docs-app-cant-save")).toBeNull();
  });
});

describe("Mind mig om vagt", () => {
  beforeEach(() => { extraGet["/reminder"] = () => ok({ minutes: 60 }); });
  const openProfile = async () => {
    fireEvent.click(screen.getByTitle("Rediger profil"));
    await screen.findByText("Kontrakt og dokumenter");
  };
  const reminderGets = () => get.mock.calls.filter(([u]) => u === `/portal/${TOK}/reminder`);

  it("the Android app: not offered (no push there), and not even asked for", async () => {
    asAndroidApp();
    await mount();
    await openProfile();
    expect(document.body.textContent).not.toContain("Mind mig om vagt");
    expect(screen.queryByRole("button", { name: "1 time" })).toBeNull();
    expect(reminderGets()).toHaveLength(0);
  });

  it("Chrome on Android keeps it (Web Push delivers there)", async () => {
    setUA(PIXEL);
    await mount();
    await openProfile();
    expect(await screen.findByRole("button", { name: "1 time" })).toBeInTheDocument();
    expect(reminderGets()).toHaveLength(1);
  });
});

describe("The branch link in the week", () => {
  const link = async () => (await screen.findAllByTestId("portal-week-branch-map"))[0];

  it("a desktop browser: Apple Maps, as before", async () => {
    await mount();
    const a = await link();
    expect(a.getAttribute("href")).toBe("https://maps.apple.com/?q=Hovedafdeling%2C%20Vesterbrogade%201");
    expect(a.getAttribute("target")).toBe("_blank");
  });

  it("Chrome on Android and the Android app: Google Maps", async () => {
    setUA(PIXEL);
    await mount();
    expect((await link()).getAttribute("href")).toBe("https://www.google.com/maps/search/?api=1&query=Hovedafdeling%2C%20Vesterbrogade%201");
  });

  it("the Android app: Google Maps, opened outside the app (target _blank)", async () => {
    asAndroidApp();
    await mount();
    const a = await link();
    expect(a.getAttribute("href")).toBe("https://www.google.com/maps/search/?api=1&query=Hovedafdeling%2C%20Vesterbrogade%201");
    expect(a.getAttribute("target")).toBe("_blank");
  });

  it("the iPhone app: Apple Maps", async () => {
    asIOSApp();
    await mount();
    expect((await link()).getAttribute("href")).toBe("https://maps.apple.com/?q=Hovedafdeling%2C%20Vesterbrogade%201");
  });
});

describe("A punch without location says how to fix it — on each phone", () => {
  async function punchWithoutFix() {
    at(12, 0);
    shifts = [{ id: "now", date: WED, start_time: "11:00", end_time: "14:00", status: "published", net_hours: 3 }];
    clockImpl = () => ok({ geofence_on: true, clocked_in: false, locked: false });
    postImpl = (url) => (url.endsWith("/clock-in") ? ok({ geofence_on: true, clocked_in: true, elapsed_sec: 0 }) : ok({}));
    Object.defineProperty(window.navigator, "geolocation", {
      configurable: true,
      value: { getCurrentPosition: (_ok, fail) => fail({ code: 1 }) },
    });
    await mount();
    const btn = await screen.findByRole("button", { name: /Stempl ind/ });
    await act(async () => { fireEvent.click(btn); });
    await waitFor(() => expect(document.body.textContent).toContain("Sådan retter du det"));
    return document.body.textContent;
  }

  // Stock Android's own Danish words (Settings, PermissionController, framework
  // on the API 37 image): "Lokation", "Tillad kun, mens appen er i brug".
  it("the Android app: Settings → Apps → BonBox Vagtplan → Tilladelser → Lokation", async () => {
    asAndroidApp();
    const text = await punchWithoutFix();
    expect(text).toContain("Indstillinger → Apps → BonBox Vagtplan → Tilladelser → Lokation → Tillad kun, mens appen er i brug.");
    expect(text).not.toContain("Indstillinger → Vagtplan → Lokalitet");
  });

  // Chrome's own Danish words: "Tilladelser", "Placering".
  it("Chrome on Android: the icon by the address bar", async () => {
    setUA(PIXEL);
    const text = await punchWithoutFix();
    expect(text).toContain("tryk på ikonet ved adressefeltet → Tilladelser → slå Placering til");
  });

  it("the staff link installed to an Android home screen: no address bar, so the web line", async () => {
    setUA(PIXEL);
    const mm = window.matchMedia;
    window.matchMedia = (q) => ({
      matches: q === "(display-mode: standalone)",
      media: q, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {},
    });
    try {
      const text = await punchWithoutFix();
      expect(text).not.toContain("adressefeltet");
      expect(text).toContain("tillad lokalitet for denne side i din browser");
    } finally {
      window.matchMedia = mm;
    }
  });

  it("a desktop browser: the web line, as before", async () => {
    const text = await punchWithoutFix();
    expect(text).toContain("tillad lokalitet for denne side i din browser");
  });

  it("the iPhone app: the iOS Settings path, as before", async () => {
    asIOSApp();
    const text = await punchWithoutFix();
    expect(text).toContain("Indstillinger → Vagtplan → Lokalitet → Når appen er i brug.");
  });
});

describe("Chat photo in the Android app", () => {
  async function openThread() {
    await mount();
    fireEvent.click(within(screen.getByTestId("portal-tabbar-v3")).getByText("Beskeder").closest("button"));
    fireEvent.click(await screen.findByText("Café Solsikke", { selector: "button *" }));
    return screen.findByTestId("portal-chat-composer");
  }
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    URL.createObjectURL = vi.fn(() => "blob:photo");
    // The photo picker's files, served from the app's own origin (webPath).
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob([new Uint8Array([0xff, 0xd8])], { type: "image/jpeg" })) }));
  });
  afterEach(() => { globalThis.fetch = realFetch; });
  const picked = (n) => ({ photos: Array.from({ length: n }, (_, i) => ({ webPath: `http://localhost/_capacitor_file_/p${i}.jpg`, format: "jpeg" })) });
  const tapAttach = async (composer) => { await act(async () => { fireEvent.click(within(composer).getByTestId("chat-photo-attach")); }); };
  const sheet = () => screen.getByTestId("portal-chat-photo-sheet");

  it("the photo button asks: take a photo, or choose photos (up to 3) — nothing native opens yet", async () => {
    asAndroidApp();
    const composer = await openThread();
    const btn = within(composer).getByTestId("chat-photo-attach");
    expect(btn.tagName).toBe("BUTTON");
    await tapAttach(composer);
    expect(sheet().getAttribute("aria-label")).toBe("Tilføj billede");
    expect(within(sheet()).getByTestId("portal-chat-photo-take").textContent).toBe("Tag et billede");
    expect(within(sheet()).getByTestId("portal-chat-photo-choose").textContent).toBe("Vælg billederOp til 3 billeder");
    expect(native.photoCalls).toHaveLength(0);
    expect(native.pickCalls).toHaveLength(0);
  });

  it("Vælg billeder: the photo picker, limited to 3; two chosen = two thumbnails at once", async () => {
    asAndroidApp();
    native.pickImpl = () => Promise.resolve(picked(2));
    const composer = await openThread();
    await tapAttach(composer);
    await act(async () => { fireEvent.click(within(sheet()).getByTestId("portal-chat-photo-choose")); });
    expect(native.pickCalls).toHaveLength(1);
    expect(native.pickCalls[0]).toMatchObject({ limit: 3, width: 1600, height: 1600 });
    expect(native.photoCalls).toHaveLength(0);
    await waitFor(() => expect(composer.querySelectorAll("img")).toHaveLength(2));
    await waitFor(() => expect(screen.queryByTestId("portal-chat-photo-sheet")).toBeNull());
    // One slot left: the sheet says "Vælg et billede", and that is the
    // single-photo picker.
    await tapAttach(composer);
    expect(within(sheet()).getByTestId("portal-chat-photo-choose").textContent).toBe("Vælg et billede");
    await act(async () => { fireEvent.click(within(sheet()).getByTestId("portal-chat-photo-choose")); });
    expect(native.pickCalls).toHaveLength(1);
    expect(native.photoCalls[0]).toMatchObject({ source: "PHOTOS" });
    await waitFor(() => expect(composer.querySelectorAll("img")).toHaveLength(3));
    // Full: the button is off; removing one opens a slot again.
    expect(within(composer).getByTestId("chat-photo-attach").disabled).toBe(true);
    fireEvent.click(within(composer).getAllByTestId("chat-photo-remove")[0]);
    expect(composer.querySelectorAll("img")).toHaveLength(2);
    expect(within(composer).getByTestId("chat-photo-attach").disabled).toBe(false);
  });

  it("Tag et billede: the camera, one photo, staged", async () => {
    asAndroidApp();
    const composer = await openThread();
    await tapAttach(composer);
    await act(async () => { fireEvent.click(within(sheet()).getByTestId("portal-chat-photo-take")); });
    expect(native.photoCalls).toHaveLength(1);
    expect(native.photoCalls[0]).toMatchObject({ source: "CAMERA", saveToGallery: false });
    expect(native.pickCalls).toHaveLength(0);
    await waitFor(() => expect(composer.querySelectorAll("img")).toHaveLength(1));
    expect(within(composer).queryByTestId("portal-chat-photo-note")).toBeNull();
  });

  it("English: Take a photo / Choose photos · Up to 3 photos", async () => {
    asAndroidApp();
    localStorage.setItem("lang", "en");
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
    await waitFor(() => expect(screen.getByTitle("Edit profile")).toBeInTheDocument());
    fireEvent.click(within(screen.getByTestId("portal-tabbar-v3")).getByText("Messages").closest("button"));
    fireEvent.click(await screen.findByText("Café Solsikke", { selector: "button *" }));
    const composer = await screen.findByTestId("portal-chat-composer");
    await tapAttach(composer);
    expect(sheet().getAttribute("aria-label")).toBe(en.staffChatAddPhoto);
    expect(within(sheet()).getByTestId("portal-chat-photo-take").textContent).toBe(en.portalPhotoTake);
    expect(within(sheet()).getByTestId("portal-chat-photo-choose").textContent).toBe(`${en.portalPhotoChooseMany}Up to 3 photos`);
  });

  it("a refused camera is said under the composer; nothing is staged", async () => {
    asAndroidApp();
    native.photoImpl = () => Promise.reject(new Error("User denied access to camera"));
    const composer = await openThread();
    await tapAttach(composer);
    await act(async () => { fireEvent.click(within(sheet()).getByTestId("portal-chat-photo-take")); });
    expect((await within(composer).findByTestId("portal-chat-photo-note")).textContent).toBe(
      "Appen må ikke bruge kameraet. Giv adgang i Indstillinger → Apps → BonBox Vagtplan → Tilladelser → Kamera, eller vælg et billede i stedet.",
    );
    expect(composer.querySelectorAll("img")).toHaveLength(0);
  });

  it("a picked photo that cannot be read: 'Kunne ikke tilføje billedet', nothing staged", async () => {
    asAndroidApp();
    native.pickImpl = () => Promise.resolve(picked(2));
    globalThis.fetch = vi.fn(() => Promise.resolve({ ok: false, status: 404, blob: () => Promise.resolve(new Blob([])) }));
    const composer = await openThread();
    await tapAttach(composer);
    await act(async () => { fireEvent.click(within(sheet()).getByTestId("portal-chat-photo-choose")); });
    expect((await within(composer).findByTestId("portal-chat-photo-note")).textContent).toBe("Kunne ikke tilføje billedet. Prøv igen.");
    expect(composer.querySelectorAll("img")).toHaveLength(0);
  });

  it("closing the sheet, or cancelling the picker or the camera, adds nothing and says nothing", async () => {
    asAndroidApp();
    native.photoImpl = () => Promise.reject(new Error("User cancelled photos app"));
    native.pickImpl = () => Promise.reject(new Error("User cancelled photos app"));
    const composer = await openThread();
    // The × (the scrim and Android BACK do the same).
    await tapAttach(composer);
    await act(async () => { fireEvent.click(within(sheet()).getByRole("button", { name: "Luk" })); });
    await waitFor(() => expect(screen.queryByTestId("portal-chat-photo-sheet")).toBeNull());
    expect(native.photoCalls).toHaveLength(0);
    expect(native.pickCalls).toHaveLength(0);
    // The picker, then the camera, closed without a photo.
    await tapAttach(composer);
    await act(async () => { fireEvent.click(within(sheet()).getByTestId("portal-chat-photo-choose")); });
    await waitFor(() => expect(screen.queryByTestId("portal-chat-photo-sheet")).toBeNull());
    await tapAttach(composer);
    await act(async () => { fireEvent.click(within(sheet()).getByTestId("portal-chat-photo-take")); });
    expect(native.pickCalls).toHaveLength(1);
    expect(native.photoCalls).toHaveLength(1);
    expect(composer.querySelectorAll("img")).toHaveLength(0);
    expect(within(composer).queryByTestId("portal-chat-photo-note")).toBeNull();
  });

  // Review of 4724866a (12 Nov 2026): BACK was only said to do what the ×
  // does. It is run here: the sheet's scrim (a fixed z-60 layer, portaled
  // after the thread) is the top-most way out, so BACK closes the sheet and
  // not the thread under it.
  it("Android BACK closes the sheet like its ×: the thread stays, nothing is staged, nothing native opens", async () => {
    asAndroidApp();
    const composer = await openThread();
    await tapAttach(composer);
    expect(sheet()).toBeTruthy();
    const { App } = await import("@capacitor/app");
    // This page's own BACK listener (the last one registered).
    const back = App.addListener.mock.calls.filter(([name]) => name === "backButton").at(-1)[1];
    // jsdom has no layout: every element counts as on screen for BACK.
    const realRects = Element.prototype.getClientRects;
    Element.prototype.getClientRects = function rects() { return [{ width: 1, height: 1 }]; };
    try {
      await act(async () => { back({ canGoBack: false }); });
      await waitFor(() => expect(screen.queryByTestId("portal-chat-photo-sheet")).toBeNull());
    } finally {
      Element.prototype.getClientRects = realRects;
    }
    // The thread is still open, with the same composer, nothing in it.
    expect(screen.getByTestId("portal-chat-composer")).toBe(composer);
    expect(composer.querySelectorAll("img")).toHaveLength(0);
    expect(within(composer).queryByTestId("portal-chat-photo-note")).toBeNull();
    expect(native.photoCalls).toHaveLength(0);
    expect(native.pickCalls).toHaveLength(0);
    // And the photo button works again afterwards.
    await tapAttach(composer);
    expect(sheet()).toBeTruthy();
  });

  it("browsers and the iPhone keep the multi-file input — no sheet", async () => {
    asIOSApp();
    const composer = await openThread();
    const attach = within(composer).getByTestId("chat-photo-attach");
    expect(attach.tagName).toBe("LABEL");
    expect(attach.querySelector('input[type="file"]').multiple).toBe(true);
    fireEvent.click(attach);
    expect(screen.queryByTestId("portal-chat-photo-sheet")).toBeNull();
    expect(native.photoCalls).toHaveLength(0);
    expect(native.pickCalls).toHaveLength(0);
  });
});

describe("The dock at large text", () => {
  // jsdom has no layout: each dock name measures 50 px wide; at the phone's
  // large text "Beskeder" needs 56 (it ellipsized to "Besked…").
  let need = {};
  beforeEach(() => {
    need = {};
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get() { return this.classList.contains("vp-dock-label") ? 50 : 0; },
    });
    Object.defineProperty(HTMLElement.prototype, "scrollWidth", {
      configurable: true,
      get() { return this.classList.contains("vp-dock-label") ? (need[this.textContent] ?? 40) : 0; },
    });
  });
  afterEach(() => {
    delete HTMLElement.prototype.clientWidth;
    delete HTMLElement.prototype.scrollWidth;
  });
  const dock = () => screen.getByTestId("portal-tabbar-v3");

  it("normal text: nothing is set, the names stay 11 px", async () => {
    await mount();
    expect(dock().style.getPropertyValue("--vp-dock-fs")).toBe("");
  });

  it("one name too wide: all five share the size it needs (no ellipsis)", async () => {
    need = { Beskeder: 56 };
    await mount();
    const want = Math.floor(11 * (46 / 52) * 0.97 * 10) / 10;
    await waitFor(() => expect(dock().style.getPropertyValue("--vp-dock-fs")).toBe(`${want}px`));
    // Every label keeps its one-line style; the size comes from the nav.
    for (const label of dock().querySelectorAll(".vp-dock-label")) {
      expect(label.style.whiteSpace).toBe("nowrap");
    }
  });

  it("re-measured when the language changes", async () => {
    need = { Messages: 60 };
    await mount();
    expect(dock().style.getPropertyValue("--vp-dock-fs")).toBe("");
    fireEvent.click(screen.getByTitle("Rediger profil"));
    fireEvent.click(await screen.findByRole("button", { name: "EN" }));
    await waitFor(() => expect(dock().style.getPropertyValue("--vp-dock-fs")).toBe(`${Math.floor(11 * (46 / 56) * 0.97 * 10) / 10}px`));
  });
});
