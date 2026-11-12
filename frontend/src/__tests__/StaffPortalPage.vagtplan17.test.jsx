/**
 * Vagtplan 1.7 — what the live 1.6 app had, on the home v3 redesign.
 *
 * Vagtplan 1.6 (24) was built from branch vagtplan-1.6, which never reached
 * main. 1.7 ports what still applies (inventory:
 * bonbox-lab-state/design-departments-2026-11-11/ios17-notes/inventory.md).
 * These pin the ported behaviour on the redesign's markup:
 *   • the iPad layout: sidebar instead of the dock, one wider column, Beskeder
 *     as a card (master-detail on a wide iPad), one tree across a rotation;
 *     its CSS and JS breakpoints in step;
 *   • the phone fixes: one Beskeder count (no badge on the open tab, the list
 *     never writes a 0 it did not count), drafts per conversation, a group's
 *     subline, colleagues on my hours, a failed Nyt read, the period sheet on
 *     the period on screen, "timer" and no all-zero chart, iPad device copy.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAD_QUERY, PAD_WIDE_QUERY, TABLET_QUERY } from "../lib/padLayout";
import { sickCallDefaultDate } from "../utils/sickCallDefaultDate";
import { sameShiftTimes } from "../utils/swapClash";

const TOK = "tok17";
const ok = (data) => Promise.resolve({ data });
const iso = (d) => d.toLocaleDateString("sv-SE");
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const reject = (status) => {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data: {} };
  return Promise.reject(e);
};

let data;
const get = vi.fn((url) => {
  const sub = url.slice(`/portal/${TOK}`.length);
  if (sub === "") return ok(data.info);
  if (sub.startsWith("/schedule")) return ok({ shifts: data.shifts });
  if (sub.startsWith("/team-schedule")) return ok(data.team);
  if (sub.startsWith("/notifications")) return data.notifications();
  if (sub === "/chat/unread") return ok({ unread: data.unread });
  if (sub.startsWith("/chat/threads/")) {
    const id = sub.slice("/chat/threads/".length);
    return data.thread(id);
  }
  if (sub.startsWith("/chat/threads")) return ok({ threads: data.threads });
  if (sub.startsWith("/hours")) return ok(data.hours);
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
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })) } }));
vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })), setAccessoryBarVisible: vi.fn(() => Promise.resolve()), setScroll: vi.fn(() => Promise.resolve()), setResizeMode: vi.fn(() => Promise.resolve()) },
  KeyboardResize: { Body: "body", Native: "native", None: "none", Ionic: "ionic" },
}));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");

// ─── A pretend window: matchMedia answers range and min/max queries for a
// width × height, and a resize tells every listener (a rotation). ─────────
const realMatchMedia = window.matchMedia;
let win = { w: 390, h: 844 };
const listeners = new Set();
function evalQuery(q) {
  const parts = q.split(/\s+and\s+/);
  return parts.every((p) => {
    let m = p.match(/\(\s*(width|height)\s*>=\s*(\d+)px\s*\)/);
    if (m) return (m[1] === "width" ? win.w : win.h) >= Number(m[2]);
    m = p.match(/\(\s*(min|max)-(width|height):\s*(\d+(?:\.\d+)?)px\s*\)/);
    if (m) {
      const v = m[2] === "width" ? win.w : win.h;
      return m[1] === "min" ? v >= Number(m[3]) : v <= Number(m[3]);
    }
    return false;
  });
}
function setWindow(w, h) {
  win = { w, h };
  for (const l of listeners) l();
}
beforeEach(() => {
  window.matchMedia = (q) => {
    const mql = {
      media: q,
      get matches() { return evalQuery(q); },
      addEventListener: (_t, fn) => listeners.add(fn),
      removeEventListener: (_t, fn) => listeners.delete(fn),
      addListener: (fn) => listeners.add(fn),
      removeListener: (fn) => listeners.delete(fn),
    };
    return mql;
  };
});
afterEach(() => {
  window.matchMedia = realMatchMedia;
  listeners.clear();
  document.body.classList.remove("portal-shell");
  document.documentElement.removeAttribute("data-vp-rail");
});

async function mount(lang = "da", { w = 390, h = 844 } = {}) {
  win = { w, h };
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
const goPhone = (tab) => fireEvent.click(screen.getByTestId(`portal-tab-${tab}`));
const goPad = (tab) => fireEvent.click(screen.getByTestId(`portal-rail-${tab}`));

const THREAD_OWN = {
  thread_id: "own", kind: "owner", title: "Café Solsikke",
  messages: [
    { id: 1, sender_type: "owner", mine: false, body: "Kan du tage fredag?", created_at: new Date().toISOString() },
  ],
};

beforeEach(() => {
  localStorage.clear();
  get.mockClear();
  post.mockClear();
  data = {
    info: { has_pin: false, staff_name: "Freja M.", role: "Bar", restaurant_name: "Café Solsikke" },
    shifts: [
      { id: "sh-1", date: inDays(1), start_time: "16:00", end_time: "22:00", status: "published", net_hours: 6, role_on_shift: "Bar" },
    ],
    team: [],
    unread: 3,
    notifications: () => ok({ notifications: [] }),
    threads: [
      { thread_id: "own", kind: "owner", title: "Café Solsikke", last_body: "Kan du tage fredag?", last_message_at: new Date().toISOString(), unread: 1 },
      { thread_id: "g1", kind: "group", title: "Køkkenet", last_body: "Tak!", last_sender: "Sofie", last_message_at: new Date().toISOString(), unread: 2, member_count: 4 },
    ],
    thread: (id) => (id === "own" ? ok(THREAD_OWN) : new Promise(() => {})),
    hours: { period_start: inDays(-10), period_end: inDays(10), total_hours: 0, entries: [] },
  };
});

describe("one definition of 'iPad': the stylesheet and the JS agree", () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const css = fs.readFileSync(path.join(HERE, "..", "components", "staff", "vagtplanPad.css"), "utf8");

  it("vagtplanPad.css uses exactly TABLET_QUERY, PAD_QUERY and PAD_WIDE_QUERY (range syntax, height floor 600)", () => {
    const media = [...css.matchAll(/@media ([^{]+)\{/g)].map((m) => m[1].trim());
    expect(media).toEqual([TABLET_QUERY, PAD_QUERY, PAD_WIDE_QUERY]);
    expect(PAD_QUERY).toBe("(width >= 744px) and (height >= 600px)");
    expect(PAD_WIDE_QUERY).toBe("(width >= 1100px) and (height >= 600px)");
  });

  it("a sideways phone is a phone: 932 × 430 matches none; an iPad mini portrait (744 × 1133) is pad, not wide", () => {
    win = { w: 932, h: 430 };
    expect([TABLET_QUERY, PAD_QUERY, PAD_WIDE_QUERY].map(evalQuery)).toEqual([false, false, false]);
    win = { w: 744, h: 1133 };
    expect([PAD_QUERY, PAD_WIDE_QUERY].map(evalQuery)).toEqual([true, false]);
    win = { w: 1024, h: 1366 };
    expect(evalQuery(PAD_WIDE_QUERY)).toBe(false); // 13" portrait keeps one column
    win = { w: 1180, h: 820 };
    expect(evalQuery(PAD_WIDE_QUERY)).toBe(true);
  });

  it("index.css carries no iPad rule, and only the staff pages import the iPad sheet", () => {
    expect(fs.readFileSync(path.join(HERE, "..", "index.css"), "utf8")).not.toMatch(/width >= 744px/);
    const page = fs.readFileSync(path.join(HERE, "..", "pages", "StaffPortalPage.jsx"), "utf8");
    const join = fs.readFileSync(path.join(HERE, "..", "pages", "JoinPage.jsx"), "utf8");
    expect(page).toContain('import "../components/staff/vagtplanPad.css";');
    expect(join).toContain('import "../components/staff/vagtplanPad.css";');
  });
});

describe("phone: unchanged shell, one Beskeder count", () => {
  it("the dock, no sidebar; the Beskeder badge is the server's count away from Beskeder, hidden while it is open, back on leaving", async () => {
    await mount("da");
    expect(screen.getByTestId("portal-tabbar-v3")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-rail")).toBeNull();
    const badge = () => within(screen.getByTestId("portal-tab-messages")).queryByLabelText("Ulæste beskeder");
    await waitFor(() => expect(badge()?.textContent).toBe("3"));
    goPhone("messages");
    await screen.findAllByTestId("portal-thread-row");
    expect(badge()).toBeNull();
    // On Beskeder the list is the count: the rows' own numbers (1 + 2), never
    // a 0 written because the list was read.
    get.mockClear();
    data.unread = 5;
    goPhone("schedule");
    await waitFor(() => expect(badge()?.textContent).toBe("5"));
    expect(get.mock.calls.some(([u]) => u === `/portal/${TOK}/chat/unread`)).toBe(true);
  });

  it("a phone conversation asks /chat/unread for nothing while it is open", async () => {
    await mount("da");
    goPhone("messages");
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[0]);
    await screen.findByTestId("portal-chat-stream");
    get.mockClear();
    await new Promise((r) => setTimeout(r, 50));
    expect(get.mock.calls.filter(([u]) => u.endsWith("/chat/unread"))).toHaveLength(0);
  });

  it("an unsent message is kept per conversation: back to the list and in again, it is still there", async () => {
    await mount("da");
    goPhone("messages");
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[0]);
    fireEvent.change(await screen.findByTestId("portal-chat-input"), { target: { value: "Jeg kommer 10 min senere" } });
    fireEvent.click(screen.getByTestId("portal-chat-back"));
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[0]);
    expect((await screen.findByTestId("portal-chat-input")).value).toBe("Jeg kommer 10 min senere");
  });

  it("a group's line is its size from the list row while its own read is pending — never 'Din leder'", async () => {
    await mount("da");
    goPhone("messages");
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[1]);
    const sub = await screen.findByTestId("portal-chat-subline");
    expect(sub.textContent).toBe("4 personer");
    expect(screen.queryByText("Din leder")).toBeNull();
  });
});

describe("iPad (820 × 1180): the sidebar, the column, Beskeder as a card", () => {
  it("a sidebar instead of the dock — first in the shell, Nyt a row with its count; no header bell", async () => {
    await mount("da", { w: 820, h: 1180 });
    const rail = screen.getByTestId("portal-rail");
    expect(screen.queryByTestId("portal-tabbar-v3")).toBeNull();
    expect(within(rail).getByText("BonBox Vagtplan")).toBeInTheDocument();
    expect(within(rail).getByText("Freja M.")).toBeInTheDocument();
    for (const k of ["schedule", "availability", "messages", "swaps", "hours", "alerts"]) {
      expect(within(rail).getByTestId(`portal-rail-${k}`)).toBeInTheDocument();
    }
    expect(screen.getByTestId("portal-rail-schedule").getAttribute("aria-current")).toBe("page");
    // DOM order: the sidebar before the header (keyboard and screen reader).
    const header = screen.getByTestId("portal-header");
    expect(rail.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(header).queryByRole("button", { name: "Nyt" })).toBeNull();
    // One column for the header row and the content, 720 px.
    expect(screen.getByTestId("portal-header-row").style.maxWidth).toBe("720px");
    expect(screen.getByTestId("portal-content").style.maxWidth).toBe("720px");
    // The shell makes room on the left, and none for a dock at the bottom.
    const shell = document.querySelector("[data-page-shell]");
    expect(shell.style.paddingLeft).toBe("14rem");
    expect(shell.style.paddingBottom).toBe("calc(2rem + var(--bb-consent-h, 0px))");
    await waitFor(() => expect(within(screen.getByTestId("portal-rail-messages")).getByLabelText("Ulæste beskeder").textContent).toBe("3"));
    goPad("alerts");
    expect(screen.getByTestId("portal-rail-alerts").getAttribute("aria-current")).toBe("page");
    await screen.findByText("Ingen notifikationer endnu");
    expect(document.documentElement.hasAttribute("data-vp-rail")).toBe(true);
  });

  it("a conversation is a card with its composer inside (not fixed over the screen)", async () => {
    await mount("da", { w: 820, h: 1180 });
    goPad("messages");
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[0]);
    const pane = await screen.findByTestId("portal-chat-pane");
    const composer = within(pane).getByTestId("portal-chat-composer");
    expect(composer.className).not.toMatch(/\bfixed\b/);
    expect(within(pane).getByTestId("portal-chat-back")).toBeInTheDocument();
  });

  it("the device's own word: 'denne iPad' in the profile sheet", async () => {
    const ua = Object.getOwnPropertyDescriptor(window.navigator, "userAgent");
    Object.defineProperty(window.navigator, "userAgent", { value: "Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15", configurable: true });
    try {
      await mount("da", { w: 820, h: 1180 });
      fireEvent.click(screen.getByTitle("Rediger profil"));
      expect(await screen.findByText("Frakobl denne iPad fra vagtplanen")).toBeInTheDocument();
    } finally {
      if (ua) Object.defineProperty(window.navigator, "userAgent", ua);
      else delete window.navigator.userAgent;
    }
  });
});

describe("wide iPad (1180 × 820): master-detail Beskeder, one tree across a rotation", () => {
  it("the list beside a pick pane; nothing opens by itself; a tapped thread opens beside the list with no way 'back'", async () => {
    await mount("da", { w: 1180, h: 820 });
    expect(screen.getByTestId("portal-content").style.maxWidth).toBe("1080px");
    goPad("messages");
    const split = await screen.findByTestId("portal-messages-split");
    expect(within(split).getByTestId("portal-chat-pick")).toBeInTheDocument();
    expect(within(split).getByText("Vælg en samtale")).toBeInTheDocument();
    expect(get.mock.calls.some(([u]) => u.includes("/chat/threads/"))).toBe(false);
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[0]);
    await screen.findByTestId("portal-chat-pane-head");
    expect(screen.queryByTestId("portal-chat-back")).toBeNull();
    // The list stays beside it, the open row marked and not counted.
    const row = screen.getAllByTestId("portal-thread-row")[0];
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(within(row).queryByTestId("portal-thread-unread")).toBeNull();
  });

  it("rotating to portrait keeps the draft (the same field), and back again", async () => {
    await mount("da", { w: 1180, h: 820 });
    goPad("messages");
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[0]);
    const input = await screen.findByTestId("portal-chat-input");
    fireEvent.change(input, { target: { value: "Halvt færdig" } });
    await act(async () => { setWindow(820, 1180); });
    await waitFor(() => expect(screen.queryByTestId("portal-messages-split")).toBeNull());
    expect(screen.getByTestId("portal-chat-input")).toBe(input);
    expect(input.value).toBe("Halvt færdig");
    await act(async () => { setWindow(1180, 820); });
    await screen.findByTestId("portal-messages-split");
    expect(screen.getByTestId("portal-chat-input")).toBe(input);
  });

  it("the tabs mark their two columns: the week, the shift list and the swap requests are the right-hand blocks", async () => {
    await mount("da", { w: 1180, h: 820 });
    expect(screen.getByTestId("portal-schedule-grid").className).toContain("vp-split");
    expect(screen.getByTestId("portal-week").className).toContain("vp-split-r");
    goPad("hours");
    expect((await screen.findByTestId("portal-hours-grid")).className).toContain("vp-split");
    expect(screen.getByTestId("portal-hours-list").className).toContain("vp-split-r");
    goPad("swaps");
    expect((await screen.findByTestId("portal-swap-grid")).className).toContain("vp-split");
    expect((await screen.findByTestId("portal-swap-inbox")).className).toContain("vp-split-r");
  });
});

describe("phone fixes from 1.6", () => {
  it("'who is on' counts a colleague on exactly my hours (my own row is told by shift id)", async () => {
    data.team = [
      { shift_id: "sh-1", staff_id: "me", staff_name: "Freja M.", date: inDays(1), start_time: "16:00", end_time: "22:00", role: "Bar" },
      { shift_id: "sh-9", staff_id: "s-oli", staff_name: "Oliver K.", date: inDays(1), start_time: "16:00", end_time: "22:00", role: "Bar" },
    ];
    await mount("da");
    const strip = await screen.findByTestId("portal-whos-on");
    await waitFor(() => expect(strip.textContent).toContain("Oliver"));
    expect(strip.textContent).not.toContain("Freja");
  });

  it("a failed Nyt read says so and offers a retry — not the empty state", async () => {
    let down = true;
    data.notifications = () => (down ? reject(503) : ok({ notifications: [] }));
    await mount("da");
    fireEvent.click(screen.getByRole("button", { name: "Nyt" }));
    const failed = await screen.findByTestId("portal-alerts-failed");
    expect(failed.textContent).toContain("Kunne ikke hente dine notifikationer");
    expect(screen.queryByText("Ingen notifikationer endnu")).toBeNull();
    down = false;
    fireEvent.click(within(failed).getByTestId("portal-alerts-retry"));
    await waitFor(() => expect(screen.queryByTestId("portal-alerts-failed")).toBeNull());
  });

  it("Timer: the period sheet opens on the period on screen", async () => {
    await mount("da");
    goPhone("hours");
    fireEvent.click(await screen.findByTestId("portal-hours-period"));
    const sheet = await screen.findByTestId("portal-period-sheet");
    expect(within(sheet).getByTestId("portal-period-from").value).toBe(inDays(-10));
    expect(within(sheet).getByTestId("portal-period-to").value).toBe(inDays(10));
  });
});

describe("sheets answer a hardware keyboard (1.6's useSheetKeys)", () => {
  it("the period sheet takes focus, keeps Tab inside, and Esc closes it", async () => {
    await mount("da");
    goPhone("hours");
    const opener = await screen.findByTestId("portal-hours-period");
    fireEvent.click(opener);
    const sheet = await screen.findByTestId("portal-period-sheet");
    await waitFor(() => expect(sheet.contains(document.activeElement)).toBe(true));
    fireEvent.keyDown(document, { key: "Escape" });
    await waitFor(() => expect(screen.queryByTestId("portal-period-sheet")).toBeNull());
  });
});

describe("helpers ported from 1.6", () => {
  it("sickCallDefaultDate: today when I work today, else my next shift in the window, else today", () => {
    const today = "2026-11-12";
    expect(sickCallDefaultDate([{ date: "2026-11-12" }, { date: "2026-11-13" }], today, "2026-11-26")).toBe("2026-11-12");
    expect(sickCallDefaultDate([{ date: "2026-11-15" }, { date: "2026-11-13" }], today, "2026-11-26")).toBe("2026-11-13");
    expect(sickCallDefaultDate([{ date: "2026-12-30" }], today, "2026-11-26")).toBe(today);
    expect(sickCallDefaultDate([{ date: "2026-11-01" }], today, "2026-11-26")).toBe(today);
    expect(sickCallDefaultDate(null, today, "2026-11-26")).toBe(today);
  });

  it("sameShiftTimes: same day, same start, same end (HH:MM) — a no-op swap", () => {
    const mine = { date: "2026-11-14", start_time: "17:00", end_time: "22:00" };
    expect(sameShiftTimes(mine, { date: "2026-11-14", start_time: "17:00:00", end_time: "22:00" })).toBe(true);
    expect(sameShiftTimes(mine, { date: "2026-11-14", start_time: "17:00", end_time: "23:00" })).toBe(false);
    expect(sameShiftTimes(mine, { date: "2026-11-15", start_time: "17:00", end_time: "22:00" })).toBe(false);
    expect(sameShiftTimes(null, mine)).toBe(false);
  });
});
