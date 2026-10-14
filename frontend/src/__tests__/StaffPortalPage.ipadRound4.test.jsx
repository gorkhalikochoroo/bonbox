/**
 * BonBox Vagtplan — round 4 of the iPad pass (design QA + review round 3
 * findings), pinned on the REAL page against a mocked portalApi.
 *
 *   • Install card on iPadOS Safari's desktop-class (Macintosh) UA: the App
 *     Store button and the Share steps, not "open this in Chrome or Safari".
 *   • Sheets answer the keyboard (Esc, focus in, Tab stays in) and have a
 *     visible way out on iPad; the Kan ikke confirms look like useConfirm.
 *   • 44 px: the Hele dagen switch (and the push reminder switch).
 *   • Nyt: a failed read is not "Ingen notifikationer endnu".
 *   • Swap cards read from the reader's side; curly quotes.
 *   • Messages split: a wider list, the name has its own line.
 *   • Smaller ones: week header role, avatar overlap, hero eyebrow while the
 *     shift runs, valgfri, empty states, profile heading, hover, Split View
 *     tab bar, flat green, wrapped "Med …" rows, cookie banner, 320 px day
 *     reveal, colleagues by shift id, no /chat/unread poll on a phone.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tokr4";
const ok = (data) => Promise.resolve({ data });
const fail = (status = 500) => {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: {} };
  return Promise.reject(e);
};
const iso = (d) => d.toLocaleDateString("sv-SE");
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return iso(d);
};
const TODAY = inDays(0);

let api;
function freshApi() {
  return {
    staffName: "Mads Holm",
    threads: [
      { thread_id: "own-1", kind: "direct", title: "Café Nordlys", member_count: 2, last_body: "Kan du tage fredag?", unread: 1, last_message_at: new Date().toISOString() },
      { thread_id: "grp-1", kind: "group", title: "Køkken + sal", member_count: 3, last_body: "Dagens suppe", unread: 1, last_message_at: new Date().toISOString() },
    ],
    schedule: [{ id: "s1", date: TODAY, start_time: "14:00", end_time: "20:00", status: "published", net_hours: 5.5 }],
    team: [],
    hours: { period_start: inDays(-10), period_end: inDays(10), total_hours: 11, entries: [] },
    availability: [],
    swaps: [],
    notifications: () => ok({ notifications: [] }),
    colleagues: [],
  };
}

const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) {
    return ok({ has_pin: false, staff_name: api.staffName, restaurant_name: "Café Nordlys", role: "server" });
  }
  if (url.startsWith(`/portal/${TOK}/schedule`)) return ok({ shifts: api.schedule });
  if (url.startsWith(`/portal/${TOK}/team-schedule`)) return ok(api.team);
  if (url.startsWith(`/portal/${TOK}/hours`)) return ok(api.hours);
  if (url.includes("/notifications")) return api.notifications();
  if (url.endsWith("/chat/unread")) return ok({ unread: api.threads.reduce((a, th) => a + (th.unread || 0), 0) });
  if (url.endsWith("/chat/colleagues")) return ok({ colleagues: api.colleagues });
  if (url.endsWith("/availability")) return ok({ availability: api.availability });
  if (url.endsWith("/give-aways")) return ok([]);
  if (url.endsWith("/swap-requests")) return ok(api.swaps);
  if (url.endsWith("/bank")) return ok({ has_bank: false });
  if (url === `/portal/${TOK}/chat/threads`) return ok({ threads: api.threads.map((th) => ({ ...th })) });
  if (url.startsWith(`/portal/${TOK}/chat/threads/`)) {
    const id = url.split("/").pop();
    const th = api.threads.find((x) => x.thread_id === id);
    if (th) th.unread = 0;
    return ok({ thread_id: id, kind: th?.kind, title: th?.title, member_ids: [], messages: [{ id: "m1", sender_type: "owner", mine: false, body: "Hej", created_at: new Date().toISOString() }] });
  }
  return ok([]);
});

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(() => ok({})), put: vi.fn(() => ok({})), delete: vi.fn(() => ok({})), defaults: { baseURL: "" } },
  storePinProof: vi.fn(),
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(() => Promise.resolve()),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: Object.assign(vi.fn(), { warning: vi.fn(), success: vi.fn(), error: vi.fn(), light: vi.fn() }) }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");
const { PAD_QUERY, PAD_WIDE_QUERY } = await import("../lib/padLayout");
const { shiftHasStarted } = await import("../utils/nextShiftCountdown");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "pages", "StaffPortalPage.jsx"), "utf8");
const JOIN = readFileSync(join(HERE, "..", "pages", "JoinPage.jsx"), "utf8");
const COOKIE = readFileSync(join(HERE, "..", "components", "CookieConsent.jsx"), "utf8");
const DA = readFileSync(join(HERE, "..", "i18n", "da.js"), "utf8");

function mockMatchMedia(which = []) {
  window.matchMedia = vi.fn((q) => ({
    matches: which.includes(q),
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }));
}

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
const nav = () => document.querySelector("nav");
const navTo = (label) => fireEvent.click(within(nav()).getByText(label).closest("button"));
const settle = (ms = 60) => act(() => new Promise((r) => setTimeout(r, ms)));
const tokens = (el) => (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
const unprefixed = (el) => tokens(el).filter((c) => !c.includes(":"));
const esc = () => fireEvent.keyDown(document.activeElement || document.body, { key: "Escape" });
const tab = (shiftKey = false) => fireEvent.keyDown(document.activeElement || document.body, { key: "Tab", shiftKey });
const unreadCalls = () => get.mock.calls.map(([u]) => u).filter((u) => u.endsWith("/chat/unread")).length;

const UA = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
const TP = Object.getOwnPropertyDescriptor(window.navigator, "maxTouchPoints");
function setDevice(ua, touch) {
  Object.defineProperty(window.navigator, "userAgent", { value: ua, configurable: true });
  Object.defineProperty(window.navigator, "maxTouchPoints", { value: touch, configurable: true });
}

beforeEach(() => {
  localStorage.clear();
  get.mockClear();
  api = freshApi();
  delete window.matchMedia;
});
afterEach(() => {
  delete window.matchMedia;
  if (UA) Object.defineProperty(window.navigator, "userAgent", UA); else delete window.navigator.userAgent;
  if (TP) Object.defineProperty(window.navigator, "maxTouchPoints", TP); else delete window.navigator.maxTouchPoints;
});

// ─── MAJOR: the install card on iPadOS Safari ─────────────────────────────
describe("'Føj til hjemmeskærm' on an iPad in Safari's default desktop-class mode", () => {
  const MAC_SAFARI = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
  it("a Macintosh UA with a touch screen gets the App Store button and the Share steps — not 'open it in Chrome or Safari'", async () => {
    setDevice(MAC_SAFARI, 5);
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    fireEvent.click(await screen.findByText("Føj til hjemmeskærm + notifikationer"));
    const store = await screen.findByText("Hent appen BonBox Vagtplan");
    expect(store.closest("a").getAttribute("href")).toContain("apps.apple.com");
    expect(screen.getByText("Eller føj til hjemmeskærm:")).toBeInTheDocument();
    expect(screen.queryByText(/Ingen installknap\?/)).toBeNull();
  });

  it("a real Mac (no touch screen) still gets the browser-menu hint", async () => {
    setDevice(MAC_SAFARI, 0);
    await mount();
    fireEvent.click(await screen.findByText("Føj til hjemmeskærm + notifikationer"));
    expect(await screen.findByText(/Ingen installknap\?/)).toBeInTheDocument();
    expect(screen.queryByText("Hent appen BonBox Vagtplan")).toBeNull();
  });

  it("the card uses the page's one device check, not its own UA test", () => {
    const card = SRC.slice(SRC.indexOf("function InstallNotifyCard("), SRC.indexOf("function StaffPushOptIn("));
    expect(card).toContain("const isIOS = _isIos();");
    expect(card).not.toMatch(/\/iphone\|ipad\|ipod\/i/);
  });
});

// ─── Sheets: the keyboard, and a visible way out ──────────────────────────
describe("sheets answer the keyboard: Esc closes, focus moves in and stays in", () => {
  async function openPeriodSheet() {
    navTo("Timer");
    const periodBtn = await screen.findByText((_, el) => el?.tagName === "BUTTON" && / – /.test(el.textContent || ""));
    periodBtn.focus();
    fireEvent.click(periodBtn);
    return { trigger: periodBtn, sheet: await screen.findByRole("dialog", { name: "Vælg en periode" }) };
  }

  it("Timer › period: focus lands inside, Tab cycles inside, Esc closes and focus returns to the trigger", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    const { trigger, sheet } = await openPeriodSheet();
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    for (let i = 0; i < 12; i += 1) {
      tab();
      expect(sheet.contains(document.activeElement)).toBe(true);
    }
    tab(true);
    expect(sheet.contains(document.activeElement)).toBe(true);
    esc();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vælg en periode" })).toBeNull());
    expect(document.activeElement).toBe(trigger);
  });

  it("Kan ikke › a day you work: the confirm closes on Esc", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    navTo("Kan ikke");
    const label = new Date().toLocaleDateString("da-DK", { weekday: "long", day: "numeric", month: "long" });
    const cell = await waitFor(() => {
      const b = screen.getAllByRole("button").find((x) => (x.getAttribute("aria-label") || "").startsWith(label));
      if (!b) throw new Error("no strip cell yet");
      return b;
    });
    fireEvent.click(cell);
    const title = await screen.findByText("Du har allerede en vagt den dag");
    const dialog = title.closest('[role="dialog"]');
    await waitFor(() => expect(dialog.contains(document.activeElement)).toBe(true));
    esc();
    await waitFor(() => expect(screen.queryByText("Du har allerede en vagt den dag")).toBeNull());
  });

  it("Beskeder › Ny gruppe and Rediger profil close on Esc", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Beskeder");
    await screen.findByText("Køkken + sal");
    fireEvent.click(screen.getByRole("button", { name: /Ny gruppe/ }));
    const group = await screen.findByRole("dialog", { name: "Ny gruppe" });
    await waitFor(() => expect(group.contains(document.activeElement)).toBe(true));
    esc();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Ny gruppe" })).toBeNull());

    fireEvent.click(screen.getByTitle("Rediger profil"));
    const heading = await screen.findByRole("heading", { name: "Rediger profil" });
    await waitFor(() => expect(heading.closest(".rounded-t-2xl").contains(document.activeElement)).toBe(true));
    esc();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Rediger profil" })).toBeNull());
  });

  it("only the TOPMOST sheet answers Esc: the photo menu over Rediger profil closes alone", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    fireEvent.click(screen.getByTitle("Rediger profil"));
    await screen.findByRole("heading", { name: "Rediger profil" });
    fireEvent.click(screen.getByRole("button", { name: "Tilføj billede" }));
    await screen.findByRole("dialog", { name: "Billede" });
    esc();
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Billede" })).toBeNull());
    expect(screen.getByRole("heading", { name: "Rediger profil" })).toBeInTheDocument();
    esc();
    await waitFor(() => expect(screen.queryByRole("heading", { name: "Rediger profil" })).toBeNull());
  });

  it("every portal sheet and confirm is wired to the keyboard", () => {
    // docs, period, Ny gruppe, the two Kan ikke confirms, profile, photo, department
    expect((SRC.match(/useSheetKeys\(/g) || []).length).toBe(8);
    for (const ref of ["docsPanelRef", "rosteredRef", "weekdayRef", "profilePanelRef", "photoPanelRef", "deptPanelRef"]) {
      expect(SRC).toContain(`ref={${ref}}`);
    }
  });
});

describe("iPad: every sheet has a visible way out; the Kan ikke confirms look like useConfirm", () => {
  it("the period sheet has a 44 × 44 × on iPad (display:none on a phone) that closes it", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    navTo("Timer");
    fireEvent.click(await screen.findByText((_, el) => el?.tagName === "BUTTON" && / – /.test(el.textContent || "")));
    const sheet = await screen.findByRole("dialog", { name: "Vælg en periode" });
    const x = within(sheet).getByTestId("portal-sheet-close");
    expect(unprefixed(x)).toContain("hidden");
    expect(tokens(x)).toEqual(expect.arrayContaining(["pad:inline-flex", "w-11", "h-11"]));
    expect(x.getAttribute("aria-label")).toBe("Luk");
    fireEvent.click(x);
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Vælg en periode" })).toBeNull());
  });

  it("the rostered-day confirm: an icon and an Annuller on iPad, and the phone's two buttons drawn as before", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    navTo("Kan ikke");
    const label = new Date().toLocaleDateString("da-DK", { weekday: "long", day: "numeric", month: "long" });
    fireEvent.click(await waitFor(() => {
      const b = screen.getAllByRole("button").find((x) => (x.getAttribute("aria-label") || "").startsWith(label));
      if (!b) throw new Error("no strip cell yet");
      return b;
    }));
    const dialog = (await screen.findByText("Du har allerede en vagt den dag")).closest('[role="dialog"]');
    const panel = dialog.querySelector(".rounded-t-2xl");
    const icon = panel.querySelector("svg.lucide-circle-question-mark, svg.lucide-help-circle, svg.lucide-circle-help");
    expect(icon).toBeTruthy();
    expect(tokens(icon.parentElement)).toEqual(expect.arrayContaining(["hidden", "pad:inline-flex", "w-10", "h-10", "rounded-full"]));
    const row = within(panel).getByText("Markér alligevel").closest("div");
    // Phone: the two buttons drawn Message | Mark anyway, as before
    // (DOM order is the iPad's: Annuller, Markér alligevel, Skriv til lederen).
    expect(unprefixed(row)).toEqual(["flex", "flex-row-reverse", "gap-2", "pt-1"]);
    expect(tokens(row)).toEqual(expect.arrayContaining(["pad:flex-row", "pad:justify-end"]));
    const [cancel, anyway, message] = [...row.children];
    expect(cancel.textContent).toBe("Annuller");
    expect(unprefixed(cancel)).toContain("hidden");
    expect(anyway.textContent).toBe("Markér alligevel");
    expect(message.textContent).toBe("Skriv til lederen");
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByText("Du har allerede en vagt den dag")).toBeNull());
  });

  it("one dim on iPad: the sheets that had a lighter or unblurred backdrop get the confirm's", () => {
    expect(SRC).toContain('const PAD_DIM = "pad:bg-[#080e16]/50! pad:backdrop-blur-[2px]";');
    // Period, documents, photo, department, Ny gruppe.
    expect((SRC.match(/\$\{PAD_DIM\}/g) || []).length).toBe(5);
    // The confirms and the profile sheet already had it.
    expect((SRC.match(/absolute inset-0 bg-\[#080e16\]\/50 backdrop-blur-\[2px\]/g) || []).length).toBe(3);
  });
});

// ─── 44 px ────────────────────────────────────────────────────────────────
describe("44 px: the Hele dagen switch on iPad", () => {
  it("is a 44 × 44 target around the 44 × 24 track (the row keeps its height); on a phone the button is the track", async () => {
    api.availability = [{ id: "a1", date: inDays(6), weekday: null, kind: "unavailable" }];
    mockMatchMedia([PAD_QUERY]);
    await mount();
    navTo("Kan ikke");
    const row = (await screen.findAllByTestId("kanikke-marked-row"))[0];
    fireEvent.click(row.querySelector("button"));
    const sw = await within(row).findByRole("switch");
    expect(tokens(sw)).toEqual(expect.arrayContaining(["pad:h-11", "pad:-my-2.5"]));
    expect(unprefixed(sw)).not.toContain("h-6");
    const track = sw.firstElementChild;
    expect(tokens(track)).toEqual(expect.arrayContaining(["w-11", "h-6", "rounded-full"]));
  });

  it("the push reminder switch got the same 44 × 44 target", () => {
    const opt = SRC.slice(SRC.indexOf("function StaffPushOptIn("));
    expect(opt).toContain('className="flex-shrink-0 flex disabled:opacity-50 pad:items-center pad:justify-center pad:w-11 pad:h-11 pad:-my-[9.5px] pad:-mx-px"');
  });
});

// ─── Nyt: a failed read is not an empty feed ──────────────────────────────
describe("Nyt says when it could not load, and offers a retry", () => {
  it("a 500 shows 'Kunne ikke hente dine notifikationer' + Prøv igen — not 'Ingen notifikationer endnu'", async () => {
    api.notifications = () => fail(500);
    mockMatchMedia([PAD_QUERY]);
    await mount();
    fireEvent.click(screen.getByTestId("portal-rail-alerts"));
    expect(await screen.findByText("Kunne ikke hente dine notifikationer")).toBeInTheDocument();
    expect(screen.queryByText("Ingen notifikationer endnu")).toBeNull();
    // It recovers.
    api.notifications = () => ok({ notifications: [] });
    fireEvent.click(screen.getByTestId("portal-alerts-retry"));
    expect(await screen.findByText("Ingen notifikationer endnu")).toBeInTheDocument();
    // iPad: the empty state is a card, like Bytte and Timer.
    expect(tokens(screen.getByTestId("portal-alerts-empty"))).toEqual(expect.arrayContaining(["pad:bg-white", "pad:border", "pad:rounded-[20px]"]));
  });
});

// ─── Swaps ────────────────────────────────────────────────────────────────
describe("swap cards read from the reader's side", () => {
  const thu = inDays(8);
  const fri = inDays(9);
  const swap = (direction) => ({
    id: "w1", direction, status: "proposed",
    from_staff_name: "Sofie Dahl", to_staff_name: "Mads Holm",
    from_shift_id: "sf", from_shift_date: thu, from_shift_time: "17:00–22:00",
    to_shift_id: "sm", to_shift_date: fri, to_shift_time: "10:00–16:00",
    reason: "Familiefest",
  });

  it("incoming from Sofie: 'Du giver' is MY shift (fre.), 'Du får' is hers (tor.); the reason in curly quotes", async () => {
    api.swaps = [swap("incoming")];
    await mount();
    navTo("Bytte");
    const shifts = await screen.findByTestId("portal-swap-shifts");
    const [give, getBox] = [...shifts.children];
    expect(give.firstElementChild.textContent).toBe("Du giver");
    expect(give.textContent).toContain("10:00–16:00");
    expect(getBox.firstElementChild.textContent).toBe("Du får");
    expect(getBox.textContent).toContain("17:00–22:00");
    expect(screen.getByText("“Familiefest”")).toBeInTheDocument();
  });

  it("outgoing (I asked): I give mine (from), I get theirs (to)", async () => {
    api.swaps = [{ ...swap("outgoing"), from_staff_name: "Mads Holm", to_staff_name: "Sofie Dahl" }];
    await mount();
    navTo("Bytte");
    const [give, getBox] = [...(await screen.findByTestId("portal-swap-shifts")).children];
    expect(give.textContent).toContain("17:00–22:00");
    expect(getBox.textContent).toContain("10:00–16:00");
  });
});

// ─── Messages ─────────────────────────────────────────────────────────────
describe("Beskeder master-detail: the list is wide enough to read a name", () => {
  it("2/5 of the column (not a fixed 320 px); the name has the first line, the time moves to the preview line", async () => {
    api.threads[1].title = "Weekendholdet i køkkenet og baren — sommer";
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Beskeder");
    const split = await screen.findByTestId("portal-messages-split");
    expect(tokens(split)).toContain("grid-cols-[minmax(320px,2fr)_minmax(0,3fr)]");
    const name = await screen.findByText("Weekendholdet i køkkenet og baren — sommer");
    expect(tokens(name)).toContain("line-clamp-2");
    expect(tokens(name)).not.toContain("truncate");
    const wide = name.closest('[data-testid="portal-thread-row-wide"]');
    expect(wide.children[1].textContent).toMatch(/Dagens suppe/);
    expect(wide.children[1].lastElementChild.textContent).toMatch(/siden|nu/);
  });

  it("a phone keeps the row exactly as it was (name and time on one line)", async () => {
    await mount();
    navTo("Beskeder");
    const name = await screen.findByText("Køkken + sal");
    expect(tokens(name)).toContain("truncate");
    expect(name.closest('[data-testid="portal-thread-row-wide"]')).toBeNull();
  });

  it("the pick pane does not promise groups the staffer may not have", () => {
    expect(DA).toContain("staffChatPickBody: 'Dine samtaler står til venstre. Tryk på en for at læse og svare her.',");
    expect(DA).not.toContain("Din leder og dine grupper står til venstre");
  });

  it("with a trackpad, a thread row responds to hover (the sidebar rows already did)", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Beskeder");
    const row = (await screen.findByText("Køkken + sal")).closest("button");
    expect(tokens(row)).toEqual(expect.arrayContaining(["hover:bg-[#f8fafc]!", "hover:border-[#cbd5e1]!"]));
  });
});

describe("a phone conversation does not poll a count it never shows", () => {
  it("phone: opening a conversation sends no /chat/unread (the badge is hidden on the open tab)", async () => {
    await mount();
    navTo("Beskeder");
    const row = (await screen.findByText("Køkken + sal")).closest("button");
    await settle(30);
    const before = unreadCalls();
    fireEvent.click(row);
    await screen.findByText("Hej");
    await settle(150);
    // It sent one after every conversation read (every 6 s while open).
    expect(unreadCalls()).toBe(before);
    // Leaving the tab reads it at once.
    navTo("Vagtplan");
    await waitFor(() => expect(unreadCalls()).toBeGreaterThan(before));
  });

  it("iPad portrait (the sidebar shows the count): a conversation read still refreshes it", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    navTo("Beskeder");
    await screen.findByText("Køkken + sal");
    const before = unreadCalls();
    fireEvent.click(screen.getByText("Køkken + sal").closest("button"));
    await screen.findByText("Hej");
    await waitFor(() => expect(unreadCalls()).toBeGreaterThan(before));
  });
});

// ─── Schedule ─────────────────────────────────────────────────────────────
describe("Vagtplan: colleagues, the week list, the hero", () => {
  it("a colleague with MY name is shown (own rows are known by shift id, not by name)", async () => {
    api.staffName = "Ali";
    api.schedule = [{ id: "s1", date: TODAY, start_time: "14:00", end_time: "20:00", status: "published", net_hours: 5.5 }];
    api.team = [
      { shift_id: "s1", staff_id: "me", staff_name: "Ali", date: TODAY, start_time: "14:00", end_time: "20:00", role: null },
      { shift_id: "x2", staff_id: "other", staff_name: "Ali", date: TODAY, start_time: "16:00", end_time: "22:00", role: null },
    ];
    await mount();
    const mates = await screen.findByTestId("portal-week-mates");
    expect(within(mates).getByText("Ali")).toBeTruthy();
    expect(screen.queryByText("Alene")).toBeNull();
    expect(screen.queryByText("Du er alene på denne vagt.")).toBeNull();
  });

  it("…and my own second shift that day is still not a colleague (same staff_id)", async () => {
    api.schedule = [
      { id: "a", date: TODAY, start_time: "10:00", end_time: "14:00", status: "published", net_hours: 4 },
      { id: "b", date: TODAY, start_time: "17:00", end_time: "22:00", status: "published", net_hours: 5 },
    ];
    api.team = [
      { shift_id: "a", staff_id: "m", staff_name: "Mads Holm", date: TODAY, start_time: "10:00", end_time: "14:00", role: null },
      { shift_id: "b", staff_id: "m", staff_name: "Mads Holm", date: TODAY, start_time: "17:00", end_time: "22:00", role: null },
      { shift_id: "o", staff_id: "o", staff_name: "Oliver Berg", date: TODAY, start_time: "17:00", end_time: "22:00", role: null },
    ];
    await mount();
    const lines = await screen.findAllByTestId("portal-week-mates");
    for (const l of lines) expect(within(l).queryByText("Mads")).toBeNull();
    expect(within(lines[0]).getByText("Oliver")).toBeTruthy();
  });

  it("the week list's day header no longer repeats the role the shift row already shows", async () => {
    api.schedule = [{ id: "s1", date: TODAY, start_time: "17:00", end_time: "22:00", status: "published", net_hours: 4.5, break_minutes: 30, role_on_shift: "server" }];
    await mount();
    const day = await waitFor(() => {
      const el = document.querySelector(`[data-week-day="${TODAY}"]`);
      if (!el) throw new Error("no week row yet");
      return el;
    });
    const header = day.firstElementChild;
    expect(header.textContent).not.toMatch(/Tjener/);
    expect(within(day).getByTestId("portal-week-row-meta").textContent).toMatch(/^Tjener · 30 min pause$/);
  });

  it("wrapped 'Med …' rows keep a 44 px pitch on a touch screen (a tap on one name never lands on another)", () => {
    const line = SRC.slice(SRC.indexOf('data-testid="portal-week-mates"') - 260, SRC.indexOf('data-testid="portal-week-mates"'));
    expect(line).toContain("pointer-coarse:gap-y-[calc(44px-1lh)]");
    expect(line).toContain("pad:gap-y-[18px]");
    expect(line).not.toContain("pad:gap-y-0.5");
    // The names keep their 44 px boxes, the margins hand the height back.
    expect(SRC).toContain("pointer-coarse:my-[calc((1lh-44px)/2)] pad:no-underline pad:inline-flex pad:items-center pad:justify-center pad:min-w-[44px] pad:min-h-[44px] pad:-my-[9px]!");
  });

  it("the hero's avatars overlap 4 px, so two initials stay whole; iPad windows get the 30 px discs", async () => {
    api.team = [
      { shift_id: "s1", staff_id: "m", staff_name: "Mads Holm", date: TODAY, start_time: "14:00", end_time: "20:00", role: null },
      { shift_id: "o", staff_id: "o", staff_name: "Oliver Berg", date: TODAY, start_time: "14:00", end_time: "20:00", role: null },
      { shift_id: "e", staff_id: "e", staff_name: "Emma Lund", date: TODAY, start_time: "14:00", end_time: "20:00", role: null },
    ];
    await mount();
    const discs = await screen.findAllByTestId("portal-whos-on-avatar");
    expect(discs.map((d) => d.textContent)).toEqual(["OB", "EL"]);
    expect(discs[0].style.marginLeft).toBe("0px");
    expect(discs[1].style.marginLeft).toBe("-4px");
    expect(tokens(discs[1])).toEqual(expect.arrayContaining(["tablet:h-[30px]", "tablet:w-[30px]", "tablet:text-[11.5px]!"]));
  });

  it("a running shift: the eyebrow says 'Din vagt nu' beside 'I gang', not 'Din næste vagt'", async () => {
    api.schedule = [{ id: "s1", date: TODAY, start_time: "00:00", end_time: "23:59", status: "published", net_hours: 23 }];
    await mount();
    expect(await screen.findByText("Din vagt nu")).toBeInTheDocument();
    expect(screen.getByText("I gang")).toBeInTheDocument();
    expect(screen.queryByText("Din næste vagt")).toBeNull();
  });

  it("a shift later on still reads 'Din næste vagt'", async () => {
    api.schedule = [{ id: "s1", date: inDays(2), start_time: "14:00", end_time: "20:00", status: "published", net_hours: 5.5 }];
    await mount();
    expect(await screen.findByText("Din næste vagt")).toBeInTheDocument();
    expect(shiftHasStarted({ date: inDays(2), start_time: "14:00" })).toBe(false);
    expect(shiftHasStarted({ date: inDays(-1), start_time: "14:00" })).toBe(true);
  });
});

describe("a picked day is revealed without scrolling the strip off the top (320 px phone)", () => {
  function geometry(stripTop, row) {
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function rect() {
      if (this.hasAttribute?.("data-week-day")) return { top: row.top, bottom: row.bottom, height: row.bottom - row.top, left: 0, right: 320, width: 320 };
      if (this.querySelector?.(':scope > button[aria-current="date"]')) return { top: stripTop, bottom: stripTop + 60, height: 60, left: 0, right: 320, width: 320 };
      if (this.hasAttribute?.("data-portal-scroller")) return { top: 0, bottom: 568, height: 568, left: 0, right: 320, width: 320 };
      // The sticky header: the kept strip stays 8 px under it.
      if (this.hasAttribute?.("data-portal-header")) return { top: 0, bottom: 92, height: 92, left: 0, right: 320, width: 320 };
      return real.call(this);
    };
    return () => { Element.prototype.getBoundingClientRect = real; };
  }

  it("the row does not fit with the strip: the page scrolls only as far as keeps the strip's top on screen", async () => {
    const innerH = window.innerHeight;
    window.innerHeight = 568;
    const spy = vi.fn();
    const realSIV = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = spy;
    const restore = geometry(150, { top: 420, bottom: 700 });
    try {
      await mount();
      const scroller = document.querySelector("[data-portal-scroller]");
      scroller.scrollBy = vi.fn();
      fireEvent.click(screen.getByTestId("portal-week-card").querySelector('button[aria-current="date"]'));
      await settle(80);
      // 150 − (92 + 8): the strip ends up 8 px under the header, not under it.
      expect(scroller.scrollBy).toHaveBeenCalledWith({ top: 50, behavior: "smooth" });
      expect(spy.mock.contexts.some((el) => el.getAttribute?.("data-week-day") === TODAY)).toBe(false);
    } finally {
      restore();
      Element.prototype.scrollIntoView = realSIV;
      window.innerHeight = innerH;
    }
  });

  it("where both fit (390 px) the row is scrolled fully into view, as before", async () => {
    const innerH = window.innerHeight;
    window.innerHeight = 844;
    const restore = geometry(300, { top: 700, bottom: 900 });
    try {
      await mount();
      const scroller = document.querySelector("[data-portal-scroller]");
      scroller.scrollBy = vi.fn();
      fireEvent.click(screen.getByTestId("portal-week-card").querySelector('button[aria-current="date"]'));
      await settle(80);
      expect(scroller.scrollBy).toHaveBeenCalledWith({ top: 56, behavior: "smooth" });
    } finally {
      restore();
      window.innerHeight = innerH;
    }
  });
});

// ─── Copy ─────────────────────────────────────────────────────────────────
describe("copy", () => {
  it("'valgfri' (en årsag), as everywhere else in the app", () => {
    expect(DA).toContain('portalSwapReasonOptional: "(valgfri)",');
    expect(DA).toContain('portalSickReasonHint: "(valgfri, kun din leder ser det)",');
    expect(DA).not.toMatch(/portal(Swap|Sick)Reason\w*: "\(valgfrit/);
  });
});

// ─── Empty states, spacing, hover, Split View bar, flat green, banner ─────
describe("iPad polish", () => {
  it("Timer: no chart of '0' bars when there are no hours yet", async () => {
    api.hours = { period_start: inDays(-20), period_end: inDays(10), total_hours: 0, entries: [] };
    await mount();
    navTo("Timer");
    await screen.findByText("Efter uge").catch(() => null);
    await settle(60);
    expect(screen.queryAllByTestId("portal-week-bar")).toHaveLength(0);
  });

  it("Timer: the chart is still there when a week has hours", async () => {
    api.hours = { period_start: inDays(-20), period_end: inDays(10), total_hours: 6, entries: [{ date: inDays(-2), total_hours: 6 }] };
    await mount();
    navTo("Timer");
    await waitFor(() => expect(screen.getAllByTestId("portal-week-bar").length).toBeGreaterThan(1));
  });

  it("Rediger profil: 24 px between the dark card and 'Sådan får du besked'", async () => {
    await mount();
    fireEvent.click(screen.getByTitle("Rediger profil"));
    const h = await screen.findByText("Sådan får du besked");
    expect(tokens(h)).toContain("pt-3");
  });

  it("'Tag den' responds to a trackpad's hover", () => {
    const at = SRC.indexOf('t("portalOpenClaim", "Take it")');
    expect(SRC.slice(at - 400, at)).toContain("bg-gray-900 text-white text-[13px] font-medium px-4 hover:bg-gray-700");
  });

  it("Split View: the tab bar shares the 480 px content column", () => {
    expect(SRC).toContain("max-w-lg mx-auto flex justify-around py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] tablet:max-w-[480px] pad:max-w-none");
  });

  it("no gradient-and-glow greens left: + Ny gruppe, Opret gruppe, Send, own bubbles, Tilslut", async () => {
    expect(SRC).not.toMatch(/rgba\(22,163,74,\.9/);
    expect(JOIN).not.toMatch(/rgba\(22,163,74,\.9/);
    expect(JOIN).not.toContain("linear-gradient(180deg,#22c55e,#16a34a)");
    expect(SRC).toContain('const GREEN_FLAT = "#15803d";');
    // Opret gruppe, the + (Ny gruppe) and Send; and your own bubbles.
    expect((SRC.match(/background: GREEN_FLAT,/g) || []).length).toBe(3);
    expect(SRC).toContain('background: m.mine ? GREEN_FLAT : "#fff",');
    expect(SRC).toContain('boxShadow: m.mine ? "none" : "0 1px 2px rgba(15,23,42,.04)",');
  });

  it("every sheet sits above the cookie banner; the revealed form and the composer clear it", () => {
    expect(COOKIE).toContain("fixed z-[60]");
    expect(SRC).toContain('const SHEET_Z = "z-[70]";');
    expect(SRC).not.toMatch(/fixed inset-0 z-(40|50|\[60\])/);
    expect(SRC).toContain("var(--bb-consent-h,0px))] pad:scroll-mt-28");
    expect(SRC).toContain('"calc(3.5rem + env(safe-area-inset-bottom) + var(--bb-consent-h, 0px))"');
  });
});
