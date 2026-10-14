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
 *     Messages master-detail, the cookie banner's bar and keeping the
 *     staffer's place across a layout change. Here we mock matchMedia — either
 *     with a fixed answer, or with a pretend WINDOW whose size we change, the
 *     queries evaluated by the small evaluator below (so a rotation or a Split
 *     View resize is a real change of size, not a hand-picked answer).
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOK = "tokpad";
const ok = (data) => Promise.resolve({ data });
const inDays = (n) => {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
};

// What the mocked API answers that a test may change (reset in beforeEach).
const api = { unread: 0, availability: [], colleagues: [] };

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
  if (url.endsWith("/chat/unread")) return ok({ unread: api.unread });
  if (url.endsWith("/chat/colleagues")) return ok({ colleagues: api.colleagues });
  if (url.endsWith("/availability")) return ok({ availability: api.availability });
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
const { PAD_QUERY, PAD_WIDE_QUERY, TABLET_QUERY, usePadLayout, matchesPad } = await import("../lib/padLayout");

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = readFileSync(join(HERE, "..", "pages", "StaffPortalPage.jsx"), "utf8");
const CSS = readFileSync(join(HERE, "..", "index.css"), "utf8");
const JOIN_SRC = readFileSync(join(HERE, "..", "pages", "JoinPage.jsx"), "utf8");

/** The phone half of a class list: every token that is NOT an iPad token
    (pad:, pad-wide:, or tablet: — an iPad window at least 480 × 600). */
const phoneTokens = (el) => (el.getAttribute("class") || "")
  .split(/\s+/)
  .filter((c) => c && !c.startsWith("pad:") && !c.startsWith("pad-wide:") && !c.startsWith("tablet:"))
  .join(" ");
const tokens = (el) => (el.getAttribute("class") || "").split(/\s+/).filter(Boolean);

/**
 * Evaluate the media queries this layout uses — "(width >= Npx) and
 * (height >= Npx)" — for a window of w × h. Anything else throws, so a query
 * that drifts into a form this cannot read fails loudly instead of quietly
 * answering false.
 */
function evalQuery(q, w, h) {
  const parts = q.split(/\s+and\s+/);
  return parts.every((part) => {
    const m = /^\((width|height) >= (\d+)px\)$/.exec(part.trim());
    if (!m) throw new Error(`evalQuery cannot read: ${part}`);
    return (m[1] === "width" ? w : h) >= Number(m[2]);
  });
}

/** A pretend window: matchMedia answers from its size; resize() fires the change listeners. */
function mockWindow(w, h) {
  const size = { w, h };
  const listeners = new Set();
  window.matchMedia = vi.fn((q) => ({
    get matches() { return evalQuery(q, size.w, size.h); },
    media: q,
    addEventListener: (_t, fn) => listeners.add(fn),
    removeEventListener: (_t, fn) => listeners.delete(fn),
    addListener: () => {},
    removeListener: () => {},
  }));
  return {
    // async + awaited: the re-render, and the fetches a layout change may
    // start, settle inside act().
    async resize(nw, nh) {
      await act(async () => {
        size.w = nw;
        size.h = nh;
        [...listeners].forEach((fn) => fn());
      });
    },
  };
}

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
  api.unread = 0;
  api.availability = [];
  api.colleagues = [];
  delete window.matchMedia;
});
afterEach(() => {
  delete window.matchMedia;
  document.documentElement.style.removeProperty("--bb-consent-left");
});

// ─── One definition of "iPad" ─────────────────────────────────────────────
describe("the pad breakpoint is one definition, in CSS and JS alike", () => {
  it("index.css declares exactly the queries padLayout.js exports — range syntax, narrowest first", () => {
    expect(TABLET_QUERY).toBe("(width >= 480px) and (height >= 600px)");
    expect(PAD_QUERY).toBe("(width >= 744px) and (height >= 600px)");
    expect(PAD_WIDE_QUERY).toBe("(width >= 1100px) and (height >= 600px)");
    const tablet = CSS.indexOf(`@custom-variant tablet (@media ${TABLET_QUERY});`);
    const pad = CSS.indexOf(`@custom-variant pad (@media ${PAD_QUERY});`);
    const wide = CSS.indexOf(`@custom-variant pad-wide (@media ${PAD_WIDE_QUERY});`);
    expect(tablet).toBeGreaterThan(-1);
    // Declared narrowest first, so a pad: rule comes after (and beats) a
    // tablet: rule for the same property.
    expect(pad).toBeGreaterThan(tablet);
    expect(wide).toBeGreaterThan(pad);
  });

  it("JS and CSS fail closed together: no min-width form left that an old WebView would read differently", () => {
    // Lightning CSS ships the CSS side as range syntax; Safari < 16.4 cannot
    // read it. If JS asked with min-width, it would say "iPad" to a page whose
    // CSS says "phone".
    for (const q of [TABLET_QUERY, PAD_QUERY, PAD_WIDE_QUERY]) expect(q).not.toMatch(/min-|max-/);
  });

  // Real windows, answered by the queries themselves.
  const layoutOf = (w, h) => (evalQuery(PAD_WIDE_QUERY, w, h) ? "wide"
    : evalQuery(PAD_QUERY, w, h) ? "pad"
      : evalQuery(TABLET_QUERY, w, h) ? "tablet" : "phone");
  it.each([
    ["iPhone SE", 320, 568, "phone"],
    ["iPhone 16", 390, 844, "phone"],
    ["iPhone Pro Max", 440, 956, "phone"],
    ["iPhone sideways", 844, 390, "phone"],
    ["iPhone Pro Max sideways", 956, 440, "phone"],
    ["iPad Slide Over", 320, 1180, "phone"],
    ["iPad Split View 1/2 (portrait)", 507, 1180, "tablet"],
    ["iPad Split View 2/3 (portrait)", 694, 1180, "tablet"],
    ["iPad mini portrait", 744, 1133, "pad"],
    ["iPad 11\" portrait", 820, 1180, "pad"],
    ["iPad Split View 2/3 (11\" landscape)", 768, 820, "pad"],
    ["iPad Split View 2/3 (13\" landscape)", 981, 1024, "pad"],
    ["iPad Pro 12.9\"/13\" portrait — one column, not two phone-narrow ones", 1024, 1366, "pad"],
    ["iPad mini landscape", 1133, 744, "wide"],
    ["iPad 11\" landscape", 1180, 820, "wide"],
    ["iPad 13\" landscape", 1366, 1024, "wide"],
  ])("%s (%i × %i) → %s", (_name, w, h, want) => {
    expect(layoutOf(w, h)).toBe(want);
  });
  it("usePadLayout is false without matchMedia (jsdom / old WebViews) — the phone layout", () => {
    expect(matchesPad()).toBe(false);
    const { result } = renderHook(() => usePadLayout());
    expect(result.current).toBe(false);
  });

  it("usePadLayout follows matchMedia and re-renders when the window crosses the breakpoint", async () => {
    const win = mockWindow(820, 1180);
    const { result } = renderHook(() => [usePadLayout(), usePadLayout(PAD_WIDE_QUERY)]);
    expect(result.current).toEqual([true, false]);
    await win.resize(1180, 820); // rotate
    expect(result.current).toEqual([true, true]);
    await win.resize(507, 1180); // Split View
    expect(result.current).toEqual([false, false]);
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

  it("the iPad sidebar heading exists only as display:none on a phone, the Nyt row not at all; the bell is the phone's", async () => {
    await mount();
    const heading = screen.getByTestId("portal-pad-rail-heading");
    expect(tokens(heading)).toContain("hidden");
    expect(tokens(heading)).toContain("pad:flex");
    expect(screen.queryByTestId("portal-rail-alerts")).toBeNull();
    // Exactly one "Nyt" control on a phone, as before.
    expect(screen.getAllByRole("button", { name: "Nyt" })).toHaveLength(1);
    // The phone keeps its five-tab bar (the extra rows are display:none) and
    // its header bell, which an iPad hides.
    const headerBell = document.querySelector('button[aria-label="Nyt"]');
    expect(phoneTokens(headerBell)).toContain("w-9 h-9 rounded-full");
    expect(tokens(headerBell)).toContain("pad:hidden");
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
    // Which app, and whose — the venue is already under every page title, so
    // the sidebar does not repeat it.
    const heading = screen.getByTestId("portal-pad-rail-heading");
    expect(heading.textContent).toContain("BonBox Vagtplan");
    expect(heading.textContent).toContain("Mads Holm");
    expect(heading.textContent).not.toContain("Café Nordlys");
    expect(heading.querySelector("img").getAttribute("src")).toBe("/vagtplan-icon-192.png");
  });

  it("Nyt is a sidebar row on iPad: opening it highlights that row and moves nothing in the header", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    const headerRow = () => screen.getByRole("heading", { level: 1 }).parentElement.parentElement;
    const before = headerRow().getAttribute("class");
    const content = document.querySelector("[data-portal-content]");
    const contentBefore = content.getAttribute("class");
    fireEvent.click(screen.getByTestId("portal-rail-alerts"));
    await waitFor(() => expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Nyt"));
    // Same column, same classes: the title and the controls stay put.
    expect(headerRow().getAttribute("class")).toBe(before);
    expect(content.getAttribute("class")).toBe(contentBefore);
    expect(screen.getByTestId("portal-rail-alerts").getAttribute("aria-current")).toBe("page");
    // The alerts list narrows itself inside the shared column.
    expect(tokens(content.firstElementChild)).toEqual(["pad:max-w-[720px]"]);
  });

  it("iPad / desktop web: the cookie banner is told to start right of the sidebar, and only while it is there", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    expect(document.documentElement.style.getPropertyValue("--bb-consent-left")).toBe("calc(14rem + env(safe-area-inset-left))");
  });

  it("a phone sets no sidebar offset for the cookie banner", async () => {
    await mount();
    expect(document.documentElement.style.getPropertyValue("--bb-consent-left")).toBe("");
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
    expect(phoneTokens(dialog)).toBe("fixed inset-0 z-[60] flex flex-col justify-end m-0");
    expect(tokens(dialog)).toEqual(expect.arrayContaining(["pad:items-center", "pad:justify-center"]));
    const panel = dialog.querySelector(".rounded-t-2xl");
    expect(tokens(panel)).toEqual(expect.arrayContaining(["pad:rounded-[24px]", "pad:max-w-[560px]"]));
    // Its sticky header stacks ABOVE the scrolling content and is opaque, so
    // the dark profile card cannot slide over the title and the close X.
    const head = within(panel).getByRole("heading", { name: "Rediger profil" }).parentElement;
    expect(phoneTokens(head)).toContain("sticky top-0 z-10 bg-white");
    expect(within(head).getByRole("button", { name: "Luk" })).toBeTruthy();
    // Centred on iPad: the keyboard lift no longer eats pad:p-8's bottom.
    expect(tokens(dialog)).toContain("pad:pb-[calc(2rem+var(--kb-h,0px))]!");
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

  it("every sheet overlay clears the space-y margin that left a 16 px undimmed strip under it — at every size", () => {
    expect(SRC).toContain('const PAD_SHEET_OVERLAY = "m-0 pad:items-center pad:justify-center pad:p-8";');
  });

  it("Meld syg brings its whole form into view at every size, clear of the header and the tab bar", () => {
    const body = SRC.slice(SRC.indexOf("function SickCallButton("), SRC.indexOf("function addDaysToDate("));
    expect(body).toContain("const id = setTimeout(() => revealForUser(formRef.current), 30);");
    expect(body).not.toContain("matchesPad");
    expect(body).toContain("${REVEAL_MARGINS}");
    expect(SRC).toContain('const REVEAL_MARGINS = "scroll-mt-24 scroll-mb-[calc(6rem+env(safe-area-inset-bottom))] pad:scroll-mt-28 pad:scroll-mb-8";');
  });

  it("44 px targets shrink from 640 px exactly as they did for a mouse and a sideways phone — but not in an iPad window used by touch", () => {
    // origin/main's phone tokens are back, so a sideways phone is unchanged…
    expect((SRC.match(/min-w-\[44px\] min-h-\[44px\] sm:min-w-0 sm:min-h-0 \$\{TOUCH_TABLET_44\}/g) || []).length).toBe(3);
    expect(SRC).not.toContain("sm:pointer-fine:");
    // …and an iPad window (≥ 480 × 600, which no phone is) with a finger keeps 44.
    expect(SRC).toContain('const TOUCH_TABLET_44 = "tablet:pointer-coarse:min-w-[44px]! tablet:pointer-coarse:min-h-[44px]!";');
  });

  it("small close buttons and links are 44 × 44 on iPad without moving what is around them", () => {
    expect(SRC).toContain('const PAD_CLOSE_44 = "pad:w-11 pad:h-11 pad:-my-2.5 pad:-mr-2.5";');
    expect((SRC.match(/\$\{PAD_CLOSE_44\}/g) || []).length).toBe(3); // Meld syg, Byt, Giv væk
    // New group's ×, the install card's chevron and ×: same box, same spot.
    expect(SRC).toContain("pad:w-11 pad:h-11 pad:p-0 pad:flex pad:items-center pad:justify-center pad:-mr-[13px]");
    expect((SRC.match(/p-3 -m-2 text-gray-400 hover:text-gray-600 active:opacity-60 shrink-0 pad:p-\[14px\] pad:-m-\[10px\]/g) || []).length).toBe(2);
    // The header's Live / Synced link: a ≥ 44 px box on its 12 px line.
    expect(SRC).toContain("pad:inline-flex pad:items-center pad:justify-start pad:min-w-[44px] pad:min-h-[44px] pad:-my-4");
  });

  it("every bottom sheet carries the pad form-sheet classes; New group keeps its own sm: card (only it)", () => {
    expect((SRC.match(/\$\{PAD_SHEET_OVERLAY\}/g) || []).length).toBe(8);
    // New group was already a centred card from 640 px (a sideways phone,
    // Split View). It stays one — the only sheet with its own sm: breakpoint.
    expect((SRC.match(/sm:items-center sm:justify-center/g) || []).length).toBe(1);
    expect((SRC.match(/sm:max-w-sm/g) || []).length).toBe(1);
  });

  it("Join: the DA/EN toggle sits in the card column — absolute on a phone, static above the card in any iPad window", () => {
    const col = JOIN_SRC.indexOf('<div className="w-full max-w-xs tablet:max-w-[380px] pad:max-w-[420px]">');
    const toggle = JOIN_SRC.indexOf('className="absolute right-4 top-[max(0.75rem,env(safe-area-inset-top))] flex rounded-xl border border-gray-200 bg-white p-0.5 gap-0.5 tablet:static tablet:w-fit tablet:ml-auto tablet:mb-3"');
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
    // Split View (tablet:): the 512 px phone column's width, not the window's.
    expect(tokens(panel)).toEqual(expect.arrayContaining(["tablet:max-w-lg", "tablet:mx-auto"]));
    expect(panel.getAttribute("style")).toContain("border-radius: 24px 24px 0 0");
    expect(panel.getAttribute("style")).toContain("padding: 18px 16px calc(18px + env(safe-area-inset-bottom))");
    expect(tokens(panel)).toEqual(expect.arrayContaining(["pad:max-w-[520px]", "pad:rounded-[24px]!", "pad:px-6!", "pad:pt-2.5!"]));
    const handle = panel.firstElementChild;
    expect(handle.getAttribute("style")).toContain("width: 38px");
    expect(tokens(handle)).toEqual(["mx-auto", "pad:hidden"]);
    // m-0 at every size: the space-y margin no longer leaves a strip under it.
    expect(phoneTokens(panel.parentElement)).toBe("fixed inset-0 z-50 flex items-end m-0");
    expect(tokens(panel.parentElement)).toEqual(expect.arrayContaining(["pad:items-center", "pad:justify-center"]));
  });

  it("New group: the phone bottom sheet under 640 px; from 640 px the centred 384 px card it was — rounded all round in an iPad window, as shipped on a sideways phone", async () => {
    mockMatchMedia([PAD_QUERY]);
    await mount();
    navTo("Beskeder");
    await screen.findByText("Køkken + sal");
    fireEvent.click(screen.getByRole("button", { name: /Ny gruppe/ }));
    const dialog = await screen.findByRole("dialog", { name: "Ny gruppe" });
    // Under 640 px only the unprefixed tokens apply — exactly origin/main's.
    const unprefixed = (el) => tokens(el).filter((c) => !c.includes(":")).join(" ");
    expect(unprefixed(dialog)).toBe("relative w-full bg-white");
    expect(unprefixed(dialog.parentElement)).toBe("fixed inset-0 z-40 flex items-end m-0");
    expect(dialog.getAttribute("style")).toContain("border-radius: 22px 22px 0 0");
    expect(dialog.getAttribute("style")).toContain("padding-bottom: calc(16px + env(safe-area-inset-bottom))");
    // From 640 px: centred, 384 px, and no longer square-bottomed.
    expect(tokens(dialog.parentElement)).toEqual(expect.arrayContaining(["sm:items-center", "sm:justify-center", "pad:items-center"]));
    expect(tokens(dialog)).toEqual(expect.arrayContaining(["sm:max-w-sm", "sm:tablet:rounded-[22px]!", "sm:tablet:pb-4!"]));
    // A sideways phone (≥ 640 wide, < 600 tall) gets exactly origin/main's card.
    expect(tokens(dialog).filter((c) => c.startsWith("sm:") && !c.startsWith("sm:tablet:"))).toEqual(["sm:max-w-sm"]);
    expect(tokens(dialog.parentElement)).toContain("pad:pb-[calc(2rem+var(--kb-h,0px))]!");
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

// ─── A layout change keeps what the staffer was doing ────────────────────
describe("rotating an iPad (or resizing Split View) keeps Messages state — nothing remounts", () => {
  const composer = () => screen.getByPlaceholderText("Skriv en besked…");
  const search = () => screen.getByPlaceholderText("Søg personer og beskeder");

  it("an unsent draft survives portrait → landscape → portrait (pad ↔ pad-wide)", async () => {
    const win = mockWindow(820, 1180);
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    await screen.findByTestId("portal-chat-pane");
    fireEvent.change(composer(), { target: { value: "Jeg kommer 10 min senere i dag" } });
    const box = composer();

    await win.resize(1180, 820);
    expect(screen.getByTestId("portal-messages-split")).toBeInTheDocument();
    expect(composer()).toBe(box); // the same element: not remounted
    expect(composer().value).toBe("Jeg kommer 10 min senere i dag");

    await win.resize(820, 1180);
    expect(screen.queryByTestId("portal-messages-split")).toBeNull();
    expect(composer().value).toBe("Jeg kommer 10 min senere i dag");
  });

  it("a draft survives landscape → Split View (pad-wide → phone layout) and back", async () => {
    const win = mockWindow(1180, 820);
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    await screen.findByTestId("portal-chat-pane");
    fireEvent.change(composer(), { target: { value: "Hej gruppe" } });
    await win.resize(507, 1180);
    expect(screen.queryByTestId("portal-chat-pane")).toBeNull(); // phone flow now
    expect(composer().value).toBe("Hej gruppe");
    await win.resize(1180, 820);
    expect(composer().value).toBe("Hej gruppe");
  });

  it("the search text survives a rotation", async () => {
    const win = mockWindow(1180, 820);
    await mount();
    navTo("Beskeder");
    await screen.findByText("Køkken + sal");
    fireEvent.change(search(), { target: { value: "suppe" } });
    await win.resize(820, 1180);
    expect(search().value).toBe("suppe");
    await win.resize(1180, 820);
    expect(search().value).toBe("suppe");
  });

  it("an open New group sheet — with its name typed — survives a rotation and a Split View resize", async () => {
    const win = mockWindow(1180, 820);
    await mount();
    navTo("Beskeder");
    await screen.findByText("Køkken + sal");
    fireEvent.click(screen.getByRole("button", { name: "Ny gruppe" }));
    const name = within(await screen.findByRole("dialog", { name: "Ny gruppe" })).getByPlaceholderText(/Køkken/);
    fireEvent.change(name, { target: { value: "Bar" } });
    await win.resize(507, 1180);
    expect(within(screen.getByRole("dialog", { name: "Ny gruppe" })).getByPlaceholderText(/Køkken/).value).toBe("Bar");
    await win.resize(820, 1180);
    expect(within(screen.getByRole("dialog", { name: "Ny gruppe" })).getByPlaceholderText(/Køkken/).value).toBe("Bar");
  });

  it("on an iPad the list stays mounted (hidden, not polling) behind a full-screen thread; a phone unmounts it as before", async () => {
    const listCalls = () => get.mock.calls.filter(([u]) => u === `/portal/${TOK}/chat/threads`).length;
    mockWindow(820, 1180);
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    await screen.findByTestId("portal-chat-pane");
    const box = search();
    expect(tokens(box.closest("div.hidden"))).toContain("hidden");
    // Hidden: no re-read. Shown again (back to the list): one re-read, and
    // it is the same field (still mounted).
    const before = listCalls();
    await new Promise((r) => setTimeout(r, 80));
    expect(listCalls()).toBe(before);
    fireEvent.click(screen.getByText("Alle samtaler"));
    await waitFor(() => expect(listCalls()).toBe(before + 1));
    expect(search()).toBe(box);
    cleanup();

    delete window.matchMedia;
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    await screen.findByText("Alle samtaler");
    expect(screen.queryByPlaceholderText("Søg personer og beskeder")).toBeNull();
  });
});

describe("the chat views are not refetched by every parent render (onRead is one stable function)", () => {
  const listCalls = () => get.mock.calls.filter(([u]) => u === `/portal/${TOK}/chat/threads`).length;
  const threadCalls = () => get.mock.calls.filter(([u]) => u === `/portal/${TOK}/chat/threads/grp-1`).length;

  it("with an unread message waiting, opening Messages reads the list once and a thread once", async () => {
    api.unread = 1;
    await mount();
    navTo("Beskeder");
    await screen.findByText("Køkken + sal");
    await new Promise((r) => setTimeout(r, 150));
    // The unread poll sets 1, the list's read sets 0: before, each of those
    // renders handed the list a new onRead and it fetched again.
    expect(listCalls()).toBe(1);
    fireEvent.click(screen.getByText("Køkken + sal").closest("button"));
    await screen.findByText("Hej Mads");
    await new Promise((r) => setTimeout(r, 150));
    expect(threadCalls()).toBe(1);
  });

  it("the source keeps it that way: the count functions handed to the chat views are stable for the page's life", () => {
    // (The count itself — one source of truth, no blinking — is pinned in
    // StaffPortalPage.ipadRound3.test.jsx.)
    expect(SRC).toContain("const takeChatTicket = useCallback(() => {");
    expect(SRC).toMatch(/const refreshChatUnread = useCallback\(\(\) => \{[\s\S]*?\}, \[token, takeChatTicket\]\);/);
    expect(SRC).toContain("takeCountTicket={takeChatTicket}");
    expect(SRC).toContain("refreshCount={refreshChatUnread}");
    expect(SRC).not.toMatch(/(onRead|takeCountTicket|refreshCount)=\{\(\) =>/);
  });
});

describe("keeping the staffer's place when the layout changes under them", () => {
  it("rotating with the Fravær form open (it was in the right column) scrolls it back on screen", async () => {
    const win = mockWindow(1180, 820);
    await mount();
    navTo("Kan ikke");
    fireEvent.click(await screen.findByRole("button", { name: "Anmod om fri" }));
    const form = await screen.findByTestId("fravaer-form");
    await new Promise((r) => setTimeout(r, 60)); // the form's own reveal, which marks it as the place
    const section = form.parentElement;
    const scroller = document.querySelector("[data-portal-scroller]");
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop, set: (v) => { scrollTop = v; } });
    // In portrait the one column puts the section far below the fold.
    const rect = (top, height) => ({ top, bottom: top + height, height, left: 0, right: 600, width: 600, x: 0, y: top });
    const real = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      if (this === section) return rect(2000, 420);
      if (this === form) return rect(2100, 300);
      if (this.classList?.contains("sticky")) return rect(0, 100);
      return real.call(this);
    };
    try {
      await win.resize(820, 1180);
    } finally {
      Element.prototype.getBoundingClientRect = real;
    }
    // The whole section (it fits) is brought up to the bottom edge.
    expect(scrollTop).toBe(2000 + 420 - (window.innerHeight - 16));
  });

  it("nothing moves when the place is still on screen, or when the staffer had scrolled away from it", async () => {
    const win = mockWindow(1180, 820);
    await mount();
    navTo("Kan ikke");
    fireEvent.click(await screen.findByRole("button", { name: "Anmod om fri" }));
    await screen.findByTestId("fravaer-form");
    await new Promise((r) => setTimeout(r, 60));
    const scroller = document.querySelector("[data-portal-scroller]");
    let scrollTop = 0;
    Object.defineProperty(scroller, "scrollTop", { configurable: true, get: () => scrollTop, set: (v) => { scrollTop = v; } });
    await win.resize(820, 1180); // jsdom: every box is 0 × 0 at 0,0 — "not rendered", left alone
    expect(scrollTop).toBe(0);
  });
});

// ─── Smaller fixes, rendered ──────────────────────────────────────────────
describe("smaller fixes", () => {
  it("chat bubbles fill their 78% column — no second 80% that wrapped short replies, on a phone too", async () => {
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    const bubble = await screen.findByText("Hej Mads");
    expect(bubble.style.maxWidth).toBe("100%");
    expect(tokens(bubble.parentElement)).toContain("max-w-[78%]");
  });

  it("the iPad Messages pane fills the window from the MEASURED header, not a guessed 10.25rem", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    const pane = await screen.findByTestId("portal-chat-pane");
    expect(pane.style.height).toContain("var(--portal-head-h");
    expect(pane.style.height).not.toContain("10.25rem");
    const scroller = document.querySelector("[data-portal-scroller]");
    expect(scroller.style.getPropertyValue("--portal-head-h")).toMatch(/^\d+px$/);
  });

  it("a phone writes no header measure (nothing there reads it)", async () => {
    await mount();
    expect(document.querySelector("[data-portal-scroller]").style.getPropertyValue("--portal-head-h")).toBe("");
  });

  it("iPad pane: the header row is 44 px for a direct thread and a group alike; a real hairline under it", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Beskeder");
    fireEvent.click((await screen.findByText("Køkken + sal")).closest("button"));
    const pane = await screen.findByTestId("portal-chat-pane");
    const row = pane.firstElementChild;
    expect(tokens(row)).toContain("min-h-[44px]");
    expect(row.nextElementSibling.style.borderBottom).toBe("1px solid rgb(232, 237, 243)");
  });

  it("a Helst (preferred) day in the marked list is green with CalendarCheck and says Helst; a Kan ikke day is unchanged", async () => {
    const d = (n) => inDays(n);
    api.availability = [
      { id: "a1", date: d(6), weekday: null, kind: "unavailable" },
      { id: "a2", date: d(13), weekday: null, kind: "preferred" },
    ];
    await mount();
    navTo("Kan ikke");
    const rows = await screen.findAllByTestId("kanikke-marked-row");
    const byKind = Object.fromEntries(rows.map((r) => [r.getAttribute("data-kind"), r]));
    expect(byKind.preferred.textContent).toContain("Helst");
    expect(byKind.preferred.querySelector("svg").getAttribute("class")).toContain("lucide-calendar-check");
    expect(byKind.unavailable.textContent).not.toContain("Helst");
    expect(byKind.unavailable.querySelector("svg").getAttribute("class")).toContain("lucide-calendar-off");
  });

  it("removing a weekly rule says the whole weekday: 'Det gælder hver mandag.' (not 'man..')", async () => {
    api.availability = [{ id: "w1", date: null, weekday: 0, kind: "unavailable" }];
    await mount();
    navTo("Kan ikke");
    fireEvent.click(await screen.findByRole("button", { name: "Næste uge" }));
    const monday = (await screen.findAllByRole("button")).find((b) => /^mandag/.test(b.getAttribute("aria-label") || ""));
    fireEvent.click(monday);
    const sheet = await screen.findByText("Fjern denne faste regel?");
    expect(sheet.parentElement.textContent).toContain("Det gælder hver mandag.");
    expect(sheet.parentElement.textContent).not.toContain("man..");
  });

  it("a bartender reads 'Bartender' in the Danish New group picker (the shared role map), not the raw code", async () => {
    api.colleagues = [{ staff_id: 7, name: "Jonas Krog", role: "bartender" }];
    await mount();
    navTo("Beskeder");
    await screen.findByText("Køkken + sal");
    fireEvent.click(screen.getByRole("button", { name: "Ny gruppe" }));
    const dialog = await screen.findByRole("dialog", { name: "Ny gruppe" });
    await within(dialog).findByText("Jonas Krog");
    expect(within(dialog).getByText("Bartender")).toBeTruthy();
    expect(within(dialog).queryByText("bartender")).toBeNull();
  });

  it("Bytte on pad-wide: two columns, one width each — actions/forms/give-aways left, requests right; no 560 px caps", async () => {
    mockMatchMedia([PAD_QUERY, PAD_WIDE_QUERY]);
    await mount();
    navTo("Bytte");
    const grid = await screen.findByTestId("portal-swap-grid");
    expect(tokens(grid)).toEqual(expect.arrayContaining(["pad-wide:grid", "pad-wide:grid-rows-[auto_auto_1fr]"]));
    const inbox = await screen.findByTestId("portal-swap-inbox");
    expect(grid.lastElementChild).toBe(inbox);
    expect(tokens(inbox)).toEqual(["pad-wide:col-start-2", "pad-wide:row-start-1", "pad-wide:row-span-3"]);
    expect(SRC).not.toContain("grid grid-cols-2 gap-2 pad:max-w-[560px]");
    expect(SRC).not.toContain("p-4 space-y-3 pad:max-w-[560px]");
    expect(SRC).not.toMatch(/pad-wide:grid-cols-2 pad-wide:gap-3/);
  });

  it("the Fravær row puts the dates on a line of their own (never truncated) and the status chip beside the kind", () => {
    const at = SRC.indexOf('data-testid="fravaer-row"');
    const row = SRC.slice(at, at + 2600);
    expect(row).toContain('data-testid="fravaer-range"');
    const range = row.slice(row.indexOf('data-testid="fravaer-range"') - 200, row.indexOf('data-testid="fravaer-range"'));
    expect(range).not.toContain("truncate");
    expect(row).not.toContain("{KIND_LABEL[g.kind] || g.kind} · {fmtRange");
  });

  it("the live timer never breaks inside itself; the 'since' line wraps as a whole instead", () => {
    expect(SRC).toContain('<span className="text-2xl font-bold tabular-nums tracking-[-0.01em] whitespace-nowrap">{clock.liveLabel}</span>');
    expect(SRC).toContain('<div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1">');
  });

  it("week rows: the colleague names hand their 44 px height back to the line (touch), and are 44 px chips on iPad", () => {
    expect(SRC).toContain("pointer-coarse:my-[calc((1lh-44px)/2)] pad:no-underline pad:inline-flex pad:items-center pad:justify-center pad:min-w-[44px] pad:min-h-[44px] pad:-my-[9px]!");
  });

  it("a day picked in the week strip is brought into view in the week's list", () => {
    expect(SRC).toContain('revealForUser(weekListRef.current?.querySelector(`[data-week-day="${d}"]`));');
    expect(SRC).toContain("data-week-day={d}");
  });

  it("the 'Schedule updated' toast sits 2rem off the bottom on iPad (no tab bar there)", () => {
    expect(SRC).toContain("pad:bottom-[calc(2rem+env(safe-area-inset-bottom))]!");
  });

  it("Timer: the two stat tiles share the row equally on iPad", () => {
    expect((SRC.match(/className="pad:flex-1!" style=\{\{ flex: /g) || []).length).toBe(5);
  });
});
