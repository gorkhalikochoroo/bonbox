/**
 * Vagtplan — the four tabs past the home (Fravær, Beskeder, Byt, Timer) in
 * the home's system (Nov 2026), pinned on the REAL page against a mocked
 * portalApi:
 *
 *   • Fravær: "Kan ikke / Helst" is an ivory track with the chosen half
 *     pine; the week strip draws one look per meaning (terracotta kan ikke,
 *     struck; dashed = every week; sage helst; brass waiting; pine
 *     approved) and the legend draws the same looks; rows are ivory cards;
 *     "Anmod om fri" is sage, Send pine.
 *   • Beskeder: pine "+", ivory search, ivory rows with Sora names and a
 *     pine count; own bubbles pine with ivory text, others the card.
 *   • Byt: "Byt" pine (not navy), the give-aways as the home's open-shift
 *     rows with the home's sage "Tag den"; no swaps = one calm line.
 *   • Timer: pine card; this week's bar pine, the rest sage, figures in
 *     .vp-figures; "Eksportér CSV" a quiet pine text button. Drawn by what
 *     the device can DO: on the web, and in an app whose WebView can share a
 *     file (iOS); not in one that cannot (Android's WebView), where one line
 *     says where the export works — and an undelivered export says so too.
 *   • Over all four: no Tailwind green-* / emerald-* class and no navy or
 *     bright green in any inline style, on any element of the tab — swept
 *     over the swap inbox (every status), a group thread, the new-group
 *     sheet and a staged photo too, not only the empty screens.
 *   • One button shape (radius 14, never wrapped) and one disabled look
 *     (the tile, muted, no shadow).
 */
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "toksys";
const ok = (data) => Promise.resolve({ data });

// The palette, as jsdom serialises it.
const PINE = "rgb(14, 59, 46)";
const CREAM = "rgb(243, 239, 228)";
const CARD = "rgb(255, 254, 251)";
const SOFT = "rgb(227, 236, 230)";
const SAGE_BAR = "rgb(195, 209, 200)";
const RED_WASH = "rgb(246, 227, 220)";
const BRASS_WASH = "rgb(244, 235, 215)";
const LINE = "rgb(232, 227, 216)";
const TILE = "rgb(241, 238, 230)";
const MUTED = "rgb(94, 106, 99)";
const DIVIDER = "rgb(238, 234, 224)";
const RED_INK = "rgb(164, 69, 47)";
const RED_WASH_HEX = "rgb(246, 227, 220)";

const native = vi.hoisted(() => ({ on: false }));
vi.mock("../utils/platform", () => ({
  platform: { get isNative() { return native.on; }, isIOS: false, isAndroid: false, get isWeb() { return !native.on; } },
  isNativeApp: () => native.on,
  canPurchaseInApp: () => !native.on,
  isIPad: () => false,
}));
const csv = vi.hoisted(() => ({ calls: [], result: true }));
vi.mock("../utils/exportCsv", () => ({
  exportToCsv: (...args) => { csv.calls.push(args); return Promise.resolve(csv.result); },
}));

const iso = (d) => d.toLocaleDateString("sv-SE");
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
// Next week's Monday + i: every day of it is in the future whatever weekday
// the suite runs on, so every cell of that week strip is tappable.
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
  // A chat photo that never arrives: the loading look stays on screen.
  if (sub.startsWith("/chat/photo/")) return new Promise(() => {});
  if (sub.startsWith("/chat/threads/")) return ok(data.thread);
  if (sub.startsWith("/chat/threads")) return ok({ threads: data.threads });
  if (sub.startsWith("/chat/colleagues")) return ok({ colleagues: data.colleagues });
  if (sub.startsWith("/swap-requests")) return ok(data.swaps);
  if (sub.startsWith("/give-aways")) return ok(data.pool);
  if (sub.startsWith("/hours")) return ok(data.hours);
  return ok([]);
});

vi.mock("../services/portalApi", () => ({
  default: { get: (...a) => get(...a), post: vi.fn(() => ok({})), put: vi.fn(), delete: vi.fn(() => ok({})), defaults: { baseURL: "" } },
  storePinProof: vi.fn(),
}));
vi.mock("../hooks/useNativePush", () => ({
  default: () => ({}),
  unregisterNativePush: vi.fn(() => Promise.resolve()),
  getStoredNativePushToken: () => null,
  NATIVE_PUSH_TOKEN_KEY: "bonbox_apns_token",
}));
vi.mock("../utils/haptics", () => ({ haptic: Object.assign(vi.fn(), { light: vi.fn(), warning: vi.fn(), success: vi.fn(), error: vi.fn() }) }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));
vi.mock("@capacitor/app", () => ({ App: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })) } }));
// The native shell's Keyboard plugin has no web build; the keyboard is not
// what these tests are about (StaffPortalPage.keyboardNative pins it).
vi.mock("@capacitor/keyboard", () => ({
  Keyboard: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })), setAccessoryBarVisible: vi.fn(() => Promise.resolve()), setScroll: vi.fn(() => Promise.resolve()), setResizeMode: vi.fn(() => Promise.resolve()) },
  KeyboardResize: { Body: "body", Native: "native", None: "none", Ionic: "ionic" },
}));

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
const content = () => screen.getByTestId("portal-content");
const go = (tab) => fireEvent.click(screen.getByTestId(`portal-tab-${tab}`));

const realMatchMedia = window.matchMedia;
const realCreateObjectURL = URL.createObjectURL;
const realRevokeObjectURL = URL.revokeObjectURL;
/** Pretend the viewport is under 360 px (NARROW_PHONE_Q). */
function narrowViewport() {
  window.matchMedia = (q) => ({
    matches: q === "(max-width: 359px)", media: q,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  });
}
/** Give this jsdom a Web Share that can (or cannot) take a file. */
function webShare(canFiles) {
  Object.defineProperty(navigator, "share", { value: vi.fn(() => Promise.resolve()), configurable: true, writable: true });
  Object.defineProperty(navigator, "canShare", { value: vi.fn((d) => !!(canFiles && d?.files?.length)), configurable: true, writable: true });
}

beforeEach(() => {
  localStorage.clear();
  get.mockClear();
  native.on = false;
  csv.calls = [];
  csv.result = true;
  data = {
    info: { has_pin: false, staff_name: "Freja M.", role: "waiter", restaurant_name: "Café Solsikke" },
    shifts: [{ id: "sh-1", date: nextWeek(0), start_time: "16:00", end_time: "22:00", status: "published", net_hours: 5.5 }],
    availability: [
      { id: "av-cant", date: nextWeek(0), kind: "unavailable", weekday: null, start_time: null, end_time: null, note: "Eksamen" },
      { id: "av-pref", date: nextWeek(1), kind: "preferred", weekday: null, start_time: null, end_time: null, note: null },
      { id: "av-fri", date: null, kind: "unavailable", weekday: 4, start_time: null, end_time: null, note: null },
    ],
    absence: [
      { id: "ab-wait", kind: "ferie", date: nextWeek(2), status: "pending", reason: null },
      { id: "ab-ok", kind: "ferie", date: nextWeek(3), status: "acknowledged", reason: null },
    ],
    threads: [
      { thread_id: "own", kind: "owner", title: "Café Solsikke", last_body: "Kan du tage fredag?", last_message_at: new Date().toISOString(), unread: 2 },
      { thread_id: "g1", kind: "group", title: "Køkkenet", last_body: "Tak!", last_sender: "Sofie", last_message_at: new Date().toISOString(), unread: 0 },
    ],
    thread: {
      thread_id: "own", kind: "owner", title: "Café Solsikke",
      messages: [
        { id: 1, sender_type: "owner", mine: false, body: "Kan du tage fredag?", created_at: new Date().toISOString() },
        { id: 2, sender_type: "staff", mine: true, body: "Ja, gerne", created_at: new Date().toISOString() },
      ],
    },
    colleagues: [],
    swaps: [],
    pool: [
      { id: "ga-1", from_staff_name: "Ida H.", from_shift_date: nextWeek(5), from_shift_time: "16:00–22:00", reason: "Bryllup" },
    ],
    hours: {
      period_start: inDays(-20), period_end: inDays(6), total_hours: 19.5, hours_source: "logged",
      entries: [
        { date: inDays(-1), start_time: "16:00", end_time: "22:00", total_hours: 5.5, resolution: "confirmed" },
        { date: inDays(-9), start_time: "10:00", end_time: "17:30", total_hours: 7 },
        { date: inDays(-16), start_time: "09:00", end_time: "16:00", total_hours: 7 },
      ],
    },
  };
});
afterEach(() => {
  document.body.classList.remove("portal-shell");
  window.matchMedia = realMatchMedia;
  URL.createObjectURL = realCreateObjectURL;
  URL.revokeObjectURL = realRevokeObjectURL;
  delete navigator.share;
  delete navigator.canShare;
});

/** The one filled-button shape: radius 14, a label that never wraps. */
function expectButtonShape(el) {
  expect(el.style.borderRadius).toBe("14px");
  expect(el.style.whiteSpace).toBe("nowrap");
}
/** The one disabled look: the tile, muted, no shadow. */
function expectOff(el) {
  expect(el.disabled).toBe(true);
  expect(el.style.background).toBe(TILE);
  expect(el.style.color).toBe(MUTED);
  expect(el.style.boxShadow).toBe("none");
  expect(el.className).not.toMatch(/disabled:opacity/);
}

/** Every element of the tab on screen: no Tailwind green / emerald class,
    no navy or bright green inline, and no navy primary (bg-gray-900). */
function expectNoGreenOrNavy(root) {
  const CLASS_BAD = /(?:^|\s)(?:[a-z-]+:)*(?:bg|text|border|ring|from|via|to|fill|stroke|outline|shadow|accent|decoration)-(?:green|emerald)-\d{2,3}(?:\/\d+)?(?=\s|$)|(?:^|\s)(?:[a-z-]+:)*bg-(?:gray|slate)-900(?=\s|$)/;
  // jsdom turns a plain hex into rgb(); a gradient or a shadow keeps what
  // was written — so both spellings, with or without spaces and alpha.
  const STYLE_BAD = /#22c55e|#16a34a|#0f172a|#111827|#1e293b|rgba?\(\s*(?:34,\s*197,\s*94|22,\s*163,\s*74|15,\s*23,\s*42|17,\s*24,\s*39|30,\s*41,\s*59)\b/i;
  const offenders = [];
  for (const el of [root, ...root.querySelectorAll("*")]) {
    const cls = el.getAttribute("class") || "";
    const style = el.getAttribute("style") || "";
    if (CLASS_BAD.test(cls) || STYLE_BAD.test(style)) offenders.push(`${el.tagName.toLowerCase()} class="${cls}" style="${style}"`);
  }
  expect(offenders).toEqual([]);
}

describe("Fravær", () => {
  it("'Kan ikke / Helst' is an ivory track; the chosen half is pine with cream text, and the intro follows it", async () => {
    await mount("da");
    go("availability");
    const group = await screen.findByTestId("kanikke-mode");
    expect(group.style.background).toBe(CARD);
    expect(group.style.border).toContain(LINE);
    expect(group.style.borderRadius).toBe("999px");
    const cant = screen.getByTestId("kanikke-mode-unavailable");
    const pref = screen.getByTestId("kanikke-mode-preferred");
    expect([cant.textContent, pref.textContent]).toEqual(["Kan ikke", "Helst"]);
    expect(cant.getAttribute("aria-pressed")).toBe("true");
    expect(cant.style.background).toBe(PINE);
    expect(cant.style.color).toBe(CREAM);
    expect(pref.style.background).toBe("transparent");
    expect(content().textContent).toContain("Tryk på de dage, du ikke kan arbejde.");
    fireEvent.click(pref);
    expect(pref.getAttribute("aria-pressed")).toBe("true");
    expect(pref.style.background).toBe(PINE);
    expect(cant.style.background).toBe("transparent");
    expect(content().textContent).toContain("Tryk på de dage, du helst vil arbejde.");
  });

  it("the week strip: one look per meaning, kan ikke struck, a rostered day keeps its dot, and the legend draws the same looks", async () => {
    await mount("da");
    go("availability");
    const week = await screen.findByTestId("kanikke-week");
    fireEvent.click(within(week).getByRole("button", { name: "Næste uge" }));
    const cells = within(week).getAllByRole("button").filter((b) => b.dataset.look);
    expect(cells).toHaveLength(7);
    expect(cells.map((c) => c.dataset.look)).toEqual(["cant", "pref", "pending", "approved", "weekly", "free", "free"]);
    const [mon, tue, wed, thu, fri, sat] = cells;
    // Kan ikke: terracotta, the date struck through.
    expect(mon.style.background).toBe(RED_WASH);
    expect(mon.querySelector(".tabular-nums").style.textDecoration).toContain("line-through");
    // Helst: sage, not struck.
    expect(tue.style.background).toBe(SOFT);
    expect(tue.querySelector(".tabular-nums").style.textDecoration).toBe("none");
    // Waiting on the manager: brass. Approved: pine.
    expect(wed.style.background).toBe(BRASS_WASH);
    expect(thu.style.background).toBe(PINE);
    // Every week: a dashed edge, not a fill.
    expect(fri.style.border).toContain("dashed");
    // A free day is the home's shift-row tile.
    expect(sat.style.background).toBe("rgb(244, 241, 234)");
    // The rostered Monday keeps its pine dot under the kan-ikke mark.
    expect(within(mon).getByTestId("kanikke-rostered-dot").style.background).toBe(PINE);
    // A pending day is read as pending — it said "Godkendt fri".
    expect(wed.getAttribute("aria-label")).toContain("Afventer");
    expect(wed.getAttribute("aria-label")).not.toContain("Godkendt fri");
    expect(thu.getAttribute("aria-label")).toContain("Godkendt fri");
    // Approved is solid pine — "selected" elsewhere on this screen — so it
    // carries a cream tick; nothing else does.
    expect(within(thu).getByTestId("kanikke-approved-mark").style.color).toBe(CREAM);
    for (const c of [mon, tue, wed, fri, sat]) expect(within(c).queryByTestId("kanikke-approved-mark")).toBeNull();

    const legend = screen.getByTestId("kanikke-legend");
    const swatch = (k) => legend.querySelector(`[data-legend="${k}"] > span`);
    expect(swatch("cant").style.background).toBe(RED_WASH);
    expect(swatch("pref").style.background).toBe(SOFT);
    expect(swatch("pending").style.background).toBe(BRASS_WASH);
    expect(swatch("approved").style.background).toBe(PINE);
    expect(swatch("approved").querySelector("svg")).not.toBeNull();
    expect(swatch("weekly").style.border).toContain("dashed");
    expect(legend.textContent).toContain("Kan ikke");
    expect(legend.textContent).toContain("Godkendt fri");
  });

  it("marked days and absence rows are ivory cards; status chips brass / sage; 'Anmod om fri' sage, Send pine", async () => {
    await mount("da");
    go("availability");
    const rows = await screen.findAllByTestId("kanikke-marked-row");
    expect(rows).toHaveLength(2);
    for (const r of rows) {
      expect(r.style.background).toBe(CARD);
      expect(r.style.border).toContain(LINE);
      expect(r.style.borderRadius).toBe("20px");
    }
    const absence = await screen.findAllByTestId("fravaer-row");
    expect(absence).toHaveLength(2);
    const chips = screen.getAllByTestId("fravaer-status");
    expect(chips.map((c) => c.textContent)).toEqual(["Afventer", "Godkendt"]);
    expect(chips[0].style.background).toBe(BRASS_WASH);
    expect(chips[1].style.background).toBe(SOFT);
    const add = screen.getByTestId("fravaer-add");
    expect(add.style.background).toBe(SOFT);
    expect(add.style.color).toBe(PINE);
    expectButtonShape(add);
    fireEvent.click(add);
    const form = await screen.findByTestId("fravaer-form");
    const send = within(form).getByRole("button", { name: "Send anmodning" });
    expect(send.style.background).toBe(PINE);
    expect(send.style.color).toBe(CREAM);
    // The kind picker is the same segmented control.
    expect(within(form).getByTestId("fravaer-kind-ferie").style.background).toBe(PINE);
    expectNoGreenOrNavy(content());
  });

  it("the header says what the dock says ('Fravær'), and the list under it has its own name", async () => {
    await mount("da");
    go("availability");
    await screen.findByTestId("fravaer-section");
    expect(document.querySelector("h1").textContent).toBe("Fravær");
    expect(screen.getByRole("heading", { level: 2, name: "Ferie og fri" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { level: 2, name: "Fravær" })).toBeNull();
  });

  it("en: 'Time off' in the header, as in the dock", async () => {
    await mount("en");
    go("availability");
    await screen.findByTestId("fravaer-section");
    expect(document.querySelector("h1").textContent).toBe("Time off");
    expect(screen.getByRole("heading", { level: 2, name: "Holiday and time off" })).toBeInTheDocument();
  });

  it("an absence row never cuts its dates: kind, then the range (no wrap) and reason, the chip under them — only 'Fortryd' beside", async () => {
    data.absence = [{ id: "ab-long", kind: "ferie", date: nextWeek(2), status: "pending", reason: "Familiebesøg i Aarhus hele ugen" }];
    await mount("da");
    go("availability");
    const [row] = await screen.findAllByTestId("fravaer-row");
    const dates = within(row).getByTestId("fravaer-row-dates");
    const range = dates.firstChild;
    expect(range.style.whiteSpace).toBe("nowrap");
    expect(range.className).not.toContain("truncate");
    expect(range.textContent).toMatch(/\d/);
    // The reason is the part allowed to truncate.
    expect(dates.lastChild.className).toContain("truncate");
    expect(dates.lastChild.textContent).toContain("Familiebesøg");
    // Kind on its own line; the chip in the same column, not a row sibling.
    const column = dates.parentElement;
    expect(column.firstChild.textContent).toBe("Ferie");
    expect(column.contains(within(row).getByTestId("fravaer-status"))).toBe(true);
    const rowChildren = [...row.children];
    expect(rowChildren).toHaveLength(3);   // well, text column, Fortryd
    expect(rowChildren[2].textContent).toBe("Fortryd");
  });

  it("the request form stacks: 'Send anmodning' full width, never wrapped; 'Annuller' a quiet text line under it", async () => {
    await mount("da");
    go("availability");
    fireEvent.click(await screen.findByTestId("fravaer-add"));
    const form = await screen.findByTestId("fravaer-form");
    const send = within(form).getByTestId("fravaer-submit");
    const cancel = within(form).getByTestId("fravaer-cancel");
    expect(send.textContent).toBe("Send anmodning");
    expect(send.className).toContain("w-full");
    expect(send.style.height).toBe("52px");
    expectButtonShape(send);
    // Send above cancel, in one column.
    expect(send.parentElement).toBe(cancel.parentElement);
    expect(send.parentElement.className).toContain("flex-col");
    expect(send.compareDocumentPosition(cancel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(cancel.textContent).toBe("Annuller");
    expect(cancel.style.background).toBe("transparent");
    expect(cancel.style.color).toBe(MUTED);
    expect(cancel.style.minHeight).toBe("44px");
    fireEvent.click(cancel);
    await waitFor(() => expect(screen.queryByTestId("fravaer-form")).toBeNull());
  });

  it("the month grid: the column sets a cell's width, 44 tall; under 360 px the gaps and side padding give way", async () => {
    narrowViewport();
    await mount("da");
    go("availability");
    fireEvent.click(await screen.findByTestId("kanikke-cal-toggle"));
    const month = await screen.findByTestId("kanikke-month");
    expect(month.style.padding).toBe("14px 6px 12px");
    const cells = month.querySelectorAll("button[data-look]");
    expect(cells.length).toBeGreaterThan(27);
    for (const c of cells) {
      expect(c.className).not.toContain("aspect-square");
      expect(c.className).not.toContain("min-h-[44px]");
      expect(c.className).toContain("w-full");
      expect(c.style.height).toBe("44px");
      expect(["0", "0px"]).toContain(c.style.minWidth);
    }
    const grid = cells[0].parentElement;
    expect(grid.style.gap).toBe("2px");
    expect(grid.style.gridTemplateColumns).toBe("repeat(7, minmax(0, 1fr))");
    for (const d of grid.querySelectorAll("div[aria-hidden]")) expect(d.className).not.toContain("aspect-square");
  });

  it("the month grid keeps its air at 360 px and up", async () => {
    await mount("da");
    go("availability");
    fireEvent.click(await screen.findByTestId("kanikke-cal-toggle"));
    const month = await screen.findByTestId("kanikke-month");
    expect(month.style.padding).toBe("14px 10px 12px");
    expect(month.querySelector("button[data-look]").parentElement.style.gap).toBe("4px");
  });

  it("copy: the weekly hint has its verb; the hint points at the list, not the calendar; a timed day only asks for a note", async () => {
    data.availability = [
      { id: "av-t", date: nextWeek(0), kind: "unavailable", weekday: null, start_time: "08:00", end_time: "12:00", note: null },
      { id: "av-a", date: nextWeek(1), kind: "unavailable", weekday: null, start_time: null, end_time: null, note: null },
    ];
    await mount("da");
    go("availability");
    const rows = await screen.findAllByTestId("kanikke-marked-row");
    expect(rows[0].textContent).toContain("08:00–12:00 · Tilføj en note");
    expect(rows[0].textContent).not.toContain("Tilføj tidsrum");
    expect(rows[1].textContent).toContain("Hele dagen · Tilføj tidsrum / note");
    expect(content().textContent).toContain("Tryk på en dag i listen for at vælge tidsrum eller note.");
    expect(content().textContent).not.toContain("ovenfor");
    fireEvent.click(screen.getByTestId("kanikke-weekly-toggle"));
    expect(content().textContent).toContain("Vælg en ugedag, du aldrig kan arbejde.");
  });
});

describe("Beskeder", () => {
  it("pine '+', ivory search, ivory rows with Sora names and a pine unread count", async () => {
    await mount("da");
    go("messages");
    const rows = await screen.findAllByTestId("portal-thread-row");
    expect(rows).toHaveLength(2);
    const plus = screen.getByTestId("portal-chat-new-group");
    expect(plus.getAttribute("aria-label")).toBe("Ny gruppe");
    expect(plus.style.background).toBe(PINE);
    expect(plus.style.borderRadius).toBe("999px");
    const search = screen.getByTestId("portal-chat-search");
    expect(search.style.background).toBe(CARD);
    expect(search.className).toContain("border-[#E8E3D8]");
    for (const r of rows) {
      expect(r.style.background).toBe(CARD);
      expect(r.style.border).toContain(LINE);
    }
    const name = within(rows[0]).getByText("Café Solsikke");
    expect(name.style.font).toContain("Sora");
    const badge = within(rows[0]).getByTestId("portal-thread-unread");
    expect(badge.textContent).toBe("2");
    expect(badge.style.background).toBe(PINE);
    expect(within(rows[1]).queryByTestId("portal-thread-unread")).toBeNull();
    expectNoGreenOrNavy(content());
  });

  it("a conversation: own bubbles pine with ivory text, the other side the card; send is pine", async () => {
    await mount("da");
    go("messages");
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[0]);
    const bubbles = await screen.findAllByTestId("portal-chat-bubble");
    expect(bubbles).toHaveLength(2);
    const [theirs, mine] = bubbles;
    expect(mine.hasAttribute("data-mine")).toBe(true);
    expect(mine.style.background).toBe(PINE);
    expect(mine.style.color).toBe(CREAM);
    expect(theirs.style.background).toBe(CARD);
    expect(theirs.style.border).toContain(LINE);
    // Nothing typed: the one disabled look. Something typed: pine.
    const send = screen.getByTestId("portal-chat-send");
    expectOff(send);
    fireEvent.change(screen.getByPlaceholderText("Skriv en besked…"), { target: { value: "Hej" } });
    expect(send.disabled).toBe(false);
    expect(send.style.background).toBe(PINE);
    expect(send.style.color).toBe(CREAM);
    expect(screen.getByTestId("portal-chat-back").textContent).toContain("Alle samtaler");
    // The owner thread has one other party, named in the h2 — not over
    // every bubble.
    expect(screen.queryByTestId("portal-chat-sender")).toBeNull();
    // The stream stops above the floating composer on a notched phone too:
    // its height gives back both safe-area insets (iPhone sim, 11 Nov: the
    // newest group message sat ~80 px under the composer without them).
    const stream = screen.getByTestId("portal-chat-stream");
    expect(stream.style.maxHeight).toContain("env(safe-area-inset-top");
    expect(stream.style.maxHeight).toContain("env(safe-area-inset-bottom");
    expectNoGreenOrNavy(content());
  });

  it("the composer's photo controls: a 44 px muted attach; a staged photo gets a pine '×', not the kit's navy dot", async () => {
    URL.createObjectURL = vi.fn(() => "blob:staged");
    URL.revokeObjectURL = vi.fn();
    await mount("da");
    go("messages");
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[0]);
    await screen.findAllByTestId("portal-chat-bubble");
    const composer = screen.getByTestId("portal-chat-composer");
    const attach = within(composer).getByTestId("chat-photo-attach");
    expect(attach.style.width).toBe("44px");
    expect(attach.style.height).toBe("44px");
    expect(attach.style.color).toBe(MUTED);
    expect(attach.className).not.toMatch(/hover:bg-|text-gray-/);
    const input = attach.querySelector('input[type="file"]');
    fireEvent.change(input, { target: { files: [new File(["x"], "a.png", { type: "image/png" })] } });
    const remove = await within(composer).findByTestId("chat-photo-remove");
    expect(remove.style.background).toBe(PINE);
    expect(remove.style.color).toBe(CREAM);
    expect(remove.style.width).toBe("24px");
    expect(remove.className).toContain("before:-inset-[10px]");
    expect(composer.querySelector("img").style.borderRadius).toBe("14px");
    // A photo alone is something to send.
    expect(screen.getByTestId("portal-chat-send").style.background).toBe(PINE);
    expectNoGreenOrNavy(composer);
  });

  it("a photo that is still loading shimmers on the divider tone, 14 px corners — no grey pulse", async () => {
    data.thread = {
      ...data.thread,
      messages: [{ id: 3, sender_type: "owner", mine: false, body: "", photo_count: 1, photos: [{ id: 9, url: `/portal/${TOK}/chat/photo/9` }], created_at: new Date().toISOString() }],
    };
    await mount("da");
    go("messages");
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[0]);
    const loading = await screen.findByTestId("chat-photo-loading");
    expect(loading.className).toContain("vp-shimmer");
    expect(loading.className).not.toContain("animate-pulse");
    expect(loading.style.background).toBe(DIVIDER);
    expect(loading.style.borderRadius).toBe("14px");
    expectNoGreenOrNavy(content());
  });

  it("a group thread names who spoke, offers Leave, and keeps the system", async () => {
    data.thread = {
      thread_id: "g1", kind: "group", title: "Køkkenet", member_ids: [1, 2, 3],
      messages: [
        { id: 5, sender_type: "staff", mine: false, sender_name: "Sofie", body: "Tak!", created_at: new Date().toISOString() },
        { id: 6, sender_type: "staff", mine: true, body: "Selv tak", created_at: new Date().toISOString() },
      ],
    };
    await mount("da");
    go("messages");
    fireEvent.click((await screen.findAllByTestId("portal-thread-row"))[1]);
    await screen.findAllByTestId("portal-chat-bubble");
    const senders = screen.getAllByTestId("portal-chat-sender");
    expect(senders.map((x) => x.textContent)).toEqual(["Sofie"]);
    expect(within(content()).getByRole("button", { name: "Forlad" })).toBeInTheDocument();
    expectNoGreenOrNavy(content());
  });

  it("the '+' sheet: a pine tick on who is picked; 'Opret gruppe' off until it has a name, then pine — no green or navy", async () => {
    data.colleagues = [{ staff_id: 7, name: "Sofie K.", role: "chef" }];
    await mount("da");
    go("messages");
    fireEvent.click(await screen.findByTestId("portal-chat-new-group"));
    const sheet = await screen.findByTestId("portal-new-group");
    const create = within(sheet).getByRole("button", { name: "Opret gruppe" });
    expectOff(create);
    expectButtonShape(create);
    const person = await within(sheet).findByRole("button", { name: /Sofie K\./ });
    fireEvent.click(person);
    expect(person.getAttribute("aria-pressed")).toBe("true");
    expect(person.querySelector("svg")).not.toBeNull();
    fireEvent.change(within(sheet).getByPlaceholderText(/Køkken/), { target: { value: "Køkkenet" } });
    expect(create.disabled).toBe(false);
    expect(create.style.background).toBe(PINE);
    expect(create.style.height).toBe("52px");
    expectNoGreenOrNavy(sheet);
  });
});

describe("Byt", () => {
  it("'Byt' and 'Giv en vagt væk' are the canvas's ivory tiles with a sage well (no navy, no filled button); give-aways read like the home's open shifts", async () => {
    await mount("da");
    go("swaps");
    const offer = await within(content()).findByRole("button", { name: /^Byt$/ });
    const give = within(content()).getByRole("button", { name: "Giv en vagt væk" });
    for (const tile of [offer, give]) {
      expect(tile.style.background).toBe(CARD);
      expect(tile.style.border).toContain(LINE);
      expect(tile.style.color).toBe("rgb(22, 33, 28)");
      expect(tile.style.borderRadius).toBe("20px");
      const well = tile.firstChild;
      expect(well.style.width).toBe("38px");
      expect(well.style.borderRadius).toBe("12px");
      expect(well.style.background).toBe(SOFT);
      expect(well.style.color).toBe(PINE);
    }
    const row = await screen.findByTestId("swap-pool-row");
    expect(row.textContent).toContain("16:00–22:00");
    expect(row.textContent).toContain("Ledig for dig");
    // The date tile is aria-hidden; the day is said in words for a reader.
    const sr = row.querySelector(".sr-only");
    expect(sr).not.toBeNull();
    expect(sr.textContent.length).toBeGreaterThan(4);
    const take = within(row).getByRole("button", { name: "Tag den" });
    expect(take.style.background).toBe(SOFT);
    expect(take.style.color).toBe(PINE);
    expect(screen.getByRole("heading", { level: 2, name: "Vagter, der gives væk" })).toBeInTheDocument();
    expect(content().textContent).not.toMatch(/til salg/i);
    expectNoGreenOrNavy(content());
  });

  it("the inbox, every status: Accepter pine, Afvis the card; brass waiting, sage done, the tile for agreed; the give-away's done line says 'Overtaget'", async () => {
    const shift = (d, tm) => ({ from_shift_date: nextWeek(d), from_shift_time: tm });
    data.swaps = [
      { id: "in", direction: "incoming", status: "proposed", from_staff_name: "Ida H.", to_staff_name: "Freja M.", ...shift(2, "10:00–16:00"), to_shift_id: "x", to_shift_date: nextWeek(3), to_shift_time: "16:00–22:00", reason: "Tandlæge" },
      { id: "out", direction: "outgoing", status: "proposed", from_staff_name: "Freja M.", to_staff_name: "Sofie K.", ...shift(4, "16:00–22:00"), to_shift_id: "y", to_shift_date: nextWeek(5), to_shift_time: "10:00–16:00" },
      { id: "ga", direction: "outgoing", status: "done", from_staff_name: "Freja M.", to_staff_name: "Sofie K.", ...shift(6, "12:00–18:00"), to_shift_id: null },
      { id: "sw", direction: "incoming", status: "done", from_staff_name: "Ida H.", to_staff_name: "Freja M.", ...shift(1, "09:00–15:00"), to_shift_id: "z", to_shift_date: nextWeek(2), to_shift_time: "15:00–21:00" },
      { id: "ag", direction: "incoming", status: "accepted", from_staff_name: "Ida H.", to_staff_name: "Freja M.", ...shift(1, "09:00–15:00"), to_shift_id: "w", to_shift_date: nextWeek(2), to_shift_time: "15:00–21:00" },
    ];
    data.pool = [];
    await mount("da");
    go("swaps");
    const rows = await screen.findAllByTestId("swap-row");
    expect(rows).toHaveLength(5);
    const [inc, out, ga, sw, ag] = rows;

    const accept = within(inc).getByTestId("swap-accept");
    expect(accept.textContent).toBe("Accepter");
    expect(accept.style.background).toBe(PINE);
    expect(accept.style.color).toBe(CREAM);
    expectButtonShape(accept);
    const decline = within(inc).getByTestId("swap-decline");
    expect(decline.style.background).toBe(CARD);
    expect(decline.style.border).toContain(LINE);
    expectButtonShape(decline);
    // One way to quote a colleague: upright curly quotes, as in the pool.
    const reason = within(inc).getByTestId("swap-reason");
    expect(reason.textContent).toBe("“Tandlæge”");
    expect(reason.style.font).not.toContain("italic");

    const pill = (r) => within(r).getByTestId("swap-status");
    expect(pill(inc).textContent).toBe("Afventer");
    expect(pill(inc).style.background).toBe(BRASS_WASH);
    expect(pill(out).style.background).toBe(BRASS_WASH);
    expect(within(out).getByRole("button", { name: "Træk tilbage" })).toBeInTheDocument();

    expect(pill(ga).textContent).toBe("Overtaget");
    expect(pill(ga).style.background).toBe(SOFT);
    expect(within(ga).getByTestId("swap-done-line").textContent).toBe("Overtaget — vagtplanen er opdateret.");
    expect(ga.textContent).not.toContain("Byttet");

    expect(pill(sw).textContent).toBe("Byttet");
    expect(pill(sw).style.background).toBe(SOFT);
    expect(within(sw).getByTestId("swap-done-line").textContent).toContain("Byttet");

    // "accepted" had no word and showed the raw English status.
    expect(pill(ag).textContent).toBe("Aftalt");
    expect(pill(ag).style.background).toBe(TILE);
    expect(content().textContent).not.toContain("accepted");

    expectNoGreenOrNavy(content());
  });

  it("no swaps: one calm line on a card, with a line icon", async () => {
    data.pool = [];
    await mount("da");
    go("swaps");
    const empty = await screen.findByTestId("swap-empty");
    expect(empty.textContent).toBe("Ingen ventende vagtbytte-anmodninger.");
    expect(empty.querySelector("svg")).not.toBeNull();
    expect(empty.style.background).toBe(CARD);
    expectNoGreenOrNavy(content());
  });

  it("both inline forms keep the system: the submit has the one shape and the one disabled look, no green or navy anywhere", async () => {
    await mount("da");
    go("swaps");
    fireEvent.click(await within(content()).findByRole("button", { name: /^Byt$/ }));
    const form = await screen.findByTestId("swap-propose");
    // Nothing picked yet: off — the tile, not a faded pine slab.
    const submit = within(form).getByRole("button", { name: "Send bytteanmodning" });
    expectOff(submit);
    expectButtonShape(submit);
    expect(submit.style.height).toBe("52px");
    expectNoGreenOrNavy(content());
    fireEvent.click(within(form).getByRole("button", { name: "Luk" }));
    fireEvent.click(within(content()).getByRole("button", { name: "Giv en vagt væk" }));
    const sell = await screen.findByTestId("swap-sell");
    const give = within(sell).getByRole("button", { name: "Giv vagten væk" });
    expectOff(give);
    expectButtonShape(give);
    expectNoGreenOrNavy(content());
  });
});

describe("Timer", () => {
  it("the card is pine; this week's bar pine, the rest sage; figures and labels in .vp-figures", async () => {
    await mount("da");
    go("hours");
    const card = await screen.findByTestId("portal-hours-card");
    expect(card.style.background).toBe(PINE);
    expect(screen.getByTestId("portal-hours-total").className).toContain("vp-figures");
    const bars = await screen.findAllByTestId("portal-week-bar");
    expect(bars.length).toBeGreaterThan(1);
    const now = bars.filter((b) => b.hasAttribute("data-current"));
    expect(now).toHaveLength(1);
    for (const b of bars) {
      expect(b.querySelector("div").style.background).toBe(b === now[0] ? PINE : SAGE_BAR);
      expect(b.firstChild.className).toContain("vp-figures");
      expect(b.lastChild.className).toContain("vp-figures");
    }
    fireEvent.click(screen.getByTestId("portal-hours-period"));
    expect(await screen.findByTestId("portal-period-sheet")).toBeInTheDocument();
    expectNoGreenOrNavy(content());
  });

  it("web: 'Eksportér CSV' is a quiet pine text button, and it exports the rows on screen plus the total", async () => {
    await mount("da");
    go("hours");
    const exp = await screen.findByTestId("portal-hours-export");
    expect(exp.textContent).toBe("Eksportér CSV");
    expect(exp.style.color).toBe(PINE);
    expect(exp.style.background).toBe("");   // a text button: no fill
    expect(screen.queryByTestId("portal-hours-export-web-only")).toBeNull();
    fireEvent.click(exp);
    expect(csv.calls).toHaveLength(1);
    const [filename, rows, columns] = csv.calls[0];
    expect(filename).toBe(`bonbox-timer-${data.hours.period_start}-${data.hours.period_end}.csv`);
    expect(rows).toHaveLength(4);
    expect(rows[3]).toEqual({ date: "I alt", start: "", end: "", hours: 19.5 });
    expect(columns.map((c) => c.key)).toEqual(["date", "start", "end", "hours"]);
  });

  it("native app that CAN share a file (the iOS WebView): the button is drawn and exports — the share sheet is how the file leaves", async () => {
    native.on = true;
    webShare(true);
    await mount("da");
    go("hours");
    const exp = await screen.findByTestId("portal-hours-export");
    expect(exp.textContent).toBe("Eksportér CSV");
    expect(screen.queryByTestId("portal-hours-export-web-only")).toBeNull();
    fireEvent.click(exp);
    expect(csv.calls).toHaveLength(1);
    // It went out: no note follows.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.queryByTestId("portal-hours-export-web-only")).toBeNull();
  });

  it("native app: an export that comes back undelivered is said, not silent — the web-only line appears", async () => {
    native.on = true;
    webShare(true);
    csv.result = false;
    await mount("da");
    go("hours");
    fireEvent.click(await screen.findByTestId("portal-hours-export"));
    expect((await screen.findByTestId("portal-hours-export-web-only")).textContent).toBe("Eksportér dine timer fra bonbox.dk i en browser");
  });

  for (const [lang, line] of [
    ["da", "Eksportér dine timer fra bonbox.dk i en browser"],
    ["en", "Export your hours from bonbox.dk in a browser"],
  ]) {
    it(`native app that cannot share a file (Android's WebView, ${lang}): no dead export button — one line says where the export works`, async () => {
      native.on = true;
      await mount(lang);
      go("hours");
      const note = await screen.findByTestId("portal-hours-export-web-only");
      expect(note.textContent).toBe(line);
      expect(screen.queryByTestId("portal-hours-export")).toBeNull();
      expect(screen.queryByText(lang === "da" ? "Eksportér CSV" : "Export CSV")).toBeNull();
      expect(csv.calls).toHaveLength(0);
    });
  }

  it("native app with Web Share but no FILE sharing: still no button", async () => {
    native.on = true;
    webShare(false);
    await mount("da");
    go("hours");
    expect(await screen.findByTestId("portal-hours-export-web-only")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-hours-export")).toBeNull();
  });

  it("web: an undelivered file is said too (never the 'use a browser' line in a browser)", async () => {
    csv.result = false;
    await mount("da");
    go("hours");
    fireEvent.click(await screen.findByTestId("portal-hours-export"));
    expect((await screen.findByTestId("portal-hours-export-failed")).textContent).toBe("Filen blev ikke gemt på enheden. Prøv igen.");
    expect(screen.queryByTestId("portal-hours-export-web-only")).toBeNull();
  });

  it("native app with no shifts in the period: neither the button nor the note", async () => {
    native.on = true;
    data.hours = { ...data.hours, total_hours: 0, entries: [] };
    await mount("da");
    go("hours");
    expect(await screen.findByTestId("portal-hours-empty")).toBeInTheDocument();
    expect(screen.queryByTestId("portal-hours-export")).toBeNull();
    expect(screen.queryByTestId("portal-hours-export-web-only")).toBeNull();
  });
});

describe("Across tabs: one colour per meaning", () => {
  it("the home strip marks a 'kan ikke' day in Fravær's terracotta, never the brass/amber that means 'Afventer' there", async () => {
    await mount("da");
    // The every-Friday rule in the fixture lands on this week's strip.
    const marks = await screen.findAllByTestId("portal-strip-cant");
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) {
      expect([RED_INK, RED_WASH_HEX]).toContain(m.style.color);
      expect(m.getAttribute("style")).not.toMatch(/183,\s*121,\s*31|#B7791F/i);
    }
  });
});
