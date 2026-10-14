/**
 * BonBox Vagtplan on iPad — the layout decisions, pinned on the REAL page
 * against a mocked portalApi, plus the promise that a phone renders exactly
 * what it rendered before.
 *
 * How the two layouts are told apart:
 *   • CSS: the `pad:` / `pad-wide:` Tailwind variants (index.css). jsdom does
 *     not evaluate media queries, so on that side we pin the CLASSES: every
 *     iPad decision is a pad:-prefixed token, and the phone tokens of each
 *     shell element are byte-for-byte the ones origin/main shipped.
 *   • JS: usePadLayout() (src/lib/padLayout.js) via window.matchMedia — the
 *     Messages master-detail and the cookie banner's bar. Here we mock
 *     matchMedia and render both answers.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tokpad";
const ok = (data) => Promise.resolve({ data });
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
};

const THREADS = [
  { thread_id: "own-1", kind: "owner", title: null, last_body: "Kan du tage fredag?", unread: 0, last_message_at: new Date().toISOString() },
  { thread_id: "grp-1", kind: "group", title: "Køkken + sal", last_body: "Dagens suppe", unread: 0, last_message_at: new Date().toISOString() },
];

const get = vi.fn((url) => {
  if (url === `/portal/${TOK}`) {
    return ok({ has_pin: false, staff_name: "Mads Holm", restaurant_name: "Café Nordlys", role: "server" });
  }
  if (url.startsWith(`/portal/${TOK}/schedule`)) {
    return ok({ shifts: [
      { id: "s1", date: inDays(1), start_time: "16:00", end_time: "22:00", status: "published", net_hours: 5.5, break_minutes: 30 },
      { id: "s2", date: inDays(3), start_time: "10:00", end_time: "15:30", status: "published", net_hours: 5.5 },
    ] });
  }
  if (url.startsWith(`/portal/${TOK}/hours`)) {
    return ok({ period_start: inDays(-10), period_end: inDays(10), total_hours: 11, entries: [] });
  }
  if (url.includes("/notifications")) return ok({ notifications: [] });
  if (url.endsWith("/chat/unread")) return ok({ unread: 0 });
  if (url === `/portal/${TOK}/chat/threads`) return ok({ threads: THREADS });
  if (url.startsWith(`/portal/${TOK}/chat/threads/`)) {
    return ok({ messages: [{ id: "m1", sender_type: "owner", mine: false, body: "Hej Mads", created_at: new Date().toISOString() }], member_ids: [] });
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
vi.mock("../utils/haptics", () => ({ haptic: Object.assign(vi.fn(), { warning: vi.fn(), success: vi.fn(), error: vi.fn() }) }));
vi.mock("../utils/camera", () => ({ capturePhoto: vi.fn() }));

const StaffPortalPage = (await import("../pages/StaffPortalPage")).default;
const { LanguageProvider } = await import("../hooks/useLanguage");
const { ConfirmProvider } = await import("../hooks/useConfirm");
const { PAD_QUERY, PAD_WIDE_QUERY, usePadLayout, matchesPad } = await import("../lib/padLayout");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "pages", "StaffPortalPage.jsx"), "utf8");
const CSS = readFileSync(join(HERE, "..", "index.css"), "utf8");
const JOIN_SRC = readFileSync(join(HERE, "..", "pages", "JoinPage.jsx"), "utf8");

/** The phone half of a class list: every token that is NOT an iPad token. */
const phoneTokens = (el) => (el.getAttribute("class") || "")
  .split(/\s+/)
  .filter((c) => c && !c.startsWith("pad:") && !c.startsWith("pad-wide:"))
  .join(" ");
const tokens = (el) => (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);

/** Pretend to be an iPad: `which` = which pad queries match. */
function mockMatchMedia(which = []) {
  const listeners = new Map();
  window.matchMedia = vi.fn((q) => ({
    matches: which.includes(q),
    media: q,
    addEventListener: (_t, fn) => listeners.set(fn, q),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
  }));
  return listeners;
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

const navTo = (label) => {
  const nav = document.querySelector("nav");
  fireEvent.click(within(nav).getByText(label).closest("button"));
};

beforeEach(() => {
  localStorage.clear();
  get.mockClear();
  delete window.matchMedia;
});
afterEach(() => {
  delete window.matchMedia;
});

// ─── One definition of "iPad" ─────────────────────────────────────────────
describe("the pad breakpoint is one definition, in CSS and JS alike", () => {
  it("index.css declares exactly the queries padLayout.js exports", () => {
    expect(PAD_QUERY).toBe("(min-width: 744px) and (min-height: 600px)");
    expect(PAD_WIDE_QUERY).toBe("(min-width: 1024px) and (min-height: 600px)");
    expect(CSS).toContain(`@custom-variant pad (@media ${PAD_QUERY});`);
    expect(CSS).toContain(`@custom-variant pad-wide (@media ${PAD_WIDE_QUERY});`);
  });

  it("a sideways phone is not an iPad: the height floor is below every iPad and above every phone", () => {
    // iPhone landscape is 375–440 tall; the shortest iPad (mini, landscape) is 744.
    expect(PAD_QUERY).toMatch(/min-height: 600px/);
  });

  it("usePadLayout is false without matchMedia (jsdom / old WebViews) — the phone layout", () => {
    expect(matchesPad()).toBe(false);
    const { result } = renderHook(() => usePadLayout());
    expect(result.current).toBe(false);
  });

  it("usePadLayout follows matchMedia and re-renders when the window crosses the breakpoint", () => {
    let matches = true;
    const listeners = new Set();
    window.matchMedia = vi.fn((q) => ({
      get matches() { return q === PAD_QUERY && matches; },
      media: q,
      addEventListener: (_t, fn) => listeners.add(fn),
      removeEventListener: (_t, fn) => listeners.delete(fn),
    }));
    const { result } = renderHook(() => usePadLayout());
    expect(result.current).toBe(true);
    act(() => { matches = false; listeners.forEach((fn) => fn()); });
    expect(result.current).toBe(false);
  });
});

// ─── Phones: unchanged ────────────────────────────────────────────────────
describe("phone (< 744 px wide, or a sideways phone): the shell is exactly origin/main's", () => {
  it("header, content, tab bar and tabs keep their phone classes token-for-token", async () => {
    await mount();
    const nav = document.querySelector("nav");
    expect(phoneTokens(nav)).toBe("fixed bottom-0 left-0 right-0 glass border-t border-gray-200/70 z-20 bb-lg-tabbar");
    expect(nav.getAttribute("data-bb-consent-clear")).toBe("");
    const inner = nav.firstElementChild;
    expect(phoneTokens(inner)).toBe("max-w-lg mx-auto flex justify-around py-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]");
    const tabBtn = within(nav).getByText("Vagtplan").closest("button");
    expect(phoneTokens(tabBtn)).toBe("relative flex flex-col items-center gap-1 px-1.5 sm:px-4 py-1 rounded-lg active:opacity-60");
    expect(phoneTokens(within(nav).getByText("Vagtplan"))).toBe("relative max-w-[64px] truncate text-[10px] font-semibold");

    const title = screen.getByRole("heading", { level: 1 });
    expect(title.getAttribute("style")).toContain("font: 700 23px/1.08");
    const headerRow = title.parentElement.parentElement;
    expect(phoneTokens(headerRow)).toBe("max-w-lg mx-auto px-4 py-3 flex items-center justify-between");

    const grid = screen.getByTestId("portal-schedule-grid");
    expect(phoneTokens(grid)).toBe("space-y-4");
    expect(phoneTokens(grid.parentElement)).toBe("max-w-lg mx-auto px-4 py-4");
    expect(phoneTokens(screen.getByTestId("portal-week-card"))).toBe("bg-white");
  });

  it("the iPad sidebar heading exists only as display:none on a phone", async () => {
    await mount();
    const heading = screen.getByTestId("portal-pad-rail-heading");
    expect(tokens(heading)).toContain("hidden");
    expect(tokens(heading)).toContain("pad:block");
  });

  it("every iPad token in the page source is pad:/pad-wide:-prefixed — no bare md:/lg: crept in", () => {
    // A bare md:/lg: would fire on a sideways phone (844 px wide) too.
    expect(SRC).not.toMatch(/["`\s](md|lg|xl):[a-z]/);
  });

  it("Messages on a phone is the list → conversation flow, with the composer pinned to the screen", async () => {
    await mount();
    navTo("Beskeder");
    const row = await screen.findByText("Køkken + sal");
    expect(screen.queryByTestId("portal-messages-split")).toBeNull();
    fireEvent.click(row.closest("button"));
    await screen.findByText("Alle samtaler");
    const composer = screen.getByTestId("portal-chat-composer");
    expect(phoneTokens(composer)).toBe("fixed inset-x-0 z-20 glass border-t border-gray-200/70 bb-lg-composer");
    expect(composer.getAttribute("style")).toContain("bottom: calc(3.5rem + env(safe-area-inset-bottom))");
    expect(screen.queryByTestId("portal-chat-pane")).toBeNull();
  });
});

// ─── iPad ─────────────────────────────────────────────────────────────────
describe("iPad (pad): sidebar, wide column, form sheets", () => {
  it("the tab bar becomes a left sidebar and stops counting as a bottom bar for the cookie banner", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    const nav = document.querySelector("nav");
    expect(nav.hasAttribute("data-bb-consent-clear")).toBe(false);
    for (const c of ["pad:top-0", "pad:right-auto", "pad:w-[calc(14rem+env(safe-area-inset-left))]", "pad:border-t-0", "pad:border-r"]) {
      expect(tokens(nav)).toContain(c);
    }
    expect(tokens(nav.firstElementChild)).toEqual(expect.arrayContaining(["pad:flex-col", "pad:justify-start"]));
    // Readable labels beside the icon, not 10px under it.
    const label = within(nav).getByText("Vagtplan");
    expect(tokens(label)).toEqual(expect.arrayContaining(["pad:text-[14.5px]", "pad:max-w-none"]));
    expect(tokens(label.closest("button"))).toEqual(expect.arrayContaining(["pad:flex-row", "pad:min-h-[44px]"]));
    // The active tab is a tinted row; the phone's icon pill is hidden there.
    expect(tokens(label.closest("button"))).toContain("pad:bg-[rgb(22_163_74/0.12)]");
    expect(screen.getByTestId("portal-pad-rail-heading").textContent).toContain("Café Nordlys");
    expect(screen.getByTestId("portal-pad-rail-heading").textContent).toContain("Mads Holm");
  });

  it("the scroller makes room on the left for the sidebar (not at the bottom), safe-area aware", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    const scroller = document.querySelector(".scrollable");
    expect(tokens(scroller)).toEqual(expect.arrayContaining([
      "pad:pl-[calc(14rem+env(safe-area-inset-left))]",
      "pad:pb-[calc(2rem+var(--bb-consent-h,0px))]!",
    ]));
  });

  it("header and content share one iPad column; Schedule splits into today | week from pad-wide", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    const grid = screen.getByTestId("portal-schedule-grid");
    expect(tokens(grid.parentElement)).toEqual(expect.arrayContaining(["pad:max-w-[720px]", "pad-wide:max-w-[1080px]", "pad:px-8"]));
    const headerRow = screen.getByRole("heading", { level: 1 }).parentElement.parentElement;
    expect(tokens(headerRow)).toEqual(expect.arrayContaining(["pad:max-w-[720px]", "pad-wide:max-w-[1080px]", "pad:px-8"]));
    expect(tokens(grid)).toEqual(expect.arrayContaining([
      "pad-wide:grid",
      "pad-wide:grid-rows-[auto_auto_auto_auto_1fr]",
      "pad-wide:items-start",
    ]));
    // The week takes the right column across every row; the last row is 1fr
    // so a tall week never pulls the left cards apart.
    expect(tokens(screen.getByTestId("portal-week-card"))).toEqual(expect.arrayContaining([
      "pad-wide:col-start-2", "pad-wide:row-start-1", "pad-wide:row-span-5",
    ]));
    // The week is the grid's LAST child, so every other card auto-places left.
    expect(grid.lastElementChild).toBe(screen.getByTestId("portal-week-card"));
  });

  it("week rows put the hours on the time line, not centred on the whole block", () => {
    expect(SRC).toContain('className="flex items-center justify-between gap-3 mt-2 pad:items-start pad:mt-3"');
  });

  it("Hours: the shift list takes the right column across all rows", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Timer");
    const list = await screen.findByTestId("portal-hours-list");
    expect(tokens(list)).toEqual(expect.arrayContaining(["pad-wide:col-start-2", "pad-wide:row-start-1", "pad-wide:row-span-7"]));
    expect(tokens(screen.getByTestId("portal-hours-grid"))).toEqual(expect.arrayContaining(["pad-wide:grid", "pad-wide:grid-rows-[repeat(6,auto)_1fr]"]));
  });

  it("Availability: Fravær moves to the right column; the divider that separated it goes", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Kan ikke");
    const grid = await screen.findByTestId("portal-availability-grid");
    expect(tokens(grid)).toEqual(expect.arrayContaining(["pad-wide:grid", "pad-wide:grid-rows-[repeat(9,auto)_1fr]"]));
    const right = [...grid.children].find((el) => tokens(el).includes("pad-wide:col-start-2"));
    expect(right).toBeTruthy();
    expect(phoneTokens(right)).toBe("space-y-3");
    expect(tokens(right)).toContain("pad-wide:row-span-10");
  });

  it("the profile sheet is a centred form sheet on iPad, a bottom sheet on a phone", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    fireEvent.click(screen.getByTitle("Rediger profil"));
    const dialog = await screen.findByRole("dialog");
    expect(phoneTokens(dialog)).toBe("fixed inset-0 z-[60] flex flex-col justify-end");
    expect(tokens(dialog)).toEqual(expect.arrayContaining(["pad:items-center", "pad:justify-center"]));
    const panel = dialog.querySelector(".rounded-t-2xl");
    expect(tokens(panel)).toEqual(expect.arrayContaining(["pad:rounded-[24px]", "pad:max-w-[560px]"]));
  });
});

describe("iPad Messages: a bounded pane, and master-detail from pad-wide", () => {
  it("pad-wide: list and conversation side by side; nothing opens (and marks read) by itself", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Beskeder");
    expect(await screen.findByTestId("portal-messages-split")).toBeInTheDocument();
    expect(screen.getByTestId("portal-chat-pick").textContent).toContain("Vælg en samtale");
    expect(get).not.toHaveBeenCalledWith(expect.stringMatching(/\/chat\/threads\/.+/));

    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    const pane = await screen.findByTestId("portal-chat-pane");
    // The list stays; the open thread is marked; there is nothing to go back to.
    const row = screen.getAllByText("Køkken + sal").map((el) => el.closest("button")).find(Boolean);
    expect(row.getAttribute("aria-current")).toBe("true");
    expect(within(pane).getByRole("heading", { level: 2 }).textContent).toBe("Køkken + sal");
    expect(screen.queryByText("Alle samtaler")).toBeNull();
    // The composer is the pane's last row, not a bar pinned over the screen.
    const composer = within(pane).getByTestId("portal-chat-composer");
    expect(tokens(composer)).not.toContain("fixed");
    expect(composer.getAttribute("style")).toBeNull();
  });

  it("pad (narrower iPad): the pane replaces the list and keeps its back link", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    navTo("Beskeder");
    expect(screen.queryByTestId("portal-messages-split")).toBeNull();
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    const pane = await screen.findByTestId("portal-chat-pane");
    expect(within(pane).getByText("Alle samtaler")).toBeInTheDocument();
    expect(tokens(within(pane).getByTestId("portal-chat-composer"))).not.toContain("fixed");
  });
});

// ─── Source pins ──────────────────────────────────────────────────────────
describe("source pins for the iPad pass", () => {
  it("the sticky header's class string is byte-for-byte origin/main's (its top inset is a native-shell decision, not this pass)", () => {
    // Known: the glued token means Tailwind never emits the top padding. The
    // app measures right on device that way; un-gluing it changes the phone
    // header the moment env(safe-area-inset-top) is non-zero, so it is left
    // for the native-shell work and checked on hardware there.
    expect(SRC).toContain('glass-static border-b border-gray-200/70 pt-[env(safe-area-inset-top)]${BAR_V2 ? " bb-lg-header" : ""}');
    // Tailwind scans comments too: a bare copy of the token anywhere in the
    // page would emit the class and move the phone header. Every occurrence
    // must stay glued to the template expression, as on origin/main.
    // Assembled, so this test file is not itself a bare copy Tailwind reads.
    const TOKEN = ["pt-[env(safe-area", "-inset-top)]"].join("");
    let at = SRC.indexOf(TOKEN);
    expect(at).toBeGreaterThan(-1);
    while (at !== -1) {
      expect(SRC.slice(at + TOKEN.length, at + TOKEN.length + 2)).toBe("${");
      at = SRC.indexOf(TOKEN, at + 1);
    }
  });

  it("an iPad form sheet clears the space-y margin that left a 16 px undimmed strip under it (phone untouched)", () => {
    expect(SRC).toContain('const PAD_SHEET_OVERLAY = "pad:items-center pad:justify-center pad:p-8 pad:m-0";');
  });

  it("Meld syg brings its form into view on iPad only — a phone keeps today's behaviour", () => {
    const at = SRC.indexOf("function SickCallButton(");
    const body = SRC.slice(at, at + 2400);
    expect(body).toContain("if (!open || !matchesPad()) return undefined;");
    expect(body).toContain('scrollIntoView?.({ block: "nearest", behavior: "smooth" })');
  });

  it("44 px tap targets are no longer shrunk by width — only for a mouse (pointer: fine)", () => {
    expect(SRC).not.toContain("sm:min-w-0 sm:min-h-0");
    expect((SRC.match(/sm:pointer-fine:min-w-0 sm:pointer-fine:min-h-0/g) || []).length).toBe(3);
  });

  it("every bottom sheet carries the pad form-sheet classes; New group keeps its own sm: card (only it)", () => {
    expect((SRC.match(/\$\{PAD_SHEET_OVERLAY\}/g) || []).length).toBe(8);
    // New group was already a centred card from 640 px (a sideways phone,
    // Split View). It stays one — the only sheet with its own sm: breakpoint.
    expect((SRC.match(/sm:items-center sm:justify-center/g) || []).length).toBe(1);
    expect((SRC.match(/sm:max-w-sm/g) || []).length).toBe(1);
  });

  it("Join: the DA/EN toggle sits in the card column — absolute on a phone, static above the card on iPad", () => {
    const col = JOIN_SRC.indexOf('<div className="w-full max-w-xs pad:max-w-[420px]">');
    const toggle = JOIN_SRC.indexOf('className="absolute right-4 top-[max(0.75rem,env(safe-area-inset-top))] flex rounded-xl border border-gray-200 bg-white p-0.5 gap-0.5 pad:static');
    expect(col).toBeGreaterThan(-1);
    expect(toggle).toBeGreaterThan(col);
    // The column is NOT positioned, so on a phone the toggle still resolves
    // against the full-screen wrapper (the top-right corner, as before).
    expect(JOIN_SRC).not.toMatch(/w-full max-w-xs[^"]*\brelative\b/);
  });
});

// ─── Sheets, type sizes, and the phone half of each ──────────────────────
describe("sheets on iPad are form sheets; on a phone they are the bottom sheets they were", () => {
  it("Hours period sheet: phone tokens + inline style unchanged; iPad hides the grab handle and insets 24 px", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    navTo("Timer");
    const periodBtn = await screen.findByText((_, el) => el?.tagName === "BUTTON" && / – /.test(el.textContent || ""));
    fireEvent.click(periodBtn);
    const panel = await screen.findByRole("dialog", { name: "Vælg en periode" });
    expect(phoneTokens(panel)).toBe("w-full bg-white");
    expect(panel.getAttribute("style")).toContain("border-radius: 24px 24px 0 0");
    expect(panel.getAttribute("style")).toContain("padding: 18px 16px calc(18px + env(safe-area-inset-bottom))");
    expect(tokens(panel)).toEqual(expect.arrayContaining(["pad:max-w-[520px]", "pad:rounded-[24px]!", "pad:px-6!", "pad:pt-2.5!"]));
    const handle = panel.firstElementChild;
    expect(handle.getAttribute("style")).toContain("width: 38px");
    expect(tokens(handle)).toEqual(["mx-auto", "pad:hidden"]);
    expect(phoneTokens(panel.parentElement)).toBe("fixed inset-0 z-50 flex items-end");
    expect(tokens(panel.parentElement)).toEqual(expect.arrayContaining(["pad:items-center", "pad:justify-center"]));
  });

  it("New group: the phone bottom sheet under 640 px; from 640 px the centred 384 px card it was, now rounded all round", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    navTo("Beskeder");
    await screen.findByText("Køkken + sal");
    fireEvent.click(screen.getByRole("button", { name: /Ny gruppe/ }));
    const dialog = await screen.findByRole("dialog", { name: "Ny gruppe" });
    // Under 640 px only the unprefixed tokens apply — exactly origin/main's.
    const unprefixed = (el) => tokens(el).filter((c) => !c.includes(":")).join(" ");
    expect(unprefixed(dialog)).toBe("relative w-full bg-white");
    expect(unprefixed(dialog.parentElement)).toBe("fixed inset-0 z-40 flex items-end");
    expect(dialog.getAttribute("style")).toContain("border-radius: 22px 22px 0 0");
    expect(dialog.getAttribute("style")).toContain("padding-bottom: calc(16px + env(safe-area-inset-bottom))");
    // From 640 px: centred, 384 px, and no longer square-bottomed.
    expect(tokens(dialog.parentElement)).toEqual(expect.arrayContaining(["sm:items-center", "sm:justify-center", "pad:items-center"]));
    expect(tokens(dialog)).toEqual(expect.arrayContaining(["sm:max-w-sm", "sm:rounded-[22px]!", "sm:pb-4!"]));
  });

  it("the documents sheet opens on top of the 560 px profile sheet, so on iPad it is the narrower 400 px sheet", () => {
    const at = SRC.indexOf('aria-label={t("portalDocsSection")}');
    expect(at).toBeGreaterThan(-1);
    expect(SRC.slice(at, at + 200)).toContain("${PAD_SHEET_PANEL_SM} ${PAD_SHEET_INSET}");
  });
});

describe("type on iPad is raised per surface (no global scaling); the phone sizes stay", () => {
  it("Schedule: week label, weekday initials and day numbers keep their phone font and gain a pad: size", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    const label = screen.getByTestId("portal-week-label");
    expect(label.getAttribute("style")).toContain("font: 700 10px/1 var(--font-text)");
    expect(tokens(label)).toEqual(["pad:text-[11px]!"]);
    const card = screen.getByTestId("portal-week-card");
    const cell = card.querySelector("button[aria-expanded], button[aria-current='date']") || card.querySelectorAll("button")[2];
    const [wd, num] = cell.querySelectorAll("span");
    expect(wd.getAttribute("style")).toContain("9.5px");
    expect(tokens(wd)).toContain("pad:text-[11px]!");
    expect(tokens(num)).toEqual(["tabular-nums", "pad:text-[15.5px]!"]);
  });

  it("Hours, the period sheet, the Kan ikke week and the profile labels: phone font kept, pad: size added", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Timer");
    await screen.findByTestId("portal-hours-list");
    const stat = screen.getByText((_, el) => el?.tagName === "DIV" && /^(Vagter|Shifts)$/i.test(el.textContent || "") && (el.getAttribute("style") || "").includes("9.5px"));
    expect(tokens(stat)).toEqual(["pad:text-[11px]!"]);
    // Source pins for the surfaces this mock does not open.
    expect(SRC).toContain('<span className="pad:text-[11px]!" style={cap}>');
    expect(SRC).toContain('className="text-[10px] text-gray-500 mb-1 block pad:text-[12px]"');
    const strip = SRC.slice(SRC.indexOf("function WeekStrip("), SRC.indexOf("function AvailabilityTab("));
    expect(strip).toContain('<span className="pad:text-[11px]!" style={{ font: "600 9.5px/1 var(--font-text)", color: dow }}>');
    expect(strip).toContain('className="tabular-nums pad:text-[15.5px]!"');
  });

  it("no global zoom crept in: index.css sets no root font-size or zoom inside the pad queries", () => {
    expect(CSS).not.toMatch(/@media[^{]*744px[^{]*\{[^}]*(font-size|zoom)/);
    expect(CSS).not.toMatch(/html\s*\{[^}]*zoom/);
  });
});

describe("every iPad token is visible to Tailwind", () => {
  it("no pad:/pad-wide: class is assembled at runtime (Tailwind only emits classes it can read in the source)", () => {
    for (const src of [SRC, JOIN_SRC]) {
      expect(src).not.toMatch(/pad(-wide)?:\$\{/);
      expect(src).not.toMatch(/["'`]pad(-wide)?:["'`]\s*\+/);
    }
  });
});

describe("master-detail keeps the list beside the thread current", () => {
  const listCalls = () => get.mock.calls.filter(([u]) => u === `/portal/${TOK}/chat/threads`).length;

  it("the first read of an opened thread re-reads the list once (its unread dot clears now, not at the next poll)", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Beskeder");
    await screen.findByText("Køkken + sal");
    await waitFor(() => expect(listCalls()).toBe(1));
    fireEvent.click(screen.getByText("Køkken + sal").closest("button"));
    await screen.findByTestId("portal-chat-pane");
    await waitFor(() => expect(listCalls()).toBe(2));
    // and only once: the conversation's own read does not keep re-reading it
    await new Promise((r) => setTimeout(r, 50));
    expect(listCalls()).toBe(2);
  });
});
