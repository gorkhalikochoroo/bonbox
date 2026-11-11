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
 *     .vp-figures; "Eksportér CSV" a quiet pine text button on the web; in
 *     the native app the export is not drawn and one line says where it
 *     works (the shells sync no share/filesystem plugin).
 *   • Over all four: no Tailwind green-* / emerald-* class and no navy or
 *     bright green in any inline style, on any element of the tab.
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

const native = vi.hoisted(() => ({ on: false }));
vi.mock("../utils/platform", () => ({
  platform: { get isNative() { return native.on; }, isIOS: false, isAndroid: false, get isWeb() { return !native.on; } },
  isNativeApp: () => native.on,
  canPurchaseInApp: () => !native.on,
  isIPad: () => false,
}));
const csv = vi.hoisted(() => ({ calls: [] }));
vi.mock("../utils/exportCsv", () => ({
  exportToCsv: (...args) => { csv.calls.push(args); return Promise.resolve(true); },
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
  if (sub.startsWith("/chat/threads/")) return ok(data.thread);
  if (sub.startsWith("/chat/threads")) return ok({ threads: data.threads });
  if (sub.startsWith("/chat/colleagues")) return ok({ colleagues: [] });
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

beforeEach(() => {
  localStorage.clear();
  get.mockClear();
  native.on = false;
  csv.calls = [];
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
});

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

    const legend = screen.getByTestId("kanikke-legend");
    const swatch = (k) => legend.querySelector(`[data-legend="${k}"] > span`);
    expect(swatch("cant").style.background).toBe(RED_WASH);
    expect(swatch("pref").style.background).toBe(SOFT);
    expect(swatch("pending").style.background).toBe(BRASS_WASH);
    expect(swatch("approved").style.background).toBe(PINE);
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
    fireEvent.click(add);
    const form = await screen.findByTestId("fravaer-form");
    const send = within(form).getByRole("button", { name: "Send anmodning" });
    expect(send.style.background).toBe(PINE);
    expect(send.style.color).toBe(CREAM);
    // The kind picker is the same segmented control.
    expect(within(form).getByTestId("fravaer-kind-ferie").style.background).toBe(PINE);
    expectNoGreenOrNavy(content());
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
    expect(screen.getByTestId("portal-chat-send").style.background).toBe(PINE);
    expect(screen.getByTestId("portal-chat-back").textContent).toContain("Alle samtaler");
    expectNoGreenOrNavy(content());
  });
});

describe("Byt", () => {
  it("'Byt' is pine (not navy), the give-away the ivory card; give-aways read like the home's open shifts", async () => {
    await mount("da");
    go("swaps");
    const offer = await within(content()).findByRole("button", { name: /^Byt$/ });
    expect(offer.style.background).toBe(PINE);
    expect(offer.style.color).toBe(CREAM);
    const give = within(content()).getByRole("button", { name: "Giv en vagt væk" });
    expect(give.style.background).toBe(CARD);
    const row = await screen.findByTestId("swap-pool-row");
    expect(row.textContent).toContain("16:00–22:00");
    expect(row.textContent).toContain("Ledig for dig");
    const take = within(row).getByRole("button", { name: "Tag den" });
    expect(take.style.background).toBe(SOFT);
    expect(take.style.color).toBe(PINE);
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

  it("both inline forms keep the system: pine submit, no green or navy anywhere", async () => {
    await mount("da");
    go("swaps");
    fireEvent.click(await within(content()).findByRole("button", { name: /^Byt$/ }));
    const form = await screen.findByTestId("swap-propose");
    expect(within(form).getByRole("button", { name: "Send bytteanmodning" }).style.background).toBe(PINE);
    expectNoGreenOrNavy(content());
    fireEvent.click(within(form).getByRole("button", { name: "Luk" }));
    fireEvent.click(within(content()).getByRole("button", { name: "Giv en vagt væk" }));
    expect(await screen.findByTestId("swap-sell")).toBeInTheDocument();
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

  for (const [lang, line] of [
    ["da", "Eksportér dine timer fra bonbox.dk i en browser"],
    ["en", "Export your hours from bonbox.dk in a browser"],
  ]) {
    it(`native app (${lang}): no dead export button — one line says where the export works`, async () => {
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
