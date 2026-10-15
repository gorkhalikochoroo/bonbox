/**
 * Vagtplan 1.6 (24) — "make it premium", pinned on the REAL page against a
 * mocked portalApi (fetch → state → rendered DOM), plus the pure helpers.
 *
 *   H1  the Nyt bell and the profile avatar: one 40 px shell, no drop shadow,
 *       initials kept, the unread badge kept, a 44 px hit area.
 *   H2  the header says NOTHING while healthy (no green "Live", no "Synket");
 *       "Offline" / "Tryk for at opdatere" only on a problem, still tappable.
 *   H3  that word sits on the 12 px line (−my-4 on a 44 px box), so the
 *       header no longer grows to fit a 44 px button.
 *   C1  Beskeder (phone): the back row is its 12 px line, not a 44 px row.
 *   C2  the thread title is a bar: hairline only while messages are scrolled
 *       under it; the stream is measured to end above the composer; the 6 s
 *       re-read no longer yanks someone reading back to the bottom.
 *   W1  every date input fits its box on iOS (no native min-width).
 *   W2  the swap picker's note in plain words (singular too), and no
 *       "swap" with a colleague's identical shift.
 *   W3  "Tag den" on an open shift that overlaps yours is visibly blocked
 *       BEFORE the tap; a tap explains, and posts nothing.
 *   W4  Meld syg starts on your next shift's date when you are off today.
 */
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { portalSyncIssue, PORTAL_SYNC_FRESH_MS } from "../utils/portalSyncIssue";
import { sickCallDefaultDate } from "../utils/sickCallDefaultDate";
import { sameShiftTimes } from "../utils/swapClash";

const TOK = "tok24";
const ok = (data) => Promise.resolve({ data });
const reject = (status, data = {}) => {
  const e = new Error(`Request failed with status code ${status}`);
  e.response = { status, data };
  return Promise.reject(e);
};
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
};

const TODAY = inDays(0);
const D2 = inDays(2);
const D3 = inDays(3);
const D5 = inDays(5);
const OLI = "staff-oliver";
const EMMA = "staff-emma";
const ALEX = "staff-alex";

/** Swapped per test. */
let scheduleImpl;
let teamImpl;
let openImpl;
let threadImpl;
let notificationsImpl;
let live = false;

const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) {
    return ok({ has_pin: false, staff_name: "Oliver Berg", restaurant_name: "Café Nordlys", role: "server" });
  }
  if (url.startsWith(`/portal/${TOK}/schedule`)) return scheduleImpl();
  if (url.startsWith(`/portal/${TOK}/team-schedule`)) return teamImpl();
  if (url.startsWith(`/portal/${TOK}/open-shifts`)) return openImpl();
  if (url.startsWith(`/portal/${TOK}/swap-requests`)) return ok([]);
  if (url.startsWith(`/portal/${TOK}/hours`)) {
    return ok({ period_start: inDays(-10), period_end: inDays(10), total_hours: 0, entries: [] });
  }
  if (url.includes("/notifications")) return notificationsImpl();
  if (url.endsWith("/chat/unread")) return ok({ unread: 0 });
  if (url.endsWith("/chat/threads")) {
    return ok({ threads: [{ thread_id: "th1", kind: "direct", title: "Café Nordlys", last_body: "Ses!" }] });
  }
  if (url.includes("/chat/threads/th1")) return threadImpl();
  return ok([]);
});
const post = vi.fn(() => ok({}));

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
vi.mock("../hooks/usePortalStream", () => ({ usePortalStream: () => live }));
vi.mock("../utils/haptics", () => ({ haptic: Object.assign(vi.fn(), { warning: vi.fn(), success: vi.fn(), error: vi.fn(), light: vi.fn() }) }));
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
  await waitFor(() => expect(screen.getByTitle(lang === "da" ? "Rediger profil" : "Edit profile")).toBeInTheDocument());
}
const navTo = (label) => {
  const nav = document.querySelector("nav");
  fireEvent.click(within(nav).getByText(label).closest("button"));
};
const cls = (el) => (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);
const header = () => document.querySelector("[data-portal-header]");
const scheduleCalls = () => get.mock.calls.filter(([u]) => u.startsWith(`/portal/${TOK}/schedule`)).length;

// Oliver: off today, works in 2 days (Sat 17:00–23:00) and in 5 days (Wed).
const OWN = [
  { id: "oli-d2", date: D2, start_time: "17:00", end_time: "23:00", status: "published", net_hours: 5.5 },
  { id: "oli-d5", date: D5, start_time: "17:00", end_time: "23:30", status: "published", net_hours: 6 },
];

beforeEach(() => {
  localStorage.clear();
  live = false;
  get.mockClear();
  post.mockClear();
  scheduleImpl = () => ok({ shifts: OWN });
  teamImpl = () => ok([
    { shift_id: "oli-d2", staff_id: OLI, staff_name: "Oliver Berg", date: D2, start_time: "17:00", end_time: "23:00" },
    { shift_id: "oli-d5", staff_id: OLI, staff_name: "Oliver Berg", date: D5, start_time: "17:00", end_time: "23:30" },
    // Identical to Oliver's D5 shift — swapping it changes nothing → never offered.
    { shift_id: "emma-d5", staff_id: EMMA, staff_name: "Emma Lund", date: D5, start_time: "17:00", end_time: "23:30" },
    // Same day, other hours, Emma free otherwise → a real trade, offered.
    { shift_id: "alex-d5", staff_id: ALEX, staff_name: "Alexandra Holm", date: D5, start_time: "11:00", end_time: "16:00" },
    // Alexandra's D3 evening: Oliver is free then, and she is free on D5 at
    // 17:00–23:30 (her D5 ends at 16:00) → offered.
    { shift_id: "alex-d3", staff_id: ALEX, staff_name: "Alexandra Holm", date: D3, start_time: "18:00", end_time: "22:00" },
    // Overlaps Oliver's own D2 shift → hidden (counted).
    { shift_id: "emma-d2", staff_id: EMMA, staff_name: "Emma Lund", date: D2, start_time: "16:00", end_time: "22:00" },
  ]);
  openImpl = () => ok([
    { id: "open-clash", date: D2, start_time: "12:00", end_time: "18:00", role: "server" },
    { id: "open-free", date: D3, start_time: "10:00", end_time: "15:00", role: "server" },
  ]);
  threadImpl = () => ok({ kind: "direct", messages: [] });
  notificationsImpl = () => ok({ notifications: [] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ─── H2: pure rule ─────────────────────────────────────────────────────────
describe("portalSyncIssue — the header speaks only on a problem", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  const ago = (ms) => new Date(now - ms);
  it("healthy is silent: open stream, a recent answer, or the first load still on its way", () => {
    expect(portalSyncIssue({ isOnline: true, liveConnected: true, lastSynced: null, now })).toBeNull();
    expect(portalSyncIssue({ isOnline: true, liveConnected: false, lastSynced: ago(10000), now })).toBeNull();
    expect(portalSyncIssue({ isOnline: true, liveConnected: false, lastSynced: null, loading: true, now })).toBeNull();
  });
  it("offline wins over everything", () => {
    expect(portalSyncIssue({ isOnline: false, liveConnected: true, lastSynced: ago(1000), now })).toBe("offline");
  });
  it("stale after 45 s without a good answer, or when the first load failed", () => {
    expect(PORTAL_SYNC_FRESH_MS).toBe(45000);
    expect(portalSyncIssue({ isOnline: true, liveConnected: false, lastSynced: ago(45000), now })).toBe("stale");
    expect(portalSyncIssue({ isOnline: true, liveConnected: false, lastSynced: null, loading: false, now })).toBe("stale");
  });
});

// ─── H1 / H2 / H3 on the page ──────────────────────────────────────────────
describe("Header — calm controls, no 'Live'", () => {
  it("bell and avatar share one 40 px shell with a 44 px hit area; no drop shadow; initials and badge kept", async () => {
    notificationsImpl = () => ok({ notifications: [{ id: "n1", kind: "shift_published", created_at: new Date().toISOString() }] });
    await mount("da");
    const bell = within(header()).getByRole("button", { name: "Nyt" });
    const avatar = screen.getByTitle("Rediger profil");
    const shell = ["relative", "w-10", "h-10", "min-h-0!", "rounded-full", "border", "before:-inset-0.5"];
    for (const c of shell) {
      expect(cls(bell)).toContain(c);
      expect(cls(avatar)).toContain(c);
    }
    // Same calm skin: white, the same hairline; the avatar lost its dark disc + shadow.
    expect(cls(bell)).toEqual(expect.arrayContaining(["bg-white", "border-gray-200"]));
    expect(cls(avatar)).toEqual(expect.arrayContaining(["bg-white", "border-gray-200"]));
    expect(avatar.getAttribute("style") || "").not.toMatch(/box-shadow|linear-gradient|width: 33px/);
    expect(avatar.textContent).toBe("OB");
    // The unread badge still rides on the bell.
    await waitFor(() => expect(within(bell).getByLabelText("Ulæste opdateringer").textContent).toBe("1"));
  });

  it("healthy (stream open): nothing after the venue name — no 'Live', no 'Synket'", async () => {
    live = true;
    await mount("da");
    await waitFor(() => expect(scheduleCalls()).toBeGreaterThan(0));
    await screen.findByText("Åbne vagter");
    const venueLine = within(header()).getByText("Café Nordlys");
    expect(venueLine.textContent).toBe("Café Nordlys");
    expect(header().textContent).not.toMatch(/Live|Synket|Synced/);
    expect(screen.queryByTestId("portal-sync-status")).toBeNull();
  });

  it("healthy without a stream (the poll answered): still silent", async () => {
    live = false;
    await mount("da");
    await screen.findByText("Åbne vagter");
    expect(screen.queryByTestId("portal-sync-status")).toBeNull();
    expect(header().textContent).not.toMatch(/Live|Synket/);
  });

  it("a failed first load says 'Tryk for at opdatere' (amber, on its 12 px line); the tap re-reads and the word goes", async () => {
    let n = 0;
    scheduleImpl = () => { n += 1; return n === 1 ? reject(500) : ok({ shifts: OWN }); };
    await mount("da");
    const word = await screen.findByTestId("portal-sync-status");
    expect(word.textContent).toBe("Tryk for at opdatere");
    expect(word.getAttribute("style")).toContain("color: rgb(180, 83, 9)");
    // A 44 × 44 box whose negative margins keep the venue line 12 px tall.
    expect(cls(word)).toEqual(expect.arrayContaining(["inline-flex", "min-w-[44px]", "min-h-[44px]", "-my-4"]));
    const before = scheduleCalls();
    await act(async () => { fireEvent.click(word); });
    await waitFor(() => expect(scheduleCalls()).toBeGreaterThan(before));
    await waitFor(() => expect(screen.queryByTestId("portal-sync-status")).toBeNull());
  });

  it("offline says 'Offline' (and English says it in English)", async () => {
    await mount("en");
    await screen.findByText("Open shifts");
    const desc = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
    Object.defineProperty(window.navigator, "onLine", { configurable: true, get: () => false });
    try {
      await act(async () => { window.dispatchEvent(new Event("offline")); });
      expect(screen.getByTestId("portal-sync-status").textContent).toBe("Offline");
    } finally {
      if (desc) Object.defineProperty(window.navigator, "onLine", desc);
      else delete window.navigator.onLine;
    }
  });
});

// ─── W3 ────────────────────────────────────────────────────────────────────
describe("Åbne vagter — an overlapping shift is blocked before the tap", () => {
  it("overlapping: 'Blokeret', aria-disabled, a tap explains and posts nothing; a free one is 'Tag den' and posts", async () => {
    await mount("da");
    const rows = await screen.findAllByTestId("portal-open-shift");
    expect(rows).toHaveLength(2);
    const [clashRow, freeRow] = rows;
    const blocked = within(clashRow).getByRole("button");
    expect(blocked.textContent).toBe("Blokeret");
    expect(blocked.getAttribute("aria-disabled")).toBe("true");
    expect(cls(blocked)).toContain("text-gray-400");
    expect(cls(blocked)).not.toContain("bg-gray-900");
    expect(clashRow.textContent).toContain("Overlapper dig");
    await act(async () => { fireEvent.click(blocked); });
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByText("Du arbejder allerede der — derfor er den blokeret.")).toBeInTheDocument();

    const take = within(freeRow).getByRole("button");
    expect(take.textContent).toBe("Tag den");
    expect(take.hasAttribute("aria-disabled")).toBe(false);
    await act(async () => { fireEvent.click(take); });
    expect(post).toHaveBeenCalledWith(`/portal/${TOK}/open-shifts/open-free/claim`);
  });
});

// ─── W4 + W1 (Meld syg) ────────────────────────────────────────────────────
describe("Meld syg — the right day, and a date field that fits", () => {
  it("sickCallDefaultDate: today if you work today, else your next shift in the window, else today", () => {
    const today = "2026-10-15";
    const max = "2026-10-29";
    expect(sickCallDefaultDate([{ date: "2026-10-17" }, { date: "2026-10-15" }], today, max)).toBe("2026-10-15");
    expect(sickCallDefaultDate([{ date: "2026-10-21" }, { date: "2026-10-17" }, { date: "2026-10-10" }], today, max)).toBe("2026-10-17");
    expect(sickCallDefaultDate([{ date: "2026-11-20" }], today, max)).toBe(today);
    expect(sickCallDefaultDate([], today, max)).toBe(today);
    expect(sickCallDefaultDate(null, today, max)).toBe(today);
  });

  it("off today → the form opens on the next shift's date", async () => {
    await mount("da");
    fireEvent.click(await screen.findByRole("button", { name: /Meld syg/ }));
    const input = await screen.findByTestId("portal-sick-date");
    expect(input.value).toBe(D2);
    // The shift line under the date confirms which shift it is.
    expect(input.parentElement.textContent).toContain("17:00 – 23:00");
  });

  it("working today → the form opens on today", async () => {
    scheduleImpl = () => ok({ shifts: [{ id: "oli-0", date: TODAY, start_time: "23:00", end_time: "23:30", status: "published", net_hours: 0.5 }, ...OWN] });
    await mount("da");
    fireEvent.click(await screen.findByRole("button", { name: /Meld syg/ }));
    expect((await screen.findByTestId("portal-sick-date")).value).toBe(TODAY);
  });

  it("every date input carries the iOS fit: no native min-width, border-box, no native appearance", async () => {
    await mount("da");
    fireEvent.click(await screen.findByRole("button", { name: /Meld syg/ }));
    const sick = await screen.findByTestId("portal-sick-date");
    const fits = (el) => {
      expect(el.style.minWidth).toMatch(/^0(px)?$/);
      expect(el.style.maxWidth).toBe("100%");
      expect(el.style.boxSizing).toBe("border-box");
      expect(el.style.appearance).toBe("none");
      expect(cls(el)).toEqual(expect.arrayContaining(["block", "text-left", "min-h-[44px]"]));
    };
    fits(sick);
    // The Timer period sheet's two dates.
    navTo("Timer");
    const periodBtn = await waitFor(() => {
      const b = [...document.querySelectorAll("[data-portal-content] button")].find((x) => / – /.test(x.textContent));
      expect(b).toBeTruthy();
      return b;
    });
    fireEvent.click(periodBtn);
    fits(await screen.findByTestId("portal-hours-from"));
    fits(screen.getByTestId("portal-hours-to"));
  });
});

// ─── W2 ────────────────────────────────────────────────────────────────────
describe("Swap picker — plain words, no no-op trades", () => {
  async function pick(lang, ownShiftId) {
    await mount(lang);
    navTo(lang === "da" ? "Bytte" : "Swaps");
    fireEvent.click(await screen.findByRole("button", { name: lang === "da" ? /^Byt$/ : /^Swap$/ }));
    await waitFor(() => expect(get).toHaveBeenCalledWith(`/portal/${TOK}/team-schedule`));
    const own = await screen.findByDisplayValue(lang === "da" ? "Vælg en af dine vagter…" : "Pick one of your shifts…");
    fireEvent.change(own, { target: { value: ownShiftId } });
    return screen.findByDisplayValue(lang === "da" ? "Vælg en kollegas vagt…" : "Pick a teammate's shift…");
  }

  it("sameShiftTimes: same day + same hours (HH:MM, seconds ignored) — nothing else", () => {
    const a = { date: "2026-10-21", start_time: "17:00", end_time: "23:30" };
    expect(sameShiftTimes(a, { date: "2026-10-21", start_time: "17:00:00", end_time: "23:30" })).toBe(true);
    expect(sameShiftTimes(a, { date: "2026-10-21", start_time: "17:00", end_time: "23:00" })).toBe(false);
    expect(sameShiftTimes(a, { date: "2026-10-22", start_time: "17:00", end_time: "23:30" })).toBe(false);
    expect(sameShiftTimes(a, null)).toBe(false);
    expect(sameShiftTimes({ date: "", start_time: "", end_time: "" }, { date: "", start_time: "", end_time: "" })).toBe(false);
  });

  it("a colleague's identical shift is not offered; real trades are", async () => {
    const picker = await pick("da", "oli-d5");
    const offered = within(picker).getAllByRole("option").map((o) => o.value).filter(Boolean);
    expect(offered).not.toContain("emma-d5");
    expect(offered).toContain("alex-d5");
  });

  it("the hidden note is plain Danish, singular for one", async () => {
    // Giving up D5: taking emma-d2 (16–22) would put Oliver on two shifts on
    // D2 (his own 17–23) → the one hidden shift. The identical emma-d5 is left
    // out without being counted — the note is about double bookings only.
    await pick("da", "oli-d5");
    expect(screen.getByTestId("swap-hidden-overlap").textContent)
      .toBe("1 vagt vises ikke, fordi en af jer så ville have to vagter på samme tid.");
  });

  it("…and plain English", async () => {
    await pick("en", "oli-d5");
    expect(screen.getByTestId("swap-hidden-overlap").textContent)
      .toBe("1 shift isn't shown because one of you would then have two shifts at the same time.");
  });
});

// ─── C1 / C2 ───────────────────────────────────────────────────────────────
describe("Beskeder conversation on a phone", () => {
  const MSGS = Array.from({ length: 14 }, (_, i) => ({
    id: `m${i}`, sender_type: i % 2 ? "staff" : "owner", mine: !!(i % 2), body: `Besked ${i}`, created_at: new Date().toISOString(),
  }));

  async function openThread() {
    await mount("da");
    navTo("Beskeder");
    fireEvent.click(await screen.findByText("Café Nordlys", { selector: "button *" }));
    return screen.findByTestId("portal-chat-stream");
  }

  it("C1: the back row is its 12 px line — the 44 px buttons sit on negative margins", async () => {
    await openThread();
    const row = screen.getByTestId("portal-chat-back-row");
    expect(cls(row)).toContain("-mt-1");
    expect(row.getAttribute("style")).toBeNull();
    const back = within(row).getByRole("button", { name: /Alle samtaler/ });
    expect(cls(back)).toEqual(expect.arrayContaining(["min-h-[44px]", "-my-4"]));
  });

  it("C2: the title bar has a solid background, and a hairline only while messages are scrolled under it", async () => {
    threadImpl = () => ok({ kind: "direct", messages: MSGS });
    const stream = await openThread();
    await screen.findByText("Besked 13");
    const bar = screen.getByTestId("portal-chat-title-bar");
    expect(bar.style.background).toBe("rgb(245, 247, 251)");
    expect(cls(bar)).toEqual(expect.arrayContaining(["-mx-4", "px-4"]));
    let top = 0;
    Object.defineProperty(stream, "scrollTop", { configurable: true, get: () => top, set: (v) => { top = v; } });
    Object.defineProperty(stream, "scrollHeight", { configurable: true, get: () => 1400 });
    Object.defineProperty(stream, "clientHeight", { configurable: true, get: () => 400 });
    top = 0;
    await act(async () => { fireEvent.scroll(stream); });
    expect(bar.style.borderBottom).toContain("transparent");
    top = 300;
    await act(async () => { fireEvent.scroll(stream); });
    expect(bar.style.borderBottom).toContain("rgb(232, 237, 243)");
    // The stream fades in under the hairline (and out above the composer)
    // instead of slicing a bubble.
    expect(stream.style.maskImage || stream.style.webkitMaskImage).toMatch(/linear-gradient\(to bottom, transparent 0(px)?, .*transparent 100%\)/);
  });

  it("C2: the stream is measured to end at the composer (2 px for rounding — not 100vh − 20rem)", async () => {
    threadImpl = () => ok({ kind: "direct", messages: MSGS });
    const realRect = Element.prototype.getBoundingClientRect;
    vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function rect() {
      const id = this.getAttribute && this.getAttribute("data-testid");
      if (id === "portal-chat-stream") return { top: 208, bottom: 708, left: 0, right: 402, width: 402, height: 500, x: 0, y: 208 };
      if (id === "portal-chat-composer") return { top: 726, bottom: 784, left: 0, right: 402, width: 402, height: 58, x: 0, y: 726 };
      return realRect.call(this);
    });
    const stream = await openThread();
    await screen.findByText("Besked 13");
    await act(async () => { window.dispatchEvent(new Event("resize")); });
    await waitFor(() => expect(stream.style.maxHeight).toBe(`${726 - 208 - 2}px`));
  });

  it("C2: someone reading back is not pulled to the bottom by the 6 s re-read; at the bottom, new messages still pin", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const vis = Object.getOwnPropertyDescriptor(Document.prototype, "visibilityState");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    try {
      // A fresh array per read, as the network gives (the same instance
      // would let React skip the update and prove nothing).
      threadImpl = () => ok({ kind: "direct", messages: MSGS.map((m) => ({ ...m })) });
      const stream = await openThread();
      await screen.findByText("Besked 13");
      let top = 0;
      Object.defineProperty(stream, "scrollTop", { configurable: true, get: () => top, set: (v) => { top = v; } });
      Object.defineProperty(stream, "scrollHeight", { configurable: true, get: () => 1400 });
      Object.defineProperty(stream, "clientHeight", { configurable: true, get: () => 400 });
      // Reading back.
      top = 200;
      await act(async () => { fireEvent.scroll(stream); });
      const reads = get.mock.calls.filter(([u]) => u.includes("/chat/threads/th1")).length;
      await act(async () => { vi.advanceTimersByTime(6100); });
      await waitFor(() => expect(get.mock.calls.filter(([u]) => u.includes("/chat/threads/th1")).length).toBeGreaterThan(reads));
      await act(async () => {});
      expect(top).toBe(200);
      // Back at the newest: the next read pins again.
      top = 1000;
      await act(async () => { fireEvent.scroll(stream); });
      top = 990; // something nudged it a hair
      const reads2 = get.mock.calls.filter(([u]) => u.includes("/chat/threads/th1")).length;
      await act(async () => { vi.advanceTimersByTime(6100); });
      await waitFor(() => expect(get.mock.calls.filter(([u]) => u.includes("/chat/threads/th1")).length).toBeGreaterThan(reads2));
      await waitFor(() => expect(top).toBe(1400));
    } finally {
      if (vis) Object.defineProperty(document, "visibilityState", vis);
      else delete document.visibilityState;
    }
  });
});
